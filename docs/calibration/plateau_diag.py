#!/usr/bin/env python3
"""R11 diagnostic: dissect the h16+ "behind" plateau of the at-fix probe.

Rerun:  python3 docs/calibration/plateau_diag.py <jsonl> [<jsonl> ...] \
            [--since "YYYY-MM-DD HH:MM"] [--until "YYYY-MM-DD HH:MM"]

Round-16 observation: at-fix signed p50 drifts to −22…−30 m late in h16 with
flat feed observables; moving trams carry the whole offset (prev=on_track
−69 vs prev=at_stop −2). Round-17 pre-registration: diagnose BEFORE proposing.

Mechanism under test (schedule-pace projection drag, tramSim.ts targetDistAt):
  target = 0.75·sObs + 0.25·sSched − TRAIL_M(10),
  sObs   = obsDist + max(0, sSched(now) − sSched(obsAt))  ← SCHEDULE pace.
When a tram runs FASTER than its delay-shifted schedule (recovering delay,
fix-to-fix ΔdelayS < 0), real advance beats the projected advance by roughly
v·|ΔdelayS|, so even a perfect target-follower reads BEHIND the next fix by
~0.75·v·|ΔdelayS| + TRAIL_M. Peak second half = fleet-wide delay recovery →
a deepening "behind" plateau would be the DESIGNED trail, not a sim bug.
Prediction if the mechanism holds: signed at-fix error rises ~linearly with
fix-to-fix ΔdelayS (slope ≈ +0.75·v̄ ≈ +4…5 m per second of ΔdelayS), and the
plateau's depth tracks the fleet's ΔdelayS trend bucket by bucket.

Probe = the established at-fix probe (analyze.py/night_profile.py rules):
prev poll's simDist vs the newly arrived obsDist, poll gap < 15 s, obs drop
> 2 km excluded. v2 lines only (obsAt/delayS/statePos needed); v1 skipped.
"""

import json
import math
import sys
from collections import defaultdict
from datetime import datetime

NIGHT_LINES = {str(x) for x in range(91, 100)}
CENTER = (14.395, 50.068, 14.46, 50.096)
PRIOR = 0.62
BUCKET_MIN = 5


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

