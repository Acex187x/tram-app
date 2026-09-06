import { DWELL_NEAR_STOP_M, nearestStopIndex, nextStopIndex } from '@/lib/physics/adapter';
import type { RouteStop, TramPublicState } from '@/lib/types';

export function timelineStops(
  stops: readonly RouteStop[],
  simDistM: number,
  phase?: TramPublicState['phase'],
) {
  const nearest = nearestStopIndex(stops, simDistM);
  const atIndex =
    Number.isFinite(simDistM) &&
    (phase === 'dwell' || phase === 'terminal') &&
    nearest >= 0 &&
    Math.abs(stops[nearest].distM - simDistM) <= DWELL_NEAR_STOP_M
      ? nearest
      : -1;
  // Retain the nearby predicted platform even when the marker is a few metres
  // past it. A generic dwell phase must never be attached to the next far stop.
  const ahead = stops.findIndex(stop => stop.distM >= simDistM - 2);
  const first = atIndex >= 0 ? atIndex : ahead >= 0 ? ahead : stops.length;
  const upcoming = stops.slice(first);
  const nextIndex = atIndex >= 0 ? (upcoming.length > 1 ? 1 : -1) : (upcoming.length ? 0 : -1);
  return {
    upcoming,
    departed: first > 0 ? stops[first - 1] : undefined,
    estimatedAtStop: atIndex >= 0 ? stops[atIndex] : undefined,
    nextIndex,
    // The adapter's ETA addresses its strictly-ahead stop. Near an approaching
    // platform that can differ from the row after the estimated dwell stop.
    etaMatchesNext: nextIndex >= 0 && nextStopIndex(stops, simDistM) === first + nextIndex,
  };
}

export function sameStopOccurrence(a: RouteStop, b: RouteStop | undefined): boolean {
  return !!b && a.stopId === b.stopId && a.sequence === b.sequence;
}
