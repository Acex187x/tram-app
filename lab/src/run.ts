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
//   ml-mode       — physics-v3 OPINION track as PUBLISHED to phones, i.e.
//                   ml-gbdt keyframes + the modal stop rule, evaluated by the
//                   client's own pure evaluator (cost of modal stops)
//   ml-smooth     — physics-v3 SMOOTH track as published (cost of continuity)
//   ml-drive      — curvegen-v3 SHADOW opinion: the virtual-tram drive
//                   (docs/research/curvegen-v3-design.md), NOT published while
//                   TRAJ_V3_PUBLISH is off; same matched-probe discipline
//   ml-drive-smooth — curvegen-v3 SHADOW smooth (regime-based continuity)

import zlib from 'zlib';

import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import {
  FEED_LATENCY_MS,
  FLUSH_MS,
  GEOMETRY_PACK_TTL_MS,
  HORIZON_BUCKETS,
  POLL_MS,
  ROLLUP_MS,
  SCORE_MAX_GAP_S,
  SCORE_MIN_GAP_S,
  TICK_MS,
  TRAJ_A_ACC,
  TRAJ_A_BRK,
  TRAJ_JSON_TTL_MS,
  TRAJ_ML_MAX_ROWS,
  TRAJ_POINTS,
  TRAJ_STEP_MS,
  TRAJ_V3_PUBLISH,
  TRAJ_V_MAX_MS,
  horizonBucket,
} from './config';
import { fetchBatchesSince, fetchFullFleet, fetchHealth, type PollerHealth } from './convex';
import { openDb, pct, round2, Store, type ScoreRow } from './db';
import { buildDriveVehicle, type DriveBuilt } from './drive';
import { GeometryStore } from './geometry';
import { LearnedModel } from './learned';
import { buildMlFeatures, MlClient } from './ml';
import { PerceptualCounters, RealismCounters } from './realism';
import { schedulePosition } from './schedule';
import { startServer } from './server';
import {
  buildV2Vehicle,
  evalTrack,
  modalReleaseMs,
  type KinTrack,
  type ModalHold,
  type TrajectoryGen,
  type V2Vehicle,
} from './trajectory';

/** The kinematic contract, echoed to debug clients so the /physics page draws
 *  its limit lines from the server's own numbers rather than a copy. */
const LIMITS = { vMaxMs: TRAJ_V_MAX_MS, aAccMs2: TRAJ_A_ACC, aBrkMs2: TRAJ_A_BRK };

/* eslint-disable @typescript-eslint/no-require-imports */
// engine-live/engine-smooth are the control line "what is in users' hands".
// physics-v3 DELETES TramEngine from the app (protocol §excision list), so the
// lab can no longer import it from src/ — it would have gone dark mid-program
// the moment that landed. The baseline is therefore PINNED to build 12's
// engine, vendored verbatim under lab/vendor/engine (see lab/README.md); to
// move the control line, replace those files with the next shipped build's.
const { TramEngine } = require('../vendor/engine/engine') as {
  TramEngine: import('../vendor/engine-api').FrozenTramEngineCtor;
};
const { getModelSpec, regNumberToModelId } =
  require('@/lib/fleet/registry') as typeof import('@/lib/fleet/registry');

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' });

interface LastFix {
  snap: TramSnapshot;
  cycle: number;
  /** Observed gap between the last two genuinely-new fixes, s (0 = only one
   *  seen). Feeds the curvegen-v3 gap-aware discontinuity threshold T_disc. */
  fixGapS: number;
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
  /** v1 payload — the shape build-12 phones consume; NEVER change it. */
  vehicle: TrajectoryVehicle;
  /** v2 payload — physics-v3 opinion + smooth tracks over the same ML samples. */
  v2: V2Vehicle;
  /** The same two tracks WITH their knot speeds. Memory only, never on the
   *  wire: the next emission starts from the real velocity (C¹ seams) and the
   *  /physics page draws the true v(t) rather than a staircase. */
  opinionK: KinTrack;
  smoothK: KinTrack;
}

