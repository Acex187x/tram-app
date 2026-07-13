// Spotter mode — pure target-selection logic. No React, no IO: the
// SpotterController feeds it the 1 Hz states/geometries and applies the
// resulting follow/camera/haptic side effects, so everything here is
// unit-testable with synthetic fixtures.
//
// Selection: among all live trams that still have the spotted station AHEAD
// on their own trip (computeArrivals — soonest ETA first), pick the first.
// Hysteresis is by construction: while a target is held it is NEVER re-ranked
// against other candidates — the spotter only moves on when the target
// DEPARTS (passed the platform by > DEPARTED_PAST_M of shape distance, rolled
// onto a new trip, or got canceled) or DISAPPEARS from the states list for
// longer than MISSING_TIMEOUT_MS.

import { computeArrivals, nextStationStop } from '@/lib/arrivals';
import type { RouteGeometry, TramPublicState } from '@/lib/types';

/** A target that passed the platform by more than this has departed (m). */
export const DEPARTED_PAST_M = 80;
/** A target missing from the feed for longer than this is treated as gone. */
export const MISSING_TIMEOUT_MS = 15_000;

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
      // Still inbound / dwelling / just past within the window — keep it.
      // No re-ranking against other candidates (hysteresis).
      return {
        tracking: { ...prev, lastSeenMs: nowMs },
        event: 'none',
        target: {
          tramKey: prev.targetKey,
          line: prev.line,
          etaS: etaSeconds(prev.stopArrivalMs, st.snapshot.delaySeconds, nowMs),
        },
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
    const st = findState(states, a.tramKey);
    if (!st) continue;
    const geo = geometryForTrip(geometries, st.snapshot.tripId);
    if (!geo) continue;
    const stop = nextStationStop(geo, stationKey, st.simDistM);
    if (!stop) continue;
    return {
      tracking: {
        targetKey: a.tramKey,
        line: a.line,
        tripId: st.snapshot.tripId,
        stopDistM: stop.distM,
        stopArrivalMs: stop.arrivalMs,
        lastSeenMs: nowMs,
      },
      event: prev ? 'switched' : 'acquired',
      target: { tramKey: a.tramKey, line: a.line, etaS: a.etaS },
    };
  }

  return { tracking: null, event: prev ? 'lost' : 'none', target: null };
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
