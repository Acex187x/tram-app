// Spotter mode — pure target-selection logic. No React, no IO: the
// SpotterController feeds it the 1 Hz states/geometries and applies the
// resulting follow/camera/haptic side effects, so everything here is
// unit-testable with synthetic fixtures.
//
// Selection: among all live trams that still have the spotted station AHEAD
// on their own trip (computeArrivals — soonest ETA first), pick the first.
// While a target is held the spotter keeps it through jitter, but every
// REEVAL_INTERVAL_MS it re-ranks the arrivals and PREEMPTS to a different tram
// that will now reach the platform at least PREEMPT_MARGIN_S sooner — near a
// terminal a just-departed car often becomes the true soonest arrival. The
// margin stops it flip-flopping between two trams with near-equal ETAs. The
// spotter still moves on unconditionally when the target DEPARTS (passed the
// platform by > DEPARTED_PAST_M of shape distance, rolled onto a new trip, or
// got canceled) or DISAPPEARS from the states list for longer than
// MISSING_TIMEOUT_MS.

import { computeArrivals, nextStationStop } from '@/lib/arrivals';
import type { RouteGeometry, TramPublicState } from '@/lib/types';

/** A target that passed the platform by more than this has departed (m). */
export const DEPARTED_PAST_M = 80;
/** A target missing from the feed for longer than this is treated as gone. */
export const MISSING_TIMEOUT_MS = 15_000;
/** How often a held target is re-ranked against the live arrivals list (ms). */
export const REEVAL_INTERVAL_MS = 3_000;
/** A different tram preempts the held one only if it arrives ≥ this much
 *  sooner — the hysteresis that stops churn between near-equal ETAs (s). */
export const PREEMPT_MARGIN_S = 20;

/** What the spotter remembers about its current target between 1 Hz steps. */
export interface SpotterTracking {
  targetKey: string;
  line: string;
  /** Trip the target was acquired on — a trip change means the visit is over. */
  tripId: string;
  /** Shape distance of the spotted platform on that trip (m). */
  stopDistM: number;
  /** Scheduled arrival at that platform (ms epoch) — the ETA base. */
  stopArrivalMs: number;
  /** Last wall-clock ms the target was present in the states list. */
  lastSeenMs: number;
  /** Last wall-clock ms the arrivals list was re-ranked for preemption. */
  lastReevalMs: number;
}

export type SpotterEvent =
  /** Nothing changed: still holding the target, or still waiting. */
  | 'none'
  /** First target found after having none. */
  | 'acquired'
  /** Current target departed/vanished → moved to the next arrival. */
  | 'switched'
  /** Current target departed/vanished and nobody else is inbound. */
  | 'lost';

/** Chip payload for the tram currently being spotted. */
export interface SpotterTargetInfo {
  tramKey: string;
  line: string;
  /** Seconds until it reaches the spotted stop, floored at 0 while dwelling. */
  etaS: number;
}

export interface SpotterStepResult {
  tracking: SpotterTracking | null;
  event: SpotterEvent;
  target: SpotterTargetInfo | null;
}

/**
 * One 1 Hz spotter step: validate the held target (keep / departed / missing)
 * and, when it is gone, acquire the next-arriving tram at the station.
 * `prev === null` means "waiting for the next tram".
 */
