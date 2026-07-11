// Live tram snapshot fetching: GET /v2/vehiclepositions (whole city) filtered to
// trams (route_type === 0) and normalized into the app's TramSnapshot contract.

import type { TramSnapshot } from '@/lib/types';
import type { VpFeature, VpFeatureCollection } from './apiTypes';
import {
  golemioFetch,
  type GolemioPriority,
  type GolemioRequestOptions,
} from './client';

export interface FetchTramSnapshotsOptions {
  priority?: GolemioPriority;
  signal?: AbortSignal;
}

const ROUTE_TYPE_TRAM = 0;

/**
 * Poll the citywide vehicle feed and return only trams.
 *
 * We deliberately fetch everything (`limit=10000`, no `includeNotTracking`) and
 * filter client-side: Golemio has no server-side "trams only" filter on this
 * endpoint, and the full payload (~900 KB) still carries `origin_timestamp`,
 * which the lighter public endpoint drops but the interpolation engine needs.
 */
export async function fetchTramSnapshots(
  options?: FetchTramSnapshotsOptions,
): Promise<TramSnapshot[]> {
  const req: GolemioRequestOptions = {
    // Urgent by default: this is the heartbeat of the live map.
    priority: options?.priority ?? 0,
    signal: options?.signal,
    searchParams: { limit: 10000 },
  };
  const fc = await golemioFetch<VpFeatureCollection>('/v2/vehiclepositions', req);

  const out: TramSnapshot[] = [];
  const features = fc?.features ?? [];
  for (const feature of features) {
    const routeType = feature?.properties?.trip?.gtfs?.route_type;
    if (routeType !== ROUTE_TYPE_TRAM) continue;
    const snap = normalizeFeature(feature);
    if (snap) out.push(snap);
  }
  return out;
}

/** Coerce Golemio's string-km distance into a number of meters. */
function kmStringToMeters(value: string | null | undefined): number {
  if (value == null) return 0;
  const km = Number.parseFloat(value);
  return Number.isFinite(km) ? km * 1000 : 0;
}

/** Parse an ISO timestamp (with offset) into epoch ms, or null. */
function isoToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function normalizeFeature(feature: VpFeature): TramSnapshot | null {
  const props = feature?.properties;
  const lp = props?.last_position;
  const trip = props?.trip;
  const gtfs = trip?.gtfs;
  if (!lp || !trip || !gtfs) return null;

  const registrationNumber =
    typeof trip.vehicle_registration_number === 'number'
      ? trip.vehicle_registration_number
      : null;

  const key =
    registrationNumber != null ? String(registrationNumber) : gtfs.trip_id;

  const observedAtMs = isoToMs(lp.origin_timestamp) ?? Date.now();

  return {
    key,
    registrationNumber,
    tripId: gtfs.trip_id,
    routeId: gtfs.route_id,
    line: gtfs.route_short_name,
    headsign: gtfs.trip_headsign ?? '',
    shapeDistM: kmStringToMeters(lp.shape_dist_traveled),
    observedAtMs,
    coordinates: feature.geometry?.coordinates ?? [0, 0],
    bearing: typeof lp.bearing === 'number' ? lp.bearing : null,
    delaySeconds: lp.delay?.actual ?? 0,
    statePosition: lp.state_position ?? 'unknown',
    lastStopId: lp.last_stop?.id ?? null,
    lastStopSequence: lp.last_stop?.sequence ?? null,
    nextStopId: lp.next_stop?.id ?? null,
    nextStopSequence: lp.next_stop?.sequence ?? null,
    nextStopArrivalMs: isoToMs(lp.next_stop?.arrival_time),
    wheelchairAccessible: trip.wheelchair_accessible === true,
    airConditioned:
      typeof trip.air_conditioned === 'boolean' ? trip.air_conditioned : null,
    usbChargers:
      typeof trip.usb_chargers === 'boolean' ? trip.usb_chargers : null,
    isCanceled: lp.is_canceled === true,
  };
}
