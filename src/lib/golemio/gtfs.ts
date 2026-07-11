// GTFS trip geometry + route inventory fetching and normalization.
//
// fetchTripGeometry builds a RouteGeometry (polyline + cumulative distances +
// projected stops with real scheduled epoch times) from a single trip detail.
// fetchAllTramRoutes lists the 38 tram lines for pickers.

import type { RouteGeometry, RouteStop } from '@/lib/types';
import type {
  GtfsRoute,
  GtfsShapePoint,
  GtfsStopTime,
  GtfsTripDetail,
} from './apiTypes';
import {
  golemioFetch,
  type GolemioPriority,
  type GolemioRequestOptions,
} from './client';

export interface FetchOptions {
  priority?: GolemioPriority;
  signal?: AbortSignal;
}

export interface TramRouteInfo {
  routeId: string; // "L1"
  line: string; // "1"
  isNight: boolean;
}

const DAY_MS = 86_400_000;

// ── GTFS clock + service-day helpers (pure, exported for testing) ─────────────

/**
 * Parse a GTFS clock string "HH:MM:SS" into seconds-since-service-midnight.
 * Hours may exceed 24 (e.g. "25:30:00") for trips that run past midnight but
 * belong to the previous service day. Returns null if unparseable.
 */
export function parseGtfsTimeSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * UTC offset (seconds) for Europe/Prague at a given instant, computed from the
 * EU DST rule (CEST +2h from the last Sunday of March 01:00 UTC to the last
 * Sunday of October 01:00 UTC; CET +1h otherwise). Avoids relying on Intl
 * timezone support, which is unreliable on Hermes.
 */
export function pragueOffsetSeconds(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  const lastSundayUtc1am = (monthZeroBased: number): number => {
    const lastDay = new Date(Date.UTC(year, monthZeroBased + 1, 0));
    const date = lastDay.getUTCDate() - lastDay.getUTCDay();
    return Date.UTC(year, monthZeroBased, date, 1, 0, 0);
  };
  const dstStart = lastSundayUtc1am(2); // March
  const dstEnd = lastSundayUtc1am(9); // October
  return utcMs >= dstStart && utcMs < dstEnd ? 7200 : 3600;
}

/** Epoch ms of Prague-local midnight for the calendar day containing `instantMs`. */
export function pragueMidnightEpoch(instantMs: number): number {
  const off = pragueOffsetSeconds(instantMs) * 1000;
  const local = new Date(instantMs + off);
  const midnightUtcGuess = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const offAtMidnight = pragueOffsetSeconds(midnightUtcGuess) * 1000;
  return midnightUtcGuess - offAtMidnight;
}

/**
 * Resolve a Prague-local wall-clock date/time to an epoch (UTC ms). Unlike a
 * naïve `midnight + seconds` addition, this is correct across DST transitions
 * where a local day is 23h (spring-forward) or 25h (fall-back). `month` is
 * 0-based; components may overflow (e.g. day 32 or hour 25) and are normalized.
 *
 * Ambiguity policy (matches the file's existing EU-rule fallback approach, no
 * reliance on Intl timezone support):
 *   • Repeated fall-back hour (both offsets valid) → the FIRST occurrence,
 *     i.e. the larger CEST offset (chronologically earlier instant).
 *   • Nonexistent spring-forward hour (no offset valid) → roll forward using
 *     the smaller CET offset (lands in the post-transition wall clock).
 */
export function pragueLocalToEpoch(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): number {
  const localAsUtc = Date.UTC(year, month, day, hours, minutes, seconds);
  // Try CEST (+2h) before CET (+1h) so the ambiguous fall-back hour resolves to
  // its first (earlier) occurrence.
  let fallback = localAsUtc;
  for (const offSec of [7200, 3600]) {
    const utc = localAsUtc - offSec * 1000;
    if (pragueOffsetSeconds(utc) === offSec) return utc;
    fallback = utc; // keep the last (CET) guess for the nonexistent-hour case
  }
  return fallback;
}

