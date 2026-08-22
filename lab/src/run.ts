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
  TRAJ_STAND_ASSERT_MS,
  TRAJ_V3_PUBLISH,
  INSTANT_NAIVE_GAP_M,
  NAIVE_LATENCY_CAP_S,
  STUCK_COORD_EPS_M,
  FUSE_FIX_AXIS,
  FUSE_COORD_DISAGREE_M,
  FUSE_OFFTRACK_MAX_M,
  FUSE_BACKWARD_TOL_M,
  FUSE_MAX_CORRECTION_M,
  TRAJ_V_MAX_MS,
  horizonBucket,
} from './config';
import { fetchBatchesSince, fetchFullFleet, fetchHealth, type PollerHealth } from './convex';
import { openDb, pct, round2, Store, type ScoreRow } from './db';
import {
  buildDriveVehicle,
  COUPLED_TRAILER_OFFSET_M,
  QUEUE_GAP_M,
  STUCK_FIX_EPS_M,
  STUCK_NEAR_STOP_M,
  type DriveBuilt,
} from './drive';
import { haversineM, pointAt } from '@/lib/geo/polyline';
import { projectDistanceOnPolyline, projectNearOnPolyline } from '@/lib/golemio/gtfs';
import { GeometryStore } from './geometry';
import { LearnedModel } from './learned';
import { buildMlFeatures, MlClient } from './ml';
import { ConvexPublisher } from './publish';
import { FreshnessCounters, PerceptualCounters, RealismCounters, SeamCounters } from './realism';
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
const { getModelSpec, isLikelyCoupledPair, regNumberToModelId } =
  require('@/lib/fleet/registry') as typeof import('@/lib/fleet/registry');

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' });

interface LastFix {
  snap: TramSnapshot;
  /** Ленточная (сырая) ось фикса — то, что видит ТЕЛЕФОН. Fused-ось живёт в
   *  snap.shapeDistM; клиент-модель швов обязана считать от сырой. */
  rawShapeDistM: number;
  cycle: number;
  /** Observed gap between the last two genuinely-new fixes, s (0 = only one
   *  seen). Feeds the curvegen-v3 gap-aware discontinuity threshold T_disc. */
  fixGapS: number;
  /** §14.3 jam evidence (descends from tramSim.updateStuckHold): two-plus
   *  genuinely-new same-trip fixes flat within STUCK_FIX_EPS_M, away from
   *  platforms and not at_stop ⇒ the tram is physically stuck HERE. Cleared
   *  by any fix that moved. null = moving / no evidence. */
  stuckAtM: number | null;
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
  /** shapeDistM of the anchor fix (seam telemetry: how far the NEXT fix moves). */
  anchorFixS: number;
  /** What produced the target keyframes: ml-gbdt samples, or the learned-walker
   *  naive substitute (ML unavailable AND the old curve provably overrun). */
  source: 'ml' | 'naive';
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
  /** shapeDistM of the anchor fix (seam telemetry). */
  anchorFixS: number;
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
  const publisher = new ConvexPublisher();
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
  /** §14.4 leadership memory for NEAR-TIED same-shape pairs: two nowcasts
   *  within ~30 m flip order on model noise every cycle, and a flip-flopping
   *  pair mutually clips into interleaved curves (measured live 2026-08-17:
   *  9373↔9441 alternating as each other's leader). The first observed order
   *  sticks until a genuine > 30 m overtake. */
  const leaderMemory = new Map<string, string>();
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
  /** ML unavailable, old curve still valid ⇒ kept serving it (owner doctrine). */
  let trajMlHeld = 0;
  /** Fused-axis telemetry: how often and how far coords overrode shape_dist. */
  let fuseApplied = 0;
  let fuseMetersSum = 0;
  /** ML unavailable AND old curve overrun/expired ⇒ learned-walker substitute. */
  let trajNaiveEmissions = 0;
  /** Kinematic-limits gate over every track ever published (protocol contract). */
  const realism = new RealismCounters();
  /** Anchor-floor hotfix telemetry (owner field report 2026-08-17: the fixed
   *  track teleported BEHIND the latest fix). Counts exactly where published
   *  bytes may differ from the pre-hotfix builders — everywhere else the
   *  builders are pure functions of unchanged inputs, so bytes are identical. */
  let anchorDsClampedPoints = 0; // raw ML Δs < 0 samples floored at the fix
  let anchorDsClampedEmissions = 0; // emissions with ≥ 1 floored sample
  let ageFloorPubApplied = 0; // published-chain age-refresh floors engaged
  let ageFloorShadowApplied = 0; // shadow/v3-chain age-refresh floors engaged
  let seamFloorPubApplied = 0; // §14.7 fix-driven continuity floors, published
  let seamFloorShadowApplied = 0; // …and on the shadow/v3 chain
  /** Why an at-fix probe could/couldn't score the PUBLISHED v2 tracks. */
  let probeOk = 0;
  let probeMissing = 0;
  let probeStaleAnchor = 0;
  let probeTripMismatch = 0;
  /** curvegen-v3 shadow gauges: same G1 realism gate + the §8 perceptual
   *  counters over every shadow emission, and the shadow probe split. */
  const realismShadow = new RealismCounters();
  const perceptual = new PerceptualCounters();
  /** Re-anchor seam telemetry (owner field report 2026-08-18: the fixed marker
   *  flies backward past the fix on bundle swap, then stands). Measured on
   *  BOTH chains — the owner's build-15 default is the published gen. */
  const seamPub = new SeamCounters();
  const seamShadow = new SeamCounters();
  /** M2: rendered-behind-the-newest-fix at fix arrival, per chain. */
  const freshPub = new FreshnessCounters();
  const freshShadow = new FreshnessCounters();
  let shadowEmissions = 0;
  let shadowDiscontinuities = 0;
  let shadowBuildFailures = 0;
  /** §14.4 leader-selection outcomes. The G12 counter can only see emissions
   *  that GOT a leader; every `return null` below is a silent hole where the
   *  anti-collision constraint simply does not apply, and the 2026-08-19
   *  bytes probe found the real through-passing population living in exactly
   *  those holes (100–336 m crossings on line 9, 28/30 with a stale fix on at
   *  least one side). Counted per leaderFor call, shadow chain. */
  const leaderPick = {
    calls: 0,
    /** A leader was returned and clipped against. */
    bound: 0,
    /** Nobody ahead on this shape (or the shape has one vehicle). */
    noCandidate: 0,
    /** Every candidate ahead was excluded as an alias pair (< 15 m). */
    aliasOnly: 0,
    /** Leadership memory says this vehicle leads the near-tied pair. */
    memoryHeld: 0,
    /** The nearest leader sits > 1500 m ahead — the constraint never binds. */
    tooFar: 0,
    /** The candidate's curve is NOT anchored to its newest fix — it is mid-
     *  rebuild this cycle. Suspected to be the main hole; measured 2026-08-19
     *  at literally 0 over 5.8 k calls, because a vehicle whose fixes stop
     *  arriving keeps `fixObsAtMs === observedAtMs` and stays leadable. */
    staleCurve: 0,
    /** The candidate has no chain entry at all (dropped / first cycle). */
    noEntry: 0,
    /** The candidate's curve is on another rail (geometry moved under it). */
    otherRail: 0,
  };
  /** Same shape, for the crossing probe's lookups (not reported). */
  const leaderPickScratch = { ...leaderPick };
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

