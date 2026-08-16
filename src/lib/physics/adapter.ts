// The whole client physics engine, part 6: the UI-compatibility adapter.
//
// Everything above this file speaks curves. Everything below it (TramSheet,
// StopsTimeline, arrivals, spotter, planner guidance, fleet browser, the
// feature builder, the follow camera) speaks `TramPublicState`. This file is
// the ONE place the two meet, so the app's ~40 consumers did not have to be
// rewritten when the physics did.
//
// Every derived quantity is a PURE function of (snapshot, curves, geometry,
// instant) — there is no controller, no per-tram memory, nothing to resync:
//
//   simSpeedKmh   central finite difference of s over ±0.5 s on the rendered
//                 curve (evaluator.evalSpeedMs) — the speed the tram is
//                 actually rendered moving at, not a modelled speed.
//   phase         'dwell' while standing within 30 m of a stop ('terminal' at
//                 the last one), 'cruise' otherwise, 'unknown' without curves.
//   nextStop*     first stop ahead of s; its ETA is the SMOOTH track's
//                 crossing time of that distance — null past the horizon,
//                 because past the horizon we genuinely do not know.
//   deviationM    |smooth − fixed| — the comparison metric.
//
// Fields that lost their meaning with the old engine (paceBias, the
// dead-reckoned projectedObservedDistM) are GONE rather than faked.

import { bearingAt, pointAt } from '@/lib/geo/polyline';
import type { RouteGeometry, RouteStop, TramModelSpec, TramPublicState, TramSnapshot } from '@/lib/types';
import type { ParsedVehicle } from './bundle';
import { crossingTimeMs, evalSpeedMs, evalTrajectory } from './evaluator';
import { renderTram, smoothFixedDeltaM, trackFor, type RenderMode } from './render';

/** At or below this rendered speed the tram counts as standing, km/h. */
export const DWELL_SPEED_KMH = 1;
/** Standing within this distance of a stop means "at the stop", meters. */
export const DWELL_NEAR_STOP_M = 30;

/** Index of the stop nearest to `s`, or -1 when there are none. */
export function nearestStopIndex(stops: readonly RouteStop[], s: number): number {
  const n = stops.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid].distM < s) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  if (lo === n) return n - 1;
  return stops[lo].distM - s < s - stops[lo - 1].distM ? lo : lo - 1;
}

/** Index of the first stop strictly ahead of `s`, or -1 when none remain. */
export function nextStopIndex(stops: readonly RouteStop[], s: number): number {
  const n = stops.length;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid].distM <= s) lo = mid + 1;
    else hi = mid;
  }
  return lo < n ? lo : -1;
}

/** Clamp an along-shape distance into a geometry's valid range. */
function clampToShape(s: number, geometry: RouteGeometry | undefined): number {
  if (!Number.isFinite(s)) return 0;
  if (!geometry) return s;
  return s < 0 ? 0 : s > geometry.totalM ? geometry.totalM : s;
}

export interface AdaptInput {
  snapshot: TramSnapshot;
  model: TramModelSpec;
  /** Trip geometry, when the shape has loaded. */
  geometry: RouteGeometry | undefined;
  /** This vehicle's curves; undefined ⇒ no server physics for it right now. */
  vehicle: ParsedVehicle | undefined;
  /** SERVER-corrected wall clock — every evaluation uses this, never Date.now(). */
  serverNowMs: number;
  mode: RenderMode;
}

/**
 * Build the public state one tram renders and reads from.
 *
 * Without curves (vehicle absent, or its trip changed under us) the tram falls
 * back to its RAW AVL fix and is marked `pastHorizon`: the fix is real
 * observed data, so showing it is honest — but it is frozen, so it renders
 * dimmed exactly like a tram that ran off the end of its curve. We never
 * invent motion the server did not predict.
 */
