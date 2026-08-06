// Convex schema for the Tram Spotter backend (docs/decisions/backend-convex.md §1).
//
// Table roles at a glance:
//   vehicles     — latest normalized TramSnapshot per tram (the fleet mirror)
//   batches      — the diff stream: one row per poll THAT CHANGED SOMETHING
//   pollerState  — singleton: poller heartbeat/generation/health
//   geometries   — preprocessed RouteGeometry per trip (phase 4)
//   segmentStats / modelStats / vehicleStats / stopStats — 24/7 calibration
//   bundles      — singleton: the compacted, client-facing calibration bundle
//
// The snapshot validator below MIRRORS `TramSnapshot` in src/lib/types.ts field
// for field. If that interface changes, this must change with it — the poller
// writes exactly what `normalizeVehiclePositions` produced, unmodified.

import { defineSchema, defineTable } from 'convex/server';
import { v, type Infer } from 'convex/values';

/**
 * One normalized tram observation. 1:1 with `TramSnapshot` (src/lib/types.ts).
 *
 * `coordinates` is `[lng, lat]`; Convex has no tuple validator, so it is stored
 * as a number array and re-narrowed on the client.
 */
export const snapshotValidator = v.object({
  key: v.string(),
  registrationNumber: v.union(v.number(), v.null()),
  tripId: v.string(),
  routeId: v.string(),
  line: v.string(),
  headsign: v.string(),
  shapeDistM: v.number(),
  observedAtMs: v.number(),
  coordinates: v.array(v.number()),
  bearing: v.union(v.number(), v.null()),
  delaySeconds: v.number(),
  statePosition: v.string(),
  lastStopId: v.union(v.string(), v.null()),
  lastStopSequence: v.union(v.number(), v.null()),
  nextStopId: v.union(v.string(), v.null()),
  nextStopSequence: v.union(v.number(), v.null()),
  nextStopArrivalMs: v.union(v.number(), v.null()),
  wheelchairAccessible: v.boolean(),
  airConditioned: v.union(v.boolean(), v.null()),
  usbChargers: v.union(v.boolean(), v.null()),
  isCanceled: v.boolean(),
});

export type StoredSnapshot = Infer<typeof snapshotValidator>;

/**
 * The subset of a snapshot the calibration folder needs. Kept narrow on purpose:
 * it is the argument of a scheduled mutation on every poll, and raw fixes are
 * never persisted (backend-convex.md §4) — these values live only inside one
 * `foldPairs` transaction.
 */
export const fixValidator = v.object({
  shapeDistM: v.number(),
  observedAtMs: v.number(),
  statePosition: v.string(),
  nextStopId: v.union(v.string(), v.null()),
  nextStopSequence: v.union(v.number(), v.null()),
});

/** A consecutive (previous fix → fresh fix) pair for one vehicle. */
export const fixPairValidator = v.object({
  key: v.string(),
  registrationNumber: v.union(v.number(), v.null()),
  tripId: v.string(),
  routeId: v.string(),
  /** Carried for shape-key resolution (route + headsign ≈ line + direction). */
  headsign: v.string(),
  prev: fixValidator,
  next: fixValidator,
});

export type FixPair = Infer<typeof fixPairValidator>;

/** 4-hour band of the Prague-local day, 0–5. See convex/calibration/keys.ts. */
export const hourBandValidator = v.number();

/**
 * Day class. Two-way (not weekday/Sat/Sun) deliberately: splitting three ways
 * triples the number of (shape, bucket, band, day) cells and starves each of
 * samples, while Saturday and Sunday differ mostly in FREQUENCY, not pace.
 */
export const dayTypeValidator = v.union(
  v.literal('weekday'),
  v.literal('weekend'),
);

/** Time-decayed EWMA accumulator shared by every stats table (see fold.ts). */
const ewmaFields = {
  /** Weighted mean of the folded samples. */
  mean: v.number(),
  /** Decayed effective sample count (the EWMA weight). */
  weight: v.number(),
  /** Weighted sum of squared deviations (variance = s / weight). */
  s: v.number(),
  /** Raw lifetime sample count, never decayed — the min-sample floor. */
  n: v.number(),
  updatedAtMs: v.number(),
};

const routeStopValidator = v.object({
  stopId: v.string(),
  name: v.string(),
  sequence: v.number(),
  coordinates: v.array(v.number()),
  distM: v.number(),
  arrivalMs: v.number(),
  departureMs: v.number(),
  dwellSeconds: v.number(),
  isTerminal: v.boolean(),
});