/** One curvegen-v3 SHADOW emission (design §12 phase A): built from the same
 *  ML samples + modal inputs as the published entry, chained on its own seam
 *  state, never published while TRAJ_V3_PUBLISH is off. */
interface ShadowEntry {
  fixObsAtMs: number;
  v2: V2Vehicle;
  opinionK: KinTrack;
  smoothK: KinTrack;
  /** Raw ML target positions (the /physics page draws them for shadow too). */
  target: TrajectoryPoint[];
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
  /** key → curvegen-v3 shadow emission, chained on its own seam state. */
  const shadowTrajectories = new Map<string, ShadowEntry>();
  /** Chains whose emission was dropped (ML outage / geometry loss / build
   *  failure): the next successful drive build carries the honest
   *  discontinuity flag — an absence shorter than a client's fetch interval
   *  would otherwise render as a silent teleport. */
  const shadowChainBroken = new Set<string>();
  const publishedChainBroken = new Set<string>();
  let trajRefreshing = false;
  let trajJson: string | null = null;
  let trajJsonAtMs = 0;
  let trajV2Json: string | null = null;
  let trajV2JsonAtMs = 0;
  let shadowJson: string | null = null;
  let shadowJsonAtMs = 0;
  /** Build time of the currently published bundle (protocol `atMs`). */
  let trajBuiltAtMs = 0;
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
  /** v2 lifetime counters (never reset — /api/summary gauges). */
  let trajEmissions = 0;
  let trajDiscontinuities = 0;
  /** Kinematic-limits gate over every track ever published (protocol contract). */
  const realism = new RealismCounters();
  /** Why an at-fix probe could/couldn't score the PUBLISHED v2 tracks. */
  let probeOk = 0;
  let probeMissing = 0;
  let probeStaleAnchor = 0;
  let probeTripMismatch = 0;
  /** curvegen-v3 shadow gauges: same G1 realism gate + the §8 perceptual
   *  counters over every shadow emission, and the shadow probe split. */
  const realismShadow = new RealismCounters();
  const perceptual = new PerceptualCounters();
  let shadowEmissions = 0;
  let shadowDiscontinuities = 0;
  let shadowBuildFailures = 0;
  let shadowProbeOk = 0;
  let shadowProbeMissing = 0;
  let shadowProbeStaleAnchor = 0;
  let shadowProbeTripMismatch = 0;

  const log = (msg: string) => console.log(`[lab ${new Date().toISOString()}] ${msg}`);

  /** Non-finite predictions skipped at the write boundary. A NaN errM binds as
   *  SQL NULL, fails the NOT NULL constraint and aborts the WHOLE cycle's
   *  score writes (observed live 2026-08-16 19:55–20:14, pre-curvegen-v3:
   *  27 poll errors = whole cycles of every variant's rows lost). NaN also
   *  sails through the 22 m/s displacement gate — every NaN comparison is
   *  false — so the guard lives here, where all variants pass. */
  let nonFiniteScores = 0;

