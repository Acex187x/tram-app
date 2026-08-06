// SMOOTHER sim (engine v2, docs/decisions/engine-v2.md §2.3): the cinematic
// tracker of the predictor — layer 2 of the fix → predictor → smoother stack,
// and the layer "smooth" mode renders. A thin follower loop: its ONLY
// reference is the predictor (sPred, vPred, the predictor's holds); there is
// no schedule anywhere. Pure TS, deterministic, no timers, allocation-free
// tick (performance invariant #8).
//
// Motion contract: `sM` is monotonically non-decreasing except two sanctioned
// fade-stamped corrections — the gap-aware teleport snap and the terminal
// un-latch propagation (the engine invokes the latter). Hard clamps always:
// vTarget ≤ vAllowedAt, accel ∈ [−A_BRK, +A_ACC], on-shape.
//
// Regime table (r2, verbatim from the design):
//   hold-follow  predictor standing (dwell/stuck/pin/terminal): the reference
//                becomes the POINT sPredHold, TRAIL suppressed — behind rolls
//                onto the platform / jam tail (captured by the stop-reach
//                clamp, joining the dwell → doors open); ahead brakes to a
//                stand (no 3 m/s floor — reality itself is standing).
//   track        vPred > 0, |err| ≤ 40:  vPred · clamp(1 + err/120, 0.7, 1.35)
//   catch-up     err > 40: ramps continuously from 1.35·vPred at 40 to the
//                ceiling at ~120; ceiling = min(vAllowed, cruiseCap,
//                CATCHUP_HEADROOM · paceBias · V_CRUISE_REF) — anchored on
//                observed free-running pace, never the legal track cap.
//   yield        vPred > 0, err < −40 (exit −12, hysteresis): max(3, 0.5·vPred)
//   teleport     |err| > gap-aware threshold: snap + fade (lastTeleportMs)

import type { RouteGeometry } from '@/lib/types';
import {
  A_ACC,
  A_BRK,
  brakeTowards,
  cruiseCapAt,
  DEFAULT_LOOKAHEAD_M,
  V_CRUISE_REF_MS,
  vAllowedAt,
  type SpeedProfile,
} from './speedProfile';
import {
  holdPointOf,
  isTerminalStop,
  MAX_TICK_DT_S,
  minStopDistOf,
  predictorPastStop,
  STOP_BEHIND_EPS_M,
  STOP_REACH_M,
  teleportThresholdM,
  type SimPhase,
  type TramSim,
} from './tramSim';

/**
 * Systematic trail, meters: while the predictor is MOVING the smoother aims
 * TRAIL_M behind it — ahead-errors are jarring (§5 of the v1 record), behind
 * reads as natural lag. SUPPRESSED whenever the predictor holds (the platform
 * capture must land ON the platform, not 10 m short). Whether 10 → 0 entirely
 * is arbitrated by the replay gate, not inherited on inertia.
 */
export const TRAIL_M = 10;
/** |err| band of the proportional track regime, m (catch-up/yield beyond). */
export const TRACK_BAND_M = 40;
/** Yield hysteresis exit: the latch releases once err recovers above −this, m. */
export const YIELD_EXIT_M = 12;
/** Proportional gain divisor of the track regime: factor = 1 + err/this. */
export const PACE_GAIN_M = 120;
/** Track-regime factor clamp. */
export const TRACK_MIN_FACTOR = 0.7;
export const TRACK_MAX_FACTOR = 1.35;
/** err at which the catch-up ramp reaches its ceiling, m. */
export const CATCHUP_FULL_ERR_M = 120;
/**
 * Catch-up ceiling anchor: measured p90/p50 free-running ratio (~1.9). The
 * ceiling is CATCHUP_HEADROOM · paceBias · V_CRUISE_REF (∧ cruiseCap ∧
 * vAllowed) — observed free-running pace with sprint headroom, NOT the legal
 * 50 km/h cap (which would sprint the night centre at 2.6× anything real).
 */
