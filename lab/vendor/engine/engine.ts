// TramEngine (v2): owns all per-tram sims. Pure TS, deterministic, no timers —
// the caller drives ingest() on each poll and tick() at frame rate.
// Depends only on '@/lib/types' + sibling engine/geo modules; the fleet model
// resolver is injected so the engine stays free of fleet/golemio imports.
//
// v2 architecture (docs/decisions/engine-v2.md): per tram the engine keeps
//   fix       — the raw AVL snapshot (layer 0, "raw" mode's anchor),
//   predictor — best estimate of the REAL tram now (tramSim.ts, "live" mode),
//   smoother  — cinematic tracker of the predictor (smoother.ts, "smooth").
// The smoother's ONLY reference is the predictor, so the smooth/live
// mode-divergence class of the v1 dual-controller design is gone structurally.
// Queue / cross-shape / junction constraints run on BOTH fleets, discovered at
// ingest from each fleet's own positions and applied O(1)/pair per substep
// (performance invariant #8: the tick path allocates nothing).

import type {
  RouteGeometry,
  SimDebugInfo,
  TramModelSpec,
  TramPublicState,
  TramSnapshot,
} from '@/lib/types';
import {
  bearingAt,
  bearingBetween,
  haversineM,
  pointAt,
  projectPointToPolyline,
  segmentIndexAt,
} from '../geo/polyline';
import {
  A_BRK,
  brakeTowards,
  buildSpeedProfile,
  cruiseCapAt,
  curveCap,
  DEFAULT_LOOKAHEAD_M,
  pragueHour,
  todPaceFactor,
  vAllowedAt,
  zoneCapAt,
  type SpeedProfile,
} from './speedProfile';
import {
  applySnapshot,
  createSim,
  cruiseProduct,
  dwellDurationMs,
  FEED_LATENCY_S,
  fixPinActive,
  holdPointOf,
  minStopDistOf,
  resyncPredictor,
  STOP_REACH_M,
  TELEPORT_THRESHOLD_M,
  teleportThresholdM,
  tick as tickSim,
  type TramSim,
} from './tramSim';
import {
  createSmoother,
  fadeTeleportSmoother,
  reanchorSmoother,
  tickSmoother,
  TRAIL_M,
  type SmootherSim,
} from './smoother';

/** Trams unseen for this long are dropped. */
export const STALE_AFTER_MS = 90_000;
/**
 * Per-key learned paceBias is remembered this long after the vehicle was last
 * seen, so a tram that drops out (feed gap > STALE_AFTER_MS) or changes trip
 * re-seeds its sims from its own learned pace instead of the fleet prior —
 * drivers don't change at teleports/trip swaps (calibration round 1 R1).
 */
export const PACE_BIAS_MEMORY_TTL_MS = 15 * 60_000;
/** Max offset when re-projecting a tram onto a new trip's geometry, meters. */
const REANCHOR_MAX_OFFSET_M = 100;
/** Max dt for one physics substep, seconds. A tick() spanning more wall time
 *  integrates it in several substeps of at most this — never by clamping. */
const MAX_ENGINE_DT_S = 0.25;
/**
 * Catch-up budget for one tick(), ms: at most this much elapsed wall time is
 * integrated synchronously (in ≤ MAX_ENGINE_DT_S substeps). The rideBackground
 * 1 Hz keep-alive tick must integrate its full 1000 ms (clamping it ran the
 * background simulation 4× slower — audit 2026-07-13 P0). Time beyond the
 * budget is DROPPED, not replayed; true pause/resume calls resetClock().
 */
export const MAX_TICK_CATCHUP_MS = 2_000;
/** In 'coarse' cadence the PREDICTOR fleet advances at most this often. */
export const PROJ_COARSE_INTERVAL_MS = 500;
/** Max wall-clock gap integrated in one coarse predictor advance, seconds. */
const PROJ_COARSE_MAX_GAP_S = 1.5;

/**
 * Predictor tick cadence (§2.4 — the performance invariant stands verbatim:
 * applying/sorting an unchanged second fleet on every 33 ms smooth-mode tick
 * is forbidden): 'full' advances the predictor every substep (live mode
 * renders it at frame rate); 'coarse' batches it at PROJ_COARSE_INTERVAL_MS
 * while the smoother — the rendered layer — advances every substep against a
 * linearly interpolated predictor reference.
 */
export type ProjectionCadence = 'full' | 'coarse';
/** Render/culling anchor selector (v2 tri-state, plus the experimental 'ml'
 *  mode whose distances come from outside the engine — see getStatesInBounds;
 *  booleans stay accepted for the pre-raw call sites: true = 'live',
 *  false = 'smooth'). */
export type PositionAnchor = 'smooth' | 'live' | 'raw' | 'ml';
/** Resolver for the experimental 'ml' anchor: along-shape meters for a vehicle
 *  at a wall-clock instant, or null when the lab published no usable
 *  trajectory for it (src/lib/feed/mlTrajectories.ts). Injected per call so the
 *  engine stays pure — it never imports the feed/store stack. */
export type MlDistResolver = (key: string, tripId: string, nowMs: number) => number | null;
/** Min clearance between a follower's nose and its leader's tail, meters. */
export const QUEUE_GAP_M = 3;
/**
 * Second unit of a coupled two-car set trails this far behind the first, m.
 * Mirrors render/featureBuilder's COUPLED_OFFSET_M (engine must not import
 * render modules) — a coupled set occupies totalLengthM + this along the track.
 */
export const COUPLED_TRAILER_OFFSET_M = 14.5;

// ── cross-shape car-following (field feedback #6, 2026-07-13) ────────────────
// The per-shapeId queue can't see trams of OTHER lines sharing the same
// street/rails (different shapeIds — common in the centre), so they drove
// through each other. Candidate PAIRS are discovered on ingest (grid-bucketed,
// so the tick stays allocation-light — performance invariant #8), separately
// for the predictor fleet and the smoother fleet from each fleet's own
// positions (v2 §2.3: "following" does not preserve time separation, so the
// rendered fleet needs its own pairs). Per tick a pair costs O(1).

/** Max world distance between two sims to be considered a cross-shape pair, m. */
export const CROSS_CANDIDATE_RADIUS_M = 120;
/**
 * Max lateral offset between a sim and the other shape to count as the SAME
 * physical track, m. Tightened 4 → 2 (build-20 regression, 2026-07-17): 4 m
 * admitted adjacent parallel rails and near-misses at crossings/junctions.
 */
export const CROSS_LATERAL_MAX_M = 2;
/**
 * Max bearing difference for "travelling the same way on the same track", deg.
 * Tightened 25 → 12 (build-20 regression): 25° let momentarily-aligned trams
 * at intersections and opposite/branching directions couple.
 */
export const CROSS_BEARING_MAX_DEG = 12;
/**
 * A cross-pair's shape-to-shape offset is measured ONCE at build (ingest) and
 * is valid only where the two rails physically coincide. Once the leader has
 * advanced more than this past the build point the rails may have diverged —
 * the pair is dropped (no effect) until the next ingest re-validates it.
 */
export const CROSS_PAIR_STALE_ADVANCE_M = 30;
/** Grid cell size for candidate discovery, m (≥ CROSS_CANDIDATE_RADIUS_M). */
const CROSS_GRID_CELL_M = 150;

