#!/usr/bin/env python3
"""Night-round calibration analysis: per-hour-of-day profile (22-05 focus).

Rerun:  python3 docs/calibration/night_profile.py <jsonl> [<jsonl> ...] \
            [--since "YYYY-MM-DD HH:MM"] [--until "YYYY-MM-DD HH:MM"] \
            [--lines 91,92,...]

Same record schema as analyze.py. Computes, per Prague-local hour bucket:
  - fleet composition (trams, records, night-route share)
  - REAL inter-fix speeds (Δobs/Δt, 4s<=Δt<=120s, sane advance) all + moving>3,
    and the implied pace ratio vs V_CRUISE_REF (42 km/h) — what the TOD_PACE
    entry would need to be if paceBias were 1.0 (it isn't: converged bias
    already absorbs fleet-median pace; the TOD entry should only encode the
    hour-dependent DEVIATION from the fleet-average the prior/bias covers)
  - fresh-fix prediction error (prev poll's simDist/projDist vs new obsDist)
    with n per bucket — the >=300-samples gate for touching a TOD entry
  - paceBias distribution (converged: != seed 0.62 and != 1.0)
  - dwell-dominated share of inter-fix intervals (advance < 10 m) — the only
    dwell observable without obsAtMs/stop table (see analysis §7 caveat)
"""

import json
import math
import sys
from collections import defaultdict
from datetime import datetime