export const CATCHUP_HEADROOM = 1.9;
/** Yield speed: this fraction of vPred, floored at YIELD_MIN_V_MS. */
export const YIELD_FACTOR = 0.5;
/** Yield floor, m/s — never pedestrian while reality moves (~11 km/h). */
export const YIELD_MIN_V_MS = 3.0;
/**
 * Doors-open ceiling on any one smoother dwell, s: past it the doors close
 * (phase leaves 'dwell') while the position holds via hold-follow — an
 * unbounded doors-open wait reads as a broken app (75 s is the v1-validated
 * bound; 90–250 s fix gaps make multi-minute predictor deficits routine).
 */
export const DWELL_MAX_EXTEND_S = 75;
/** Minimum visible dwell when stopping at all, s — no 1-s door blinks. */
export const DWELL_MIN_S = 4;
/** Behind-error above which an already-served stop is skipped entirely, m. */
export const DWELL_SKIP_ERR_M = 60;
/** Speed cap while rolling through a skipped stop's zone, m/s. */
export const DWELL_SKIP_ROLL_V_MS = 4;
/**
 * Half-width of a skipped stop's roll zone, m: v²/(2·A_BRK) — the skip fires
 * only once the envelope has already brought the smoother to ≤ the roll cap,
 * so releasing the stop's 0-limit never violates the envelope.
 */
export const DWELL_SKIP_ZONE_M =
  (DWELL_SKIP_ROLL_V_MS * DWELL_SKIP_ROLL_V_MS) / (2 * A_BRK);

export type SmootherRegime = 'hold-follow' | 'track' | 'catchup' | 'yield';

export interface SmootherSim {
  /** Vehicle key (fleet-generic constraint passes). */
  key: string;
  /** SHARED with the predictor — trip changes swap both atomically (§2.2). */
  geometry: RouteGeometry;
  profile: SpeedProfile;
  /** Rendered distance along shape, m. Monotonic except sanctioned fades. */
  sM: number;
  /** Rendered speed, m/s. Always ≥ 0. */
  vMs: number;
  phase: SimPhase;
  /** Earliest wall clock this dwell may release (min-blink / shortened), ms. */
  dwellUntilMs: number;
  /** Stop index (into geometry.stops) of the current dwell, or null. */
  dwellStopIdx: number | null;
  /** Wall clock the current dwell began, ms (doors-close cap anchor). */
  dwellStartMs: number;
  /** Dwell-sync: waiting for the predictor to depart this same stop (§2.3). */
  dwellSynced: boolean;
  /** THE stops-ahead representation: first stop not yet served (prefix). */
  nextStopIdx: number;
  /** End of the active skipped-stop roll zone, m along shape (0 = none). */
  skipRollUntilM: number;
  /** Yield-regime hysteresis latch (enter err < −40, exit err > −12). */
  yielding: boolean;
  /** Junction-yield hold point (engine-written), m along shape, or null. */
  yieldHoldM: number | null;
  /** Physical length incl. any coupled trailer, m (queue spacing). */
  lengthM: number;
  /** ms of the last sanctioned discontinuity (renderer fades); 0 if never. */
  lastTeleportMs: number;
  /** Regime chosen by the last tick (debug overlay). */
  regime: SmootherRegime;
}

/** First-unserved-stop prefix at a position (geometry order = serve order). */
function stopIdxAt(geometry: RouteGeometry, sM: number): number {
  const stops = geometry.stops;
  let idx = 0;
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].distM < sM - STOP_BEHIND_EPS_M) idx = i + 1;
  }
  return idx;
}

/** The catch-up ceiling at the smoother's position (see CATCHUP_HEADROOM). */
function catchupCeiling(sm: SmootherSim, pred: TramSim): number {
  return Math.min(
    cruiseCapAt(sm.profile, sm.geometry, sm.sM),
    CATCHUP_HEADROOM * pred.paceBias * V_CRUISE_REF_MS,
  );
}