export default defineSchema({
  /** The live fleet: one row per tram key, replaced only when the fix moved. */
  vehicles: defineTable({
    key: v.string(),
    snapshot: snapshotValidator,
    /** `batches.seq` that last wrote this row. */
    updatedSeq: v.number(),
    /**
     * Coarse presence clock: bumped on every change and, for an otherwise
     * unchanged vehicle, at most every SEEN_TOUCH_MS (ingest.ts) — a per-poll
     * touch of the whole fleet would be exactly the subscription churn the
     * diffing exists to avoid.
     */
    seenAtMs: v.number(),
  })
    .index('by_key', ['key'])
    .index('by_seen', ['seenAtMs']),

  /** The diff stream. Rows older than BATCH_RETENTION_MS are swept (crons.ts). */
  batches: defineTable({
    seq: v.number(),
    /** Server wall clock when the poll was ingested. */
    atMs: v.number(),
    changed: v.array(snapshotValidator),
    /**
     * Keys retired this poll (unseen > STALE_AFTER_MS). Without them a ghost
     * tram would linger on every client until its 5-minute re-seed.
     */
    removed: v.optional(v.array(v.string())),
  }).index('by_seq', ['seq']),

  /** Singleton (`singleton: 'poller'`): liveness + health mirrored to clients. */
  pollerState: defineTable({
    singleton: v.literal('poller'),
    /** Bumped by start/stop/watchdog; a loop with a stale token exits. */
    generation: v.number(),
    running: v.boolean(),
    startedAtMs: v.number(),
    /** Heartbeat — every poll cycle, success or failure. Watchdog input. */
    lastPollAtMs: v.number(),
    lastOkAtMs: v.number(),
    lastSeq: v.number(),
    consecutiveFailures: v.number(),
    authFailed: v.boolean(),
    lastError: v.union(v.string(), v.null()),
    pollIntervalMs: v.number(),
    fleetSize: v.number(),
    rejectedTotal: v.number(),
    rejectedByReason: v.record(v.string(), v.number()),
    /** How many times the watchdog had to restart the loop. */
    restarts: v.number(),
  }).index('by_singleton', ['singleton']),

  /** Preprocessed route geometry, served to clients (rollout phase 4). */
  geometries: defineTable({
    tripId: v.string(),
    shapeId: v.string(),
    routeId: v.string(),
    line: v.string(),
    headsign: v.string(),
    /** Prague service midnight the stop times are anchored to (re-anchoring). */
    serviceMidnightMs: v.number(),
    coordinates: v.array(v.array(v.number())),
    cumDistM: v.array(v.number()),
    totalM: v.number(),
    stops: v.array(routeStopValidator),
    builtAtMs: v.number(),
  })
    .index('by_trip', ['tripId'])
    .index('by_shape', ['shapeId']),

  /** Mean moving pace (m/s) per shape × 250 m bucket × hour band × day type. */
  segmentStats: defineTable({
    shapeId: v.string(),
    /** Index of the 250 m bucket along the shape. */
    bucket: v.number(),
    hourBand: hourBandValidator,
    dayType: dayTypeValidator,
    ...ewmaFields,
  })
    .index('by_segment', ['shapeId', 'bucket', 'hourBand', 'dayType'])
    .index('by_updated', ['updatedAtMs']),

  /** Fleet-level pace prior per tram model (mean of speed / CRUISE_REF_MS). */
  modelStats: defineTable({
    model: v.string(),
    ...ewmaFields,
  }).index('by_model', ['model']),

  /** Per-vehicle pace prior + the in-progress dwell-run accumulator. */
  vehicleStats: defineTable({
    key: v.string(),
    model: v.string(),
    ...ewmaFields,
    /** Stop currently being dwelled at, if a run is open (fold.ts). */
    runStopId: v.optional(v.union(v.string(), v.null())),
    runStartMs: v.optional(v.number()),
    runLastMs: v.optional(v.number()),
  })
    .index('by_key', ['key'])
    .index('by_updated', ['updatedAtMs']),

  /** Learned dwell budget (seconds) per stop × hour band × day type. */
  stopStats: defineTable({
    stopId: v.string(),
    hourBand: hourBandValidator,
    dayType: dayTypeValidator,
    ...ewmaFields,
  })
    .index('by_stop', ['stopId', 'hourBand', 'dayType'])
    .index('by_updated', ['updatedAtMs']),

  /** Singleton (`singleton: 'latest'`): the compacted client-facing bundle. */
  bundles: defineTable({
    singleton: v.literal('latest'),
    version: v.number(),
    generatedAtMs: v.number(),
    /** Fleet-level fallbacks the client shrinks toward. */
    fleetFactor: v.number(),
    fleetPaceMs: v.number(),
    fleetDwellS: v.number(),
    /** vehicle key → pace factor (shrunk vehicle → model → fleet). */
    vehicleBias: v.record(v.string(), v.number()),
    /** model id → pace factor (shrunk model → fleet). */
    modelBias: v.record(v.string(), v.number()),
    segments: v.array(
      v.object({
        shapeId: v.string(),
        fromM: v.number(),
        toM: v.number(),
        hourBand: hourBandValidator,
        dayType: dayTypeValidator,
        paceMs: v.number(),
        n: v.number(),
      }),
    ),
    stops: v.array(
      v.object({
        stopId: v.string(),
        hourBand: hourBandValidator,
        dayType: dayTypeValidator,
        dwellS: v.number(),
        n: v.number(),
      }),
    ),
  }).index('by_singleton', ['singleton']),
});
