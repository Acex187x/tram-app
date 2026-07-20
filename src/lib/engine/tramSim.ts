// Per-tram physics/state machine. Pure TS, deterministic, no timers — the
// caller (TramEngine) drives ticks. Distance-along-shape `sM` is monotonically
// non-decreasing except on an explicit >500 m schedule teleport.

import type { RouteGeometry, RouteStop, TramSnapshot } from '@/lib/types';
import {
  A_ACC,
  A_BRK,
  cruiseCapAt,
  meanCruiseCapOver,
  todDwellFactor,
  todPaceFactor,
  V_CRUISE_REF_MS,
  vAllowedAt,
  ZONAL_DWELL_AB,
  zonalDwellFactor,
  type SpeedProfile,
} from './speedProfile';

export type SimPhase = 'cruise' | 'dwell' | 'terminal';

/** Hard-teleport threshold: |projected observation − s| above this snaps position. */
export const TELEPORT_THRESHOLD_M = 500;
/** A stop is "reached" when s is within this many meters of its distM. */
export const STOP_REACH_M = 2;
/** Fallback dwell when the feed gives none, seconds (jittered ±0..8 s). */
export const DEFAULT_DWELL_S = 18;
/** Max dt fed into one physics step, seconds. */
export const MAX_TICK_DT_S = 0.25;
/** Only stops MORE than this far behind s are seeded as already dwelled. */
export const STOP_BEHIND_EPS_M = 0.5;
/** Observation weight in the pace-controller target blend (timetable gets the rest). */
export const OBS_BLEND_WEIGHT = 0.75;
/**
 * Systematic trail bias, meters: the pace target is the projected observation
 * MINUS this, so the sim rides slightly BEHIND reality rather than ahead.
 */
export const TRAIL_M = 10;
/** Sim this far AHEAD of the target (e < −40) → enter the soft-yield regime. */
export const HARD_BRAKE_ENTER_M = 40;
/** The ahead regime exits once the error recovers above −12 m. */
export const HARD_BRAKE_EXIT_M = 12;
/**
 * DEEP-ahead crawl speed, m/s — a walking-pace backstop used ONLY when the
 * sim has run away beyond DEEP_AHEAD_ENTER_M (broken tracking, rare). The
 * common ahead case (smooth wave, 2026-07-19) rides the soft-yield band
 * (AHEAD_SLOW_*) instead: pedestrian-speed dips between stops read as a
 * glitch to the user, so they are reserved for stuck fixes / envelope /
 * genuinely deep desync.
 */
export const CRAWL_V_MS = 1.0;
/**
 * Soft-yield speed while moderately ahead of reality (crawl latch active,
 * |e| below DEEP_AHEAD_ENTER_M): this fraction of the tram's own cruise
 * product (cruise cap · paceBias · TOD) — a visible ease-off, not a stall.
 */
export const AHEAD_SLOW_FACTOR = 0.5;
/** Floor of the soft-yield speed, m/s (~11 km/h — slow tram, not pedestrian). */
export const AHEAD_SLOW_MIN_V_MS = 3.0;
/**
 * Ahead-error beyond which the soft yield escalates to the CRAWL_V_MS
 * walking-pace backstop (with hysteresis: releases at DEEP_AHEAD_EXIT_M).
 * Bounds runaway when reality moves slower than the soft-yield floor; the
 * primary absorber for large ahead-error remains the adaptive dwell
 * extension at the next stop (DWELL_MAX_EXTEND_S).
 */
export const DEEP_AHEAD_ENTER_M = 120;
/** The deep-ahead crawl releases back to soft yield once e recovers above −this. */
export const DEEP_AHEAD_EXIT_M = 60;
/** Error beyond which the bold catch-up factor cap applies, meters. */
export const BOLD_CATCHUP_ERR_M = 40;
/**
 * Pace factor cap in the bold catch-up regime (e > BOLD_CATCHUP_ERR_M).
 * 1.5 → 1.4 (smooth wave, 2026-07-19): catch-up stays bold but the swing
 * between regimes narrows — big lateness is absorbed by dwell
 * shortening/skipping, not by sprinting.
 */
export const CATCHUP_MAX_FACTOR = 1.4;
/** Pace factor cap in the gentle proportional band (|e| ≤ 40). */
export const GENTLE_MAX_FACTOR = 1.35;
/**
 * Pace factor floor (gentle band; the ahead regimes undercut it).
 * 0.55 → 0.7 (smooth wave, 2026-07-19): between stops the tram always rides
 * at ≥ 70% of its own calibrated pace — mild ahead-error is repaid at the
 * next stop (longer dwell), not by dawdling down an open street.
 */
export const MIN_PACE_FACTOR = 0.7;
/** Proportional gain divisor: factor = 1 + e / PACE_GAIN_M. */
export const PACE_GAIN_M = 120;
/** Max |stop.distM − s| for trusting an at_stop feed state when seeding a dwell, m. */
const AT_STOP_MATCH_M = 50;

// ── observation-pinned holds (field feedback, 2026-07-13 ride sessions) ──────
// A rider sitting in the real tram sees two classes of phantom motion: the sim
// departs a stop while the latest fix still shows the tram standing there
// (early departure), and the sim creeps forward while consecutive fixes pin
// the tram at one mid-segment point (stuck at a light/jam). Both are fixed by
// pinning the sim to what the FIX says, releasing on fresh movement evidence
// or on a bounded staleness compromise (the feed lags; waiting forever would
// be worse than a late departure).

/**
 * Max age of the pinning fix that keeps holding a dwell open past its base
 * duration, seconds. Fix cadence p50 is ~45 s (calibration sessions): a tram
 * still standing keeps refreshing its at-stop fix inside this budget, while a
 * tram that departed right after its last fix shows a moving fix within
 * roughly one cadence. Beyond this age an unseen departure is the better bet.
 *
 * 60 → 45 (first ground-truth ride calibration, 2026-07-20 — docs/calibration/
 * analysis-2026-07-20-ride.md): the rider recording shows the feed keeps
 * reporting at_stop for 50–75 s while the real platform dwell is 15–20 s, so a
 * 60 s hold pinned the sim at stops long after the real departure (worst
 * observed −374 m, sim dwell 95 s vs real 15 s). 45 s = one fix cadence p50 —
 * a standing tram usually refreshes its fix inside the hold, a departed one is
 * released a cadence earlier. Ride replay (ride_replay.py): mean |err| vs the
 * rider −25% (180 → 135 m), both ride halves agree; fleet replay unchanged.
 * Likely to drop further (35–40 s read −33…−42% on this ride) — needs ≥2 more
 * rides before going below one cadence. Also bounds fixPinActive (the
 * projection freeze at a pinned platform) — same staleness story.
 */
export const STOP_HOLD_MAX_FIX_AGE_S = 45;
/**
 * Hidden feed latency, seconds (R12 latency-aware anchoring, first ground-truth
 * ride 2026-07-20 — docs/calibration/analysis-2026-07-20-ride.md §2). The fix
 * timestamp `obsAt` is NOT the moment the tram was actually at `obsDist`: the
 * ride decomposition shows the raw fix already trails reality by +77 m at an
 * apparent age of 0–15 s — i.e. ≈ 8–14 s of pipeline latency (poll + AVL
 * processing) BEYOND obsAt, at the ~5 m/s real pace. So a fix that reads
 * "40 s since obsAt" was really last-seen-standing ≈ 40 s + this latency ago.
 *
 * The staleness clock that decides "the tram has probably left this stop by
 * now" must run on that TRUE age. Adding this to (now − obsAt) releases a
 * stale at-stop hold this many seconds earlier — attacking the ride's dominant
 * behind-mass (the feed reports at_stop for 50–75 s while the real platform
 * dwell is 15–20 s; worst observed −374 m, sim glued to a stale fix). It does
 * NOT re-calibrate the cadence constant above: STOP_HOLD_MAX_FIX_AGE_S stays at
 * one fix-cadence p50 (45 s); this only corrects the age MEASUREMENT it is
 * compared against, so the effective wall release lands at ~42 s (still within
 * one cadence, not the deferred sub-cadence 35–40 s hold the analysis wants ≥2
 * rides for). Deliberately SHRUNK — half-step from the shipped 0 toward the
 * ride-replay optimum (~5–8 s), well under the measured 8–14 s. Ride replay
 * (ride_replay.py): mean |err| 133 → 123 m (−8%), p90 266 → 259, signed
 * −91 → −78; fleet replay (replay.py) bit-identical (the bound never binds at
 * fleet cadence — same result the STOP_HOLD 60→45 change verified). TUNABLE —
 * recalibrate the exact magnitude on future ride recordings.
 */
export const FEED_LATENCY_S = 3;
/**
 * A fix that has advanced more than this past the fix seen at dwell entry is
 * movement evidence (releases the fix-hold); smaller deltas are AVL
 * shape-projection scatter, meters.
 */
