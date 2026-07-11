// Polyline math over a route shape: { coordinates: [lng,lat][], cumDistM: number[] }.
// Pure functions, local-meters math (equirectangular approximation with cos(lat)),
// accurate to well under 0.1% at Prague scale. No imports from engine/golemio/react.

/** Mean earth radius, meters (IUGG). */
const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180;
/** Meters per degree of latitude (spherical approximation). */
const M_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_M;

export type LngLat = [number, number];

/** Great-circle distance between two [lng,lat] points, meters. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * DEG2RAD;
  const dLng = (b[0] - a[0]) * DEG2RAD;
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cumulative distances (meters) per vertex; result[0] === 0, same length as coords. */
export function cumulativeDistances(coords: LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  let acc = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) acc += haversineM(coords[i - 1], coords[i]);
    out[i] = acc;
  }
  return out;
}

/**
 * Largest index i such that cumDistM[i] <= distM (and i < length-1 when possible),
 * i.e. the segment [i, i+1] containing distM. Binary search; distM is clamped.
 */
export function segmentIndexAt(cumDistM: number[], distM: number): number {
  const n = cumDistM.length;
  if (n <= 1) return 0;
  const d = Math.min(Math.max(distM, cumDistM[0]), cumDistM[n - 1]);
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumDistM[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Point at distance distM along the polyline (linear interp, clamped to ends). */
export function pointAt(coords: LngLat[], cumDistM: number[], distM: number): LngLat {
  const n = coords.length;
  if (n === 0) return [0, 0];
  if (n === 1) return [coords[0][0], coords[0][1]];
  const total = cumDistM[n - 1];
  const d = Math.min(Math.max(distM, 0), total);
  const i = segmentIndexAt(cumDistM, d);
  const segLen = cumDistM[i + 1] - cumDistM[i];
  if (segLen <= 1e-9) return [coords[i][0], coords[i][1]];
  const t = (d - cumDistM[i]) / segLen;
  const a = coords[i];
  const b = coords[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Compass bearing (deg, 0..360, 0 = north, clockwise) from a to b via local-meters math. */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(((a[1] + b[1]) / 2) * DEG2RAD);
  const dxEast = (b[0] - a[0]) * cosLat;
  const dyNorth = b[1] - a[1];
  if (Math.abs(dxEast) < 1e-15 && Math.abs(dyNorth) < 1e-15) return 0;
  const deg = Math.atan2(dxEast, dyNorth) / DEG2RAD;
  return (deg + 360) % 360;
}

/**
 * Bearing (deg 0..360) of the track at distM. For stability, averages the local
 * direction over the segment [distM-2, distM+2] (clamped to the polyline ends).
 * Falls back to the nearest non-degenerate segment for degenerate windows.
 */
export function bearingAt(coords: LngLat[], cumDistM: number[], distM: number): number {
  const n = coords.length;
  if (n < 2) return 0;
  const total = cumDistM[n - 1];
  const d = Math.min(Math.max(distM, 0), total);
  const d0 = Math.max(0, d - 2);
  const d1 = Math.min(total, d + 2);
  const p0 = pointAt(coords, cumDistM, d0);
  const p1 = pointAt(coords, cumDistM, d1);
  if (haversineM(p0, p1) > 1e-3) return bearingBetween(p0, p1);
  // Degenerate window (duplicate vertices / zero-length shape region):
  // scan outward for the nearest non-degenerate segment.
  const i = segmentIndexAt(cumDistM, d);
  for (let step = 0; step < n; step++) {
    const fwd = i + step;
    const back = i - step;
    if (fwd < n - 1 && haversineM(coords[fwd], coords[fwd + 1]) > 1e-3) {
      return bearingBetween(coords[fwd], coords[fwd + 1]);
    }
    if (back >= 0 && back < n - 1 && haversineM(coords[back], coords[back + 1]) > 1e-3) {
      return bearingBetween(coords[back], coords[back + 1]);
    }
  }
  return 0;
}

/** Point distM meters from p toward compass bearing bearingDeg (equirectangular). */
export function destinationPoint(p: LngLat, bearingDeg: number, distM: number): LngLat {
  const theta = bearingDeg * DEG2RAD;
  const dNorth = Math.cos(theta) * distM;
  const dEast = Math.sin(theta) * distM;
  const cosLat = Math.cos(p[1] * DEG2RAD);
  const lat = p[1] + dNorth / M_PER_DEG_LAT;
  const lng = p[0] + dEast / (M_PER_DEG_LAT * Math.max(cosLat, 1e-6));
  return [lng, lat];
}

/**
 * Per-vertex curvature (rad/m): |Δheading| per meter, smoothed over a ±10 m
 * window along the shape. Duplicate points and zero-length segments contribute
 * no heading of their own (previous valid heading is carried forward).
 */
export function curvatureProfile(coords: LngLat[], cumDistM: number[]): number[] {
  const n = coords.length;
  const out = new Array<number>(n).fill(0);
  if (n < 3) return out;
  const total = cumDistM[n - 1];
  if (total <= 1e-6) return out;

  // Segment headings; NaN for zero-length segments, then fill from neighbors.
  const headings = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    headings[i] =
      haversineM(coords[i], coords[i + 1]) > 1e-3 ? bearingBetween(coords[i], coords[i + 1]) : NaN;
  }
  let lastValid = NaN;
  for (let i = 0; i < n - 1; i++) {
    if (Number.isNaN(headings[i])) headings[i] = lastValid;
    else lastValid = headings[i];
  }
  // Back-fill any leading NaNs.
  let firstValid = NaN;
  for (let i = 0; i < n - 1; i++) {
    if (!Number.isNaN(headings[i])) {
      firstValid = headings[i];
      break;
    }
  }
  if (Number.isNaN(firstValid)) return out; // fully degenerate shape
  for (let i = 0; i < n - 1 && Number.isNaN(headings[i]); i++) headings[i] = firstValid;

  // Absolute turn (radians) at each interior vertex, as prefix sums.
  const prefixTurn = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    let dh = headings[i] - headings[i - 1];
    dh = ((dh + 540) % 360) - 180; // normalize to (-180, 180]
    prefixTurn[i] = prefixTurn[i - 1] + Math.abs(dh) * DEG2RAD;
  }
  prefixTurn[n - 1] = prefixTurn[n - 2];

  // Windowed sum of turns within ±10 m, divided by the window length.
  const WINDOW_M = 10;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const from = cumDistM[i] - WINDOW_M;
    const to = cumDistM[i] + WINDOW_M;
    while (lo < n - 1 && cumDistM[lo] < from) lo++;
    while (hi < n - 1 && cumDistM[hi + 1] <= to) hi++;
    // Turns at vertices in [lo, hi]: prefixTurn[hi] - prefixTurn[lo - 1]
    const sum = prefixTurn[hi] - (lo > 0 ? prefixTurn[lo - 1] : 0);
    const windowLen = Math.min(total, cumDistM[i] + WINDOW_M) - Math.max(0, cumDistM[i] - WINDOW_M);
    out[i] = sum / Math.max(windowLen, 1);
  }
  return out;
}