  /**
   * The fused fix axis (config §fused): re-derive shapeDistM from the
   * coordinates when the feed's two representations of this fix contradict
   * each other. Everything downstream of processSnapshot — learned model, ML
   * features, jam evidence, trajectory anchors, published anchorS — sees ONE
   * axis, the one backed by the actual sensor.
   */
  function fuseSnap(snap: TramSnapshot): TramSnapshot {
    if (!FUSE_FIX_AXIS) return snap;
    // BENCH VERDICT (hunt1, 205 событий): парковочные координаты стоящего у
    // платформы трамвая систематически проецируются на −60…−73 м от неё, а
    // ось at_stop-фикса Golemio прибивает РОВНО к остановке — и она ПРАВА.
    // Фьюзить at_stop-фиксы = утащить якорь модального холда от платформы.
    if (snap.statePosition === 'at_stop') return snap;
    const geom = geometry.resolve(snap.tripId);
    if (!geom) return snap;
    // Оконная проекция вокруг заявленной оси (±FUSE_MAX_CORRECTION_M + запас):
    // петли линии 16 (Δ417/425 м между проходами) ловят глобальную
    // ближайшую точку на чужой круг — окно делает проекцию однозначной.
    const sProj = projectNearOnPolyline(
      snap.coordinates,
      geom.coordinates,
      geom.cumDistM,
      snap.shapeDistM,
      FUSE_MAX_CORRECTION_M + 50,
    );
    if (sProj === null) return snap;
    const disagreeM = Math.abs(sProj - snap.shapeDistM);
    if (disagreeM <= FUSE_COORD_DISAGREE_M) return snap;
    if (disagreeM > FUSE_MAX_CORRECTION_M) return snap;
    // Sanity: a projection that lands far off the rail is a guess, not a fix.
    if (haversineM(pointAt(geom.coordinates, geom.cumDistM, sProj), snap.coordinates) > FUSE_OFFTRACK_MAX_M) {
      return snap;
    }
    // Monotone guard against this vehicle's own previous fused fix: trams do
    // not reverse, so a strongly backward projection is capped, not obeyed.
    const prevF = lastFix.get(snap.key);
    let fused = sProj;
    if (
      prevF &&
      prevF.snap.tripId === snap.tripId &&
      fused < prevF.snap.shapeDistM - FUSE_BACKWARD_TOL_M
    ) {
      fused = prevF.snap.shapeDistM - FUSE_BACKWARD_TOL_M;
    }
    fuseApplied++;
    fuseMetersSum += Math.abs(fused - snap.shapeDistM);
    return { ...snap, shapeDistM: round2(Math.max(0, Math.min(geom.totalM, fused))) };
  }

