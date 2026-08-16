// The whole client physics engine, part 5: which curve, evaluated when.
//
// Two render modes over ONE bundle (protocol §"Two render modes"):
//   'smooth' (default)  the continuity track — server-blended, never teleports
//                       except at a server-flagged `discontinuity`.
//   'fixed'  («более точное положение») the raw model-opinion track — it
//                       re-anchors on every fix and is allowed to jump. It
//                       exists to be visibly beaten by smooth, and the gap
//                       between them (`deviationM`) is how we measure that.
//
// Position and bearing are NOT computed here: they come from the existing
// polyline pointAt/bearingAt over the trip geometry, which the render/adapter
// layer already owns. This file answers only "how many meters along the
// shape, and are we past the data".

import { evalTrajectory, trackEndMs } from './evaluator';
import type { ParsedVehicle } from './bundle';
import { EMPTY_TRACK } from './bundle';

export type RenderMode = 'smooth' | 'fixed';

export interface RenderedTram {
  /** Distance along the trip shape, meters. */
  s: number;
  /**
   * True when the evaluated instant is beyond the track's last keyframe: the
   * value above is CLAMPED (frozen at the last thing the server predicted),
   * not extrapolated. The renderer dims these trams — "never animate beyond
   * data" is the whole point of the connection-honesty requirement.
   */
  pastHorizon: boolean;
}

/**
 * The track a mode renders from, with a cross-fallback: a vehicle whose
 * requested curve is missing renders the other one rather than vanishing.
 * (Both empty is impossible — parseBundle drops such vehicles.)
 */
export function trackFor(v: ParsedVehicle, mode: RenderMode): Float64Array {
  if (mode === 'smooth') return v.smooth.length > 0 ? v.smooth : v.opinion;
  return v.opinion.length > 0 ? v.opinion : v.smooth;
}

/**
 * Evaluate one vehicle at a SERVER-CORRECTED instant. Pure: no per-tram state,
 * no history, no controller — call it twice with the same arguments and get
 * the same answer, on any device, at any join time. That is the determinism
 * guarantee, and it is why there is nothing to "resync" after a suspension.
 */
export function renderTram(
  v: ParsedVehicle,
  serverNowMs: number,
  mode: RenderMode,
): RenderedTram {
  const track = trackFor(v, mode);
  return {
    s: evalTrajectory(track, serverNowMs),
    pastHorizon: serverNowMs > trackEndMs(track),
  };
}

/**
 * Along-shape meters only — the allocation-free twin of renderTram, for the
 * pre-allocation viewport cull that runs over the whole fleet on close-zoom
 * pushes (perf invariant #5: payload ∝ visible, cull before you allocate).
 */
export function renderDistM(
  v: ParsedVehicle | undefined,
  serverNowMs: number,
  mode: RenderMode,
): number {
  if (v === undefined) return Number.NaN;
  return evalTrajectory(trackFor(v, mode), serverNowMs);
}

/**
 * |smooth − fixed| at one instant, meters — THE comparison metric between the
 * cinematic curve and the model's raw opinion. Surfaces in the tram sheet, the
 * debug overlay and the calibration records; it is how "smooth beats fixed"
 * stops being an assertion and becomes a number.
 */
export function smoothFixedDeltaM(v: ParsedVehicle, serverNowMs: number): number {
  if (v.smooth.length === 0 || v.opinion.length === 0) return Number.NaN;
  return Math.abs(
    evalTrajectory(v.smooth, serverNowMs) - evalTrajectory(v.opinion, serverNowMs),
  );
}

/** An absent vehicle's track — exported so callers avoid `undefined` branches. */
export const NO_TRACK = EMPTY_TRACK;
