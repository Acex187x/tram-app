#!/usr/bin/env python3
"""Coarse 1D replay of the smooth-sim pace controller over the logged AVL fix
sequences, to estimate the devM effect of candidate constant changes.

Rerun:  python3 docs/calibration/replay.py [path-to-jsonl]

Model (deliberately coarse -- no shape geometry, no stops, no schedule anchor):
  - per tram, fixes = the (t, obsDist) sequence where obsDist changed
    (fix times quantized to the 5 s poll cadence; trip changes = obs drop
    > 2 km start a fresh sim, like the engine's re-anchor path);
  - target(t) = lastFix + vProj*(t - tFix) - TRAIL_M, where vProj is a
    trailing EWMA of the tram's real inter-fix speed (proxy for the engine's
    schedule-pace projection; engine uses the timetable which encodes similar
    running times);
  - controller = the engine's regimes verbatim: crawl latch (enter -40 / exit
    -12, 1 m/s), factor = clamp(1 + e/120, 0.55, 1.35|1.5), vTarget =
    cap * factor * bias, accel clamp [-1.2, +1.0], s monotonic, teleport at
    |target - s| > 500;
  - cap = V_CENTER inside CENTER_BBOX else V_MAX, using the tram's own logged
    simDist->lat/lng samples to locate the replayed s (nearest sample);
  - paceBias EWMA learned per fix like updatePaceBias, but WITHOUT the dwell
    deduction (no stop table here) -- absolute bias values are therefore lower
    than the engine's; comparisons ACROSS configs remain meaningful.

Metric: at every fix arrival, err = s(t_fix) - newObsDist  (position error
vs fresh truth -- the same probe as "prediction error AT fix refresh" in
analyze.py, whose logged baseline is |abs| p50=86 m, signed p50=-38 m).
Also reports devM-style |s - staleObs| sampled at 5 s to match the logged devM.
"""

import json
import math
import sys
from collections import defaultdict

PATH = sys.argv[1] if len(sys.argv) > 1 else "docs/calibration/session-2026-07-11.jsonl"
CENTER = (14.395, 50.068, 14.46, 50.096)


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = math.floor(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


records = []
with open(PATH) as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))
records.sort(key=lambda r: (r["key"], r["t"]))
by_tram = defaultdict(list)
for r in records:
    by_tram[r["key"]].append(r)

# Per tram: fix sequence + simDist->(lng,lat) location samples for zone lookup.
trams = {}
for key, rs in by_tram.items():
    fixes = []
    last_obs = None
    for r in rs:
        if last_obs is None or r["obsDist"] != last_obs:
            fixes.append((r["t"], r["obsDist"]))
            last_obs = r["obsDist"]
    loc = sorted((r["simDist"], r["lng"], r["lat"]) for r in rs
                 if r.get("simDist") is not None and r.get("lng") is not None)
    # trams that never spawned a sim (no shape match -> simDist/lng null, day
    # round 6 artifact) have no zone samples; nothing to replay against.
    if len(fixes) >= 3 and loc:
        trams[key] = (fixes, loc)


def in_center_at(loc, s):
    # nearest logged simDist sample
    lo, hi = 0, len(loc) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if loc[mid][0] <= s:
            lo = mid
        else:
            hi = mid
    _, lng, lat = loc[lo] if abs(loc[lo][0] - s) <= abs(loc[hi][0] - s) else loc[hi]
    w, so, e, n = CENTER
    return w <= lng <= e and so <= lat <= n


A_BRK, A_ACC = 1.2, 1.0
DT = 1.0
FRESH_FIX_COUNT = 2  # first N scored fixes of a segment = "fresh sim" events

TZ_OFFSET_H = 2  # Europe/Prague in summer (CEST); log timestamps are epoch ms


def tod_factor(tod, t_ms):
    """Hour-blended TOD lookup at epoch ms, mirroring todTableFactor()."""
    if tod is None:
        return 1.0
    frac = (t_ms / 3600000.0 + TZ_OFFSET_H) % 24
    h0 = int(frac)
    if isinstance(tod, dict):
        a = tod.get(h0, 1.0)
        b = tod.get((h0 + 1) % 24, 1.0)
    else:
        a, b = tod[h0], tod[(h0 + 1) % 24]
    return a if a == b else a + (b - a) * (frac - h0)


