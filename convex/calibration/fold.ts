// Streaming 24/7 calibration: fold fresh fix PAIRS into pace/dwell aggregates.
// backend-convex.md §4. Raw fixes are never stored — a pair exists only inside
// this transaction; what survives is the EWMA state of four small tables.
//
// The server sees every fix of every tram around the clock, so the aggregates
// grow without any client session and without the sampling bias of "whatever
// the phone happened to be watching".

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { fixPairValidator, type FixPair } from '../schema';
import { bucketAt, dayTypeAt, hourBandAt, proxyShapeKey, type DayType } from './keys';
import { regNumberToModelId } from './models';

// ── Gate constants (R13 moving-span semantics) ───────────────────────────────

/**
 * Cruise reference speed, m/s. Mirrors `V_CRUISE_REF_MS` in
 * src/lib/engine/speedProfile.ts — the denominator the engine's `paceBias` is
 * measured against, so a factor learned here is directly comparable to the
 * bias the client would have learned locally. KEEP THE TWO IN SYNC.
 */
export const CRUISE_REF_MS = 11.7;

/** Recency weighting of every aggregate: samples halve in weight in 14 days. */
export const EWMA_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** A span shorter than this in time is fix jitter, longer is an untracked gap. */
export const SPAN_MIN_GAP_S = 8;
export const SPAN_MAX_GAP_S = 240;

/** Below this the span is flat — standstill evidence, not a pace sample. */
export const SPAN_MIN_DIST_M = 15;

/**
 * Teleport-scale rejection for a SPAN.
 *
 * Deliberately NOT the engine's gap-aware `teleportThreshold()` (500–1500 m):
 * that threshold measures sim-vs-observation desync at one ingest, and a
 * legitimate 240 s moving span covers up to ~2.8 km — it would reject exactly
 * the long, clean, fast spans that carry the most pace signal. The physical
 * criterion is used instead: no Prague tram exceeds ~65 km/h, so an implied
 * speed above 22 m/s (≈79 km/h) is a distance discontinuity (shape reset,
 * trip re-assignment, bad feed value), never travel. Negative Δdist is
 * rejected for the same reason.
 */
export const SPAN_MAX_SPEED_MS = 22;

/** Guard rails on a single folded pace factor (mirrors PACE_BIAS_* ratios). */
export const FACTOR_MIN = 0.1;
export const FACTOR_MAX = 2.5;

/** An at_stop→at_stop span must be this flat to count as dwelling. */
export const DWELL_FLAT_M = 15;

/** Plausible bounds on one observed dwell run, seconds. */
export const DWELL_MIN_S = 5;
export const DWELL_MAX_S = 300;

// ── Time-decayed EWMA (West's weighted incremental mean/variance) ────────────

export interface EwmaState {
  mean: number;
  weight: number;
  s: number;
  n: number;
  updatedAtMs: number;
}

/** Weight remaining after half-life decay from `updatedAtMs` to `atMs`. */
export function decayFactor(updatedAtMs: number, atMs: number): number {
  const dt = Math.max(0, atMs - updatedAtMs);
  return Math.pow(0.5, dt / EWMA_HALF_LIFE_MS);
}

/** Effective (decayed) sample weight of a stat as of `atMs`. */
export function decayedWeight(state: EwmaState, atMs: number): number {
  return state.weight * decayFactor(state.updatedAtMs, atMs);
}

/**
 * Fold samples into a decayed EWMA. Decay is applied LAZILY — once per write,
 * from the stat's own `updatedAtMs` — so a stat that stops receiving samples
 * simply keeps its last state until it is read (`decayedWeight`) or pruned.
 */
