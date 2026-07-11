// Pure math for the full-screen 3D model viewer (src/app/model/[id].tsx):
// orbit-camera state, gesture mapping, consist layout and camera framing.
// NO three.js imports — this module is unit-tested under jest, where three's
// ESM build is not transformable. The viewer feeds three.js from these values.

/** Spherical orbit-camera state around a fixed look-at target. */
export interface OrbitState {
  /** Compass-style angle around the target, degrees. −32° ≈ 3/4 front view. */
  azimuthDeg: number;
  /** Height angle above the ground plane, degrees (clamped 5–70). */
  elevationDeg: number;
  /** Distance from the target, meters. */
  radiusM: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ── Tuning constants ─────────────────────────────────────────────────────────

export const ELEVATION_MIN_DEG = 5;
export const ELEVATION_MAX_DEG = 70;

/** Pan sensitivity: a ~390 px full-width swipe ≈ 160° of azimuth. */
export const AZIMUTH_DEG_PER_PX = 0.4;
export const ELEVATION_DEG_PER_PX = 0.25;

/** Initial 3/4-front view (matches scripts/render-model.mjs --thumb). */
export const INITIAL_AZIMUTH_DEG = -32;
export const INITIAL_ELEVATION_DEG = 14;

/** Dolly clamps as multiples of the initial fitted radius. */
export const ZOOM_MIN_FACTOR = 0.35;
export const ZOOM_MAX_FACTOR = 2.5;

/** Gentle turntable while untouched. */
export const IDLE_SPIN_DEG_PER_S = 4;
export const IDLE_SPIN_DELAY_MS = 2500;

/** Gap between consecutive body sections along Z, meters. */
export const SECTION_GAP_M = 0.35;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Wrap an azimuth into [−180, 180) so it never grows unbounded. */
export function normalizeAzimuthDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped;
}

/** Apply a pan gesture (cumulative translation from gesture start). */
export function panOrbit(start: OrbitState, dxPx: number, dyPx: number): OrbitState {
  return {
    azimuthDeg: normalizeAzimuthDeg(start.azimuthDeg + dxPx * AZIMUTH_DEG_PER_PX),
    elevationDeg: clamp(
      start.elevationDeg + dyPx * ELEVATION_DEG_PER_PX,
      ELEVATION_MIN_DEG,
      ELEVATION_MAX_DEG,
    ),
    radiusM: start.radiusM,
  };
}

/** Apply a pinch gesture: scale > 1 zooms in (dolly closer), clamped. */
export function pinchOrbit(
  start: OrbitState,
  scale: number,
  minRadiusM: number,
  maxRadiusM: number,
): OrbitState {
  const safeScale = scale > 1e-3 ? scale : 1e-3;
  return {
    azimuthDeg: start.azimuthDeg,
    elevationDeg: start.elevationDeg,
    radiusM: clamp(start.radiusM / safeScale, minRadiusM, maxRadiusM),
  };
}

/**
 * Orbit → cartesian camera position. Same convention as
 * scripts/render-model.mjs: at azimuth 0 the camera sits at −Z of the target
 * (looking at the tram's nose, which is authored toward −Z), positive azimuth
 * swings clockwise when viewed from above.
 */
export function orbitToPosition(orbit: OrbitState, target: Vec3): Vec3 {
  const az = (orbit.azimuthDeg * Math.PI) / 180;
  const el = (orbit.elevationDeg * Math.PI) / 180;
  return {
    x: target.x + orbit.radiusM * Math.cos(el) * Math.sin(az),
    y: target.y + orbit.radiusM * Math.sin(el),
    z: target.z - orbit.radiusM * Math.cos(el) * Math.cos(az),
  };
}

/**
 * Lay body sections nose-to-tail along +Z (front of the consist at z ≈ 0,
 * i.e. the nose is the −Z end — the authored front). Input: each section's
 * own bbox extent along Z; output: the position.z offset to apply to each
 * section object so sections sit end-to-end with `gapM` between them.
 * Mirrors the placement loop in scripts/render-model.mjs.
 */
export function layoutSections(
  extents: { minZ: number; maxZ: number }[],
  gapM: number = SECTION_GAP_M,
): number[] {
  let zCursor = 0;
  const offsets: number[] = [];
  for (const e of extents) {
    offsets.push(zCursor - e.minZ);
    zCursor += Math.max(0, e.maxZ - e.minZ) + gapM;
  }
  return offsets;
}

/**
 * Camera distance that frames a whole bbox of the given size (bounding-sphere
 * fit against the tighter of the vertical/horizontal FOV, small margin).
 */
export function fitRadius(
  size: Vec3,
  fovDeg: number,
  aspect: number,
  marginFactor = 1.08,
): number {
  const sphereR = 0.5 * Math.hypot(size.x, size.y, size.z);
  if (!(sphereR > 0) || !(fovDeg > 0) || !(aspect > 0)) return 10;
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const halfMin = Math.min(vFov, hFov) / 2;
  return (sphereR / Math.sin(halfMin)) * marginFactor;
}

/** Theme-aware viewer background (per iteration-3 spec). */
export function viewerBackgroundColor(scheme: 'dark' | 'light'): string {
  return scheme === 'dark' ? '#101014' : '#ECECF2';
}
