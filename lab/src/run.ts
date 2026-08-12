// Lab orchestrator: ingest the backend diff stream, drive shadow predictors,
// score every prediction against the next real fix (the continuous at-fix
// probe of docs/research/prediction-architecture.md §7.4), learn online, roll
// up minute metrics, and expose live state to the map/API server.
//
// Variants under test (same pairs, same evaluation instant):
//   naive         — tram stays at its last fix (floor every model must beat)
//   schedule      — timetable shifted by reported delay (the classical
//                   OneBusAway/TRAVIC control line; no learning, no physics)
//   engine-live   — the app's REAL predictor (projectedObservedDistM of the
//                   shared TramEngine, ticked exactly like the phone runs it)
//   engine-smooth — the app's cinematic smoother track (lags by design)
//   learned       — closed-form walk over learned slow surfaces
//   learned-fast  — + corridor residuals (phase-2 "leader as sensor")
//   learned-2h    — + two-hypothesis stop release (probability blend)
//   ml-gbdt/ml-mlp— LightGBM / neural net trained nightly on the archive
//                   (lab/ml/service.py), predicting Δs from shared features

import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import {
  FLUSH_MS,
  HORIZON_BUCKETS,
  POLL_MS,
  ROLLUP_MS,
  SCORE_MAX_GAP_S,
  SCORE_MIN_GAP_S,
  TICK_MS,
  TRAJ_JSON_TTL_MS,
  TRAJ_ML_MAX_ROWS,
  TRAJ_POINTS,
  TRAJ_STEP_MS,
  horizonBucket,
} from './config';
import { fetchBatchesSince, fetchFullFleet, fetchHealth, type PollerHealth } from './convex';
import { openDb, pct, round2, Store, type ScoreRow } from './db';
import { GeometryStore } from './geometry';
import { LearnedModel } from './learned';
import { buildMlFeatures, MlClient } from './ml';
import { schedulePosition } from './schedule';
import { startServer } from './server';

/* eslint-disable @typescript-eslint/no-require-imports */
const { TramEngine } = require('@/lib/engine/engine') as typeof import('@/lib/engine/engine');
const { getModelSpec, regNumberToModelId } =
  require('@/lib/fleet/registry') as typeof import('@/lib/fleet/registry');

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' });

interface LastFix {
  snap: TramSnapshot;
  cycle: number;
}

interface ScoringEvent {
  base: Omit<ScoreRow, 'variant' | 'errM' | 'absErrM'>;
  actual: number;
  s0: number;
  totalM: number;
  preds: { variant: string; value: number }[];
  mlFeatures: number[] | null;
}

/** One keyframe of the /api/trajectories feed: absolute wall time → distance
 * along the trip shape, in meters. The app lerps s between consecutive t. */
export interface TrajectoryPoint {
  t: number;
  s: number;
}

export interface TrajectoryVehicle {
  key: string;
  tripId: string;
  line: string;
  /** observedAtMs of the fix this trajectory is anchored to. */
  anchorMs: number;
  points: TrajectoryPoint[];
}

interface TrajectoryEntry {
  fixObsAtMs: number;
  vehicle: TrajectoryVehicle;
}

export interface LiveVehicle {
  key: string;
  line: string;
  fixAgeS: number;
  fix: [number, number];
  engine: [number, number] | null;
  smooth: [number, number] | null;
  learned: [number, number] | null;
  engineDistM: number | null;
  learnedDistM: number | null;
  fixDistM: number;
}