export const STOP_HOLD_MOVE_EPS_M = 8;
/** A fix within this far behind the dwell position still pins the dwell, m. */
export const STOP_HOLD_NEAR_BEHIND_M = 30;
/** A fix at most this far AHEAD of the dwell position still pins it (scatter), m. */
export const STOP_HOLD_AHEAD_EPS_M = 8;
/**
 * A fix within this many meters of a platform counts as "standing AT that
 * stop" for the POSITIONAL arrival-pin (no explicit at_stop feed state, but
 * consecutive fixes rest on the platform) — platform-length scale plus AVL
 * shape-projection scatter, meters.
 */
export const FIX_AT_STOP_TOL_M = 20;
/**
 * An arrival-fix snap onto the platform larger than this renders as a
 * teleport (lastTeleportMs → feature-builder opacity fade) instead of an
 * instant small nudge, meters (same class as STUCK_BACK_FADE_M).
 */
export const FIX_STOP_SNAP_FADE_M = 25;
/**
 * Two genuinely new fixes within this many meters of each other mean the tram
 * is physically stuck (red light / jam / incident) — not moving at any
 * schedule pace. The sim holds AT the fix until a moving fix arrives.
 */
export const STUCK_FIX_EPS_M = 8;
/**
 * Stuck detection is suppressed when the fix lies within this of a stop —
 * standing at a platform is a dwell (fix-hold owns it), not a jam, meters.
 */
export const STUCK_NEAR_STOP_M = 40;
/**
 * When a stuck fix is confirmed and the sim has already driven MORE than this
 * far past the pinned point, it is pulled back to the fix — reality says the
 * tram never left it (audit 2026-07-13: the old hold merely stopped the sim
 * wherever it happened to be, stranding it up to ~80 m ahead of the jam for
 * the whole hold). Smaller overshoots stay put: braking-distance leftover and
 * AVL scatter, not worth a visible backward correction, meters.
 */
export const STUCK_BACK_EPS_M = 10;
/**
 * Stuck pull-backs larger than this render as a teleport (lastTeleportMs →
 * feature-builder opacity fade) instead of an instant small nudge, meters.
 */
export const STUCK_BACK_FADE_M = 25;

// ── motion-profile redistribution (field feedback, 2026-07-13) ──────────────
// Real trams leave stops briskly and cruise the first stretch clearly faster
// than their whole-segment average (which includes traffic lights the sim
// cannot see). The departure burst boosts the cruise target for a bounded
// distance out of every dwell; the debt it creates against the pace target is
// repaid where it is least visible — at the next stop, via the adaptive-dwell
// extension — so the calibrated AVERAGE pace (paceBias × cruise ref) is
// untouched. Main smooth-mode sims only; projections mirror real average pace.

/** Cruise-target boost right after leaving a stop. */
export const DEPART_BURST_FACTOR = 1.25;
/** The departure burst lasts this many meters past the departed stop. */
export const DEPART_BURST_DIST_M = 150;

// ── adaptive dwell synchronization ───────────────────────────────────────────
// Stop dwells are the PRIMARY error-correction mechanism for the main
// smooth-mode sim: stretching or trimming a dwell reads as natural boarding
// variance, unlike visible mid-segment speed manipulation. Enabled per sim via
// createSim's { adaptiveDwell: true } option — TramEngine turns it on for MAIN
// sims only; live-projection sims mirror reality and keep fixed dwells.

/** Max extension past the base dwell while waiting for reality to catch up, s. */
export const DWELL_MAX_EXTEND_S = 75;
/**
 * An extended dwell keeps holding while e = target − s ≤ −this (sim still
 * ahead of reality) and releases once e recovers above it, meters.
 */
export const DWELL_EXTEND_RELEASE_M = 8;
/**
 * Dwell-shortening gain, m: when the sim arrives BEHIND reality (e > 0) the
 * base dwell is scaled by clamp(1 − e / this, 0, 1) — the real tram has
 * already used up part of its dwell here.
 */
export const DWELL_SHORTEN_GAIN_M = 80;
/** Behind-error above which an upcoming stop's dwell is skipped entirely, m. */
export const DWELL_SKIP_ERR_M = 60;
/** Minimum visible dwell when stopping at all, s — avoids 1-s door blinks. */
export const DWELL_MIN_S = 4;
/** Speed cap while rolling through a skipped stop's zone, m/s. */
export const DWELL_SKIP_ROLL_V_MS = 4;
/**
 * Half-width of a skipped stop's roll zone, m: v²/(2·A_BRK) — the distance
 * from which the braking envelope has already brought the sim down to
 * DWELL_SKIP_ROLL_V_MS. The skip decision fires only inside this window, so
 * releasing the stop's 0-limit never violates the braking envelope, and the
 * roll cap holds until the same distance past the stop.
 */
export const DWELL_SKIP_ZONE_M =
  (DWELL_SKIP_ROLL_V_MS * DWELL_SKIP_ROLL_V_MS) / (2 * A_BRK);
/**
 * Pace-bias EWMA half-life, seconds: a fix stream at a new pace dominates the
 * bias within ~2–3 min — drivers swap mid-route, and central districts without
 * dedicated tracks run persistently slower than outskirts with them.
 */
export const PACE_BIAS_HALF_LIFE_S = 150;
/** Clamp on one inter-fix real/expected speed ratio sample. */
export const PACE_BIAS_MIN_RATIO = 0.4;
export const PACE_BIAS_MAX_RATIO = 1.6;
/**
 * paceBias prior for a genuinely NEW vehicle (calibration round 1,
 * docs/calibration/analysis-2026-07-11.md): the fleet's converged bias median
 * is ~0.58–0.63, so a fresh sim starting at 1.0 spends its first ~4–5 min
 * simulating a tram ~1.7× too fast (56% rendered ahead of the fresh fix,
 * |err| p90 385 m) before the EWMA converges. Starting at the fleet prior
 * removes that cold-start sprint; a genuinely fast tram still learns upward
 * within a couple of fixes. Existing vehicles inherit their learned bias
 * across teleports and trip changes instead (see applySnapshot / TramEngine).
 */
export const PACE_BIAS_PRIOR = 0.62;
/**
 * Terminal un-latch tolerance, meters: while phase === 'terminal', a FRESH
 * observation placing the real tram more than this far BEHIND the latched
 * position re-anchors the sim to the observation (calibration round 1 R2 —
 * terminal was the worst per-mode error in the 2026-07-11 session: signed
 * sim−obs p50 +324 m across 2.2% of records, because a fresh sim sprints to
 * the last stop, latches terminal with v=0, and sub-500 m errors never
 * teleport). 150 m is comfortably above genuine end-of-trip fix scatter.
 */
export const TERMINAL_UNLATCH_BEHIND_M = 150;
/** Inter-fix intervals shorter than this are too noisy to calibrate on, s. */
export const PACE_BIAS_MIN_DT_S = 8;
/** Inter-fix advances shorter than this are too noisy to calibrate on, m. */
export const PACE_BIAS_MIN_DS_M = 15;
/** Fallback physical tram length when the caller passes none (T3-sized), m. */
export const DEFAULT_TRAM_LENGTH_M = 14.1;

/** Piecewise-linear distance-vs-time schedule through the trip's stops. */
export interface ScheduleAnchor {
  /** Monotonic non-decreasing timestamps, ms (arrival & departure per stop, delay-shifted). */
  times: number[];
  /** Distance along shape at each timestamp, meters. */
  dists: number[];
}