  function processSnapshot(rawSnap: TramSnapshot, batchAtMs: number, events: ScoringEvent[]): void {
    const snap = fuseSnap(rawSnap);
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

    // M2 freshness probe: the instant a genuinely-new fix lands (≈ when the
    // phone's RemoteFeed dot moves), how far BEHIND it is each chain's
    // currently served opinion curve? Clients add up to ~7–9 s of poll+cache
    // lag on top of this before the re-anchored curve reaches their screen.
    const pubEntry = trajectories.get(snap.key);
    if (pubEntry && pubEntry.v2.tripId === snap.tripId && pubEntry.fixObsAtMs < snap.observedAtMs) {
      freshPub.note(snap.key, pubEntry.v2.opinion, snap.shapeDistM, nowMs);
    }
    const shEntry = shadowTrajectories.get(snap.key);
    if (shEntry && shEntry.v2.tripId === snap.tripId && shEntry.fixObsAtMs < snap.observedAtMs) {
      freshShadow.note(snap.key, shEntry.v2.opinion, snap.shapeDistM, nowMs);
    }

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

    // §14.3 jam evidence (descends from tramSim.updateStuckHold): a
    // genuinely-new same-trip fix that has NOT moved (≤ STUCK_FIX_EPS_M) is
    // standing evidence — unless the feed says at_stop (the modal rule owns
    // platforms) or the fix rests within STUCK_NEAR_STOP_M of one (platform
    // semantics win). Any moved fix clears it, and the very next refresh
    // cycle re-emits — a jam exit reaches the screen within one poll.
    let stuckAtM: number | null = null;
    if (
      prev &&
      sameTrip &&
      geom &&
      snap.statePosition !== 'at_stop' &&
      Math.abs(snap.shapeDistM - prev.snap.shapeDistM) <= STUCK_FIX_EPS_M
    ) {
      let nearStop = geom.totalM - snap.shapeDistM <= STUCK_NEAR_STOP_M;
      for (const st of geom.stops) {
        if (st.distM > snap.shapeDistM + STUCK_NEAR_STOP_M) break;
        if (Math.abs(st.distM - snap.shapeDistM) <= STUCK_NEAR_STOP_M) {
          nearStop = true;
          break;
        }
      }
      // Cross-check against the OTHER representation of the same two fixes:
      // the axis routinely freezes while the coordinates keep driving (the
      // ±70 m feed self-contradiction). A flat axis alone declared PHANTOM
      // jams — the drive then held the tram mid-block for the whole next fix
      // gap (p90 ~79 s) while the coords showed it long gone. Standing is
      // asserted only when BOTH representations agree.
      if (!nearStop) {
        const coordAdvanceM =
          projectDistanceOnPolyline(snap.coordinates, geom.coordinates, geom.cumDistM) -
          projectDistanceOnPolyline(prev.snap.coordinates, geom.coordinates, geom.cumDistM);
        if (Math.abs(coordAdvanceM) <= STUCK_COORD_EPS_M) stuckAtM = snap.shapeDistM;
      }
    }
    lastFix.set(snap.key, { snap, cycle, fixGapS: gapS > 0 ? round2(gapS) : 0, stuckAtM, rawShapeDistM: rawSnap.shapeDistM });
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

    const stale: {
      key: string;
      snap: TramSnapshot;
      geom: RouteGeometry;
      fixGapS: number;
      stuckAtM: number | null;
      clientFixS: number;
    }[] = [];
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
      stale.push({ key, snap: lf.snap, geom, fixGapS: lf.fixGapS, stuckAtM: lf.stuckAtM, clientFixS: lf.rawShapeDistM });
    }
    if (stale.length === 0) {
      trajBuiltAtMs = tCompute; // set validated, nothing to recompute
      return;
    }

    // §14.4 anti-collision: same-shape ordering by fix positions. Leaders
    // (larger fix s) are rebuilt FIRST within a shape, so a same-cycle
    // follower always clips against its leader's freshest curve — the cascade
    // is bounded because emitted curves are static once built.
    stale.sort((a, b) =>
      a.geom.shapeId === b.geom.shapeId
        ? b.snap.shapeDistM - a.snap.shapeDistM
        : a.geom.shapeId < b.geom.shapeId
          ? -1
          : 1,
    );
    const byShape = new Map<string, { key: string; fixS: number; snap: TramSnapshot }[]>();
    for (const [key, lf] of lastFix) {
      const g = geometry.resolve(lf.snap.tripId);
      if (!g) continue;
      let arr = byShape.get(g.shapeId);
      if (!arr) byShape.set(g.shapeId, (arr = []));
      arr.push({ key, fixS: lf.snap.shapeDistM, snap: lf.snap });
    }
    for (const arr of byShape.values()) arr.sort((x, y) => x.fixS - y.fixS);
    // §14.4 crossing repair: a leader that re-anchored BACKWARD can invalidate
    // follower curves built before it (the follower could not have known).
    // Any non-stale shadow entry whose curve now penetrates its current
    // leader's is re-emitted this cycle — the seam machinery keeps continuity
    // and the effective-gap clamp freezes (never grows) the overlap.
    const staleKeys = new Set(stale.map((x) => x.key));
    const probeCrossing = (): void => {
      for (const [key, entry] of shadowTrajectories) {
        if (staleKeys.has(key)) continue;
        const lf = lastFix.get(key);
        if (!lf) continue;
        const g = geometry.resolve(lf.snap.tripId);
        if (!g) continue;
        const lead = leaderFor(shadowTrajectories, key, g.shapeId, lf.snap.shapeDistM, false);
        if (!lead) continue;
        for (const dt of [0, 30_000, 60_000]) {
          const t = tCompute + dt;
          if (
            evalTrack(entry.v2.opinion, t) > evalTrack(lead.opinion, t) - 0.5 ||
            evalTrack(entry.v2.smooth, t) > evalTrack(lead.smooth, t) - 0.5
          ) {
            stale.push({ key, snap: lf.snap, geom: g, fixGapS: lf.fixGapS, stuckAtM: lf.stuckAtM, clientFixS: lf.rawShapeDistM });
            staleKeys.add(key);
            break;
          }
        }
      }
    };