export function foldSamples(
  prev: EwmaState | null,
  samples: readonly number[],
  atMs: number,
): EwmaState {
  const decay = prev ? decayFactor(prev.updatedAtMs, atMs) : 1;
  let mean = prev ? prev.mean : 0;
  let weight = prev ? prev.weight * decay : 0;
  let s = prev ? prev.s * decay : 0;
  const n = (prev ? prev.n : 0) + samples.length;
  for (const x of samples) {
    weight += 1;
    const d = x - mean;
    mean += d / weight;
    s += d * (x - mean);
  }
  return { mean, weight, s, n, updatedAtMs: atMs };
}

// ── Span classification ──────────────────────────────────────────────────────

type Span =
  | { kind: 'pace'; speedMs: number; midDistM: number }
  | { kind: 'dwell'; stopId: string }
  | { kind: 'excluded' };

/**
 * The R13 gate. A pair only becomes a pace sample when it is confidently
 * MOVING: no at_stop endpoint, a real distance travelled, a gap inside the
 * usable window, and no distance discontinuity. Everything else either becomes
 * dwell evidence or is dropped — signal standstills stop polluting pace by
 * construction, fleet-wide.
 */
export function classifySpan(pair: FixPair): Span {
  const { prev, next } = pair;
  const gapS = (next.observedAtMs - prev.observedAtMs) / 1000;
  if (!(gapS >= SPAN_MIN_GAP_S && gapS <= SPAN_MAX_GAP_S)) return { kind: 'excluded' };

  const dDist = next.shapeDistM - prev.shapeDistM;
  const atStop = prev.statePosition === 'at_stop' || next.statePosition === 'at_stop';

  if (atStop) {
    // Both endpoints at the same stop with a flat distance: a real dwell run.
    const flat = Math.abs(dDist) < DWELL_FLAT_M;
    const sameStop =
      prev.statePosition === 'at_stop' &&
      next.statePosition === 'at_stop' &&
      prev.nextStopId != null &&
      prev.nextStopId === next.nextStopId;
    if (flat && sameStop && prev.nextStopId != null) {
      return { kind: 'dwell', stopId: prev.nextStopId };
    }
    return { kind: 'excluded' };
  }

  if (dDist < SPAN_MIN_DIST_M) return { kind: 'excluded' };
  const speedMs = dDist / gapS;
  if (speedMs > SPAN_MAX_SPEED_MS) return { kind: 'excluded' };
  return { kind: 'pace', speedMs, midDistM: prev.shapeDistM + dDist / 2 };
}

// ── Accumulators ─────────────────────────────────────────────────────────────

interface SegmentBucketAcc {
  shapeId: string;
  bucket: number;
  hourBand: number;
  dayType: DayType;
  samples: number[];
}

interface StopBucketAcc {
  stopId: string;
  hourBand: number;
  dayType: DayType;
  samples: number[];
}

interface DwellRun {
  stopId: string;
  startMs: number;
  lastMs: number;
}

function clampFactor(x: number): number {
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, x));
}

/**
 * Fold one poll's fresh fix pairs.
 *
 * Scheduled (never awaited) by `ingest.applyPoll`, so a calibration failure can
 * never stall or fail the feed path.
 */
