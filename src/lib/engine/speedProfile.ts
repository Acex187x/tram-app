// Per-shape speed-limit profile: per-vertex vLimit = min(zone cap, curve cap),
// plus the runtime braking envelope vAllowedAt() over upcoming vertex limits and
// stop points. Precomputed once per geometry; recompute only when daytime flips.

import type { RouteGeometry } from '@/lib/types';
import { curvatureProfile, segmentIndexAt } from '../geo/polyline';

/** Lateral comfort acceleration used for curve caps, m/s². */
export const A_LAT = 0.98;
/** Service braking deceleration, m/s². */
export const A_BRK = 1.2;
/** Service acceleration, m/s². */
export const A_ACC = 1.0;
/** Network max (50 km/h), m/s. */
export const V_MAX_MS = 13.9;
/** Daytime city-center cap (31 km/h), m/s. */
export const V_CENTER_MS = 8.6;
/** Lower clamp for curve caps, m/s. */
export const V_CURVE_MIN_MS = 1.4;
/** Braking-envelope lookahead, meters. */
export const DEFAULT_LOOKAHEAD_M = 400;
/**
 * Vertex limits stay active this far BEHIND the head, meters (~tram length) —
 * the body is still on the curve when the head has just passed its apex.
 */
export const TRAIL_LIMIT_M = 15;

/** Prague center slow zone: [west, south, east, north]. */
export const CENTER_BBOX: readonly [number, number, number, number] = [
  14.395, 50.068, 14.46, 50.096,
];

export interface SpeedProfile {
  shapeId: string;
  /** Daytime flag the profile was built with (center zone active when true). */
  daytime: boolean;
  /** Per-vertex speed limit, m/s (same length as geometry.coordinates). */
  vLimit: number[];
}

export interface SpeedProfileOptions {
  /** True between 07:00–19:00 Prague time — activates the center 8.6 m/s cap. */
  daytime: boolean;
}

/** Zone speed cap at a coordinate: 8.6 m/s inside CENTER_BBOX during daytime, else 13.9. */
export function zoneCapAt(coord: [number, number], daytime: boolean): number {
  if (!daytime) return V_MAX_MS;
  const [w, s, e, n] = CENTER_BBOX;
  const inside = coord[0] >= w && coord[0] <= e && coord[1] >= s && coord[1] <= n;
  return inside ? V_CENTER_MS : V_MAX_MS;
}

/** Curve cap from curvature κ (rad/m): sqrt(A_LAT/κ), clamped to [1.4, 13.9] m/s. */
export function curveCap(kappa: number): number {
  if (kappa <= 1e-9) return V_MAX_MS;
  const v = Math.sqrt(A_LAT / kappa);
  return Math.min(V_MAX_MS, Math.max(V_CURVE_MIN_MS, v));
}

/** Build the per-vertex speed-limit profile for a route geometry. */
export function buildSpeedProfile(
  geometry: RouteGeometry,
  opts: SpeedProfileOptions,
): SpeedProfile {
  const kappa = curvatureProfile(geometry.coordinates, geometry.cumDistM);
  const vLimit = new Array<number>(geometry.coordinates.length);
  for (let i = 0; i < geometry.coordinates.length; i++) {
    vLimit[i] = Math.min(zoneCapAt(geometry.coordinates[i], opts.daytime), curveCap(kappa[i]));
  }
  return { shapeId: geometry.shapeId, daytime: opts.daytime, vLimit };
}

/**
 * Cruise reference cap at sM: the zone/curve cap of the current segment,
 * WITHOUT the braking envelope. max() of the segment endpoints so a low limit
 * at a vertex acts as a *point* constraint (via the envelope), not a blanket
 * limit over a possibly-long straight segment leading to/from it.
 *
 * Pace catch-up scaling may multiply THIS value only — never vAllowedAt() —
 * so a late tram can hold the track's cruise speed but can never defeat the
 * braking envelope toward stops/curves (the final target is clamped to it).
 */