    /** Immediate same-shape leader's CURRENT curves from `chain` + the
     *  clearance to keep (QUEUE_GAP_M + leader length, coupled-aware).
     *  Ordering uses each vehicle's CURRENT NOWCAST (its chain curve at
     *  tCompute, itself fix-floored), not raw fix positions: fixes of unequal
     *  age invert pairs — a stale-fix vehicle's real position can be far past
     *  a "leader" whose fresh fix is only nominally ahead (measured live
     *  2026-08-17: one inverted pair chained a vehicle to a phantom 200 m
     *  behind it). `ordS` is the caller's own nowcast on the same basis. */
    const leaderFor = (
      chain: Map<string, { v2: V2Vehicle; fixObsAtMs: number }>,
      key: string,
      shapeId: string,
      ordS: number,
      /** false for the crossing probe's lookups — they ask the same question
       *  but on a different population, and mixing them makes the outcome
       *  rates uninterpretable. */
      tally = true,
    ): { key: string; opinion: TrajectoryPoint[]; smooth: TrajectoryPoint[]; gapM: number } | null => {
      const pick = tally ? leaderPick : leaderPickScratch;
      pick.calls++;
      const arr = byShape.get(shapeId);
      if (!arr) {
        pick.noCandidate++;
        return null;
      }
      if (leaderMemory.size > 20_000) leaderMemory.clear(); // bounded memory
      const self = arr.find((c) => c.key === key);
      let aliasExcluded = 0;
      const cands: { c: { key: string; fixS: number; snap: TramSnapshot }; cOrd: number }[] = [];
      for (const c of arr) {
        if (c.key === key) continue;
        // Alias pair: two "vehicles" with fixes closer than a tram length are
        // physically one consist double-reported (or siding odometry
        // aliasing) — no ordering can hold and mutual clipping interleaves
        // the curves (measured live 2026-08-17: two L9V3 pairs flip-flopping
        // at < 15 m separation). Not a queue; skip.
        if (self && Math.abs(c.fixS - self.fixS) < 15) {
          aliasExcluded++;
          continue;
        }
        // Ordering basis per §14.4: FIXES are the evidence ("overtaking is
        // rare" — a fresh fix outranks any model belief; the first live
        // window measured an ML curve "overtaking" a real leader by 289 m).
        //
        // 2026-08-19: the ordering no longer falls back to the chain nowcast
        // past a 30 s fix age. ORDER and POSITION age at completely different
        // rates — which of two trams on one rail is in front is a topological
        // fact that survives minutes of silence (that IS "overtaking is
        // rare"), while the projected position diverges fast: measured
        // fleet-wide this window, a curve sits a median 343 m past its own fix
        // at 60–120 s of fix age (max 1231 m). Promoting the nowcast let a
        // diverging curve declare ITSELF the leader, which legitimised the
        // crossing instead of preventing it — the 2026-08-19 bytes probe
        // found 30 crossings up to 336 m, 28 of them with a stale fix on at
        // least one side and only 2 fresh/fresh, on pairs whose FIXES were a
        // queue-distance 20–32 m apart. The phantom-cap failure this fallback
        // was built for (a stale vehicle chained to a leader it has really
        // passed) is now handled where it belongs — `effLeader`'s inversion
        // band, which clips-and-heals rather than dropping the constraint.
        // Ordering is now fix-based throughout, matching the alias exclusion
        // and the leadership memory, which were already reading raw fixes.
        const cOrd = c.fixS;
        if (cOrd <= ordS + 0.5) continue;
        cands.push({ c, cOrd });
      }
      cands.sort((x, y) => x.cOrd - y.cOrd);
      let best: { key: string; fixS: number; snap: TramSnapshot } | null = null;
      let bestOrd = Infinity;
      let memoryHeld = false;
      for (const { c, cOrd } of cands) {
        const pairKey = key < c.key ? `${key}|${c.key}` : `${c.key}|${key}`;
        if (cOrd - ordS < 30) {
          const mem = leaderMemory.get(pairKey);
          if (mem === key) {
            memoryHeld = true;
            continue; // near-tied and memory says I lead
          }
          if (mem === undefined) leaderMemory.set(pairKey, c.key);
        } else {
          leaderMemory.set(pairKey, c.key); // genuine separation — update
        }
        best = c;
        bestOrd = cOrd;
        break;
      }
      if (best === null) {
        if (memoryHeld) pick.memoryHeld++;
        else if (aliasExcluded > 0 && cands.length === 0) pick.aliasOnly++;
        else pick.noCandidate++;
        return null;
      }
      if (bestOrd - ordS > 1500) {
        pick.tooFar++;
        return null; // never binds
      }
      const entry = chain.get(best.key);
      if (!entry) {
        pick.noEntry++;
        return null;
      }
      // Freshness: the leader's curve must reflect its NEWEST fix — a stale
      // curve can sit behind the follower's fresh position and would cap the
      // follower onto a phantom (the leader rebuilds within one poll cycle).
      if (entry.fixObsAtMs !== best.snap.observedAtMs) {
        pick.staleCurve++;
        return null;
      }
      const lg = geometry.resolve(entry.v2.tripId);
      if (!lg || lg.shapeId !== shapeId) {
        pick.otherRail++;
        return null; // stale curve, other rail
      }
      pick.bound++;
      const modelId = regNumberToModelId(best.snap.registrationNumber);
      const lenM =
        (getModelSpec(modelId)?.totalLengthM ?? 14.1) +
        (isLikelyCoupledPair(modelId, best.snap.line) ? COUPLED_TRAILER_OFFSET_M : 0);
      return {
        key: best.key,
        opinion: entry.v2.opinion,
        smooth: entry.v2.smooth,
        gapM: QUEUE_GAP_M + lenM,
      };
    };
    probeCrossing();
    // Re-sort: the crossing probe may have appended followers; leaders first.
    stale.sort((a, b) =>
      a.geom.shapeId === b.geom.shapeId
        ? b.snap.shapeDistM - a.snap.shapeDistM
        : a.geom.shapeId < b.geom.shapeId
          ? -1
          : 1,
    );

