// Hourly compaction of the live calibration stats into the client-facing
// bundle (backend-convex.md §4, "Bundle").
//
// Two disciplines from the calibration program (RUNBOOK §5) are load-bearing
// here and are the reason this is not a straight dump of the stats tables:
//
//   • MINIMUM-SAMPLE FLOORS — a cell with three samples is noise wearing the
//     costume of a measurement. Below the floor the cell is simply not emitted
//     and the client falls back to the parent level.
//   • SHRINKAGE toward the parent (vehicle → model → fleet, segment → shape →
//     fleet, stop → fleet). A thin cell is pulled most of the way back to its
//     parent; only a cell with real weight is allowed to move far from it.
//     This is the "per-vehicle/per-segment split lands as an L2-shrunk factor,
//     never a hardcoded exception" rule, applied continuously.

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { CRUISE_REF_MS, decayedWeight } from './fold';
import { SEGMENT_BUCKET_M } from './keys';

// ── Floors: (raw lifetime samples, decayed weight) a cell must clear ─────────
export const MIN_VEHICLE_N = 24;
export const MIN_VEHICLE_WEIGHT = 8;
export const MIN_MODEL_N = 200;
export const MIN_MODEL_WEIGHT = 40;
export const MIN_SEGMENT_N = 12;
export const MIN_SEGMENT_WEIGHT = 4;
export const MIN_STOP_N = 8;
export const MIN_STOP_WEIGHT = 3;

// ── Shrinkage strengths (pseudo-samples of the parent mixed into a cell) ─────
export const VEHICLE_SHRINK_K = 24;
export const MODEL_SHRINK_K = 80;
export const SHAPE_SHRINK_K = 24;
export const SEGMENT_SHRINK_K = 8;
export const STOP_SHRINK_K = 6;

// ── Size caps. The bundle ships to every client on connect, so it is bounded
// by construction: the highest-weight cells win, everything else falls back to
// its parent. Rounding (below) is part of the size budget, not cosmetics.
// MAX_VEHICLES must stay ≤ 1000: `vehicleBias` is ONE Convex object and the
// platform hard-caps objects at 1024 entries — at 1025 qualifying vehicles the
// hourly compact would throw on every run and the bundle would silently freeze.
export const MAX_VEHICLES = 1000;
export const MAX_SEGMENTS = 1000;
export const MAX_STOPS = 1000;

// Read bounds — a mutation cannot scan an unbounded table. `by_updated`
// descending puts the freshest cells first, which are exactly the ones a
// weight-ranked bundle would keep anyway. Their SUM must stay comfortably
// under Convex's 16,384-documents-read-per-transaction limit (the old
// 8000+4000+4000 left ~2% headroom — one more read path added later would
// have tipped compaction into a hard failure every hour).
export const SEGMENT_SCAN = 6000;
export const STOP_SCAN = 3000;
export const VEHICLE_SCAN = 3000;

/** Fleet-level dwell fallback (s) before any stop has cleared its floor. */
export const DEFAULT_DWELL_S = 18;

/** Refuse to publish a bundle built on this little evidence. */
export const MIN_FLEET_WEIGHT = 50;

/** Pull `mean` toward `parent` in proportion to how thin its evidence is. */
export function shrink(mean: number, weight: number, parent: number, k: number): number {
  return (mean * weight + parent * k) / (weight + k);
}