export function stepSpotter(
  prev: SpotterTracking | null,
  stationKey: string,
  states: TramPublicState[],
  geometries: RouteGeometry[],
  nowMs: number,
): SpotterStepResult {
  /** When switching away from a dropped target, don't re-pick it this step
   *  (a loop route can list the same station again further down the trip). */
  let excludeKey: string | null = null;

  if (prev) {
    const st = findState(states, prev.targetKey);
    if (!st) {
      if (nowMs - prev.lastSeenMs <= MISSING_TIMEOUT_MS) {
        // Brief feed dropout — hold the target (schedule-only ETA; the live
        // delay is unknown while the tram is missing).
        return {
          tracking: prev,
          event: 'none',
          target: {
            tramKey: prev.targetKey,
            line: prev.line,
            etaS: etaSeconds(prev.stopArrivalMs, 0, nowMs),
          },
        };
      }
      excludeKey = prev.targetKey; // gone for good — replace it
    } else if (
      !st.snapshot.isCanceled &&
      st.snapshot.tripId === prev.tripId &&
      st.simDistM <= prev.stopDistM + DEPARTED_PAST_M
    ) {
      // Still inbound / dwelling / just past within the window — keep it,
      // but periodically re-rank the arrivals and hand off to a genuinely
      // sooner tram (a just-departed car near a terminal), with a margin so
      // near-equal ETAs don't cause churn.
      const heldEtaS = etaSeconds(prev.stopArrivalMs, st.snapshot.delaySeconds, nowMs);
      if (nowMs - prev.lastReevalMs >= REEVAL_INTERVAL_MS) {
        const arrivals = computeArrivals(stationKey, states, geometries, nowMs);
        const rival = arrivals.find((a) => a.tramKey !== prev.targetKey) ?? null;
        if (rival && rival.etaS + PREEMPT_MARGIN_S < heldEtaS) {
          const acquired = acquireTarget(rival, stationKey, states, geometries, nowMs);
          if (acquired) return { tracking: acquired, event: 'switched', target: targetOf(rival) };
        }
        // No preemption this cycle — reset the re-rank clock.
        return {
          tracking: { ...prev, lastSeenMs: nowMs, lastReevalMs: nowMs },
          event: 'none',
          target: { tramKey: prev.targetKey, line: prev.line, etaS: heldEtaS },
        };
      }
      return {
        tracking: { ...prev, lastSeenMs: nowMs },
        event: 'none',
        target: { tramKey: prev.targetKey, line: prev.line, etaS: heldEtaS },
      };
    } else {
      excludeKey = prev.targetKey; // departed / new trip / canceled
    }
  }

  // (Re)acquire: the soonest arrival that isn't the tram we just dropped.
  // computeArrivals already filters to trams with the station ahead and
  // sorts by delay-shifted ETA.
  for (const a of computeArrivals(stationKey, states, geometries, nowMs)) {
    if (a.tramKey === excludeKey) continue;
    const acquired = acquireTarget(a, stationKey, states, geometries, nowMs);
    if (acquired) {
      return {
        tracking: acquired,
        event: prev ? 'switched' : 'acquired',
        target: targetOf(a),
      };
    }
  }

  return { tracking: null, event: prev ? 'lost' : 'none', target: null };
}

// ── helpers ──────────────────────────────────────────────────────────────────

type Arrival = ReturnType<typeof computeArrivals>[number];

/** Chip payload for an arrival (line + soonest ETA at the spotted stop). */
function targetOf(a: Arrival): SpotterTargetInfo {
  return { tramKey: a.tramKey, line: a.line, etaS: a.etaS };
}

/** Build the tracking record for an arrival, or null if its live state /
 *  geometry / next platform can't be resolved this step. */
function acquireTarget(
  a: Arrival,
  stationKey: string,
  states: TramPublicState[],
  geometries: RouteGeometry[],
  nowMs: number,
): SpotterTracking | null {
  const st = findState(states, a.tramKey);
  if (!st) return null;
  const geo = geometryForTrip(geometries, st.snapshot.tripId);
  if (!geo) return null;
  const stop = nextStationStop(geo, stationKey, st.simDistM);
  if (!stop) return null;
  return {
    targetKey: a.tramKey,
    line: a.line,
    tripId: st.snapshot.tripId,
    stopDistM: stop.distM,
    stopArrivalMs: stop.arrivalMs,
    lastSeenMs: nowMs,
    lastReevalMs: nowMs,
  };
}

function findState(states: TramPublicState[], key: string): TramPublicState | undefined {
  for (const s of states) if (s.key === key) return s;
  return undefined;
}

function geometryForTrip(geometries: RouteGeometry[], tripId: string): RouteGeometry | undefined {
  for (const g of geometries) if (g.tripId === tripId) return g;
  return undefined;
}

/** Delay-shifted schedule ETA in whole seconds, floored at 0. */
function etaSeconds(stopArrivalMs: number, delaySeconds: number, nowMs: number): number {
  return Math.max(0, Math.floor((stopArrivalMs + delaySeconds * 1000 - nowMs) / 1000));
}
