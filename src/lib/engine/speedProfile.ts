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
/**
 * Pace-controller cruise REFERENCE (42 km/h), m/s — the speed the controller
 * aims for on an unconstrained straight, before the catch-up factor, the
 * per-tram paceBias and the time-of-day factor multiply it. Calibration round
 * 1 (docs/calibration/analysis-2026-07-11.md §3): real outside-p90 speed is
 * ~42.9 km/h while the 50 km/h network default is ~2× the median real pace —
 * right as a CAP, far too fast as a cruise TARGET. Caps stay caps: V_MAX_MS
 * still bounds the braking envelope (vAllowedAt) and the hard speed limit;
 * catch-up regimes (factor up to 1.5) may exceed this reference up to that
 * envelope.
 */
export const V_CRUISE_REF_MS = 11.7;
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

// ── time-of-day model ────────────────────────────────────────────────────────
// Hour-of-day multipliers (Prague local) for the cruise pace and for DEFAULT
// dwell durations. Shipped NEUTRAL (all 1.0): the calibration program
// (docs/calibration/plan.md) drops learned per-hour values in later without
// any structural change here. Factors blend linearly between adjacent hour
// entries — entry h anchors h:00, so 07:30 resolves to the midpoint of
// entries 7 and 8 (wrapping 23→0) and pace never steps discontinuously.

let pragueHmFormatter: Intl.DateTimeFormat | null | undefined;

/** Prague-local fractional hour (h + m/60) at a timestamp, minute resolution. */
function pragueHourMinuteAt(ms: number): number {
  if (pragueHmFormatter === undefined) {
    try {
      pragueHmFormatter = new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
        timeZone: 'Europe/Prague',
      });
    } catch {
      pragueHmFormatter = null;
    }
  }
  if (pragueHmFormatter) {
    let h = NaN;
    let m = NaN;
    for (const part of pragueHmFormatter.formatToParts(new Date(ms))) {
      if (part.type === 'hour') h = parseInt(part.value, 10);
      else if (part.type === 'minute') m = parseInt(part.value, 10);
    }
    if (!Number.isNaN(h) && !Number.isNaN(m)) return (h % 24) + m / 60;
  }
  // Fallback: CET/CEST approximation.
  const d = new Date(ms);
  return ((d.getUTCHours() + 2) % 24) + d.getUTCMinutes() / 60;
}

/** Per-minute cache so the Intl lookup runs once per wall-clock minute, not per tick. */
let pragueMinuteCache: { minute: number; hourFrac: number } | null = null;

/** Fractional Prague-local hour of day in [0, 24), second resolution. */
export function pragueHourFrac(nowMs: number): number {
  const minute = Math.floor(nowMs / 60000);
  if (!pragueMinuteCache || pragueMinuteCache.minute !== minute) {
    pragueMinuteCache = { minute, hourFrac: pragueHourMinuteAt(minute * 60000) };
  }
  const secFrac = (nowMs - minute * 60000) / 60000; // [0, 1) of a minute
  return pragueMinuteCache.hourFrac + secFrac / 60;
}

/** Integer Prague-local hour of day, 0–23. */
export function pragueHour(nowMs: number): number {
  return Math.floor(pragueHourFrac(nowMs)) % 24;
}

/**
 * Per-hour cruise-pace multiplier, Prague local (entry h anchors h:00).
 * NEUTRAL until the calibration program fills learned values — VALUES STAY 1.0
 * for now; the comments document the EXPECTED future shape only.
 * Composes multiplicatively with the pace-controller factor and the per-tram
 * paceBias, always under the braking envelope.
 */
export const TOD_PACE_TABLE: number[] = [
  1.0, // 00 — night running: expect up to ~1.2 (empty streets, green waves)
  1.0, // 01 — night running: expect up to ~1.2
  1.0, // 02 — night running: expect up to ~1.2
  1.0, // 03 — night running: expect up to ~1.2
  1.0, // 04 — night running: expect up to ~1.2
  1.0, // 05 — early service: expect ~1.1 (still light traffic)
  1.0, // 06 — pre-peak ramp: expect ~0.9
  1.0, // 07 — AM peak: expect ~0.8 (car traffic + heavy boarding)
  1.0, // 08 — AM peak: expect ~0.8
  1.0, // 09 — peak tail: expect ~0.9
  1.0, // 10 — midday: expect ~1.0
  1.0, // 11 — midday: expect ~1.0
  1.0, // 12 — midday: expect ~1.0
  1.0, // 13 — midday: expect ~1.0
  1.0, // 14 — pre-peak: expect ~0.95
  1.0, // 15 — PM peak: expect ~0.8
  1.0, // 16 — PM peak: expect ~0.8
  1.0, // 17 — PM peak: expect ~0.8
  1.0, // 18 — peak tail: expect ~0.9
  1.0, // 19 — evening: expect ~1.0
  1.0, // 20 — evening: expect ~1.0–1.1
  1.0, // 21 — evening: expect ~1.1
  1.0, // 22 — night running: expect ~1.1–1.2
  1.0, // 23 — night running: expect up to ~1.2
];

