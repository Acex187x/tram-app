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
# Fresh-fix detection prefers the v2 `obsAt` timestamp (present from 2026-07-12
# builds): a NEW obsAt with an UNCHANGED obsDist is a genuine repeated-position
# fix (stuck tram) and must stay in the sequence — the obsDist-change heuristic
# (v1 fallback) drops exactly those, hiding the stuck regime from the replay.
trams = {}
for key, rs in by_tram.items():
    fixes = []
    last_obs = None
    last_at = None
    for r in rs:
        if r.get("obsDist") is None:
            continue
        obs_at = r.get("obsAt")
        if obs_at is not None:
            if last_at is None or obs_at > last_at:
                fixes.append((r["t"], r["obsDist"]))
                last_at = obs_at
                last_obs = r["obsDist"]
        elif last_obs is None or r["obsDist"] != last_obs:
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
    Realism-wave extensions (2026-07-13, field feedback):
      a_acc/a_brk   — accel/brake clamps (defaults 1.0/1.2 = legacy; the
                      shipped profile change is 1.3/1.4).
      seed_speed    — True = a fresh segment sim starts at its cruise pace
                      (min(cap, hard_cap) × bias) instead of 0 — models the
                      mid-segment cruise seeding (fix #2; teleports reseed
                      the same way).
    Smooth-wave extensions (2026-07-19, speed-extremes redesign):
      ahead_slow    — True = the ahead regime (crawl latch, enter -40/exit
                      -12) rides a SOFT-YIELD band instead of the flat 1 m/s
                      crawl: vt = max(3.0, 0.5*cap*bias*tod), escalating to
                      the 1 m/s walking backstop only while e < -120 (deep
                      latch, hysteresis exit at -60). Ship set also narrows
                      min_factor 0.55->0.7 and catchup_max 1.5->1.4 (passed
                      as the existing cfg keys).
      stuck_hold    — True = a repeated-position fresh fix (|Δs| ≤ 8 m with
                      time advancing — only extractable via v2 obsAt) freezes
                      the target AT the fix and brakes the sim to a stand
                      there until a moving fix arrives OR the pinning fix is
                      60 s old (fix #3 + the #1 staleness compromise: the
                      replay has no stop table, so its "stuck" stretches mix
                      real jams with platform dwells — the engine handles the
                      latter via dwell + fix-hold with exactly this 60 s age
                      release). Off = the target keeps advancing at vProj
                      through the jam (the old creep-forward behavior).
    NOT modelable here (no stop table): stop-hold (#1), departure burst +
    adaptive-dwell debt repayment (#4b), the projection redesign (R11 — the
    replay models the MAIN sim only).
    Fresh-sim events are the first FRESH_FIX_COUNT scored fixes per segment —
    structural, so the subset is identical across configs."""
    at_fix_err = []       # (err, fresh) at fix arrival; err = s - freshObs
    dev_style = []        # |s - staleObs| every 5 s (comparable to logged devM)
    hard_cap = cfg.get("hard_cap")
    inherit = cfg.get("inherit_bias", False)
    tod = cfg.get("tod")
    a_acc = cfg.get("a_acc", A_ACC)
    a_brk = cfg.get("a_brk", A_BRK)
    seed_speed = cfg.get("seed_speed", False)
    stuck_hold = cfg.get("stuck_hold", False)
    ahead_slow = cfg.get("ahead_slow", False)

    def cruise_at(s, bias, t):
        cap = cfg["v_center"] if in_center_at_loc[0](s) else cfg["v_max"]
        vt = cap * bias * tod_factor(tod, t)
        return min(hard_cap, vt) if hard_cap is not None else vt

    in_center_at_loc = [None]
    for key, (fixes, loc) in trams.items():
        in_center_at_loc[0] = lambda s, loc=loc: in_center_at(loc, s)
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
            bias = carried if (inherit and carried is not None) else cfg["prior"]
            v = cruise_at(s, bias, t) if seed_speed else 0.0
            crawling = False
            deep = False
            stuck = False
            fi = 0                      # last applied fix index
            v_proj = 5.9                # global median real speed, m/s
            last5 = t
            for i in range(1, len(seg)):
                tf, of = seg[i]
                # integrate up to this fix
                while t < tf:
                    tprev, oprev = seg[fi]
                    cap = cfg["v_center"] if in_center_at(loc, s) else cfg["v_max"]
                    # 45 s mirrors STOP_HOLD_MAX_FIX_AGE_S (60 → 45, ride
                    # calibration 2026-07-20 — see analysis-2026-07-20-ride.md;
                    # fleet metrics verified identical at 60 vs 40/45/39/35 s on
                    # session-2026-07-11: the bound rarely binds here). R12
                    # latency-aware effective age: the engine now compares
                    # (age + FEED_LATENCY_S=3 s) against the bound, so the
                    # effective wall release is ~42 s — still bit-identical here
                    # (the effective bound stays inside the 35-45 s dead band).
                    if stuck and t - tprev + 3_000 <= 45_000:
                        # Stuck-hold: target frozen AT the fix; brake to a
                        # stand there (envelope approach when still short).
                        # Releases when the pinning fix turns 60 s old (the
                        # engine's staleness compromise at stops).
                        d_hold = oprev - s
                        vt = min(cap, math.sqrt(2 * a_brk * d_hold)) if d_hold > 0 else 0.0
                    else:
                        target = oprev + v_proj * (t - tprev) / 1000 - cfg["trail"]
                        e = target - s
                        if crawling:
                            if e > -12:
                                crawling = False
                                deep = False
                        elif e < -40:
                            crawling = True
                        if crawling and ahead_slow:
                            # Soft-yield band; walking backstop only when deep.
                            if deep:
                                if e > -60:
                                    deep = False
                            elif e < -120:
                                deep = True
                            if deep:
                                vt = min(cap, 1.0)
                            else:
                                vt = min(cap, max(3.0, 0.5 * cap * bias * tod_factor(tod, t)))
                        elif crawling:
                            vt = min(cap, 1.0)
                        else:
                            mf = cfg["catchup_max"] if e > 40 else cfg["gentle_max"]
                            fac = min(mf, max(cfg["min_factor"], 1 + e / cfg["gain"]))
                            vt = cap * fac * bias * tod_factor(tod, t)
                            if hard_cap is not None:
                                vt = min(hard_cap, vt)
                    a = min(a_acc, max(-a_brk, (vt - v) / DT))
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
                if stuck_hold and dt_s > 0:
                    # Repeated-position fresh fix = stuck; a moving fix clears.
                    stuck = abs(ds) <= 8
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
                    s = float(of)
                    v = cruise_at(s, bias, tf) if seed_speed else 0.0
                    crawling = False
                    deep = False
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
    # Day-round candidates (round 8, deep peak 07:36-08:40): h8 vs the 0.66
    # norm reads x1.030 with ALL subsamples above for the first time — but the
    # paired within-tram test is null (h7->h8 Δbias +0.000, 86/91) and the
    # paired SPEED test says the slowdown is centre-only (-1.4 km/h, outskirts
    # +0.9) — the bias climb is zone-mix contamination, the same all-day drift
    # R5 tracks, not an h8 deviation. D24 = measured-anyway gate record,
    # D25 = wrong-way control.
    ("D24 tod h8=1.03 (measured)", {**NEW, "tod": {8: 1.03}}),
    ("D25 tod h8=0.95 (control, wrong way)", {**NEW, "tod": {8: 0.95}}),
    # Day-round candidates (round 9, peak decay 08:36-09:36): h9 vs the 0.66
    # norm reads x1.015 with MIXED subsamples (half A and odd-parity below) —
    # the round-8 all-above read did not survive past the peak, consistent
    # with zone-mix. Paired h8->h9 fleet is null (Δspeed -0.25, Δbias +0.000
    # 97/87); centre-majority still slowing (-2.17, 15/42) but live at-fix h9
    # is -3.0 m — the engine already tracks it. D26 = measured-anyway gate
    # record, D27 = wrong-way control.
    ("D26 tod h9=1.02 (measured)", {**NEW, "tod": {9: 1.02}}),
    ("D27 tod h9=0.95 (control, wrong way)", {**NEW, "tod": {9: 0.95}}),
    # Day-round candidates (round 10, noon 09:36-10:37): h10 vs the 0.66 norm
    # reads x0.985 with mixed subsamples (the noon point — zone-mix mostly
    # unwound); paired h9->h10 fleet is null (Δspeed +0.22, Δbias -0.010);
    # live at-fix h10 signed +2.0 — nothing to correct. D28 = measured-anyway
    # gate record, D29 = wrong-way control.
    ("D28 tod h10=0.99 (measured)", {**NEW, "tod": {10: 0.99}}),
    ("D29 tod h10=1.05 (control, wrong way)", {**NEW, "tod": {10: 1.05}}),
    # Day-round candidates (round 11, midday 10:37-11:34): the round-10
    # "+1.0 / 50.2% ahead" regime did NOT persist — the window reads
    # signed p50 -3.0 / %ahead 38.9 (h10 tail -7.0/38.3, h11 -2.0/39.4),
    # back inside the 37-40 band; the flip was transient (hole-adjacent
    # slices had read +17..+22). Paired h10->h11 fleet null (Δspeed -0.19,
    # Δbias +0.000 123/107); centre-majority still slowing (-1.99, 18/45).
    # D30 = the pre-registered <1.0 candidate (evaluated anyway for the
    # record), D31 = wrong-way control.
    ("D30 tod h11=0.97 (candidate)", {**NEW, "tod": {11: 0.97}}),
    ("D31 tod h11=1.03 (control, wrong way)", {**NEW, "tod": {11: 1.03}}),
    # Day-round candidates (round 12, midday 11:34-12:35): h12 vs the 0.66
    # norm reads x0.985 with mixed subsamples (x0.955-x1.015); paired
    # h11->h12 fleet null (Δspeed +0.12, 128/125; Δbias +0.000); live at-fix
    # h12 signed -2.0 / %ahead 38.8 — everything neutral, the expected quiet
    # noon point. D32 = measured-anyway gate record, D33 = wrong-way control.
    ("D32 tod h12=0.99 (measured)", {**NEW, "tod": {12: 0.99}}),
    ("D33 tod h12=1.05 (control, wrong way)", {**NEW, "tod": {12: 1.05}}),
    # Day-round candidates (round 13, early afternoon 12:35-13:35): h13 vs
    # the 0.66 norm reads x0.985 with mixed subsamples (x0.970-x1.015);
    # paired h12->h13 fleet near-null (Δspeed +0.55, 140/113; Δbias +0.010,
    # 133/106; centre-majority -0.99 vs outskirts +1.70 — same zonal split);
    # live at-fix h13 signed -5.0 / %ahead 37.9 — inside all bands, the
    # pre-registered neutral afternoon point. D34 = measured-anyway gate
    # record, D35 = wrong-way control.
    ("D34 tod h13=0.99 (measured)", {**NEW, "tod": {13: 0.99}}),
    ("D35 tod h13=1.05 (control, wrong way)", {**NEW, "tod": {13: 1.05}}),
    # Day-round candidates (round 14, pre-peak 13:35-14:26): h14 vs the 0.66
    # norm reads x0.985 with ALL subsamples slightly below (x0.970-x0.985);
    # paired h13->h14 fleet near-null (Δspeed +0.28, 130/112; Δbias -0.010,
    # 104/125) BUT centre-majority -3.19 km/h (16/48) vs outskirts +1.59
    # (114/64) — the strongest centre downtick of the day, flagged as a
    # possible pre-peak precursor; live at-fix h14 signed -8.0 / %ahead 37.2
    # — at the band edge but inside. D36 = measured-anyway gate record,
    # D37 = wrong-way control.
    ("D36 tod h14=0.99 (measured)", {**NEW, "tod": {14: 0.99}}),
    ("D37 tod h14=1.05 (control, wrong way)", {**NEW, "tod": {14: 1.05}}),
    # Day-round candidates (round 15, peak onset 14:26-15:26): h15 vs the
    # 0.66 norm reads x0.985 (114/128) with halves x0.985/x0.985 — norm
    # level, not an h15 deviation; paired h14->h15 fleet near-null (Δspeed
    # +0.07, 121/116; Δbias +0.000 109/118) with the zonal split deepening
    # (centre-majority -3.85 km/h 12/50 vs outskirts +1.49 109/66). Live
    # at-fix h15 signed -35 BUT dissected as a 15:00-15:20 transient
    # (slices -38/-48 -> -10.5 after :20) with EVERY feed observable flat
    # (speed/cadence/jump/delayS/latency/re-anchors) — sim-side excursion,
    # not a TOD signal. D38 = measured-anyway gate record, D39 = wrong-way
    # control.
    ("D38 tod h15=0.99 (measured)", {**NEW, "tod": {15: 0.99}}),
    ("D39 tod h15=1.05 (control, wrong way)", {**NEW, "tod": {15: 1.05}}),
    # Day-round candidates (round 16, evening peak 15:26-16:37): h16 vs the
    # 0.66 norm reads x0.970 (110/142) with halves/parity x0.970-x0.985 —
    # the h12-h15 level, not an h16 deviation; h15 FULL-hour final reads the
    # same (x0.970, halves x0.985/x0.985). Paired h15->h16 fleet near-null
    # (Δspeed +0.83, 138/103; Δbias -0.010, 106/122), zonal split intact
    # (centre-majority -1.81 vs outskirts +1.50). The 16:00-boundary watch
    # came back NEGATIVE (no 15:00-style transient; the only excursion,
    # 15:54-15:59, coincides with a logged 66-s poll stall + a real delayS
    # bump 47->64 — feed NOT flat). D40 = measured-anyway gate record,
    # D41 = wrong-way control.
    ("D40 tod h16=0.98 (measured)", {**NEW, "tod": {16: 0.98}}),
    ("D41 tod h16=1.05 (control, wrong way)", {**NEW, "tod": {16: 1.05}}),
    # Day-round candidates (round 17, evening peak h16 tail + h17 16:37-17:48):
    # h17-only vs the 0.66 norm reads x0.985 (114/141) with ALL 8 disjoint
    # subsamples x0.970-x0.985 — the h12-h16 fleet level, no h17 deviation.
    # Paired h16->h17 fleet null (Δspeed -0.13, 122/130; Δbias +0.010,
    # 131/111); the centre-majority decline keeps decelerating
    # (-3.85 -> -1.81 -> -0.90). D42 = measured-anyway gate record,
    # D43 = wrong-way control.
    ("D42 tod h17=0.98 (measured)", {**NEW, "tod": {17: 0.98}}),
    ("D43 tod h17=1.05 (control, wrong way)", {**NEW, "tod": {17: 1.05}}),
    # Day-round candidates (round 18, h17 tail + h18 17:48-18:29 — post-peak
    # release window; NB 2026-07-12 is a SUNDAY, flagged this round): h18-only
    # vs the 0.66 norm reads x0.985 (110/139), ALL 8 disjoint subsamples
    # x0.962-x0.985 — the h12-h17 fleet level, no h18 deviation. Paired
    # h17->h18 fleet null (Δspeed +0.14, 127/123; Δbias +0.000, 115/119);
    # centre-majority -1.92 vs outskirts +0.83 — the zonal split, not TOD.
    # D44 = measured-anyway gate record, D45 = wrong-way control.
    ("D44 tod h18=0.99 (measured)", {**NEW, "tod": {18: 0.99}}),
    ("D45 tod h18=1.05 (control, wrong way)", {**NEW, "tod": {18: 1.05}}),
    # Day-round candidates (round 19, h18 tail + h19 18:29-19:30, SUNDAY):
    # h19-only vs the 0.66 norm reads x0.939 with ALL 8 disjoint subsamples
    # below (x0.924-x0.955) — the first hour outside the h12-h18 corridor —
    # BUT the drop is a structural artifact of the 19:00 daytime-cap boundary
    # (zoneCapAt: centre 8.6 m/s only 07:00-19:00; profiles rebuild at 19:00
    # and updatePaceBias re-learns centre spans against ~11.7 m/s instead of
    # 8.6 → centre bias must fall by ~x0.74 at constant real speed; paired
    # h18->h19 centre-majority Δbias -0.110 (3/59) vs outskirts -0.010, while
    # the feed-truth leg is null: fleet Δspeed +0.42, true feed speed
    # 21.7->21.9, centre 18.5->19.0, dwell MID 92->89 — nothing real moved;
    # h19 bias lands exactly on the night-learned 0.62 prior, vs 0.62 x1.008
    # mixed). Post-19:00 bias-norm reads are NOT comparable to the daytime
    # 0.65-0.66 neutral. D46 = norm-implied candidate anyway (gate record),
    # D47 = wrong-way control.
    ("D46 tod h19=0.95 (norm-implied, cap-contaminated)", {**NEW, "tod": {19: 0.95}}),
    ("D47 tod h19=1.05 (control, wrong way)", {**NEW, "tod": {19: 1.05}}),
    # Day-round candidates (round 20, h19 full + h20 first read 20:00-20:39,
    # SUNDAY pre-night; capless frame per the round-19 boundary discovery):
    # h19 full vs 0.62 x0.968 MIXED subsamples (x0.960-x1.016), h20 vs 0.62
    # x0.968 MIXED (x0.968-x1.016); paired h19->h20 fleet null (Δbias +0.000
    # 113/124, Δspeed +0.65); true feed speed 21.7->22.2, centre 18.8->19.0.
    # NB the whole 19:31-20:39 stretch carries a periodic (~4 min) app-stall
    # class (integration collapse + at_stop invariant break, NO host load;
    # app restarted 20:39:51) — replay uses feed fixes only (thinned by poll
    # gaps, same for all configs; cross-config comparison stays meaningful).
    # D48 = measured-anyway gate record, D49 = wrong-way control.
    ("D48 tod h20=0.97 (measured, capless)", {**NEW, "tod": {20: 0.97}}),
    ("D49 tod h20=1.05 (control, wrong way)", {**NEW, "tod": {20: 1.05}}),
    # Day-round candidates (round 21, h20 full + h21 first read 21:00-21:32,
    # SUNDAY pre-night, FRESH app post-20:39:51 restart): h20 full vs 0.62
    # x0.968 (subsamples x0.968-x0.984, all at-or-below but <=3.2%), h21 vs
    # 0.62 x1.000 EXACT (130/130) — no norm-implied candidate for h21, so
    # D50/D51 are a symmetric control pair around the neutral read; D48 rerun
    # on the h20 full-hour extract is the h20-final gate record.
    ("D50 tod h21=0.95 (symmetric control)", {**NEW, "tod": {21: 0.95}}),
    ("D51 tod h21=1.05 (symmetric control)", {**NEW, "tod": {21: 1.05}}),
    # Day-round candidates (round 22, h21 full + h22 first read 22:00-22:33,
    # SUNDAY night window, app fresh ~2 h): h22 first read — symmetric
    # control pair around the read (same pattern as D50/D51); D50/D51 rerun
    # on the h21 full-hour extract is the h21-final gate record.
    # Round 24: D52/D53 rerun on the h22 FULL-hour extract (22:00-23:00, clean)
    # is the h22-final gate record — both flat-to-worse (frs p50 122/122 vs NEW
    # 121) => TOD h22 = 1.0 FINAL alongside norm x1.016 + paired +0.010 legs.
    ("D52 tod h22=0.95 (symmetric control)", {**NEW, "tod": {22: 0.95}}),
    ("D53 tod h22=1.05 (symmetric control)", {**NEW, "tod": {22: 1.05}}),
    # Realism wave (2026-07-13, field-feedback rides): structural fixes #2
    # (mid-segment cruise-speed seeding), #3 (stuck-hold on repeated-position
    # fixes — requires the v2 obsAt fresh-fix extraction above) and the #4
    # profile constants (A_ACC 1.0→1.3, A_BRK 1.2→1.4). R60/R61 isolate the
    # components, R62 is the shipped combination. GATE: R62 vs NEW on the
    # newest sim session — median |at-fix err| must not grow. (Stop-hold #1,
    # the departure burst #4b and the projection redesign R11 have no replay
    # counterpart — no stop table / main-sim-only model; they are gated by the
    # jest invariants instead.)
    ("R60 seed+profile (#2+#4a)", {**NEW, "seed_speed": True, "a_acc": 1.3, "a_brk": 1.4}),
    ("R61 stuck-hold (#3)", {**NEW, "stuck_hold": True}),
    ("R62 REALISM shipped (#2+#3+#4a)",
     {**NEW, "seed_speed": True, "stuck_hold": True, "a_acc": 1.3, "a_brk": 1.4}),
    # Smooth wave (2026-07-19, speed-extremes redesign): the ahead regime
    # rides a soft-yield band (max(3.0, 0.5×cruise) m/s) with a deep-only
    # 1 m/s backstop (enter -120 / exit -60), gentle floor 0.55→0.7, bold
    # catch-up ceiling 1.5→1.4. S70 = R62 + the smooth set (the ship
    # candidate); S71/S72 isolate the components. GATE: S70 vs R62 — median
    # |at-fix err| must not grow. (The junction yield, the arrival-fix stop
    # pin and the curve/switch slow-downs have no replay counterpart — no
    # geometry/stop table here; they are gated by the jest invariants.)
    ("S71 soft-yield only", {**NEW, "seed_speed": True, "stuck_hold": True,
                             "a_acc": 1.3, "a_brk": 1.4, "ahead_slow": True}),
    ("S72 clamps only (0.7/1.4)", {**NEW, "seed_speed": True, "stuck_hold": True,
                                   "a_acc": 1.3, "a_brk": 1.4,
                                   "min_factor": 0.7, "catchup_max": 1.4}),
    ("S70 SMOOTH shipped (yield+clamps)", {**NEW, "seed_speed": True, "stuck_hold": True,
                                           "a_acc": 1.3, "a_brk": 1.4, "ahead_slow": True,
                                           "min_factor": 0.7, "catchup_max": 1.4}),
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
r = results.get("R62 REALISM shipped (#2+#3+#4a)")
if r is not None:
    print(f"\nREALISM GATE (R62 vs NEW, {PATH}):")
    print(f"  median |fix err|   NEW {n['p50']:.1f} -> R62 {r['p50']:.1f} m "
          f"({100 * (r['p50'] - n['p50']) / n['p50']:+.1f}%)")
    print(f"  signed p50         NEW {n['sp50']:+.1f} -> R62 {r['sp50']:+.1f}; "
          f"%ahead NEW {n['ahead']:.1f} -> R62 {r['ahead']:.1f}")
    print(f"  fresh-sim |err|    p50 NEW {n['fresh_p50']:.1f} -> R62 {r['fresh_p50']:.1f}; "
          f"p90 NEW {n['fresh_p90']:.1f} -> R62 {r['fresh_p90']:.1f}  [n={r['n_fresh']}]")
s70 = results.get("S70 SMOOTH shipped (yield+clamps)")
if r is not None and s70 is not None:
    print(f"\nSMOOTH GATE (S70 vs R62, {PATH}):")
    print(f"  median |fix err|   R62 {r['p50']:.1f} -> S70 {s70['p50']:.1f} m "
          f"({100 * (s70['p50'] - r['p50']) / r['p50']:+.1f}%)")
    print(f"  signed p50         R62 {r['sp50']:+.1f} -> S70 {s70['sp50']:+.1f}; "
          f"%ahead R62 {r['ahead']:.1f} -> S70 {s70['ahead']:.1f}")
    print(f"  fresh-sim |err|    p50 R62 {r['fresh_p50']:.1f} -> S70 {s70['fresh_p50']:.1f}; "
          f"p90 R62 {r['fresh_p90']:.1f} -> S70 {s70['fresh_p90']:.1f}  [n={s70['n_fresh']}]")

print("\nlogged reality for comparison (device session): at-fix |err| p50=86 p90=260, "
      "signed p50=-38, %ahead=27.1, devM p50=130 p90=413")
