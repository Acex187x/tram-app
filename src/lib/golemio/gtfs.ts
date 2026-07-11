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
    const start = mid + firstDepSec * 1000;
    const end = mid + lastArrSec * 1000;
    const dist = nowMs < start ? start - nowMs : nowMs > end ? nowMs - end : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = mid;
    }
  }
  return best;
}

// ── Geometry projection ──────────────────────────────────────────────────────

/**
 * Distance along a polyline (meters, using the polyline's own cumulative
 * distances) of the point nearest to `coord`. Used when a stop lacks
 * shape_dist_traveled: we project the stop onto the nearest segment.
 */
export function projectDistanceOnPolyline(
  coord: [number, number],
  coordinates: [number, number][],
  cumDistM: number[],
): number {
  if (coordinates.length === 0) return 0;
  if (coordinates.length === 1) return cumDistM[0] ?? 0;

  // Local equirectangular projection (meters) around the stop latitude.
  const lat0 = (coord[1] * Math.PI) / 180;
  const kx = (Math.cos(lat0) * 111_320) as number;
  const ky = 110_540;
  const px = coord[0] * kx;
  const py = coord[1] * ky;

  let bestDistM = cumDistM[0] ?? 0;
  let bestSq = Number.POSITIVE_INFINITY;

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
    if (distSq < bestSq) {
      bestSq = distSq;
      const a = cumDistM[i] ?? 0;
      const b = cumDistM[i + 1] ?? a;
      bestDistM = a + t * (b - a);
    }
  }
  return bestDistM;
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

  const stops: RouteStop[] = stopTimes.map((st: GtfsStopTime) => {
    const stopCoord = st.stop?.geometry.coordinates ?? [0, 0];
    const name = st.stop?.properties.stop_name ?? st.stop_id;
    const distM =
      st.shape_dist_traveled != null
        ? st.shape_dist_traveled * 1000
        : projectDistanceOnPolyline(stopCoord, coordinates, cumDistM);

    const arrSec = parseGtfsTimeSeconds(st.arrival_time);
    const depSec = parseGtfsTimeSeconds(st.departure_time);
    const arrivalMs =
      arrSec != null ? serviceMidnight + arrSec * 1000 : serviceMidnight;
    const departureMs =
      depSec != null ? serviceMidnight + depSec * 1000 : arrivalMs;

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
