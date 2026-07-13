#!/usr/bin/env python3
"""Day-fleet PACE_BIAS_PRIOR re-measurement (day round 6+).

Rerun:  python3 docs/calibration/day_prior.py <jsonl> [--since "YYYY-MM-DD HH:MM"]
            [--until "YYYY-MM-DD HH:MM"] [--prior 0.62]

Estimator (the "honest" one from night rounds 1-5, hardened for the day fleet):
  per-tram MEDIAN converged paceBias (records where bias != 1.0 seed and
  != prior seed), then the fleet median of those per-tram medians. Filters:
    - >=3 AVL fixes (obsDist changes) inside the window (tram actually moving
      and observed, not a parked ghost);
    - sim age > 5 min at the tram's last window record (age = time since the
      tram FIRST appeared anywhere in the file(s), i.e. sim birth; excludes
      sims still converging from the seed — bias half-life is 150 s, so
      >5 min means >=2 half-lives of learning);
    - >=1 converged bias record in the (sub)window.
Robustness subsamples (all disjoint):
    - window halves (first vs second 50% by time);
    - even vs odd fleet number (int(key) % 2).
A real prior miscalibration must read on the same side of the prior in ALL
subsamples; per-tram above/below split must not be a coin flip.
Night lines 91-99 are excluded by default (day-fleet prior); use
--fleet night for the 91-99 segment or --fleet all (Monday round 26+;
Sunday h0-h4 whole-fleet norms were night-line-dominated windows).
--zone centre|out|all (round 28): record-level CENTER-bbox filter for the
07:00/19:00 cap-boundary mirror checks (default all = historical).
"""

import json
import math
import sys
from collections import defaultdict
from datetime import datetime

NIGHT_LINES = {str(x) for x in range(91, 100)}
CENTER = (14.395, 50.068, 14.46, 50.096)  # lng0, lat0, lng1, lat1 (plan.md bbox)
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


def parse_args(argv):
    paths, since, until, prior, fleet, zone = [], None, None, 0.62, "day", "all"
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--since":
            since = datetime.strptime(argv[i + 1], "%Y-%m-%d %H:%M").timestamp() * 1000
            i += 2
        elif a == "--until":
            until = datetime.strptime(argv[i + 1], "%Y-%m-%d %H:%M").timestamp() * 1000
            i += 2
        elif a == "--prior":
            prior = float(argv[i + 1])
            i += 2
        elif a == "--fleet":
            fleet = argv[i + 1]  # day (default, historical) | night (91-99 only) | all
            assert fleet in ("day", "night", "all"), "--fleet day|night|all"
            i += 2
        elif a == "--zone":
            # centre = records inside the CENTER bbox only; out = outside only;
            # all (default, historical) = no positional filter. Record-level
            # filter (round 28, for the 07:00 cap-boundary mirror check).
            zone = argv[i + 1]
            assert zone in ("centre", "out", "all"), "--zone centre|out|all"
            i += 2
        else:
            paths.append(a)
            i += 1
    return paths, since, until, prior, fleet, zone


paths, SINCE, UNTIL, PRIOR, FLEET, ZONE = parse_args(sys.argv[1:])
if not paths:
    paths = ["docs/calibration/sim-sessions/sim-2026-07-12.jsonl"]

# First pass: sim birth = first record per key ANYWHERE in the file(s)
# (the app runs continuously; a sim is born when the tram enters the feed).
first_seen = {}
records = []
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
            if SINCE and r["t"] < SINCE:
                continue
            if UNTIL and r["t"] >= UNTIL:
                continue
            is_night = r["line"] in NIGHT_LINES
            if (FLEET == "day" and is_night) or (FLEET == "night" and not is_night):
                continue
            if ZONE != "all":
                lng, lat = r.get("lng"), r.get("lat")
                in_centre = (lng is not None and lat is not None
                             and CENTER[0] <= lng <= CENTER[2]
                             and CENTER[1] <= lat <= CENTER[3])
                if (ZONE == "centre") != in_centre:
                    continue
            records.append(r)

records.sort(key=lambda r: (r["key"], r["t"]))
if not records:
    print("no records after filters")
    sys.exit(1)

