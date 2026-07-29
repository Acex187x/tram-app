#!/usr/bin/env python3
"""Ground-truth ride replay: re-run the smooth-sim pace controller over a
ride recording's AVL fix sequence and score it against the RIDER'S GPS
(fDist — the filtered rider position projected onto the tram's shape).

This is the ride-side counterpart of replay.py (which replays fleet AVL
sessions and scores at-fix error vs the next fix). Here the truth is the
rider sitting in the physical tram, so the metric is the real headline:

    err(t) = s_replay(t) − fDist(t)      (m along shape; + = sim AHEAD)

Usage:
    python3 docs/calibration/ride_replay.py <ride.jsonl> [--sweep]
    python3 docs/calibration/ride_replay.py <ride1.jsonl> <ride2.jsonl> ...

With several rides the metrics aggregate across all of them (equal weight
per point). --sweep runs the exploratory candidate grid; the default runs
only SHIP / CANDIDATE / the surrogate-fidelity check.

What is modeled (1D port of tramSim.tick + applySnapshot):
  - target = obs projected forward from obsAt at a schedule-pace proxy
    (EWMA of real inter-fix pace, like replay.py), blended 0.75/0.25 with
    itself (no timetable here — the proxy IS the schedule pace), − TRAIL_M;
  - regimes verbatim: gentle band (factor clamp(1+e/120, min_factor,
    1.35)), bold catch-up (factor ≤ catchup_max above +40 m), soft-yield
    latch (enter −40 / exit −12) at max(3.0, 0.5·cruise), deep crawl
    (enter −120 / exit −60) at 1 m/s;
  - braking envelope over curve caps (curvature of the shape reconstructed
    from the ride's own GPS track) + upcoming stops + shape end; A_ACC/A_BRK;
  - stops from the ride's own at_stop fix clusters (keyed by nextSeq);
    default dwell 18 s ± deterministic jitter; adaptive dwell
    (extend ≤ +75 s while ahead / shorten / skip beyond +60 m);
  - fix-holds: dwell fix-hold (stale at-stop fix pins the dwell, age ≤
    stop_hold_age), arrival-fix stop pin (at_stop fix snaps an approaching
    sim onto the platform, caps the target there), stuck-hold (repeated
    mid-segment fix ⇒ stand at the fix, bounded pull-back);
  - paceBias EWMA per updatePaceBias (dwell deduction of stops inside the
    span, expected = mean min(vLimit, cruise_ref) over the span, clamps,
    half-life), TOD factor hooks (neutral by default).

NOT modeled: junction yield / switch slow (needs a second tram), zone cap
by daytime (rides so far are post-19:00; pass `daytime=True` per config to
enable), timetable anchor (proxy above), coupled-consist spacing.

SURROGATE FIDELITY: config "FIDELITY (logged sim check)" compares the
replayed s(t) against the LOGGED simDist(t) of the same ride under shipped
constants — if this diverges badly the port drifted from the engine and
sweep verdicts should not be trusted. Target: mean |s − simDist| well
under the ground-truth error itself (≈≤ 60 m).

GATE (how to use for constant changes): a candidate must
  1. reduce mean |err| vs ground truth here (ideally p90 too), AND
  2. not regress the fleet replay (docs/calibration/replay.py) on the
     newest session file, AND
  3. keep jest + tsc green.
Single-ride caveat: with one ride, treat any win < ~10% as noise; prefer
constants with a mechanistic story (e.g. hold ages tied to the measured
fix cadence) over free-fit values, and re-run on every new ride before
trusting a shipped value (regularize toward the shipped prior — see
analysis-2026-07-20-ride.md §methodology).
"""

import json
import math
import sys
from collections import defaultdict