export function cruiseCapAt(profile: SpeedProfile, geometry: RouteGeometry, sM: number): number {
  const cum = geometry.cumDistM;
  const n = cum.length;
  if (n === 0) return 0;
  const s = Math.min(Math.max(sM, 0), geometry.totalM);
  const i = segmentIndexAt(cum, s);
  return n > 1
    ? Math.max(profile.vLimit[i], profile.vLimit[Math.min(i + 1, n - 1)])
    : profile.vLimit[0];
}

/**
 * Length-weighted mean of the cruise cap over the along-shape span [aM, bM]
 * (same per-segment max-of-endpoints semantics as cruiseCapAt). This is the
 * PROFILE-EXPECTED average cruise speed over the span — the reference the
 * per-tram pace calibration compares real inter-fix speeds against.
 */
export function meanCruiseCapOver(
  profile: SpeedProfile,
  geometry: RouteGeometry,
  aM: number,
  bM: number,
): number {
  const cum = geometry.cumDistM;
  const n = cum.length;
  if (n === 0) return 0;
  const a = Math.min(Math.max(Math.min(aM, bM), 0), geometry.totalM);
  const b = Math.min(Math.max(Math.max(aM, bM), 0), geometry.totalM);
  if (b - a < 1e-6 || n === 1) return cruiseCapAt(profile, geometry, a);

  let sum = 0;
  let covered = 0;
  let pos = a;
  for (let i = segmentIndexAt(cum, a); i < n - 1 && pos < b; i++) {
    const segEnd = Math.min(cum[i + 1], b);
    const len = segEnd - pos;
    if (len > 0) {
      sum += len * Math.max(profile.vLimit[i], profile.vLimit[i + 1]);
      covered += len;
    }
    pos = segEnd;
  }
  return covered > 0 ? sum / covered : cruiseCapAt(profile, geometry, a);
}

/**
 * Braking envelope: the max speed permitted at sM so that every upcoming limit
 * within lookaheadM can be met with deceleration aBrk:
 *
 *   vAllowed(s) = min over limit points d>=s of sqrt(vLim(d)² + 2·aBrk·(d−s))
 *
 * Limit points are shape vertices (curve/zone caps), stops (vLim = 0) and the
 * geometry end (vLim = 0). Stops with distM < minStopDist are ignored — the
 * caller passes it so already-dwelled/passed stops don't pin the tram.
 */
export function vAllowedAt(
  profile: SpeedProfile,
  geometry: RouteGeometry,
  sM: number,
  minStopDist = 0,
  lookaheadM: number = DEFAULT_LOOKAHEAD_M,
  aBrk: number = A_BRK,
): number {
  const cum = geometry.cumDistM;
  const n = cum.length;
  if (n === 0) return 0;
  const total = geometry.totalM;
  const s = Math.min(Math.max(sM, 0), total);

  // Base cap for the current segment (point-constraint semantics, see cruiseCapAt).
  let v = cruiseCapAt(profile, geometry, s);

  const horizon = s + lookaheadM;

  // Vertex limits: envelope ahead, direct cap for the trailing tram-length
  // window (the body hasn't cleared a just-passed curve apex yet).
  const trailStart = segmentIndexAt(cum, Math.max(0, s - TRAIL_LIMIT_M));
  for (let j = trailStart; j < n; j++) {
    const d = cum[j];
    if (d < s - TRAIL_LIMIT_M) continue;
    if (d > horizon) break;
    const lim = profile.vLimit[j];
    if (lim >= v) continue;
    const cand = d <= s ? lim : Math.sqrt(lim * lim + 2 * aBrk * (d - s));
    if (cand < v) v = cand;
  }

  // Upcoming stops = 0-limit points (skipping already-dwelled/passed ones).
  for (const stop of geometry.stops) {
    const d = stop.distM;
    if (d < minStopDist || d < s) continue;
    if (d > horizon) continue;
    const cand = Math.sqrt(2 * aBrk * (d - s));
    if (cand < v) v = cand;
  }

  // Geometry end is always a hard 0-limit (never overshoot past the terminal).
  if (total <= horizon) {
    const cand = Math.sqrt(2 * aBrk * Math.max(0, total - s));
    if (cand < v) v = cand;
  }

  return Math.max(0, v);
}
