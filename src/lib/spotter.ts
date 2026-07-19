// Spotter mode — pure target-selection logic. No React, no IO: the
// SpotterController feeds it the 1 Hz states/geometries and applies the
// resulting follow/camera/haptic side effects, so everything here is
// unit-testable with synthetic fixtures.
//
// Selection: among all live trams that still have the spotted station AHEAD
// on their own trip (computeArrivals), pick the one with the smallest
// POSITION-BASED ETA (liveEtaS — remaining scheduled run time from the tram's
// live simulated position; the schedule+feed-delay etaS lags reality and
// clamps to 0 for late trams, which used to let a physically-closer tram slip
// past unnoticed). While a target is held the spotter re-ranks the arrivals
// every REEVAL_INTERVAL_MS and PREEMPTS to a different tram that will now
// reach the platform at least PREEMPT_MARGIN_S sooner — near a terminal a
// just-departed car often becomes the true soonest arrival. The margin plus a
// short post-acquisition PREEMPT_HOLDOFF_MS stop it flip-flopping between two
// trams with near-equal ETAs. The spotter still moves on unconditionally when
// the target DEPARTS (passed the platform by > DEPARTED_PAST_M of shape
// distance, rolled onto a new trip, or got canceled) or DISAPPEARS from the
// states list for longer than MISSING_TIMEOUT_MS.

import { computeArrivals, nextStationStop, positionEtaS } from '@/lib/arrivals';
import type { RouteGeometry, TramPublicState } from '@/lib/types';

/** A target that passed the platform by more than this has departed (m). */
export const DEPARTED_PAST_M = 80;
/** A target missing from the feed for longer than this is treated as gone. */
export const MISSING_TIMEOUT_MS = 15_000;
/** How often a held target is re-ranked against the live arrivals list (ms) —
 *  every 1 Hz controller step, so a genuinely-sooner tram is caught within a
 *  second instead of a 3 s window. */
export const REEVAL_INTERVAL_MS = 1_000;
/** A different tram preempts the held one only if it arrives ≥ this much
 *  sooner (s). Small on purpose: position-based ETAs move smoothly with the
 *  physics sim, so 6 s absorbs fix-snap jitter while still catching a tram
 *  that is genuinely ~10 s earlier (the old 20 s margin let 5–19 s-earlier
 *  trams reach the platform first). */
export const PREEMPT_MARGIN_S = 6;
/** No preemption within this long of acquiring the current target (ms) —
 *  temporal damping so even a pathological ETA oscillation can't flip the
 *  camera more than once per window. Departure/missing switching ignores it. */
export const PREEMPT_HOLDOFF_MS = 8_000;

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
  /** Wall-clock ms this target was acquired — anchors the preemption holdoff. */
  acquiredMs: number;
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
      // sooner tram (a just-departed car near a terminal), with a margin +
      // post-acquisition holdoff so near-equal ETAs don't cause churn.
      // Both sides of the comparison use the POSITION-based ETA: the
      // schedule+delay ETA clamps to 0 for a late tram still far from the
      // platform, which made preemption impossible from that moment on.
      const geo = geometryForTrip(geometries, prev.tripId);
      const heldEtaS =
        (geo ? positionEtaS(geo, prev.stopDistM, prev.stopArrivalMs, st.simDistM) : null) ??
        etaSeconds(prev.stopArrivalMs, st.snapshot.delaySeconds, nowMs);
      if (nowMs - prev.lastReevalMs >= REEVAL_INTERVAL_MS) {
        if (nowMs - prev.acquiredMs >= PREEMPT_HOLDOFF_MS) {
          let rival: Arrival | null = null;
          for (const a of computeArrivals(stationKey, states, geometries, nowMs)) {
            if (a.tramKey === prev.targetKey) continue;
            if (rival === null || a.liveEtaS < rival.liveEtaS) rival = a;
          }
          if (rival && rival.liveEtaS + PREEMPT_MARGIN_S < heldEtaS) {
            const acquired = acquireTarget(rival, stationKey, states, geometries, nowMs);
            if (acquired) return { tracking: acquired, event: 'switched', target: targetOf(rival) };
          }
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
  // computeArrivals filters to trams with the station ahead; re-rank its
  // board order (delay-shifted schedule) by the position-based liveEtaS so
  // the physically-closest tram wins, not the one with the stalest delay.
  const ranked = [...computeArrivals(stationKey, states, geometries, nowMs)].sort(
    (a, b) => a.liveEtaS - b.liveEtaS || a.etaS - b.etaS || a.tramKey.localeCompare(b.tramKey),
  );
  for (const a of ranked) {
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

/** Chip payload for an arrival (line + position-based ETA at the stop). */
function targetOf(a: Arrival): SpotterTargetInfo {
  return { tramKey: a.tramKey, line: a.line, etaS: a.liveEtaS };
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
    acquiredMs: nowMs,
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