# ── shipped constants (mirror src/lib/engine/{tramSim,speedProfile}.ts) ──────
SHIP = dict(
    v_max=13.9,            # V_MAX_MS
    cruise_ref=11.7,       # V_CRUISE_REF_MS
    v_center=8.6,          # V_CENTER_MS (unused unless daytime=True)
    a_acc=1.3,             # A_ACC
    a_brk=1.4,             # A_BRK
    a_lat=0.98,            # A_LAT
    csf=0.85,              # CURVE_SLOW_FACTOR
    trail=10.0,            # TRAIL_M
    gain=120.0,            # PACE_GAIN_M
    gentle_max=1.35,       # GENTLE_MAX_FACTOR
    catchup_max=1.4,       # CATCHUP_MAX_FACTOR
    min_factor=0.7,        # MIN_PACE_FACTOR
    bold_err=40.0,         # BOLD_CATCHUP_ERR_M
    ahead_enter=40.0,      # HARD_BRAKE_ENTER_M
    ahead_exit=12.0,       # HARD_BRAKE_EXIT_M
    ahead_slow_factor=0.5, # AHEAD_SLOW_FACTOR
    ahead_slow_min=3.0,    # AHEAD_SLOW_MIN_V_MS
    deep_enter=120.0,      # DEEP_AHEAD_ENTER_M
    deep_exit=60.0,        # DEEP_AHEAD_EXIT_M
    crawl_v=1.0,           # CRAWL_V_MS
    default_dwell=18.0,    # DEFAULT_DWELL_S
    dwell_min=4.0,         # DWELL_MIN_S
    dwell_extend_max=75.0, # DWELL_MAX_EXTEND_S
    dwell_release=8.0,     # DWELL_EXTEND_RELEASE_M
    dwell_shorten_gain=80.0,  # DWELL_SHORTEN_GAIN_M
    dwell_skip_err=60.0,   # DWELL_SKIP_ERR_M
    skip_roll_v=4.0,       # DWELL_SKIP_ROLL_V_MS
    stop_hold_age=45.0,    # STOP_HOLD_MAX_FIX_AGE_S (60 → 45, 2026-07-20)
    stop_hold_move=8.0,    # STOP_HOLD_MOVE_EPS_M
    stop_hold_near=30.0,   # STOP_HOLD_NEAR_BEHIND_M
    stop_hold_ahead=8.0,   # STOP_HOLD_AHEAD_EPS_M
    fix_at_stop_tol=20.0,  # FIX_AT_STOP_TOL_M
    at_stop_match=50.0,    # AT_STOP_MATCH_M
    stuck_eps=8.0,         # STUCK_FIX_EPS_M
    stuck_near_stop=40.0,  # STUCK_NEAR_STOP_M
    stuck_back_eps=10.0,   # STUCK_BACK_EPS_M
    burst_factor=1.25,     # DEPART_BURST_FACTOR
    burst_dist=150.0,      # DEPART_BURST_DIST_M
    bias_prior=0.62,       # PACE_BIAS_PRIOR
    bias_half_life=150.0,  # PACE_BIAS_HALF_LIFE_S
    bias_lo=0.4,           # PACE_BIAS_MIN_RATIO
    bias_hi=1.6,           # PACE_BIAS_MAX_RATIO
    bias_min_dt=8.0,       # PACE_BIAS_MIN_DT_S
    bias_min_ds=15.0,      # PACE_BIAS_MIN_DS_M
    teleport=500.0,        # TELEPORT_THRESHOLD_M floor
    teleport_max=1500.0,   # TELEPORT_THRESHOLD_MAX_M
    teleport_gap_margin=1.25, # TELEPORT_GAP_MARGIN
    teleport_gap_min=45.0, # TELEPORT_GAP_MIN_S
    teleport_gap_max=240.0,# TELEPORT_GAP_MAX_S
    stop_reach=2.0,        # STOP_REACH_M
    tod_pace=1.0,          # todPaceFactor over the ride window
    lookahead=400.0,       # DEFAULT_LOOKAHEAD_M
    daytime=False,
    off_gate=30.0,         # fOffM gate on ground-truth points
    proj_alpha=0.5,        # schedule-pace-proxy EWMA gain (replay.py value)
    feed_latency=3.0,      # FEED_LATENCY_S (R12, 2026-07-20): hidden pipeline
                           # latency BEYOND obsAt. Used as a latency-aware
                           # EFFECTIVE FIX AGE (fix_age + feed_latency) in the
                           # stop-hold staleness checks (pin freeze + dwell
                           # hold), so a stale at-stop fix releases this many
                           # seconds earlier. The ride shows the raw fix already
                           # +77 m behind reality at apparent age 0-15 s (≈8-14 s
                           # of latency at ~5 m/s); 3 s is the shrunk half-step
                           # (effective wall release ~42 s, within one cadence).
)

