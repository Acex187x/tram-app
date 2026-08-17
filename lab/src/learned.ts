// The "learned" predictor family — the hypotheses under test.
//
// A deliberately transparent, closed-form predictor whose every coefficient is
// a small learned statistic (docs/research/prediction-architecture.md §7.2).
// It learns online from consecutive fix pairs with the same R13 gating the
// server calibration uses (convex/calibration/fold.ts — constants mirrored in
// config.ts), and predicts by walking the shape: hold at the anchored stop for
// a LEARNED release time, then advance bucket by bucket at LEARNED pace,
// spending LEARNED dwell at each intermediate stop.
//
// Three variants share the walk and differ only in the surface:
//   learned       — slow surfaces only (14-day half-life EWMA)
//   learned-fast  — slow surface × CORRIDOR RESIDUAL: a ~12-min-half-life
//                   ratio of recently-measured vs expected pace per 1 km of
//                   shape — the plan's phase-2 "leader as congestion sensor"
//   learned-2h    — two-hypothesis stop release: expected position =
//                   (1-p)·standing + p·departed, p from the learned release
//                   distribution (mean+variance are already in the cells)
//
// Slow-pace fallback chain (finest trusted cell wins):
//   seg(shape|bucket|band|day) → segShape(shape|bucket) → route(route|band)
//   → global(band) → DEFAULT_PACE_MS.

import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import {
  DEFAULT_DWELL_S,
  DEFAULT_PACE_MS,
  DEFAULT_RELEASE_S,
  DWELL_FLAT_M,
  DWELL_MAX_S,
  DWELL_MIN_S,
  EWMA_HALF_LIFE_MS,
  FEED_LATENCY_MS,
  MIN_CELL_WEIGHT,
  RELEASE_MAX_S,
  RELEASE_MIN_S,
  SEG_BUCKET_M,
  SPAN_MAX_GAP_S,
  SPAN_MAX_SPEED_MS,
  SPAN_MIN_DIST_M,
  SPAN_MIN_GAP_S,
  dayType,
  hourBand,
} from './config';
import type { Store } from './db';

/** Fast corridor residual: half-life and trust/clamp bounds. */
export const CORRIDOR_HALF_LIFE_MS = 12 * 60 * 1000;
export const CORRIDOR_MIN_WEIGHT = 1.5;
export const CORRIDOR_CLAMP: [number, number] = [0.5, 1.6];
const CORRIDOR_M = 1000;

export interface Ewma {
  mean: number;
  weight: number;
  s: number;
  n: number;
  updatedAtMs: number;
}

/** West's weighted incremental mean/variance with lazy half-life decay —
 * the same fold the server calibration uses (convex/calibration/fold.ts). */
export function foldSample(prev: Ewma | null, x: number, atMs: number, halfLifeMs = EWMA_HALF_LIFE_MS): Ewma {
  const decay = prev ? Math.pow(0.5, Math.max(0, atMs - prev.updatedAtMs) / halfLifeMs) : 1;
  let mean = prev ? prev.mean : 0;
  let weight = prev ? prev.weight * decay : 0;
  let s = prev ? prev.s * decay : 0;
  weight += 1;
  const d = x - mean;
  mean += d / weight;
  s += d * (x - mean);
  return { mean, weight, s, n: (prev ? prev.n : 0) + 1, updatedAtMs: atMs };
}

export interface Anchor {
  s0: number;
  t0Ms: number; // observedAtMs + FEED_LATENCY_MS
  tripId: string;
  atStop: boolean;
  nextStopId: string | null;
  /** Seconds this vehicle had ALREADY been observed standing at this stop
   * before the anchor fix — the remaining hold is release − standingS. */
  standingS: number;
}

interface DwellRun {
  stopId: string;
  startMs: number;
  lastMs: number;
}

const TABLES = ['seg', 'segShape', 'route', 'global', 'stopDwell', 'stopRelease', 'corridor', 'corridorPace'] as const;
type Table = (typeof TABLES)[number];

export type LearnedVariant = 'learned' | 'learned-fast' | 'learned-2h';