/**
 * Place the smoother at `targetM` and rebuild its local state from the
 * predictor: served prefix from the position, stops already served by REALITY
 * at the landing point stay closed (no spurious re-dwell), and landing on the
 * predictor's own platform joins its dwell (doors open). The one placement
 * core behind create / trip-reanchor / teleport / un-latch propagation.
 */
function placeSmoother(
  sm: SmootherSim,
  pred: TramSim,
  targetM: number,
  nowMs: number,
  opts: { fade?: boolean; keepSpeed?: boolean } = {},
): void {
  const geo = sm.geometry;
  const stops = geo.stops;
  sm.sM = Math.min(Math.max(targetM, 0), geo.totalM);
  sm.phase = 'cruise';
  sm.dwellUntilMs = 0;
  sm.dwellStopIdx = null;
  sm.dwellStartMs = 0;
  sm.dwellSynced = false;
  sm.skipRollUntilM = 0;
  sm.yielding = false;
  sm.yieldHoldM = null;
  let idx = stopIdxAt(geo, sm.sM);
  // Stops AT the landing point that reality has already served stay served —
  // a fresh spawn must not blink its doors at a platform the tram just left.
  while (
    idx < stops.length &&
    stops[idx].distM <= sm.sM + STOP_REACH_M &&
    predictorPastStop(pred, idx)
  ) {
    idx++;
  }
  sm.nextStopIdx = idx;

  // Landing on the predictor's platform/terminal joins its stand.
  if (pred.phase === 'terminal' && Math.abs(sm.sM - pred.sM) <= STOP_REACH_M) {
    sm.phase = 'terminal';
    sm.vMs = 0;
  } else if (
    pred.phase === 'dwell' &&
    pred.dwellStopIdx !== null &&
    Math.abs(stops[pred.dwellStopIdx].distM - sm.sM) <= STOP_REACH_M
  ) {
    sm.sM = Math.min(Math.max(stops[pred.dwellStopIdx].distM, 0), geo.totalM);
    sm.phase = 'dwell';
    sm.dwellStopIdx = pred.dwellStopIdx;
    sm.dwellStartMs = nowMs;
    sm.dwellUntilMs = nowMs + DWELL_MIN_S * 1000;
    sm.dwellSynced = true;
    sm.nextStopIdx = Math.max(sm.nextStopIdx, pred.dwellStopIdx + 1);
    sm.vMs = 0;
  } else if (!opts.keepSpeed) {
    // Seed the speed of a placed-mid-segment smoother: the predictor's own
    // motion, envelope-bounded (never "accelerates out of nowhere").
    sm.vMs = Math.min(
      vAllowedAt(sm.profile, geo, sm.sM, minStopDistOf(sm), DEFAULT_LOOKAHEAD_M, A_BRK, sm.nextStopIdx),
      Math.max(pred.vMs, 0),
    );
  }
  if (opts.fade) sm.lastTeleportMs = nowMs;
}

/** Create the smoother for a (possibly brand-new) predictor. */
export function createSmoother(pred: TramSim, nowMs: number): SmootherSim {
  const sm: SmootherSim = {
    key: pred.key,
    geometry: pred.geometry,
    profile: pred.profile,
    sM: 0,
    vMs: 0,
    phase: 'cruise',
    dwellUntilMs: 0,
    dwellStopIdx: null,
    dwellStartMs: 0,
    dwellSynced: false,
    nextStopIdx: 0,
    skipRollUntilM: 0,
    yielding: false,
    yieldHoldM: null,
    lengthM: pred.lengthM,
    lastTeleportMs: 0,
    regime: 'track',
  };
  const hold = holdPointOf(pred);
  placeSmoother(sm, pred, hold ?? Math.max(0, pred.sM - TRAIL_M), nowMs);
  return sm;
}

/**
 * Atomic trip change (§2.2): the engine swapped BOTH layers' geometry in one
 * ingest. Re-anchor the smoother on the new shape at `sM` (its old world
 * point projected onto the new polyline), keeping momentum when it lands
 * cruising.
 */