    // ── the two-phase emission (owner doctrine, 2026-08-21 evening) ─────────
    // A fresh fix must move the FIXED point the same second it lands, not an
    // ML round trip later. So every fix-driven rebuild emits TWICE:
    //   pass 1  INSTANT: the learned-walker naive prediction — pure TS, sub-ms
    //           per vehicle — through the same generator, published to Convex
    //           immediately (`source: 'naive'` on the wire);
    //   pass 2  the ML upgrade: when predictBatch returns, the same vehicle is
    //           re-emitted from the ml-gbdt targets (`source: 'ml'`), chaining
    //           through the pass-1 emission's seam state, and replaces it in
    //           Convex a second or two later.
    // If ML is down, pass 2 simply never lands and the fleet keeps driving on
    // pass-1 physics — the "switch to the simple model" is now the default
    // path exercised on every fix, not a dusty failure branch.
    const naivePointsFor = (v: {
      key: string;
      snap: TramSnapshot;
      geom: RouteGeometry;
    }): TrajectoryPoint[] => {
      const anchorS = Math.min(v.geom.totalM, Math.max(0, v.snap.shapeDistM));
      const fixAgeS = Math.max(0, (tCompute - v.snap.observedAtMs) / 1000);
      // The learned walker (release holds + learned pace) is the naive model;
      // its own anchor covers the trip guard. The FALLBACK (no walker anchor —
      // fresh trips, cold vehicles) must not invent motion: a tram the feed
      // says is standing holds AT its fix, and a moving one dead-reckons the
      // feed latency only up to NAIVE_LATENCY_CAP_S — pace × unbounded fix-age
      // inflated standing trams forward, and the next fix corrected them
      // BACKWARD as a teleport (the build-22 «клоунада» class).
      const standing = v.snap.statePosition === 'at_stop';
      const latencyS = standing ? 0 : Math.min(fixAgeS, NAIVE_LATENCY_CAP_S);
      const naive: TrajectoryPoint[] = [];
      let maxS = anchorS;
      for (let k = 0; k < TRAJ_POINTS; k++) {
        const t = tCompute + k * TRAJ_STEP_MS;
        const walked = learned.predict(v.key, t, v.geom);
        const fallbackS = standing
          ? anchorS
          : anchorS +
            Math.max(0.5, learned.paceAt(v.geom.shapeId, v.geom.routeId, anchorS, t)) *
              (latencyS + (k * TRAJ_STEP_MS) / 1000);
        const s = walked !== null && Number.isFinite(walked) ? walked : fallbackS;
        maxS = Math.max(maxS, Math.min(v.geom.totalM, Math.max(anchorS, s)));
        naive.push({ t, s: round2(maxS) });
      }
      return naive;
    };

    // Anchor-floor hotfix (2026-08-17): the anchor fix is a hard floor — the
    // tram provably was at shapeDistM at anchor time and does not reverse, so
    // an ML Δs < 0 is model error, clamped to 0; independently-predicted
    // horizons can jitter backwards, clamped monotone. Null = unusable answer.
    const mlPointsFor = (
      v: { snap: TramSnapshot; geom: RouteGeometry },
      gi: number,
      gbdt: (number | null)[],
    ): TrajectoryPoint[] | null => {
      const anchorS = Math.min(v.geom.totalM, Math.max(0, v.snap.shapeDistM));
      const points: TrajectoryPoint[] = [];
      let dsClampedHere = 0;
      let maxS = 0;
      for (let k = 0; k < TRAJ_POINTS; k++) {
        const ds = gbdt[gi * TRAJ_POINTS + k];
        if (ds === null || !Number.isFinite(ds)) return null;
        if (ds < 0) dsClampedHere++;
        const sK = Math.min(v.geom.totalM, Math.max(anchorS, v.snap.shapeDistM + ds));
        maxS = k === 0 ? sK : Math.max(maxS, sK);
        points.push({ t: tCompute + k * TRAJ_STEP_MS, s: round2(maxS) });
      }
      if (dsClampedHere > 0) {
        anchorDsClampedPoints += dsClampedHere;
        anchorDsClampedEmissions++;
      }
      return points;
    };