  function writeScore(row: Omit<ScoreRow, 'absErrM'>): void {
    if (!Number.isFinite(row.errM)) {
      nonFiniteScores++;
      if (nonFiniteScores <= 5 || nonFiniteScores % 1000 === 0) {
        log(`non-finite score skipped: ${row.variant} for ${row.key} (total ${nonFiniteScores})`);
      }
      return;
    }
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

      // physics-v3: score what a PHONE IS RENDERING right now — the published
      // v2 tracks evaluated by the client's own pure evaluator. Not recomputed,
      // so this measures the real cost of the modal stop rule (ml-mode) and of
      // server-owned continuity (ml-smooth) on top of ml-gbdt. Only scored when
      // the published bundle is anchored to the SAME fix every other variant
      // starts from, so n stays matched.
      const pub = trajectories.get(snap.key);
      if (!pub) probeMissing++;
      else if (pub.v2.tripId !== prev.snap.tripId) probeTripMismatch++;
      else if (pub.fixObsAtMs !== prev.snap.observedAtMs) probeStaleAnchor++;
      else {
        probeOk++;
        preds.push({ variant: 'ml-mode', value: evalTrack(pub.v2.opinion, nowMs) });
        preds.push({ variant: 'ml-smooth', value: evalTrack(pub.v2.smooth, nowMs) });
      }

      // curvegen-v3 shadow probe: the CURRENTLY GENERATED (unpublished) drive
      // tracks, evaluated at the same scoring instant with the same guards, so
      // ml-drive/ml-drive-smooth land on matched events vs ml-mode/ml-smooth.
      const sh = shadowTrajectories.get(snap.key);
      if (!sh) shadowProbeMissing++;
      else if (sh.v2.tripId !== prev.snap.tripId) shadowProbeTripMismatch++;
      else if (sh.fixObsAtMs !== prev.snap.observedAtMs) shadowProbeStaleAnchor++;
      else {
        shadowProbeOk++;
        preds.push({ variant: 'ml-drive', value: evalTrack(sh.v2.opinion, nowMs) });
        preds.push({ variant: 'ml-drive-smooth', value: evalTrack(sh.v2.smooth, nowMs) });
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
    lastFix.set(snap.key, { snap, cycle, fixGapS: gapS > 0 ? round2(gapS) : 0 });
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

    const markDropped = (key: string): void => {
      if (trajectories.delete(key)) publishedChainBroken.add(key);
      if (shadowTrajectories.delete(key)) shadowChainBroken.add(key);
    };
    for (const key of trajectories.keys()) {
      if (!lastFix.has(key)) markDropped(key);
    }
    for (const key of shadowTrajectories.keys()) {
      if (!lastFix.has(key)) markDropped(key);
    }

    const stale: { key: string; snap: TramSnapshot; geom: RouteGeometry; fixGapS: number }[] = [];
    for (const [key, lf] of lastFix) {
      const entry = trajectories.get(key);
      // Recompute when the fix changed OR the trajectory itself is aging out:
      // long AVL gaps (p90 ~79 s, max >160 s) would otherwise leave all 13
      // keyframes in the past and the app's marker frozen at the last point.
      const computedAtMs = entry?.vehicle.points[0]?.t ?? 0;
      if (entry?.fixObsAtMs === lf.snap.observedAtMs && tCompute - computedAtMs < 60_000) continue;
      const geom = geometry.resolve(lf.snap.tripId);
      if (!geom) {
        markDropped(key); // no geometry ⇒ no s-axis to predict along
        continue;
      }
      stale.push({ key, snap: lf.snap, geom, fixGapS: lf.fixGapS });
    }
    if (stale.length === 0) {
      trajBuiltAtMs = tCompute; // set validated, nothing to recompute
      return;
    }

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
        for (const v of group) markDropped(v.key);
        continue;
      }
      group.forEach((v, gi) => {
        const drop = (): void => markDropped(v.key);
        const points: TrajectoryPoint[] = [];
        let maxS = 0;
        for (let k = 0; k < TRAJ_POINTS; k++) {
          const ds = pred.gbdt[gi * TRAJ_POINTS + k];
          if (ds === null || !Number.isFinite(ds)) return drop();
          const s = Math.min(v.geom.totalM, Math.max(0, v.snap.shapeDistM + ds));
          // Each horizon is predicted independently, so the sequence can jitter
          // backwards; the app lerps it blindly, so clamp it monotone here.
          maxS = k === 0 ? s : Math.max(maxS, s);
          points.push({ t: tCompute + k * TRAJ_STEP_MS, s: round2(maxS) });
        }
        // ── physics v3: opinion (+ modal stops) and smooth (+ continuity) ──
        // The modal hold mirrors learned-2h's probability model exactly (same
        // anchor epoch, same already-standing credit, same release Normal), so
        // "the curve holds" and "P(departed) < 0.6" can never drift apart.
        let modal: ModalHold | null = null;
        if (v.snap.statePosition === 'at_stop' && v.snap.nextStopId != null) {
          const t0Ms = v.snap.observedAtMs + FEED_LATENCY_MS;
          const a = learned.anchorOf(v.key);
          const standingS =
            a && a.tripId === v.snap.tripId && a.nextStopId === v.snap.nextStopId && a.atStop
              ? a.standingS
              : 0;
          const { mean, sd } = learned.releaseStats(v.snap.nextStopId, t0Ms);
          const stopS = v.snap.shapeDistM;
          const releaseAtMs = modalReleaseMs(t0Ms, standingS, mean, sd);
          modal = {
            stopS,
            releaseAtMs,
            walk: (tMs: number) => learned.walkFrom(stopS, releaseAtMs, tMs, v.geom),
          };
        }
        const baseArgs = {
          key: v.key,
          tripId: v.snap.tripId,
          line: v.snap.line,
          anchorMs: v.snap.observedAtMs,
          emittedAtMs: tCompute,
          raw: points,
        };
        // The drive consumes the learned surfaces through a narrow adapter so
        // its unit tests can inject constants (design §8: builder ≠ measure).
        const surfaces = {
          paceAt: (sM: number, atMs: number) =>
            learned.paceAt(v.geom.shapeId, v.geom.routeId, sM, atMs),
          dwellAt: (stopId: string, atMs: number) => learned.dwellAt(stopId, atMs),
        };

        // ── curvegen-v3 SHADOW build (design §12 phase A): its own seam
        // chain, its own realism gate + perceptual counters, never published
        // while TRAJ_V3_PUBLISH is off.
        const prevShadow = shadowTrajectories.get(v.key);
        const shadowBuilt: DriveBuilt | null = buildDriveVehicle({
          ...baseArgs,
          modal: modal ? { stopS: modal.stopS, releaseAtMs: modal.releaseAtMs } : null,
          geom: v.geom,
          surfaces,
          fixGapS: v.fixGapS,
          chainBroken: shadowChainBroken.has(v.key),
          prev: prevShadow
            ? {
                tripId: prevShadow.v2.tripId,
                smooth: prevShadow.smoothK,
                opinion: prevShadow.opinionK,
              }
            : null,
        });
        if (shadowBuilt === null) {
          shadowBuildFailures++;
          shadowTrajectories.delete(v.key);
          shadowChainBroken.add(v.key);
        } else {
          shadowEmissions++;
          if (shadowBuilt.vehicle.discontinuity) shadowDiscontinuities++;
          realismShadow.check(v.key, 'opinion', shadowBuilt.vehicle.opinion, tCompute);
          realismShadow.check(v.key, 'smooth', shadowBuilt.vehicle.smooth, tCompute);
          perceptual.record({
            key: v.key,
            emittedAtMs: tCompute,
            kind: !prevShadow
              ? 'first'
              : prevShadow.fixObsAtMs !== v.snap.observedAtMs
                ? 'fix'
                : 'age',
            discontinuity: shadowBuilt.vehicle.discontinuity,
            discKind: shadowBuilt.meta.discKind,
            opinion: shadowBuilt.vehicle.opinion,
            smooth: shadowBuilt.vehicle.smooth,
            prevSmooth: prevShadow ? prevShadow.v2.smooth : null,
            perTrack: { opinion: shadowBuilt.meta.opinion, smooth: shadowBuilt.meta.smooth },
          });
          shadowTrajectories.set(v.key, {
            fixObsAtMs: v.snap.observedAtMs,
            v2: shadowBuilt.vehicle,
            opinionK: shadowBuilt.opinion,
            smoothK: shadowBuilt.smooth,
            target: points,
          });
          shadowChainBroken.delete(v.key);
        }

        // ── the PUBLISHED bundle: the current generator until the flip flag
        // turns, then the v3 drive on the published chain's own seam state
        // (phase B: ml-mode/ml-smooth then measure the published v3 pixels).
        const prevEntry = trajectories.get(v.key);
        const prevPub = prevEntry
          ? {
              tripId: prevEntry.v2.tripId,
              smooth: prevEntry.smoothK,
              opinion: prevEntry.opinionK,
            }
          : null;
        const built = TRAJ_V3_PUBLISH
          ? buildDriveVehicle({
              ...baseArgs,
              modal: modal ? { stopS: modal.stopS, releaseAtMs: modal.releaseAtMs } : null,
              geom: v.geom,
              surfaces,
              fixGapS: v.fixGapS,
              chainBroken: publishedChainBroken.has(v.key),
              prev: prevPub,
            })
          : buildV2Vehicle({ ...baseArgs, modal, prev: prevPub });
        if (built === null) {
          trajectories.delete(v.key);
          publishedChainBroken.add(v.key);
          return;
        }
        const v2 = built.vehicle;
        trajEmissions++;
        if (v2.discontinuity) trajDiscontinuities++;
        // Realism gate, continuous side: measure what we are about to publish
        // exactly as a lerping client will experience it (protocol §Kinematic
        // limits). Counters are lifetime, so a regression surfaces in digests.
        realism.check(v.key, 'opinion', v2.opinion, tCompute);
        realism.check(v.key, 'smooth', v2.smooth, tCompute);

        trajectories.set(v.key, {
          fixObsAtMs: v.snap.observedAtMs,
          vehicle: {
            key: v.key,
            tripId: v.snap.tripId,
            line: v.snap.line,
            anchorMs: v.snap.observedAtMs,
            points,
          },
          v2,
          opinionK: built.opinion,
          smoothK: built.smooth,
        });
      });
    }
    trajBuiltAtMs = tCompute;
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