export const foldPairs = internalMutation({
  args: { atMs: v.number(), pairs: v.array(fixPairValidator) },
  returns: v.object({
    paceSamples: v.number(),
    dwellRuns: v.number(),
    segments: v.number(),
  }),
  handler: async (ctx, { atMs, pairs }) => {
    if (pairs.length === 0) {
      return { paceSamples: 0, dwellRuns: 0, segments: 0 };
    }

    // Resolve trip → shape once per distinct trip (see keys.proxyShapeKey for
    // why a proxy is used until `geometries` is populated).
    const tripIds = [...new Set(pairs.map((p) => p.tripId))];
    const shapeByTrip = new Map<string, string>();
    await Promise.all(
      tripIds.map(async (tripId) => {
        const geo = await ctx.db
          .query('geometries')
          .withIndex('by_trip', (q) => q.eq('tripId', tripId))
          .first();
        if (geo) shapeByTrip.set(tripId, geo.shapeId);
      }),
    );

    const byVehicle = new Map<string, FixPair[]>();
    for (const pair of pairs) {
      const list = byVehicle.get(pair.key);
      if (list) list.push(pair);
      else byVehicle.set(pair.key, [pair]);
    }

    const segAcc = new Map<string, SegmentBucketAcc>();
    const stopAcc = new Map<string, StopBucketAcc>();
    const modelAcc = new Map<string, number[]>();
    let paceSamples = 0;
    let dwellRuns = 0;

    const keys = [...byVehicle.keys()];
    const vehicleDocs = await Promise.all(
      keys.map((key) =>
        ctx.db
          .query('vehicleStats')
          .withIndex('by_key', (q) => q.eq('key', key))
          .first(),
      ),
    );

    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const doc = vehicleDocs[i];
      const vehiclePairs = (byVehicle.get(key) ?? []).sort(
        (a, b) => a.prev.observedAtMs - b.prev.observedAtMs,
      );
      const model = regNumberToModelId(vehiclePairs[0].registrationNumber);

      let run: DwellRun | null =
        doc?.runStopId != null && doc.runStartMs != null && doc.runLastMs != null
          ? { stopId: doc.runStopId, startMs: doc.runStartMs, lastMs: doc.runLastMs }
          : null;

      const flushRun = (finished: DwellRun) => {
        const dwellS = (finished.lastMs - finished.startMs) / 1000;
        // The observed run is a LOWER BOUND on the real dwell: arrival and
        // departure both fall between AVL fixes (cadence ~15–50 s), so the
        // learned budget is conservative by up to one cadence. Documented
        // rather than corrected — a fabricated correction would be unfalsifiable.
        if (dwellS < DWELL_MIN_S || dwellS > DWELL_MAX_S) return;
        const band = hourBandAt(finished.startMs);
        const day = dayTypeAt(finished.startMs);
        const stopKey = `${finished.stopId}|${band}|${day}`;
        const acc = stopAcc.get(stopKey);
        if (acc) acc.samples.push(dwellS);
        else {
          stopAcc.set(stopKey, {
            stopId: finished.stopId,
            hourBand: band,
            dayType: day,
            samples: [dwellS],
          });
        }
        dwellRuns += 1;
      };

      const factorSamples: number[] = [];

      for (const pair of vehiclePairs) {
        const span = classifySpan(pair);
        if (span.kind === 'dwell') {
          if (run && run.stopId === span.stopId) {
            run.lastMs = pair.next.observedAtMs;
          } else {
            if (run) flushRun(run);
            run = {
              stopId: span.stopId,
              startMs: pair.prev.observedAtMs,
              lastMs: pair.next.observedAtMs,
            };
          }
          continue;
        }

        // Any non-dwell span (moving OR excluded) ends an open run: past that
        // point the vehicle's standstill is no longer observed continuously.
        if (run) {
          flushRun(run);
          run = null;
        }
        if (span.kind !== 'pace') continue;

        paceSamples += 1;
        factorSamples.push(clampFactor(span.speedMs / CRUISE_REF_MS));

        const shapeId =
          shapeByTrip.get(pair.tripId) ?? proxyShapeKey(pair.routeId, pair.headsign);
        const bucket = bucketAt(span.midDistM);
        const band = hourBandAt(pair.next.observedAtMs);
        const day = dayTypeAt(pair.next.observedAtMs);
        const segKey = `${shapeId}|${bucket}|${band}|${day}`;
        const acc = segAcc.get(segKey);
        if (acc) acc.samples.push(span.speedMs);
        else {
          segAcc.set(segKey, {
            shapeId,
            bucket,
            hourBand: band,
            dayType: day,
            samples: [span.speedMs],
          });
        }
      }

      if (factorSamples.length > 0) {
        const list = modelAcc.get(model);
        if (list) list.push(...factorSamples);
        else modelAcc.set(model, [...factorSamples]);
      }

      // Persist the vehicle prior + the (possibly still open) dwell run.
      const runFields = {
        runStopId: run ? run.stopId : null,
        runStartMs: run ? run.startMs : 0,
        runLastMs: run ? run.lastMs : 0,
      };
      if (doc == null) {
        const folded = foldSamples(null, factorSamples, atMs);
        await ctx.db.insert('vehicleStats', { key, model, ...folded, ...runFields });
      } else if (factorSamples.length > 0) {
        const folded = foldSamples(doc, factorSamples, atMs);
        await ctx.db.patch(doc._id, { model, ...folded, ...runFields });
      } else {
        // No samples: never touch mean/weight/updatedAtMs — bumping the decay
        // clock without folding anything would silently erode the stat.
        await ctx.db.patch(doc._id, { model, ...runFields });
      }
    }

    // ── Aggregate writes (one read+write per distinct cell per fold) ─────────
    for (const acc of segAcc.values()) {
      const existing = await ctx.db
        .query('segmentStats')
        .withIndex('by_segment', (q) =>
          q
            .eq('shapeId', acc.shapeId)
            .eq('bucket', acc.bucket)
            .eq('hourBand', acc.hourBand)
            .eq('dayType', acc.dayType),
        )
        .first();
      const folded = foldSamples(existing, acc.samples, atMs);
      if (existing) await ctx.db.patch(existing._id, folded);
      else {
        await ctx.db.insert('segmentStats', {
          shapeId: acc.shapeId,
          bucket: acc.bucket,
          hourBand: acc.hourBand,
          dayType: acc.dayType,
          ...folded,
        });
      }
    }

    for (const acc of stopAcc.values()) {
      const existing = await ctx.db
        .query('stopStats')
        .withIndex('by_stop', (q) =>
          q.eq('stopId', acc.stopId).eq('hourBand', acc.hourBand).eq('dayType', acc.dayType),
        )
        .first();
      const folded = foldSamples(existing, acc.samples, atMs);
      if (existing) await ctx.db.patch(existing._id, folded);
      else {
        await ctx.db.insert('stopStats', {
          stopId: acc.stopId,
          hourBand: acc.hourBand,
          dayType: acc.dayType,
          ...folded,
        });
      }
    }

    for (const [model, samples] of modelAcc) {
      const existing = await ctx.db
        .query('modelStats')
        .withIndex('by_model', (q) => q.eq('model', model))
        .first();
      const folded = foldSamples(existing, samples, atMs);
      if (existing) await ctx.db.patch(existing._id, folded);
      else await ctx.db.insert('modelStats', { model, ...folded });
    }

    return { paceSamples, dwellRuns, segments: segAcc.size };
  },
});

/** Below this decayed weight a cell carries no usable signal any more. */
export const PRUNE_MIN_WEIGHT = 0.25;
/** …and it must also have been untouched for this long before deletion. */
export const PRUNE_MIN_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** Bound on one sweep so the mutation always fits in a transaction. */
export const PRUNE_BATCH = 512;

/**
 * Daily garbage collection for decayed-out cells (crons.ts).
 *
 * Decay itself is lazy (applied on write), so this sweep exists only to stop
 * dead segments/stops/vehicles — a shape variant retired months ago, a scrapped
 * tram — from accumulating forever and inflating the bundle scan.
 */
export const pruneStale = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), scanned: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - PRUNE_MIN_AGE_MS;
    let deleted = 0;
    let scanned = 0;

    for (const table of ['segmentStats', 'stopStats', 'vehicleStats'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_updated', (q) => q.lt('updatedAtMs', cutoff))
        .take(PRUNE_BATCH);
      scanned += rows.length;
      for (const row of rows) {
        if (decayedWeight(row, now) >= PRUNE_MIN_WEIGHT) continue;
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return { deleted, scanned };
  },
});
