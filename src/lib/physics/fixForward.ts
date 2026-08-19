// The whole client physics engine, part 9: the last-mile fix-forward shim.
//
// The phone holds TWO asynchronous streams, and they are not in step:
//
//   fixes   Convex WebSocket, pushed the moment the server folds a Golemio
//           poll — on screen ~2 s after the tram was actually there.
//   curves  tram-lab HTTP, and every curve costs an ML round trip before it
//           can be emitted: fix → lab poll (≤2 s) → predictBatch → emit →
//           JSON freeze (≤2 s) → client poll (≤5 s). ~7–11 s after the fix.
//
// So for part of every inter-fix window the client KNOWS something the served
// curve does not: a newer observation. Measured against the live streams at a
// realistic bundle age (2026-08-19, gen=v3), the served opinion is behind the
// phone's newest fix for ~10 % of the fleet at any instant, median 73 m,
// p90 228 m.
//
// Build 16 handled this with a floor — `max(curve, fix)` in fixed mode. That
// removes the backward marker and introduces a worse artefact: the marker PINS
// at the fix and stands there, mid-segment, until the curve's own progression
// climbs past it. Replaying the client path against the live streams for four
// minutes puts a number on it: **3.0 % of all the time the served curve says a
// tram is moving, build 16 renders it standing still.** That is the
// «трамваи останавливаются посреди перегона» field report.
//
// ── why a TIME shift and not a space shift ──────────────────────────────────
//
// The obvious repair is to translate the curve along s so it passes through
// the fix: `s(t) = curve(t) + (fixS − curve(fixAt))`. Measured, that fixes the
// stall (0 %) and the lag (0 %) — and DOUBLES backward steps, from 350 to 776
// over the same four minutes, which is the owner's loudest complaint. Two
// reasons, and they are the same reason:
//
//   1. A space shift moves the curve's FEATURES too. A curve holding at a
//      platform the tram has already left gets its hold dragged 180 m down the
//      block, so the marker stops dead in the middle of a segment — the very
//      artefact being fixed, relocated.
//   2. It double-counts catch-up. A curve that is behind because it held too
//      long will depart and close the gap on its own; adding the gap on top
//      overshoots, and the next bundle — which the server's §14.7 seam rule
//      floored at the UNSHIFTED previous curve, because that is where it
//      believes the client is drawing — lands behind the marker.
//
// So the shim advances the curve in TIME instead:
//
//     τ = crossingTime(curve, fixS) − fixAt          (≥ 0, 0 when not behind)
//     s(t) = curve(t + τ)
//
// Read that as: the curve is not wrong about how this tram drives, it is LATE.
// The tram is already at the point the curve only reaches τ seconds from now,
// so wind the curve forward to that point and read it normally. Everything
// downstream follows: a hold the tram has demonstrably left is skipped rather
// than relocated, the speed is the curve's own speed AT THE POSITION THE TRAM
// IS AT, and there is no invented catch-up to overshoot with.
//
// Properties, all by construction:
//   • at `fixAt` the marker is exactly on the fix, and never behind it after;
//   • never frozen while the curve is moving — the rendered speed is the
//     curve's own speed, not zero;
//   • never backwards in t — τ is constant in t and the curves are monotone;
//   • no per-tram state, no history, no controller. τ is a pure function of
//     (curve, fix), so two phones holding the same bundle and the same fix
//     render pixel-identical trams (protocol goal 3).
//
// Rate limiting. `fixed` («более точное положение») is defined by the protocol
// as the track that may jump, so it takes the whole shift immediately.
// `smooth` is the continuity track and must not teleport, so it approaches the
// shifted curve at a bounded extra speed (SMOOTH_CATCHUP_V_MS) — deliberately
// slow enough that it can never read as the build-13 «догоняет с невозможной
// скоростью», which closed ~140 m in 30 s (≈4.7 m/s) with no cap at all.

import { crossingTimeMs, evalTrajectory } from './evaluator';

/**
 * Extra closing speed the SMOOTH track may spend catching up to the shifted
 * curve, m/s.
 *
 * 2 m/s is ~7 km/h on top of whatever the curve is already doing: it closes
 * the common small lag inside one inter-fix window and visibly narrows a large
 * one, while staying far below anything a passenger would read as teleporting.
 * `fixed` uses Infinity.
 */