// ── junction conflict yield (complex-junction collisions, 2026-07-19) ────────
// Trams on CROSSING shapes (different bearings) drove visually through each
// other's sides at junctions — the same-direction cross pairs above cannot see
// them. Discovery (ingest only, same grid buckets) samples one tram's path
// forward and finds where it meets the other tram's shape at a genuine
// crossing angle; per tick the pair is O(1): whichever tram is closer to (or
// inside) the conflict zone proceeds, the other YIELDS via a braking-envelope
// speed cap toward a hold point short of the zone. Speed-only — a yielder's
// sM is never rewritten.

/** How far ahead along a tram's own shape a crossing conflict is searched, m. */
export const JUNCTION_LOOKAHEAD_M = 80;
/** Sampling step of the forward path during conflict-point discovery, m. */
const JUNCTION_SAMPLE_STEP_M = 10;
/** Max distance between a sampled path point and the other shape, m. */
const JUNCTION_LATERAL_M = 6;
/**
 * Genuine crossing angles at the conflict point, degrees. Below 25° the
 * shapes are merging/diverging switches or parallel scatter; above 155° they
 * are opposite directions on a shared street — which must NEVER couple.
 */
export const JUNCTION_MIN_ANGLE_DEG = 25;
export const JUNCTION_MAX_ANGLE_DEG = 155;
/** Conflict-zone half-width, m: a yielder holds this far short of the point. */
export const JUNCTION_ZONE_M = 12;
/** A tram has cleared a conflict once its TAIL is this far past the point, m. */
export const JUNCTION_CLEAR_M = 3;
/**
 * A priority tram standing still (below this speed) OUTSIDE the conflict zone
 * blocks nobody — it is dwelling/stuck short of the junction, m/s.
 */
const JUNCTION_STANDSTILL_V_MS = 0.3;
/**
 * Switch/junction slow-down (realism heuristic, 2026-07-19): while a junction
 * pair is active, BOTH trams pass the contested crossing at ≤ SWITCH_SLOW_V_MS
 * within SWITCH_SLOW_RADIUS_M, approached on the braking envelope.
 */
export const SWITCH_SLOW_V_MS = 6.0;
export const SWITCH_SLOW_RADIUS_M = 25;

/** Ignore instantaneous AVL bearings; adopt a raw-position bearing only after this much movement, m. */
const RAW_BEARING_MIN_MOVE_M = 10;
/**
 * A same-shape queue back-clamp larger than this renders as a teleport
 * (lastTeleportMs → feature-builder opacity fade) instead of a visible
 * reverse slide, m. Small clamps (braking-distance leftover) stay put.
 */
export const QUEUE_BACK_FADE_M = 5;

/**
 * The structural slice of a sim that the fleet constraints operate on — both
 * the predictor (TramSim) and the smoother (SmootherSim) satisfy it, so every
 * constraint pass is written ONCE and applied to both fleets (§2.3).
 */
interface RailBody {
  key: string;
  geometry: RouteGeometry;
  sM: number;
  vMs: number;
  lengthM: number;
  yieldHoldM: number | null;
  lastTeleportMs: number;
}

/**
 * A junction conflict pair: shape A crosses shape B at (sConfA on A) ≈
 * (sConfB on B) — a fixed geometric property of the two shapes.
 */
interface JunctionPair {
  a: RailBody;
  b: RailBody;
  sConfA: number;
  sConfB: number;
}

/** A cross-shape follower/leader pair: leader.sM + offsetM ≈ leader's position
 *  in the FOLLOWER's shape coordinates (locally parallel tracks). */
interface CrossPair {
  leader: RailBody;
  follower: RailBody;
  offsetM: number;
  /** leader.sM captured at pair-build time (staleness guard). */
  leaderSAtBuild: number;
}

/** Forward neighbor-cell key deltas (key = ix·2²⁰ + iy) so each unordered
 *  cell pair is visited exactly once during cross-pair discovery. */
const CROSS_NEIGHBOR_OFFSETS = [1, 1_048_576 - 1, 1_048_576, 1_048_576 + 1] as const;

/** Null out both bodies' junction-yield holds for every pair in the list. */
function clearJunctionHolds(pairs: JunctionPair[]): void {
  for (const p of pairs) {
    p.a.yieldHoldM = null;
    p.b.yieldHoldM = null;
  }
}

/**
 * Moderate pass-through cap over a contested junction (see SWITCH_SLOW_V_MS):
 * inside SWITCH_SLOW_RADIUS_M of the conflict point speed is capped at
 * SWITCH_SLOW_V_MS; the approach follows the braking envelope toward the zone
 * edge. O(1), zero allocation, speed-only.
 */
function capSwitchSpeed(body: RailBody, sConfM: number): void {
  const d = sConfM - body.sM;
  const vCap =
    d > SWITCH_SLOW_RADIUS_M
      ? Math.sqrt(
          SWITCH_SLOW_V_MS * SWITCH_SLOW_V_MS + 2 * A_BRK * (d - SWITCH_SLOW_RADIUS_M),
        )
      : SWITCH_SLOW_V_MS;
  if (body.vMs > vCap) body.vMs = vCap;
}

/**
 * Approximate track curvature (rad/m) at sM from the heading change across a
 * ±10 m window — DEBUG-ONLY read (getDebugInfo).
 */
function curvatureAtS(geometry: RouteGeometry, sM: number): number {
  const total = geometry.totalM;
  const s0 = Math.max(0, sM - 10);
  const s1 = Math.min(total, sM + 10);
  const arc = s1 - s0;
  if (arc <= 1e-6) return 0;
  const b0 = bearingAt(geometry.coordinates, geometry.cumDistM, s0);
  const b1 = bearingAt(geometry.coordinates, geometry.cumDistM, s1);
  let d = Math.abs(b1 - b0) % 360;
  if (d > 180) d = 360 - d;
  return (d * (Math.PI / 180)) / arc;
}

export interface TramEngineOptions {
  /** Maps a snapshot to its fleet model spec (injected — keeps engine pure). */
  resolveModel: (snapshot: TramSnapshot) => TramModelSpec;
  /** Override daytime detection (07:00–19:00 Prague time by default). */
  isDaytime?: (nowMs: number) => boolean;
  /**
   * Whether this tram runs as a coupled two-car set (adds trailer length to
   * queue spacing). Default mirrors fleet/registry's isLikelyCoupledPair.
   */
  isCoupled?: (snapshot: TramSnapshot, model: TramModelSpec) => boolean;
}

/** Default coupled-pair rule (kept in sync with fleet/registry). */
function defaultIsCoupled(snapshot: TramSnapshot, model: TramModelSpec): boolean {
  if (!model.runsCoupled || snapshot.line === '23') return false;
  const n = Number(snapshot.line);
  return Number.isInteger(n) && n >= 1 && n <= 26;
}