V_CRUISE_REF_KMH = 42.0  # R3 reference, speedProfile.ts V_CRUISE_REF_MS=11.7
PACE_BIAS_PRIOR = 0.62
NIGHT_LINES = {str(x) for x in range(91, 100)}
CENTER = (14.395, 50.068, 14.46, 50.096)


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = math.floor(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def parse_args(argv):
    paths, since, until, lines = [], None, None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--since":
            since = datetime.strptime(argv[i + 1], "%Y-%m-%d %H:%M").timestamp() * 1000
            i += 2
        elif a == "--until":
            until = datetime.strptime(argv[i + 1], "%Y-%m-%d %H:%M").timestamp() * 1000
            i += 2
        elif a == "--lines":
            lines = set(argv[i + 1].split(","))
            i += 2
        else:
            paths.append(a)
            i += 1
    return paths, since, until, lines


paths, SINCE, UNTIL, LINES = parse_args(sys.argv[1:])
if not paths:
    paths = ["docs/calibration/sim-sessions/sim-2026-07-12.jsonl"]

records = []
for p in paths:
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if SINCE and r["t"] < SINCE:
                continue
            if UNTIL and r["t"] >= UNTIL:
                continue
            if LINES and r["line"] not in LINES:
                continue
            records.append(r)

records.sort(key=lambda r: (r["key"], r["t"]))
if not records:
    print("no records after filters")
    sys.exit(1)

by_tram = defaultdict(list)
for r in records:
    by_tram[r["key"]].append(r)


def hour_of(t):
    return datetime.fromtimestamp(t / 1000).hour  # machine tz == Prague


t0 = min(r["t"] for r in records)
t1 = max(r["t"] for r in records)
print(f"files: {paths}")
print(f"window: {datetime.fromtimestamp(t0/1000)} .. {datetime.fromtimestamp(t1/1000)} "
      f"({(t1-t0)/60000:.1f} min), records {len(records)}, trams {len(by_tram)}")
nrl = sum(1 for r in records if r["line"] in NIGHT_LINES)
print(f"night-route (91-99) records: {nrl} ({100*nrl/len(records):.0f}%)")

# ---- per-hour aggregation ---------------------------------------------------
speed_h = defaultdict(list)       # real inter-fix kmh (incl dwell)
moving_h = defaultdict(list)      # kmh > 3
dwellish_h = defaultdict(int)     # intervals with advance < 10 m
ivl_h = defaultdict(int)          # total scored intervals
fix_ivl_h = defaultdict(list)     # fix refresh interval s
simfix_h = defaultdict(list)      # at-fix signed err smooth sim
projfix_h = defaultdict(list)     # at-fix signed err projSim
bias_h = defaultdict(list)        # converged bias values
speed_night_h = defaultdict(list)  # moving, night routes only
speed_center_h = defaultdict(list)
speed_out_h = defaultdict(list)
trams_h = defaultdict(set)

for key, rs in by_tram.items():
    last_obs, last_t = None, None
    for i, r in enumerate(rs):
        h = hour_of(r["t"])
        trams_h[h].add(key)
        b = r.get("bias")
        if b is not None and abs(b - 1.0) > 1e-9 and abs(b - PACE_BIAS_PRIOR) > 1e-9:
            bias_h[h].append(b)
        if last_obs is not None and r["obsDist"] != last_obs:
            dt = (r["t"] - last_t) / 1000
            ds = r["obsDist"] - last_obs
            if dt <= 120:
                fix_ivl_h[h].append(dt)
            if 4 <= dt <= 120 and 0 <= ds <= dt * 22:
                kmh = ds / dt * 3.6
                speed_h[h].append(kmh)
                ivl_h[h] += 1
                if ds < 10:
                    dwellish_h[h] += 1
                if kmh > 3:
                    moving_h[h].append(kmh)
                    if r["line"] in NIGHT_LINES:
                        speed_night_h[h].append(kmh)
                    w, s_, e, n = CENTER
                    if r.get("lng") is None or r.get("lat") is None:
                        pass  # no rendered position logged (rare) — skip zone split
                    elif w <= r["lng"] <= e and s_ <= r["lat"] <= n:
                        speed_center_h[h].append(kmh)
                    else:
                        speed_out_h[h].append(kmh)
            # at-fix probe (same rules as analyze.py)
            prev = rs[i - 1]
            if (prev.get("simDist") is not None
                    and r["t"] - prev["t"] < 15000
                    and r["obsDist"] >= prev["obsDist"] - 2000):
                simfix_h[h].append(prev["simDist"] - r["obsDist"])
                if prev.get("projDist") is not None:
                    projfix_h[h].append(prev["projDist"] - r["obsDist"])
        if last_obs is None or r["obsDist"] != last_obs:
            last_obs, last_t = r["obsDist"], r["t"]

hours = sorted(set(list(speed_h) + list(simfix_h)),
               key=lambda h: (h - 12) % 24)  # order 12..23,0..11 → night contiguous

print("\n== REAL SPEED PROFILE by Prague hour (moving > 3 km/h) ==")
print(f"{'h':>2s} {'trams':>5s} {'n_mov':>6s} {'p50':>6s} {'p75':>6s} {'p90':>6s} "
      f"{'p50/42':>6s} {'night-rt p50':>12s} {'centre p50':>10s} {'out p50':>8s} "
      f"{'dwell-ish%':>10s} {'fixIvl p50':>10s}")
for h in hours:
    mv = moving_h[h]
    if not mv and not simfix_h[h]:
        continue
    nn = speed_night_h[h]
    ce, ou = speed_center_h[h], speed_out_h[h]
    dw = 100 * dwellish_h[h] / max(1, ivl_h[h])
    print(f"{h:2d} {len(trams_h[h]):5d} {len(mv):6d} {pct(mv,50):6.1f} {pct(mv,75):6.1f} "
          f"{pct(mv,90):6.1f} {pct(mv,50)/V_CRUISE_REF_KMH:6.2f} "
          f"{pct(nn,50) if nn else float('nan'):12.1f} "
          f"{pct(ce,50) if ce else float('nan'):10.1f} "
          f"{pct(ou,50) if ou else float('nan'):8.1f} "
          f"{dw:9.1f}% {pct(fix_ivl_h[h],50):10.0f}")

print("\n== FRESH-FIX PREDICTION ERROR by hour (gate: n>=300 to touch a TOD entry) ==")
print(f"{'h':>2s} {'n_fix':>6s} {'sim sgn p50':>11s} {'sim |e| p50':>11s} {'sim |e| p90':>11s} "
      f"{'%ahead':>7s} {'proj |e| p50':>12s}")
for h in hours:
    sf = simfix_h[h]
    if not sf:
        continue
    ab = [abs(x) for x in sf]
    pj = [abs(x) for x in projfix_h[h]]
    ahead = 100 * sum(1 for x in sf if x > 0) / len(sf)
    print(f"{h:2d} {len(sf):6d} {pct(sf,50):11.1f} {pct(ab,50):11.1f} {pct(ab,90):11.1f} "
          f"{ahead:6.1f}% {pct(pj,50) if pj else float('nan'):12.1f}")

print("\n== paceBias (converged: != 1.0 and != 0.62 seed) by hour ==")
print(f"{'h':>2s} {'n':>6s} {'p50':>6s} {'mean':>6s} {'p10':>6s} {'p90':>6s} "
      f"{'<=0.45':>7s} {'implied ref x bias, km/h':>24s}")
for h in hours:
    bs = bias_h[h]
    if not bs:
        continue
    lo = 100 * sum(1 for b in bs if b <= 0.45) / len(bs)
    print(f"{h:2d} {len(bs):6d} {pct(bs,50):6.2f} {sum(bs)/len(bs):6.2f} "
          f"{pct(bs,10):6.2f} {pct(bs,90):6.2f} {lo:6.1f}% "
          f"{pct(bs,50)*V_CRUISE_REF_KMH:24.1f}")

# ---- fresh-sim vs converged split of the at-fix probe -----------------------
# "fresh" = the sim still sits at its seed bias at the PREVIOUS poll: exactly
# 1.0 (pre-R1 builds) or exactly 0.62 (R1 PACE_BIAS_PRIOR seed). This is the
# live R1 test: pre-R1 fresh sims sprinted (+25.5 signed p50, |e| p90 385 on
# the device session); with the 0.62 prior they should not.
fresh_err, conv_err = [], []
for key, rs in by_tram.items():
    last_obs = None
    for i, r in enumerate(rs):
        if last_obs is not None and r["obsDist"] != last_obs:
            prev = rs[i - 1]
            if (prev.get("simDist") is not None
                    and r["t"] - prev["t"] < 15000
                    and r["obsDist"] >= prev["obsDist"] - 2000):
                b = prev.get("bias")
                e = prev["simDist"] - r["obsDist"]
                if b is not None and (abs(b - 1.0) < 1e-9 or abs(b - PACE_BIAS_PRIOR) < 1e-9):
                    fresh_err.append(e)
                else:
                    conv_err.append(e)
        if last_obs is None or r["obsDist"] != last_obs:
            last_obs = r["obsDist"]

print("\n== AT-FIX ERROR: fresh (seed bias) vs converged sims ==")
for name, xs in (("fresh(seed)", fresh_err), ("converged", conv_err)):
    if not xs:
        print(f"{name:12s} n=0")
        continue
    ab = [abs(x) for x in xs]
    print(f"{name:12s} n={len(xs):5d} signed p50={pct(xs,50):+7.1f} "
          f"|e| p50={pct(ab,50):6.1f} p90={pct(ab,90):6.1f} "
          f"%ahead={100*sum(1 for x in xs if x>0)/len(xs):5.1f}")
print("  (pre-R1 device: fresh n=96 signed +25.5 |e| p90 385, %ahead 56)")

# overall at-fix numbers for direct comparison with round-1 baseline
all_sim = [x for h in simfix_h for x in simfix_h[h]]
all_proj = [x for h in projfix_h for x in projfix_h[h]]
if all_sim:
    ab = [abs(x) for x in all_sim]
    abp = [abs(x) for x in all_proj]
    print(f"\n== OVERALL at-fix probe (window) ==")
    print(f"smooth sim: n={len(all_sim)} signed p50={pct(all_sim,50):+.1f} "
          f"|e| p50={pct(ab,50):.1f} p90={pct(ab,90):.1f} "
          f"%ahead={100*sum(1 for x in all_sim if x>0)/len(all_sim):.1f}")
    print(f"  (round-1 pre-R1 device baseline: signed p50=-38, |e| p50=86, p90=260, %ahead=27.1)")
    print(f"projSim   : n={len(all_proj)} |e| p50={pct(abp,50):.1f} p90={pct(abp,90):.1f}")