export class LearnedModel {
  private cells = new Map<Table, Map<string, Ewma>>(new Map(TABLES.map((t) => [t, new Map()])));
  private dirty = new Map<Table, Set<string>>(new Map(TABLES.map((t) => [t, new Set()])));
  private anchors = new Map<string, Anchor>();
  private runs = new Map<string, DwellRun>();
  paceSamples = 0;
  dwellSamples = 0;
  releaseSamples = 0;

  constructor(private store: Store) {
    for (const row of store.loadCells()) {
      const m = this.cells.get(row.tbl as Table);
      if (m) m.set(row.cellKey, { mean: row.mean, weight: row.weight, s: row.s, n: row.n, updatedAtMs: row.updatedAtMs });
    }
    const meta = store.getMeta('learned-counters');
    if (meta) {
      try {
        const c = JSON.parse(meta) as { pace: number; dwell: number; release: number };
        this.paceSamples = c.pace;
        this.dwellSamples = c.dwell;
        this.releaseSamples = c.release;
      } catch {
        /* fresh counters */
      }
    }
  }

  private fold(tbl: Table, key: string, x: number, atMs: number, halfLifeMs = EWMA_HALF_LIFE_MS): void {
    const m = this.cells.get(tbl)!;
    m.set(key, foldSample(m.get(key) ?? null, x, atMs, halfLifeMs));
    this.dirty.get(tbl)!.add(key);
  }

  private cell(tbl: Table, key: string): Ewma | undefined {
    return this.cells.get(tbl)!.get(key);
  }

  private trusted(tbl: Table, key: string, minWeight: number, atMs: number, halfLifeMs = EWMA_HALF_LIFE_MS): number | null {
    const c = this.cell(tbl, key);
    if (!c) return null;
    const decayed = c.weight * Math.pow(0.5, Math.max(0, atMs - c.updatedAtMs) / halfLifeMs);
    return decayed >= minWeight ? c.mean : null;
  }

  cellCount(tbl: Table): number {
    return this.cells.get(tbl)!.size;
  }

  // ── learning ───────────────────────────────────────────────────────────────

  /** Fold one consecutive-fix pair (same vehicle, same trip). */
  update(prev: TramSnapshot, next: TramSnapshot, geom: RouteGeometry | undefined): void {
    const gapS = (next.observedAtMs - prev.observedAtMs) / 1000;
    if (!(gapS >= SPAN_MIN_GAP_S && gapS <= SPAN_MAX_GAP_S)) {
      this.endRun(prev.key);
      return;
    }
    const atMs = next.observedAtMs;
    const dDist = next.shapeDistM - prev.shapeDistM;
    const prevAtStop = prev.statePosition === 'at_stop';
    const nextAtStop = next.statePosition === 'at_stop';

    if (prevAtStop && nextAtStop) {
      const sameStop = prev.nextStopId != null && prev.nextStopId === next.nextStopId;
      if (sameStop && Math.abs(dDist) < DWELL_FLAT_M) {
        const run = this.runs.get(prev.key);
        if (run && run.stopId === prev.nextStopId) run.lastMs = next.observedAtMs;
        else {
          this.endRun(prev.key);
          this.runs.set(prev.key, { stopId: prev.nextStopId!, startMs: prev.observedAtMs, lastMs: next.observedAtMs });
        }
      } else this.endRun(prev.key);
      return;
    }

    if (prevAtStop && !nextAtStop) {
      // Release: time from an at_stop observation until the tram is next seen
      // moving. The RAW gap overstates the remaining hold — it includes the
      // travel time between the real departure and the next fix. The v0
      // estimator folded the raw gap and learned the AVL sticky-hold artifact
      // (~50 s) instead of the real ~17 s dwell, dragging the learned variant
      // behind reality (finding 2026-08-09, README §Findings). R13-style
      // clip-not-drop: deduct the moving portion at the expected pace.
      if (prev.nextStopId != null && gapS >= RELEASE_MIN_S && gapS <= RELEASE_MAX_S) {
        const shapeId = geom?.shapeId ?? `trip:${next.tripId}`;
        const pace = Math.max(1, this.paceAt(shapeId, next.routeId, prev.shapeDistM + Math.max(0, dDist) / 2, atMs));
        const travelS = Math.max(0, dDist) / pace;
        const holdS = Math.min(RELEASE_MAX_S, Math.max(2, gapS - travelS));
        this.fold('stopRelease', stopKey(prev.nextStopId, atMs), holdS, atMs);
        this.releaseSamples++;
      }
      this.endRun(prev.key);
      return;
    }

    this.endRun(prev.key);
    if (nextAtStop) return; // moving→at_stop: endpoint pollutes pace (R13)
    if (dDist < SPAN_MIN_DIST_M) return;
    const speed = dDist / gapS;
    if (speed > SPAN_MAX_SPEED_MS) return;

    const shapeId = geom?.shapeId ?? `trip:${next.tripId}`;
    const midS = prev.shapeDistM + dDist / 2;
    const bucket = Math.floor(midS / SEG_BUCKET_M);
    const band = hourBand(atMs);
    const day = dayType(atMs);

    // Corridor residual folds the ratio vs the PRE-UPDATE slow expectation —
    // "how is this km running right now, relative to how it usually runs".
    const expected = this.paceAt(shapeId, next.routeId, midS, atMs);
    const ratio = Math.min(2.5, Math.max(0.3, speed / Math.max(0.5, expected)));
    this.fold('corridor', `${shapeId}|${Math.floor(midS / CORRIDOR_M)}`, ratio, atMs, CORRIDOR_HALF_LIFE_MS);
    // Absolute recent pace of this km of track (any vehicle = the leader
    // signal), for the ML feature contract v2.
    this.fold('corridorPace', `${shapeId}|${Math.floor(midS / CORRIDOR_M)}`, speed, atMs, CORRIDOR_HALF_LIFE_MS);

    this.fold('seg', `${shapeId}|${bucket}|${band}|${day}`, speed, atMs);
    this.fold('segShape', `${shapeId}|${bucket}`, speed, atMs);
    this.fold('route', `${next.routeId}|${band}`, speed, atMs);
    this.fold('global', `${band}`, speed, atMs);
    this.paceSamples++;
  }

