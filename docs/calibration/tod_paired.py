#!/usr/bin/env python3
"""Paired within-tram TOD test between two time buckets (day round 7+ method).

Rerun:  python3 docs/calibration/tod_paired.py <jsonl> \
            --a "2026-07-12 06:00" "2026-07-12 07:00" \
            --b "2026-07-12 08:00" "2026-07-12 08:40"

For every tram present in BOTH buckets (day_prior filters per bucket: >=3 AVL
fixes, >=1 converged bias record (!= 1.0, != 0.62 seed), sim age > 5 min):
  - Δbias  = median converged bias in B - in A
  - Δspeed = median moving inter-fix speed (poll Δobs/Δt > 3 km/h) in B - in A
Fleet composition cancels out — this isolates the time-of-day effect from the
kt8d5-share / new-tram-influx artifacts that move record-weighted medians.
Split by centre-majority (tram spends >50% of its B-bucket records in the
centre bbox) — the peak signal is expected to be centre-led.
"""

import json
import math
import sys
from collections import defaultdict
from datetime import datetime

NIGHT_LINES = {str(x) for x in range(91, 100)}
CENTER = (14.395, 50.068, 14.46, 50.096)
PRIOR = 0.62
MIN_FIXES = 3
MIN_AGE_MS = 5 * 60 * 1000


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = math.floor(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def ts(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M").timestamp() * 1000


args = sys.argv[1:]
paths, wa, wb = [], None, None
i = 0
while i < len(args):
    if args[i] == "--a":
        wa = (ts(args[i + 1]), ts(args[i + 2]))
        i += 3
    elif args[i] == "--b":
        wb = (ts(args[i + 1]), ts(args[i + 2]))
        i += 3
    else:
        paths.append(args[i])
        i += 1
if not paths:
    paths = ["docs/calibration/sim-sessions/sim-2026-07-12.jsonl"]
assert wa and wb, "--a t0 t1 --b t0 t1 required"

first_seen = {}
buck = {"A": defaultdict(list), "B": defaultdict(list)}
for p in paths:
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            k = r["key"]
            if k not in first_seen or r["t"] < first_seen[k]:
                first_seen[k] = r["t"]
            if r["line"] in NIGHT_LINES:
                continue
            if wa[0] <= r["t"] < wa[1]:
                buck["A"][k].append(r)
            elif wb[0] <= r["t"] < wb[1]:
                buck["B"][k].append(r)


def tram_stats(rs, key):
    """(median_bias, median_moving_kmh, centre_share) or None if filters fail."""
    fixes = 0
    last_obs = last_t = None
    speeds = []
    centre_n = 0
    for r in rs:
        if r.get("lng") is not None:
            w, s_, e, n = CENTER
            if w <= r["lng"] <= e and s_ <= r["lat"] <= n:
                centre_n += 1
        if last_obs is not None and r["obsDist"] != last_obs:
            fixes += 1
            dt = (r["t"] - last_t) / 1000
            ds = r["obsDist"] - last_obs
            if 4 <= dt <= 120 and 0 <= ds <= dt * 22:
                kmh = ds / dt * 3.6
                if kmh > 3:
                    speeds.append(kmh)
        if last_obs is None or r["obsDist"] != last_obs:
            last_obs, last_t = r["obsDist"], r["t"]
    if fixes < MIN_FIXES:
        return None
    if rs[-1]["t"] - first_seen[key] <= MIN_AGE_MS:
        return None
    conv = [r["bias"] for r in rs if r.get("bias") is not None
            and abs(r["bias"] - 1.0) > 1e-9 and abs(r["bias"] - PRIOR) > 1e-9]
    if not conv:
        return None
    return (pct(conv, 50), pct(speeds, 50) if speeds else None,
            centre_n / max(1, len(rs)))


pairs = []
for k in set(buck["A"]) & set(buck["B"]):
    sa = tram_stats(buck["A"][k], k)
    sb = tram_stats(buck["B"][k], k)
    if sa and sb:
        pairs.append((k, sa, sb))

print(f"files: {paths}")
print(f"bucket A: {datetime.fromtimestamp(wa[0]/1000)} .. {datetime.fromtimestamp(wa[1]/1000)}"
      f"  trams {len(buck['A'])}")
print(f"bucket B: {datetime.fromtimestamp(wb[0]/1000)} .. {datetime.fromtimestamp(wb[1]/1000)}"
      f"  trams {len(buck['B'])}")
print(f"paired trams passing filters in both: {len(pairs)}")


def report(name, sel):
    ps = [p for p in pairs if sel(p)]
    if not ps:
        print(f"{name:24s} n=0")
        return
    db = [b[0] - a[0] for _, a, b in ps]
    up = sum(1 for x in db if x > 0)
    dn = sum(1 for x in db if x < 0)
    dv = [(b[1] - a[1]) for _, a, b in ps if a[1] is not None and b[1] is not None]
    vup = sum(1 for x in dv if x > 0)
    vdn = sum(1 for x in dv if x < 0)
    print(f"{name:24s} n={len(ps):3d}  Δbias p50={pct(db,50):+.3f} "
          f"(up/dn {up}/{dn})   Δspeed p50={pct(dv,50) if dv else float('nan'):+.2f} km/h "
          f"(up/dn {vup}/{vdn}, n={len(dv)})")


report("ALL paired", lambda p: True)
report("centre-majority (B)", lambda p: p[2][2] > 0.5)
report("outskirts-majority (B)", lambda p: p[2][2] <= 0.5)
# disjoint parity check on the paired set
report("even fleet numbers", lambda p: p[0].isdigit() and int(p[0]) % 2 == 0)
report("odd fleet numbers", lambda p: p[0].isdigit() and int(p[0]) % 2 == 1)
