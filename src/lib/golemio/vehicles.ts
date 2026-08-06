// Live tram snapshot fetching: GET /v2/vehiclepositions (whole city) filtered to
// trams (route_type === 0), validated, and normalized into the app's
// TramSnapshot contract.
//
// This module is the CLIENT TRANSPORT half only: rate-limited fetch, payload
// gate, error taxonomy. The validation/normalization policy itself lives in
// `./normalize` — a dependency-free module shared verbatim with the server-side
// poller, so the two can never drift. Everything the normalizer exports is
// re-exported here so existing call sites keep importing from one place.

import type { VpFeatureCollection } from './apiTypes';
import {
  golemioFetch,
  GolemioNetworkError,
  type GolemioPriority,
  type GolemioRequestOptions,
} from './client';
import {
  isVehiclePositionsPayload,
  normalizeVehiclePositions,
  type TramSnapshotBatch,
} from './normalize';

export {
  emptyRejectionCounters,
  isVehiclePositionsPayload,
  kmToMetersOrNull,
  MAX_SHAPE_DIST_M,
  normalizeFeature,
  normalizeVehiclePositions,
  PRAGUE_LAT_MAX,
  PRAGUE_LAT_MIN,
  PRAGUE_LNG_MAX,
  PRAGUE_LNG_MIN,
  ROUTE_TYPE_TRAM,
  SNAPSHOT_REJECT_REASONS,
} from './normalize';
export type {
  NormalizeResult,
  SnapshotRejectReason,
  TramSnapshotBatch,
} from './normalize';

export interface FetchTramSnapshotsOptions {
  priority?: GolemioPriority;
  signal?: AbortSignal;
  /** Passed through to golemioFetch (the 5 s poll loop passes 0 — the loop is
   * its own retry mechanism and must stay single-flight). */
  retries?: number;
}

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
  if (!isVehiclePositionsPayload(fc)) {
    throw new GolemioNetworkError(
      'Golemio vehiclepositions payload malformed (missing features array)',
    );
  }

  return normalizeVehiclePositions(fc);
}