  private endRun(key: string): void {
    const run = this.runs.get(key);
    if (!run) return;
    this.runs.delete(key);
    const dwellS = (run.lastMs - run.startMs) / 1000;
    if (dwellS < DWELL_MIN_S || dwellS > DWELL_MAX_S) return;
    this.fold('stopDwell', stopKey(run.stopId, run.startMs), dwellS, run.startMs);
    this.dwellSamples++;
  }

  // ── surfaces ───────────────────────────────────────────────────────────────

  paceAt(shapeId: string, routeId: string, sM: number, atMs: number): number {
    const bucket = Math.floor(sM / SEG_BUCKET_M);
    const band = hourBand(atMs);
    const day = dayType(atMs);
    return (
      this.trusted('seg', `${shapeId}|${bucket}|${band}|${day}`, MIN_CELL_WEIGHT, atMs) ??
      this.trusted('segShape', `${shapeId}|${bucket}`, MIN_CELL_WEIGHT, atMs) ??
      this.trusted('route', `${routeId}|${band}`, MIN_CELL_WEIGHT + 2, atMs) ??
      this.trusted('global', `${band}`, MIN_CELL_WEIGHT + 7, atMs) ??
      DEFAULT_PACE_MS
    );
  }

  /** Recent measured pace of this km (12-min half-life) + its decayed trust —
   * the "leader as congestion sensor" signal, ML feature contract v2. */
  corridorPaceAt(shapeId: string, sM: number, atMs: number): { paceMs: number | null; trust: number } {
    const c = this.cell('corridorPace', `${shapeId}|${Math.floor(sM / CORRIDOR_M)}`);
    if (!c) return { paceMs: null, trust: 0 };
    const trust = c.weight * Math.pow(0.5, Math.max(0, atMs - c.updatedAtMs) / CORRIDOR_HALF_LIFE_MS);
    return trust >= 0.5 ? { paceMs: c.mean, trust: Math.min(5, trust) } : { paceMs: null, trust: Math.min(5, trust) };
  }

  corridorFactor(shapeId: string, sM: number, atMs: number): number {
    const v = this.trusted(
      'corridor',
      `${shapeId}|${Math.floor(sM / CORRIDOR_M)}`,
      CORRIDOR_MIN_WEIGHT,
      atMs,
      CORRIDOR_HALF_LIFE_MS,
    );
    if (v === null) return 1;
    return Math.min(CORRIDOR_CLAMP[1], Math.max(CORRIDOR_CLAMP[0], v));
  }