export function adaptTram(input: AdaptInput): TramPublicState {
  const { snapshot, model, geometry, serverNowMs, mode } = input;
  // A trajectory computed for a different trip is stale the instant the tram
  // turns at a terminus — drop it rather than render the old shape's meters.
  const vehicle =
    input.vehicle !== undefined && input.vehicle.tripId === snapshot.tripId
      ? input.vehicle
      : undefined;

  const hasGeometry = geometry !== undefined;
  const observedDist = clampToShape(snapshot.shapeDistM, geometry);
  const observedPosition: [number, number] = geometry
    ? pointAt(geometry.coordinates, geometry.cumDistM, observedDist)
    : [snapshot.coordinates[0], snapshot.coordinates[1]];
  const observedBearing = geometry
    ? bearingAt(geometry.coordinates, geometry.cumDistM, observedDist)
    : (snapshot.bearing ?? 0);

  let simDistM: number;
  let pastHorizon: boolean;
  let simSpeedKmh = 0;
  let fixedDistM: number | null = null;
  let deviationM: number | null = null;

  if (vehicle) {
    const rendered = renderTram(vehicle, serverNowMs, mode);
    simDistM = clampToShape(rendered.s, geometry);
    pastHorizon = rendered.pastHorizon;
    simSpeedKmh = pastHorizon ? 0 : evalSpeedMs(trackFor(vehicle, mode), serverNowMs) * 3.6;
    const opinion = vehicle.opinion.length > 0 ? vehicle.opinion : null;
    fixedDistM = opinion ? clampToShape(evalTrajectory(opinion, serverNowMs), geometry) : null;
    const delta = smoothFixedDeltaM(vehicle, serverNowMs);
    deviationM = Number.isFinite(delta) ? delta : null;
  } else {
    // No server physics: stand on the last real observation, visibly frozen.
    simDistM = observedDist;
    pastHorizon = true;
  }

  const position = geometry
    ? pointAt(geometry.coordinates, geometry.cumDistM, simDistM)
    : [snapshot.coordinates[0], snapshot.coordinates[1]] as [number, number];
  const bearing = geometry
    ? bearingAt(geometry.coordinates, geometry.cumDistM, simDistM)
    : (snapshot.bearing ?? 0);

  // Phase + next stop need the timetable side of the geometry.
  let phase: TramPublicState['phase'] = 'unknown';
  let nextStopName: string | null = null;
  let nextStopEtaS: number | null = null;
  if (geometry && geometry.stops.length > 0 && vehicle) {
    const nearIdx = nearestStopIndex(geometry.stops, simDistM);
    const near = nearIdx >= 0 ? geometry.stops[nearIdx] : null;
    const standing = simSpeedKmh <= DWELL_SPEED_KMH;
    if (standing && near && Math.abs(near.distM - simDistM) <= DWELL_NEAR_STOP_M) {
      phase = near.isTerminal ? 'terminal' : 'dwell';
    } else {
      phase = 'cruise';
    }
    const aheadIdx = nextStopIndex(geometry.stops, simDistM);
    if (aheadIdx >= 0) {
      const stop = geometry.stops[aheadIdx];
      nextStopName = stop.name;
      // ETA always reads the SMOOTH curve: it is the server's best answer to
      // "when", independent of which curve the user chose to watch.
      const smoothTrack = vehicle.smooth.length > 0 ? vehicle.smooth : vehicle.opinion;
      const crossMs = crossingTimeMs(smoothTrack, stop.distM);
      if (Number.isFinite(crossMs)) {
        const etaS = (crossMs - serverNowMs) / 1000;
        nextStopEtaS = etaS > 0 ? etaS : 0;
      }
    }
  } else if (geometry && geometry.stops.length > 0) {
    // Geometry but no curves: the next stop is still knowable, the ETA is not.
    const aheadIdx = nextStopIndex(geometry.stops, simDistM);
    if (aheadIdx >= 0) nextStopName = geometry.stops[aheadIdx].name;
  }

  return {
    key: snapshot.key,
    snapshot,
    model,
    simDistM,
    simSpeedKmh,
    position,
    bearing,
    phase,
    observedPosition,
    observedBearing,
    deviationM,
    fixedDistM,
    pastHorizon,
    nextStopName,
    nextStopEtaS,
    hasGeometry,
  };
}