first_seen = {}
by_tram = defaultdict(list)
delay_by_bucket = defaultdict(list)  # fleet delayS context, ALL v2 records
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
            if r["line"] in NIGHT_LINES or r.get("obsAt") is None:
                continue
            if r.get("delayS") is not None:
                delay_by_bucket[int(r["t"] // (BUCKET_MIN * 60000))].append(r["delayS"])
            by_tram[k].append(r)

if not by_tram:
    print("no v2 records after filters")
    sys.exit(1)

for rs in by_tram.values():
    rs.sort(key=lambda r: r["t"])

t0 = min(rs[0]["t"] for rs in by_tram.values())
t1 = max(rs[-1]["t"] for rs in by_tram.values())
print(f"files: {paths}")
print(f"window: {datetime.fromtimestamp(t0/1000)} .. {datetime.fromtimestamp(t1/1000)} "
      f"({(t1-t0)/60000:.1f} min), trams {len(by_tram)}")


def in_center(r):
    if r.get("lng") is None or r.get("lat") is None:
        return None
    w, s_, e, n = CENTER
    return w <= r["lng"] <= e and s_ <= r["lat"] <= n


probes = []  # dict rows
for key, rs in by_tram.items():
    last_obs = None
    last_fix = None  # (obsAt, obsDist, delayS) at the previous obsAt change
    cur_fix = None
    for i, r in enumerate(rs):
        if cur_fix is None or (r.get("obsAt") is not None and r["obsAt"] != cur_fix[0]):
            last_fix, cur_fix = cur_fix, (r["obsAt"], r["obsDist"], r.get("delayS"))
        if last_obs is not None and r["obsDist"] != last_obs:
            prev = rs[i - 1]
            if (prev.get("simDist") is not None
                    and r["t"] - prev["t"] < 15000
                    and r["obsDist"] >= prev["obsDist"] - 2000):
                d_delay = dt_fix = v_fix = None
                if last_fix is not None and last_fix[0] is not None:
                    dt_fix = (cur_fix[0] - last_fix[0]) / 1000
                    if last_fix[2] is not None and cur_fix[2] is not None:
                        d_delay = cur_fix[2] - last_fix[2]
                    if 2 <= dt_fix <= 180 and 0 <= r["obsDist"] - last_fix[1] <= dt_fix * 22:
                        v_fix = (r["obsDist"] - last_fix[1]) / dt_fix * 3.6
                b = prev.get("bias")
                probes.append({
                    "t": r["t"],
                    "key": key,
                    "model": r["model"],
                    "signed": prev["simDist"] - r["obsDist"],
                    "centre": in_center(prev),
                    "state": prev.get("statePos"),
                    "fresh": b is not None and (abs(b - 1.0) < 1e-9 or abs(b - PRIOR) < 1e-9),
                    "age_min": (r["t"] - first_seen[key]) / 60000,
                    "delay": cur_fix[2],
                    "d_delay": d_delay,
                    "dt_fix": dt_fix,
                    "v_fix": v_fix,
                    "lag_s": (r["t"] - r["obsAt"]) / 1000,
                })
        if last_obs is None or r["obsDist"] != last_obs:
            last_obs = r["obsDist"]

print(f"at-fix probes: {len(probes)}")


def show(name, ps, extra=""):
    if not ps:
        print(f"  {name:34s} n=0")
        return
    sg = [p["signed"] for p in ps]
    ahead = 100 * sum(1 for x in sg if x > 0) / len(sg)
    print(f"  {name:34s} n={len(sg):5d} signed p50={pct(sg,50):+7.1f} "
          f"p25={pct(sg,25):+7.1f} p75={pct(sg,75):+7.1f} %ahead={ahead:5.1f}{extra}")


# 1. Trajectory: bucket × (all / prev=on_track / prev=at_stop) + fleet delayS.
print(f"\n== 1. TRAJECTORY ({BUCKET_MIN}-min buckets): plateau vs fleet delayS ==")
print(f"{'bucket':>6s} {'n':>5s} {'sgn p50':>8s} {'on_track':>9s} {'at_stop':>8s} "
      f"{'fleet delayS p50':>16s} {'probe ΔdelayS p50':>17s} {'v_fix p50':>9s} {'lag p50':>8s}")
by_b = defaultdict(list)
for p in probes:
    by_b[int(p["t"] // (BUCKET_MIN * 60000))].append(p)
for b in sorted(by_b):
    ps = by_b[b]
    sg = [p["signed"] for p in ps]
    ot = [p["signed"] for p in ps if p["state"] == "on_track"]
    st = [p["signed"] for p in ps if p["state"] == "at_stop"]
    dd = [p["d_delay"] for p in ps if p["d_delay"] is not None]
    vf = [p["v_fix"] for p in ps if p["v_fix"] is not None and p["v_fix"] > 3]
    lg = [p["lag_s"] for p in ps]
    fd = delay_by_bucket.get(b, [])
    lab = datetime.fromtimestamp(b * BUCKET_MIN * 60).strftime("%H:%M")
    print(f"{lab:>6s} {len(ps):5d} {pct(sg,50):+8.1f} "
          f"{pct(ot,50) if ot else float('nan'):+9.1f} "
          f"{pct(st,50) if st else float('nan'):+8.1f} "
          f"{pct(fd,50) if fd else float('nan'):16.0f} "
          f"{pct(dd,50) if dd else float('nan'):17.1f} "
          f"{pct(vf,50) if vf else float('nan'):9.1f} {pct(lg,50):8.1f}")

# 2. Class splits (window-wide, then second half only).
tm = (t0 + t1) / 2
for label, sel in (("FULL window", lambda p: True), ("second half", lambda p: p["t"] >= tm)):
    sub = [p for p in probes if sel(p)]
    print(f"\n== 2. CLASS SPLITS — {label} ==")
    show("all", sub)
    show("prev=on_track", [p for p in sub if p["state"] == "on_track"])
    show("prev=at_stop", [p for p in sub if p["state"] == "at_stop"])
    show("fresh(seed)", [p for p in sub if p["fresh"]])
    show("converged", [p for p in sub if not p["fresh"]])
    show("centre", [p for p in sub if p["centre"] is True])
    show("outskirts", [p for p in sub if p["centre"] is False])
    for lo, hi in ((0, 15), (15, 60), (60, 180), (180, 1e9)):
        show(f"sim age {lo:.0f}-{'inf' if hi > 1e8 else int(hi)} min",
             [p for p in sub if lo <= p["age_min"] < hi])
    models = defaultdict(list)
    for p in sub:
        models[p["model"]].append(p)
    for m in sorted(models, key=lambda m: -len(models[m])):
        if len(models[m]) >= 200:
            show(f"model {m}", models[m])

# 3. THE MECHANISM TEST: signed vs fix-to-fix ΔdelayS (moving probes).
print("\n== 3. MECHANISM TEST: signed error vs fix-to-fix ΔdelayS ==")
print("  (schedule-pace projection drag predicts slope ≈ +0.75·v̄ ≈ +4…5 m "
      "per second of ΔdelayS; recovery ΔdelayS<0 → behind)")
mov = [p for p in probes if p["d_delay"] is not None and p["state"] == "on_track"]
bands = ((-1e9, -10), (-10, -3), (-3, 3), (3, 10), (10, 1e9))
for lo, hi in bands:
    ps = [p for p in mov if lo <= p["d_delay"] < hi]
    dd = [p["d_delay"] for p in ps]
    show(f"ΔdelayS [{lo:+.0f},{hi:+.0f}) s", ps,
         extra=f"  ΔdelayS p50={pct(dd,50):+5.1f}" if ps else "")
show("at_stop control, ΔdelayS<-3",
     [p for p in probes if p["d_delay"] is not None and p["d_delay"] < -3
      and p["state"] == "at_stop"])
# OLS slope on the moving probes (trimmed to |ΔdelayS|<=30, |signed|<=400)
fit = [(p["d_delay"], p["signed"]) for p in mov
       if abs(p["d_delay"]) <= 30 and abs(p["signed"]) <= 400]
if len(fit) > 100:
    mx = sum(x for x, _ in fit) / len(fit)
    my = sum(y for _, y in fit) / len(fit)
    sxx = sum((x - mx) ** 2 for x, _ in fit)
    sxy = sum((x - mx) * (y - my) for x, y in fit)
    print(f"  OLS slope (trimmed, n={len(fit)}): {sxy/sxx:+.2f} m per ΔdelayS second "
          f"(intercept {my - sxy/sxx*mx:+.1f} m)")

# 4. delayS LEVEL bands (is it the absolute delay, not its derivative?).
print("\n== 4. CONTROL: signed vs delayS LEVEL (on_track probes) ==")
for lo, hi in ((-1e9, 0), (0, 30), (30, 60), (60, 120), (120, 1e9)):
    show(f"delayS [{lo:+.0f},{hi:+.0f}) s",
         [p for p in mov if p["delay"] is not None and lo <= p["delay"] < hi])

# 5. ACCUMULATION: does drag from PREVIOUS fix intervals linger (controller
#    catch-up slower than the fix cadence), so sustained recovery episodes
#    stack? Probes with the CURRENT interval quiet (|ΔdelayS|<3) split by the
#    PREVIOUS interval's ΔdelayS and by the 3-interval cumulative sum.
print("\n== 5. ACCUMULATION: quiet-current probes (|ΔdelayS_cur|<3, on_track) ==")
probes.sort(key=lambda p: (p["key"], p["t"]))
hist = defaultdict(list)  # key -> [d_delay history]
prev_dd = {}
for p in probes:
    h = hist[p["key"]]
    p["d_prev"] = h[-1] if h else None
    p["d_cum3"] = sum(x for x in h[-3:]) + (p["d_delay"] or 0) \
        if len(h) >= 1 and all(x is not None for x in h[-3:]) \
        and p["d_delay"] is not None else None
    h.append(p["d_delay"])
quiet = [p for p in mov if p["d_delay"] is not None and abs(p["d_delay"]) < 3]
print("  by PREVIOUS interval ΔdelayS:")
for lo, hi in ((-1e9, -10), (-10, -3), (-3, 3), (3, 1e9)):
    show(f"  ΔdelayS_prev [{lo:+.0f},{hi:+.0f}) s",
         [p for p in quiet if p.get("d_prev") is not None and lo <= p["d_prev"] < hi])
print("  by cumulative ΔdelayS over last ~4 fixes (all on_track probes):")
for lo, hi in ((-1e9, -40), (-40, -15), (-15, -5), (-5, 5), (5, 1e9)):
    show(f"  ΣΔdelayS [{lo:+.0f},{hi:+.0f}) s",
         [p for p in mov if p.get("d_cum3") is not None and lo <= p["d_cum3"] < hi])
print("  steady probes (|ΣΔdelayS|<5) by delayS LEVEL:")
steady = [p for p in mov if p.get("d_cum3") is not None and abs(p["d_cum3"]) < 5]
for lo, hi in ((-1e9, 0), (0, 60), (60, 1e9)):
    show(f"  steady, delayS [{lo:+.0f},{hi:+.0f}) s",
         [p for p in steady if p["delay"] is not None and lo <= p["delay"] < hi])