/**
 * Resolve GTFS seconds-since-service-midnight (may exceed 86400 for after-
 * midnight runs) to an epoch, treating the value as a Prague-local wall clock
 * on the service day whose local midnight is `serviceMidnightMs`. Overflow
 * hours become a calendar-day offset plus an in-day wall clock, then resolve
 * through `pragueLocalToEpoch` so DST transitions are handled correctly.
 */
export function gtfsSecondsToEpoch(serviceMidnightMs: number, sec: number): number {
  const dayOffset = Math.floor(sec / 86400);
  const rem = sec - dayOffset * 86400;
  const h = Math.floor(rem / 3600);
  const mi = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  // Recover the service day's calendar date from its local-midnight epoch.
  const midLocal = new Date(
    serviceMidnightMs + pragueOffsetSeconds(serviceMidnightMs) * 1000,
  );
  return pragueLocalToEpoch(
    midLocal.getUTCFullYear(),
    midLocal.getUTCMonth(),
    midLocal.getUTCDate() + dayOffset,
    h,
    mi,
    s,
  );
}

/**
 * Choose the service-day midnight (epoch ms) for a trip whose stop times span
 * [firstDepSec, lastArrSec] seconds-of-day. GTFS times are relative to the
 * service day, which for after-midnight runs is the *previous* calendar day, so
 * we pick whichever of yesterday/today/tomorrow's midnight places the trip's
 * time window closest to `nowMs`.
 */
export function computeServiceMidnightMs(
  firstDepSec: number,
  lastArrSec: number,
  nowMs: number,
): number {
  let best = pragueMidnightEpoch(nowMs);
  let bestDist = Number.POSITIVE_INFINITY;
  for (const dayDelta of [-1, 0, 1]) {
    const mid = pragueMidnightEpoch(nowMs + dayDelta * DAY_MS);
    // Resolve the trip window with the same DST-aware conversion used for stops.
    const start = gtfsSecondsToEpoch(mid, firstDepSec);
    const end = gtfsSecondsToEpoch(mid, lastArrSec);
    const dist = nowMs < start ? start - nowMs : nowMs > end ? nowMs - end : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = mid;
    }
  }
  return best;
}

/**
 * Best-effort service-day midnight (Prague-local-midnight epoch) for an already
 * built geometry, recovered from its first stop's scheduled departure. Assumes
 * that first departure falls within the service day (GTFS clock < 24:00), which
 * holds for essentially every scheduled trip; a trip whose *first* stop is after
 * midnight (labelled to the previous service day) would be off by one day.
 */
export function geometryServiceMidnight(geometry: RouteGeometry): number {
  const first = geometry.stops[0];
  if (!first) return pragueMidnightEpoch(Date.now());
  return pragueMidnightEpoch(first.departureMs);
}

/**
 * Shift (ms) needed to re-anchor a geometry cached at `storedServiceMidnightMs`
 * onto the service day containing `nowMs`. A disk cache hit on a later service
 * day (within the 24h TTL) otherwise replays a stale, past-dated timetable —
 * schedule anchors run off the end of the trip and trams teleport/stick. We
 * recover the trip window (first departure / last arrival, seconds of service
 * day) relative to the stored midnight, re-pick the current service midnight
 * with the same candidate logic as the initial build, and return the delta.
 * Returns 0 when the service day is unchanged.
 */
export function serviceDayShiftMs(
  geometry: RouteGeometry,
  storedServiceMidnightMs: number,
  nowMs: number,
): number {
  const stops = geometry.stops;
  if (stops.length === 0) return 0;
  const firstDepSec = Math.round(
    (stops[0].departureMs - storedServiceMidnightMs) / 1000,
  );
  const lastArrSec = Math.round(
    (stops[stops.length - 1].arrivalMs - storedServiceMidnightMs) / 1000,
  );
  const newMid = computeServiceMidnightMs(firstDepSec, lastArrSec, nowMs);
  return newMid - storedServiceMidnightMs;
}

// ── Geometry projection ──────────────────────────────────────────────────────