export interface PolylineProjection {
  /** Distance along the polyline of the nearest point, meters. */
  distM: number;
  /** Perpendicular offset from the polyline, meters. */
  offsetM: number;
}

/** Project a [lng,lat] point onto the polyline: nearest point along it + offset. */
export function projectPointToPolyline(
  point: LngLat,
  coords: LngLat[],
  cumDistM: number[],
): PolylineProjection {
  const n = coords.length;
  if (n === 0) return { distM: 0, offsetM: 0 };
  const cosLat = Math.cos(point[1] * DEG2RAD);
  // Local meters relative to `point`.
  const px = (c: LngLat) => (c[0] - point[0]) * cosLat * M_PER_DEG_LAT;
  const py = (c: LngLat) => (c[1] - point[1]) * M_PER_DEG_LAT;

  let bestDist = Infinity;
  let bestAlong = 0;
  let ax = px(coords[0]);
  let ay = py(coords[0]);
  if (n === 1) return { distM: 0, offsetM: Math.hypot(ax, ay) };
  for (let i = 0; i < n - 1; i++) {
    const bx = px(coords[i + 1]);
    const by = py(coords[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d = Math.hypot(qx, qy);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = cumDistM[i] + t * (cumDistM[i + 1] - cumDistM[i]);
    }
    ax = bx;
    ay = by;
  }
  return { distM: bestAlong, offsetM: bestDist };
}