export interface TramSim {
  geometry: RouteGeometry;
  profile: SpeedProfile;
  snapshot: TramSnapshot;
  /** Simulated distance along shape, m. */
  sM: number;
  /** Simulated speed, m/s. */
  vMs: number;
  phase: SimPhase;
  /** When the current dwell ends (ms epoch); meaningful only in 'dwell' phase. */
  dwellUntilMs: number;
  /** Stop sequences already dwelled at (or passed) this trip. */
  dwelledStopSeqs: Set<number>;
  /** Latest schedule anchor (rebuilt on every snapshot). */
  lastAnchor: ScheduleAnchor;
  /** Latest observed distance along shape (clamped to geometry), m — AVL anchor. */
  obsDistM: number;
  /** ms epoch of that observation (snapshot.observedAtMs). */
  obsAtMs: number;
  /**
   * Cached evalScheduleAnchor(lastAnchor, obsAtMs). Recomputed only when the
   * anchor/observation change (createSim/applySnapshot) — the pace controller
   * reads it every tick, so this saves a binary search per evaluation.
   */
  obsSchedDistM: number;
  /**
   * Total physical length incl. any coupled trailer, m (head at sM, tail at
   * sM − lengthM). Drives car-following spacing in TramEngine.
   */
  lengthM: number;
  /** Stops with distM below this are never treated as 0-limits. */
  minStopDist: number;
  /** ms timestamp of the last hard teleport (renderer may dip opacity), 0 if never. */
  lastTeleportMs: number;
  /**
   * Learned per-tram pace multiplier (1 = exactly the profile's cruise pace):
   * recency-weighted EWMA of real inter-fix average speed ÷ profile-expected
   * average speed over the same span (both measured against the
   * V_CRUISE_REF_MS cruise reference). Scales the cruise target in tick() so a
   * tram that consistently runs at 70% of reference pace is simulated at ~70%
   * between fixes instead of sprint-and-crawl. Starts at PACE_BIAS_PRIOR for a
   * genuinely new vehicle and is INHERITED across hard teleports (same
   * vehicle, same driver) and — via TramEngine's per-key memory — across trip
   * changes for the same vehicle key.
   */
  paceBias: number;
  /**
   * Ahead-regime latch: the sim overran the target by more than
   * HARD_BRAKE_ENTER_M and rides the soft-yield band (AHEAD_SLOW_*) until the
   * error recovers above −HARD_BRAKE_EXIT_M. Hysteresis avoids
   * brake/sprint oscillation.
   */
  crawling: boolean;
  /**
   * Deep-ahead escalation latch (only meaningful while crawling): e fell
   * below −DEEP_AHEAD_ENTER_M, so the soft yield gives way to the
   * CRAWL_V_MS walking-pace backstop until e recovers above
   * −DEEP_AHEAD_EXIT_M. Own hysteresis band so the speed does not toggle at
   * the deep boundary when reality is slower than the soft-yield floor.
   */
  deepCrawl: boolean;
  /**
   * Junction-yield hold point, m along shape (null = none): set by
   * TramEngine's junction conflict pairs (crossing paths at a junction —
   * different shapes, crossing bearings). While set, tick() caps vTarget by
   * the braking envelope toward this point, so the yielder brakes to a stand
   * just short of the conflict zone and proceeds when the engine clears the
   * hold (the crossing tram has passed). Speed-only — never touches sM.
   */
  yieldHoldM: number | null;
  /**
   * Adaptive dwell synchronization enabled (MAIN smooth-mode sim only): stop
   * dwells extend while the sim is ahead of reality, shrink or are skipped
   * while behind. Always false for live-projection sims — they mirror reality
   * (dead-reckon the raw fix) by definition.
   */
  adaptiveDwell: boolean;
  /**
   * End of the currently active skipped-stop roll zone, m along shape: while
   * sM is below this, the cruise target is capped at DWELL_SKIP_ROLL_V_MS so
   * the sim rolls through the skipped platform at a modest pace. 0 = none.
   */
  skipRollUntilM: number;
  /**
   * Live-projection sim (TramEngine's projSim): dead-reckons the raw fix at
   * the vehicle's LEARNED pace under the same physics (envelope, stops,
   * dwells) but does NOT chase the pace-controller target — no TRAIL_M bias,
   * no schedule-pace factor, no crawl regime. This is what "Live" mode
   * renders; chasing the schedule-projected target gave it a systematic
   * schedule-pace drag (calibration R11) visible from inside the real tram.
   */
  projection: boolean;
  /**
   * Stuck-hold anchor, m along shape (null = none): set when consecutive
   * genuinely-new fixes report the same mid-segment position — the tram is
   * physically stuck (light/jam). The sim brakes to a stand AT this point and
   * holds until a fresh fix shows movement (soft catch-up resumes then).
   */
  stuckAtM: number | null;
  /**
   * Platform distM the LATEST fix pins the tram at (null = none): set when a
   * fresh fix reports at_stop (or rests on a platform with no observed
   * movement — see detectFixStop). While set and fresh, the fix is
   * AUTHORITATIVE that the tram is standing AT this stop right now: the
   * observation is not projected forward at schedule pace, the pace target is
   * capped at the platform (a late schedule must never drag the sim past a
   * stop the fix holds it at), and a sim caught still approaching is snapped
   * onto the platform into a dwell (arrival-fix anchor, field bug
   * 2026-07-19: the sim used to accelerate past the stop toward the
   * schedule position while the real tram stood boarding).
   */
  fixStopDistM: number | null;
  /** Departure-burst end, m along shape (0 = none); main smooth sims only. */
  burstUntilM: number;
  /**
   * The observed fix distance seen when the current/last dwell began, m. A
   * later fix advancing more than STOP_HOLD_MOVE_EPS_M past it is movement
   * evidence that releases the dwell fix-hold.
   */
  dwellObsDistM: number;
  /**
   * Monotonic scan hint for nextUndwelledStop(): stops[0..nextStopIdx) are
   * known served/skippable (dwelled or below minStopDist — both monotone
   * facts), so the per-tick scan starts here instead of at 0 (stop hot-path
   * audit 2026-07-13). Reset to 0 whenever those facts are invalidated:
   * teleport (snapTo), reanchor, and the stuck pull-back (which re-opens
   * stops). Purely an optimization — behavior is identical to a full scan.
   */
  nextStopIdx: number;
}

// ── schedule anchor ──────────────────────────────────────────────────────────

/** Build sSched(t): piecewise-linear dist-vs-time over stops, shifted by delaySeconds. */
export function buildScheduleAnchor(stops: RouteStop[], delaySeconds: number): ScheduleAnchor {
  const times: number[] = [];
  const dists: number[] = [];
  const shiftMs = delaySeconds * 1000;
  for (const stop of stops) {
    const arr = stop.arrivalMs + shiftMs;
    const dep = Math.max(stop.departureMs + shiftMs, arr);
    const last = times.length > 0 ? times[times.length - 1] : -Infinity;
    const a = Math.max(arr, last);
    times.push(a);
    dists.push(stop.distM);
    if (dep > a) {
      times.push(dep);
      dists.push(stop.distM);
    }
  }
  return { times, dists };
}

/** Evaluate the schedule anchor at tMs (clamped to first/last stop distance). */
export function evalScheduleAnchor(anchor: ScheduleAnchor, tMs: number): number {
  const { times, dists } = anchor;
  const n = times.length;
  if (n === 0) return 0;
  if (tMs <= times[0]) return dists[0];
  if (tMs >= times[n - 1]) return dists[n - 1];
  // Binary search for the bracketing interval.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= tMs) lo = mid;
    else hi = mid;
  }
  const dt = times[hi] - times[lo];
  if (dt <= 0) return dists[hi];
  const t = (tMs - times[lo]) / dt;
  return dists[lo] + (dists[hi] - dists[lo]) * t;
}

/** Where the schedule says this tram should be right now, meters along shape. */
export function scheduleDistAt(sim: TramSim, nowMs: number): number {
  return evalScheduleAnchor(sim.lastAnchor, nowMs);
}

/**
 * True age of the latest fix, ms: wall time since obsAt PLUS the hidden feed
 * latency (FEED_LATENCY_S) — the fix was actually last-seen that much earlier
 * than its obsAt timestamp claims (R12). Used by every "is this fix too stale
 * to still trust as a stand?" check, so a stale at-stop hold releases a feed
 * latency earlier than its apparent age would.
 */
function staleFixAgeMs(sim: TramSim, nowMs: number): number {
  return nowMs - sim.obsAtMs + FEED_LATENCY_S * 1000;
}

/**
 * Whether the fix-pinned platform (fixStopDistM) is still authoritative: the
 * pinning fix must be younger than the same staleness bound the dwell
 * fix-hold uses — past it, an unseen departure is likelier than a record
 * stand and normal schedule projection resumes. The age is latency-adjusted
 * (staleFixAgeMs): the fix is older than obsAt suggests.
 */
function fixPinActive(sim: TramSim, nowMs: number): boolean {
  return sim.fixStopDistM !== null && staleFixAgeMs(sim, nowMs) <= STOP_HOLD_MAX_FIX_AGE_S * 1000;
}

/**
 * The latest AVL observation projected forward from its timestamp to nowMs at
 * schedule pace (never backwards), clamped to the geometry. This — not the
 * timetable — is the primary anchor for a live sim. A fix that pins the tram
 * AT a stop is NOT projected forward: the tram is standing, and advancing it
 * at schedule pace is exactly what used to drag sims past a platform the real
 * tram had just arrived at.
 */
export function observedDistAt(sim: TramSim, nowMs: number): number {
  if (fixPinActive(sim, nowMs)) return clampS(sim.geometry, sim.obsDistM);
  const advance = Math.max(0, evalScheduleAnchor(sim.lastAnchor, nowMs) - sim.obsSchedDistM);
  return clampS(sim.geometry, sim.obsDistM + advance);
}

/**
 * Pace-controller target position: observation-primary blend of the projected
 * AVL observation with the timetable anchor (low-gain reference), minus the
 * systematic TRAIL_M bias — the sim aims slightly BEHIND projected reality so
 * it hurries less and never runs ahead of it under normal tracking.
 *
 * While a fresh fix pins the tram at a stop, the target is additionally
 * capped at that platform: a late timetable (sSched already past the stop)
 * must never pull the sim beyond a stop the fix says the tram is standing at
 * — it would shorten/skip the dwell there and "overshoot" the platform.
 */