  /** GET /api/trajectories/v2 — the physics-v3 bundle. Frozen for the same TTL
   * as v1 INCLUDING serverNowMs, so two fetches inside the window are
   * byte-identical (determinism gate); clients pay ≤ TRAJ_JSON_TTL_MS of clock
   * offset for that, which the staleness field makes visible. */
  function getTrajectoriesV2(gen: TrajectoryGen = 'current'): string {
    if (gen === 'v3') return getGenV3();
    if (gen === 'mix') return getGenMix();
    const nowMs = Date.now();
    if (trajV2Json !== null && nowMs - trajV2JsonAtMs < TRAJ_JSON_TTL_MS) return trajV2Json;
    trajV2Json = JSON.stringify({
      protocolVersion: 2,
      serverNowMs: nowMs,
      atMs: trajBuiltAtMs,
      horizonS: ((TRAJ_POINTS - 1) * TRAJ_STEP_MS) / 1000,
      vehicles: [...trajectories.values()].map((e) => e.v2),
    });
    trajV2JsonAtMs = nowMs;
    return trajV2Json;
  }

  /** GET /api/shadow-trajectories — the curvegen-v3 SHADOW bundle, exactly the
   * v2 shape plus `shadow: true`, so check-v2.mjs / determinism-v2.mjs and the
   * /physics page can consume it with the same code paths. Frozen for the same
   * 2 s TTL as v2; NEVER fetched by phones. */
  function getShadowTrajectories(): string {
    const nowMs = Date.now();
    if (shadowJson !== null && nowMs - shadowJsonAtMs < TRAJ_JSON_TTL_MS) return shadowJson;
    shadowJson = JSON.stringify({
      protocolVersion: 2,
      shadow: true,
      generator: 'drive-v3',
      serverNowMs: nowMs,
      atMs: trajBuiltAtMs,
      horizonS: ((TRAJ_POINTS - 1) * TRAJ_STEP_MS) / 1000,
      vehicles: [...shadowTrajectories.values()].map((e) => e.v2),
    });
    shadowJsonAtMs = nowMs;
    return shadowJson;
  }

