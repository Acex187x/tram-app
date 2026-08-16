// Pure normalization for GET /v2/vehiclepositions: raw GeoJSON FeatureCollection
// → TramSnapshot[] + per-reason rejection counters.
//
// This module is deliberately DEPENDENCY-FREE (type-only imports, no fetch
// wrapper, no react-native/expo, no stores): the same code runs in the app and
// on the server (Convex), so the client and the 24/7 poller can never drift
// into two dialects of "what a valid tram fix is". Transport, rate limiting and
// error taxonomy stay in `client.ts`/`vehicles.ts`, which are client-only.
//
// Validation policy (2026-07 review): a record missing/invalid in a KEY field
// is DROPPED and counted by reason — never coerced into a quasi-valid value.
// The old lenient defaults created real artifacts downstream:
//   • coordinates → [0, 0]        teleported trams to the Gulf of Guinea,
//   • unknown shape_dist → 0      teleported the sim to the route start,
//   • missing origin_timestamp → Date.now()  fabricated fresh fixes and fed
//     false pace samples into the calibration records.
// A tram without a valid distance or fix time cannot be simulated anyway;
// per-reason counters surface through FeedStatus for the health indicator.

import type { TramSnapshot } from '@/lib/types';
import type { VpFeature, VpFeatureCollection } from './apiTypes';

/** GTFS route_type for trams — the only vehicles this app tracks. */
export const ROUTE_TYPE_TRAM = 0;

// Plausible bounds for the Prague tram network (with margin).
export const PRAGUE_LNG_MIN = 14.2;
export const PRAGUE_LNG_MAX = 14.7;
export const PRAGUE_LAT_MIN = 49.9;
export const PRAGUE_LAT_MAX = 50.2;
/** No Prague tram trip is anywhere near this long (m) — beyond it is garbage. */
export const MAX_SHAPE_DIST_M = 100_000;

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

/** Zeroed per-reason counters (a fresh object per batch). */
export function emptyRejectionCounters(): Record<SnapshotRejectReason, number> {
  return {
    'missing-core': 0,
    'bad-coordinates': 0,
    'bad-distance': 0,
    'missing-timestamp': 0,
  };
}

/**
 * Is this body shaped like the vehiclepositions payload?
 *
 * Callers must treat `false` as a DELIVERY FAILURE (throw), not an empty city —
 * a truncated/error body would otherwise read as "no trams in Prague" and
 * evaporate the fleet.
 */
export function isVehiclePositionsPayload(
  value: unknown,
): value is VpFeatureCollection {
  if (value == null || typeof value !== 'object') return false;
  return Array.isArray((value as { features?: unknown }).features);
}

/** Finite number or null. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Coerce Golemio's string-km distance into meters, or null when absent,
 * unparseable, or out of the plausible range. Never fabricates 0.
 */
export function kmToMetersOrNull(value: unknown): number | null {
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

/**
 * Whole-payload normalization: keep trams, validate each, count the drops.
 *
 * The caller is responsible for the payload gate (`isVehiclePositionsPayload`)
 * — a malformed body must raise a transport error before it ever gets here.
 */
export function normalizeVehiclePositions(
  fc: VpFeatureCollection,
): TramSnapshotBatch {
  const rejected = emptyRejectionCounters();
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
