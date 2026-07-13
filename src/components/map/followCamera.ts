// Pure follow-camera math: target leading + the stationary-target deadband.
// Deliberately free of rnmapbox/native imports so the retarget policy is
// unit-testable (__tests__/follow-camera.test.ts). Consumed by TramLayers'
// retarget loop — see docs/decisions/map-rendering.md §10.

/**
 * Follow-camera cadence. Retargeting `setCamera` on EVERY 16 ms tick restarts
 * the native Mapbox camera animator 60×/s, which chokes it into ~1 Hz visible
 * stutter (user-reported regression). Instead we retarget every ~80 ms with a
 * 170 ms linear glide: each new glide starts before the previous one ends, so
 * consecutive animations overlap into continuous motion, while the animator is
 * only restarted 12.5×/s. Deliberately NOT tied to the 1 Hz UI cadence.
 */
export const CAMERA_RETARGET_MS = 80;
export const CAMERA_GLIDE_MS = 170;

/**
 * Stationary-target deadband (project-review P2 "follow camera never idles on
 * a dwell"): a retarget whose camera target is visually identical to the LAST
 * SENT one is suppressed entirely — every setCamera restarts a native
 * animation, and a tram dwelling at a stop must let the map reach a fully
 * idle state (performance.md invariant #6).
 *
 * Thresholds are sub-pixel at follow zoom (~0.54 m/px at z17.5, lat 50°), so
 * suppression is invisible. Deltas are measured against the last SENT camera
 * (not the last evaluation), so slow drift accumulates and still sends the
 * moment it crosses the deadband — the 80/170 ms glide smoothness while
 * moving is untouched (0.5 m per 80 ms ≈ anything above walking pace
 * retargets on every beat).
 */
export const CAMERA_DEADBAND_M = 0.5;
export const CAMERA_DEADBAND_DEG = 0.5;

/**
 * While the target is deadband-suppressed AND the tram reads as dwelling
 * (speed ≈ 0), re-evaluation relaxes from 12.5 Hz to 4 Hz. Motion-restart
 * latency stays imperceptible: from standstill a tram needs ~1 s to cover
 * the 0.5 m deadband anyway, and the first post-dwell retarget is a <1 px
 * jump smoothed by the 170 ms glide.
 */
export const CAMERA_DWELL_EVAL_MS = 250;
export const CAMERA_DWELL_SPEED_KMH = 0.5;

/** Meters per degree of latitude (small-offset math only). */
export const M_PER_DEG_LAT = 111_320;

/** The full native camera target a retarget would send. */
export interface FollowCameraTarget {
  center: [number, number];
  /** Final heading (tram bearing + user offset), normalized to [0, 360). */
  heading: number;
  zoom: number;
  pitch: number;
}

/**
 * Lead a coordinate along `bearing` by the distance the tram covers in
 * CAMERA_RETARGET_MS at `speedKmh` — the camera glides toward where the tram
 * is about to be instead of trailing where it was at retarget time.
 */
export function leadTarget(
  [lng, lat]: [number, number],
  bearing: number,
  speedKmh: number,
): [number, number] {
  const distM = (speedKmh / 3.6) * (CAMERA_RETARGET_MS / 1000);
  if (distM <= 0) return [lng, lat];
  const rad = (bearing * Math.PI) / 180;
  return [
    lng + (distM * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)),
    lat + (distM * Math.cos(rad)) / M_PER_DEG_LAT,
  ];
}

/**
 * True when `next` is visually identical to the last sent target: center
 * moved < CAMERA_DEADBAND_M, heading turned < CAMERA_DEADBAND_DEG (shortest
 * way around the circle) and zoom/pitch (gesture overrides) are exactly
 * unchanged.
 */
export function withinDeadband(prev: FollowCameraTarget, next: FollowCameraTarget): boolean {
  if (next.zoom !== prev.zoom || next.pitch !== prev.pitch) return false;
  const rawDeg = Math.abs(next.heading - prev.heading) % 360;
  if (Math.min(rawDeg, 360 - rawDeg) >= CAMERA_DEADBAND_DEG) return false;
  const dLatM = (next.center[1] - prev.center[1]) * M_PER_DEG_LAT;
  const dLngM =
    (next.center[0] - prev.center[0]) *
    M_PER_DEG_LAT *
    Math.cos((prev.center[1] * Math.PI) / 180);
  return dLatM * dLatM + dLngM * dLngM < CAMERA_DEADBAND_M * CAMERA_DEADBAND_M;
}