export function start(): void {
  const store = new Store(openDb());
  const geometry = new GeometryStore(store);
  const learned = new LearnedModel(store);
  const ml = new MlClient();
  const engine = new TramEngine({
    resolveModel: (s: TramSnapshot) => getModelSpec(regNumberToModelId(s.registrationNumber)),
  });
  engine.setProjectionCadence('full');

  const fleet = new Map<string, TramSnapshot>();
  const lastFix = new Map<string, LastFix>();
  /** key → keyframe trajectory computed for that vehicle's CURRENT fix. */
  const trajectories = new Map<string, TrajectoryEntry>();
  let trajRefreshing = false;
  let trajJson: string | null = null;
  let trajJsonAtMs = 0;
  let cursor: number | null = null;
  let cycle = 0;
  let lastBatchAtMs = 0;
  let pollerHealth: PollerHealth | null = null;
  let pragueDay = DAY_FMT.format(new Date());

  // Per-rollup-window accumulators.
  let scoreBuf: ScoreRow[] = [];
  let cFixes = 0;
  let cBatches = 0;
  let latencySum = 0;
  let latencyN = 0;
  let gapSum = 0;
  let gapN = 0;
  let cDiscarded = 0;

  const log = (msg: string) => console.log(`[lab ${new Date().toISOString()}] ${msg}`);

  function writeScore(row: Omit<ScoreRow, 'absErrM'>): void {
    const full: ScoreRow = { ...row, errM: round2(row.errM), absErrM: round2(Math.abs(row.errM)) };
    store.addScore(full);
    scoreBuf.push(full);
  }

  function processSnapshot(snap: TramSnapshot, batchAtMs: number, events: ScoringEvent[]): void {
    const prev = lastFix.get(snap.key);
    const isNew = !prev || snap.observedAtMs > prev.snap.observedAtMs;
    fleet.set(snap.key, snap);
    if (!isNew) return;

    const nowMs = Date.now();
    const latencyS = round2((batchAtMs - snap.observedAtMs) / 1000);
    store.addFix({
      key: snap.key,
      reg: snap.registrationNumber,
      tripId: snap.tripId,
      routeId: snap.routeId,
      line: snap.line,
      obsAtMs: snap.observedAtMs,
      seenAtMs: batchAtMs,
      shapeDistM: snap.shapeDistM,
      lat: snap.coordinates[1],
      lng: snap.coordinates[0],
      bearing: snap.bearing,
      delayS: snap.delaySeconds,
      statePos: snap.statePosition,
      nextStopId: snap.nextStopId,
      nextSeq: snap.nextStopSequence,
    });
    cFixes++;
    latencySum += latencyS;
    latencyN++;

    const geom = geometry.resolve(snap.tripId);
    const sameTrip = prev !== undefined && prev.snap.tripId === snap.tripId;
    const gapS = prev ? (snap.observedAtMs - prev.snap.observedAtMs) / 1000 : 0;

    // ── shadow scoring: what did each variant believe, just before truth? ──
    if (
      prev &&
      sameTrip &&
      geom &&
      prev.cycle < cycle &&
      gapS >= SCORE_MIN_GAP_S &&
      gapS <= SCORE_MAX_GAP_S
    ) {
      const actual = snap.shapeDistM;
      // Feed-discontinuity gate: a displacement implying > 22 m/s (~79 km/h)
      // is a shape/odometry reset, never travel (same physical criterion as
      // convex/calibration/fold.ts). Such an event would charge a km-scale
      // error to EVERY variant simultaneously — the synchronous spike class
      // on the minute panels (finding 2026-08-11). Skipped entirely, counted.
      if (Math.abs(actual - prev.snap.shapeDistM) / gapS > 22) {
        cDiscarded++;
      } else {
      gapSum += gapS;
      gapN++;
      const preds: { variant: string; value: number }[] = [];

      preds.push({ variant: 'naive', value: prev.snap.shapeDistM });

      const sched = schedulePosition(geom, prev.snap.delaySeconds, nowMs, prev.snap.shapeDistM);
      if (sched !== null) preds.push({ variant: 'schedule', value: sched });

      const st = engine.getState(snap.key);
      if (st && st.projectedObservedDistM !== null) {
        preds.push({ variant: 'engine-live', value: st.projectedObservedDistM });
      }
      if (st && st.hasGeometry) {
        preds.push({ variant: 'engine-smooth', value: st.simDistM });
      }

      for (const variant of ['learned', 'learned-fast', 'learned-2h'] as const) {
        const v = learned.predict(snap.key, nowMs, geom, variant);
        if (v !== null) preds.push({ variant, value: v });
      }

      events.push({
        base: {
          atMs: nowMs,
          key: snap.key,
          line: snap.line,
          routeId: snap.routeId,
          tripId: snap.tripId,
          horizonS: round2(gapS),
          latencyS,
        },
        actual,
        s0: prev.snap.shapeDistM,
        totalM: geom.totalM,
        preds,
        mlFeatures: buildMlFeatures(prev.snap, geom, learned, nowMs),
      });
      }
    }

    // ── learning + reseed (after prediction capture — never peek the answer)
    if (prev && sameTrip) learned.update(prev.snap, snap, geom);
    learned.reseed(snap);
    lastFix.set(snap.key, { snap, cycle });
  }

  async function resolveEvents(events: ScoringEvent[]): Promise<void> {
    if (events.length === 0) return;
    const mlRows = events.filter((e) => e.mlFeatures !== null);
    const predictions = await ml.predictBatch(mlRows.map((e) => e.mlFeatures!));
    if (predictions) {
      mlRows.forEach((e, i) => {
        for (const [variant, arr] of [
          ['ml-gbdt', predictions.gbdt],
          ['ml-mlp', predictions.mlp],
        ] as const) {
          const ds = arr[i];
          if (ds !== null && Number.isFinite(ds)) {
            const value = Math.min(e.totalM, Math.max(0, e.s0 + ds));
            e.preds.push({ variant, value });
          }
        }
      });
    }
    for (const e of events) {
      for (const p of e.preds) {
        writeScore({ ...e.base, variant: p.variant, errM: p.value - e.actual });
      }
    }
  }

  // ── trajectory keyframes (GET /api/trajectories) ───────────────────────────
  // The experimental app mode wants a dumb-lerpable polyline in TIME rather
  // than a position it must re-derive: 13 ml-gbdt samples of Δs at the anchor
  // fix, evaluated at now + k·10 s. gapS is a model FEATURE, so simply moving
  // tEvalMs forward gives each horizon its own honest prediction — no physics
  // integration on the client.
  //
  // Only vehicles whose fix actually changed are recomputed (~10–20 per 2 s
  // cycle ⇒ ~130–260 rows), so this rides along with the scoring loop for
  // free. It runs detached: an ML stall must never delay scoring.
  async function refreshTrajectories(): Promise<void> {
    const tCompute = Date.now();

    for (const key of trajectories.keys()) {
      if (!lastFix.has(key)) trajectories.delete(key);
    }

    const stale: { key: string; snap: TramSnapshot; geom: RouteGeometry }[] = [];
    for (const [key, lf] of lastFix) {
      const entry = trajectories.get(key);
      // Recompute when the fix changed OR the trajectory itself is aging out:
      // long AVL gaps (p90 ~79 s, max >160 s) would otherwise leave all 13
      // keyframes in the past and the app's marker frozen at the last point.
      const computedAtMs = entry?.vehicle.points[0]?.t ?? 0;
      if (entry?.fixObsAtMs === lf.snap.observedAtMs && tCompute - computedAtMs < 60_000) continue;
      const geom = geometry.resolve(lf.snap.tripId);
      if (!geom) {
        trajectories.delete(key); // no geometry ⇒ no s-axis to predict along
        continue;
      }
      stale.push({ key, snap: lf.snap, geom });
    }
    if (stale.length === 0) return;

    // Chunk on VEHICLE boundaries so a failed chunk drops whole vehicles only.
    const perChunk = Math.max(1, Math.floor(TRAJ_ML_MAX_ROWS / TRAJ_POINTS));
    for (let i = 0; i < stale.length; i += perChunk) {
      const group = stale.slice(i, i + perChunk);
      const rows: number[][] = [];
      for (const v of group) {
        for (let k = 0; k < TRAJ_POINTS; k++) {
          rows.push(buildMlFeatures(v.snap, v.geom, learned, tCompute + k * TRAJ_STEP_MS));
        }
      }
      const pred = await ml.predictBatch(rows);
      if (!pred) {
        // ML down or models not ready: drop these vehicles from the feed
        // rather than serve keyframes anchored to a superseded fix.
        for (const v of group) trajectories.delete(v.key);
        continue;
      }
      group.forEach((v, gi) => {
        const points: TrajectoryPoint[] = [];
        let maxS = 0;
        for (let k = 0; k < TRAJ_POINTS; k++) {
          const ds = pred.gbdt[gi * TRAJ_POINTS + k];
          if (ds === null || !Number.isFinite(ds)) return void trajectories.delete(v.key);
          const s = Math.min(v.geom.totalM, Math.max(0, v.snap.shapeDistM + ds));
          // Each horizon is predicted independently, so the sequence can jitter
          // backwards; the app lerps it blindly, so clamp it monotone here.
          maxS = k === 0 ? s : Math.max(maxS, s);
          points.push({ t: tCompute + k * TRAJ_STEP_MS, s: round2(maxS) });
        }
        trajectories.set(v.key, {
          fixObsAtMs: v.snap.observedAtMs,
          vehicle: {
            key: v.key,
            tripId: v.snap.tripId,
            line: v.snap.line,
            anchorMs: v.snap.observedAtMs,
            points,
          },
        });
      });
    }
  }

  /** Detached refresh with an in-flight guard — never awaited by the poller. */
  function kickTrajectoryRefresh(): void {
    if (trajRefreshing) return;
    trajRefreshing = true;
    refreshTrajectories()
      .catch((e) => log(`trajectory refresh error: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        trajRefreshing = false;
      });
  }

  /** Pre-serialized so repeated polling costs one stringify per TTL window. */
  function getTrajectories(): string {
    const nowMs = Date.now();
    if (trajJson !== null && nowMs - trajJsonAtMs < TRAJ_JSON_TTL_MS) return trajJson;
    trajJson = JSON.stringify({
      atMs: nowMs,
      stepS: TRAJ_STEP_MS / 1000,
      horizonS: ((TRAJ_POINTS - 1) * TRAJ_STEP_MS) / 1000,
      vehicles: [...trajectories.values()].map((e) => e.vehicle),
    });
    trajJsonAtMs = nowMs;
    return trajJson;
  }

  async function pollOnce(): Promise<void> {
    cycle++;
    const nowMs = Date.now();
    engine.tick(nowMs); // bring predictions to "now" before judging them
    const events: ScoringEvent[] = [];

    if (cursor === null) {
      const full = await fetchFullFleet();
      fleet.clear();
      for (const v of full.vehicles) {
        fleet.set(v.key, v);
        learned.reseed(v);
        lastFix.set(v.key, { snap: v, cycle });
      }
      cursor = full.seq;
      pollerHealth = full.poller;
      lastBatchAtMs = full.atMs;
      log(`seeded fleet: ${fleet.size} vehicles at seq ${cursor}`);
    } else {
      const res = await fetchBatchesSince(cursor);
      const gap =
        res.batches.length > 0
          ? res.batches[0].seq > cursor + 1
          : res.oldestSeq > cursor + 1;
      if (gap) {
        log(`seq gap at cursor ${cursor} (oldest ${res.oldestSeq}) — reseeding`);
        cursor = null;
        return pollOnce();
      }
      for (const batch of res.batches) {
        cBatches++;
        lastBatchAtMs = batch.atMs;
        for (const snap of batch.changed) processSnapshot(snap, batch.atMs, events);
        for (const key of batch.removed ?? []) {
          fleet.delete(key);
          lastFix.delete(key);
          learned.forget(key);
        }
        cursor = batch.seq;
      }
    }

    await resolveEvents(events);
    kickTrajectoryRefresh(); // detached: scoring has already been written

    // Production RemoteFeed semantics: the engine always ingests the MERGED
    // full array (keeps lastSeenMs fresh; the 90 s stale sweep stays sane).
    engine.ingest([...fleet.values()], geometry.resolve, Date.now());
    geometry.ensure(new Set([...fleet.values()].map((v) => v.tripId)));

    // Prague service-day rollover → re-anchor cached stop epochs.
    const day = DAY_FMT.format(new Date());
    if (day !== pragueDay) {
      pragueDay = day;
      geometry.reanchorAll(Date.now());
      log('service-day rollover: geometries re-anchored');
    }
  }

  function rollup(): void {
    const tsMin = Math.floor(Date.now() / 60_000);
    const buf = scoreBuf;
    scoreBuf = [];
    const groups = new Map<string, number[]>(); // `${variant}|${bucket}` → signed errs
    for (const r of buf) {
      for (const b of ['all', horizonBucket(r.horizonS)]) {
        const k = `${r.variant}|${b}`;
        let a = groups.get(k);
        if (!a) groups.set(k, (a = []));
        a.push(r.errM);
      }
    }
    const rows: Parameters<Store['writeRollup']>[0] = [];
    for (const [k, errs] of groups) {
      const [variant, hbucket] = k.split('|');
      const abs = errs.map(Math.abs).sort((a, b) => a - b);
      rows.push({
        tsMin,
        variant,
        hbucket,
        n: errs.length,
        meanAbs: round2(abs.reduce((a, b) => a + b, 0) / abs.length),
        p50Abs: round2(pct(abs, 50)),
        p90Abs: round2(pct(abs, 90)),
        signedMean: round2(errs.reduce((a, b) => a + b, 0) / errs.length),
      });
    }
    if (rows.length > 0) store.writeRollup(rows);

    store.writeLearningRollup({ tsMin, ...learned.gauges() });
    const withGeometry = [...fleet.values()].filter((v) => geometry.resolve(v.tripId)).length;
    store.writeIngestRollup({
      tsMin,
      fixes: cFixes,
      batches: cBatches,
      vehicles: fleet.size,
      withGeometry,
      geomFetchOk: geometry.fetchOk,
      geomFetchFail: geometry.fetchFail,
      avgLatencyS: latencyN > 0 ? round2(latencySum / latencyN) : null,
      avgFixGapS: gapN > 0 ? round2(gapSum / gapN) : null,
      pollerFleetSize: pollerHealth?.fleetSize ?? null,
      pollerRunning: pollerHealth ? (pollerHealth.running ? 1 : 0) : null,
      discarded: cDiscarded,
    });
    cDiscarded = 0;
    cFixes = 0;
    cBatches = 0;
    latencySum = 0;
    latencyN = 0;
    gapSum = 0;
    gapN = 0;
    geometry.fetchOk = 0;
    geometry.fetchFail = 0;
  }

  function getLive(): { atMs: number; vehicles: LiveVehicle[] } {
    const nowMs = Date.now();
    const states = engine.getStates(nowMs);
    const vehicles: LiveVehicle[] = [];
    for (const st of states) {
      const geom = geometry.resolve(st.snapshot.tripId);
      const engineDistM = st.projectedObservedDistM;
      const learnedDistM = geom ? learned.predict(st.key, nowMs, geom, 'learned-fast') : null;
      vehicles.push({
        key: st.key,
        line: st.snapshot.line,
        fixAgeS: Math.round((nowMs - st.snapshot.observedAtMs) / 1000),
        fix: st.observedPosition,
        engine: geom && engineDistM !== null ? geometry.coordAt(geom, engineDistM) : null,
        smooth: st.hasGeometry ? st.position : null,
        learned: geom && learnedDistM !== null ? geometry.coordAt(geom, learnedDistM) : null,
        engineDistM,
        learnedDistM,
        fixDistM: st.snapshot.shapeDistM,
      });
    }
    return { atMs: nowMs, vehicles };
  }

  function getSummary(): unknown {
    return {
      atMs: Date.now(),
      fleet: fleet.size,
      geometries: geometry.size(),
      cursor,
      lastBatchAtMs,
      poller: pollerHealth,
      lastHour: store.summarySince(Date.now() - 3_600_000),
      learning: learned.gauges(),
      ml: { ready: ml.modelsReady, lastOkMs: ml.lastOkMs, lastError: ml.lastError },
      horizonBuckets: HORIZON_BUCKETS,
    };
  }

  startServer({
    getLive,
    getSummary,
    getTrajectories,
    isHealthy: () => Date.now() - lastBatchAtMs < 120_000,
  });

  // ── loops ──────────────────────────────────────────────────────────────────
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    pollOnce()
      .catch((e) => log(`poll error: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        polling = false;
      });
  }, POLL_MS);

  setInterval(() => engine.tick(Date.now()), TICK_MS);
  setInterval(rollup, ROLLUP_MS);
  setInterval(() => {
    learned.flush();
    fetchHealth()
      .then((h) => {
        pollerHealth = h;
      })
      .catch(() => undefined);
  }, FLUSH_MS);

  log('lab started');
}