t0 = min(r["t"] for r in records)
t1 = max(r["t"] for r in records)
by_tram = defaultdict(list)
for r in records:
    by_tram[r["key"]].append(r)

print(f"files: {paths}   prior under test: {PRIOR}")
print(f"window: {datetime.fromtimestamp(t0/1000)} .. {datetime.fromtimestamp(t1/1000)} "
      f"({(t1-t0)/60000:.1f} min), day-line records {len(records)}, trams {len(by_tram)}")


def measure(name, rs_by_tram):
    """rs_by_tram: {key: [records]} for one (sub)window. Returns fleet median."""
    per_tram = []
    n_fix_fail = n_age_fail = n_noconv = 0
    for key, rs in sorted(rs_by_tram.items()):
        fixes = 0
        last_obs = None
        for r in rs:
            if last_obs is None or r["obsDist"] != last_obs:
                fixes += 1 if last_obs is not None else 0
                last_obs = r["obsDist"]
        if fixes < MIN_FIXES:
            n_fix_fail += 1
            continue
        if rs[-1]["t"] - first_seen[key] <= MIN_AGE_MS:
            n_age_fail += 1
            continue
        conv = [r["bias"] for r in rs
                if r.get("bias") is not None
                and abs(r["bias"] - 1.0) > 1e-9 and abs(r["bias"] - PRIOR) > 1e-9]
        if not conv:
            n_noconv += 1
            continue
        per_tram.append(pct(conv, 50))
    if not per_tram:
        print(f"{name:28s} n=0 (excluded: fixes {n_fix_fail}, age {n_age_fail}, "
              f"no converged bias {n_noconv})")
        return None
    med = pct(per_tram, 50)
    above = sum(1 for b in per_tram if b > PRIOR)
    below = sum(1 for b in per_tram if b < PRIOR)
    print(f"{name:28s} trams={len(per_tram):3d} fleet p50={med:.3f} "
          f"mean={sum(per_tram)/len(per_tram):.3f} p25={pct(per_tram,25):.3f} "
          f"p75={pct(per_tram,75):.3f}  above/below prior {above}/{below}  "
          f"deviation x{med/PRIOR:.3f}  (excl: fix {n_fix_fail} age {n_age_fail} "
          f"noconv {n_noconv})")
    return med


print(f"\n== per-tram median converged bias (>= {MIN_FIXES} fixes, sim age > "
      f"{MIN_AGE_MS//60000} min) ==")
measure("FULL window", by_tram)

tm = (t0 + t1) / 2
half_a = {k: [r for r in rs if r["t"] < tm] for k, rs in by_tram.items()}
half_b = {k: [r for r in rs if r["t"] >= tm] for k, rs in by_tram.items()}
half_a = {k: v for k, v in half_a.items() if v}
half_b = {k: v for k, v in half_b.items() if v}
print(f"\n-- disjoint by time (split at {datetime.fromtimestamp(tm/1000).time()}) --")
measure("half A (first 30 min)", half_a)
measure("half B (second 30 min)", half_b)

even = {k: v for k, v in by_tram.items() if k.isdigit() and int(k) % 2 == 0}
odd = {k: v for k, v in by_tram.items() if k.isdigit() and int(k) % 2 == 1}
print("\n-- disjoint by fleet number parity --")
measure("even fleet numbers", even)
measure("odd fleet numbers", odd)

print("\n-- parity x time (4-way disjoint) --")
measure("even, half A", {k: v for k, v in half_a.items() if k.isdigit() and int(k) % 2 == 0})
measure("even, half B", {k: v for k, v in half_b.items() if k.isdigit() and int(k) % 2 == 0})
measure("odd, half A", {k: v for k, v in half_a.items() if k.isdigit() and int(k) % 2 == 1})
measure("odd, half B", {k: v for k, v in half_b.items() if k.isdigit() and int(k) % 2 == 1})

# context: by model family (top models), FULL window — is the read fleet-wide
# or driven by one family?
models = defaultdict(dict)
for k, rs in by_tram.items():
    models[rs[0]["model"]][k] = rs
print("\n-- by model family (context, FULL window) --")
for m in sorted(models, key=lambda m: -len(models[m])):
    if len(models[m]) >= 10:
        measure(f"model {m}", models[m])
