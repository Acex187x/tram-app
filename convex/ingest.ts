// Poll ingestion: diff the fleet, publish a batch, retire vanished trams, and
// hand the fresh fix pairs to the calibration folder (backend-convex.md §2).
//
// The diff is the whole point of the table layout: at ~2 s polls most vehicles
// are byte-identical from one poll to the next (AVL fixes arrive every ~15–50 s
// per tram), and rewriting an unchanged row would wake every subscription for
// nothing. A poll that changes nothing writes nothing but the heartbeat.

import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { snapshotValidator, type FixPair, type StoredSnapshot } from './schema';

/** A vehicle absent from the feed this long is retired from the fleet mirror. */
export const STALE_AFTER_MS = 90_000;

/**
 * How stale `seenAtMs` may get on an otherwise unchanged vehicle before we pay
 * one write to refresh it. Must stay well below STALE_AFTER_MS.
 */
export const SEEN_TOUCH_MS = 45_000;

/** Batch rows are kept this long — enough for a client to resume a blip. */
export const BATCH_RETENTION_MS = 10 * 60_000;

/** Upper bound on deletions per mutation so a sweep always fits a transaction. */
export const SWEEP_BATCH = 256;

/**
 * Pairs per scheduled `foldPairs` call. Steady state produces tens of pairs per
 * poll, but the first poll after an outage can carry a fresh fix for the whole
 * fleet (~450) — folded in one mutation that risks the 1 s execution budget
 * (one indexed read + patch per vehicle). Chunking keeps every fold small; the
 * chunks are per-vehicle-disjoint (pairs are one-per-vehicle within a poll), so
 * splitting cannot tear a vehicle's dwell-run accumulator.
 */
export const FOLD_CHUNK = 128;

async function pollerState(ctx: MutationCtx) {
  return await ctx.db
    .query('pollerState')
    .withIndex('by_singleton', (q) => q.eq('singleton', 'poller'))
    .first();
}

/**
 * Has this observation actually moved?
 *
 * Per the design: changed iff `observedAtMs` advanced, or `shapeDistM`/`tripId`
 * changed. The one refinement is a regression guard — an observation OLDER than
 * the stored one is a stale CDN object being replayed (s-maxage=5 on a ~2 s
 * poll makes that routine), and accepting its distance would drag the tram
 * backwards. Such a record is treated as unchanged, not as a change.
 */
export function isChanged(prev: StoredSnapshot | null, next: StoredSnapshot): boolean {
  if (prev == null) return true;
  if (next.observedAtMs > prev.observedAtMs) return true;
  if (next.observedAtMs < prev.observedAtMs) return false;
  return next.shapeDistM !== prev.shapeDistM || next.tripId !== prev.tripId;
}

/**
 * Apply one poll of the citywide feed.
 *
 * Called by `poller.pollLoop` with the already-normalized snapshots — the same
 * shared pure normalization the client runs (src/lib/golemio/normalize.ts), so
 * server and app can never drift into two dialects of "a valid tram fix".
 */