export function reanchorSmoother(
  sm: SmootherSim,
  pred: TramSim,
  sM: number,
  nowMs: number,
): void {
  const vBefore = sm.vMs;
  sm.geometry = pred.geometry;
  sm.profile = pred.profile;
  placeSmoother(sm, pred, sM, nowMs);
  if (sm.phase === 'cruise') sm.vMs = vBefore;
}

/**
 * Sanctioned fade-teleport of the smoother onto the predictor — used by the
 * engine for the terminal un-latch propagation (§2.3: INDEPENDENT of the
 * gap-aware threshold — without it the smoother wedges at the wrong terminal,
 * the R2 +324 m class) and for trip changes whose re-projection failed.
 */
export function fadeTeleportSmoother(sm: SmootherSim, pred: TramSim, nowMs: number): void {
  sm.geometry = pred.geometry;
  sm.profile = pred.profile;
  const hold = holdPointOf(pred);
  placeSmoother(sm, pred, hold ?? Math.max(0, pred.sM - TRAIL_M), nowMs, { fade: true });
}

/**
 * Advance the smoother by dtS seconds against the predictor reference
 * `sPredRefM` (the predictor's position, linearly interpolated between batch
 * points in coarse cadence — §2.4). The regime table + stop rules of §2.3.
 */