/** Tolerance (m) allowing a projected stop to sit slightly behind the previous
 * stop's distance before we treat a nearer earlier-segment candidate as a
 * backward jump on a loop/crossing. */
const PROJECTION_BACK_TOL_M = 5;

/**
 * Distance along a polyline (meters, using the polyline's own cumulative
 * distances) of the point nearest to `coord`. Used when a stop lacks
 * shape_dist_traveled: we project the stop onto the nearest segment.
 *
 * `minDistM` is a lower bound (the previous stop's distance): among candidate
 * segments we prefer the nearest whose projected distance is at least
 * `minDistM − tolerance`, so that on loops/crossings a stop is not snapped to
 * an earlier segment it happens to sit equally close to. The result is clamped
 * to `minDistM` to keep the stop series monotonically non-decreasing. When no
 * forward candidate exists we fall back to the globally nearest segment,
 * clamped to `minDistM`.
 */
export function projectDistanceOnPolyline(
  coord: [number, number],
  coordinates: [number, number][],
  cumDistM: number[],
  minDistM = 0,
): number {
  if (coordinates.length === 0) return Math.max(0, minDistM);
  if (coordinates.length === 1) return Math.max(cumDistM[0] ?? 0, minDistM);

  // Local equirectangular projection (meters) around the stop latitude.
  const lat0 = (coord[1] * Math.PI) / 180;
  const kx = (Math.cos(lat0) * 111_320) as number;
  const ky = 110_540;
  const px = coord[0] * kx;
  const py = coord[1] * ky;

  // Constrained best (projected distance ≥ minDistM − tolerance) and an
  // unconstrained fallback (globally nearest) for degenerate geometry.
  let bestDistM = cumDistM[0] ?? 0;
  let bestSq = Number.POSITIVE_INFINITY;
  let fallbackDistM = cumDistM[0] ?? 0;
  let fallbackSq = Number.POSITIVE_INFINITY;
  const lowerBound = minDistM - PROJECTION_BACK_TOL_M;

  for (let i = 0; i < coordinates.length - 1; i++) {
    const ax = coordinates[i][0] * kx;
    const ay = coordinates[i][1] * ky;
    const bx = coordinates[i + 1][0] * kx;
    const by = coordinates[i + 1][1] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const segLenSq = dx * dx + dy * dy;
    let t = segLenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / segLenSq : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const distSq = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    const a = cumDistM[i] ?? 0;
    const b = cumDistM[i + 1] ?? a;
    const projDistM = a + t * (b - a);
    if (distSq < fallbackSq) {
      fallbackSq = distSq;
      fallbackDistM = projDistM;
    }
    if (projDistM >= lowerBound && distSq < bestSq) {
      bestSq = distSq;
      bestDistM = projDistM;
    }
  }

  if (bestSq === Number.POSITIVE_INFINITY) {
    // No forward candidate; use the nearest segment, clamped monotonic.
    return Math.max(fallbackDistM, minDistM);
  }
  return Math.max(bestDistM, minDistM);
}

// ── Trip geometry ────────────────────────────────────────────────────────────

export interface FetchTripGeometryOptions extends FetchOptions {
  /** Reference time for service-day selection; defaults to Date.now(). */
  nowMs?: number;
}

/** Strip the "L" prefix from a Golemio route_id to get the line short name. */
function routeIdToLine(routeId: string): string {
  return routeId.replace(/^L/, '');
}

/**
 * Fetch a trip's full geometry + timetable and normalize into RouteGeometry.
 * Requests includeShapes/includeStopTimes/includeStops; stop names + coordinates
 * arrive nested under each stop_time's `stop`.
 */
export async function fetchTripGeometry(
  tripId: string,
  options?: FetchTripGeometryOptions,
): Promise<RouteGeometry> {
  const req: GolemioRequestOptions = {
    priority: options?.priority ?? 1,
    signal: options?.signal,
    searchParams: {
      includeShapes: true,
      includeStopTimes: true,
      includeStops: true,
    },
  };
  const detail = await golemioFetch<GtfsTripDetail>(
    `/v2/gtfs/trips/${encodeURIComponent(tripId)}`,
    req,
  );
  return buildRouteGeometry(detail, options?.nowMs ?? Date.now());
}