function round(x: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

function weightedMean(rows: { mean: number; w: number }[], fallback: number): number {
  let sw = 0;
  let sx = 0;
  for (const r of rows) {
    sw += r.w;
    sx += r.mean * r.w;
  }
  return sw > 0 ? sx / sw : fallback;
}

/**
 * Compact `segmentStats`/`modelStats`/`vehicleStats`/`stopStats` into the
 * `bundles` singleton. Hourly cron; also runnable by hand while iterating.
 */
export const compact = internalMutation({
  args: {},
  returns: v.object({
    published: v.boolean(),
    version: v.number(),
    segments: v.number(),
    stops: v.number(),
    vehicles: v.number(),
    models: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();

    const modelRows = await ctx.db.query('modelStats').collect();
    const modelWeighted = modelRows.map((r) => ({
      model: r.model,
      mean: r.mean,
      n: r.n,
      w: decayedWeight(r, now),
    }));
    const fleetWeight = modelWeighted.reduce((acc, r) => acc + r.w, 0);
    const fleetFactor = weightedMean(modelWeighted, 1);

    const previous = await ctx.db
      .query('bundles')
      .withIndex('by_singleton', (q) => q.eq('singleton', 'latest'))
      .first();
    const version = (previous?.version ?? 0) + 1;

    if (fleetWeight < MIN_FLEET_WEIGHT) {
      // Publishing a bundle built on a handful of spans would seed every client
      // with noise. Staying silent leaves the engine on its own priors.
      return {
        published: false,
        version: previous?.version ?? 0,
        segments: 0,
        stops: 0,
        vehicles: 0,
        models: 0,
      };
    }

    // ── models → fleet ──────────────────────────────────────────────────────
    const modelBias: Record<string, number> = {};
    for (const r of modelWeighted) {
      if (r.n < MIN_MODEL_N || r.w < MIN_MODEL_WEIGHT) continue;
      modelBias[r.model] = round(shrink(r.mean, r.w, fleetFactor, MODEL_SHRINK_K), 3);
    }

    // ── vehicles → model → fleet ────────────────────────────────────────────
    const vehicleRows = await ctx.db
      .query('vehicleStats')
      .withIndex('by_updated')
      .order('desc')
      .take(VEHICLE_SCAN);
    const vehicleCandidates = vehicleRows
      .map((r) => ({ key: r.key, model: r.model, mean: r.mean, n: r.n, w: decayedWeight(r, now) }))
      .filter((r) => r.n >= MIN_VEHICLE_N && r.w >= MIN_VEHICLE_WEIGHT)
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_VEHICLES);
    const vehicleBias: Record<string, number> = {};
    for (const r of vehicleCandidates) {
      const parent = modelBias[r.model] ?? fleetFactor;
      vehicleBias[r.key] = round(shrink(r.mean, r.w, parent, VEHICLE_SHRINK_K), 3);
    }

    // ── segments → shape → fleet ────────────────────────────────────────────
    const segmentRows = await ctx.db
      .query('segmentStats')
      .withIndex('by_updated')
      .order('desc')
      .take(SEGMENT_SCAN);
    const segments = segmentRows.map((r) => ({
      shapeId: r.shapeId,
      bucket: r.bucket,
      hourBand: r.hourBand,
      dayType: r.dayType,
      mean: r.mean,
      n: r.n,
      w: decayedWeight(r, now),
    }));
    const fleetPaceMs = weightedMean(segments, fleetFactor * CRUISE_REF_MS);

    const byShape = new Map<string, { mean: number; w: number }[]>();
    for (const s of segments) {
      const list = byShape.get(s.shapeId);
      if (list) list.push(s);
      else byShape.set(s.shapeId, [s]);
    }
    const shapePace = new Map<string, number>();
    for (const [shapeId, rows] of byShape) {
      const raw = weightedMean(rows, fleetPaceMs);
      const w = rows.reduce((acc, r) => acc + r.w, 0);
      shapePace.set(shapeId, shrink(raw, w, fleetPaceMs, SHAPE_SHRINK_K));
    }

    const segmentOut = segments
      .filter((s) => s.n >= MIN_SEGMENT_N && s.w >= MIN_SEGMENT_WEIGHT)
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_SEGMENTS)
      .map((s) => ({
        shapeId: s.shapeId,
        fromM: s.bucket * SEGMENT_BUCKET_M,
        toM: (s.bucket + 1) * SEGMENT_BUCKET_M,
        hourBand: s.hourBand,
        dayType: s.dayType,
        paceMs: round(
          shrink(s.mean, s.w, shapePace.get(s.shapeId) ?? fleetPaceMs, SEGMENT_SHRINK_K),
          2,
        ),
        n: s.n,
      }));

    // ── stops → fleet ───────────────────────────────────────────────────────
    const stopRows = await ctx.db
      .query('stopStats')
      .withIndex('by_updated')
      .order('desc')
      .take(STOP_SCAN);
    const stops = stopRows.map((r) => ({
      stopId: r.stopId,
      hourBand: r.hourBand,
      dayType: r.dayType,
      mean: r.mean,
      n: r.n,
      w: decayedWeight(r, now),
    }));
    const fleetDwellS = weightedMean(stops, DEFAULT_DWELL_S);
    const stopOut = stops
      .filter((s) => s.n >= MIN_STOP_N && s.w >= MIN_STOP_WEIGHT)
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_STOPS)
      .map((s) => ({
        stopId: s.stopId,
        hourBand: s.hourBand,
        dayType: s.dayType,
        dwellS: round(shrink(s.mean, s.w, fleetDwellS, STOP_SHRINK_K), 1),
        n: s.n,
      }));

    const doc = {
      singleton: 'latest' as const,
      version,
      generatedAtMs: now,
      fleetFactor: round(fleetFactor, 3),
      fleetPaceMs: round(fleetPaceMs, 2),
      fleetDwellS: round(fleetDwellS, 1),
      vehicleBias,
      modelBias,
      segments: segmentOut,
      stops: stopOut,
    };
    if (previous) await ctx.db.replace(previous._id, doc);
    else await ctx.db.insert('bundles', doc);

    return {
      published: true,
      version,
      segments: segmentOut.length,
      stops: stopOut.length,
      vehicles: vehicleCandidates.length,
      models: Object.keys(modelBias).length,
    };
  },
});
