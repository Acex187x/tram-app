// Live tram snapshot fetching: GET /v2/vehiclepositions (whole city) filtered to
// trams (route_type === 0), validated, and normalized into the app's
// TramSnapshot contract.
//
// Validation policy (2026-07 review): a record missing/invalid in a KEY field
// is DROPPED and counted by reason — never coerced into a quasi-valid value.
// The old lenient defaults created real artifacts downstream:
//   • coordinates → [0, 0]        teleported trams to the Gulf of Guinea,
//   • unknown shape_dist → 0      teleported the sim to the route start,
//   • missing origin_timestamp → Date.now()  fabricated fresh fixes and fed
//     false pace samples into calibration/paceBias.
// A tram without a valid distance or fix time cannot be simulated anyway;
// per-reason counters surface through FeedStatus for the health indicator.

import type { TramSnapshot } from '@/lib/types';
import type { VpFeature, VpFeatureCollection } from './apiTypes';
import {
  golemioFetch,
  GolemioNetworkError,
  type GolemioPriority,
  type GolemioRequestOptions,
} from './client';

export interface FetchTramSnapshotsOptions {
  priority?: GolemioPriority;
  signal?: AbortSignal;
  /** Passed through to golemioFetch (the 5 s poll loop passes 0 — the loop is
   * its own retry mechanism and must stay single-flight). */
  retries?: number;
}

const ROUTE_TYPE_TRAM = 0;

// Plausible bounds for the Prague tram network (with margin).
export const PRAGUE_LNG_MIN = 14.2;
export const PRAGUE_LNG_MAX = 14.7;
export const PRAGUE_LAT_MIN = 49.9;
export const PRAGUE_LAT_MAX = 50.2;
/** No Prague tram trip is anywhere near this long (m) — beyond it is garbage. */
const MAX_SHAPE_DIST_M = 100_000;

/** Why a tram feature was dropped by validation. */
export type SnapshotRejectReason =
  | 'missing-core' // no last_position/trip/gtfs or unusable trip/route ids
  | 'bad-coordinates' // non-finite or outside the Prague bounding box
  | 'bad-distance' // shape_dist_traveled absent/unparseable/out of range
  | 'missing-timestamp'; // origin_timestamp absent or unparseable

export const SNAPSHOT_REJECT_REASONS: readonly SnapshotRejectReason[] = [
  'missing-core',
  'bad-coordinates',
  'bad-distance',
  'missing-timestamp',
];

export interface TramSnapshotBatch {
  snapshots: TramSnapshot[];
  /** Tram features dropped by validation this batch, keyed by reason. */
  rejected: Record<SnapshotRejectReason, number>;
  rejectedTotal: number;
}

export type NormalizeResult =
  | { ok: true; snapshot: TramSnapshot }
  | { ok: false; reason: SnapshotRejectReason };

/**
 * Poll the citywide vehicle feed and return only trams (plus per-reason drop
 * counters for the feed health indicator).
 *
 * We deliberately fetch everything (`limit=10000`, no `includeNotTracking`) and
 * filter client-side: Golemio has no server-side "trams only" filter on this
 * endpoint, and the full payload (~900 KB) still carries `origin_timestamp`,
 * which the lighter public endpoint drops but the interpolation engine needs.
 */
export async function fetchTramSnapshots(
  options?: FetchTramSnapshotsOptions,
): Promise<TramSnapshotBatch> {
  const req: GolemioRequestOptions = {
    // Urgent by default: this is the heartbeat of the live map.
    priority: options?.priority ?? 0,
    signal: options?.signal,
    retries: options?.retries,
    searchParams: { limit: 10000 },
  };
  const fc = await golemioFetch<VpFeatureCollection>('/v2/vehiclepositions', req);

  // Payload validation BEFORE ingest: a schema-shaped response is required;
  // anything else is a delivery failure, not an empty city.
  if (fc == null || typeof fc !== 'object' || !Array.isArray(fc.features)) {
    throw new GolemioNetworkError(
      'Golemio vehiclepositions payload malformed (missing features array)',
    );
  }

  const rejected: Record<SnapshotRejectReason, number> = {
    'missing-core': 0,
    'bad-coordinates': 0,
    'bad-distance': 0,
    'missing-timestamp': 0,
  };
  let rejectedTotal = 0;
  const snapshots: TramSnapshot[] = [];
  for (const feature of fc.features) {
    // Non-tram vehicles (and features too broken to identify as trams) are
    // expected bulk — filtered silently, not counted as rejections.
    const routeType = feature?.properties?.trip?.gtfs?.route_type;
    if (routeType !== ROUTE_TYPE_TRAM) continue;
    const res = normalizeFeature(feature);
    if (res.ok) {
      snapshots.push(res.snapshot);
    } else {
      rejected[res.reason] += 1;
      rejectedTotal += 1;
    }
  }
  return { snapshots, rejected, rejectedTotal };
}

