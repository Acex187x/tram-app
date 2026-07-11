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
/** Sim this far AHEAD of the target (e < −40) → enter the hard-brake crawl. */
export const HARD_BRAKE_ENTER_M = 40;
/** The crawl regime exits once the error recovers above −12 m. */
export const HARD_BRAKE_EXIT_M = 12;
/** Crawl speed while waiting for reality to catch back up, m/s. */
export const CRAWL_V_MS = 1.0;
/** Error beyond which the bold catch-up factor cap applies, meters. */
export const BOLD_CATCHUP_ERR_M = 40;
/** Pace factor cap in the bold catch-up regime (e > BOLD_CATCHUP_ERR_M). */
export const CATCHUP_MAX_FACTOR = 1.5;
/** Pace factor cap in the gentle proportional band (|e| ≤ 40). */
export const GENTLE_MAX_FACTOR = 1.35;
/** Pace factor floor (gentle band; the crawl regime undercuts it). */
export const MIN_PACE_FACTOR = 0.55;
/** Proportional gain divisor: factor = 1 + e / PACE_GAIN_M. */
export const PACE_GAIN_M = 120;
/** Max |stop.distM − s| for trusting an at_stop feed state when seeding a dwell, m. */
const AT_STOP_MATCH_M = 50;

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
   * Hard-brake regime latch: the sim overran the target by more than
   * HARD_BRAKE_ENTER_M and crawls (≤ CRAWL_V_MS) until the error recovers
   * above −HARD_BRAKE_EXIT_M. Hysteresis avoids brake/sprint oscillation.
   */
  crawling: boolean;
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
 * The latest AVL observation projected forward from its timestamp to nowMs at
 * schedule pace (never backwards), clamped to the geometry. This — not the
 * timetable — is the primary anchor for a live sim.
 */
export function observedDistAt(sim: TramSim, nowMs: number): number {
  const advance = Math.max(0, evalScheduleAnchor(sim.lastAnchor, nowMs) - sim.obsSchedDistM);
  return clampS(sim.geometry, sim.obsDistM + advance);
}

/**
 * Pace-controller target position: observation-primary blend of the projected
 * AVL observation with the timetable anchor (low-gain reference), minus the
 * systematic TRAIL_M bias — the sim aims slightly BEHIND projected reality so
 * it hurries less and never runs ahead of it under normal tracking.
 */
export function targetDistAt(sim: TramSim, nowMs: number): number {
  const sSched = evalScheduleAnchor(sim.lastAnchor, nowMs);
  const sObs = clampS(sim.geometry, sim.obsDistM + Math.max(0, sSched - sim.obsSchedDistM));
  return Math.max(0, OBS_BLEND_WEIGHT * sObs + (1 - OBS_BLEND_WEIGHT) * sSched - TRAIL_M);
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
 * time-of-day scaled), else the 18 s ± deterministic 0–8 s jitter default,
 * multiplied by todDwellFactor(nowMs) when a wall clock is provided (peak
 * boarding takes longer). Callers without a time context omit nowMs and get
 * the unscaled default.
 */
export function dwellDurationMs(stop: RouteStop, nowMs?: number): number {
  if (stop.dwellSeconds > 0) return stop.dwellSeconds * 1000;
  const jitter = (hashString(stop.stopId) % 17) - 8; // deterministic, in [-8, 8]
  const baseMs = (DEFAULT_DWELL_S + jitter) * 1000;
  return nowMs === undefined ? baseMs : baseMs * todDwellFactor(nowMs);
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
    // When at_stop, the feed's "last stop" is the stop the tram stands AT —
    // it must stay unmarked so the dwell below can happen.
    const seqBehind = hasSeq && (atStop ? stop.sequence < lastSeq : stop.sequence <= lastSeq);
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
  const departMs = current.departureMs + snap.delaySeconds * 1000;
  if (departMs > nowMs) {
    sim.phase = 'dwell';
    sim.dwellUntilMs = departMs;
  } else if (atStop) {
    sim.phase = 'dwell';
    sim.dwellUntilMs = nowMs + dwellDurationMs(current, nowMs);
  }
  // else: scheduled departure already passed and the feed doesn't report
  // at_stop — the dwell is considered served; cruise on.
}

/** First stop not yet dwelled at (stops are ordered by distance along shape). */
export function nextUndwelledStop(sim: TramSim): RouteStop | null {
  for (const stop of sim.geometry.stops) {
    if (stop.distM < sim.minStopDist) continue;
    if (!sim.dwelledStopSeqs.has(stop.sequence)) return stop;
  }
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
  const sim: TramSim = {
    geometry,
    profile,
    snapshot,
    sM: clampS(geometry, snapshot.shapeDistM + schedAdvance),
    vMs: 0,
    phase: 'cruise',
    dwellUntilMs: 0,
    dwelledStopSeqs: new Set<number>(),
    lastAnchor: anchor,
    obsDistM: clampS(geometry, snapshot.shapeDistM),
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
    adaptiveDwell: opts.adaptiveDwell === true,
    skipRollUntilM: 0,
  };
  seedStopState(sim, nowMs);
  return sim;
}

