// The published trajectory feed — the physics-v3 curves, in Convex.
//
// Before this file the curves travelled a separate HTTP path (phone polls
// tram-lab.acex.sh every 5 s against a 2 s JSON freeze), which is where the
// 7–11 s fix-vs-curve freshness race of fixForward.ts came from. Now the
// predictor pushes every re-emission here (`publish`, token-gated), and the
// client folds the same diff-stream shape the fix feed already uses — one
// transport, ~2–4 s from fix to curve on glass.
//
// THE WIRE CONTRACT IS OWNED BY THE CLIENT: `TrajectorySeedResult` and
// `TrajectoryBatchesResult` in src/lib/physics/convexSource.ts are what these
// queries must return, field for field. Change that file and this one together.
//
// Protocol, client side (mirrors stream.ts):
//   1. one-shot `fullSet()` → seed the vehicle map, remember `seq`
//   2. subscribe `batchesSince({ sinceSeq })` → fold `changed`/`removed`
//   3. seq gap → back to step 1.

import { v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { trajectoryVehicleValidator, type StoredTrajectoryVehicle } from './schema';

/** Trajectory batches are short-lived — a client blip resumes well inside this. */
export const TRAJ_BATCH_RETENTION_MS = 5 * 60_000;

/** Rows a vehicle sweep may delete per mutation (same bound as ingest.ts). */
const SWEEP_BATCH = 256;

/**
 * A trajectory row this much older than the newest publication belongs to a
 * vehicle the predictor stopped emitting without a `removed` notice (predictor
 * crash mid-publish). The sweep cron retires them so clients cannot render a
 * ghost curve forever.
 */
export const TRAJ_VEHICLE_STALE_MS = 15 * 60_000;

const metaValidator = v.object({
  atMs: v.number(),
  horizonS: v.number(),
  generator: v.string(),
  lastSeq: v.number(),
  publishedAtMs: v.number(),
  /** Convex transaction clock — the client's clock-sync sample. */
  serverNowMs: v.number(),
});

async function readMeta(ctx: { db: QueryCtx['db'] }) {
  return await ctx.db
    .query('trajectoryMeta')
    .withIndex('by_singleton', (q) => q.eq('singleton', 'meta'))
    .first();
}

/**
 * One publication from the predictor service. Guarded by a shared secret
 * (`ENGINE_PUSH_TOKEN` env var on the deployment) because this is the ONE
 * write surface the public deployment exposes — everything else is internal.
 *
 * `changed` replaces each vehicle's row wholesale (old predictions are deleted
 * by construction); `removed` deletes rows for vehicles that left the feed.
 * The caller chunks large publications (predictor restart ⇒ full fleet) so a
 * single transaction stays small; each chunk becomes its own batch row.
 */
export const publish = mutation({
  args: {
    token: v.string(),
    /** Predictor build instant of this publication. */
    atMs: v.number(),
    horizonS: v.number(),
    generator: v.string(),
    changed: v.array(trajectoryVehicleValidator),
    removed: v.array(v.string()),
  },
  returns: v.object({ seq: v.number() }),
  handler: async (ctx, args) => {
    const expected = process.env.ENGINE_PUSH_TOKEN;
    if (!expected || args.token !== expected) {
      throw new Error('trajectories.publish: bad or unconfigured token');
    }
    const meta = await readMeta(ctx);
    const seq = (meta?.lastSeq ?? 0) + 1;

    for (const vehicle of args.changed) {
      const row = await ctx.db
        .query('trajectoryVehicles')
        .withIndex('by_key', (q) => q.eq('key', vehicle.key))
        .first();
      if (row) await ctx.db.patch(row._id, { vehicle, updatedSeq: seq });
      else await ctx.db.insert('trajectoryVehicles', { key: vehicle.key, vehicle, updatedSeq: seq });
    }
    for (const key of args.removed) {
      const row = await ctx.db
        .query('trajectoryVehicles')
        .withIndex('by_key', (q) => q.eq('key', key))
        .first();
      if (row) await ctx.db.delete(row._id);
    }
    if (args.changed.length > 0 || args.removed.length > 0) {
      await ctx.db.insert('trajectoryBatches', {
        seq,
        atMs: args.atMs,
        changed: args.changed,
        removed: args.removed.length > 0 ? args.removed : undefined,
      });
    }
    const fields = {
      atMs: args.atMs,
      horizonS: args.horizonS,
      generator: args.generator,
      lastSeq: seq,
      publishedAtMs: Date.now(),
    };
    if (meta) await ctx.db.patch(meta._id, fields);
    else await ctx.db.insert('trajectoryMeta', { singleton: 'meta', ...fields });
    return { seq };
  },
});

/** One-shot seed: every live curve + the bundle-level meta. */
export const fullSet = query({
  args: {},
  returns: v.object({
    vehicles: v.array(trajectoryVehicleValidator),
    meta: v.union(metaValidator, v.null()),
    seq: v.number(),
  }),
  handler: async (ctx) => {
    const meta = await readMeta(ctx);
    const rows = await ctx.db.query('trajectoryVehicles').collect();
    const vehicles: StoredTrajectoryVehicle[] = rows.map((r) => r.vehicle);
    return {
      vehicles,
      meta: meta
        ? {
            atMs: meta.atMs,
            horizonS: meta.horizonS,
            generator: meta.generator,
            lastSeq: meta.lastSeq,
            publishedAtMs: meta.publishedAtMs,
            serverNowMs: Date.now(),
          }
        : null,
      seq: meta?.lastSeq ?? 0,
    };
  },
});

/**
 * Bundle-level heartbeat — the ONE cheap subscription for staleness, clock
 * sync and the active generator. Refires on every publisher cycle (heartbeats
 * included, ~2 s), which is exactly what lets a client distinguish "predictor
 * alive, fleet quiet" from "predictor dead" without polling.
 */
export const meta = query({
  args: {},
  returns: v.union(metaValidator, v.null()),
  handler: async (ctx) => {
    const row = await readMeta(ctx);
    if (!row) return null;
    return {
      atMs: row.atMs,
      horizonS: row.horizonS,
      generator: row.generator,
      lastSeq: row.lastSeq,
      publishedAtMs: row.publishedAtMs,
      serverNowMs: Date.now(),
    };
  },
});

const MAX_TRAJ_BATCHES_PER_QUERY = 64;

/**
 * The trajectory diff stream. Deliberately does NOT read `trajectoryMeta`
 * beyond what the batches themselves imply — the singleton is written on every
 * publish (heartbeats included) and reading it here would wake every
 * subscriber on publications that changed nothing.
 */
export const batchesSince = query({
  args: { sinceSeq: v.number(), limit: v.optional(v.number()) },
  returns: v.object({
    batches: v.array(
      v.object({
        seq: v.number(),
        atMs: v.number(),
        changed: v.array(trajectoryVehicleValidator),
        removed: v.optional(v.array(v.string())),
      }),
    ),
    oldestSeq: v.union(v.number(), v.null()),
    latestSeq: v.union(v.number(), v.null()),
    /** Convex transaction clock at (re)execution — the clock-sync sample. */
    serverNowMs: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.min(MAX_TRAJ_BATCHES_PER_QUERY, args.limit ?? MAX_TRAJ_BATCHES_PER_QUERY);
    const rows = await ctx.db
      .query('trajectoryBatches')
      .withIndex('by_seq', (q) => q.gt('seq', args.sinceSeq))
      .order('asc')
      .take(limit);
    const oldestRow = await ctx.db.query('trajectoryBatches').withIndex('by_seq').order('asc').first();
    const latestRow = await ctx.db.query('trajectoryBatches').withIndex('by_seq').order('desc').first();
    return {
      batches: rows.map((r) => ({
        seq: r.seq,
        atMs: r.atMs,
        changed: r.changed,
        removed: r.removed,
      })),
      oldestSeq: oldestRow?.seq ?? null,
      latestSeq: latestRow?.seq ?? null,
      serverNowMs: Date.now(),
    };
  },
});

/** Retention sweep for the trajectory diff stream (crons.ts, every minute). */
export const sweepBatches = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - TRAJ_BATCH_RETENTION_MS;
    const rows = await ctx.db
      .query('trajectoryBatches')
      .withIndex('by_seq')
      .order('asc')
      .take(SWEEP_BATCH);
    let deleted = 0;
    for (const row of rows) {
      if (row.atMs >= cutoff) break; // by_seq is chronological — the rest is fresh
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return { deleted };
  },
});

/** Ghost-curve sweep: rows the predictor abandoned without a removal notice. */
export const sweepStaleVehicles = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const meta = await readMeta(ctx);
    if (!meta) return { deleted: 0 };
    const cutoff = meta.atMs - TRAJ_VEHICLE_STALE_MS;
    const rows = await ctx.db.query('trajectoryVehicles').take(SWEEP_BATCH);
    let deleted = 0;
    for (const row of rows) {
      if (row.vehicle.emittedAtMs < cutoff) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});
