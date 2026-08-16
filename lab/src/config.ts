// Lab configuration — env-driven so the same code runs on the host (smoke
// tests, CONVEX_URL=https://tram-api.acex.sh) and inside the compose network
// (CONVEX_URL=http://tram-convex-backend:3210).

export const CONVEX_URL = process.env.CONVEX_URL ?? 'https://tram-api.acex.sh';
export const SITE_URL = process.env.SITE_URL ?? 'https://tram-site.acex.sh';
export const ML_URL = process.env.ML_URL ?? 'http://tram-lab-ml:8092';
export const DB_PATH = process.env.LAB_DB ?? `${__dirname}/../data/lab.db`;
export const HTTP_PORT = Number(process.env.LAB_PORT ?? 8090);

/** Diff-stream poll cadence (the backend publishes batches at 2 s). */
export const POLL_MS = 2_000;
/** Shadow-engine tick cadence (engine contract allows dt up to 1000 ms). */
export const TICK_MS = 1_000;
/** Rollup cadence (one row per variant×bucket per minute). */
export const ROLLUP_MS = 60_000;
/** Learned-table flush + poller-health sample cadence. */
export const FLUSH_MS = 30_000;

/** Mirror of the engine's FEED_LATENCY_S: a fix is ~this much older than its
 * origin_timestamp claims by the time any consumer sees it. */
export const FEED_LATENCY_MS = 5_000;

/** Scoring gate: only score fix gaps inside this window (mirrors the
 * calibration program's usable-span window). */
export const SCORE_MIN_GAP_S = 4;
export const SCORE_MAX_GAP_S = 300;

/** Trajectory keyframe feed (GET /api/trajectories) — the experimental app ML
 * mode fetches these and dumb-lerps between the points, so the shape of the
 * feed IS the contract: TRAJ_POINTS samples spaced TRAJ_STEP_MS apart, the
 * first one at the computation instant (⇒ 120 s of horizon at 10 s spacing). */
export const TRAJ_STEP_MS = 10_000;
export const TRAJ_POINTS = 13;
/** Max feature rows per ML inference request (chunked vehicle-aligned). */
export const TRAJ_ML_MAX_ROWS = 2_000;
/** Serialized-response cache: hammering the endpoint must stay free. Both v1
 * and v2 freeze their whole payload (serverNowMs included) for this window, so
 * repeated fetches inside it are byte-identical — the cost is that a client's
 * clock offset can be up to this much stale. */
export const TRAJ_JSON_TTL_MS = 2_000;

/** ── physics v3 (docs/research/physics-v3-protocol.md), GET /api/trajectories/v2
 * The protocol is FROZEN; these are its numeric constants. */
/** The smooth track must reach the opinion track within this window. */
export const TRAJ_CONVERGE_MS = 30_000;
/** |rendered − opinion| above this at emission ⇒ honest teleport, not a blend. */
export const TRAJ_DISCONTINUITY_M = 150;
/** Modal stop rule: hold at the platform while P(departed) < this. */
export const TRAJ_MODAL_P = 0.6;
/** Extra knot this far after the modal release, so a 10 s grid cannot smear
 * the departure kink into a slow creep off the platform. */
export const TRAJ_MODAL_KICK_MS = 5_000;
/** Hard per-track keyframe cap from the protocol. */
export const TRAJ_MAX_POINTS = 24;

/** Horizon buckets for rollups (fix gap seconds → label). */
export function horizonBucket(gapS: number): string {
  if (gapS < 30) return '<30s';
  if (gapS < 60) return '30-60s';
  if (gapS < 120) return '60-120s';
  return '120s+';
}
export const HORIZON_BUCKETS = ['<30s', '30-60s', '60-120s', '120s+'];

/** Learned-surface geometry bucketing (mirrors convex/calibration/keys.ts). */
export const SEG_BUCKET_M = 250;

/** Learning gates (mirrors convex/calibration/fold.ts R13 semantics). */
export const SPAN_MIN_GAP_S = 8;
export const SPAN_MAX_GAP_S = 240;
export const SPAN_MIN_DIST_M = 15;
export const SPAN_MAX_SPEED_MS = 22;
export const DWELL_FLAT_M = 15;
export const DWELL_MIN_S = 5;
export const DWELL_MAX_S = 300;
export const RELEASE_MIN_S = 4;
export const RELEASE_MAX_S = 180;

/** EWMA half-life (parity with the server calibration). */
export const EWMA_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Learned predictor fallbacks (used until cells accumulate weight). */
export const DEFAULT_PACE_MS = 5.5; // m/s ≈ 19.8 km/h fleet-wide moving pace
export const DEFAULT_DWELL_S = 18;
export const DEFAULT_RELEASE_S = 20;
/** Minimum decayed weight before a cell is trusted over its parent. */
export const MIN_CELL_WEIGHT = 3;

/** Geometry negative-cache TTL after a 404 (trip not in GTFS yet). */
export const GEOMETRY_404_TTL_MS = 10 * 60 * 1000;
/** Re-fetch geometry after this age (server rebuilds daily). */
export const GEOMETRY_TTL_MS = 26 * 60 * 60 * 1000;

const HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  hour: '2-digit',
  hour12: false,
});
const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  weekday: 'short',
});

let hourCacheMin = -1;
let hourCacheVal = 0;
let dayCacheVal: 'weekday' | 'weekend' = 'weekday';

/** Prague local hour (0–23) + weekday/weekend, cached per wall minute. */
export function pragueContext(ms: number): { hour: number; dayType: 'weekday' | 'weekend' } {
  const min = Math.floor(ms / 60_000);
  if (min !== hourCacheMin) {
    hourCacheMin = min;
    hourCacheVal = Number(HOUR_FMT.format(new Date(ms)));
    const wd = DAY_FMT.format(new Date(ms));
    dayCacheVal = wd === 'Sat' || wd === 'Sun' ? 'weekend' : 'weekday';
  }
  return { hour: hourCacheVal, dayType: dayCacheVal };
}

/** 4-hour band 0..5 (parity with convex hourBandAt). */
export function hourBand(ms: number): number {
  return Math.floor(pragueContext(ms).hour / 4);
}
export function dayType(ms: number): 'weekday' | 'weekend' {
  return pragueContext(ms).dayType;
}