export const applyPoll = internalMutation({
  args: {
    generation: v.number(),
    atMs: v.number(),
    snapshots: v.array(snapshotValidator),
    rejected: v.record(v.string(), v.number()),
    rejectedTotal: v.number(),
  },
  returns: v.object({
    stale: v.boolean(),
    generation: v.number(),
    seq: v.number(),
    changed: v.number(),
    retired: v.number(),
    pairs: v.number(),
  }),
  handler: async (ctx, args) => {
    const state = await pollerState(ctx);
    if (state == null || state.generation !== args.generation) {
      // A newer generation owns the poller (restart/watchdog). Report staleness
      // so the calling loop exits instead of double-polling forever.
      return {
        stale: true,
        generation: state?.generation ?? 0,
        seq: state?.lastSeq ?? 0,
        changed: 0,
        retired: 0,
        pairs: 0,
      };
    }

    const { atMs } = args;
    // Dedupe by key (last wins): a data error putting one registration number
    // on two features would otherwise insert duplicate `vehicles` rows, and
    // `by_key.first()` would flip between them on every later poll.
    const byKey = new Map<string, StoredSnapshot>();
    for (const s of args.snapshots) byKey.set(s.key, s);
    const snapshots = [...byKey.values()];
    const existing = await Promise.all(
      snapshots.map((s) =>
        ctx.db
          .query('vehicles')
          .withIndex('by_key', (q) => q.eq('key', s.key))
          .first(),
      ),
    );

    const seq = state.lastSeq + 1;
    const changed: StoredSnapshot[] = [];
    const pairs: FixPair[] = [];
    const touches: Id<'vehicles'>[] = [];

    for (let i = 0; i < snapshots.length; i += 1) {
      const next = snapshots[i];
      const doc = existing[i];
      const prev = doc?.snapshot ?? null;
      if (!isChanged(prev, next)) {
        // Present but unmoved: refresh the presence clock only when it has gone
        // stale enough to matter for the retirement sweep.
        if (doc && atMs - doc.seenAtMs >= SEEN_TOUCH_MS) touches.push(doc._id);
        continue;
      }
      changed.push(next);
      if (doc) {
        await ctx.db.patch(doc._id, { snapshot: next, updatedSeq: seq, seenAtMs: atMs });
      } else {
        await ctx.db.insert('vehicles', {
          key: next.key,
          snapshot: next,
          updatedSeq: seq,
          seenAtMs: atMs,
        });
      }
      // A calibration pair needs a genuinely FRESH fix on both ends: same trip,
      // and the fix clock actually advanced (a distance-only change with an
      // identical timestamp carries no measurable span).
      if (prev && next.observedAtMs > prev.observedAtMs && prev.tripId === next.tripId) {
        pairs.push({
          key: next.key,
          registrationNumber: next.registrationNumber,
          tripId: next.tripId,
          routeId: next.routeId,
          headsign: next.headsign,
          prev: {
            shapeDistM: prev.shapeDistM,
            observedAtMs: prev.observedAtMs,
            statePosition: prev.statePosition,
            nextStopId: prev.nextStopId,
            nextStopSequence: prev.nextStopSequence,
          },
          next: {
            shapeDistM: next.shapeDistM,
            observedAtMs: next.observedAtMs,
            statePosition: next.statePosition,
            nextStopId: next.nextStopId,
            nextStopSequence: next.nextStopSequence,
          },
        });
      }
    }

    for (const id of touches) await ctx.db.patch(id, { seenAtMs: atMs });

    // Retire trams that have dropped out of the feed entirely — BEFORE the
    // batch row is written, so their keys ride the diff stream as `removed`.
    // Otherwise every client keeps the ghost until its 5-minute re-seed.
    const stale = await ctx.db
      .query('vehicles')
      .withIndex('by_seen', (q) => q.lt('seenAtMs', atMs - STALE_AFTER_MS))
      .take(SWEEP_BATCH);
    const removed: string[] = [];
    for (const row of stale) {
      await ctx.db.delete(row._id);
      removed.push(row.key);
    }

    const hasBatch = changed.length > 0 || removed.length > 0;
    if (hasBatch) {
      await ctx.db.insert('batches', {
        seq,
        atMs,
        changed,
        ...(removed.length > 0 ? { removed } : {}),
      });
    }

    const rejectedByReason = { ...state.rejectedByReason };
    for (const [reason, count] of Object.entries(args.rejected)) {
      rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + count;
    }

    await ctx.db.patch(state._id, {
      lastPollAtMs: atMs,
      lastOkAtMs: atMs,
      lastSeq: hasBatch ? seq : state.lastSeq,
      consecutiveFailures: 0,
      authFailed: false,
      lastError: null,
      fleetSize: snapshots.length,
      rejectedTotal: state.rejectedTotal + args.rejectedTotal,
      rejectedByReason,
    });

    // Scheduled, never awaited: calibration must never be able to stall or
    // fail the feed path. Chunked so a post-outage whole-fleet poll cannot
    // push one oversized fold mutation into the execution budget.
    for (let i = 0; i < pairs.length; i += FOLD_CHUNK) {
      await ctx.scheduler.runAfter(0, internal.calibration.fold.foldPairs, {
        atMs,
        pairs: pairs.slice(i, i + FOLD_CHUNK),
      });
    }

    return {
      stale: false,
      generation: state.generation,
      seq: hasBatch ? seq : state.lastSeq,
      changed: changed.length,
      retired: stale.length,
      pairs: pairs.length,
    };
  },
});

/**
 * Retention sweep for the diff stream (1 min cron). Batch rows exist only to
 * let a briefly disconnected client resume without re-seeding the whole fleet;
 * past BATCH_RETENTION_MS a resume falls back to `stream.fullFleet` anyway.
 */
export const sweepBatches = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - BATCH_RETENTION_MS;
    const rows = await ctx.db
      .query('batches')
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