GRID_M = 10.0  # vLimit sampling grid along the shape


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = math.floor(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


# ── ride parsing & static reconstruction ─────────────────────────────────────

class Ride:
    def __init__(self, path):
        self.path = path
        self.points = []
        self.header = None
        for line in open(path):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if "type" in r:
                if r["type"] == "ride-start":
                    self.header = r
                continue
            if r.get("gpsLat") is None:
                continue
            self.points.append(r)
        if not self.points:
            raise SystemExit(f"{path}: no points")
        self._build_shape()
        self._build_stops()
        self._build_fixes()

    def _build_shape(self):
        """Polyline s → (lat,lng) from the ride's own filtered track, plus a
        curvature-derived vLimit grid every GRID_M meters."""
        samp = sorted(
            (p["fDist"], p["fLat"], p["fLng"])
            for p in self.points
            if p.get("fDist") is not None and p.get("fOffM") is not None
            and p["fOffM"] < 30
        )
        pts = []
        for d, la, ln in samp:
            if not pts or d - pts[-1][0] >= 8.0:
                pts.append((d, la, ln))
        lat0 = pts[len(pts) // 2][1]
        mlat = 111_320.0
        mlng = 111_320.0 * math.cos(math.radians(lat0))
        self.shape = [(d, ln * mlng, la * mlat, la, ln) for d, la, ln in pts]
        self.s_min = pts[0][0]
        self.s_max = pts[-1][0]

    def _kappa_at(self, i):
        """Curvature via circumcircle of points ~25 m back / forward."""
        sh = self.shape
        d = sh[i][0]
        a = i
        b = i
        while a > 0 and d - sh[a][0] < 25:
            a -= 1
        while b < len(sh) - 1 and sh[b][0] - d < 25:
            b += 1
        (x1, y1), (x2, y2), (x3, y3) = (
            sh[a][1:3], sh[i][1:3], sh[b][1:3])
        ax, ay = x2 - x1, y2 - y1
        bx, by = x3 - x2, y3 - y2
        cross = ax * by - ay * bx
        la = math.hypot(ax, ay)
        lb = math.hypot(bx, by)
        lc = math.hypot(x3 - x1, y3 - y1)
        if la * lb * lc == 0:
            return 0.0
        return abs(2 * cross) / (la * lb * lc)

    def coord_at(self, s):
        sh = self.shape
        lo, hi = 0, len(sh) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if sh[mid][0] <= s:
                lo = mid
            else:
                hi = mid
        return sh[lo][3], sh[lo][4]

    def build_vlimit(self, cfg):
        """vLimit on a GRID_M grid: min(zone cap, curve cap)."""
        n = int((self.s_max - self.s_min) / GRID_M) + 2
        vlim = [cfg["v_max"]] * n
        ki = 0
        for gi in range(n):
            s = self.s_min + gi * GRID_M
            while ki < len(self.shape) - 1 and self.shape[ki + 1][0] <= s:
                ki += 1
            kap = self._kappa_at(ki)
            if kap > 1e-9:
                cv = cfg["csf"] * math.sqrt(cfg["a_lat"] / kap)
                cv = min(cfg["v_max"], max(1.4, cv))
            else:
                cv = cfg["v_max"]
            zone = cfg["v_max"]
            if cfg["daytime"]:
                la, ln = self.shape[ki][3], self.shape[ki][4]
                if 14.395 <= ln <= 14.46 and 50.068 <= la <= 50.096:
                    zone = cfg["v_center"]
            vlim[gi] = min(cv, zone)
        return vlim

    def _build_stops(self):
        """Stop table from at_stop fix clusters keyed by nextSeq."""
        clusters = defaultdict(list)
        for p in self.points:
            if p.get("statePos") == "at_stop" and p.get("obsDist") is not None:
                clusters[p.get("nextSeq")].append(p["obsDist"])
        stops = []
        for seq, ds in clusters.items():
            ds.sort()
            stops.append((ds[len(ds) // 2], seq))
        stops.sort()
        self.stops = stops  # [(distM, seq)]

    def _build_fixes(self):
        """Genuinely-new AVL fixes: (obsAt, obsDist, at_stop, wall_t_first_seen)."""
        fixes = []
        last_at = None
        for p in self.points:
            oa, od = p.get("obsAt"), p.get("obsDist")
            if oa is None or od is None:
                continue
            if last_at is None or oa > last_at:
                fixes.append(dict(
                    at=oa, dist=od,
                    at_stop=p.get("statePos") == "at_stop",
                    seen=p["t"],
                ))
                last_at = oa
        self.fixes = fixes

    def truth(self, cfg):
        """(t, fDist, simDist) ground-truth samples, fOffM-gated."""
        out = []
        for p in self.points:
            if (p.get("fOffM") is not None and p["fOffM"] < cfg["off_gate"]
                    and p.get("fDist") is not None):
                out.append((p["t"], p["fDist"], p.get("simDist")))
        return out


# ── 1D controller replay ─────────────────────────────────────────────────────

def v_allowed(vlim, ride, s, next_stop_d, cfg):
    """Braking envelope at s over the vLimit grid + next stop + shape end."""
    gi0 = max(0, int((s - ride.s_min) / GRID_M))
    v = vlim[min(gi0, len(vlim) - 1)]
    horizon = s + cfg["lookahead"]
    a_brk = cfg["a_brk"]
    for gi in range(gi0, len(vlim)):
        d = ride.s_min + gi * GRID_M
        if d > horizon:
            break
        lim = vlim[gi]
        if lim >= v:
            continue
        cand = lim if d <= s else math.sqrt(lim * lim + 2 * a_brk * (d - s))
        if cand < v:
            v = cand
    if next_stop_d is not None and next_stop_d <= horizon and next_stop_d >= s:
        cand = math.sqrt(2 * a_brk * (next_stop_d - s))
        if cand < v:
            v = cand
    if ride.s_max <= horizon:
        cand = math.sqrt(2 * a_brk * max(0.0, ride.s_max - s))
        if cand < v:
            v = cand
    return max(0.0, v)


def mean_vlim_over(vlim, ride, a, b, cap):
    gi0 = max(0, int((a - ride.s_min) / GRID_M))
    gi1 = min(len(vlim) - 1, int((b - ride.s_min) / GRID_M))
    if gi1 <= gi0:
        return min(cap, vlim[max(0, min(gi0, len(vlim) - 1))])
    return sum(min(cap, vlim[g]) for g in range(gi0, gi1 + 1)) / (gi1 - gi0 + 1)


def dwell_s(cfg, seq):
    jitter = (abs(hash(("stop", seq))) % 17) - 8
    return max(4.0, cfg["default_dwell"] + jitter * (cfg["default_dwell"] / 18.0))


def replay(ride, cfg):
    """Replay one ride; returns list of (t, s_replay)."""
    vlim = ride.build_vlimit(cfg)
    fixes = ride.fixes
    stops = ride.stops
    tod = cfg["tod_pace"]

    # state
    fx = fixes[0]
    prev_fx = None
    s = fx["dist"]
    v = 0.0
    bias = cfg["bias_prior"]
    v_proj = 5.9
    phase = "cruise"
    dwell_until = 0.0
    dwell_obs = fx["dist"]
    crawling = False
    deep = False
    stuck_at = None
    fix_pin = None          # platform distM pinned by the latest fix
    burst_until = 0.0
    skip_roll_until = 0.0
    served = set()
    fi = 0

    # arrival pin at spawn
    if fx["at_stop"]:
        near = [st for st in stops if abs(st[0] - fx["dist"]) <= cfg["at_stop_match"]]
        if near:
            fix_pin = min(near, key=lambda st: abs(st[0] - fx["dist"]))[0]
            s = fix_pin
    for d, seq in stops:
        if d < s - 0.5:
            served.add(seq)

    def next_stop(s):
        for d, seq in stops:
            if seq in served or d < s - 0.5:
                continue
            return d, seq
        return None, None

    out = []
    t = ride.points[0]["t"]
    t_end = ride.points[-1]["t"]
    DT = 1.0

    def cruise_product(s):
        gi = max(0, min(len(vlim) - 1, int((s - ride.s_min) / GRID_M)))
        return min(vlim[gi], cfg["cruise_ref"]) * bias * tod

    while t <= t_end:
        # ingest fixes that have been SEEN by now (wall arrival time)
        while fi + 1 < len(fixes) and fixes[fi + 1]["seen"] <= t:
            prev_fx, fx = fx, fixes[fi + 1]
            fi += 1
            ds_f = fx["dist"] - prev_fx["dist"]
            dt_f = (fx["at"] - prev_fx["at"]) / 1000.0
            # 2026-07-27 engine parity: a slow feed must not turn honest
            # inter-fix travel into a hard snap. The threshold scales with the
            # observed gap, and the candidate observation is projected only as
            # far as cruise-reference physics permits.
            gap = min(cfg["teleport_gap_max"], max(cfg["teleport_gap_min"], dt_f))
            teleport_threshold = min(
                cfg["teleport_max"],
                max(cfg["teleport"], gap * cfg["cruise_ref"] * cfg["teleport_gap_margin"]),
            )
            seen_age = max(0.0, (t - fx["at"]) / 1000.0)
            ingest_advance = min(v_proj * seen_age, cfg["cruise_ref"] * seen_age)
            s_ingest_obs = fx["dist"] + ingest_advance
            if abs(s_ingest_obs - s) > teleport_threshold:
                s = s_ingest_obs
                v = cruise_product(s)
                phase = "cruise"
                crawling = deep = False
                stuck_at = None
                fix_pin = None
                served = {seq for d, seq in stops if d < s - 0.5}
                out.append((t, s))
                continue
            # paceBias update
            if dt_f >= cfg["bias_min_dt"] and ds_f >= cfg["bias_min_ds"]:
                dw = sum(dwell_s(cfg, seq) for d, seq in stops
                         if prev_fx["dist"] + 1 < d < fx["dist"] - 1)
                eff = max(dt_f - dw, dt_f * 0.25)
                expected = mean_vlim_over(vlim, ride, prev_fx["dist"], fx["dist"],
                                          cfg["cruise_ref"]) * tod
                if expected > 0.1:
                    ratio = min(cfg["bias_hi"],
                                max(cfg["bias_lo"], ds_f / eff / expected))
                    alpha = 1 - 0.5 ** (dt_f / cfg["bias_half_life"])
                    bias += alpha * (ratio - bias)
                v_real = ds_f / dt_f
                v_proj += cfg["proj_alpha"] * (v_real - v_proj)
            # stuck-hold
            if dt_f > 0:
                if abs(ds_f) > cfg["stuck_eps"]:
                    stuck_at = None
                elif not fx["at_stop"] and not any(
                        abs(d - fx["dist"]) <= cfg["stuck_near_stop"]
                        for d, _ in stops):
                    stuck_at = fx["dist"]
                    if s - stuck_at > cfg["stuck_back_eps"]:
                        s = stuck_at
                        v = 0.0
                        phase = "cruise"
                        crawling = deep = False
                        served = {sq for d, sq in stops if d < s - 0.5}
            # arrival-fix stop pin
            fix_pin = None
            if fx["at_stop"] or (abs(ds_f) <= cfg["stop_hold_move"]):
                tol = cfg["at_stop_match"] if fx["at_stop"] else cfg["fix_at_stop_tol"]
                near = [st for st in stops if abs(st[0] - fx["dist"]) <= tol]
                if near:
                    fix_pin = min(near, key=lambda st: abs(st[0] - fx["dist"]))[0]
            if fix_pin is not None and phase == "cruise":
                behind = fix_pin - s
                if behind > cfg["stop_reach"]:
                    s = fix_pin
                    v = 0.0
                    crawling = deep = False
                    for d, seq in stops:
                        if d <= fix_pin:
                            served.add(seq)
                    dwell_obs = fx["dist"]
                    phase = "dwell"
                    _, pseq = next_stop(fix_pin - 1)
                    dwell_until = t + dwell_s(cfg, pseq) * 1000

        fix_age = (t - fx["at"]) / 1000.0
        # R12 latency-aware effective age: the fix is older than obsAt claims by
        # the hidden pipeline latency, so the "too stale to still be standing"
        # clock runs on (fix_age + feed_latency) — releasing a stale at-stop
        # hold that much earlier (the ride's dominant −374 m behind-mass).
        eff_age = fix_age + cfg["feed_latency"]
        pin_active = fix_pin is not None and eff_age <= cfg["stop_hold_age"]

        # target: obs projected forward at the schedule-pace proxy, capped by
        # cruise-reference pace exactly like tramSim.maxAdvanceM().
        if pin_active:
            s_obs = fx["dist"]
        else:
            age = max(0.0, fix_age)
            s_obs = fx["dist"] + min(v_proj * age, cfg["cruise_ref"] * age)
        target = s_obs - cfg["trail"]
        if pin_active:
            target = min(target, fix_pin)
        e = target - s

        if phase == "dwell":
            v = 0.0
            if t >= dwell_until:
                hold_fix = (
                    eff_age <= cfg["stop_hold_age"]
                    and fx["dist"] - dwell_obs <= cfg["stop_hold_move"]
                    and s - fx["dist"] >= -cfg["stop_hold_ahead"]
                    and (s - fx["dist"] <= cfg["stop_hold_near"]
                         or (fx["at_stop"]
                             and s - fx["dist"] <= cfg["at_stop_match"]))
                )
                hold_real = (
                    t < dwell_until + cfg["dwell_extend_max"] * 1000
                    and e <= -cfg["dwell_release"]
                )
                if not hold_fix and not hold_real:
                    phase = "cruise"
                    burst_until = s + cfg["burst_dist"]
            out.append((t, s))
            t += DT * 1000
            continue

        nd, nseq = next_stop(s)
        # adaptive skip
        skip_zone = (cfg["skip_roll_v"] ** 2) / (2 * cfg["a_brk"])
        if (nd is not None and e > cfg["dwell_skip_err"]
                and nd - s <= skip_zone and nd < ride.s_max - 50):
            served.add(nseq)
            skip_roll_until = nd + skip_zone
            nd, nseq = next_stop(s)

        va = v_allowed(vlim, ride, s, nd, cfg)

        # regimes
        if crawling:
            if e > -cfg["ahead_exit"]:
                crawling = deep = False
        elif e < -cfg["ahead_enter"]:
            crawling = True
        if crawling:
            if deep:
                if e > -cfg["deep_exit"]:
                    deep = False
            elif e < -cfg["deep_enter"]:
                deep = True
            if deep:
                vt = min(va, cfg["crawl_v"])
            else:
                vt = min(va, max(cfg["ahead_slow_min"],
                                 cfg["ahead_slow_factor"] * cruise_product(s)))
        else:
            mf = cfg["catchup_max"] if e > cfg["bold_err"] else cfg["gentle_max"]
            factor = min(mf, max(cfg["min_factor"], 1 + e / cfg["gain"]))
            burst = cfg["burst_factor"] if s < burst_until else 1.0
            vt = min(va, cruise_product(s) * factor * burst)

        if stuck_at is not None:
            d_hold = stuck_at - s
            vt = min(vt, math.sqrt(2 * cfg["a_brk"] * d_hold) if d_hold > 0 else 0.0)
        if s < skip_roll_until:
            vt = min(vt, cfg["skip_roll_v"])

        a = min(cfg["a_acc"], max(-cfg["a_brk"], (vt - v) / DT))
        v = max(0.0, v + a * DT)
        s_new = s + v * DT

        if nd is not None and s_new >= nd - cfg["stop_reach"]:
            s = max(s, min(s_new, nd))
            v = 0.0
            served.add(nseq)
            burst_until = 0.0
            phase = "dwell"
            dwell_obs = fx["dist"]
            dm = dwell_s(cfg, nseq) * 1000
            if e > 0:
                dm = max(cfg["dwell_min"] * 1000,
                         dm * max(0.0, 1 - e / cfg["dwell_shorten_gain"]))
            dwell_until = t + dm
        else:
            s = min(s_new, ride.s_max)

        out.append((t, s))
        t += DT * 1000
    return out


def score(ride, cfg):
    """Replay + align to ground truth; returns per-point error lists."""
    sim = replay(ride, cfg)
    by_sec = {int(t / 1000): s for t, s in sim}
    errs = []
    fid = []
    for t, fdist, logged in ride.truth(cfg):
        s = by_sec.get(int(t / 1000))
        if s is None:
            continue
        errs.append(s - fdist)
        if logged is not None:
            fid.append(s - logged)
    return errs, fid


# ── configs ──────────────────────────────────────────────────────────────────

# The shipped 2026-07-20 change: STOP_HOLD_MAX_FIX_AGE_S 60 → 45 (one fix
# cadence p50). BASELINE_60 reproduces the pre-change engine for the gate row.
BASELINE_60 = {**SHIP, "stop_hold_age": 60.0, "feed_latency": 0.0}
# R11 prior: the pre-R12 engine (hold 45, NO latency-aware effective fix age).
# This is the row the R12 change must beat on the ground truth.
NO_LATENCY = {**SHIP, "feed_latency": 0.0}
CANDIDATE = dict(SHIP)

SWEEP = [
    ("feed_latency 0 (pre-R12)", {**SHIP, "feed_latency": 0.0}),
    ("feed_latency 3 (SHIP)", {**SHIP, "feed_latency": 3.0}),
    ("feed_latency 5", {**SHIP, "feed_latency": 5.0}),
    ("feed_latency 6", {**SHIP, "feed_latency": 6.0}),
    ("feed_latency 8", {**SHIP, "feed_latency": 8.0}),
    ("feed_latency 10 (probe)", {**SHIP, "feed_latency": 10.0}),
    ("hold_age 40", {**SHIP, "stop_hold_age": 40.0, "feed_latency": 0.0}),
    ("hold_age 45", {**SHIP, "stop_hold_age": 45.0, "feed_latency": 0.0}),
    ("catchup 1.5", {**SHIP, "catchup_max": 1.5}),
    ("catchup 1.55", {**SHIP, "catchup_max": 1.55}),
    ("catchup 1.7 (probe)", {**SHIP, "catchup_max": 1.7}),
    ("trail 5", {**SHIP, "trail": 5.0}),
    ("trail 0", {**SHIP, "trail": 0.0}),
    ("extend_max 40", {**SHIP, "dwell_extend_max": 40.0}),
    ("bias_lo 0.5", {**SHIP, "bias_lo": 0.5}),
    ("bias hl 300", {**SHIP, "bias_half_life": 300.0}),
    ("bias hl 600 (probe)", {**SHIP, "bias_half_life": 600.0}),
    ("csf 1.0", {**SHIP, "csf": 1.0}),
    ("cruise_ref 12.5", {**SHIP, "cruise_ref": 12.5}),
    ("tod 1.1 (probe)", {**SHIP, "tod_pace": 1.1}),
    ("tod 0.9 (control)", {**SHIP, "tod_pace": 0.9}),
]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sweep = "--sweep" in sys.argv
    if not args:
        args = ["20260720-193029-9097.jsonl"]
    rides = [Ride(p) for p in args]
    for r in rides:
        h = r.header or {}
        print(f"ride {r.path}: line {h.get('line')} model {h.get('model')} "
              f"key {h.get('tramKey')} points {len(r.points)} "
              f"stops {len(r.stops)} fixes {len(r.fixes)} "
              f"span {r.s_min:.0f}-{r.s_max:.0f} m")

    configs = [("BASELINE (hold 60, pre-change)", BASELINE_60)]
    configs.append(("R11 prior (hold 45, no latency)", NO_LATENCY))
    if sweep:
        configs += SWEEP
    configs.append(("SHIP (hold 45, feed_latency 3, R12)", SHIP))

    print(f"\n{'config':28s} {'mean|e|':>8s} {'p50|e|':>7s} {'p90|e|':>7s} "
          f"{'signed':>7s} {'%ahead':>7s} {'fid_mean':>9s}")
    base_mean = None
    for name, cfg in configs:
        all_errs = []
        all_fid = []
        for r in rides:
            errs, fid = score(r, cfg)
            all_errs += errs
            all_fid += fid
        ae = [abs(x) for x in all_errs]
        mean_e = sum(ae) / len(ae)
        fid_m = sum(abs(x) for x in all_fid) / len(all_fid) if all_fid else float("nan")
        ahead = 100 * sum(1 for x in all_errs if x > 0) / len(all_errs)
        signed = sum(all_errs) / len(all_errs)
        if name.startswith("BASELINE"):
            base_mean = mean_e
        delta = f" ({100*(mean_e-base_mean)/base_mean:+.1f}%)" if base_mean and not name.startswith("BASELINE") else ""
        print(f"{name:28s} {mean_e:8.1f} {pct(ae,50):7.1f} {pct(ae,90):7.1f} "
              f"{signed:+7.1f} {ahead:6.1f}% {fid_m:9.1f}{delta}")
    print("\nfid_mean = mean |s_replay − logged simDist| under that config "
          "(surrogate-fidelity vs the on-device engine — the logged sim ran "
          "pre-change constants, so it is only exact for BASELINE).")
    print("GATE: a candidate's mean|e| must drop vs the shipped row here AND "
          "replay.py must not regress on the newest fleet session.")


if __name__ == "__main__":
    main()