export function targetDistAt(sim: TramSim, nowMs: number): number {
  const sSched = evalScheduleAnchor(sim.lastAnchor, nowMs);
  const pinned = fixPinActive(sim, nowMs);
  const sObs = pinned
    ? clampS(sim.geometry, sim.obsDistM)
    : clampS(sim.geometry, sim.obsDistM + Math.max(0, sSched - sim.obsSchedDistM));
  const t = Math.max(0, OBS_BLEND_WEIGHT * sObs + (1 - OBS_BLEND_WEIGHT) * sSched - TRAIL_M);
  return pinned ? Math.min(t, sim.fixStopDistM as number) : t;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clampS(geometry: RouteGeometry, s: number): number {
  return Math.min(Math.max(s, 0), geometry.totalM);
}

function hashString(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Dwell duration for a stop: feed value (scheduled computed dwell — NEVER
 * time-of-day or zonally scaled), else the 18 s ± deterministic 0–8 s jitter
 * default, multiplied by todDwellFactor(nowMs) when a wall clock is provided
 * (peak boarding takes longer) and by the caller-supplied zonal A/B factor
 * (R8 gate-2 treatment trams only — see zonalDwellTreatmentFactor; omitted or
 * 1 keeps the product bit-identical to the pre-experiment value). Callers
 * without a time context omit nowMs and get the unscaled default.
 */
export function dwellDurationMs(
  stop: RouteStop,
  nowMs?: number,
  zonalFactor?: number,
): number {
  if (stop.dwellSeconds > 0) return stop.dwellSeconds * 1000;
  const jitter = (hashString(stop.stopId) % 17) - 8; // deterministic, in [-8, 8]
  const baseMs = (DEFAULT_DWELL_S + jitter) * 1000;
  if (nowMs === undefined) return baseMs;
  return baseMs * todDwellFactor(nowMs) * (zonalFactor ?? 1);
}

/**
 * R8 gate-2 zonal-dwell A/B treatment factor for a sim at a stop
 * (docs/calibration/analysis-2026-07-13.md, round-30 spec). Flag OFF (the
 * default) → exactly 1 for every tram, so multiplying it into
 * dwellDurationMs is a bit-identical no-op. Flag ON (dev only): trams whose
 * key is an EVEN registration number form the treatment group — the parity
 * split matches the analysis scripts' `int(key) % 2`, so the key must be a
 * pure integer string; ODD and non-numeric (trip-id fallback, possibly
 * digit-prefixed) keys are the control group and stay at 1. Treated trams get
 * zonalDwellFactor(stop) — centre x1.30 / outskirts x0.90 — on DEFAULT dwells
 * only via dwellDurationMs.
 */
export function zonalDwellTreatmentFactor(sim: TramSim, stop: RouteStop): number {
  if (!ZONAL_DWELL_AB) return 1;
  const key = sim.snapshot.key;
  const reg = parseInt(key, 10);
  // Strict-integer keys only (String(reg) round-trips) — a digit-prefixed
  // trip-id fallback key must land in control, exactly like the analysis
  // scripts' int(key) which rejects it.
  if (!Number.isFinite(reg) || String(reg) !== key || reg % 2 !== 0) return 1;
  return zonalDwellFactor(stop.coordinates);
}

function isTerminalStop(geometry: RouteGeometry, stop: RouteStop): boolean {
  const stops = geometry.stops;
  return stop.isTerminal || (stops.length > 0 && stop === stops[stops.length - 1]);
}

/**
 * Seed dwell state for a freshly (re)positioned sim:
 *  - mark only stops UNAMBIGUOUSLY behind as already dwelled — strictly behind
 *    sM by more than STOP_BEHIND_EPS_M, or at/before the feed's last-stop
 *    sequence when it matches the geometry (never the forward reach tolerance);
 *  - when the sim starts AT a stop — the feed says at_stop, or an unmarked stop
 *    lies within reach of the spawn position — begin a dwell there instead of
 *    silently skipping it. Remaining dwell derives from the scheduled departure
 *    (+ delay); if that has already passed, fall back to the default dwell for
 *    at_stop, else treat the dwell as served.
 */
function seedStopState(sim: TramSim, nowMs: number): void {
  const { stops } = sim.geometry;
  const snap = sim.snapshot;
  const atStop = snap.statePosition === 'at_stop';
  const lastSeq = snap.lastStopSequence;
  const hasSeq = lastSeq !== null && stops.some((st) => st.sequence === lastSeq);

  let min = 0;
  for (const stop of stops) {
    // When at_stop — or when the fix PINS this platform (fixStopDistM, §14
    // arrival anchor; e.g. a projSim reseed whose feed still reads on_track
    // with lastStopSequence already pointing at the stop) — the stop the
    // tram stands AT must stay unmarked so the dwell below can happen.
    const pinnedStop =
      sim.fixStopDistM !== null && Math.abs(stop.distM - sim.fixStopDistM) <= STOP_REACH_M;
    const seqBehind =
      !pinnedStop && hasSeq && (atStop ? stop.sequence < lastSeq : stop.sequence <= lastSeq);
    const distBehind = stop.distM < sim.sM - STOP_BEHIND_EPS_M;
    if (seqBehind || distBehind) {
      sim.dwelledStopSeqs.add(stop.sequence);
      if (stop.distM + 0.01 > min) min = stop.distM + 0.01;
    }
  }
  sim.minStopDist = min;

  // The stop the sim starts at: prefer the feed-declared at_stop stop, else any
  // unmarked stop within reach of the spawn position.
  let current: RouteStop | null = null;
  if (atStop && hasSeq) {
    const st = stops.find((s) => s.sequence === lastSeq) ?? null;
    if (
      st &&
      !sim.dwelledStopSeqs.has(st.sequence) &&
      Math.abs(st.distM - sim.sM) <= AT_STOP_MATCH_M
    ) {
      current = st;
    }
  }
  if (!current) {
    for (const stop of stops) {
      if (stop.distM > sim.sM + STOP_REACH_M) break;
      if (sim.dwelledStopSeqs.has(stop.sequence)) continue;
      if (Math.abs(stop.distM - sim.sM) <= STOP_REACH_M) {
        current = stop;
        break;
      }
    }
  }
  if (!current) return;

  sim.vMs = 0;
  sim.dwelledStopSeqs.add(current.sequence);
  sim.minStopDist = Math.max(sim.minStopDist, current.distM + 0.01);
  if (isTerminalStop(sim.geometry, current)) {
    sim.phase = 'terminal';
    return;
  }
  // A fix-pinned platform is as authoritative as an explicit at_stop state:
  // the tram is STANDING here, so a passed scheduled departure must still
  // begin a (default-length) dwell instead of cruising on.
  const pinnedHere =
    sim.fixStopDistM !== null && Math.abs(current.distM - sim.fixStopDistM) <= STOP_REACH_M;
  const departMs = current.departureMs + snap.delaySeconds * 1000;
  if (departMs > nowMs) {
    sim.phase = 'dwell';
    sim.dwellUntilMs = departMs;
    sim.dwellObsDistM = sim.obsDistM;
  } else if (atStop || pinnedHere) {
    sim.phase = 'dwell';
    sim.dwellUntilMs =
      nowMs + dwellDurationMs(current, nowMs, zonalDwellTreatmentFactor(sim, current));
    sim.dwellObsDistM = sim.obsDistM;
  }
  // else: scheduled departure already passed and the feed doesn't report
  // at_stop — the dwell is considered served; cruise on.
}

/**
 * Fix-hold: while the LATEST fix still shows the tram standing at the dwell
 * position, the dwell continues past its base duration — the sim must never
 * depart a stop ahead of an at-stop fix (field feedback #1). Releases when a
 * fresh fix advances past the fix seen at dwell entry (movement evidence), or
 * when the pinning fix is old enough that an unseen departure is likelier
 * than a record dwell (the feed has latency; never wait forever).
 */
function fixPinsDwell(sim: TramSim, nowMs: number): boolean {
  if (staleFixAgeMs(sim, nowMs) > STOP_HOLD_MAX_FIX_AGE_S * 1000) return false;
  if (sim.obsDistM - sim.dwellObsDistM > STOP_HOLD_MOVE_EPS_M) return false; // fix moved on
  const behind = sim.sM - sim.obsDistM; // fix relative to the dwell position
  if (behind < -STOP_HOLD_AHEAD_EPS_M) return false; // fix ahead beyond scatter
  if (behind <= STOP_HOLD_NEAR_BEHIND_M) return true;
  // Further behind: only an explicit at_stop feed state within the at-stop
  // matching radius still counts as "standing at this stop".
  return sim.snapshot.statePosition === 'at_stop' && behind <= AT_STOP_MATCH_M;
}

/**
 * Which stop (if any) the latest fix pins the tram AT — the arrival-side
 * complement of fixPinsDwell (which only guards an already-running dwell):
 *  - explicit `at_stop` feed state: the feed-declared stop (lastStopSequence)
 *    when it matches the geometry near the fix, else the nearest platform
 *    within AT_STOP_MATCH_M of the fix;
 *  - positional: the fix rests within FIX_AT_STOP_TOL_M of a platform AND has
 *    not moved more than STOP_HOLD_MOVE_EPS_M since the previous fix (standing
 *    evidence — a tram sweeping past the platform shows a large inter-fix
 *    advance and is never pinned). Requires a previous fix; callers without
 *    one (createSim) pass null and get the explicit branch only.
 */
function detectFixStop(sim: TramSim, prevObsDistM: number | null): RouteStop | null {
  const stops = sim.geometry.stops;
  const obs = sim.obsDistM;
  const snap = sim.snapshot;
  if (snap.statePosition === 'at_stop') {
    const seq = snap.lastStopSequence;
    if (seq !== null) {
      for (const st of stops) {
        if (st.sequence === seq && Math.abs(st.distM - obs) <= AT_STOP_MATCH_M) return st;
      }
    }
    return nearestStopWithin(stops, obs, AT_STOP_MATCH_M);
  }
  if (prevObsDistM === null || Math.abs(obs - prevObsDistM) > STOP_HOLD_MOVE_EPS_M) return null;
  return nearestStopWithin(stops, obs, FIX_AT_STOP_TOL_M);
}

/** Nearest stop within `tolM` of the along-shape position, or null. */
function nearestStopWithin(stops: RouteStop[], obs: number, tolM: number): RouteStop | null {
  let best: RouteStop | null = null;
  let bestD = tolM;
  for (const st of stops) {
    if (st.distM > obs + tolM) break; // stops are ordered by distM
    const d = Math.abs(st.distM - obs);
    if (d <= bestD) {
      best = st;
      bestD = d;
    }
  }
  return best;
}

/**
 * Arrival-fix anchor (field bug 2026-07-19): a fresh fix pinning the tram AT
 * a stop is authoritative — the tram is standing there NOW. A sim caught
 * still APPROACHING that platform is snapped onto it and put into a dwell,
 * instead of accelerating toward the (possibly late) schedule position past
 * the stop while the real tram stands boarding. Composes with:
 *  - targetDistAt's platform cap (the schedule can't drag the sim onward);
 *  - fixPinsDwell (the dwell then holds until the fix moves or goes stale);
 *  - the adaptive-dwell shorten/skip paths, which see e ≤ 0 at the platform
 *    while the pin is active and therefore never trim this dwell.
 * The snap is FORWARD-only (sM stays monotonic); a jump beyond
 * FIX_STOP_SNAP_FADE_M renders as a teleport fade. Sims at/past the platform
 * are left alone — dwell/fix-hold/soft-yield own those cases.
 */
function updateFixStopPin(sim: TramSim, prevObsDistM: number, nowMs: number): void {
  const stop = detectFixStop(sim, prevObsDistM);
  sim.fixStopDistM = stop ? stop.distM : null;
  if (!stop || sim.phase === 'terminal') return;
  const behindM = stop.distM - sim.sM;
  if (behindM <= STOP_REACH_M) return; // at/past the platform already
  if (behindM > FIX_STOP_SNAP_FADE_M) sim.lastTeleportMs = nowMs;
  sim.sM = stop.distM;
  sim.vMs = 0;
  sim.crawling = false;
  sim.deepCrawl = false;
  sim.skipRollUntilM = 0;
  sim.burstUntilM = 0;
  // Every stop up to (and incl.) the platform is behind the sim now — served.
  let min = sim.minStopDist;
  for (const st of sim.geometry.stops) {
    if (st.distM > stop.distM) break;
    sim.dwelledStopSeqs.add(st.sequence);
    if (st.distM + 0.01 > min) min = st.distM + 0.01;
  }
  sim.minStopDist = min;
  sim.dwellObsDistM = sim.obsDistM;
  if (isTerminalStop(sim.geometry, stop)) {
    sim.phase = 'terminal';
    return;
  }
  sim.phase = 'dwell';
  const departMs = stop.departureMs + sim.snapshot.delaySeconds * 1000;
  sim.dwellUntilMs =
    departMs > nowMs
      ? departMs
      : nowMs + dwellDurationMs(stop, nowMs, zonalDwellTreatmentFactor(sim, stop));
}

/**
 * A sim (re)seeded BETWEEN stops is already moving — a tram observed
 * mid-segment did not stop there to wait for us (field feedback #2). Seed the
 * speed straight to the segment's cruise pace, bounded by the braking
 * envelope, instead of accelerating from 0 out of nowhere. Sims seeded into a
 * dwell/terminal, or pinned by a stuck fix, stay stopped.
 */
function seedCruiseSpeed(sim: TramSim, nowMs: number): void {
  if (sim.phase !== 'cruise' || sim.stuckAtM !== null) return;
  sim.vMs = Math.min(
    vAllowedAt(sim.profile, sim.geometry, sim.sM, sim.minStopDist),
    Math.min(cruiseCapAt(sim.profile, sim.geometry, sim.sM), V_CRUISE_REF_MS) *
      sim.paceBias *
      todPaceFactor(nowMs),
  );
}

/**
 * First stop not yet dwelled at (stops are ordered by distance along shape).
 * Advances the sim's monotonic nextStopIdx hint as it skips: a stop rejected
 * for being dwelled or below minStopDist stays rejected forever (both facts
 * only grow, except at the resets that also clear the hint), so the scan
 * never re-visits the prefix — O(1) amortized per tick instead of O(stops).
 */
export function nextUndwelledStop(sim: TramSim): RouteStop | null {
  const stops = sim.geometry.stops;
  let i = sim.nextStopIdx;
  for (; i < stops.length; i++) {
    const stop = stops[i];
    if (stop.distM < sim.minStopDist || sim.dwelledStopSeqs.has(stop.sequence)) continue;
    sim.nextStopIdx = i;
    return stop;
  }
  sim.nextStopIdx = i;
  return null;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export interface CreateSimOptions {
  /**
   * Enable adaptive dwell synchronization (extend/shorten/skip stop dwells to
   * absorb tracking error). TramEngine sets this for MAIN smooth-mode sims
   * only — live-projection sims must mirror reality with fixed dwells.
   * Defaults to false.
   */
  adaptiveDwell?: boolean;
  /**
   * Seed paceBias from a previously learned value (TramEngine's per-key
   * memory: same vehicle, new trip/sim — the driver didn't change). Clamped
   * to [PACE_BIAS_MIN_RATIO, PACE_BIAS_MAX_RATIO]. Defaults to
   * PACE_BIAS_PRIOR for genuinely new vehicles.
   */
  initialPaceBias?: number;
  /**
   * Create a live-projection sim: dead-reckons the fix at the learned pace,
   * never chases the pace-controller target (no trail bias / crawl / bursts).
   * TramEngine sets this for projSims only. Defaults to false.
   */
  projection?: boolean;
  /**
   * Seed the stuck-hold anchor (TramEngine passes the main sim's stuckAtM
   * when re-seeding a projSim on a repeated-position fix): the sim spawns AT
   * the raw fix, standing, and holds there. Defaults to null (not stuck).
   */
  stuckAtM?: number | null;
  /**
   * Seed the fix-pinned platform (TramEngine passes the main sim's
   * fixStopDistM when re-seeding a projSim): the sim spawns standing AT this
   * stop, in a dwell — never dead-reckoned forward past it. When omitted,
   * createSim derives the pin itself from an explicit at_stop feed state
   * (the positional pin needs a previous fix and only arises in
   * applySnapshot). Pass null to force no pin.
   */
  fixStopDistM?: number | null;
}

/**
 * Create a sim from a live snapshot. Initial s = the reported shape distance
 * projected forward by the elapsed time since observation at schedule pace.
 */
export function createSim(
  geometry: RouteGeometry,
  profile: SpeedProfile,
  snapshot: TramSnapshot,
  nowMs: number,
  lengthM: number = DEFAULT_TRAM_LENGTH_M,
  opts: CreateSimOptions = {},
): TramSim {
  const anchor = buildScheduleAnchor(geometry.stops, snapshot.delaySeconds);
  const obsSchedDistM = evalScheduleAnchor(anchor, snapshot.observedAtMs);
  const schedAdvance = Math.max(0, evalScheduleAnchor(anchor, nowMs) - obsSchedDistM);
  const stuckAtM = opts.stuckAtM ?? null;
  const obsDistM = clampS(geometry, snapshot.shapeDistM);
  const sim: TramSim = {
    geometry,
    profile,
    snapshot,
    // A stuck tram is NOT advancing at schedule pace — seed exactly at the fix.
    sM: stuckAtM !== null ? obsDistM : clampS(geometry, snapshot.shapeDistM + schedAdvance),
    vMs: 0,
    phase: 'cruise',
    dwellUntilMs: 0,
    dwelledStopSeqs: new Set<number>(),
    lastAnchor: anchor,
    obsDistM,
    obsAtMs: snapshot.observedAtMs,
    obsSchedDistM,
    lengthM,
    minStopDist: 0,
    lastTeleportMs: 0,
    paceBias: Math.min(
      PACE_BIAS_MAX_RATIO,
      Math.max(PACE_BIAS_MIN_RATIO, opts.initialPaceBias ?? PACE_BIAS_PRIOR),
    ),
    crawling: false,
    deepCrawl: false,
    yieldHoldM: null,
    adaptiveDwell: opts.adaptiveDwell === true,
    skipRollUntilM: 0,
    projection: opts.projection === true,
    stuckAtM,
    fixStopDistM: null,
    burstUntilM: 0,
    dwellObsDistM: obsDistM,
    nextStopIdx: 0,
  };
  // Fix-pinned platform: caller-provided (projSim reseeds inherit the main
  // sim's pin), else derived from an explicit at_stop feed state. A pinned
  // sim spawns standing AT the platform — never projected forward past it at
  // schedule pace (that projection is how live mode used to drive off a stop
  // the real tram had just arrived at).
  const pinnedDistM =
    opts.fixStopDistM !== undefined
      ? opts.fixStopDistM
      : (detectFixStop(sim, null)?.distM ?? null);
  sim.fixStopDistM = pinnedDistM;
  if (pinnedDistM !== null) sim.sM = clampS(geometry, pinnedDistM);
  seedStopState(sim, nowMs);
  seedCruiseSpeed(sim, nowMs);
  return sim;
}

/** Re-anchor a sim to a new distance (used when swapping geometry between trips). */
export function reanchorSim(sim: TramSim, sM: number, nowMs: number): void {
  sim.sM = clampS(sim.geometry, sM);
  sim.phase = 'cruise';
  sim.dwellUntilMs = 0;
  sim.crawling = false;
  sim.deepCrawl = false;
  sim.yieldHoldM = null; // new shape — old hold point is meaningless
  sim.fixStopDistM = null; // new shape — old platform pin is meaningless
  sim.skipRollUntilM = 0;
  sim.burstUntilM = 0;
  sim.stuckAtM = null; // new shape — old along-shape anchor is meaningless
  sim.dwelledStopSeqs.clear();
  sim.nextStopIdx = 0;
  seedStopState(sim, nowMs);
  seedCruiseSpeed(sim, nowMs);
}

/**
 * Per-tram adaptive calibration: on a genuinely NEW fix, compare the real
 * average speed over the inter-fix interval (Δs_obs/Δt_obs along the shape,
 * with the scheduled dwell time of stops strictly inside the span deducted)
 * against the PROFILE-EXPECTED average cruise speed over the same span, and
 * fold the clamped ratio into sim.paceBias via a time-based EWMA (half-life
 * PACE_BIAS_HALF_LIFE_S — recent fixes dominate, so a driver change fades in
 * ~2–3 min). Degenerate samples (Δt < 8 s, Δs < 15 m) are skipped.
 */
function updatePaceBias(
  sim: TramSim,
  prevObsDistM: number,
  prevObsAtMs: number,
  snapshot: TramSnapshot,
): void {
  if (prevObsAtMs <= 0 || snapshot.observedAtMs <= prevObsAtMs) return;
  const dtObsS = (snapshot.observedAtMs - prevObsAtMs) / 1000;
  const obsDistM = clampS(sim.geometry, snapshot.shapeDistM);
  const dsObsM = obsDistM - prevObsDistM;
  if (dtObsS < PACE_BIAS_MIN_DT_S || dsObsM < PACE_BIAS_MIN_DS_M) return;

  // Deduct the (estimated) dwell time of stops strictly inside the span so
  // the sample measures MOTION pace, matching the dwell-free expected speed.
  // Never let the deduction eat more than 3/4 of the interval — the estimate
  // is scheduled, not measured.
  let dwellS = 0;
  for (const stop of sim.geometry.stops) {
    if (stop.distM > prevObsDistM + 1 && stop.distM < obsDistM - 1) {
      dwellS +=
        dwellDurationMs(stop, snapshot.observedAtMs, zonalDwellTreatmentFactor(sim, stop)) / 1000;
    }
  }
  const effDtS = Math.max(dtObsS - dwellS, dtObsS * 0.25);

  // Expected speed against the CRUISE REFERENCE (V_CRUISE_REF_MS-capped)
  // TIMES the time-of-day pace factor — the exact product tick() multiplies
  // paceBias into. The calibration must measure against the same expectation,
  // or the bias would re-learn the TOD factor into itself and the factor
  // would apply twice once TOD_PACE_TABLE ships non-1.0 entries (night round
  // 2026-07-12); bias learns only the per-vehicle RESIDUAL. Evaluated at the
  // inter-fix midpoint (the factor is hour-blended and the span can cross an
  // hour boundary). With the shipped all-1.0 table the factor is exactly 1
  // and `expected` is bit-identical to the pre-fix value.
  const expected =
    meanCruiseCapOver(sim.profile, sim.geometry, prevObsDistM, obsDistM, V_CRUISE_REF_MS) *
    todPaceFactor((prevObsAtMs + snapshot.observedAtMs) / 2);
  if (expected < 0.1) return;
  const ratio = Math.min(
    PACE_BIAS_MAX_RATIO,
    Math.max(PACE_BIAS_MIN_RATIO, dsObsM / effDtS / expected),
  );
  // Time-based EWMA: weight decays by half every PACE_BIAS_HALF_LIFE_S of
  // observed time, regardless of fix cadence.
  const alpha = 1 - Math.pow(0.5, dtObsS / PACE_BIAS_HALF_LIFE_S);
  sim.paceBias += alpha * (ratio - sim.paceBias);
}

/** Snap the sim to `sM` and rebuild its motion/dwell state (teleport core). */
function snapTo(sim: TramSim, sM: number, nowMs: number): void {
  sim.sM = clampS(sim.geometry, sM);
  sim.vMs = 0;
  sim.phase = 'cruise';
  sim.dwellUntilMs = 0;
  sim.crawling = false;
  sim.deepCrawl = false;
  sim.yieldHoldM = null; // re-anchored — the engine re-derives holds on ingest
  sim.fixStopDistM = null; // re-derived from the fresh fix by the caller
  sim.skipRollUntilM = 0;
  sim.burstUntilM = 0;
  sim.stuckAtM = null; // a >500 m re-anchor is movement evidence in itself
  sim.dwelledStopSeqs.clear();
  sim.nextStopIdx = 0;
  seedStopState(sim, nowMs);
  seedCruiseSpeed(sim, nowMs); // a tram teleported mid-segment is moving
  sim.lastTeleportMs = nowMs;
}

/**
 * Ingest a fresh snapshot for the same trip: rebuild the schedule anchor with
 * the new delay and re-anchor the observation (shapeDistM @ observedAtMs) so
 * every poll reconciles the sim with reality. Convergence happens via the pace
 * controller — no position jumps — unless the projected OBSERVATION disagrees
 * with the sim by more than 500 m, which hard-teleports to the observation.
 * Genuinely new fixes also feed the per-tram pace calibration (paceBias) —
 * except across a teleport, whose inter-fix "speed" is a re-anchor artifact,
 * not motion. paceBias itself survives a teleport: it is the same physical
 * vehicle and driver, and the learned pace was the one thing the old sim got
 * right (calibration round 1 — resetting it re-triggered the cold-start
 * sprint on every teleport).
 *
 * Terminal un-latch (calibration round 1 R2): 'terminal' is otherwise an
 * absorbing state (tick() holds v=0 forever), so a sim that sprinted to the
 * last stop ahead of reality would sit there wrongly for minutes — sub-500 m
 * errors never teleport. If a FRESH fix places the real tram more than
 * TERMINAL_UNLATCH_BEHIND_M behind the latched position, re-anchor the sim to
 * the observation and resume normal simulation. This is a deliberate,
 * bounded BACKWARD teleport — the one exception to sM monotonicity besides
 * the 500 m teleport: the pace controller cannot recover from a wrong
 * terminal latch (v is pinned to 0 and reality is behind), so honesty beats
 * monotonicity here. It renders as a teleport (lastTeleportMs), not a reverse
 * drive.
 */
export function applySnapshot(sim: TramSim, snapshot: TramSnapshot, nowMs: number): void {
  const prevObsDistM = sim.obsDistM;
  const prevObsAtMs = sim.obsAtMs;
  sim.snapshot = snapshot;
  sim.lastAnchor = buildScheduleAnchor(sim.geometry.stops, snapshot.delaySeconds);
  sim.obsDistM = clampS(sim.geometry, snapshot.shapeDistM);
  sim.obsAtMs = snapshot.observedAtMs;
  sim.obsSchedDistM = evalScheduleAnchor(sim.lastAnchor, snapshot.observedAtMs);
  const sObs = observedDistAt(sim, nowMs);
  if (Math.abs(sObs - sim.sM) > TELEPORT_THRESHOLD_M) {
    // Hard teleport: no pace sample (the jump is not motion), bias inherited.
    snapTo(sim, sObs, nowMs);
    // The teleporting fix may itself pin a platform (at_stop across a trip
    // re-anchor): land the sim standing there, not projected past it. The
    // positional pin cannot false-trigger here (the >500 m inter-fix jump
    // fails its movement gate).
    updateFixStopPin(sim, prevObsDistM, nowMs);
    return;
  }
  updatePaceBias(sim, prevObsDistM, prevObsAtMs, snapshot);
  const freshFix = snapshot.observedAtMs > prevObsAtMs || sim.obsDistM !== prevObsDistM;
  if (freshFix) updateStuckHold(sim, prevObsDistM, prevObsAtMs, snapshot, nowMs);
  if (sim.phase === 'terminal' && freshFix && sim.sM - sObs > TERMINAL_UNLATCH_BEHIND_M) {
    snapTo(sim, sObs, nowMs);
  }
  // Arrival-fix anchor: a fresh fix standing AT a stop snaps a still-
  // approaching sim onto the platform and into a dwell (runs after the
  // terminal un-latch so a just-un-latched sim can land at its platform too).
  if (freshFix) updateFixStopPin(sim, prevObsDistM, nowMs);
}

/**
 * Stuck detection (field feedback #3): two-plus genuinely new fixes at the
 * same mid-segment point mean the tram is physically stuck (light / jam /
 * incident) — hold the sim AT that point instead of interpolating forward at
 * schedule pace. A fresh fix that moved by more than STUCK_FIX_EPS_M clears
 * the hold (the pace controller's catch-up then closes the gap softly).
 * Standing at/near a stop is a dwell, not a jam — the dwell fix-hold owns it.
 * Stuck fixes never pollute paceBias (Δs < PACE_BIAS_MIN_DS_M skips them).
 *
 * When the confirming fix arrives AFTER the sim already drove past the pinned
 * point (the fix cadence is slow; the sim was cruising at learned pace in the
 * meantime), the sim is pulled BACK to the fix — bounded, and rendered as a
 * teleport fade when large (see rewindToStuckFix). The hold releases only on
 * a fresh fix that actually moved (> STUCK_FIX_EPS_M).
 */
function updateStuckHold(
  sim: TramSim,
  prevObsDistM: number,
  prevObsAtMs: number,
  snapshot: TramSnapshot,
  nowMs: number,
): void {
  if (Math.abs(sim.obsDistM - prevObsDistM) > STUCK_FIX_EPS_M) {
    sim.stuckAtM = null; // moving fix — release, soft catch-up takes over
    return;
  }
  // Same position: only a TIME-advanced repeat is evidence of standing still.
  if (snapshot.observedAtMs <= prevObsAtMs || prevObsAtMs <= 0) return;
  if (snapshot.statePosition === 'at_stop') return;
  for (const stop of sim.geometry.stops) {
    if (stop.distM > sim.obsDistM + STUCK_NEAR_STOP_M) break;
    if (Math.abs(stop.distM - sim.obsDistM) <= STUCK_NEAR_STOP_M) return;
  }
  sim.stuckAtM = sim.obsDistM;
  rewindToStuckFix(sim, nowMs);
}

/**
 * Bounded backward correction to a just-confirmed stuck fix: the tram is
 * physically standing AT sim.stuckAtM while the sim already drove ahead of it.
 * Overshoots ≤ STUCK_BACK_EPS_M stay put (scatter / braking leftover); larger
 * ones snap back to the anchor — quietly when small, marked as a teleport
 * (renderer fade) beyond STUCK_BACK_FADE_M. This is a deliberate exception to
 * sM monotonicity, same class as the terminal un-latch: the hold pins v to 0
 * with reality behind, so the pace controller could never recover the error.
 * Stops the overshoot had already "served" are re-opened — the real tram is
 * still behind them and must dwell there after the jam clears.
 */
function rewindToStuckFix(sim: TramSim, nowMs: number): void {
  const anchorM = sim.stuckAtM;
  if (anchorM === null) return;
  const backM = sim.sM - anchorM;
  if (backM <= STUCK_BACK_EPS_M) return;
  sim.sM = anchorM;
  sim.vMs = 0;
  sim.phase = 'cruise'; // stuckAtM keeps it standing; no dwell/terminal latch
  sim.dwellUntilMs = 0;
  sim.crawling = false;
  sim.deepCrawl = false;
  sim.skipRollUntilM = 0;
  sim.burstUntilM = 0;
  // Re-open stops now ahead of the corrected position and rebuild minStopDist
  // from the marks that remain (stuck arming guarantees no stop within
  // STUCK_NEAR_STOP_M of the anchor, so nothing re-opens right on top of it).
  let min = 0;
  for (const stop of sim.geometry.stops) {
    if (stop.distM > sim.sM + STOP_REACH_M) sim.dwelledStopSeqs.delete(stop.sequence);
    else if (sim.dwelledStopSeqs.has(stop.sequence) && stop.distM + 0.01 > min) {
      min = stop.distM + 0.01;
    }
  }
  sim.minStopDist = min;
  sim.nextStopIdx = 0; // re-opened stops invalidate the monotonic scan hint
  if (backM > STUCK_BACK_FADE_M) sim.lastTeleportMs = nowMs;
}

// ── physics tick ─────────────────────────────────────────────────────────────

/**
 * Advance the sim by dtS seconds. Asymmetric pace controller around
 * e = target(now) − s (target = observation-primary blend − TRAIL_M):
 *  - e < −HARD_BRAKE_ENTER_M (sim ran ahead): soft-yield regime — ease off to
 *    max(AHEAD_SLOW_MIN_V_MS, AHEAD_SLOW_FACTOR · cruise product) until e
 *    recovers above −HARD_BRAKE_EXIT_M (hysteresis latch on sim.crawling).
 *    Only a deep runaway (e < −DEEP_AHEAD_ENTER_M, own hysteresis on
 *    sim.deepCrawl) drops to the CRAWL_V_MS walking-pace backstop. The sim
 *    NEVER moves backwards.
 *  - e > BOLD_CATCHUP_ERR_M (behind): bold catch-up, pace factor up to 1.4.
 *  - between: gentle proportional control, factor clamp(1 + e/120, 0.7, 1.35).
 * The cruise target is additionally scaled by the learned per-tram paceBias.
 * All regimes stay clamped by the braking envelope (vTarget ≤ vAllowed) —
 * catch-up can never defeat curve/stop limits. Acceleration is clamped to
 * [−A_BRK, +A_ACC] m/s². s never decreases.
 *
 * Adaptive dwell synchronization (sim.adaptiveDwell — main smooth-mode sims
 * only) handles the error AT STOPS, composing with the mid-segment regimes:
 *  - ahead (e ≤ −DWELL_EXTEND_RELEASE_M at base-dwell expiry): keep dwelling —
 *    "boarding takes longer" — re-evaluated every tick (a fresh fix releases
 *    early), capped at base + DWELL_MAX_EXTEND_S. phase stays 'dwell'.
 *  - behind (e > 0 at arrival): base dwell scaled by clamp(1 − e/80, 0, 1),
 *    never below DWELL_MIN_S when stopping at all.
 *  - badly behind (e > DWELL_SKIP_ERR_M): skip the dwell — mark the stop
 *    served and roll through its zone at ≤ DWELL_SKIP_ROLL_V_MS; phase never
 *    enters 'dwell' (the real tram already left, doors stay closed).
 */
export function tick(sim: TramSim, nowMs: number, dtS: number): void {
  const dt = Math.min(Math.max(dtS, 0), MAX_TICK_DT_S);

  if (sim.phase === 'terminal') {
    sim.vMs = 0;
    return;
  }
  if (sim.phase === 'dwell') {
    sim.vMs = 0;
    if (nowMs >= sim.dwellUntilMs) {
      // Fix-hold (ALL sims, incl. projections): while the latest fix still
      // shows the tram standing at this stop, keep dwelling — never depart
      // ahead of an at-stop fix. Releases on fix movement or fix staleness.
      const holdForFix = fixPinsDwell(sim, nowMs);
      // Adaptive extension: while the sim is still AHEAD of reality, keep
      // holding at the platform — it reads as slow boarding, not error
      // correction. Re-evaluated every tick so a fresh fix releases it early;
      // hard-capped at base dwell + DWELL_MAX_EXTEND_S.
      const holdForReality =
        sim.adaptiveDwell &&
        nowMs < sim.dwellUntilMs + DWELL_MAX_EXTEND_S * 1000 &&
        targetDistAt(sim, nowMs) - sim.sM <= -DWELL_EXTEND_RELEASE_M;
      if (!holdForFix && !holdForReality) {
        sim.phase = 'cruise';
        // Motion-profile departure burst (main smooth sims only): brisk exit,
        // debt repaid at the next stop by the adaptive-dwell extension.
        if (sim.adaptiveDwell) sim.burstUntilM = sim.sM + DEPART_BURST_DIST_M;
      }
    }
    return;
  }
  if (dt <= 0) return;

  // Pace controller: observation-primary target, timetable as low-gain
  // reference. Projection sims chase no target (e is never read for them).
  const e = sim.projection ? 0 : targetDistAt(sim, nowMs) - sim.sM;

  // Adaptive dwell skip: badly behind reality — the real tram already served
  // and left this stop — so don't stop at all: mark the stop served (it must
  // not re-trigger) and roll through its zone at a modest cap. Decided only
  // once the braking envelope has already brought the sim inside
  // DWELL_SKIP_ZONE_M (i.e. at/below the roll cap), so releasing the stop's
  // 0-limit never violates the envelope. Terminal stops are never skipped.
  let next = nextUndwelledStop(sim);
  if (
    sim.adaptiveDwell &&
    next &&
    e > DWELL_SKIP_ERR_M &&
    next.distM - sim.sM <= DWELL_SKIP_ZONE_M &&
    !isTerminalStop(sim.geometry, next)
  ) {
    sim.dwelledStopSeqs.add(next.sequence);
    sim.minStopDist = next.distM + 0.01;
    sim.skipRollUntilM = next.distM + DWELL_SKIP_ZONE_M;
    next = nextUndwelledStop(sim);
  }

  const vAllowed = vAllowedAt(sim.profile, sim.geometry, sim.sM, sim.minStopDist);

  let vTarget: number;
  if (sim.projection) {
    // Live projection: dead-reckon the fix at the vehicle's LEARNED pace under
    // the same physics — no trail bias, no schedule-pace target chasing, no
    // crawl. What "Live" mode renders must move like the real tram moves.
    vTarget = Math.min(
      vAllowed,
      Math.min(cruiseCapAt(sim.profile, sim.geometry, sim.sM), V_CRUISE_REF_MS) *
        sim.paceBias *
        todPaceFactor(nowMs),
    );
  } else {
    // Ahead-regime latch with hysteresis (enter at −40 m, exit at −12 m).
    if (sim.crawling) {
      if (e > -HARD_BRAKE_EXIT_M) {
        sim.crawling = false;
        sim.deepCrawl = false;
      }
    } else if (e < -HARD_BRAKE_ENTER_M) {
      sim.crawling = true;
    }

    if (sim.crawling) {
      // Ran ahead of reality: soft yield — ease off to a fraction of the
      // tram's OWN pace (never a pedestrian stall) and let the projected
      // observation catch up; the remainder is absorbed at the next stop by
      // the adaptive-dwell extension. Only a genuinely deep runaway
      // (e < −DEEP_AHEAD_ENTER_M, its own hysteresis band) escalates to the
      // walking-pace CRAWL_V_MS backstop — without it a reality slower than
      // the soft-yield floor could keep widening the error unboundedly.
      if (sim.deepCrawl) {
        if (e > -DEEP_AHEAD_EXIT_M) sim.deepCrawl = false;
      } else if (e < -DEEP_AHEAD_ENTER_M) {
        sim.deepCrawl = true;
      }
      if (sim.deepCrawl) {
        vTarget = Math.min(vAllowed, CRAWL_V_MS);
      } else {
        const cruiseProduct =
          Math.min(cruiseCapAt(sim.profile, sim.geometry, sim.sM), V_CRUISE_REF_MS) *
          sim.paceBias *
          todPaceFactor(nowMs);
        vTarget = Math.min(
          vAllowed,
          Math.max(AHEAD_SLOW_MIN_V_MS, AHEAD_SLOW_FACTOR * cruiseProduct),
        );
      }
    } else {
      const maxFactor = e > BOLD_CATCHUP_ERR_M ? CATCHUP_MAX_FACTOR : GENTLE_MAX_FACTOR;
      const factor = Math.min(maxFactor, Math.max(MIN_PACE_FACTOR, 1 + e / PACE_GAIN_M));
      // Departure burst (motion profile): a bounded, decaying boost right out
      // of a dwell — set only for adaptive (main smooth) sims on release.
      const burst = sim.sM < sim.burstUntilM ? DEPART_BURST_FACTOR : 1;
      // Pace scaling applies to the cruise REFERENCE only; the braking envelope
      // is a hard limit — a late tram may hold cruise speed but never overrun a
      // stop. The reference is the zone/curve cap bounded by V_CRUISE_REF_MS
      // (42 km/h — real p90 pace; the 50 km/h V_MAX_MS stays the envelope/hard
      // cap, calibration round 1 R3), so catch-up regimes (factor ≤ 1.4) can
      // still exceed the reference up to the envelope. The learned per-tram
      // paceBias scales the target too, so a tram that really runs at 70% of
      // reference pace cruises at ~70% between fixes instead of sprinting to
      // the cap and then crawling. The time-of-day pace factor (hour-blended
      // TOD_PACE_TABLE, neutral until calibrated) composes on top: paceBias
      // then only learns the per-vehicle RESIDUAL.
      vTarget = Math.min(
        vAllowed,
        Math.min(cruiseCapAt(sim.profile, sim.geometry, sim.sM), V_CRUISE_REF_MS) *
          factor *
          burst *
          sim.paceBias *
          todPaceFactor(nowMs),
      );
    }
  }

  // Stuck-hold (all sims): repeated same-position fixes pin the tram at the
  // fix — brake to a stand AT it (braking-envelope approach when still short
  // of it) and hold until a moving fix clears stuckAtM. Never reverses.
  if (sim.stuckAtM !== null) {
    const dHold = sim.stuckAtM - sim.sM;
    vTarget = Math.min(vTarget, dHold > 0 ? Math.sqrt(2 * A_BRK * dHold) : 0);
  }

  // Junction yield (all sims): TramEngine flagged a crossing-path conflict
  // ahead — brake on the envelope toward the hold point just short of the
  // conflict zone and stand until the engine clears the hold (the crossing
  // tram has passed). Speed-only: sM is never rewritten, no teleports.
  if (sim.yieldHoldM !== null) {
    const dHold = sim.yieldHoldM - sim.sM;
    vTarget = Math.min(vTarget, dHold > 0 ? Math.sqrt(2 * A_BRK * dHold) : 0);
  }

  // Modest roll-through pace while inside a just-skipped stop's zone (still
  // clamped by the envelope via the min above — vTarget only ever decreases).
  if (sim.sM < sim.skipRollUntilM) {
    vTarget = Math.min(vTarget, DWELL_SKIP_ROLL_V_MS);
  }

  // Acceleration clamp.
  const a = Math.min(A_ACC, Math.max(-A_BRK, (vTarget - sim.vMs) / dt));
  sim.vMs = Math.max(0, sim.vMs + a * dt);

  const sNew = sim.sM + sim.vMs * dt;

  if (next && sNew >= next.distM - STOP_REACH_M) {
    // Reached the stop (never slide past an un-dwelled stop).
    sim.sM = Math.max(sim.sM, Math.min(sNew, next.distM));
    sim.vMs = 0;
    sim.dwelledStopSeqs.add(next.sequence);
    sim.minStopDist = next.distM + 0.01;
    sim.burstUntilM = 0;
    if (isTerminalStop(sim.geometry, next)) {
      sim.phase = 'terminal';
    } else {
      sim.phase = 'dwell';
      sim.dwellObsDistM = sim.obsDistM;
      let dwellMs = dwellDurationMs(next, nowMs, zonalDwellTreatmentFactor(sim, next));
      if (sim.adaptiveDwell && e > 0) {
        // Behind reality: the real tram has already spent part of its dwell
        // here — trim proportionally, but never blink (≥ DWELL_MIN_S when
        // stopping at all). e > DWELL_SKIP_ERR_M normally skips above; this
        // floor also covers arrivals landing between the two thresholds.
        const shortenFactor = Math.max(0, 1 - e / DWELL_SHORTEN_GAIN_M);
        dwellMs = Math.max(DWELL_MIN_S * 1000, dwellMs * shortenFactor);
      }
      sim.dwellUntilMs = nowMs + dwellMs;
    }
    return;
  }

  sim.sM = Math.min(sNew, sim.geometry.totalM);
  if (sim.sM >= sim.geometry.totalM - 1e-6 && !next) {
    // Ran off the end with no stops left — hold as terminal.
    sim.phase = 'terminal';
    sim.vMs = 0;
  }
}