  // ── GET /api/trajectories/v2?gen=v3|mix — engine selection from the phone ──
  // Same wire shape, same 2 s freeze, one cache PER GEN so byte-determinism
  // inside a window holds for each of them independently. `gen=current` never
  // reaches this code: its bytes are frozen for build 14 in the field.
  let genV3Json: string | null = null;
  let genV3JsonAtMs = 0;
  let genMixJson: string | null = null;
  let genMixJsonAtMs = 0;

  /** `?gen=v3` — the drive-v3 curves (the /api/shadow-trajectories content) in
   *  the plain v2 envelope: a phone that picked this engine is not running a
   *  shadow, so the `shadow: true` marker stays on the shadow endpoint. */
  function getGenV3(): string {
    const nowMs = Date.now();
    if (genV3Json !== null && nowMs - genV3JsonAtMs < TRAJ_JSON_TTL_MS) return genV3Json;
    genV3Json = JSON.stringify({
      protocolVersion: 2,
      generator: 'drive-v3',
      serverNowMs: nowMs,
      atMs: trajBuiltAtMs,
      horizonS: ((TRAJ_POINTS - 1) * TRAJ_STEP_MS) / 1000,
      vehicles: [...shadowTrajectories.values()].map((e) => e.v2),
    });
    genV3JsonAtMs = nowMs;
    return genV3Json;
  }