  dwellAt(stopId: string, atMs: number): number {
    return this.trusted('stopDwell', stopKey(stopId, atMs), MIN_CELL_WEIGHT, atMs) ?? DEFAULT_DWELL_S;
  }

  /** Learned dwell distribution (mean, sd) + the trust bit, for the drive's
   * §14.1 dwell-stretch hierarchy and the §14.2 request-stop skip class
   * (curvegen-v3 design). Untrusted cells (decayed weight below
   * MIN_CELL_WEIGHT — note dwell runs < 5 s are never even folded, so
   * rarely-held request stops stay untrusted by construction) fall back to
   * the generic defaults with a wide sd. */
  dwellStats(stopId: string, atMs: number): { mean: number; sd: number; trusted: boolean } {
    const c = this.cell('stopDwell', stopKey(stopId, atMs));
    const decayed = c
      ? c.weight * Math.pow(0.5, Math.max(0, atMs - c.updatedAtMs) / EWMA_HALF_LIFE_MS)
      : 0;
    if (!c || decayed < MIN_CELL_WEIGHT) {
      return { mean: DEFAULT_DWELL_S, sd: DEFAULT_DWELL_S * 0.4, trusted: false };
    }
    const variance = c.weight > 1 ? c.s / c.weight : 0;
    return { mean: c.mean, sd: Math.max(2, Math.sqrt(variance)), trusted: true };
  }

  releaseAt(stopId: string, atMs: number): number {
    return this.trusted('stopRelease', stopKey(stopId, atMs), MIN_CELL_WEIGHT, atMs) ?? DEFAULT_RELEASE_S;
  }

  /** Learned release distribution (mean, sd) for the two-hypothesis variant. */
  releaseStats(stopId: string, atMs: number): { mean: number; sd: number } {
    const c = this.cell('stopRelease', stopKey(stopId, atMs));
    if (!c || c.weight < MIN_CELL_WEIGHT) return { mean: DEFAULT_RELEASE_S, sd: DEFAULT_RELEASE_S * 0.6 };
    const variance = c.weight > 1 ? c.s / c.weight : 0;
    return { mean: c.mean, sd: Math.max(3, Math.sqrt(variance)) };
  }

  // ── prediction ─────────────────────────────────────────────────────────────

  reseed(snap: TramSnapshot): void {
    const run = this.runs.get(snap.key);
    const atStop = snap.statePosition === 'at_stop';
    const standingS =
      atStop && run && run.stopId === snap.nextStopId
        ? Math.max(0, (snap.observedAtMs - run.startMs) / 1000)
        : 0;
    this.anchors.set(snap.key, {
      s0: snap.shapeDistM,
      t0Ms: snap.observedAtMs + FEED_LATENCY_MS,
      tripId: snap.tripId,
      atStop,
      nextStopId: snap.nextStopId,
      standingS,
    });
  }

  forget(key: string): void {
    this.anchors.delete(key);
    this.runs.delete(key);
  }

  anchorOf(key: string): Readonly<Anchor> | undefined {
    return this.anchors.get(key);
  }

  /** Pace-only walk from an explicit (s, t) — no stop hold, dwells at the
   * downstream stops as usual. The physics-v3 modal stop renderer uses it as
   * the "departs at FULL LEARNED PACE" branch once P(departed) crosses the
   * modal threshold (docs/research/physics-v3-protocol.md). */
  walkFrom(s0: number, tStartMs: number, tMs: number, geom: RouteGeometry, fast = false): number {
    return this.walk(
      { s0, t0Ms: tStartMs, tripId: geom.tripId, atStop: false, nextStopId: null, standingS: 0 },
      tMs,
      geom,
      fast,
    );
  }

  /** Closed-form position estimate for `key` at wall time tMs, or null. */
  predict(key: string, tMs: number, geom: RouteGeometry | undefined, variant: LearnedVariant = 'learned'): number | null {
    const a = this.anchors.get(key);
    if (!a || !geom || geom.tripId !== a.tripId) return null;
    const fast = variant === 'learned-fast';

    if (variant === 'learned-2h' && a.atStop && a.nextStopId != null) {
      // Two hypotheses: still standing (prob 1-p) vs departed (prob p),
      // p = P(release ≤ total standing time) under the learned Normal(μ, σ).
      const { mean, sd } = this.releaseStats(a.nextStopId, a.t0Ms);
      const elapsedS = (tMs - a.t0Ms) / 1000 + a.standingS;
      const p = normalCdf((elapsedS - mean) / sd);
      const moving = this.walk(a, tMs, geom, false);
      return (1 - p) * a.s0 + p * moving;
    }
    return this.walk(a, tMs, geom, fast);
  }

