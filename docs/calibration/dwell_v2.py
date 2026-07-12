#!/usr/bin/env python3
"""Schema-v2 analysis: REAL dwell times + true feed speed (day round 8+).

Rerun:  python3 docs/calibration/dwell_v2.py <jsonl> [--since "YYYY-MM-DD HH:MM"]
            [--until "YYYY-MM-DD HH:MM"]

Uses ONLY v2 lines (presence of `obsAt`; builds from 2026-07-12 ~07:47 emit
them — see plan.md "Record schema"). v1 lines in the same file are skipped.

Real fixes: records deduped per tram by obsAt (obsAt = observedAtMs of the
last real AVL fix; repeated across polls until the next fix arrives). All
timing below uses Δ(obsAt) — the feed's own clock — not poll timestamps.

1. FIX CADENCE — Δ(obsAt) between consecutive fixes: the detectability floor
   for dwells (a dwell shorter than one fix interval can land 0-1 fixes at
   the stop and is invisible → measured dwell medians are censored UP).

2. TRUE FEED SPEED — Δ(obsDist)/Δ(obsAt) between consecutive fixes (0 <= ds,
   2 s <= dt <= 120 s, <80 km/h sanity). Poll-quantized speeds in
   analyze.py/night_profile.py add up to one poll interval of timing noise;
   this is exact per the AVL clock. Split by hour × centre/outskirts.

3. REAL DWELLS — maximal runs of >=2 consecutive fixes with per-step
   |Δ obsDist| <= 5 m, majority statePos == 'at_stop', BOUNDED by a moving
   step (> 20 m) on both sides (unbounded runs = terminal layovers / data
   edges — reported separately). Attributed to (line, nextSeq) of the run.
     duration LOWER bound = obsAt[last of run] - obsAt[first of run]
     duration UPPER bound = obsAt[next moving fix] - obsAt[fix before run]
   Truth lies between (tram stops before its first flat fix and departs
   before the fix that shows movement). MID = (lower+upper)/2 is the honest
   point estimate. Engine base: DEFAULT_DWELL_S = 18 s (± 8 s deterministic
   jitter) × TOD_DWELL_TABLE — the default is used only at stops WITHOUT a
   scheduled computed_dwell; the measured population mixes both.
   Flat runs with majority 'on_track' = traffic stops (signals/congestion),
   reported separately — they are NOT dwell and must not feed TOD_DWELL.
"""

import json
import math
import sys
from collections import defaultdict
from datetime import datetime