export const SMOOTH_CATCHUP_V_MS = 2;

/**
 * How long a tram coasts to a halt once its curve runs out, ms.
 *
 * Past the horizon there is no prediction left, and the honest options are
 * "stop dead at the last keyframe" (what build 16 did) or "decelerate like a
 * vehicle". A tram doing 10 m/s stopping over 20 s is 0.5 m/s² — a third of
 * the protocol's A_BRK, i.e. unmistakably a gentle roll-out rather than a
 * claim about where the tram went. `pastHorizon` stays true throughout, so
 * the marker is still dimmed and the connection banner still tells the truth.
 */
export const COAST_DECAY_MS = 20_000;

/**
 * How far the curve must be wound forward for it to be where the newest fix
 * proves the tram is, ms. Zero means "render the curve as served".
 *
 * Takes primitives, not a fix object: this runs per tram inside the
 * pre-allocation viewport cull, where "cull before you allocate" (perf
 * invariant #5/#8) means the argument itself must not be a per-call object.
 * Pass `fixS = NaN` to disable the shim; every comparison below is then false
 * and the result is a plain 0.
 *
 * Three gates, each earning its place:
 *
 * `anchorMs` — the curve's OWN anchor fix, and the gate that makes this
 * correct rather than merely forward-biased. A curve may legitimately sit
 * behind the fix it was built from: that is exactly what the `smooth`
 * continuity track does at every emission, resuming from where the previous
 * curve said the tram was. Winding THAT forward would re-introduce the
 * teleport the smooth track exists to remove. So the shim fires only on
 * evidence the server did not have — a fix observed strictly after the
 * curve's anchor. When `anchorMs` is not a finite number the bundle did not
 * say, and the fix, which is real observed data, wins.
 *
 * `behind` — the curve must actually be behind the fix at the fix instant. A
 * curve that OVER-ran its fix is left alone: pulling a marker backwards is the
 * §14.7 seam class, and the server owns that decision with evidence (observed
 * fix-over-fix speed) this file does not have.
 *
 * `reach` — the curve must reach the fix's position at all. When the tram is
 * already past everything the curve predicts, `crossingTimeMs` returns NaN and
 * there is no phase to wind to; the caller falls back to holding at the fix.
 */
export function fixForwardTauMs(
  track: Float64Array,
  fixS: number,
  fixAtMs: number,
  anchorMs: number,
): number {
  if (track.length === 0) return 0;
  if (Number.isFinite(anchorMs) && !(fixAtMs > anchorMs)) return 0;
  if (!(fixS > evalTrajectory(track, fixAtMs))) return 0;
  const reach = crossingTimeMs(track, fixS);
  if (!Number.isFinite(reach)) return Number.POSITIVE_INFINITY; // past the whole curve
  const tau = reach - fixAtMs;
  return tau > 0 ? tau : 0;
}

/**
 * Speed of a track's final segment, m/s — the velocity the coast starts from.
 * Never negative (the curves are monotone; a server hiccup must not launch a
 * tram backwards off the end of its own horizon).
 */
export function trackEndSpeedMs(track: Float64Array): number {
  const n = track.length >> 1;
  if (n < 2) return 0;
  const b = (n - 1) << 1;
  const a = b - 2;
  const dtMs = track[b] - track[a];
  if (!(dtMs > 0)) return 0;
  const v = ((track[b + 1] - track[a + 1]) * 1000) / dtMs;
  return v > 0 ? v : 0;
}

/**
 * Meters travelled past the horizon: constant deceleration from `vEndMs` to a
 * standstill over COAST_DECAY_MS, then nothing. Monotone non-decreasing in
 * `sinceEndMs`, so it can never make a marker reverse.
 */
export function coastDistM(vEndMs: number, sinceEndMs: number): number {
  if (!(vEndMs > 0) || !(sinceEndMs > 0)) return 0;
  const decayS = COAST_DECAY_MS / 1000;
  const tS = sinceEndMs < COAST_DECAY_MS ? sinceEndMs / 1000 : decayS;
  return vEndMs * tS - ((vEndMs / (2 * decayS)) * tS) * tS;
}