def replay(cfg):
    """cfg: v_max, v_center, prior, trail, half_life, clamp_lo, clamp_hi,
    catchup_max, gentle_max, min_factor, gain.
    Round-1 extensions (optional keys):
      hard_cap      — envelope proxy: vt = min(hard_cap, cap*fac*bias). The
                      engine always clamps vTarget by vAllowedAt (≤ 13.9);
                      pass 13.9 to model that. Default None = legacy uncapped
                      behavior (reproduces the original analysis table).
      inherit_bias  — True = learned bias survives teleports AND carries into
                      the tram's next segment (trip change), like the engine's
                      teleport inheritance + per-key memory. Default False =
                      reset to prior (legacy/old engine).
      tod           — 24-entry list (or {hour: factor} dict, missing hours =
                      1.0) modeling TOD_PACE_TABLE: vt *= tod(t) (hour-blended
                      like todTableFactor) AND the learning ratio divides by
                      tod(t) — i.e. this models the engine WITH the
                      updatePaceBias composition fix (expected speed scaled by
                      todPaceFactor), the only correct way to ship a non-1.0
                      entry (otherwise bias double-counts the TOD factor).
                      Default None = neutral.
    Fresh-sim events are the first FRESH_FIX_COUNT scored fixes per segment —
    structural, so the subset is identical across configs."""
    at_fix_err = []       # (err, fresh) at fix arrival; err = s - freshObs
    dev_style = []        # |s - staleObs| every 5 s (comparable to logged devM)
    hard_cap = cfg.get("hard_cap")
    inherit = cfg.get("inherit_bias", False)
    tod = cfg.get("tod")
    for key, (fixes, loc) in trams.items():
        # split on trip changes (obs drops > 2 km)
        segs = [[fixes[0]]]
        for f in fixes[1:]:
            if f[1] < segs[-1][-1][1] - 2000:
                segs.append([f])
            else:
                segs[-1].append(f)
        carried = None                 # per-key bias memory across segments
        for seg in segs:
            if len(seg) < 3:
                continue
            t, s = seg[0][0], float(seg[0][1])
            v = 0.0
            bias = carried if (inherit and carried is not None) else cfg["prior"]
            crawling = False
            fi = 0                      # last applied fix index
            v_proj = 5.9                # global median real speed, m/s
            last5 = t
            for i in range(1, len(seg)):
                tf, of = seg[i]
                # integrate up to this fix
                while t < tf:
                    tprev, oprev = seg[fi]
                    target = oprev + v_proj * (t - tprev) / 1000 - cfg["trail"]
                    e = target - s
                    cap = cfg["v_center"] if in_center_at(loc, s) else cfg["v_max"]
                    if crawling:
                        if e > -12:
                            crawling = False
                    elif e < -40:
                        crawling = True
                    if crawling:
                        vt = min(cap, 1.0)
                    else:
                        mf = cfg["catchup_max"] if e > 40 else cfg["gentle_max"]
                        fac = min(mf, max(cfg["min_factor"], 1 + e / cfg["gain"]))
                        vt = cap * fac * bias * tod_factor(tod, t)
                        if hard_cap is not None:
                            vt = min(hard_cap, vt)
                    a = min(A_ACC, max(-A_BRK, (vt - v) / DT))
                    v = max(0.0, v + a * DT)
                    s += v * DT
                    t += 1000
                    if t - last5 >= 5000:
                        dev_style.append(abs(s - seg[fi][1]))
                        last5 = t
                # fix arrives: score, then learn + re-anchor projection
                at_fix_err.append((s - of, i <= FRESH_FIX_COUNT))
                tprev, oprev = seg[fi]
                dt_s = (tf - tprev) / 1000
                ds = of - oprev
                if dt_s >= 8 and ds >= 15:
                    v_real = ds / dt_s
                    v_proj += 0.5 * (v_real - v_proj)   # projection-pace EWMA
                    cap = cfg["v_center"] if in_center_at(loc, of) else cfg["v_max"]
                    # expected speed scaled by TOD (the updatePaceBias
                    # composition fix) so bias learns only the residual
                    ratio = min(cfg["clamp_hi"],
                                max(cfg["clamp_lo"],
                                    v_real / (cap * tod_factor(tod, tf))))
                    alpha = 1 - 0.5 ** (dt_s / cfg["half_life"])
                    bias += alpha * (ratio - bias)
                fi = i
                # teleport check (engine: vs projected obs; here vs fresh fix)
                if abs(of - s) > 500:
                    s, v, crawling = float(of), 0.0, False
                    if not inherit:
                        bias = cfg["prior"]
            carried = bias
    return at_fix_err, dev_style


BASE = dict(v_max=13.9, v_center=8.6, prior=1.0, trail=10, half_life=150,
            clamp_lo=0.4, clamp_hi=1.6, catchup_max=1.5, gentle_max=1.35,
            min_factor=0.55, gain=120)

# OLD/NEW gate configs (round 1): identical simulator (hard cap = the 13.9
# envelope proxy, matching the engine's vAllowed clamp), only the shipped
# constants differ. OLD = pre-round-1 engine (prior 1.0, cruise ref = the
# 13.9 network cap, bias reset on teleport). NEW = R1+R3 as shipped (prior
# 0.62, cruise ref 11.7 m/s with the 13.9 envelope untouched, bias inherited
# across teleports/segments). R2 (terminal un-latch) is not modelable here —
# the replay has no stop table, so no terminal latch exists to un-latch.
OLD = {**BASE, "hard_cap": 13.9}
NEW = {**BASE, "v_max": 11.7, "prior": 0.62, "hard_cap": 13.9,
       "inherit_bias": True}