CENTER = (14.395, 50.068, 14.46, 50.096)
NIGHT_LINES = {str(x) for x in range(91, 100)}
FLAT_M = 5          # per-step |Δobs| <= this = stationary
MOVE_M = 20         # bounding step must advance > this
MAX_DT_S = 120      # speed-sample sanity
MAX_DWELL_UPPER_S = 600  # drop pathological runs (blocked line / bad segment)


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = math.floor(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def parse_args(argv):
    paths, since, until = [], None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--since":
            since = datetime.strptime(argv[i + 1], "%Y-%m-%d %H:%M").timestamp() * 1000
            i += 2
        elif a == "--until":
            until = datetime.strptime(argv[i + 1], "%Y-%m-%d %H:%M").timestamp() * 1000
            i += 2
        else:
            paths.append(a)
            i += 1
    return paths, since, until


paths, SINCE, UNTIL = parse_args(sys.argv[1:])
if not paths:
    paths = ["docs/calibration/sim-sessions/sim-2026-07-12.jsonl"]

# ---- load v2 lines, dedupe to real fixes ------------------------------------
by_tram = defaultdict(dict)   # key -> {obsAt: record}  (first record per fix)
n_v1 = n_v2 = 0
for p in paths:
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if '"obsAt"' not in line:
                n_v1 += 1
                continue
            r = json.loads(line)
            if r.get("obsAt") is None:
                n_v1 += 1
                continue
            n_v2 += 1
            if SINCE and r["t"] < SINCE:
                continue
            if UNTIL and r["t"] >= UNTIL:
                continue
            if r["line"] in NIGHT_LINES:
                continue
            fixes = by_tram[r["key"]]
            if r["obsAt"] not in fixes:
                fixes[r["obsAt"]] = r

by_tram = {k: [v[t] for t in sorted(v)] for k, v in by_tram.items() if len(v) >= 2}
if not by_tram:
    print("no v2 fixes after filters")
    sys.exit(1)

all_fixes = [r for rs in by_tram.values() for r in rs]
t0 = min(r["obsAt"] for r in all_fixes)
t1 = max(r["obsAt"] for r in all_fixes)
print(f"files: {paths}")
print(f"v2 poll-lines {n_v2} (v1 skipped {n_v1}); window (obsAt) "
      f"{datetime.fromtimestamp(t0/1000)} .. {datetime.fromtimestamp(t1/1000)} "
      f"({(t1-t0)/60000:.1f} min)")
print(f"trams {len(by_tram)}, real fixes {len(all_fixes)} "
      f"({len(all_fixes)/len(by_tram):.0f}/tram)")


def in_center(r):
    if r.get("lng") is None or r.get("lat") is None:
        return False
    w, s, e, n = CENTER
    return w <= r["lng"] <= e and s <= r["lat"] <= n


def hour_of(ms):
    return datetime.fromtimestamp(ms / 1000).hour  # machine tz == Prague


# ---- segments (trip changes), cadence, feed speed ---------------------------
cad = []                      # Δ(obsAt) s, within segment
speed_h = defaultdict(list)   # hour -> feed kmh (all)
moving_h = defaultdict(list)  # hour -> feed kmh > 3
centre_h = defaultdict(list)
out_h = defaultdict(list)
segments = {}                 # key -> list of fix lists

for key, rs in by_tram.items():
    segs = [[rs[0]]]
    for r in rs[1:]:
        if r["obsDist"] < segs[-1][-1]["obsDist"] - 2000:
            segs.append([r])
        else:
            segs[-1].append(r)
    segments[key] = segs
    for seg in segs:
        for a, b in zip(seg, seg[1:]):
            dt = (b["obsAt"] - a["obsAt"]) / 1000
            ds = b["obsDist"] - a["obsDist"]
            if 0 < dt <= MAX_DT_S:
                cad.append(dt)
            if 2 <= dt <= MAX_DT_S and 0 <= ds <= dt * 22:
                kmh = ds / dt * 3.6
                h = hour_of(b["obsAt"])
                speed_h[h].append(kmh)
                if kmh > 3:
                    moving_h[h].append(kmh)
                    (centre_h if in_center(b) else out_h)[h].append(kmh)

print(f"\n== 1. REAL FIX CADENCE Δ(obsAt) (s) — dwell detectability floor ==")
print(f"n={len(cad)} p10={pct(cad,10):.0f} p25={pct(cad,25):.0f} p50={pct(cad,50):.0f} "
      f"p75={pct(cad,75):.0f} p90={pct(cad,90):.0f}")
print(f"(dwells shorter than ~p50 land <2 fixes at the stop and are mostly "
      f"invisible; measured dwell medians are censored UP accordingly)")

print(f"\n== 2. TRUE FEED SPEED Δobs/Δ(obsAt), km/h (moving > 3) ==")
print(f"{'h':>2s} {'n_mov':>6s} {'p50':>6s} {'p75':>6s} {'p90':>6s} "
      f"{'centre p50':>10s} {'out p50':>8s} {'all-p50(incl dwell)':>19s}")
for h in sorted(moving_h):
    mv, ce, ou = moving_h[h], centre_h[h], out_h[h]
    print(f"{h:2d} {len(mv):6d} {pct(mv,50):6.1f} {pct(mv,75):6.1f} {pct(mv,90):6.1f} "
          f"{pct(ce,50) if ce else float('nan'):10.1f} "
          f"{pct(ou,50) if ou else float('nan'):8.1f} "
          f"{pct(speed_h[h],50):19.1f}")

# ---- dwell runs --------------------------------------------------------------
dwells = []          # dict(lower, upper, mid, line, nextSeq, hour, centre)
traffic_stops = []   # same, majority on_track
unbounded = 0        # terminal layover / edge runs (not scored)
short_census = 0     # moving steps that jump a whole stop spacing (context)

for key, segs in segments.items():
    for seg in segs:
        i = 0
        n = len(seg)
        while i < n - 1:
            # find start of a flat run
            if abs(seg[i + 1]["obsDist"] - seg[i]["obsDist"]) <= FLAT_M:
                j = i + 1
                while j < n - 1 and abs(seg[j + 1]["obsDist"] - seg[j]["obsDist"]) <= FLAT_M:
                    j += 1
                run = seg[i:j + 1]
                lower = (run[-1]["obsAt"] - run[0]["obsAt"]) / 1000
                bounded_in = i > 0 and (run[0]["obsDist"] - seg[i - 1]["obsDist"]) > MOVE_M
                bounded_out = j < n - 1 and (seg[j + 1]["obsDist"] - run[-1]["obsDist"]) > MOVE_M
                if bounded_in and bounded_out:
                    upper = (seg[j + 1]["obsAt"] - seg[i - 1]["obsAt"]) / 1000
                    at_stop_n = sum(1 for r in run if r.get("statePos") == "at_stop")
                    rec = dict(
                        lower=lower, upper=upper, mid=(lower + upper) / 2,
                        line=run[0]["line"], nextSeq=run[0].get("nextSeq"),
                        hour=hour_of(run[0]["obsAt"]), centre=in_center(run[0]),
                        n_fix=len(run))
                    if upper <= MAX_DWELL_UPPER_S:
                        (dwells if at_stop_n * 2 >= len(run) else traffic_stops).append(rec)
                else:
                    unbounded += 1
                i = j
            else:
                i += 1


def dwell_table(name, ds):
    if not ds:
        print(f"{name}: n=0")
        return
    lo = [d["lower"] for d in ds]
    up = [d["upper"] for d in ds]
    mi = [d["mid"] for d in ds]
    print(f"{name}: n={len(ds)}")
    print(f"  lower bound s: p25={pct(lo,25):5.0f} p50={pct(lo,50):5.0f} "
          f"p75={pct(lo,75):5.0f} p90={pct(lo,90):5.0f}")
    print(f"  MID estimate : p25={pct(mi,25):5.0f} p50={pct(mi,50):5.0f} "
          f"p75={pct(mi,75):5.0f} p90={pct(mi,90):5.0f}")
    print(f"  upper bound s: p25={pct(up,25):5.0f} p50={pct(up,50):5.0f} "
          f"p75={pct(up,75):5.0f} p90={pct(up,90):5.0f}")


print(f"\n== 3. REAL DWELLS (flat >=2 fixes, majority at_stop, bounded) ==")
print(f"bounded flat runs: dwell {len(dwells)} / traffic(on_track) {len(traffic_stops)}; "
      f"unbounded (terminal/edge, unscored) {unbounded}")
dwell_table("DWELL (at_stop)", dwells)
dwell_table("TRAFFIC STOP (on_track)", traffic_stops)

print("\nby hour (dwell only):")
byh = defaultdict(list)
for d in dwells:
    byh[d["hour"]].append(d)
for h in sorted(byh):
    ds = byh[h]
    mi = [d["mid"] for d in ds]
    lo = [d["lower"] for d in ds]
    up = [d["upper"] for d in ds]
    print(f"  h{h:02d} n={len(ds):4d}  lower p50={pct(lo,50):4.0f}  "
          f"MID p50={pct(mi,50):4.0f} p90={pct(mi,90):4.0f}  upper p50={pct(up,50):4.0f}")

print("\ncentre vs outskirts (dwell MID s):")
for name, sel in (("centre", True), ("outskirts", False)):
    mi = [d["mid"] for d in dwells if d["centre"] == sel]
    if mi:
        print(f"  {name:9s} n={len(mi):4d} p50={pct(mi,50):4.0f} p90={pct(mi,90):4.0f}")

print("\ntop (line,nextSeq) dwell sites (n>=5, by MID p50):")
site = defaultdict(list)
for d in dwells:
    site[(d["line"], d["nextSeq"])].append(d["mid"])
rows = [(k, len(v), pct(v, 50)) for k, v in site.items() if len(v) >= 5]
for (ln, seq), n, m in sorted(rows, key=lambda x: -x[2])[:12]:
    print(f"  line {ln:>3s} seq {seq!s:>4s}: n={n:3d} MID p50={m:4.0f} s")

# ---- 4. time-budget estimator: MEAN DWELL PER STOP SERVED --------------------
# Per-dwell detection above is censored UP (dwell < fix cadence ~46 s is mostly
# invisible). This estimator is not: over each segment,
#   stops passed  N = nextSeq[last] - nextSeq[first]   (increments per stop,
#                     served or skipped — matching the engine, which dwells at
#                     every stop),
#   stationary time S_low  = Σ Δ(obsAt) over flat steps (|Δobs| <= FLAT_M),
#   S_high = S_low + half of each transition step adjacent to a flat run.
# Mean engine-equivalent dwell per stop ∈ [S_low/N, S_high/N]. Dwells that fit
# entirely inside one inter-fix step contribute 0 to S_low (undercount), so
# truth sits toward the middle/upper part of the band.
tot_stops = 0
s_low = s_high = 0.0
tot_time = 0.0
per_hour = defaultdict(lambda: [0, 0.0, 0.0, 0.0])  # h -> [N, s_low, s_high, T]
per_zone = defaultdict(lambda: [0, 0.0, 0.0, 0.0])  # in_center? -> same (R8 band)
for key, segs in segments.items():
    for seg in segs:
        seqs = [r.get("nextSeq") for r in seg if r.get("nextSeq") is not None]
        if len(seqs) < 2 or len(seg) < 3:
            continue
        n_stops = seqs[-1] - seqs[0]
        if n_stops < 1 or n_stops > 60:   # resets / bad segments
            continue
        lo = hi = 0.0
        flat_prev = False
        steps = list(zip(seg, seg[1:]))
        for si, (a, b) in enumerate(steps):
            h = hour_of(b["obsAt"])
            z = in_center(b)
            dt = (b["obsAt"] - a["obsAt"]) / 1000
            if dt <= 0 or dt > MAX_DT_S:
                flat_prev = False
                continue
            # per-hour: stops passed on this step, time on this step
            if a.get("nextSeq") is not None and b.get("nextSeq") is not None:
                dseq = b["nextSeq"] - a["nextSeq"]
                if 0 <= dseq <= 5:
                    per_hour[h][0] += dseq
                    per_zone[z][0] += dseq
            per_hour[h][3] += dt
            per_zone[z][3] += dt
            flat = abs(b["obsDist"] - a["obsDist"]) <= FLAT_M
            if flat:
                lo += dt
                hi += dt
                per_hour[h][1] += dt
                per_hour[h][2] += dt
                per_zone[z][1] += dt
                per_zone[z][2] += dt
                if not flat_prev:      # transition INTO the run (prev step)
                    pa, pb = steps[si - 1] if si > 0 else (None, None)
                    if pa is not None:
                        pdt = (pb["obsAt"] - pa["obsAt"]) / 1000
                        if 0 < pdt <= MAX_DT_S:
                            hi += pdt / 2
                            per_hour[h][2] += pdt / 2
                            per_zone[z][2] += pdt / 2
            else:
                if flat_prev:          # transition OUT of the run
                    hi += dt / 2
                    per_hour[h][2] += dt / 2
                    per_zone[z][2] += dt / 2
            flat_prev = flat
        T = (seg[-1]["obsAt"] - seg[0]["obsAt"]) / 1000
        tot_stops += n_stops
        s_low += lo
        s_high += hi
        tot_time += T

print(f"\n== 4. TIME-BUDGET: mean dwell per stop served (uncensored) ==")
print(f"segments total: stops passed {tot_stops}, stationary time "
      f"[{s_low:.0f}, {s_high:.0f}] s of {tot_time:.0f} s "
      f"({100*s_low/max(1,tot_time):.0f}-{100*s_high/max(1,tot_time):.0f}% of time)")
print(f"MEAN DWELL PER STOP: [{s_low/max(1,tot_stops):.1f}, "
      f"{s_high/max(1,tot_stops):.1f}] s   (engine default 18 s x TOD_DWELL)")
for h in sorted(per_hour):
    N, lo, hi, T = per_hour[h]
    if N >= 50:
        print(f"  h{h:02d}: stops {N:5d}  dwell/stop [{lo/N:5.1f}, {hi/N:5.1f}] s  "
              f"stationary {100*lo/max(1,T):.0f}-{100*hi/max(1,T):.0f}% of time")
for z in (True, False):
    N, lo, hi, T = per_zone[z]
    if N >= 50:
        print(f"  {'centre' if z else 'outskirts':9s}: stops {N:5d}  "
              f"dwell/stop [{lo/N:5.1f}, {hi/N:5.1f}] s  "
              f"stationary {100*lo/max(1,T):.0f}-{100*hi/max(1,T):.0f}% of time")

print(f"\nengine reference: DEFAULT_DWELL_S=18 (±8 jitter) × TOD_DWELL (currently 1.0);"
      f"\nscheduled computed_dwell stops are mixed into the measured population.")