  /** `?gen=mix` — per vehicle: v3's `opinion` (and the anchor it re-anchored
   *  to) driven onto the CURRENT generator's `smooth` track, to see whether the
   *  new opinion is the improvement without also swapping the continuity track.
   *  `discontinuity` is the OR and `emittedAtMs` the max of the two sources, so
   *  the composite can never under-report a teleport nor blend from an anchor
   *  older than the curves it carries. A vehicle only one source knows is
   *  passed through whole — and so is one whose sources disagree on the trip,
   *  because `s` is distance along THAT trip's shape and a track composed
   *  across a trip change would be drawn on geometry it was never fitted to.
   *  Built only when this gen is actually requested, then frozen like the
   *  others; the pass-through cases reuse the source objects rather than
   *  copying them. */
  function getGenMix(): string {
    const nowMs = Date.now();
    if (genMixJson !== null && nowMs - genMixJsonAtMs < TRAJ_JSON_TTL_MS) return genMixJson;
    const vehicles: V2Vehicle[] = [];
    for (const [key, cur] of trajectories) {
      const v3 = shadowTrajectories.get(key);
      if (!v3 || v3.v2.tripId !== cur.v2.tripId) {
        vehicles.push(v3 ? v3.v2 : cur.v2);
        continue;
      }
      vehicles.push({
        key: v3.v2.key,
        tripId: v3.v2.tripId,
        line: v3.v2.line,
        anchorMs: v3.v2.anchorMs,
        emittedAtMs: Math.max(v3.v2.emittedAtMs, cur.v2.emittedAtMs),
        discontinuity: v3.v2.discontinuity || cur.v2.discontinuity,
        opinion: v3.v2.opinion,
        smooth: cur.v2.smooth,
      });
    }
    for (const [key, v3] of shadowTrajectories) {
      if (!trajectories.has(key)) vehicles.push(v3.v2);
    }
    genMixJson = JSON.stringify({
      protocolVersion: 2,
      generator: 'mix',
      serverNowMs: nowMs,
      atMs: trajBuiltAtMs,
      horizonS: ((TRAJ_POINTS - 1) * TRAJ_STEP_MS) / 1000,
      vehicles,
    });
    genMixJsonAtMs = nowMs;
    return genMixJson;
  }

  // ── GET /api/geometry-pack — cold start for clients ────────────────────────
  // A fresh phone knows every tram's `s` from the v2 bundle within 2 s but has
  // no shape to place it on, and fetching /geometry/:tripId per vehicle is
  // hundreds of round trips. This is the whole ACTIVE fleet's geometry in one
  // gzip: deduplicated by shapeId (dozens of trips share a shape) plus the
  // tripId → shapeId index. The gzipped buffer is cached — recompressing a
  // multi-megabyte payload per request would be the most expensive thing the
  // lab does.
  let packBuf: Buffer | null = null;
  let packBuiltAtMs = 0;
  let packMeta = { shapes: 0, trips: 0, rawBytes: 0, gzipBytes: 0, buildMs: 0 };