CONFIGS = [
    ("A baseline (uncapped, legacy table)", BASE),
    ("B prior 0.6", {**BASE, "prior": 0.6}),
    ("C caps 42/29 km/h (11.7/8.0)", {**BASE, "v_max": 11.7, "v_center": 8.0}),
    ("D caps 42/29 + prior 0.75", {**BASE, "v_max": 11.7, "v_center": 8.0, "prior": 0.75}),
    ("E TRAIL_M 25", {**BASE, "trail": 25}),
    ("F half-life 60 s", {**BASE, "half_life": 60}),
    ("G clamp_lo 0.3", {**BASE, "clamp_lo": 0.3}),
    ("H D + clamp_lo 0.3", {**BASE, "v_max": 11.7, "v_center": 8.0,
                            "prior": 0.75, "clamp_lo": 0.3}),
    ("I D + TRAIL 20 + hl 60", {**BASE, "v_max": 11.7, "v_center": 8.0,
                                "prior": 0.75, "trail": 20, "half_life": 60}),
    ("OLD gate (pre-round-1 constants)", OLD),
    ("NEW gate (R1+R3 shipped)", NEW),
    # Day-round candidates (round 7, morning peak 06:36-07:36): TOD h7
    # measured vs the re-measured 0.66 fleet norm reads x1.030 full-window
    # but flips sign on one 4-way disjoint cell (x0.985) and the paired
    # within-tram h6->h7 bias delta is +0.010 (75/58) — weak. D20 = the
    # measured deviation anyway (gate for the record), D21 = wrong-way
    # control, D22/D23 = prior candidates re-run on a peak window (R5
    # evidence accumulation; vs 0.62 the fleet reads x1.081, 140/42).
    ("D20 tod h7=1.03 (measured)", {**NEW, "tod": {7: 1.03}}),
    ("D21 tod h7=0.95 (control, wrong way)", {**NEW, "tod": {7: 0.95}}),
    ("D22 prior 0.66 (R5 candidate)", {**NEW, "prior": 0.66}),
    ("D23 prior 0.58 (control, wrong way)", {**NEW, "prior": 0.58}),
]

print(f"trams replayed: {len(trams)}")
print(f"{'config':36s} {'|err|p50':>8s} {'|err|p90':>8s} {'signed p50':>10s} "
      f"{'%ahead':>7s} {'devM p50':>9s} {'devM p90':>9s} "
      f"{'frs p50':>8s} {'frs p90':>8s} {'n_frs':>6s}")
results = {}
for name, cfg in CONFIGS:
    tagged, devs = replay(cfg)
    errs = [e for e, _ in tagged]
    ae = [abs(e) for e in errs]
    fresh = [abs(e) for e, is_fresh in tagged if is_fresh]
    ahead = 100 * sum(1 for x in errs if x > 0) / len(errs)
    results[name] = dict(p50=pct(ae, 50), p90=pct(ae, 90), sp50=pct(errs, 50),
                         ahead=ahead, fresh_p50=pct(fresh, 50),
                         fresh_p90=pct(fresh, 90), n_fresh=len(fresh))
    print(f"{name:36s} {pct(ae,50):8.0f} {pct(ae,90):8.0f} {pct(errs,50):10.0f} "
          f"{ahead:6.1f}% {pct(devs,50):9.0f} {pct(devs,90):9.0f} "
          f"{pct(fresh,50):8.0f} {pct(fresh,90):8.0f} {len(fresh):6d}")

o = results["OLD gate (pre-round-1 constants)"]
n = results["NEW gate (R1+R3 shipped)"]
print(f"\nGATE ({PATH}):")
print(f"  median |fresh-fix err|  OLD {o['p50']:.1f} -> NEW {n['p50']:.1f} m "
      f"({100 * (n['p50'] - o['p50']) / o['p50']:+.1f}%)")
print(f"  fresh-sim |err| p90     OLD {o['fresh_p90']:.1f} -> NEW {n['fresh_p90']:.1f} m "
      f"({100 * (n['fresh_p90'] - o['fresh_p90']) / o['fresh_p90']:+.1f}%)  "
      f"[n={n['n_fresh']}]")
print(f"  (context) |err| p90     OLD {o['p90']:.0f} -> NEW {n['p90']:.0f}; "
      f"signed p50 OLD {o['sp50']:+.0f} -> NEW {n['sp50']:+.0f}; "
      f"%ahead OLD {o['ahead']:.1f} -> NEW {n['ahead']:.1f}")
print("\nlogged reality for comparison (device session): at-fix |err| p50=86 p90=260, "
      "signed p50=-38, %ahead=27.1, devM p50=130 p90=413")
