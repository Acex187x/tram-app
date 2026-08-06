// The public read surface the client's RemoteFeed subscribes to
// (backend-convex.md §3). Read-only, unauthenticated: this is public transit
// data, and the Golemio key never leaves the server.
//
// THE WIRE CONTRACT IS OWNED BY THE CLIENT: `FullFleetResult`,
// `BatchesSinceResult` and `PollerHealth` in src/lib/feed/remoteFeed.ts are
// what these queries must return, field for field (they cannot be imported
// here because `TramSnapshot` narrows `coordinates` to a tuple Convex
// validators cannot express). Change that file and this one together.
//
// Protocol, client side:
//   1. one-shot `fullFleet()` → seed the local fleet map, remember `seq`
//   2. subscribe `batchesSince({ sinceSeq })` → fold `changed`/`removed` into
//      the map and emit the MERGED FULL ARRAY (the runtime replaces its
//      snapshot list wholesale, so a diff-only emit would silently shrink the
//      fleet — recon §6)
//   3. seq gap (`oldestSeq`/first row outran the cursor) → back to step 1.

import { v } from 'convex/values';
import { query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { snapshotValidator } from './schema';

/** Server-side feed health, mirrored into the client's `FeedStatus`. */
export const healthValidator = v.object({
  running: v.boolean(),
  generation: v.number(),
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
  restarts: v.number(),
});

const OFFLINE_HEALTH = {
  running: false,
  generation: 0,
  lastPollAtMs: 0,
  lastOkAtMs: 0,
  lastSeq: 0,
  consecutiveFailures: 0,
  authFailed: false,
  lastError: null as string | null,
  pollIntervalMs: 0,
  fleetSize: 0,
  rejectedTotal: 0,
  rejectedByReason: {} as Record<string, number>,
  restarts: 0,
};

async function readHealth(ctx: QueryCtx) {
  const state = await ctx.db
    .query('pollerState')
    .withIndex('by_singleton', (q) => q.eq('singleton', 'poller'))
    .first();
  if (state == null) return OFFLINE_HEALTH;
  return {
    running: state.running,
    generation: state.generation,
    lastPollAtMs: state.lastPollAtMs,
    lastOkAtMs: state.lastOkAtMs,
    lastSeq: state.lastSeq,
    consecutiveFailures: state.consecutiveFailures,
    authFailed: state.authFailed,
    lastError: state.lastError,
    pollIntervalMs: state.pollIntervalMs,
    fleetSize: state.fleetSize,
    rejectedTotal: state.rejectedTotal,
    rejectedByReason: state.rejectedByReason,
    restarts: state.restarts,
  };
}

/**
 * The whole current fleet plus the sequence number it is current as of.
 *
 * Intended as a ONE-SHOT at `start()` and after a seq gap. It is a reactive
 * query like any other, so a permanent subscription would re-send ~170
 * snapshots on every change — subscribe to `batchesSince` instead.
 */
export const fullFleet = query({
  args: {},
  returns: v.object({
    seq: v.number(),
    atMs: v.number(),
    vehicles: v.array(snapshotValidator),
    poller: healthValidator,
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query('vehicles').collect();
    const poller = await readHealth(ctx);
    return {
      // `lastSeq` is the seq of the newest published batch; every vehicle row
      // was written at or before it, so it is a safe resume point.
      seq: poller.lastSeq,
      // NOT Date.now(): a query result is cached and re-served, so a wall-clock
      // stamp here would be stale on every cache hit (and query handlers must
      // stay deterministic). `lastOkAtMs` says exactly what this payload is:
      // the fleet as of the last successful poll.
      atMs: poller.lastOkAtMs,
      vehicles: rows.map((r) => r.snapshot),
      poller,
    };
  },
});

export const MAX_BATCHES_PER_QUERY = 256;
export const DEFAULT_BATCHES_PER_QUERY = 64;

/**
 * The diff stream after `sinceSeq` (strictly greater — the client's cursor is
 * the last seq it folded).
 *
 * Deliberately does NOT read `pollerState`: the heartbeat is written on every
 * 2 s cycle, so touching it here would push an update to every subscriber even
 * when nothing about the fleet changed. Health lives in its own query (and the
 * RemoteFeed treats each folded batch's `atMs` as heartbeat evidence).
 *
 * Gap detection is the client's job: it re-seeds when the first returned row
 * (or `oldestSeq` on an empty window) is > its cursor + 1. If the window ever
 * exceeds the `take` bound, the client's re-subscription at its advanced
 * cursor picks up the remainder — RESUBSCRIBE_AFTER_BATCHES (8) keeps normal
 * windows far below the bound anyway.
 */
export const batchesSince = query({
  args: { sinceSeq: v.number(), limit: v.optional(v.number()) },
  returns: v.object({
    batches: v.array(
      v.object({
        seq: v.number(),
        atMs: v.number(),
        changed: v.array(snapshotValidator),
        removed: v.optional(v.array(v.string())),
      }),
    ),
    oldestSeq: v.number(),
    latestSeq: v.number(),
  }),
  handler: async (ctx, { sinceSeq, limit }) => {
    const take = Math.min(
      MAX_BATCHES_PER_QUERY,
      Math.max(1, limit ?? DEFAULT_BATCHES_PER_QUERY),
    );
    const rows = await ctx.db
      .query('batches')
      .withIndex('by_seq', (q) => q.gt('seq', sinceSeq))
      .order('asc')
      .take(take);
    const oldest = await ctx.db.query('batches').withIndex('by_seq').order('asc').first();
    const newest = await ctx.db.query('batches').withIndex('by_seq').order('desc').first();
    return {
      batches: rows.map((r) => ({
        seq: r.seq,
        atMs: r.atMs,
        changed: r.changed,
        ...(r.removed && r.removed.length > 0 ? { removed: r.removed } : {}),
      })),
      // 0 = nothing retained right now; the client cannot infer a gap from an
      // empty table and relies on the first future row (or its 5-min re-seed).
      oldestSeq: oldest?.seq ?? 0,
      latestSeq: newest?.seq ?? sinceSeq,
    };
  },
});

/**
 * Poller health on its own subscription. Lets a client show "feed degraded"
 * when GOLEMIO itself is down — a state the local-poll feed cannot distinguish
 * from a quiet city.
 */
export const health = query({
  args: {},
  returns: healthValidator,
  handler: async (ctx) => await readHealth(ctx),
});

/**
 * The latest calibration bundle, or null before the first compaction produced
 * one. Consumed by engine-v2 prior seeding (rollout phase 3); the system fields
 * are stripped so the payload is exactly the documented bundle shape.
 */
const bundlePayloadValidator = v.object({
  version: v.number(),
  generatedAtMs: v.number(),
  fleetFactor: v.number(),
  fleetPaceMs: v.number(),
  fleetDwellS: v.number(),
  vehicleBias: v.record(v.string(), v.number()),
  modelBias: v.record(v.string(), v.number()),
  segments: v.array(
    v.object({
      shapeId: v.string(),
      fromM: v.number(),
      toM: v.number(),
      hourBand: v.number(),
      dayType: v.union(v.literal('weekday'), v.literal('weekend')),
      paceMs: v.number(),
      n: v.number(),
    }),
  ),
  stops: v.array(
    v.object({
      stopId: v.string(),
      hourBand: v.number(),
      dayType: v.union(v.literal('weekday'), v.literal('weekend')),
      dwellS: v.number(),
      n: v.number(),
    }),
  ),
});

export const calibrationBundle = query({
  args: {},
  returns: v.union(bundlePayloadValidator, v.null()),
  handler: async (ctx) => {
    const doc = await ctx.db
      .query('bundles')
      .withIndex('by_singleton', (q) => q.eq('singleton', 'latest'))
      .first();
    if (doc == null) return null;
    return {
      version: doc.version,
      generatedAtMs: doc.generatedAtMs,
      fleetFactor: doc.fleetFactor,
      fleetPaceMs: doc.fleetPaceMs,
      fleetDwellS: doc.fleetDwellS,
      vehicleBias: doc.vehicleBias,
      modelBias: doc.modelBias,
      segments: doc.segments,
      stops: doc.stops,
    };
  },
});
