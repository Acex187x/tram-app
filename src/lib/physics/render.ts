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
// Both are read through the fix-forward shim (fixForward.ts): the served curve
// supplies the MOTION, the newest AVL fix supplies the OFFSET. Everything a
// caller sees from this file — position and speed alike — is that composed
// function, so a tram's reported speed always describes the pixels it is
// actually moving at. Without a fix argument the composition degenerates to
// the raw curve, which is what every existing test and the lab's server-side
// twin of `evalTrack` expect.
//
// Position and bearing are NOT computed here: they come from the existing
// polyline pointAt/bearingAt over the trip geometry, which the render/adapter
// layer already owns. This file answers only "how many meters along the
// shape, and are we past the data".

import { evalTrajectory, trackEndMs, trackStartMs, SPEED_HALF_WINDOW_MS } from './evaluator';
import type { ParsedVehicle } from './bundle';
import { EMPTY_TRACK } from './bundle';
import { coastDistM, fixForwardTauMs, trackEndSpeedMs, SMOOTH_CATCHUP_V_MS } from './fixForward';

export type RenderMode = 'smooth' | 'fixed';

export interface RenderedTram {
  /** Distance along the trip shape, meters. */
  s: number;
  /**
   * True when the evaluated instant is beyond the track's last keyframe: the
   * curve itself is CLAMPED there (frozen at the last thing the server
   * predicted) and only the bounded coast of fixForward.ts moves the marker
   * on — never an extrapolation of the prediction. The renderer dims these
   * trams, because "the server has not told us anything about now" is exactly
   * what the user needs to know.
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
 * How fast a mode may spend the fix gap, m/s. `fixed` is the track the
 * protocol licenses to jump, so it corrects at once; `smooth` is the
 * continuity track and closes the gap at a bounded speed instead.
 */
export function catchupVMsFor(mode: RenderMode): number {
  return mode === 'fixed' ? Number.POSITIVE_INFINITY : SMOOTH_CATCHUP_V_MS;
}

/** The served curve at `tMs`, coasting to a halt past its last keyframe. */
function curveWithCoast(track: Float64Array, tMs: number, endMs: number): number {
  const s = evalTrajectory(track, tMs);
  return tMs > endMs ? s + coastDistM(trackEndSpeedMs(track), tMs - endMs) : s;
}

/**
 * The composed render function: the served curve, wound forward in time to
 * where the newest fix proves the tram is, coasting to a halt past its last
 * keyframe. THE one definition of "where is this tram" — everything else in
 * the client (position, speed, culling, diagnostics) is this at some instant.
 * Allocation-free; `fixS = NaN` renders the served curve raw.
 *
 * Monotone in `tMs` by construction, which is the property the whole file
 * exists to keep: `τ` does not depend on `tMs`, the curve is monotone, the
 * coast is monotone, and the rate-limited branch is a `min` of two functions
 * that are each monotone in `tMs`.
 */
export function renderedDistM(
  track: Float64Array,
  tMs: number,
  catchupVMs: number,
  fixS: number,
  fixAtMs: number,
  anchorMs: number,
): number {
  const endMs = trackEndMs(track);
  const tau = fixForwardTauMs(track, fixS, fixAtMs, anchorMs);
  if (tau === 0) return curveWithCoast(track, tMs, endMs);
  // The tram is past everything this curve predicts: there is no phase left to
  // wind to. `fixed` takes the correction at once (the protocol licenses it to
  // jump) and then holds at the fix — the predictor replaces an overrun curve
  // within a couple of seconds, so the hold is a blink. `smooth` must not
  // teleport, so it WALKS to the fix at the bounded catch-up rate. Before this
  // branch ignored `catchupVMs` entirely and snapped both modes onto the fix,
  // which was the «телепортируется за новый фикс и стоит» field report.
  //
  // The walk's allowance is measured from the CURVE's start — the same datum
  // the finite-τ branch below uses, and for the same reason: a fix-anchored
  // allowance resets to zero on every AVL update, and a fix that flips a
  // finite τ to ∞ would hand back everything already caught up as a backward
  // step (caught by the fix-sweeping monotonicity tests). One datum, one
  // allowance, continuous across the branch boundary — and deterministic,
  // because both are server timestamps.
  if (tau === Number.POSITIVE_INFINITY) {
    const raw = curveWithCoast(track, tMs, endMs);
    if (raw >= fixS) return raw;
    if (catchupVMs === Number.POSITIVE_INFINITY) return fixS;
    const walked = raw + catchupVMs * Math.max(0, (tMs - trackStartMs(track)) / 1000);
    return walked < fixS ? walked : fixS;
  }
  const shifted = curveWithCoast(track, tMs + tau, endMs);
  if (catchupVMs === Number.POSITIVE_INFINITY) return shifted;
  // Rate-limited approach (smooth): never jump to the shifted curve, walk to
  // it at `catchupVMs` on top of the served curve's own motion.
  //
  // The allowance is measured from the CURVE's own start, not from the fix.
  // Measuring it from the fix looked natural and was a bug: a fresh fix reset
  // the allowance to zero every ~20 s, so the marker gave back everything it
  // had caught up and stepped BACKWARD ~28 m (up to ~44 m) on every AVL
  // update — in the default render mode. The curve's start only moves when the
  // bundle does, and at that moment τ collapses to ~0 anyway because the new
  // curve is anchored to this very fix, so there is nothing left to give back.
  const capped =
    curveWithCoast(track, tMs, endMs) +
    catchupVMs * Math.max(0, (tMs - trackStartMs(track)) / 1000);
  return capped < shifted ? capped : shifted;
}

/**
 * Meters the shim is adding at this instant — the rendered position minus the
 * curve as served. Diagnostics only (`PhysicsDebugInfo.fixForwardM`): reading
 * it in the field is how "the marker looks wrong" becomes a measurement.
 */
export function fixForwardAppliedM(
  track: Float64Array,
  tMs: number,
  catchupVMs: number,
  fixS: number,
  fixAtMs: number,
  anchorMs: number,
): number {
  return (
    renderedDistM(track, tMs, catchupVMs, fixS, fixAtMs, anchorMs) -
    curveWithCoast(track, tMs, trackEndMs(track))
  );
}

/**
 * Evaluate one vehicle at a SERVER-CORRECTED instant. Pure: no per-tram state,
 * no history, no controller — call it twice with the same arguments and get
 * the same answer, on any device, at any join time. That is the determinism
 * guarantee, and it is why there is nothing to "resync" after a suspension.
 *
 * `fixS`/`fixAtMs` are the newest AVL observation the client holds for this
 * tram; omit them (or pass NaN) to read the served curve raw. The gate against
 * the vehicle's own `anchorMs` lives in fixForwardOffsetM.
 */
export function renderTram(
  v: ParsedVehicle,
  serverNowMs: number,
  mode: RenderMode,
  fixS: number = Number.NaN,
  fixAtMs: number = Number.NaN,
): RenderedTram {
  const track = trackFor(v, mode);
  // Winding the curve forward consumes its horizon τ earlier, so the honest
  // "the server has told us nothing about now" instant moves with it. τ = ∞
  // means the fix is past the whole curve, which is that condition outright.
  const tau = fixForwardTauMs(track, fixS, fixAtMs, v.anchorMs);
  return {
    s: renderedDistM(track, serverNowMs, catchupVMsFor(mode), fixS, fixAtMs, v.anchorMs),
    pastHorizon:
      tau === Number.POSITIVE_INFINITY || serverNowMs + tau > trackEndMs(track),
  };
}

/**
 * Along-shape meters only — the allocation-free twin of renderTram, for the
 * pre-allocation viewport cull that runs over the whole fleet on close-zoom
 * pushes (perf invariant #5: payload ∝ visible, cull before you allocate).
 * Takes the same fix as renderTram so the cull decides on the position the
 * tram will actually be drawn at, not on an un-shifted curve that can sit
 * hundreds of meters away from it.
 */
export function renderDistM(
  v: ParsedVehicle | undefined,
  serverNowMs: number,
  mode: RenderMode,
  fixS: number = Number.NaN,
  fixAtMs: number = Number.NaN,
): number {
  if (v === undefined) return Number.NaN;
  return renderedDistM(
    trackFor(v, mode),
    serverNowMs,
    catchupVMsFor(mode),
    fixS,
    fixAtMs,
    v.anchorMs,
  );
}

/**
 * Central finite difference of the RENDERED motion at `tMs`, m/s.
 *
 * Deliberately not `evalSpeedMs(track, …)`: the rendered curve is the served
 * one plus the fix-forward offset and the past-horizon coast, and a speed that
 * described only the first term would report a stationary tram as moving (or
 * vice versa) exactly in the windows this shim exists for — and `phase`, which
 * reads this number to decide "dwell", would be wrong with it.
 *
 * Never negative: the composition is monotone by construction, and a server
 * hiccup must not render as a tram driving backwards.
 */
export function renderSpeedMs(
  v: ParsedVehicle,
  serverNowMs: number,
  mode: RenderMode,
  fixS: number = Number.NaN,
  fixAtMs: number = Number.NaN,
  halfWindowMs: number = SPEED_HALF_WINDOW_MS,
): number {
  const track = trackFor(v, mode);
  if (track.length === 0) return 0;
  const catchup = catchupVMsFor(mode);
  const a = v.anchorMs;
  const before = renderedDistM(track, serverNowMs - halfWindowMs, catchup, fixS, fixAtMs, a);
  const after = renderedDistM(track, serverNowMs + halfWindowMs, catchup, fixS, fixAtMs, a);
  const speed = ((after - before) * 500) / halfWindowMs; // Δm / (2·halfWindow s)
  return speed > 0 ? speed : 0;
}

/**
 * |smooth − fixed| at one instant, meters — THE comparison metric between the
 * cinematic curve and the model's raw opinion. Surfaces in the tram sheet, the
 * debug overlay and the calibration records; it is how "smooth beats fixed"
 * stops being an assertion and becomes a number.
 *
 * Reads the SERVED curves, without the shim: it measures what the server
 * published, and folding a client-side correction into it would quietly
 * flatter both tracks by the same offset.
 */
export function smoothFixedDeltaM(v: ParsedVehicle, serverNowMs: number): number {
  if (v.smooth.length === 0 || v.opinion.length === 0) return Number.NaN;
  return Math.abs(
    evalTrajectory(v.smooth, serverNowMs) - evalTrajectory(v.opinion, serverNowMs),
  );
}

/** An absent vehicle's track — exported so callers avoid `undefined` branches. */
export const NO_TRACK = EMPTY_TRACK;