/** Re-anchor a sim to a new distance (used when swapping geometry between trips). */
export function reanchorSim(sim: TramSim, sM: number, nowMs: number): void {
  sim.sM = clampS(sim.geometry, sM);
  sim.phase = 'cruise';
  sim.dwellUntilMs = 0;
  sim.crawling = false;
  sim.skipRollUntilM = 0;
  sim.dwelledStopSeqs.clear();
  seedStopState(sim, nowMs);
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
      dwellS += dwellDurationMs(stop, snapshot.observedAtMs) / 1000;
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
  sim.skipRollUntilM = 0;
  sim.dwelledStopSeqs.clear();
  seedStopState(sim, nowMs);
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
    return;
  }
  updatePaceBias(sim, prevObsDistM, prevObsAtMs, snapshot);
  const freshFix = snapshot.observedAtMs > prevObsAtMs || sim.obsDistM !== prevObsDistM;
  if (sim.phase === 'terminal' && freshFix && sim.sM - sObs > TERMINAL_UNLATCH_BEHIND_M) {
    snapTo(sim, sObs, nowMs);
  }
}

// ── physics tick ─────────────────────────────────────────────────────────────

/**
 * Advance the sim by dtS seconds. Asymmetric pace controller around
 * e = target(now) − s (target = observation-primary blend − TRAIL_M):
 *  - e < −HARD_BRAKE_ENTER_M (sim ran ahead): hard-brake crawl regime —
 *    vTarget ≤ CRAWL_V_MS until e recovers above −HARD_BRAKE_EXIT_M
 *    (hysteresis latch on sim.crawling). The sim NEVER moves backwards.
 *  - e > BOLD_CATCHUP_ERR_M (behind): bold catch-up, pace factor up to 1.5.
 *  - between: gentle proportional control, factor clamp(1 + e/120, 0.55, 1.35).
 * The cruise target is additionally scaled by the learned per-tram paceBias.
 * All regimes stay clamped by the braking envelope (vTarget ≤ vAllowed) —
 * catch-up can never defeat curve/stop limits. Acceleration is clamped to
 * [−1.2, +1.0] m/s². s never decreases.
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
      // Adaptive extension: while the sim is still AHEAD of reality, keep
      // holding at the platform — it reads as slow boarding, not error
      // correction. Re-evaluated every tick so a fresh fix releases it early;
      // hard-capped at base dwell + DWELL_MAX_EXTEND_S.
      const holdForReality =
        sim.adaptiveDwell &&
        nowMs < sim.dwellUntilMs + DWELL_MAX_EXTEND_S * 1000 &&
        targetDistAt(sim, nowMs) - sim.sM <= -DWELL_EXTEND_RELEASE_M;
      if (!holdForReality) sim.phase = 'cruise';
    }
    return;
  }
  if (dt <= 0) return;

  // Pace controller: observation-primary target, timetable as low-gain reference.
  const e = targetDistAt(sim, nowMs) - sim.sM;

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

  // Hard-brake latch with hysteresis (enter at −40 m, exit at −12 m).
  if (sim.crawling) {
    if (e > -HARD_BRAKE_EXIT_M) sim.crawling = false;
  } else if (e < -HARD_BRAKE_ENTER_M) {
    sim.crawling = true;
  }

  let vTarget: number;
  if (sim.crawling) {
    // Ran ahead of reality: crawl until the projected observation catches up.
    vTarget = Math.min(vAllowed, CRAWL_V_MS);
  } else {
    const maxFactor = e > BOLD_CATCHUP_ERR_M ? CATCHUP_MAX_FACTOR : GENTLE_MAX_FACTOR;
    const factor = Math.min(maxFactor, Math.max(MIN_PACE_FACTOR, 1 + e / PACE_GAIN_M));
    // Pace scaling applies to the cruise REFERENCE only; the braking envelope
    // is a hard limit — a late tram may hold cruise speed but never overrun a
    // stop. The reference is the zone/curve cap bounded by V_CRUISE_REF_MS
    // (42 km/h — real p90 pace; the 50 km/h V_MAX_MS stays the envelope/hard
    // cap, calibration round 1 R3), so catch-up regimes (factor ≤ 1.5) can
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
        sim.paceBias *
        todPaceFactor(nowMs),
    );
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
    if (isTerminalStop(sim.geometry, next)) {
      sim.phase = 'terminal';
    } else {
      sim.phase = 'dwell';
      let dwellMs = dwellDurationMs(next, nowMs);
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
