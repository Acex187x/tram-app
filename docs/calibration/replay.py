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
                 if r.get("simDist") is not None)
    if len(fixes) >= 3:
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


def replay(cfg):
    """cfg: v_max, v_center, prior, trail, half_life, clamp_lo, clamp_hi,
    catchup_max, gentle_max, min_factor, gain"""
    at_fix_err = []   # s - freshObs at fix arrival
    dev_style = []    # |s - staleObs| every 5 s (comparable to logged devM)
    for key, (fixes, loc) in trams.items():
        # split on trip changes (obs drops > 2 km)
        segs = [[fixes[0]]]
        for f in fixes[1:]:
            if f[1] < segs[-1][-1][1] - 2000:
                segs.append([f])
            else:
                segs[-1].append(f)
        for seg in segs:
            if len(seg) < 3:
                continue
            t, s = seg[0][0], float(seg[0][1])
            v = 0.0
            bias = cfg["prior"]
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
                        vt = cap * fac * bias
                    a = min(A_ACC, max(-A_BRK, (vt - v) / DT))
                    v = max(0.0, v + a * DT)
                    s += v * DT
                    t += 1000
                    if t - last5 >= 5000:
                        dev_style.append(abs(s - seg[fi][1]))
                        last5 = t
                # fix arrives: score, then learn + re-anchor projection
                at_fix_err.append(s - of)
                tprev, oprev = seg[fi]
                dt_s = (tf - tprev) / 1000
                ds = of - oprev
                if dt_s >= 8 and ds >= 15:
                    v_real = ds / dt_s
                    v_proj += 0.5 * (v_real - v_proj)   # projection-pace EWMA
                    cap = cfg["v_center"] if in_center_at(loc, of) else cfg["v_max"]
                    ratio = min(cfg["clamp_hi"], max(cfg["clamp_lo"], v_real / cap))
                    alpha = 1 - 0.5 ** (dt_s / cfg["half_life"])
                    bias += alpha * (ratio - bias)
                fi = i
                # teleport check (engine: vs projected obs; here vs fresh fix)
                if abs(of - s) > 500:
                    s, v, crawling, bias = float(of), 0.0, False, cfg["prior"]
    return at_fix_err, dev_style


BASE = dict(v_max=13.9, v_center=8.6, prior=1.0, trail=10, half_life=150,
            clamp_lo=0.4, clamp_hi=1.6, catchup_max=1.5, gentle_max=1.35,
            min_factor=0.55, gain=120)

CONFIGS = [
    ("A baseline (current constants)", BASE),
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
]

print(f"trams replayed: {len(trams)}")
print(f"{'config':34s} {'|err|p50':>8s} {'|err|p90':>8s} {'signed p50':>10s} "
      f"{'%ahead':>7s} {'devM p50':>9s} {'devM p90':>9s}")
for name, cfg in CONFIGS:
    errs, devs = replay(cfg)
    ae = [abs(x) for x in errs]
    ahead = 100 * sum(1 for x in errs if x > 0) / len(errs)
    print(f"{name:34s} {pct(ae,50):8.0f} {pct(ae,90):8.0f} {pct(errs,50):10.0f} "
          f"{ahead:6.1f}% {pct(devs,50):9.0f} {pct(devs,90):9.0f}")
print("\nlogged reality for comparison: at-fix |err| p50=86 p90=260, signed p50=-38, "
      "%ahead=27.1, devM p50=130 p90=413")
