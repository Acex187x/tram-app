// Journey guidance — the pure state machine behind "Start" on a planned
// itinerary. No React, no IO, no timers: everything takes (itinerary, live
// states, geometries, nowMs), so the ~1 Hz driver on the map and the planner
// sheet's stepper derive identical state, and it is unit-testable.
//
// Model: a guidance session walks an itinerary leg by leg through phases
//   walk  — heading to the first boarding stop (duration = access-walk time)
//   wait  — at the leg's boarding stop; a live tram is matched ("bound") via
//           the same next-catchable-tram logic the itinerary cards use
//   ride  — aboard the bound tram; progress tracks its simulated position
//   arrived — past the last leg's exit stop
//
// Transitions are driven by the BOUND tram's along-shape position on its own
// trip geometry: it pulling away from the boarding stop ⇒ assume boarded
// (wait → ride); it reaching the exit stop ⇒ next leg's wait, or arrived.

import { computeItineraryTiming, type LegTiming } from '@/lib/arrivals';
import type { PlannerItinerary, RouteGeometry, TramPublicState } from '@/lib/types';
import { normalizeName } from './network';

export type GuidancePhase = 'walk' | 'wait' | 'ride' | 'arrived';

export interface GuidanceProgress {
  /** Index into itinerary.legs of the leg being walked-to/waited-for/ridden. */
  legIndex: number;
  phase: GuidancePhase;
  /** Live tram bound to the current leg (rebound while waiting, pinned while riding). */
  tramKey: string | null;
}

/** Tram counted as DEPARTED its boarding stop beyond this along-shape slack (m). */
export const BOARD_DEPART_SLACK_M = 30;
/** Tram counted as ARRIVED at the exit stop within this along-shape slack (m). */
export const EXIT_ARRIVE_SLACK_M = 25;
/** Stops closer than this count as already passed (engine dwell tolerance). */
const PASSED_SLACK_M = 2;

/** Fresh progress for a new session: walk first when there is a walk to make. */
export function initialProgress(accessWalkS: number): GuidanceProgress {
  return { legIndex: 0, phase: accessWalkS > 0 ? 'walk' : 'wait', tramKey: null };
}

// ── Bound-tram position on a leg ─────────────────────────────────────────────

export interface LegTramPosition {
  /** Tram's simulated along-shape distance (m) on its own trip geometry. */
  simDistM: number;
  fromDistM: number;
  toDistM: number;
  /** Leg stops still ahead of the tram, exit stop included. */
  stopsRemaining: number;
  /** The next stop the tram reaches is the exit stop — "get off at the next stop". */
  nextIsExit: boolean;
  departedFrom: boolean;
  arrivedAtExit: boolean;
}

/**
 * Where a tram is relative to a leg (boarding stop `fromKey` → exit stop
 * `toKey`, normalized station keys) on ITS OWN trip geometry. Null when the
 * geometry doesn't visit from → to in order (diverted / different variant).
 */
export function legTramPosition(
  geo: RouteGeometry,
  simDistM: number,
  fromKey: string,
  toKey: string,
): LegTramPosition | null {
  let fromIdx = -1;
  let toIdx = -1;
  for (let i = 0; i < geo.stops.length; i++) {
    const k = normalizeName(geo.stops[i].name);
    if (fromIdx < 0) {
      if (k === fromKey) fromIdx = i;
    } else if (k === toKey) {
      toIdx = i;
      break;
    }
  }
  if (fromIdx < 0 || toIdx < 0) return null;

  const fromDistM = geo.stops[fromIdx].distM;
  const toDistM = geo.stops[toIdx].distM;
  let stopsRemaining = 0;
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    if (geo.stops[i].distM > simDistM + PASSED_SLACK_M) stopsRemaining += 1;
  }
  return {
    simDistM,
    fromDistM,
    toDistM,
    stopsRemaining,
    nextIsExit: stopsRemaining === 1,
    departedFrom: simDistM > fromDistM + BOARD_DEPART_SLACK_M,
    arrivedAtExit: simDistM >= toDistM - EXIT_ARRIVE_SLACK_M,
  };
}

// ── The 1 Hz tick ────────────────────────────────────────────────────────────

export interface GuidanceTick {
  /** Next progress — the SAME reference when nothing changed (cheap store commits). */
  progress: GuidanceProgress;
  /** Bound tram's position on the current leg (ride tracking), when trackable. */
  pos: LegTramPosition | null;
  /** Next catchable tram's timing while walking/waiting (what to board & when). */
  wait: LegTiming | null;
}