    /** One vehicle through the generator into the published (and optionally
     *  shadow) chain. `tEmit` is THIS emission's birth — pass 1 and pass 2
     *  must never share one, or two different byte-sets would claim the same
     *  blend anchor. */
    const buildAndStore = (
      v: { key: string; snap: TramSnapshot; geom: RouteGeometry; fixGapS: number; stuckAtM: number | null; clientFixS: number },
      points: TrajectoryPoint[],
      source: 'ml' | 'naive',
      includeShadow: boolean,
    ): void => {
      const tEmit = Date.now();
      const anchorS = Math.min(v.geom.totalM, Math.max(0, v.snap.shapeDistM));
      // The target grid is anchored at tCompute, but THIS emission is born at
      // tEmit — up to a couple of ML-latency seconds later — and the protocol
      // horizon (≥ 120 s past emittedAtMs) is measured from the birth. The v2
      // builders therefore consume a PADDED grid (one extra keyframe
      // continuing the final segment's pace) so the horizon never comes up
      // seconds short (the check-v2 «horizon 119s» class introduced by the
      // two-phase restructure). The v1 feed keeps the exact 13-point shape —
      // its wire contract is frozen for build-12 phones.
      let padded = points;
      if (points.length >= 2) {
        const last = points[points.length - 1];
        const prev = points[points.length - 2];
        const padS = Math.min(v.geom.totalM, last.s + Math.max(0, last.s - prev.s));
        padded = [...points, { t: last.t + TRAJ_STEP_MS, s: round2(padS) }];
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
          emittedAtMs: tEmit,
          raw: padded,
        };
        // The drive consumes the learned surfaces through a narrow adapter so
        // its unit tests can inject constants (design §8: builder ≠ measure).
        const surfaces = {
          paceAt: (sM: number, atMs: number) =>
            learned.paceAt(v.geom.shapeId, v.geom.routeId, sM, atMs),
          dwellStats: (stopId: string, atMs: number) => learned.dwellStats(stopId, atMs),
        };

        // Anchor-floor hotfix, age-refresh clause: on a SAME-ANCHOR (age)
        // re-emission the fresh ML nowcast may jitter backward with no new
        // evidence; the opinion is floored at the previously rendered opinion
        // position, PER CHAIN (published and shadow chains re-emit from their
        // own previous curves). Fix-driven re-emissions get no such floor —
        // fresh evidence is never dampened; the floored `raw` already bounds
        // them at the new fix itself.
        const prevShadow = shadowTrajectories.get(v.key);
        const prevEntry = trajectories.get(v.key);
        const ageFloorOf = (pv: V2Vehicle | undefined, pFixObsAtMs: number | undefined): number =>
          pv !== undefined && pv.tripId === v.snap.tripId && pFixObsAtMs === v.snap.observedAtMs
            ? evalTrack(pv.opinion, tEmit)
            : 0;
        const ageFloorShadowS = ageFloorOf(prevShadow?.v2, prevShadow?.fixObsAtMs);
        // The pass-2 ML upgrade must not be floored at the pass-1 NAIVE
        // opinion: the floor exists to damp same-evidence nowcast jitter, but
        // here the ML answer is strictly better information about the same
        // anchor — flooring it locked pass-1 error in, and the NEXT fix then
        // corrected the whole chain backward as a teleport (build-22 G13).
        // The smooth track still seams from the previous curve, so releasing
        // the opinion floor cannot make the rendered smooth marker jump.
        const ageFloorPubS =
          prevEntry?.source === 'naive' && source === 'ml'
            ? 0
            : ageFloorOf(prevEntry?.v2, prevEntry?.fixObsAtMs);
        // §14.7 seam-rule input: the PREVIOUS emission's anchor fix, present
        // exactly when this is a FIX-DRIVEN re-emission of the same trip.
        const seamPrevFixOf = (
          pv: V2Vehicle | undefined,
          pFixObsAtMs: number | undefined,
          pAnchorFixS: number | undefined,
        ): number | undefined =>
          pv !== undefined &&
          pv.tripId === v.snap.tripId &&
          pFixObsAtMs !== undefined &&
          pFixObsAtMs !== v.snap.observedAtMs
            ? pAnchorFixS
            : undefined;
        const seamPrevFixShadowS = seamPrevFixOf(
          prevShadow?.v2,
          prevShadow?.fixObsAtMs,
          prevShadow?.anchorFixS,
        );
        const seamPrevFixPubS = seamPrevFixOf(
          prevEntry?.v2,
          prevEntry?.fixObsAtMs,
          prevEntry?.anchorFixS,
        );

        if (includeShadow) {
        // ── curvegen-v3 SHADOW build (design §12 phase A): its own seam
        // chain, its own realism gate + perceptual counters, never published
        // while TRAJ_V3_PUBLISH is off.
        const shadowBuilt: DriveBuilt | null = buildDriveVehicle({
          ...baseArgs,
          modal: modal ? { stopS: modal.stopS, releaseAtMs: modal.releaseAtMs } : null,
          geom: v.geom,
          surfaces,
          fixGapS: v.fixGapS,
          ageFloorS: ageFloorShadowS,
          anchorFixS: v.snap.shapeDistM,
          prevFixS: seamPrevFixShadowS,
          stuckAtM: v.stuckAtM,
          leader: leaderFor(shadowTrajectories, v.key, v.geom.shapeId, v.snap.shapeDistM),
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
          if (shadowBuilt.meta.ageFloorApplied) ageFloorShadowApplied++;
          if (shadowBuilt.meta.seamFloorApplied) seamFloorShadowApplied++;
          realismShadow.check(v.key, 'opinion', shadowBuilt.vehicle.opinion, tEmit);
          realismShadow.check(v.key, 'smooth', shadowBuilt.vehicle.smooth, tEmit);
          realismShadow.checkAnchorFloor(v.key, shadowBuilt.vehicle.opinion, anchorS, tEmit);
          perceptual.record({
            key: v.key,
            emittedAtMs: tEmit,
            latestFixS: v.clientFixS,
            anchorMs: v.snap.observedAtMs,
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
            requestSkips: shadowBuilt.meta.requestSkips,
            jamHolding: shadowBuilt.meta.jamHolding,
            leaderKey: shadowBuilt.meta.leaderKey,
            standingStart: shadowBuilt.meta.standingStart,
            leaderDroppedInverted: shadowBuilt.meta.leaderDroppedInverted,
            perTrack: { opinion: shadowBuilt.meta.opinion, smooth: shadowBuilt.meta.smooth },
          });
          // Re-anchor seam telemetry (fix-driven re-emissions only): what a
          // client swapping from the previous shadow curve to this one renders.
          if (
            prevShadow &&
            prevShadow.v2.tripId === v.snap.tripId &&
            prevShadow.fixObsAtMs !== v.snap.observedAtMs
          ) {
            seamShadow.record({
              key: v.key,
              emittedAtMs: tEmit,
              prevOpinion: prevShadow.v2.opinion,
              newOpinion: shadowBuilt.vehicle.opinion,
              latestFixS: v.clientFixS,
              prevFixS: prevShadow.anchorFixS,
              anchorMs: v.snap.observedAtMs,
              fixGapS: v.fixGapS,
              standingStart:
                (modal !== null && modal.releaseAtMs > tEmit + TRAJ_STAND_ASSERT_MS) ||
                shadowBuilt.meta.jamHolding,
              discontinuity: shadowBuilt.vehicle.discontinuity,
            });
          }
          shadowTrajectories.set(v.key, {
            fixObsAtMs: v.snap.observedAtMs,
            anchorFixS: v.snap.shapeDistM,
            v2: shadowBuilt.vehicle,
            opinionK: shadowBuilt.opinion,
            smoothK: shadowBuilt.smooth,
            target: points,
          });
          shadowChainBroken.delete(v.key);
        }

        }

        // ── the PUBLISHED bundle: the current generator until the flip flag
        // turns, then the v3 drive on the published chain's own seam state
        // (phase B: ml-mode/ml-smooth then measure the published v3 pixels).
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
              ageFloorS: ageFloorPubS,
              anchorFixS: v.snap.shapeDistM,
              clientFixS: v.clientFixS,
              prevFixS: seamPrevFixPubS,
              stuckAtM: v.stuckAtM,
              leader: leaderFor(trajectories, v.key, v.geom.shapeId, v.snap.shapeDistM),
              chainBroken: publishedChainBroken.has(v.key),
              prev: prevPub,
            })
          : buildV2Vehicle({
              ...baseArgs,
              modal,
              prev: prevPub,
              ageFloorS: ageFloorPubS,
              anchorFixS: v.snap.shapeDistM,
              clientFixS: v.clientFixS,
              prevFixS: seamPrevFixPubS,
              fixGapS: v.fixGapS,
            });
        if (built === null) {
          trajectories.delete(v.key);
          publishedChainBroken.add(v.key);
          return;
        }
        if ('meta' in built ? built.meta.ageFloorApplied : built.ageFloorApplied) {
          ageFloorPubApplied++;
        }
        if ('meta' in built ? built.meta.seamFloorApplied : built.seamFloorApplied) {
          seamFloorPubApplied++;
        }
        const v2 = built.vehicle;
        trajEmissions++;
        if (v2.discontinuity) trajDiscontinuities++;
        // Realism gate, continuous side: measure what we are about to publish
        // exactly as a lerping client will experience it (protocol §Kinematic
        // limits). Counters are lifetime, so a regression surfaces in digests.
        realism.check(v.key, 'opinion', v2.opinion, tEmit);
        realism.check(v.key, 'smooth', v2.smooth, tEmit);
        realism.checkAnchorFloor(v.key, v2.opinion, anchorS, tEmit);