  private walk(a: Anchor, tMs: number, geom: RouteGeometry, fast: boolean): number {
    let t = a.t0Ms;
    let s = a.s0;
    if (tMs <= t) return s;

    if (a.atStop && a.nextStopId != null) {
      // Remaining hold = learned release minus the time already observed
      // standing (capped: never hold longer than 60 s from the anchor).
      const hold = Math.min(60, Math.max(0, this.releaseAt(a.nextStopId, t) - a.standingS)) * 1000;
      t += hold;
      if (tMs <= t) return s;
    }

    const stops = geom.stops;
    let stopIdx = 0;
    while (stopIdx < stops.length && stops[stopIdx].distM <= s + 1) stopIdx++;
    let guard = 0;
    while (t < tMs && guard++ < 500) {
      if (s >= geom.totalM - 1) return geom.totalM; // terminal hold
      const bucketEnd = (Math.floor(s / SEG_BUCKET_M) + 1) * SEG_BUCKET_M;
      const nextStopD = stopIdx < stops.length ? stops[stopIdx].distM : Infinity;
      const target = Math.min(bucketEnd, nextStopD, geom.totalM);
      let pace = Math.max(0.5, this.paceAt(geom.shapeId, geom.routeId, s, t));
      if (fast) pace = Math.max(0.5, pace * this.corridorFactor(geom.shapeId, s, t));
      const dtNeed = ((target - s) / pace) * 1000;
      if (t + dtNeed >= tMs) {
        return s + ((tMs - t) / 1000) * pace;
      }
      t += dtNeed;
      s = target;
      if (target === nextStopD && stopIdx < stops.length) {
        // Dwell runs measure the AVL sticky-hold window (a superset of the
        // real ~17 s dwell) — usable as a budget only under a cap.
        t += Math.min(40, this.dwellAt(stops[stopIdx].stopId, t)) * 1000;
        stopIdx++;
        if (t >= tMs) return s;
      }
    }
    return s;
  }

  // ── persistence / rollup gauges ────────────────────────────────────────────

  flush(): void {
    for (const tbl of TABLES) {
      const dirty = this.dirty.get(tbl)!;
      if (dirty.size === 0) continue;
      const m = this.cells.get(tbl)!;
      for (const key of dirty) {
        const c = m.get(key);
        if (c) this.store.saveCell(tbl, key, c);
      }
      dirty.clear();
    }
    this.store.setMeta(
      'learned-counters',
      JSON.stringify({ pace: this.paceSamples, dwell: this.dwellSamples, release: this.releaseSamples }),
    );
  }

  gauges(): { segCells: number; segShapeCells: number; routeCells: number; stopDwellCells: number; stopReleaseCells: number; corridorCells: number; corridorPaceCells: number; paceSamples: number; dwellSamples: number; releaseSamples: number } {
    return {
      segCells: this.cellCount('seg'),
      segShapeCells: this.cellCount('segShape'),
      routeCells: this.cellCount('route'),
      stopDwellCells: this.cellCount('stopDwell'),
      stopReleaseCells: this.cellCount('stopRelease'),
      // The corridor tables were a telemetry blind spot: learned-fast and the
      // ML leader features consumed them for a week with no cell-count gauge.
      corridorCells: this.cellCount('corridor'),
      corridorPaceCells: this.cellCount('corridorPace'),
      paceSamples: this.paceSamples,
      dwellSamples: this.dwellSamples,
      releaseSamples: this.releaseSamples,
    };
  }
}

function stopKey(stopId: string, atMs: number): string {
  return `${stopId}|${hourBand(atMs)}|${dayType(atMs)}`;
}

/** Abramowitz–Stegun approximation of the standard normal CDF. */
export function normalCdf(z: number): number {
  if (z < -6) return 0;
  if (z > 6) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}