/**
 * Advance a guidance session against the live fleet. Pure — call it on every
 * ~1 Hz UI tick and commit `progress` back only when the reference changed.
 * `walkUntilMs` = session start + access walk (the walk phase's natural end).
 */
export function tickGuidance(
  itinerary: PlannerItinerary,
  progress: GuidanceProgress,
  states: TramPublicState[],
  geometries: RouteGeometry[],
  nowMs: number,
  walkUntilMs: number,
): GuidanceTick {
  const legs = itinerary.legs;
  const leg = legs[progress.legIndex];
  if (!leg || progress.phase === 'arrived') return { progress, pos: null, wait: null };

  const fromKey = normalizeName(leg.fromStopName);
  const toKey = normalizeName(leg.toStopName);

  const posFor = (key: string | null): LegTramPosition | null => {
    if (!key) return null;
    const state = states.find((s) => s.key === key);
    if (!state || state.snapshot.line !== leg.line || state.snapshot.isCanceled) return null;
    const geo = geometries.find((g) => g.tripId === state.snapshot.tripId);
    if (!geo) return null;
    return legTramPosition(geo, state.simDistM, fromKey, toKey);
  };

  if (progress.phase === 'ride') {
    const pos = posFor(progress.tramKey);
    if (pos?.arrivedAtExit) {
      const next: GuidanceProgress =
        progress.legIndex + 1 < legs.length
          ? { legIndex: progress.legIndex + 1, phase: 'wait', tramKey: null }
          : { legIndex: progress.legIndex, phase: 'arrived', tramKey: null };
      return { progress: next, pos: null, wait: null };
    }
    // Tram lost from the feed → keep riding on schedule knowledge (pos null).
    return { progress, pos, wait: null };
  }

  // walk / wait. The boarding transition watches the PREVIOUSLY bound tram —
  // the fresh candidate search excludes trams already past the boarding stop,
  // so the departure signal only exists on the old binding.
  const boundPos = posFor(progress.tramKey);
  if (progress.phase === 'wait' && boundPos?.departedFrom) {
    return { progress: { ...progress, phase: 'ride' }, pos: boundPos, wait: null };
  }

  const wait = computeItineraryTiming([leg], states, geometries, nowMs).legs[0] ?? null;
  const candidateKey = wait?.tram?.key ?? null;
  const phase: GuidancePhase =
    progress.phase === 'walk' && nowMs >= walkUntilMs ? 'wait' : progress.phase;
  // Bind the fresh candidate; keep the old binding only while still trackable.
  const tramKey = candidateKey ?? (boundPos ? progress.tramKey : null);

  const next =
    phase !== progress.phase || tramKey !== progress.tramKey
      ? { legIndex: progress.legIndex, phase, tramKey }
      : progress;
  return { progress: next, pos: posFor(tramKey), wait };
}

// ── Step list (stepper + banner counter) ─────────────────────────────────────

export type GuidanceStep =
  | { kind: 'walk'; legIndex: 0; stopName: string }
  | { kind: 'board'; legIndex: number; line: string; stopName: string; transfer: boolean }
  | { kind: 'ride'; legIndex: number; line: string; stopCount: number; exitName: string }
  | { kind: 'arrive'; legIndex: number; stopName: string };

/** Flatten an itinerary into displayable guidance steps. */
export function buildSteps(itinerary: PlannerItinerary, hasAccessWalk: boolean): GuidanceStep[] {
  const legs = itinerary.legs;
  const steps: GuidanceStep[] = [];
  if (legs.length === 0) return steps;
  if (hasAccessWalk) steps.push({ kind: 'walk', legIndex: 0, stopName: legs[0].fromStopName });
  legs.forEach((leg, i) => {
    steps.push({
      kind: 'board',
      legIndex: i,
      line: leg.line,
      stopName: leg.fromStopName,
      transfer: i > 0,
    });
    steps.push({
      kind: 'ride',
      legIndex: i,
      line: leg.line,
      stopCount: leg.stopCount,
      exitName: leg.toStopName,
    });
  });
  steps.push({
    kind: 'arrive',
    legIndex: legs.length - 1,
    stopName: legs[legs.length - 1].toStopName,
  });
  return steps;
}

/** Index of the step `progress` is currently on. */
export function activeStepIndex(steps: GuidanceStep[], progress: GuidanceProgress): number {
  if (progress.phase === 'arrived') return steps.length - 1;
  const kind = progress.phase === 'walk' ? 'walk' : progress.phase === 'wait' ? 'board' : 'ride';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === kind && (s.kind === 'walk' || s.legIndex === progress.legIndex)) return i;
  }
  return 0;
}
