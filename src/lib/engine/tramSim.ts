// Per-tram physics/state machine. Pure TS, deterministic, no timers — the
// caller (TramEngine) drives ticks. Distance-along-shape `sM` is monotonically
// non-decreasing except on an explicit >500 m schedule teleport.

import type { RouteGeometry, RouteStop, TramSnapshot } from '@/lib/types';
import { A_ACC, A_BRK, cruiseCapAt, vAllowedAt, type SpeedProfile } from './speedProfile';

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
/** Max |stop.distM − s| for trusting an at_stop feed state when seeding a dwell, m. */
const AT_STOP_MATCH_M = 50;

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
  /** Stops with distM below this are never treated as 0-limits. */
  minStopDist: number;
  /** ms timestamp of the last hard teleport (renderer may dip opacity), 0 if never. */
  lastTeleportMs: number;
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
  const advance = Math.max(
    0,
    evalScheduleAnchor(sim.lastAnchor, nowMs) - evalScheduleAnchor(sim.lastAnchor, sim.obsAtMs),
  );
  return clampS(sim.geometry, sim.obsDistM + advance);
}

/**
 * Pace-controller target position: observation-primary blend of the projected
 * AVL observation with the timetable anchor (low-gain reference).
 */
export function targetDistAt(sim: TramSim, nowMs: number): number {
  const sObs = observedDistAt(sim, nowMs);
  const sSched = evalScheduleAnchor(sim.lastAnchor, nowMs);
  return OBS_BLEND_WEIGHT * sObs + (1 - OBS_BLEND_WEIGHT) * sSched;
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

/** Dwell duration for a stop: feed value, else 18 s ± deterministic 0–8 s jitter. */
export function dwellDurationMs(stop: RouteStop): number {
  if (stop.dwellSeconds > 0) return stop.dwellSeconds * 1000;
  const jitter = (hashString(stop.stopId) % 17) - 8; // deterministic, in [-8, 8]
  return (DEFAULT_DWELL_S + jitter) * 1000;
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
    sim.dwellUntilMs = nowMs + dwellDurationMs(current);
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

/**
 * Create a sim from a live snapshot. Initial s = the reported shape distance
 * projected forward by the elapsed time since observation at schedule pace.
 */
export function createSim(
  geometry: RouteGeometry,
  profile: SpeedProfile,
  snapshot: TramSnapshot,
  nowMs: number,
): TramSim {
  const anchor = buildScheduleAnchor(geometry.stops, snapshot.delaySeconds);
  const schedAdvance = Math.max(
    0,
    evalScheduleAnchor(anchor, nowMs) - evalScheduleAnchor(anchor, snapshot.observedAtMs),
  );
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
    minStopDist: 0,
    lastTeleportMs: 0,
  };
  seedStopState(sim, nowMs);
  return sim;
}

/** Re-anchor a sim to a new distance (used when swapping geometry between trips). */
export function reanchorSim(sim: TramSim, sM: number, nowMs: number): void {
  sim.sM = clampS(sim.geometry, sM);
  sim.phase = 'cruise';
  sim.dwellUntilMs = 0;
  sim.dwelledStopSeqs.clear();
  seedStopState(sim, nowMs);
}

/**
 * Ingest a fresh snapshot for the same trip: rebuild the schedule anchor with
 * the new delay and re-anchor the observation (shapeDistM @ observedAtMs) so
 * every poll reconciles the sim with reality. Convergence happens via the pace
 * controller — no position jumps — unless the projected OBSERVATION disagrees
 * with the sim by more than 500 m, which hard-teleports to the observation.
 */
export function applySnapshot(sim: TramSim, snapshot: TramSnapshot, nowMs: number): void {
  sim.snapshot = snapshot;
  sim.lastAnchor = buildScheduleAnchor(sim.geometry.stops, snapshot.delaySeconds);
  sim.obsDistM = clampS(sim.geometry, snapshot.shapeDistM);
  sim.obsAtMs = snapshot.observedAtMs;
  const sObs = observedDistAt(sim, nowMs);
  if (Math.abs(sObs - sim.sM) > TELEPORT_THRESHOLD_M) {
    sim.sM = sObs;
    sim.vMs = 0;
    sim.phase = 'cruise';
    sim.dwellUntilMs = 0;
    sim.dwelledStopSeqs.clear();
    seedStopState(sim, nowMs);
    sim.lastTeleportMs = nowMs;
  }
}

// ── physics tick ─────────────────────────────────────────────────────────────

/**
 * Advance the sim by dtS seconds. Pace controller:
 *   e = target(now) − s;  vTarget = min(vAllowed, vCruise · clamp(1 + e/120, 0.55, 1.65))
 * where target(now) is the observation-primary blend (targetDistAt) and
 * vCruise is the zone/curve cruise cap WITHOUT the braking envelope — catch-up
 * scaling can never defeat the envelope (vTarget ≤ vAllowed always).
 * Acceleration is clamped to [−1.2, +1.0] m/s². s never decreases.
 */
export function tick(sim: TramSim, nowMs: number, dtS: number): void {
  const dt = Math.min(Math.max(dtS, 0), MAX_TICK_DT_S);

  if (sim.phase === 'terminal') {
    sim.vMs = 0;
    return;
  }
  if (sim.phase === 'dwell') {
    sim.vMs = 0;
    if (nowMs >= sim.dwellUntilMs) sim.phase = 'cruise';
    return;
  }
  if (dt <= 0) return;

  // Pace controller: observation-primary target, timetable as low-gain reference.
  const e = targetDistAt(sim, nowMs) - sim.sM;
  const factor = Math.min(1.65, Math.max(0.55, 1 + e / 120));
  const vAllowed = vAllowedAt(sim.profile, sim.geometry, sim.sM, sim.minStopDist);
  // Pace scaling applies to the cruise cap only; the braking envelope is a
  // hard limit — a late tram may hold cruise speed but never overrun a stop.
  const vTarget = Math.min(vAllowed, cruiseCapAt(sim.profile, sim.geometry, sim.sM) * factor);

  // Acceleration clamp.
  const a = Math.min(A_ACC, Math.max(-A_BRK, (vTarget - sim.vMs) / dt));
  sim.vMs = Math.max(0, sim.vMs + a * dt);

  const sNew = sim.sM + sim.vMs * dt;

  const next = nextUndwelledStop(sim);
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
      sim.dwellUntilMs = nowMs + dwellDurationMs(next);
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