/** Queue order within one shape: ascending s, deterministic tie-break by key. */
function compareBySimDist(a: RailBody, b: RailBody): number {
  if (a.sM !== b.sM) return a.sM - b.sM;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Allocation-free coordinate/bbox check used by close-zoom fleet culling. */
function coordinateIsInBbox(
  p: readonly [number, number],
  bbox: readonly [number, number, number, number],
): boolean {
  return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
}

/**
 * `pointAt()` necessarily allocates a `[lng, lat]` tuple. Culling used to call
 * it for every tram before discarding almost all of them. Interpolate the two
 * numbers directly and compare them without materialising a point.
 */
function pointAtIsInBbox(
  coordinates: readonly [number, number][],
  cumDistM: number[],
  distM: number,
  bbox: readonly [number, number, number, number],
): boolean {
  const n = coordinates.length;
  if (n === 0) return false;
  if (n === 1) return coordinateIsInBbox(coordinates[0], bbox);
  const total = cumDistM[n - 1];
  const d = Math.min(Math.max(distM, 0), total);
  const i = segmentIndexAt(cumDistM, d);
  const a = coordinates[i];
  const b = coordinates[i + 1];
  const segLen = cumDistM[i + 1] - cumDistM[i];
  const t = segLen <= 1e-9 ? 0 : (d - cumDistM[i]) / segLen;
  const lng = a[0] + (b[0] - a[0]) * t;
  const lat = a[1] + (b[1] - a[1]) * t;
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

interface Entry {
  key: string;
  snapshot: TramSnapshot;
  tripId: string;
  lastSeenMs: number;
  /**
   * Layer 1 — best estimate of the REAL tram now. Reseeds on every
   * genuinely-new fix; live mode renders its sM (projectedObservedDistM).
   */
  predictor: TramSim | null;
  /**
   * Layer 2 — the rendered smooth layer chasing the predictor. Shares the
   * predictor's geometry object (atomic trip change, §2.2).
   */
  smoother: SmootherSim | null;
  /**
   * Bearing for trams WITHOUT geometry (field feedback #7): derived ONLY from
   * raw-position movement (≥ RAW_BEARING_MIN_MOVE_M) and held while standing.
   * NEVER the feed's instantaneous AVL bearing (noise at v≈0).
   */
  fallbackBearing: number | null;
  /**
   * Predictor batch anchors for the smoother's coarse-cadence reference
   * (§2.4): sPred is linearly interpolated across the last completed batch
   * interval [ (predT0,predS0) → (predT1,predS1) ], evaluated with one batch
   * of delay so the reference stays continuous between batches. Collapsed to
   * the current position on every reseed (jumps propagate immediately).
   */
  predS0: number;
  predT0: number;
  predS1: number;
  predT1: number;
}

/** Default daytime rule: 07:00–19:00 Prague time (shared helper in speedProfile). */
export function defaultIsDaytime(nowMs: number): boolean {
  const h = pragueHour(nowMs);
  return h >= 7 && h < 19;
}

export class TramEngine {
  private readonly entries = new Map<string, Entry>();
  /** shapeId → profile built for the current daytime flag. */
  private readonly profiles = new Map<string, SpeedProfile>();
  private daytime: boolean | null = null;
  private lastTickMs: number | null = null;
  private projectionCadence: ProjectionCadence = 'full';
  /** Wall clock the predictor fleet was last advanced to (coarse batching). */
  private lastProjTickMs: number | null = null;
  private readonly opts: TramEngineOptions;
  /** Same-shape queue groups (≥ 2 members), one set per fleet; rebuilt lazily
   *  after every ingest so tick() allocates nothing on the hot path. */
  private smootherQueueGroups: RailBody[][] = [];
  private predictorQueueGroups: RailBody[][] = [];
  private queueDirty = true;
  /** Cross-shape pairs per fleet (rebuilt on every ingest; O(1)/pair/tick). */
  private readonly smootherCrossPairs: CrossPair[] = [];
  private readonly predictorCrossPairs: CrossPair[] = [];
  /** Junction conflict pairs per fleet. */
  private readonly smootherJunctionPairs: JunctionPair[] = [];
  private readonly predictorJunctionPairs: JunctionPair[] = [];
  /**
   * key → last learned paceBias (+ when it was last refreshed). Outlives the
   * entry (STALE_AFTER_MS drops entries; the vehicle and its driver are still
   * out there). Pruned after PACE_BIAS_MEMORY_TTL_MS.
   */
  private readonly paceBiasMemory = new Map<string, { bias: number; atMs: number }>();

  constructor(opts: TramEngineOptions) {
    this.opts = opts;
  }

  private isDaytime(nowMs: number): boolean {
    return (this.opts.isDaytime ?? defaultIsDaytime)(nowMs);
  }

  /** Physical track length occupied by a tram, incl. any coupled trailer, m. */
  private tramLengthM(snapshot: TramSnapshot): number {
    const model = this.opts.resolveModel(snapshot);
    const coupled = (this.opts.isCoupled ?? defaultIsCoupled)(snapshot, model);
    return model.totalLengthM + (coupled ? COUPLED_TRAILER_OFFSET_M : 0);
  }

  private getProfile(geometry: RouteGeometry, daytime: boolean): SpeedProfile {
    const cached = this.profiles.get(geometry.shapeId);
    if (cached && cached.daytime === daytime) return cached;
    const profile = buildSpeedProfile(geometry, { daytime });
    this.profiles.set(geometry.shapeId, profile);
    return profile;
  }

  /**
   * Drop speed profiles that no live sim can reference any more (multi-hour
   * session heap growth). Ingest-only work, deliberately kept off tick().
   */
  private pruneProfiles(): void {
    if (this.profiles.size === 0) return;
    const activeShapeIds = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.predictor) activeShapeIds.add(entry.predictor.geometry.shapeId);
    }
    for (const shapeId of this.profiles.keys()) {
      if (!activeShapeIds.has(shapeId)) this.profiles.delete(shapeId);
    }
  }

  /** Rebuild all speed profiles when the daytime flag flips. */
  private refreshDaytime(nowMs: number): void {
    const daytime = this.isDaytime(nowMs);
    if (daytime === this.daytime) return;
    this.daytime = daytime;
    this.profiles.clear();
    for (const entry of this.entries.values()) {
      if (entry.predictor) {
        const profile = this.getProfile(entry.predictor.geometry, daytime);
        entry.predictor.profile = profile;
        if (entry.smoother) entry.smoother.profile = profile;
      }
    }
  }

  /** Collapse the predictor interpolation anchors onto its current position. */
  private collapsePredAnchors(entry: Entry, nowMs: number): void {
    const s = entry.predictor ? entry.predictor.sM : 0;
    entry.predS0 = s;
    entry.predS1 = s;
    entry.predT0 = nowMs;
    entry.predT1 = nowMs;
  }

  /** Smoother reference: the predictor position, batch-interpolated in coarse
   *  cadence (§2.4 — monotone, cheap, no physics). */
  private predRefAt(entry: Entry, tMs: number): number {
    if (entry.predT1 <= entry.predT0) return entry.predS1;
    const f = Math.min(1, Math.max(0, (tMs - entry.predT1) / (entry.predT1 - entry.predT0)));
    return entry.predS0 + (entry.predS1 - entry.predS0) * f;
  }

  /**
   * Ingest one poll of snapshots. Creates/updates/removes sims; trams unseen
   * for 90 s are dropped. Trip changes swap geometry for BOTH layers
   * atomically; the smoother re-anchors by projecting its old world point
   * onto the new shape (≤ 100 m offset / ≤ teleport-threshold — the v1 rule),
   * else fade-teleports to the predictor.
   */
  ingest(
    snapshots: TramSnapshot[],
    resolveGeometry: (tripId: string) => RouteGeometry | undefined,
    nowMs: number,
  ): void {
    this.refreshDaytime(nowMs);
    const daytime = this.daytime ?? this.isDaytime(nowMs);

    for (const snapshot of snapshots) {
      const key = snapshot.key;
      const geometry = resolveGeometry(snapshot.tripId);
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          key,
          snapshot,
          tripId: snapshot.tripId,
          lastSeenMs: nowMs,
          predictor: null,
          smoother: null,
          // NOT the feed's instantaneous bearing — garbage at v≈0. Stays null
          // until raw-position movement supplies a real heading (see below).
          fallbackBearing: null,
          predS0: 0,
          predT0: nowMs,
          predS1: 0,
          predT1: nowMs,
        };
        this.entries.set(key, entry);
      } else if (
        haversineM(entry.snapshot.coordinates, snapshot.coordinates) >= RAW_BEARING_MIN_MOVE_M
      ) {
        // Raw-position bearing (geometry-less rendering): adopt a direction
        // only from actual movement; while standing, hold the last one.
        entry.fallbackBearing = bearingBetween(entry.snapshot.coordinates, snapshot.coordinates);
      }
      entry.snapshot = snapshot;
      entry.lastSeenMs = nowMs;

      if (!geometry) {
        // No geometry (yet, or trip changed and the new shape isn't loaded):
        // hold the raw API position; drop sims that belong to a stale trip.
        if (entry.tripId !== snapshot.tripId) {
          entry.predictor = null;
          entry.smoother = null;
        }
        entry.tripId = snapshot.tripId;
        continue;
      }

      const profile = this.getProfile(geometry, daytime);
      const lengthM = this.tramLengthM(snapshot);
      // Same physical vehicle → same driver: new sims inherit the learned pace.
      const remembered = this.paceBiasMemory.get(key);
      const inheritedBias =
        remembered && nowMs - remembered.atMs <= PACE_BIAS_MEMORY_TTL_MS
          ? remembered.bias
          : undefined;

      let anchorsDirty = false;
      if (
        entry.predictor &&
        entry.tripId === snapshot.tripId &&
        entry.predictor.geometry.shapeId === geometry.shapeId
      ) {
        const pred = entry.predictor;
        const res = applySnapshot(pred, snapshot, nowMs);
        pred.lengthM = lengthM; // line (→ coupling) may change mid-trip
        if (!entry.smoother) entry.smoother = createSmoother(pred, nowMs);
        entry.smoother.lengthM = lengthM;
        if (res.terminalUnlatched) {
          // Terminal un-latch propagation (§2.3): a sanctioned BACKWARD
          // fade-teleport, independent of the gap-aware threshold — without
          // it the smoother wedges at the wrong terminal (the R2 class).
          fadeTeleportSmoother(entry.smoother, pred, nowMs);
        } else if (res.teleported) {
          // A teleport-classified reseed is true desync for BOTH layers: snap
          // the smoother within the same ingest (the app reads getStates on
          // the very next line — it must not render one stale frame of the
          // old position) when its own error clears the gap-aware threshold.
          const sm = entry.smoother;
          if (
            Math.abs(pred.sM - sm.sM) >
            teleportThresholdM(pred.lastFixGapS)
          ) {
            fadeTeleportSmoother(sm, pred, nowMs);
          }
        }
        if (res.freshFix) anchorsDirty = true;
      } else if (entry.predictor) {
        // Trip/shape changed: ATOMIC swap for both layers (§2.2). The old
        // predictor's live bias is the freshest memory of this vehicle.
        const oldPred = entry.predictor;
        const oldSmoother = entry.smoother;
        const pred = createSim(geometry, profile, snapshot, nowMs, lengthM, {
          initialPaceBias: oldPred.paceBias,
        });
        entry.predictor = pred;
        if (oldSmoother) {
          const oldPos = pointAt(
            oldSmoother.geometry.coordinates,
            oldSmoother.geometry.cumDistM,
            oldSmoother.sM,
          );
          const proj = projectPointToPolyline(oldPos, geometry.coordinates, geometry.cumDistM);
          if (
            proj.offsetM <= REANCHOR_MAX_OFFSET_M &&
            Math.abs(pred.sM - proj.distM) <= TELEPORT_THRESHOLD_M
          ) {
            reanchorSmoother(oldSmoother, pred, proj.distM, nowMs);
          } else {
            fadeTeleportSmoother(oldSmoother, pred, nowMs);
          }
          oldSmoother.lengthM = lengthM;
          entry.smoother = oldSmoother;
        } else {
          entry.smoother = createSmoother(pred, nowMs);
        }
        anchorsDirty = true;
      } else {
        entry.predictor = createSim(geometry, profile, snapshot, nowMs, lengthM, {
          initialPaceBias: inheritedBias,
        });
        entry.smoother = createSmoother(entry.predictor, nowMs);
        anchorsDirty = true;
      }
      entry.tripId = snapshot.tripId;
      this.paceBiasMemory.set(key, { bias: entry.predictor.paceBias, atMs: nowMs });
      if (anchorsDirty) this.collapsePredAnchors(entry, nowMs);
    }

    // Remove trams unseen for 90 s (their learned bias stays remembered);
    // prune bias memories not refreshed within the TTL.
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastSeenMs > STALE_AFTER_MS) this.entries.delete(key);
    }
    for (const [key, mem] of this.paceBiasMemory) {
      if (nowMs - mem.atMs > PACE_BIAS_MEMORY_TTL_MS) this.paceBiasMemory.delete(key);
    }
    this.pruneProfiles();

    // Membership may have changed and reseeds may have jumped sims — resolve
    // overlaps right away rather than waiting for the next tick (the app reads
    // getStates on the very next line after ingest).
    this.queueDirty = true;
    this.rebuildCrossPairs();
    this.applyQueueConstraints(nowMs);
  }

  /**
   * Switch the predictor tick cadence. Callers set 'full' while the map
   * renders the predictor every frame (positionMode==='live') and 'coarse'
   * otherwise. Idempotent; takes effect on the next tick().
   */
  setProjectionCadence(cadence: ProjectionCadence): void {
    this.projectionCadence = cadence;
  }

  /**
   * Forget the tick clock. Call on a TRUE pause/resume boundary (app
   * suspension, runtime mode change): the next tick() re-anchors at its
   * timestamp instead of integrating — or budget-dropping — the gap.
   */
  resetClock(): void {
    this.lastTickMs = null;
    this.lastProjTickMs = null;
  }

  /**
   * Reconcile a fully suspended fleet with absolute wall time in one O(n)
   * pass (v2 semantics, §2.2): the PREDICTOR re-anchors closed-form from its
   * last fix (the same segmented advance as a reseed, bounded by maxAdvanceM,
   * respecting stuck-holds / fresh at-stop pins / staleness), forward-only;
   * the SMOOTHER snaps onto the re-anchored predictor (hold point, else
   * sPred − TRAIL_M) with a fade stamp, forward-only. Both layers' clocks are
   * re-armed so the next timer tick moves normally.
   */
  resyncAfterSuspension(nowMs: number): void {
    this.refreshDaytime(nowMs);
    for (const entry of this.entries.values()) {
      const pred = entry.predictor;
      if (!pred) continue;
      resyncPredictor(pred, nowMs);
      this.collapsePredAnchors(entry, nowMs);
      const sm = entry.smoother;
      if (sm && sm.phase !== 'terminal') {
        const hold = holdPointOf(pred);
        const target = hold ?? Math.max(0, pred.sM - TRAIL_M);
        if (target > sm.sM + 1e-6) fadeTeleportSmoother(sm, pred, nowMs);
      }
    }

    // A seek can change queue ordering/clearance. Resolve constraints once,
    // then arm clocks at the same wall timestamp so the next timer tick moves
    // normally instead of becoming a no-op anchor frame.
    this.queueDirty = true;
    this.rebuildCrossPairs();
    this.applyQueueConstraints(nowMs);
    this.lastTickMs = nowMs;
    this.lastProjTickMs = nowMs;
  }

  /**
   * Advance all sims to nowMs. The elapsed interval since the previous tick is
   * integrated in substeps of ≤ MAX_ENGINE_DT_S. Every substep advances the
   * WHOLE smoother fleet and then applies its constraints (car-following on a
   * coarse tick cadence stays equivalent to fine cadences). The predictor
   * fleet advances every substep in 'full' cadence and in ≤ 1.5 s batches
   * every PROJ_COARSE_INTERVAL_MS in 'coarse' — its constraints run only on
   * the substeps that advanced it (performance invariant: never re-sort an
   * unchanged second fleet at 30 Hz). Elapsed time beyond MAX_TICK_CATCHUP_MS
   * is dropped (true pause/resume calls resetClock()).
   */
  tick(nowMs: number): void {
    this.refreshDaytime(nowMs);
    const prevMs = this.lastTickMs;
    this.lastTickMs = nowMs;
    if (prevMs === null || nowMs <= prevMs) return; // anchor tick / clock skew

    const fromMs = Math.max(prevMs, nowMs - MAX_TICK_CATCHUP_MS);
    const full = this.projectionCadence === 'full';
    if (this.lastProjTickMs === null) this.lastProjTickMs = fromMs;

    let t = fromMs;
    while (t < nowMs) {
      const stepMs = Math.min(MAX_ENGINE_DT_S * 1000, nowMs - t);
      t += stepMs;
      const dtS = stepMs / 1000;

      const projDue = full || t - this.lastProjTickMs >= PROJ_COARSE_INTERVAL_MS;
      let projFromMs = 0;
      if (projDue) {
        projFromMs = Math.max(this.lastProjTickMs, t - PROJ_COARSE_MAX_GAP_S * 1000);
        this.lastProjTickMs = t;
      }

      for (const entry of this.entries.values()) {
        const pred = entry.predictor;
        if (!pred) continue;
        if (projDue) {
          // Batch spans [projFromMs, t] in ≤ MAX_ENGINE_DT_S sub-substeps, so
          // no time is dropped across coarse intervals or a cadence switch.
          let pt = projFromMs;
          while (pt < t) {
            const pStepMs = Math.min(MAX_ENGINE_DT_S * 1000, t - pt);
            pt += pStepMs;
            tickSim(pred, pt, pStepMs / 1000);
          }
          entry.predS0 = entry.predS1;
          entry.predT0 = entry.predT1;
          entry.predS1 = pred.sM;
          entry.predT1 = t;
        }
        const sm = entry.smoother;
        if (sm) {
          const ref = full ? pred.sM : this.predRefAt(entry, t);
          tickSmoother(sm, pred, ref, t, dtS);
        }
      }
      // Constraints run AFTER each substep's position updates so queues
      // compress correctly regardless of iteration order and tick cadence.
      this.applyQueueConstraints(t, projDue);
    }
  }

  /** Rebuild shapeId → bodies queue groups (only groups of ≥ 2 members). */
  private rebuildQueueGroups(): void {
    this.queueDirty = false;
    this.collectQueueGroups('smoother', this.smootherQueueGroups);
    this.collectQueueGroups('predictor', this.predictorQueueGroups);
  }

  private collectQueueGroups(kind: 'predictor' | 'smoother', out: RailBody[][]): void {
    const byShape = new Map<string, RailBody[]>();
    for (const entry of this.entries.values()) {
      const body = entry[kind];
      if (!body) continue;
      const shapeId = body.geometry.shapeId;
      const group = byShape.get(shapeId);
      if (group) group.push(body);
      else byShape.set(shapeId, [body]);
    }
    out.length = 0;
    for (const group of byShape.values()) {
      if (group.length > 1) out.push(group);
    }
  }

  /**
   * Discover cross-shape and junction pairs for BOTH fleets (ingest-time only
   * — the tick path stays allocation-light). Grid-bucketed by world position;
   * each fleet is discovered from its OWN positions (§2.3).
   */
  private rebuildCrossPairs(): void {
    // A body whose pair vanishes in this rebuild must not keep braking toward
    // a stale hold point — clear every hold the OLD pair set could have set.
    clearJunctionHolds(this.smootherJunctionPairs);
    clearJunctionHolds(this.predictorJunctionPairs);
    this.smootherCrossPairs.length = 0;
    this.predictorCrossPairs.length = 0;
    this.smootherJunctionPairs.length = 0;
    this.predictorJunctionPairs.length = 0;

    const smBodies: RailBody[] = [];
    const predBodies: RailBody[] = [];
    for (const entry of this.entries.values()) {
      if (entry.smoother) smBodies.push(entry.smoother);
      if (entry.predictor) predBodies.push(entry.predictor);
    }
    this.discoverPairs(smBodies, this.smootherCrossPairs, this.smootherJunctionPairs);
    this.discoverPairs(predBodies, this.predictorCrossPairs, this.predictorJunctionPairs);
  }

  private discoverPairs(
    bodies: RailBody[],
    crossOut: CrossPair[],
    junctionOut: JunctionPair[],
  ): void {
    const n = bodies.length;
    if (n < 2) return;

    // Local-meter positions + grid buckets.
    const M_PER_DEG = 111_320;
    const cosLat = Math.cos((bodies[0].geometry.coordinates[0]?.[1] ?? 50) * (Math.PI / 180));
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const cells = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const g = bodies[i].geometry;
      const p = pointAt(g.coordinates, g.cumDistM, bodies[i].sM);
      xs[i] = p[0] * cosLat * M_PER_DEG;
      ys[i] = p[1] * M_PER_DEG;
      const key =
        Math.round(xs[i] / CROSS_GRID_CELL_M) * 1_048_576 + Math.round(ys[i] / CROSS_GRID_CELL_M);
      const cell = cells.get(key);
      if (cell) cell.push(i);
      else cells.set(key, [i]);
    }

    const r2 = CROSS_CANDIDATE_RADIUS_M * CROSS_CANDIDATE_RADIUS_M;
    for (const [key, cell] of cells) {
      for (let a = 0; a < cell.length; a++) {
        for (let b = a + 1; b < cell.length; b++) {
          this.tryCrossPair(bodies, xs, ys, r2, cell[a], cell[b], crossOut, junctionOut);
        }
        for (const dKey of CROSS_NEIGHBOR_OFFSETS) {
          const other = cells.get(key + dKey);
          if (!other) continue;
          for (const j of other) {
            this.tryCrossPair(bodies, xs, ys, r2, cell[a], j, crossOut, junctionOut);
          }
        }
      }
    }
  }

  /** Examine one candidate pair; push CrossPair/JunctionPair when it qualifies. */
  private tryCrossPair(
    bodies: RailBody[],
    xs: Float64Array,
    ys: Float64Array,
    r2: number,
    i: number,
    j: number,
    crossOut: CrossPair[],
    junctionOut: JunctionPair[],
  ): void {
    const a = bodies[i];
    const b = bodies[j];
    if (a.geometry.shapeId === b.geometry.shapeId) return; // same-shape queue owns it
    const dx = xs[i] - xs[j];
    const dy = ys[i] - ys[j];
    if (dx * dx + dy * dy > r2) return;
    // Same direction of travel? (opposite tracks/directions must never couple)
    const bearA = bearingAt(a.geometry.coordinates, a.geometry.cumDistM, a.sM);
    const bearB = bearingAt(b.geometry.coordinates, b.geometry.cumDistM, b.sM);
    let dBear = Math.abs(bearA - bearB) % 360;
    if (dBear > 180) dBear = 360 - dBear;
    if (dBear > CROSS_BEARING_MAX_DEG) {
      // Not travelling the same way — but their paths may CROSS at a nearby
      // junction (side-impact class). Anti-parallel pairs (> 155°) are the
      // opposite-direction shared street and never couple in any mechanism.
      if (dBear <= JUNCTION_MAX_ANGLE_DEG) {
        if (!this.findJunctionConflict(bodies, i, j, junctionOut)) {
          this.findJunctionConflict(bodies, j, i, junctionOut);
        }
      }
      return;
    }

    // Shared physical track? Project A onto B's shape (and vice versa when A
    // is the follower) — the along-shape offset then maps s between shapes.
    const posA = pointAt(a.geometry.coordinates, a.geometry.cumDistM, a.sM);
    const projAonB = projectPointToPolyline(posA, b.geometry.coordinates, b.geometry.cumDistM);
    if (projAonB.offsetM <= CROSS_LATERAL_MAX_M && projAonB.distM > b.sM) {
      crossOut.push({ leader: a, follower: b, offsetM: projAonB.distM - a.sM, leaderSAtBuild: a.sM });
      return;
    }
    const posB = pointAt(b.geometry.coordinates, b.geometry.cumDistM, b.sM);
    const projBonA = projectPointToPolyline(posB, a.geometry.coordinates, a.geometry.cumDistM);
    if (projBonA.offsetM <= CROSS_LATERAL_MAX_M && projBonA.distM > a.sM) {
      crossOut.push({ leader: b, follower: a, offsetM: projBonA.distM - b.sM, leaderSAtBuild: b.sM });
    }
  }

  /**
   * Junction conflict discovery: walk body A's own shape forward — from just
   * behind its tail to JUNCTION_LOOKAHEAD_M ahead — and find the first sample
   * that lands on body B's shape at a genuine crossing angle. Returns true
   * when a pair was pushed.
   */
  private findJunctionConflict(
    bodies: RailBody[],
    ia: number,
    ib: number,
    out: JunctionPair[],
  ): boolean {
    const a = bodies[ia];
    const b = bodies[ib];
    const ga = a.geometry;
    const gb = b.geometry;
    const from = Math.max(0, a.sM - a.lengthM);
    const to = Math.min(ga.totalM, a.sM + JUNCTION_LOOKAHEAD_M);
    for (let s = from; s <= to; s += JUNCTION_SAMPLE_STEP_M) {
      const p = pointAt(ga.coordinates, ga.cumDistM, s);
      const proj = projectPointToPolyline(p, gb.coordinates, gb.cumDistM);
      if (proj.offsetM > JUNCTION_LATERAL_M) continue;
      const sConfB = proj.distM;
      // B already dragged its tail past this crossing, or is too far away to
      // conflict before the next ingest re-discovers with fresh positions.
      if (b.sM - b.lengthM > sConfB + JUNCTION_CLEAR_M) continue;
      if (sConfB - b.sM > JUNCTION_LOOKAHEAD_M) continue;
      // Genuine crossing angle AT the conflict point.
      const bearA = bearingAt(ga.coordinates, ga.cumDistM, s);
      const bearB = bearingAt(gb.coordinates, gb.cumDistM, sConfB);
      let ang = Math.abs(bearA - bearB) % 360;
      if (ang > 180) ang = 360 - ang;
      if (ang < JUNCTION_MIN_ANGLE_DEG || ang > JUNCTION_MAX_ANGLE_DEG) continue;
      out.push({ a, b, sConfA: s, sConfB });
      return true;
    }
    return false;
  }

  /**
   * Junction conflict yield: for each crossing-shape pair still short of the
   * conflict, the body closer to (or already inside) the conflict zone
   * proceeds and the other YIELDS. Strictly speed-only. Holds are re-derived
   * from scratch on every pass, so a cleared conflict releases within one
   * tick. O(pairs), zero allocation (invariant #8).
   */
  private applyJunctionPairs(pairs: JunctionPair[]): void {
    clearJunctionHolds(pairs);
    for (const p of pairs) {
      const { a, b } = p;
      const clearedA = a.sM - a.lengthM > p.sConfA + JUNCTION_CLEAR_M;
      const clearedB = b.sM - b.lengthM > p.sConfB + JUNCTION_CLEAR_M;
      // Switch/junction slow-down: while a body is still around the contested
      // crossing, it passes at SWITCH_SLOW_V_MS — envelope-smooth approach.
      if (!clearedA) capSwitchSpeed(a, p.sConfA);
      if (!clearedB) capSwitchSpeed(b, p.sConfB);
      if (clearedA || clearedB) continue;
      const dA = p.sConfA - a.sM;
      const dB = p.sConfB - b.sM;
      const insideA = dA < JUNCTION_ZONE_M;
      const insideB = dB < JUNCTION_ZONE_M;
      // Both already inside the zone: braking either would freeze an overlap
      // in place — let them roll apart (speed-only mechanism, no teleports).
      if (insideA && insideB) continue;
      let yielder: RailBody;
      let other: RailBody;
      let holdM: number;
      if (insideA || (!insideB && (dA < dB || (dA === dB && a.key < b.key)))) {
        yielder = b;
        other = a;
        holdM = p.sConfB - JUNCTION_ZONE_M;
      } else {
        yielder = a;
        other = b;
        holdM = p.sConfA - JUNCTION_ZONE_M;
      }
      // A priority body standing OUTSIDE the zone (dwelling at a platform,
      // stuck at a light) blocks nobody — the yielder crosses first.
      if (!insideA && !insideB && other.vMs < JUNCTION_STANDSTILL_V_MS) continue;
      if (yielder.yieldHoldM === null || holdM < yielder.yieldHoldM) {
        yielder.yieldHoldM = holdM;
      }
      const vCap = brakeTowards(holdM - yielder.sM);
      if (yielder.vMs > vCap) yielder.vMs = vCap;
    }
  }

  /**
   * Car-following/queueing per fleet: within one shapeId a follower's nose may
   * never come closer than QUEUE_GAP_M to its leader's tail. Iterates each
   * queue leader → follower so a dwelling/teleported leader compresses the
   * whole queue in one pass.
   */
  private applyQueueConstraints(nowMs: number, includePredictor = true): void {
    if (this.queueDirty) this.rebuildQueueGroups();
    this.applyGroupConstraints(this.smootherQueueGroups, nowMs);
    this.applyCrossPairs(this.smootherCrossPairs);
    this.applyJunctionPairs(this.smootherJunctionPairs);
    if (includePredictor) {
      this.applyGroupConstraints(this.predictorQueueGroups, nowMs);
      this.applyCrossPairs(this.predictorCrossPairs);
      this.applyJunctionPairs(this.predictorJunctionPairs);
    }
  }

  private applyGroupConstraints(groups: RailBody[][], nowMs: number): void {
    for (const group of groups) {
      group.sort(compareBySimDist);
      for (let i = group.length - 2; i >= 0; i--) {
        const leader = group[i + 1];
        const follower = group[i];
        const limit = leader.sM - leader.lengthM - QUEUE_GAP_M;
        const gap = limit - follower.sM;
        if (gap <= 0) {
          // Same-shape queue: the follower shares the leader's geometry, so
          // clamping its sM to the limit is ALWAYS a valid on-rail position
          // (unlike cross-shape pairs). A noticeable backward clamp renders
          // as a teleport fade, not a reverse slide.
          const clamped = Math.max(0, limit);
          if (follower.sM - clamped > QUEUE_BACK_FADE_M) follower.lastTeleportMs = nowMs;
          follower.sM = clamped;
          follower.vMs = Math.min(follower.vMs, leader.vMs);
        } else {
          const vCap = leader.vMs + brakeTowards(gap);
          if (follower.vMs > vCap) follower.vMs = vCap;
        }
      }
    }
  }

  /**
   * Cross-shape car-following: keep a follower on ANOTHER shape from driving
   * into a leader sharing the same physical rail — by BRAKING ONLY. It never
   * rewrites follower.sM (build-20 regression fix: the offset mapping is only
   * valid where the rails coincide; a position clamp teleported followers
   * off-route). O(1) per pair, zero allocation.
   */
  private applyCrossPairs(pairs: CrossPair[]): void {
    for (const p of pairs) {
      if (p.leader.sM - p.leaderSAtBuild > CROSS_PAIR_STALE_ADVANCE_M) continue;
      const limit = p.leader.sM + p.offsetM - p.leader.lengthM - QUEUE_GAP_M;
      const gap = limit - p.follower.sM;
      if (gap <= 0) {
        // Brake to the leader's speed — NEVER clamp sM across shapes.
        if (p.follower.vMs > p.leader.vMs) p.follower.vMs = p.leader.vMs;
      } else {
        const vCap = p.leader.vMs + brakeTowards(gap);
        if (p.follower.vMs > vCap) p.follower.vMs = vCap;
      }
    }
  }

  /** Public state for every tracked tram (UI lists, feature builder input). */
  getStates(nowMs: number = this.lastTickMs ?? Date.now()): TramPublicState[] {
    const out: TramPublicState[] = [];
    for (const entry of this.entries.values()) out.push(this.toPublicState(entry, nowMs));
    return out;
  }

  /**
   * Public states whose current render anchors intersect a bbox. Close-zoom
   * map frames use this before feature building so hundreds of off-screen
   * vehicles do not allocate full public-state objects 15–30 times/second.
   * `anchor` selects the culling anchor per render mode ('smooth' | 'live' |
   * 'raw' | 'ml'); the boolean form of the old `useProjection` argument is
   * still accepted (true = 'live') until the raw-mode plumbing lands
   * everywhere. 'ml' additionally needs `mlDistM` — the lab's published
   * distance for the vehicle — and culls at the fix when it returns null,
   * matching what the feature builder then renders.
   */
  getStatesInBounds(
    nowMs: number,
    bbox: [number, number, number, number],
    preserveKeyA: string | null = null,
    preserveKeyB: string | null = null,
    anchor: PositionAnchor | boolean = 'smooth',
    mlDistM: MlDistResolver | null = null,
  ): TramPublicState[] {
    const mode: PositionAnchor = anchor === true ? 'live' : anchor === false ? 'smooth' : anchor;
    const out: TramPublicState[] = [];
    for (const entry of this.entries.values()) {
      let include = entry.key === preserveKeyA || entry.key === preserveKeyB;
      if (!include) {
        if (mode === 'raw') {
          // Raw mode renders the fix — cull by the raw AVL coordinate.
          include = coordinateIsInBbox(entry.snapshot.coordinates, bbox);
        } else if (mode === 'ml') {
          // The lab's horizon runs ~120 s past the fix — hundreds of meters,
          // more than any caller's cull margin — so culling an ml frame by the
          // fix would drop trams that ARE on screen. Cull at the rendered ml
          // distance on the shared geometry; with no trajectory (or no
          // geometry) ml renders the fix, so cull there instead.
          const body: RailBody | null = entry.predictor ?? entry.smoother;
          const mlDist = mlDistM ? mlDistM(entry.key, entry.snapshot.tripId, nowMs) : null;
          include =
            body && mlDist !== null
              ? pointAtIsInBbox(body.geometry.coordinates, body.geometry.cumDistM, mlDist, bbox)
              : coordinateIsInBbox(entry.snapshot.coordinates, bbox);
        } else {
          const body: RailBody | null =
            mode === 'live'
              ? (entry.predictor ?? entry.smoother)
              : (entry.smoother ?? entry.predictor);
          include = body
            ? pointAtIsInBbox(body.geometry.coordinates, body.geometry.cumDistM, body.sM, bbox)
            : coordinateIsInBbox(entry.snapshot.coordinates, bbox);
        }
      }
      if (include) out.push(this.toPublicState(entry, nowMs));
    }
    return out;
  }

  /** Explicit-timestamp alias of getStates (render-side callers). */
  getStatesAt(nowMs: number): TramPublicState[] {
    return this.getStates(nowMs);
  }

  /** Public state for one tram, or undefined if unknown. */
  getState(key: string, nowMs: number = this.lastTickMs ?? Date.now()): TramPublicState | undefined {
    const entry = this.entries.get(key);
    return entry ? this.toPublicState(entry, nowMs) : undefined;
  }

  /** THE shared geometry both layers run on (featureBuilder callback) —
   *  undefined when the tram has no geometry sims (bare-dot path). */
  getGeometry(key: string): RouteGeometry | undefined {
    return this.entries.get(key)?.predictor?.geometry;
  }

  /**
   * Additive, ON-DEMAND debug view of one tram's INTERNAL sim state for the
   * debug overlay (10 Hz while mounted; deliberately exempt from the ≤1 Hz
   * perf invariant). Pure read — nothing here influences the simulation.
   */
  getDebugInfo(
    key: string,
    nowMs: number = this.lastTickMs ?? Date.now(),
  ): SimDebugInfo | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const { snapshot } = entry;
    const pred = entry.predictor;
    const sm = entry.smoother;
    if (!pred || !sm) {
      return {
        hasSim: false,
        phase: 'unknown',
        simDistM: snapshot.shapeDistM,
        simSpeedKmh: 0,
        targetDistM: null,
        errPredM: null,
        regime: null,
        paceBias: null,
        vAllowedKmh: null,
        cruiseCapKmh: null,
        stuckAtM: null,
        yieldHoldM: null,
        fixStopDistM: null,
        fixPinActive: false,
        dwellUntilMs: 0,
        obsDistM: snapshot.shapeDistM,
        obsAtMs: snapshot.observedAtMs,
        fixAgeMs: Math.max(0, nowMs - snapshot.observedAtMs),
        lastTeleportMs: 0,
        projDistM: null,
        simSpeedMs: 0,
        cruiseTargetKmh: null,
        zoneCapKmh: null,
        curveCapKmh: null,
        curveKappa: null,
        curveRadiusM: null,
        todPaceFactor: null,
        staleFixAgeMs: Math.max(0, nowMs - snapshot.observedAtMs) + FEED_LATENCY_S * 1000,
        minStopDistM: null,
        skipRollUntilM: 0,
        lengthM: null,
        delaySeconds: snapshot.delaySeconds,
        statePosition: snapshot.statePosition,
      };
    }
    const hold = holdPointOf(pred);
    const trailM = hold === null ? TRAIL_M : 0;
    const target = pred.sM - trailM;
    const ageMs = Math.max(0, nowMs - pred.obsAtMs);
    const cruiseCapMs = cruiseCapAt(sm.profile, sm.geometry, sm.sM);
    const coord = pointAt(sm.geometry.coordinates, sm.geometry.cumDistM, sm.sM);
    const kappa = curvatureAtS(sm.geometry, sm.sM);
    const tod = todPaceFactor(nowMs);
    return {
      hasSim: true,
      phase: sm.phase,
      simDistM: sm.sM,
      simSpeedKmh: sm.vMs * 3.6,
      targetDistM: target,
      errPredM: target - sm.sM,
      regime: sm.regime,
      paceBias: pred.paceBias,
      vAllowedKmh:
        vAllowedAt(
          sm.profile,
          sm.geometry,
          sm.sM,
          minStopDistOf(sm),
          DEFAULT_LOOKAHEAD_M,
          A_BRK,
          sm.nextStopIdx,
        ) * 3.6,
      cruiseCapKmh: cruiseCapMs * 3.6,
      stuckAtM: pred.stuckAtM,
      yieldHoldM: sm.yieldHoldM,
      fixStopDistM: pred.fixStopDistM,
      fixPinActive: fixPinActive(pred, nowMs),
      dwellUntilMs: sm.phase === 'dwell' ? sm.dwellUntilMs : 0,
      obsDistM: pred.obsDistM,
      obsAtMs: pred.obsAtMs,
      fixAgeMs: ageMs,
      lastTeleportMs: Math.max(sm.lastTeleportMs, pred.lastTeleportMs),
      projDistM: pred.sM,
      simSpeedMs: sm.vMs,
      cruiseTargetKmh: cruiseProduct(pred, nowMs) * 3.6,
      zoneCapKmh: zoneCapAt(coord, sm.profile.daytime) * 3.6,
      curveCapKmh: curveCap(kappa) * 3.6,
      curveKappa: kappa,
      curveRadiusM: kappa > 1e-6 ? 1 / kappa : null,
      todPaceFactor: tod,
      staleFixAgeMs: ageMs + FEED_LATENCY_S * 1000,
      minStopDistM: minStopDistOf(sm),
      skipRollUntilM: sm.skipRollUntilM,
      lengthM: sm.lengthM,
      delaySeconds: pred.snapshot.delaySeconds,
      statePosition: pred.snapshot.statePosition,
    };
  }

  /** Predictor ETA to an along-shape distance: remaining dwell + learned-pace
   *  travel + fixed dwells at intermediate un-served stops. Reality's clock
   *  for the animation's stop (§2.5). */
  private predictorEtaS(pred: TramSim, distM: number, nowMs: number): number {
    if (pred.sM >= distM - STOP_REACH_M) return 0;
    let etaS = 0;
    if (pred.phase === 'dwell') etaS += Math.max(0, pred.dwellUntilMs - nowMs) / 1000;
    const pace = Math.max(0.5, cruiseProduct(pred, nowMs));
    etaS += (distM - pred.sM) / pace;
    const stops = pred.geometry.stops;
    for (let i = pred.nextStopIdx; i < stops.length; i++) {
      const st = stops[i];
      if (st.distM >= distM - STOP_REACH_M) break;
      etaS += dwellDurationMs(st, nowMs) / 1000;
    }
    return etaS;
  }

  private toPublicState(entry: Entry, nowMs: number): TramPublicState {
    const { snapshot } = entry;
    const model = this.opts.resolveModel(snapshot);
    const pred = entry.predictor;
    const sm = entry.smoother;

    if (!pred || !sm) {
      // No geometry: hold the raw API position (featureBuilder renders it as
      // an un-oriented dot — NO 3D body, NO perpendicular track offset).
      // Bearing is the movement-derived fallback, or 0 while it is still null.
      // NEVER the feed's instantaneous bearing (garbage at v≈0, #7).
      return {
        key: entry.key,
        snapshot,
        model,
        simDistM: snapshot.shapeDistM,
        simSpeedKmh: 0,
        position: [snapshot.coordinates[0], snapshot.coordinates[1]],
        bearing: entry.fallbackBearing ?? 0,
        phase: 'unknown',
        observedPosition: [snapshot.coordinates[0], snapshot.coordinates[1]],
        observedBearing: entry.fallbackBearing ?? 0,
        deviationM: null,
        projectedObservedDistM: null,
        nextStopName: null,
        nextStopEtaS:
          snapshot.nextStopArrivalMs !== null
            ? Math.max(0, (snapshot.nextStopArrivalMs - nowMs) / 1000)
            : null,
        hasGeometry: false,
      };
    }

    const geometry = sm.geometry;
    // Honest last AVL fix, placed on the shape (NOT projected forward in time).
    const observedDistM = Math.min(Math.max(snapshot.shapeDistM, 0), geometry.totalM);
    // One stop identity for the whole sheet: the SMOOTHER's next un-served
    // stop names the stop; the PREDICTOR supplies reality's ETA to it (§2.5).
    const next = sm.nextStopIdx < geometry.stops.length ? geometry.stops[sm.nextStopIdx] : null;
    return {
      key: entry.key,
      snapshot,
      model,
      simDistM: sm.sM,
      simSpeedKmh: sm.vMs * 3.6,
      position: pointAt(geometry.coordinates, geometry.cumDistM, sm.sM),
      bearing: bearingAt(geometry.coordinates, geometry.cumDistM, sm.sM),
      phase: sm.phase,
      observedPosition: pointAt(geometry.coordinates, geometry.cumDistM, observedDistM),
      observedBearing: bearingAt(geometry.coordinates, geometry.cumDistM, observedDistM),
      deviationM: Math.abs(sm.sM - observedDistM),
      projectedObservedDistM: pred.sM,
      nextStopName: next ? next.name : null,
      nextStopEtaS: next ? this.predictorEtaS(pred, next.distM, nowMs) : null,
      hasGeometry: true,
      paceBias: pred.paceBias,
    };
  }
}
