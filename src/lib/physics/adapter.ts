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
//   simSpeedKmh   central finite difference of s over ±0.5 s on the RENDERED
//                 motion (render.renderSpeedMs — curve + fix-forward offset +
//                 past-horizon coast) — the speed the tram is actually
//                 rendered moving at, not a modelled speed.
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
import { crossingTimeMs, evalTrajectory } from './evaluator';
import { SMOOTH_CATCHUP_V_MS } from './fixForward';
import {
  renderedDistM,
  renderSpeedMs,
  renderTram,
  smoothFixedDeltaM,
  type RenderMode,
} from './render';

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
 * dimmed exactly like a tram that ran off the end of its curve. With no curve
 * there is no velocity profile to translate and nothing but the fix to stand
 * on, so this stays a freeze; the fix-forward shim only ever moves a tram
 * along motion the server did predict.
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
  // The newest AVL fix the phone holds for this tram — raw, on the SHAPE axis
  // the curves also live on. Feeds the fix-forward shim below; unclamped,
  // because every consumer clamps its own result to the geometry.
  const fixS = snapshot.shapeDistM;
  const fixAtMs = snapshot.observedAtMs;
  const observedDist = clampToShape(fixS, geometry);
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
    // The last-mile fix-forward shim (fixForward.ts). The snapshot is the
    // newest same-trip AVL fix the phone holds — RemoteFeed lands it ~2 s
    // after the tram was there, while the trajectory bundle trails by ~7–11 s
    // because every curve costs an ML round trip before it can be emitted. So
    // for most of each inter-fix window the client knows something the served
    // curve does not, and the lab measures the cost on its own chain: at 48 %
    // of fix arrivals the served opinion is already behind the fix that just
    // landed (p90 142 m). Build 16 floored the render at the fix, which fixed
    // the backward marker and produced a tram standing still mid-segment for
    // ~17 s at that p90. Here the whole curve is translated through the fix
    // instead, so the tram keeps moving on the server's own velocity profile.
    // It fires only on a fix the curve's own anchor postdates — see
    // fixForwardOffsetM, which owns that gate.
    const rendered = renderTram(vehicle, serverNowMs, mode, fixS, fixAtMs);
    simDistM = clampToShape(rendered.s, geometry);
    pastHorizon = rendered.pastHorizon;
    // Read off the RENDERED motion, not the raw curve: past the horizon that
    // is the coast decaying to zero, and inside it the fix-forward offset is
    // part of how fast the marker is really travelling. `phase` reads this.
    simSpeedKmh = renderSpeedMs(vehicle, serverNowMs, mode, fixS, fixAtMs) * 3.6;
    // The opinion curve RAW — no shim, no floor. This is not a UI readout:
    // it is written to every calibration and ride record as `projDist`, and
    // docs/calibration/analyze.py scores `prev.projDist − cur.obsDist` as the
    // MODEL's error at the next fix. Folding a client-side correction into it
    // (build 16 floored it at the fix) makes the physics-tuning loop grade the
    // server on the client's homework. What the client added is reported
    // separately as PhysicsDebugInfo.fixForwardM.
    fixedDistM =
      vehicle.opinion.length > 0
        ? clampToShape(evalTrajectory(vehicle.opinion, serverNowMs), geometry)
        : null;
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
      //
      // …read at the lead the marker actually has, because a curve that is
      // late about where the tram is is late about when it arrives by exactly
      // as much. Asking the unwound curve when it reaches a stop the tram is
      // provably already closer to is the same staleness, reported in seconds.
      //
      // The lead is measured, not assumed: `tauEffMs` is how long the smooth
      // curve still needs to reach the point the smooth marker is ALREADY
      // drawn at. Using the raw τ instead would over-credit the rate-limited
      // smooth marker and report «arriving now» for a stop the tram is still
      // 20 m short of. Because the marker's own position is the datum, and the
      // next stop is by definition ahead of it, the subtraction can never
      // produce a crossing in the past.
      //
      // Basis stays the SMOOTH track whichever mode renders — "when" is a
      // property of the prediction, not of the curve the user chose to watch.
      // The fixed marker runs ahead of this basis, so its ETA errs late, which
      // is the safe direction and the same "fixed is beaten by smooth"
      // relationship the two tracks already have.
      const smoothTrack = vehicle.smooth.length > 0 ? vehicle.smooth : vehicle.opinion;
      const smoothRenderedS = renderedDistM(
        smoothTrack,
        serverNowMs,
        SMOOTH_CATCHUP_V_MS,
        fixS,
        fixAtMs,
        vehicle.anchorMs,
      );
      const leadMs = crossingTimeMs(smoothTrack, smoothRenderedS) - serverNowMs;
      const tauEffMs = Number.isFinite(leadMs) && leadMs > 0 ? leadMs : 0;
      const crossMs = crossingTimeMs(smoothTrack, stop.distM) - tauEffMs;
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
