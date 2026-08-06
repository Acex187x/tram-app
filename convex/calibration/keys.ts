// Bucketing keys for the 24/7 server-side calibration (backend-convex.md §4).
//
// The Prague-local clock comes from the SAME pure resolver the app and the GTFS
// service-day logic use (`src/lib/time/prague.ts`) — no Intl, no host timezone.
// Server and client must agree on which hour band a fix belongs to, or learned
// values land in the wrong cell at every DST boundary.

import { pragueOffsetSeconds } from '../../src/lib/time/prague';

/** Distance granularity of a learned segment, meters. */
export const SEGMENT_BUCKET_M = 250;

/** Width of an hour band, hours (6 bands per day: 0–3, 4–7, … 20–23). */
export const HOUR_BAND_HOURS = 4;

export const HOUR_BAND_COUNT = 24 / HOUR_BAND_HOURS;

export type DayType = 'weekday' | 'weekend';

interface PragueParts {
  /** Prague-local hour of day, 0–23. */
  hour: number;
  /** Prague-local day of week, 0 = Sunday. */
  dow: number;
}

function pragueParts(utcMs: number): PragueParts {
  const local = new Date(utcMs + pragueOffsetSeconds(utcMs) * 1000);
  return { hour: local.getUTCHours(), dow: local.getUTCDay() };
}

/** 4-hour band of the Prague-local day, 0–5. */
export function hourBandAt(utcMs: number): number {
  return Math.floor(pragueParts(utcMs).hour / HOUR_BAND_HOURS);
}

/**
 * Day class of a Prague-local instant.
 *
 * Calendar day, not GTFS service day: a 01:00 Saturday fix counts as `weekend`
 * even though it belongs to Friday-night service. Both sides of that boundary
 * are night hours in the same band, so the misfiling is a night-vs-night swap,
 * not a peak-vs-night one.
 */
export function dayTypeAt(utcMs: number): DayType {
  const { dow } = pragueParts(utcMs);
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
}

/** Index of the 250 m bucket containing `distM` along a shape. */
export function bucketAt(distM: number): number {
  return Math.max(0, Math.floor(distM / SEGMENT_BUCKET_M));
}

/**
 * Stable key for the shape a span was travelled on.
 *
 * `shape_id` is stable across days (recon §4) but only reachable through trip
 * geometry, which the server does not serve until rollout phase 4. Until the
 * `geometries` table is populated we fall back to a `~route|headsign` proxy:
 * `trip_id` rotates daily and would reset every segment's history each night,
 * whereas route + headsign pins the line AND its direction — which matters,
 * because `shape_dist_traveled` is measured along each direction's own shape,
 * so merging directions would blend two different distance axes into one set of
 * buckets. The proxy is still coarser than a real shape id (short-turn variants
 * of the same headsign share a key); the `~` prefix marks it so real ids never
 * collide with it and the bundle can be filtered on it once they start accruing.
 */
export function proxyShapeKey(routeId: string, headsign: string): string {
  return `~${routeId}|${headsign}`;
}