export function tickSmoother(
  sm: SmootherSim,
  pred: TramSim,
  sPredRefM: number,
  nowMs: number,
  dtS: number,
): void {
  const dt = Math.min(Math.max(dtS, 0), MAX_TICK_DT_S);
  const geo = sm.geometry;
  const stops = geo.stops;

  if (sm.phase === 'terminal') {
    // Absorbing; the engine's un-latch propagation is the only escape.
    sm.vMs = 0;
    return;
  }

  if (sm.phase === 'dwell') {
    sm.vMs = 0;
    const k = sm.dwellStopIdx;
    if (sm.dwellSynced && k !== null) {
      if (nowMs - sm.dwellStartMs >= DWELL_MAX_EXTEND_S * 1000) {
        // Doors close after the cap; hold-follow keeps the position while the
        // predictor still stands at/behind this stop.
        sm.phase = 'cruise';
        sm.dwellStopIdx = null;
        sm.dwellSynced = false;
      } else if (predictorPastStop(pred, k) && nowMs >= sm.dwellUntilMs) {
        sm.phase = 'cruise'; // reality departed — follow it out
        sm.dwellStopIdx = null;
        sm.dwellSynced = false;
      }
    } else if (nowMs >= sm.dwellUntilMs) {
      sm.phase = 'cruise';
      sm.dwellStopIdx = null;
    }
    return;
  }
  if (dt <= 0) return;

  const hold = holdPointOf(pred);
  const trailM = hold === null ? TRAIL_M : 0;
  const err = sPredRefM - sm.sM - trailM;

  // Gap-aware teleport: beyond the honest-blind-travel threshold the layers
  // have truly desynced — snap onto the reference with a fade (sanctioned in
  // BOTH directions; the one non-monotonic move this function itself makes).
  if (Math.abs(err) > teleportThresholdM(pred.lastFixGapS)) {
    placeSmoother(sm, pred, sPredRefM - trailM, nowMs, { fade: true });
    return;
  }

  // Skip rule (§2.3 stops): badly behind at a stop REALITY already served and
  // left — roll through at a modest cap, doors stay closed. Decided only once
  // the envelope has the smoother at/below the roll cap (inside the zone), so
  // releasing the 0-limit never violates the envelope. Terminals never skip.
  let next = sm.nextStopIdx < stops.length ? stops[sm.nextStopIdx] : null;
  if (
    next &&
    err > DWELL_SKIP_ERR_M &&
    next.distM - sm.sM <= DWELL_SKIP_ZONE_M &&
    !isTerminalStop(geo, next) &&
    predictorPastStop(pred, sm.nextStopIdx)
  ) {
    sm.skipRollUntilM = next.distM + DWELL_SKIP_ZONE_M;
    sm.nextStopIdx += 1;
    next = sm.nextStopIdx < stops.length ? stops[sm.nextStopIdx] : null;
  }

  const vAllowed = vAllowedAt(
    sm.profile,
    geo,
    sm.sM,
    minStopDistOf(sm),
    DEFAULT_LOOKAHEAD_M,
    A_BRK,
    sm.nextStopIdx,
  );

  let vTarget: number;
  if (hold !== null) {
    // hold-follow: the reference is the POINT the predictor stands at.
    sm.regime = 'hold-follow';
    sm.yielding = false;
    const d = hold - sm.sM;
    // Behind: close onto the platform / jam tail — approach at the observed
    // free-running ceiling, braking onto the point. Ahead: stand (no floor —
    // reality itself is standing).
    vTarget = d > 0 ? Math.min(brakeTowards(d), catchupCeiling(sm, pred)) : 0;
  } else {
    const vPred = Math.max(0, pred.vMs);
    if (sm.yielding) {
      if (err > -YIELD_EXIT_M) sm.yielding = false;
    } else if (err < -TRACK_BAND_M) {
      sm.yielding = true;
    }
    if (sm.yielding) {
      sm.regime = 'yield';
      vTarget = Math.max(YIELD_MIN_V_MS, YIELD_FACTOR * vPred);
    } else if (err > TRACK_BAND_M) {
      // Continuous catch-up ramp: 1.35·vPred at err=40 → ceiling at err≈120.
      sm.regime = 'catchup';
      const base = TRACK_MAX_FACTOR * vPred;
      const ceil = catchupCeiling(sm, pred);
      const t = Math.min(1, (err - TRACK_BAND_M) / (CATCHUP_FULL_ERR_M - TRACK_BAND_M));
      vTarget = base + Math.max(0, ceil - base) * t;
    } else {
      sm.regime = 'track';
      const factor = Math.min(
        TRACK_MAX_FACTOR,
        Math.max(TRACK_MIN_FACTOR, 1 + err / PACE_GAIN_M),
      );
      vTarget = vPred * factor;
    }
  }

  vTarget = Math.min(vTarget, vAllowed);
  if (sm.yieldHoldM !== null) {
    vTarget = Math.min(vTarget, brakeTowards(sm.yieldHoldM - sm.sM));
  }
  if (sm.sM < sm.skipRollUntilM) {
    vTarget = Math.min(vTarget, DWELL_SKIP_ROLL_V_MS);
  }

  const a = Math.min(A_ACC, Math.max(-A_BRK, (vTarget - sm.vMs) / dt));
  sm.vMs = Math.max(0, sm.vMs + a * dt);

  const sNew = sm.sM + sm.vMs * dt;

  if (next && sNew >= next.distM - STOP_REACH_M) {
    // Reached the stop (never slide past an un-served stop) — §2.3 stop rules.
    sm.sM = Math.max(sm.sM, Math.min(sNew, next.distM));
    sm.vMs = 0;
    const k = sm.nextStopIdx;
    sm.nextStopIdx = k + 1;
    if (isTerminalStop(geo, next)) {
      sm.phase = 'terminal';
      return;
    }
    sm.phase = 'dwell';
    sm.dwellStopIdx = k;
    sm.dwellStartMs = nowMs;
    if (!predictorPastStop(pred, k)) {
      // Reality is still at (or short of) this stop: dwell-sync bound to THIS
      // stop index — release when the predictor departs it (doors-cap bounded).
      sm.dwellSynced = true;
      sm.dwellUntilMs = nowMs + DWELL_MIN_S * 1000;
    } else {
      // Reality already served and left: the validated shorten rule —
      // max(DWELL_MIN_S, predictor's remaining dwell here) = a brief stop.
      sm.dwellSynced = false;
      sm.dwellUntilMs = nowMs + DWELL_MIN_S * 1000;
    }
    return;
  }

  sm.sM = Math.min(sNew, geo.totalM);
  if (sm.sM >= geo.totalM - 1e-6 && !next) {
    sm.phase = 'terminal';
    sm.vMs = 0;
  }
}
