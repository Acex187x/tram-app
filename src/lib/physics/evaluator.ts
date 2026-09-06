// The whole client physics engine, part 1: pure arithmetic over one track.
//
// A "track" is a flat Float64Array of interleaved keyframes [t0,s0,t1,s1,…] —
// absolute wall-clock ms → meters along the trip shape. The server owns every
// expensive decision (smoothing, modal stops, blending); the client only
// *reads* the curve it was handed. See docs/research/physics-v3-protocol.md.
//
// Everything here is allocation-free and branch-cheap by construction: no
// closures, no objects, no array literals, no Math.* beyond comparisons. That
// is what lets ~120 visible trams be evaluated at display rate for free
// (perf invariants #1/#8) — and what makes two clients render pixel-identical
// trams from the same bundle at the same instant (statelessness → determinism).

/** Optional decoder-prepared cubic coefficients per segment, [a,b,c].
 * Typed positions retain their legacy [t,s] layout; absent/NaN coefficients
 * mean exact legacy linear interpolation. Preparation occurs once per wire
 * decode, never per frame. The server uses the same preparation for seams.
 */
export type PreparedTrack = Float64Array & { hermite?: Float64Array };

export const TRACK_MAX_SPEED_MS = 16.7;
export const TRACK_MAX_ACCEL_MS2 = 1.3;
export const TRACK_MAX_BRAKE_MS2 = 1.4;

/** Prepare only cubics whose *whole span* satisfies the wire limits. */
export function prepareHermiteTrack(track: Float64Array, velocities: Float64Array): Float64Array {
  const n = track.length >> 1;
  const out = track as PreparedTrack;
  delete out.hermite;
  if (n < 2 || velocities.length !== n) return track;
  const coefficients = new Float64Array((n - 1) * 3);
  coefficients.fill(Number.NaN);
  let eligible = false;
  for (let i = 0; i < n - 1; i++) {
    const dt = (track[(i + 1) * 2] - track[i * 2]) / 1000;
    const ds = track[(i + 1) * 2 + 1] - track[i * 2 + 1];
    const v0 = velocities[i],
      v1 = velocities[i + 1];
    if (
      !Number.isFinite(dt) ||
      dt <= 0 ||
      !Number.isFinite(ds) ||
      ds < 0 ||
      !Number.isFinite(v0) ||
      !Number.isFinite(v1) ||
      v0 < 0 ||
      v1 < 0 ||
      v0 > TRACK_MAX_SPEED_MS ||
      v1 > TRACK_MAX_SPEED_MS
    )
      continue;
    if (ds === 0 && (v0 !== 0 || v1 !== 0)) continue;
    const a = dt * v0;
    const b = 3 * ds - dt * (2 * v0 + v1);
    const c = -2 * ds + dt * (v0 + v1);
    const accel0 = (2 * b) / (dt * dt),
      accel1 = (2 * b + 6 * c) / (dt * dt);
    if (
      accel0 < -TRACK_MAX_BRAKE_MS2 - 1e-8 ||
      accel0 > TRACK_MAX_ACCEL_MS2 + 1e-8 ||
      accel1 < -TRACK_MAX_BRAKE_MS2 - 1e-8 ||
      accel1 > TRACK_MAX_ACCEL_MS2 + 1e-8
    )
      continue;
    // Velocity is quadratic; only its interior vertex can exceed endpoints.
    const vertex = c !== 0 ? -b / (3 * c) : -1;
    if (vertex > 0 && vertex < 1) {
      const v = (a + vertex * (2 * b + 3 * c * vertex)) / dt;
      if (v < -1e-8 || v > TRACK_MAX_SPEED_MS + 1e-8) continue;
    }
    const j = i * 3;
    coefficients[j] = a;
    coefficients[j + 1] = b;
    coefficients[j + 2] = c;
    eligible = true;
  }
  if (eligible) out.hermite = coefficients;
  return track;
}

/** Number of keyframes in an interleaved track. */
export function knotCount(track: Float64Array): number {
  return track.length >> 1;
}

/** Wall-clock ms of the first keyframe (NaN for an empty track). */
export function trackStartMs(track: Float64Array): number {
  return track.length >= 2 ? track[0] : Number.NaN;
}

/** Wall-clock ms of the last keyframe — the horizon end (NaN when empty). */
export function trackEndMs(track: Float64Array): number {
  const n = track.length >> 1;
  return n > 0 ? track[(n - 1) << 1] : Number.NaN;
}

/** Meters at the last keyframe — where the curve freezes (NaN when empty). */
export function trackEndS(track: Float64Array): number {
  const n = track.length >> 1;
  return n > 0 ? track[((n - 1) << 1) + 1] : Number.NaN;
}