/**
 * Per-hour multiplier for DEFAULT (fallback) dwell durations, Prague local
 * (entry h anchors h:00). NEUTRAL until calibrated — VALUES STAY 1.0 for now;
 * comments document the EXPECTED future shape only. Scheduled
 * computed_dwell_time_seconds is never scaled by this; adaptive-dwell logic
 * composes on top unchanged.
 */
export const TOD_DWELL_TABLE: number[] = [
  1.0, // 00 — night: expect ~0.8 (few passengers, quick doors)
  1.0, // 01 — night: expect ~0.8
  1.0, // 02 — night: expect ~0.8
  1.0, // 03 — night: expect ~0.8
  1.0, // 04 — night: expect ~0.8
  1.0, // 05 — early service: expect ~0.9
  1.0, // 06 — pre-peak ramp: expect ~1.1
  1.0, // 07 — AM peak: expect ~1.2–1.4 (boarding takes longer)
  1.0, // 08 — AM peak: expect ~1.2–1.4
  1.0, // 09 — peak tail: expect ~1.1
  1.0, // 10 — midday: expect ~1.0
  1.0, // 11 — midday: expect ~1.0
  1.0, // 12 — midday: expect ~1.0
  1.0, // 13 — midday: expect ~1.0
  1.0, // 14 — pre-peak: expect ~1.1
  1.0, // 15 — PM peak: expect ~1.2–1.4
  1.0, // 16 — PM peak: expect ~1.2–1.4
  1.0, // 17 — PM peak: expect ~1.2–1.4
  1.0, // 18 — peak tail: expect ~1.1
  1.0, // 19 — evening: expect ~1.0
  1.0, // 20 — evening: expect ~0.95
  1.0, // 21 — evening: expect ~0.9
  1.0, // 22 — night: expect ~0.85
  1.0, // 23 — night: expect ~0.8
];

/**
 * Blended table lookup at the Prague-local fractional hour: linear
 * interpolation between entry floor(h) and the next entry (wrapping 23→0).
 * The equal-entries fast path also guarantees EXACT neutrality (returns the
 * entry itself, no float round-trip) while the shipped tables are uniform.
 */
function todTableFactor(table: readonly number[], nowMs: number): number {
  const frac = pragueHourFrac(nowMs);
  const h0 = Math.floor(frac) % 24;
  const a = table[h0];
  const b = table[(h0 + 1) % 24];
  return a === b ? a : a + (b - a) * (frac - Math.floor(frac));
}

/** Time-of-day cruise-pace multiplier at nowMs (hour-blended TOD_PACE_TABLE). */
export function todPaceFactor(nowMs: number): number {
  return todTableFactor(TOD_PACE_TABLE, nowMs);
}

/** Time-of-day DEFAULT-dwell multiplier at nowMs (hour-blended TOD_DWELL_TABLE). */
export function todDwellFactor(nowMs: number): number {
  return todTableFactor(TOD_DWELL_TABLE, nowMs);
}

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
 * (same per-segment max-of-endpoints semantics as cruiseCapAt), with each
 * per-segment value additionally capped at `refCapMs`. This is the
 * PROFILE-EXPECTED average cruise speed over the span — the reference the
 * per-tram pace calibration compares real inter-fix speeds against. The
 * calibration passes V_CRUISE_REF_MS so the bias ratio is measured against
 * the SAME reference the pace controller cruises at (tramSim tick): if the
 * two references diverged, the converged product ref × bias would no longer
 * equal the tram's real pace.
 */
export function meanCruiseCapOver(
  profile: SpeedProfile,
  geometry: RouteGeometry,
  aM: number,
  bM: number,
  refCapMs: number = Infinity,
): number {
  const cum = geometry.cumDistM;
  const n = cum.length;
  if (n === 0) return 0;
  const a = Math.min(Math.max(Math.min(aM, bM), 0), geometry.totalM);
  const b = Math.min(Math.max(Math.max(aM, bM), 0), geometry.totalM);
  if (b - a < 1e-6 || n === 1) return Math.min(refCapMs, cruiseCapAt(profile, geometry, a));

  let sum = 0;
  let covered = 0;
  let pos = a;
  for (let i = segmentIndexAt(cum, a); i < n - 1 && pos < b; i++) {
    const segEnd = Math.min(cum[i + 1], b);
    const len = segEnd - pos;
    if (len > 0) {
      sum += len * Math.min(refCapMs, Math.max(profile.vLimit[i], profile.vLimit[i + 1]));
      covered += len;
    }
    pos = segEnd;
  }
  return covered > 0 ? sum / covered : Math.min(refCapMs, cruiseCapAt(profile, geometry, a));
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