export function buildRouteGeometry(
  detail: GtfsTripDetail,
  nowMs: number,
): RouteGeometry {
  const shapePoints = [...(detail.shapes ?? [])].sort(
    (a, b) => a.properties.shape_pt_sequence - b.properties.shape_pt_sequence,
  );
  const coordinates: [number, number][] = shapePoints.map(
    (p: GtfsShapePoint) => p.geometry.coordinates,
  );
  const cumDistM: number[] = shapePoints.map(
    (p) => (p.properties.shape_dist_traveled ?? 0) * 1000,
  );
  const totalM = cumDistM.length > 0 ? cumDistM[cumDistM.length - 1] : 0;

  const stopTimes = [...(detail.stop_times ?? [])].sort(
    (a, b) => a.stop_sequence - b.stop_sequence,
  );
  const lastSequence =
    stopTimes.length > 0 ? stopTimes[stopTimes.length - 1].stop_sequence : -1;

  // Service-day midnight from first departure / last arrival.
  const firstDepSec =
    (stopTimes.length > 0
      ? parseGtfsTimeSeconds(stopTimes[0].departure_time)
      : null) ?? 0;
  const lastArrSec =
    (stopTimes.length > 0
      ? parseGtfsTimeSeconds(stopTimes[stopTimes.length - 1].arrival_time)
      : null) ?? firstDepSec;
  const serviceMidnight = computeServiceMidnightMs(firstDepSec, lastArrSec, nowMs);

  let prevDistM = 0;
  const stops: RouteStop[] = stopTimes.map((st: GtfsStopTime) => {
    const stopCoord = st.stop?.geometry.coordinates ?? [0, 0];
    const name = st.stop?.properties.stop_name ?? st.stop_id;
    const rawDistM =
      st.shape_dist_traveled != null
        ? st.shape_dist_traveled * 1000
        : projectDistanceOnPolyline(stopCoord, coordinates, cumDistM, prevDistM);
    // Clamp the whole series monotonic (guards both projected stops on loops
    // and any non-monotonic shape_dist_traveled from the feed).
    const distM = Math.max(rawDistM, prevDistM);
    prevDistM = distM;

    const arrSec = parseGtfsTimeSeconds(st.arrival_time);
    const depSec = parseGtfsTimeSeconds(st.departure_time);
    const arrivalMs =
      arrSec != null ? gtfsSecondsToEpoch(serviceMidnight, arrSec) : serviceMidnight;
    const departureMs =
      depSec != null ? gtfsSecondsToEpoch(serviceMidnight, depSec) : arrivalMs;

    return {
      stopId: st.stop_id,
      name,
      sequence: st.stop_sequence,
      coordinates: stopCoord,
      distM,
      arrivalMs,
      departureMs,
      dwellSeconds: st.computed_dwell_time_seconds ?? 0,
      isTerminal: st.stop_sequence === lastSequence,
    };
  });

  return {
    shapeId: detail.shape_id,
    tripId: detail.trip_id,
    routeId: detail.route_id,
    line: routeIdToLine(detail.route_id),
    headsign: detail.trip_headsign ?? '',
    coordinates,
    cumDistM,
    totalM,
    stops,
  };
}

// ── Route inventory ──────────────────────────────────────────────────────────

/** List all tram routes (route_type === 0). */
export async function fetchAllTramRoutes(
  options?: FetchOptions,
): Promise<TramRouteInfo[]> {
  const req: GolemioRequestOptions = {
    priority: options?.priority ?? 2,
    signal: options?.signal,
    searchParams: { limit: 10000 },
  };
  const routes = await golemioFetch<GtfsRoute[]>('/v2/gtfs/routes', req);
  return (routes ?? [])
    .filter((r) => r.route_type === 0)
    .map((r) => ({
      routeId: r.route_id,
      line: r.route_short_name,
      isNight: r.is_night === true,
    }));
}