/** Finite number or null. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Coerce Golemio's string-km distance into meters, or null when absent,
 * unparseable, or out of the plausible range. Never fabricates 0.
 */
function kmToMetersOrNull(value: unknown): number | null {
  let km: number;
  if (typeof value === 'string' && value.trim() !== '') {
    km = Number(value);
  } else if (typeof value === 'number') {
    km = value;
  } else {
    return null;
  }
  if (!Number.isFinite(km)) return null;
  const meters = km * 1000;
  if (meters < 0 || meters > MAX_SHAPE_DIST_M) return null;
  return meters;
}

/** Parse an ISO timestamp (with offset) into epoch ms, or null. */
function isoToMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** [lng, lat] finite and inside the Prague bounding box. */
function validCoordinates(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [lng, lat] = value as unknown[];
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return false;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return false;
  return (
    lng >= PRAGUE_LNG_MIN &&
    lng <= PRAGUE_LNG_MAX &&
    lat >= PRAGUE_LAT_MIN &&
    lat <= PRAGUE_LAT_MAX
  );
}

/**
 * Validate + normalize one tram feature. Invalid key fields reject the record
 * (with a reason) instead of degrading into plausible-but-false values.
 */
export function normalizeFeature(feature: VpFeature): NormalizeResult {
  const props = feature?.properties;
  const lp = props?.last_position;
  const trip = props?.trip;
  const gtfs = trip?.gtfs;
  if (!lp || !trip || !gtfs) return { ok: false, reason: 'missing-core' };
  if (typeof gtfs.trip_id !== 'string' || gtfs.trip_id === '') {
    return { ok: false, reason: 'missing-core' };
  }
  if (typeof gtfs.route_id !== 'string' || typeof gtfs.route_short_name !== 'string') {
    return { ok: false, reason: 'missing-core' };
  }

  const coordinates = feature.geometry?.coordinates;
  if (!validCoordinates(coordinates)) {
    return { ok: false, reason: 'bad-coordinates' };
  }

  const shapeDistM = kmToMetersOrNull(lp.shape_dist_traveled);
  if (shapeDistM == null) return { ok: false, reason: 'bad-distance' };

  // The AVL fix time is load-bearing: the engine dead-reckons from it and the
  // calibration pipeline learns pace from Δ(obsDist)/Δ(obsAt). Substituting
  // delivery time (Date.now()) fabricated fresh fixes — drop instead.
  const observedAtMs = isoToMs(lp.origin_timestamp);
  if (observedAtMs == null) return { ok: false, reason: 'missing-timestamp' };

  const registrationNumber =
    typeof trip.vehicle_registration_number === 'number' &&
    Number.isFinite(trip.vehicle_registration_number)
      ? trip.vehicle_registration_number
      : null;

  const key =
    registrationNumber != null ? String(registrationNumber) : gtfs.trip_id;

  return {
    ok: true,
    snapshot: {
      key,
      registrationNumber,
      tripId: gtfs.trip_id,
      routeId: gtfs.route_id,
      line: gtfs.route_short_name,
      headsign: typeof gtfs.trip_headsign === 'string' ? gtfs.trip_headsign : '',
      shapeDistM,
      observedAtMs,
      coordinates: [coordinates[0], coordinates[1]],
      bearing: finiteOrNull(lp.bearing),
      delaySeconds: finiteOrNull(lp.delay?.actual) ?? 0,
      statePosition:
        typeof lp.state_position === 'string' && lp.state_position !== ''
          ? lp.state_position
          : 'unknown',
      lastStopId: typeof lp.last_stop?.id === 'string' ? lp.last_stop.id : null,
      lastStopSequence: finiteOrNull(lp.last_stop?.sequence),
      nextStopId: typeof lp.next_stop?.id === 'string' ? lp.next_stop.id : null,
      nextStopSequence: finiteOrNull(lp.next_stop?.sequence),
      nextStopArrivalMs: isoToMs(lp.next_stop?.arrival_time),
      wheelchairAccessible: trip.wheelchair_accessible === true,
      airConditioned:
        typeof trip.air_conditioned === 'boolean' ? trip.air_conditioned : null,
      usbChargers:
        typeof trip.usb_chargers === 'boolean' ? trip.usb_chargers : null,
      isCanceled: lp.is_canceled === true,
    },
  };
}