        // Re-anchor seam telemetry, published chain (fix-driven only).
        if (
          prevEntry &&
          prevEntry.v2.tripId === v.snap.tripId &&
          prevEntry.fixObsAtMs !== v.snap.observedAtMs
        ) {
          seamPub.record({
            key: v.key,
            emittedAtMs: tEmit,
            prevOpinion: prevEntry.v2.opinion,
            newOpinion: v2.opinion,
            latestFixS: v.clientFixS,
            prevFixS: prevEntry.anchorFixS,
            anchorMs: v.snap.observedAtMs,
            fixGapS: v.fixGapS,
            standingStart: modal !== null && modal.releaseAtMs > tEmit + TRAJ_STAND_ASSERT_MS,
            discontinuity: v2.discontinuity,
          });
        }

        trajectories.set(v.key, {
          fixObsAtMs: v.snap.observedAtMs,
          anchorFixS: v.snap.shapeDistM,
          source,
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
    };

    // ── pass 1: instant naive re-anchor — WHEN a correction is actually due ─
    // The doctrine: a fresh fix must move the marker the same second it lands.
    // But when the old ML curve already passes within INSTANT_NAIVE_GAP_M of
    // the new fix, it IS the better answer for the next ~2 s — replacing it
    // with a worse naive model added two seams and visible jitter to every
    // fix window (build-22 field report). So pass 1 fires exactly when the
    // old curve is provably wrong: gone, wrong trip, overrun entirely
    // (the τ=∞ teleport class), or off by more than the gate.
    const instant = stale.filter((x) => {
      const entry = trajectories.get(x.key);
      if (entry === undefined) return true;
      if (entry.fixObsAtMs === x.snap.observedAtMs) return false; // not fix-driven
      if (entry.v2.tripId !== x.snap.tripId) return true;
      const o = entry.v2.opinion;
      if (o.length === 0) return true;
      if (x.snap.shapeDistM > o[o.length - 1].s + 1) return true; // overrun
      return Math.abs(x.snap.shapeDistM - evalTrack(o, x.snap.observedAtMs)) > INSTANT_NAIVE_GAP_M;
    });
    for (const v of instant) {
      buildAndStore(v, naivePointsFor(v), 'naive', false);
      trajNaiveEmissions++;
    }
    if (instant.length > 0) {
      trajBuiltAtMs = tCompute;
      await publisher.publishCycle(
        trajectories,
        tCompute,
        TRAJ_V3_PUBLISH ? 'drive-v3' : 'current',
      );
    }

    // ── pass 2: the ML upgrade, chunked on vehicle boundaries ───────────────
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
        // ML down / not ready: pass 1 already covers every fix-driven vehicle
        // with naive physics, and an age-driven rebuild keeps its old curve.
        trajMlHeld += group.length;
        continue;
      }
      group.forEach((v, gi) => {
        const points = mlPointsFor(v, gi, pred.gbdt);
        if (points === null) {
          trajMlHeld++;
          return; // unusable ML answer for this vehicle — naive/old curve stands
        }
        buildAndStore(v, points, 'ml', true);
      });
    }
    trajBuiltAtMs = tCompute;
  }

  /** Detached refresh with an in-flight guard — never awaited by the poller. */
  function kickTrajectoryRefresh(): void {
    if (trajRefreshing) return;
    trajRefreshing = true;
    refreshTrajectories()
      .then(() =>
        // The promotion seam: every refresh publishes its delta (or a
        // heartbeat) to Convex, where the app now reads the curves. Detached
        // from serving and never throws (publish.ts).
        publisher.publishCycle(
          trajectories,
          trajBuiltAtMs,
          TRAJ_V3_PUBLISH ? 'drive-v3' : 'current',
        ),
      )
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
      for (const raw of full.vehicles) {
        const v = fuseSnap(raw);
        fleet.set(v.key, v);
        learned.reseed(v);
        lastFix.set(v.key, { snap: v, cycle, fixGapS: 0, stuckAtM: null, rawShapeDistM: raw.shapeDistM });
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
        /** ML-outage doctrine telemetry: curves held vs naive substitutes. */
        mlHeld: trajMlHeld,
        naiveEmissions: trajNaiveEmissions,
        publish: publisher.gauges(),
        fusedAxis: {
          applied: fuseApplied,
          meanM: fuseApplied > 0 ? round2(fuseMetersSum / fuseApplied) : 0,
        },
        geometryPack: publisher.packGauges(),
        probe: { ok: probeOk, missing: probeMissing, staleAnchor: probeStaleAnchor, tripMismatch: probeTripMismatch },
        /** Anchor-floor hotfix telemetry: exactly where bytes may differ from
         *  the pre-hotfix builders (everywhere else: pure fn, same inputs). */
        anchorFloor: {
          dsClampedPoints: anchorDsClampedPoints,
          dsClampedEmissions: anchorDsClampedEmissions,
          ageFloorPublished: ageFloorPubApplied,
          ageFloorShadow: ageFloorShadowApplied,
          seamFloorPublished: seamFloorPubApplied,
          seamFloorShadow: seamFloorShadowApplied,
        },
      },
      realism: realism.gauges(),
      shadow: {
        generator: 'drive-v3',
        published: TRAJ_V3_PUBLISH,
        vehicles: shadowTrajectories.size,
        emissions: shadowEmissions,
        discontinuities: shadowDiscontinuities,
        buildFailures: shadowBuildFailures,
        leaderPick,
        probe: {
          ok: shadowProbeOk,
          missing: shadowProbeMissing,
          staleAnchor: shadowProbeStaleAnchor,
          tripMismatch: shadowProbeTripMismatch,
        },
        realism: realismShadow.gauges(),
      },
      perceptual: perceptual.gauges(),
      /** Re-anchor seam telemetry + G13 (owner field report 2026-08-18): the
       *  cross-emission backward-swap class the G10 floor cannot see, and the
       *  M2 freshness race, per chain. */
      seam: {
        published: { swap: seamPub.gauges(), freshness: freshPub.gauges() },
        shadow: { swap: seamShadow.gauges(), freshness: freshShadow.gauges() },
      },
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
    const lf = lastFix.get(key);
    // Promotion-era truth for the devtools: which fix the served curve was
    // predicted FROM, whether it renders ml-gbdt or the naive substitute,
    // whether this exact emission has reached Convex, and whether the ML
    // service is even answering — everything "какого хуя" needs in one fetch.
    const pubEmitted = publisher.publishedEmittedAtMs(key);
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
      /** ml-gbdt keyframes or the learned-walker substitute (published chain). */
      curveSource: source === 'published' ? (entry as TrajectoryEntry).source : null,
      /** The fix the served curve was anchored to (obsAt + shapeDist). */
      anchorFix:
        source === 'published'
          ? {
              obsAtMs: (entry as TrajectoryEntry).fixObsAtMs,
              s: (entry as TrajectoryEntry).anchorFixS,
            }
          : null,
      /** The newest fix the ENGINE holds (compare against anchorFix for lag). */
      latestFix: lf
        ? {
            obsAtMs: lf.snap.observedAtMs,
            s: lf.snap.shapeDistM,
            statePosition: lf.snap.statePosition,
            fixGapS: lf.fixGapS,
            stuckAtM: lf.stuckAtM,
          }
        : null,
      /** ML service health as this engine sees it. */
      ml: { ready: ml.modelsReady, lastOkMs: ml.lastOkMs, lastError: ml.lastError },
      /** Convex publication state of THIS vehicle's current emission. */
      publish: {
        enabled: publisher.enabled,
        emittedAtMs: pubEmitted,
        synced: pubEmitted !== null && pubEmitted === entry.v2.emittedAtMs,
      },
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
  // Cold-start geometry pack → Convex file storage (the app reads it from
  // tram-site since 2026-08-21). First upload once the fleet has geometry,
  // then refresh every 5 min; uploadGeometryPack itself skips unchanged packs.
  const uploadPack = (): void => {
    if (!publisher.enabled || fleet.size === 0) return;
    void publisher.uploadGeometryPack(getGeometryPack());
  };
  setTimeout(uploadPack, 90_000);
  setInterval(uploadPack, 5 * 60_000);
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