  function getGeometryPack(): { buf: Buffer; meta: typeof packMeta; atMs: number } {
    const nowMs = Date.now();
    if (packBuf !== null && nowMs - packBuiltAtMs < GEOMETRY_PACK_TTL_MS) {
      return { buf: packBuf, meta: packMeta, atMs: packBuiltAtMs };
    }
    const t0 = Date.now();
    const { shapes, trips } = geometry.pack(
      new Set([...fleet.values()].map((v) => v.tripId)),
    );
    const json = JSON.stringify({ atMs: nowMs, shapes, trips });
    packBuf = zlib.gzipSync(json, { level: 9 });
    packBuiltAtMs = nowMs;
    packMeta = {
      shapes: shapes.length,
      trips: Object.keys(trips).length,
      rawBytes: Buffer.byteLength(json),
      gzipBytes: packBuf.length,
      buildMs: Date.now() - t0,
    };
    log(
      `geometry-pack rebuilt: ${packMeta.shapes} shapes / ${packMeta.trips} trips, ` +
        `${(packMeta.rawBytes / 1048576).toFixed(2)} MiB raw → ` +
        `${(packMeta.gzipBytes / 1048576).toFixed(2)} MiB gzip in ${packMeta.buildMs} ms`,
    );
    return { buf: packBuf, meta: packMeta, atMs: packBuiltAtMs };
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
        lastFix.set(v.key, { snap: v, cycle, fixGapS: 0 });
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
      scoring: { nonFiniteSkipped: nonFiniteScores },
      trajectories: {
        vehicles: trajectories.size,
        builtAtMs: trajBuiltAtMs,
        emissions: trajEmissions,
        discontinuities: trajDiscontinuities,
        probe: { ok: probeOk, missing: probeMissing, staleAnchor: probeStaleAnchor, tripMismatch: probeTripMismatch },
      },
      realism: realism.gauges(),
      shadow: {
        generator: 'drive-v3',
        published: TRAJ_V3_PUBLISH,
        vehicles: shadowTrajectories.size,
        emissions: shadowEmissions,
        discontinuities: shadowDiscontinuities,
        buildFailures: shadowBuildFailures,
        probe: {
          ok: shadowProbeOk,
          missing: shadowProbeMissing,
          staleAnchor: shadowProbeStaleAnchor,
          tripMismatch: shadowProbeTripMismatch,
        },
        realism: realismShadow.gauges(),
      },
      perceptual: perceptual.gauges(),
      horizonBuckets: HORIZON_BUCKETS,
    };
  }

  /** GET /api/vehicle/:key/debug[?source=shadow] — everything the /physics
   *  page needs to draw "how it drives": both curves of the chosen track
   *  source (published bundle, or the curvegen-v3 shadow drive) with their
   *  true knot speeds, and the vehicle's recent REAL fixes so the model can be
   *  eyeballed against the only ground truth there is. */
  function getVehicleDebug(key: string, source: 'published' | 'shadow'): unknown {
    const entry =
      source === 'shadow'
        ? (shadowTrajectories.get(key) ?? null)
        : (trajectories.get(key) ?? null);
    const fixes = store.recentFixes(key, 10);
    if (!entry) {
      return { key, atMs: Date.now(), found: false, source, fixes, limits: LIMITS };
    }
    const snap = fleet.get(key);
    const target =
      source === 'shadow'
        ? (entry as ShadowEntry).target
        : (entry as TrajectoryEntry).vehicle.points;
    return {
      key,
      atMs: Date.now(),
      found: true,
      source,
      line: entry.v2.line,
      tripId: entry.v2.tripId,
      anchorMs: entry.v2.anchorMs,
      emittedAtMs: entry.v2.emittedAtMs,
      discontinuity: entry.v2.discontinuity,
      statePosition: snap?.statePosition ?? null,
      opinion: { points: entry.v2.opinion, v: entry.opinionK.v },
      smooth: { points: entry.v2.smooth, v: entry.smoothK.v },
      /** The raw ml-gbdt TARGET positions both generators consume. */
      target,
      fixes,
      limits: LIMITS,
    };
  }

  startServer({
    getLive,
    getSummary,
    getTrajectories,
    getTrajectoriesV2,
    getShadowTrajectories,
    getVehicleDebug,
    getGeometryPack,
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
