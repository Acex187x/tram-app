#!/usr/bin/env python3
"""Calibration analysis for docs/calibration/session-2026-07-11.jsonl.

Rerun:  python3 docs/calibration/analyze.py [path-to-jsonl]
Output: plain-text tables on stdout (numbers quoted in analysis-2026-07-11.md).

Record schema (one line per tram per poll, ~5 s batch cadence):
  t (unix ms), key, model, line,
  obsDist  raw last AVL fix along shape, m (NOT projected forward -> stale),
  simDist  smooth-sim position, m
  projDist live-projection sim (projSim), m
  devM     |simDist - obsDist| at poll time
  kmh      sim speed
  bias     per-tram paceBias EWMA at that moment (1.0 = fresh sim/teleport)
  lat/lng  rendered (sim) position
  mode     cruise|dwell|terminal|unknown

Engine build: paceBias present (commit bda0255, 22:22), adaptive dwell NOT
present (commit b75f942 landed 23:17:58, mid-session; device build predates it).
"""

import json
import math
import sys
from collections import defaultdict
from datetime import datetime

PATH = sys.argv[1] if len(sys.argv) > 1 else "docs/calibration/session-2026-07-11.jsonl"

CENTER = (14.395, 50.068, 14.46, 50.096)  # w, s, e, n
V_MAX_KMH = 50.0
V_CENTER_KMH = 31.0


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = math.floor(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def stats(xs):
    if not xs:
        return "n=0"
    m = sum(xs) / len(xs)
    return (
        f"n={len(xs):6d} mean={m:8.1f} p50={pct(xs,50):8.1f} p75={pct(xs,75):8.1f} "
        f"p90={pct(xs,90):8.1f} p95={pct(xs,95):8.1f} p99={pct(xs,99):8.1f} max={max(xs):8.1f}"
    )


def in_center(lng, lat):
    w, s, e, n = CENTER
    return w <= lng <= e and s <= lat <= n


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

polls = sorted({r["t"] for r in records})

print("=" * 78)
print("A. DATA HYGIENE")
print("=" * 78)
t0, t1 = polls[0], polls[-1]
print(f"records            : {len(records)}")
print(f"session            : {datetime.fromtimestamp(t0/1000)} .. {datetime.fromtimestamp(t1/1000)}"
      f"  ({(t1-t0)/60000:.1f} min)")
print(f"distinct poll ts   : {len(polls)}")
gaps = [(polls[i + 1] - polls[i]) / 1000 for i in range(len(polls) - 1)]
print(f"poll cadence (s)   : {stats(gaps)}")
big_gaps = [(polls[i], g) for i, g in enumerate(gaps) if g > 15]
for ts, g in big_gaps:
    print(f"  gap > 15 s at {datetime.fromtimestamp(ts/1000).time()} -> {g:.1f} s")
print(f"distinct trams     : {len(by_tram)}")
models = defaultdict(int)
lines = defaultdict(int)
for r in records:
    models[r["model"]] += 1
    lines[r["line"]] += 1
print("records by model   :", dict(sorted(models.items(), key=lambda kv: -kv[1])))
print("records by line    :", dict(sorted(lines.items(), key=lambda kv: -kv[1])))
per_tram_n = sorted(len(v) for v in by_tram.values())
print(f"records per tram   : {stats(per_tram_n)}")
tram_models = {k: v[0]["model"] for k, v in by_tram.items()}
mcount = defaultdict(int)
for m in tram_models.values():
    mcount[m] += 1
print("trams by model     :", dict(sorted(mcount.items(), key=lambda kv: -kv[1])))

# AVL fix cadence: runs of unchanged obsDist per tram.
fix_intervals = []      # seconds between obsDist changes
stale_run_lens = []     # consecutive polls with identical obsDist
fresh_polls = 0
for key, rs in by_tram.items():
    last_obs, last_t, run = None, None, 0
    for r in rs:
        if last_obs is not None and r["obsDist"] == last_obs:
            run += 1
        else:
            if last_t is not None and last_obs is not None:
                fix_intervals.append((r["t"] - last_t) / 1000)
            if last_obs is not None:
                stale_run_lens.append(run)
            run = 0
            last_t = r["t"]
            fresh_polls += 1
        last_obs = r["obsDist"]
print(f"\nAVL fix refresh interval (s, per tram, obsDist changed): {stats(fix_intervals)}")
print(f"stale-run length (polls with identical obsDist)         : {stats([float(x) for x in stale_run_lens])}")
print(f"polls where obsDist changed: {fresh_polls} / {len(records)} "
      f"({100*fresh_polls/len(records):.0f}%)")

print()
print("=" * 78)
print("B. ERROR CHARACTERIZATION")
print("=" * 78)
dev = [r["devM"] for r in records if r.get("devM") is not None]
signed = [r["simDist"] - r["obsDist"] for r in records
          if r.get("simDist") is not None and r.get("obsDist") is not None]
print(f"devM  |sim-obs|    : {stats(dev)}")
print(f"signed sim-obs     : {stats(signed)}")
ahead = sum(1 for x in signed if x > 0)
print(f"sim AHEAD of last fix (signed>0): {100*ahead/len(signed):.1f}%   "
      f"(>50 m ahead: {100*sum(1 for x in signed if x>50)/len(signed):.1f}%, "
      f">50 m behind: {100*sum(1 for x in signed if x<-50)/len(signed):.1f}%)")

print("\ndevM by model:")
for m in sorted(models):
    xs = [r["devM"] for r in records if r["model"] == m and r.get("devM") is not None]
    print(f"  {m:8s} {stats(xs)}")
print("\nsigned (sim-obs) by model:")
for m in sorted(models):
    xs = [r["simDist"] - r["obsDist"] for r in records if r["model"] == m]
    print(f"  {m:8s} {stats(xs)}")
print("\ndevM by mode:")
mode_n = defaultdict(int)
for r in records:
    mode_n[r["mode"]] += 1
for m in sorted(mode_n):
    xs = [r["devM"] for r in records if r["mode"] == m and r.get("devM") is not None]
    print(f"  {m:8s} {stats(xs)}")
print("\ndevM by line (lines with >=300 records):")
for ln in sorted(lines, key=lambda x: -lines[x]):
    if lines[ln] < 300:
        continue
    xs = [r["devM"] for r in records if r["line"] == ln and r.get("devM") is not None]
    sg = [r["simDist"] - r["obsDist"] for r in records if r["line"] == ln]
    print(f"  line {ln:>3s} devM {stats(xs)}")
    print(f"          signed mean={sum(sg)/len(sg):7.1f}")

# Error vs age-of-fix (sawtooth?): bucket signed error by seconds since obsDist
# last CHANGED for that tram (proxy for fix age; true observedAtMs not logged).
print("\nsigned error vs time-since-fix-refresh (proxy for fix age):")
buckets = defaultdict(list)
absbuckets = defaultdict(list)
for key, rs in by_tram.items():
    last_change_t = None
    last_obs = None
    for r in rs:
        if last_obs is None or r["obsDist"] != last_obs:
            last_change_t = r["t"]
        last_obs = r["obsDist"]
        age = (r["t"] - last_change_t) / 1000
        b = min(int(age // 5) * 5, 40)
        buckets[b].append(r["simDist"] - r["obsDist"])
        absbuckets[b].append(abs(r["simDist"] - r["obsDist"]))
for b in sorted(buckets):
    xs, ax = buckets[b], absbuckets[b]
    print(f"  age {b:2d}-{b+5:2d}s n={len(xs):5d}  signed mean={sum(xs)/len(xs):7.1f} "
          f"p50={pct(xs,50):7.1f}   |err| p50={pct(ax,50):7.1f} p90={pct(ax,90):7.1f}")

# Error immediately AT a fix refresh: previous poll's simDist/projDist vs the
# newly arrived obsDist. This is the fairest quality probe we have: the new fix
# is fresh truth (a few s stale at most).
print("\nprediction error AT fix refresh (prev poll's position - new obsDist):")
sim_at_fix, proj_at_fix = [], []
for key, rs in by_tram.items():
    for i in range(1, len(rs)):
        prev, cur = rs[i - 1], rs[i]
        if cur["obsDist"] != prev["obsDist"] and cur["t"] - prev["t"] < 15000:
            if cur["obsDist"] < prev["obsDist"] - 2000:
                continue  # trip change / re-anchor artifact
            sim_at_fix.append(prev["simDist"] - cur["obsDist"])
            if prev.get("projDist") is not None:
                proj_at_fix.append(prev["projDist"] - cur["obsDist"])
print(f"  smooth sim  signed: {stats(sim_at_fix)}")
print(f"     |abs|          : {stats([abs(x) for x in sim_at_fix])}")
print(f"  projSim     signed: {stats(proj_at_fix)}")
print(f"     |abs|          : {stats([abs(x) for x in proj_at_fix])}")
print(f"  smooth ahead of fresh fix: {100*sum(1 for x in sim_at_fix if x>0)/len(sim_at_fix):.1f}%")
print(f"  projSim ahead of fresh fix: {100*sum(1 for x in proj_at_fix if x>0)/len(proj_at_fix):.1f}%")

print()
print("=" * 78)
print("C. SPEED REALITY & paceBias")
print("=" * 78)
# Real speeds from consecutive obsDist deltas (obs advanced).
real_all, real_center, real_out = [], [], []
real_by_line = defaultdict(list)
moving_all, moving_center, moving_out = [], [], []
for key, rs in by_tram.items():
    last_obs, last_t, last_ll = None, None, None
    for r in rs:
        if last_obs is not None and r["obsDist"] != last_obs:
            ds = r["obsDist"] - last_obs
            dt = (r["t"] - last_t) / 1000
            if 4 <= dt <= 120 and 0 <= ds <= dt * 22:  # sane advance, <80 km/h
                kmh = ds / dt * 3.6
                real_all.append(kmh)
                real_by_line[r["line"]].append(kmh)
                lng, lat = r["lng"], r["lat"]
                (real_center if in_center(lng, lat) else real_out).append(kmh)
                if kmh > 3:  # exclude dwell-dominated intervals
                    moving_all.append(kmh)
                    (moving_center if in_center(lng, lat) else moving_out).append(kmh)
        if last_obs is None or r["obsDist"] != last_obs:
            last_obs, last_t = r["obsDist"], r["t"]
for r in []:
    pass
print("real inter-fix speed, km/h (includes dwell time inside the interval):")
print(f"  all     : {stats(real_all)}")
print(f"  centre  : {stats(real_center)}")
print(f"  outside : {stats(real_out)}")
print("moving only (> 3 km/h):")
print(f"  all     : {stats(moving_all)}")
print(f"  centre  : {stats(moving_center)}")
print(f"  outside : {stats(moving_out)}")
print(f"share of moving samples above 50 km/h cap: "
      f"{100*sum(1 for x in moving_all if x>50)/max(1,len(moving_all)):.2f}%")
print(f"share of centre moving samples above 31 km/h cap: "
      f"{100*sum(1 for x in moving_center if x>31)/max(1,len(moving_center)):.2f}%")
print("\nreal speed by line (>=30 samples, moving only):")
for ln in sorted(real_by_line, key=lambda x: -len(real_by_line[x])):
    xs = [x for x in real_by_line[ln] if x > 3]
    if len(xs) < 30:
        continue
    print(f"  line {ln:>3s}: n={len(xs):4d} p50={pct(xs,50):5.1f} p90={pct(xs,90):5.1f} km/h")

# paceBias distribution and convergence
bias_all = [r["bias"] for r in records if r.get("bias") is not None]
bias_nonfresh = [b for b in bias_all if abs(b - 1.0) > 1e-9]
print(f"\npaceBias all records     : {stats(bias_all)}")
print(f"paceBias excluding ==1.0 : {stats(bias_nonfresh)}")
print(f"  records with bias==1.00 (fresh/teleport/unconverged): "
      f"{100*(len(bias_all)-len(bias_nonfresh))/len(bias_all):.1f}%")
hist = defaultdict(int)
for b in bias_nonfresh:
    hist[round(b * 10) / 10] += 1
print("  histogram (0.1 bins, excl 1.0):",
      {k: hist[k] for k in sorted(hist)})
lo = sum(1 for b in bias_nonfresh if b <= 0.45)
print(f"  fraction <=0.45 (near 0.4 sample clamp): {100*lo/len(bias_nonfresh):.1f}%")
print(f"  fraction <=0.60: {100*sum(1 for b in bias_nonfresh if b<=0.6)/len(bias_nonfresh):.1f}%")

# convergence: mean bias by minute-within-session
print("\nmean paceBias by minute of session (excl ==1.0):")
bymin = defaultdict(list)
for r in records:
    if r.get("bias") is not None and abs(r["bias"] - 1.0) > 1e-9:
        bymin[int((r["t"] - t0) // 60000)].append(r["bias"])
for m in sorted(bymin):
    xs = bymin[m]
    print(f"  min {m:2d}: n={len(xs):4d} mean={sum(xs)/len(xs):.3f} p50={pct(xs,50):.3f}")

# final bias per tram
finals = [rs[-1]["bias"] for rs in by_tram.values()
          if rs[-1].get("bias") is not None and len(rs) > 60]
print(f"\nfinal paceBias per tram (trams with >60 records): {stats(finals)}")

# implied bias from data: real moving speed / cap
print(f"\nimplied global pace ratio (moving p50 / 50 km/h): {pct(moving_all,50)/50:.2f}")
print(f"implied centre ratio (centre moving p50 / 31 km/h): {pct(moving_center,50)/31:.2f}")
print(f"implied outside ratio (outside moving p50 / 50 km/h): {pct(moving_out,50)/50:.2f}")

# staleness floor for devM: median real speed * median fix age
v_med_ms = pct(real_all, 50) / 3.6
age_med = pct(fix_intervals, 50) / 2  # average age ~ half the refresh interval
print(f"\ndevM staleness floor estimate (a PERFECT sim would still show this):")
print(f"  median real speed {pct(real_all,50):.1f} km/h x mean fix age ~{age_med:.0f} s"
      f" ~= {v_med_ms*age_med:.0f} m median devM floor")