/**
 * Distance along the shape (meters) at wall-clock `tMs`.
 *
 * CLAMPED outside the published range — before the first knot it returns the
 * first `s`, after the last knot the last `s`. That clamp IS the honesty rule:
 * past the horizon the tram FREEZES at the last thing the server told us
 * instead of being extrapolated into fiction (the caller pairs it with
 * `pastHorizon` from `trackEndMs` to dim the frozen tram — see renderTram).
 *
 * Binary search + linear interpolation, zero allocation. Assumes strictly
 * increasing `t` (parseBundle guarantees it by dropping non-ascending knots).
 * Returns NaN for an empty track.
 */
export function evalTrajectory(track: Float64Array, tMs: number): number {
  const n = track.length >> 1;
  if (n === 0) return Number.NaN;
  if (tMs <= track[0]) return track[1];
  const lastBase = (n - 1) << 1;
  if (tMs >= track[lastBase]) return track[lastBase + 1];
  // Largest knot index lo (≤ n-2) whose t is ≤ tMs.
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid << 1] <= tMs) lo = mid;
    else hi = mid - 1;
  }
  const a = lo << 1;
  const b = a + 2;
  const t0 = track[a];
  const span = track[b] - t0;
  // Guarded for safety; parseBundle already rejects non-ascending stamps.
  if (span <= 0) return track[b + 1];
  const s0 = track[a + 1];
  const u = (tMs - t0) / span;
  const h = (track as PreparedTrack).hermite;
  const j = lo * 3;
  return h && Number.isFinite(h[j])
    ? s0 + u * (h[j] + u * (h[j + 1] + u * h[j + 2]))
    : s0 + (track[b + 1] - s0) * u;
}

/**
 * Wall-clock ms at which the track reaches `sTarget` meters — the inverse of
 * evalTrajectory, used for stop ETAs.
 *
 * Returns the first keyframe time when the target is already behind the curve's
 * start, and **NaN when `sTarget` lies beyond the published horizon** (the
 * honest answer: the server has not predicted that far, so there is no ETA).
 * Assumes non-decreasing `s` (protocol invariant). Zero allocation.
 */
export function crossingTimeMs(track: Float64Array, sTarget: number): number {
  const n = track.length >> 1;
  if (n === 0) return Number.NaN;
  if (sTarget <= track[1]) return track[0];
  const lastBase = (n - 1) << 1;
  if (sTarget > track[lastBase + 1]) return Number.NaN; // beyond the horizon
  // First knot index hi whose s is ≥ sTarget (hi ≥ 1: knot 0 is below target).
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[(mid << 1) + 1] >= sTarget) hi = mid;
    else lo = mid + 1;
  }
  const b = hi << 1;
  const a = b - 2;
  const s0 = track[a + 1];
  const ds = track[b + 1] - s0;
  const t0 = track[a];
  if (ds <= 0) return track[b];
  const h = (track as PreparedTrack).hermite;
  const j = (hi - 1) * 3;
  if (h && Number.isFinite(h[j])) {
    // Monotonicity is checked at decode, so bounded bisection is unambiguous
    // even at a zero-speed stop boundary. 24 rounds give <0.01 ms error on
    // a 120 s span; no Newton singularity and no per-call allocation.
    let left = 0,
      right = 1;
    const target = sTarget - s0;
    for (let iteration = 0; iteration < 24; iteration++) {
      const mid = (left + right) / 2;
      const value = mid * (h[j] + mid * (h[j + 1] + mid * h[j + 2]));
      if (value < target) left = mid;
      else right = mid;
    }
    return t0 + ((track[b] - t0) * (left + right)) / 2;
  }
  return t0 + ((track[b] - t0) * (sTarget - s0)) / ds;
}

/**
 * Central finite difference of the curve at `tMs`, m/s: the speed the RENDERED
 * tram is actually moving at. Pure (no per-tram state, no controller) — the
 * curve is the only source of truth, so a client that joins mid-motion reports
 * the same speed as one that has been open for an hour.
 *
 * `halfWindowMs` defaults to 500 (a ±0.5 s window): wide enough to read through
 * the keyframe spacing, narrow enough that a stop's deceleration still shows.
 * Never negative — the protocol's curves are monotone, and a server hiccup
 * must not render as a tram driving backwards.
 */
export function evalSpeedMs(
  track: Float64Array,
  tMs: number,
  halfWindowMs: number = SPEED_HALF_WINDOW_MS,
): number {
  const n = track.length >> 1;
  if (n === 0) return 0;
  const before = evalTrajectory(track, tMs - halfWindowMs);
  const after = evalTrajectory(track, tMs + halfWindowMs);
  const v = ((after - before) * 500) / halfWindowMs; // Δm / (2·halfWindow s)
  return v > 0 ? v : 0;
}

/** Half-window of the speed finite difference, ms (±0.5 s). */
export const SPEED_HALF_WINDOW_MS = 500;
