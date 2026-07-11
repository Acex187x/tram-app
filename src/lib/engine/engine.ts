// TramEngine: owns all per-tram sims. Pure TS, deterministic, no timers —
// the caller drives ingest() on each poll and tick() at frame rate.
// Depends only on '@/lib/types' + sibling engine/geo modules; the fleet model
// resolver is injected so the engine stays free of fleet/golemio imports.

import type {
  RouteGeometry,
  TramModelSpec,
  TramPublicState,
  TramSnapshot,
} from '@/lib/types';
import { bearingAt, pointAt, projectPointToPolyline } from '../geo/polyline';
import { A_BRK, buildSpeedProfile, pragueHour, type SpeedProfile } from './speedProfile';
import {
  applySnapshot,
  createSim,
  nextUndwelledStop,
  observedDistAt,
  reanchorSim,
  targetDistAt,
  tick as tickSim,
  TELEPORT_THRESHOLD_M,
  type TramSim,
} from './tramSim';

/** Trams unseen for this long are dropped. */
export const STALE_AFTER_MS = 90_000;
/**
 * Per-key learned paceBias is remembered this long after the vehicle was last
 * seen, so a tram that drops out (feed gap > STALE_AFTER_MS) or changes trip
 * re-seeds its sims from its own learned pace instead of the fleet prior —
 * drivers don't change at teleports/trip swaps (calibration round 1 R1).
 * Bounded so a vehicle returning after a long layover (plausible driver/duty
 * change) starts from the prior again; the 150 s EWMA half-life re-learns any
 * residual quickly either way.
 */
export const PACE_BIAS_MEMORY_TTL_MS = 15 * 60_000;
/** Max offset when re-projecting a tram onto a new trip's geometry, meters. */
const REANCHOR_MAX_OFFSET_M = 100;
/** Max dt for one engine tick, seconds (larger gaps are clamped). */
const MAX_ENGINE_DT_S = 0.25;
/** In 'coarse' projection cadence the projSims advance at most this often. */
export const PROJ_COARSE_INTERVAL_MS = 500;
/** Max wall-clock gap integrated in one coarse projection advance, seconds. */
const PROJ_COARSE_MAX_GAP_S = 1.5;

/**
 * Projection-sim tick cadence: 'full' advances the dead-reckoning projSims on
 * every engine tick (needed while positionMode==='live' renders them at frame
 * rate); 'coarse' advances them at most every PROJ_COARSE_INTERVAL_MS — in
 * 'smooth' mode the projection is only consumed at ~1 Hz (deviation display),
 * so ticking a second physics sim per tram at 60 Hz was pure thermal waste.
 */
export type ProjectionCadence = 'full' | 'coarse';
/** Min clearance between a follower's nose and its leader's tail, meters. */
export const QUEUE_GAP_M = 3;
/**
 * Second unit of a coupled two-car set trails this far behind the first, m.
 * Mirrors render/featureBuilder's COUPLED_OFFSET_M (engine must not import
 * render modules) — a coupled set occupies totalLengthM + this along the track.
 */
export const COUPLED_TRAILER_OFFSET_M = 14.5;

export interface TramEngineOptions {
  /** Maps a snapshot to its fleet model spec (injected — keeps engine pure). */
  resolveModel: (snapshot: TramSnapshot) => TramModelSpec;
  /** Override daytime detection (07:00–19:00 Prague time by default). */
  isDaytime?: (nowMs: number) => boolean;
  /**
   * Whether this tram runs as a coupled two-car set (adds trailer length to
   * queue spacing). Default mirrors fleet/registry's isLikelyCoupledPair:
   * runsCoupled models on numeric day lines 1–26, excluding line 23.
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
function compareBySimDist(a: TramSim, b: TramSim): number {
  if (a.sM !== b.sM) return a.sM - b.sM;
  return a.snapshot.key < b.snapshot.key ? -1 : a.snapshot.key > b.snapshot.key ? 1 : 0;
}

interface Entry {
  key: string;
  snapshot: TramSnapshot;
  tripId: string;
  lastSeenMs: number;
  sim: TramSim | null;
  /**
   * Live-mode dead-reckoning sim: re-seeded AT the raw fix whenever a NEW
   * observation arrives (jumping to it — accepted live-mode UX), then advanced
   * between polls by the same physics as the main sim (speed profile, dwells,
   * pace capped by the schedule-projected observation). Its sM feeds
   * TramPublicState.projectedObservedDistM.
   */
  projSim: TramSim | null;
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
  /** Wall clock the projSims were last advanced to (coarse-cadence bookkeeping). */
  private lastProjTickMs: number | null = null;
  private readonly opts: TramEngineOptions;
  /**
   * Sims sharing a shapeId (only groups of ≥ 2 — singletons need no queue),
   * rebuilt lazily after every ingest (sims are created/replaced/dropped only
   * there). Persisted so tick() allocates nothing on the hot path.
   */
  private queueGroups: TramSim[][] = [];
  private queueDirty = true;
  /**
   * key → last learned paceBias (+ when it was last refreshed). Outlives the
   * entry itself (STALE_AFTER_MS drops entries after 90 s without a fix, but
   * the vehicle and its driver are still out there) so respawned/trip-swapped
   * sims inherit the learned pace. Pruned after PACE_BIAS_MEMORY_TTL_MS.
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

  /** Rebuild all speed profiles when the daytime flag flips. */
  private refreshDaytime(nowMs: number): void {
    const daytime = this.isDaytime(nowMs);
    if (daytime === this.daytime) return;
    this.daytime = daytime;
    this.profiles.clear();
    for (const entry of this.entries.values()) {
      if (entry.sim) entry.sim.profile = this.getProfile(entry.sim.geometry, daytime);
      if (entry.projSim) entry.projSim.profile = this.getProfile(entry.projSim.geometry, daytime);
    }
  }

  /**
   * Ingest one poll of snapshots. Creates/updates/removes sims; trams unseen
   * for 90 s are dropped. When a tram's tripId changes, the new geometry is
   * adopted while keeping a smooth position via re-projection of the current
   * world position onto the new shape.
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
          sim: null,
          projSim: null,
        };
        this.entries.set(key, entry);
      }
      entry.snapshot = snapshot;
      entry.lastSeenMs = nowMs;

      if (!geometry) {
        // No geometry (yet, or trip changed and the new shape isn't loaded):
        // hold the raw API position; drop sims that belong to a stale trip.
        if (entry.tripId !== snapshot.tripId) {
          entry.sim = null;
          entry.projSim = null;
        }
        entry.tripId = snapshot.tripId;
        continue;
      }

      const profile = this.getProfile(geometry, daytime);
      const lengthM = this.tramLengthM(snapshot);
      // Same physical vehicle → same driver: new sims (trip change, respawn
      // after a feed gap) inherit the learned pace instead of the fleet prior.
      const remembered = this.paceBiasMemory.get(key);
      const inheritedBias =
        remembered && nowMs - remembered.atMs <= PACE_BIAS_MEMORY_TTL_MS
          ? remembered.bias
          : undefined;

      if (entry.sim && entry.tripId === snapshot.tripId) {
        applySnapshot(entry.sim, snapshot, nowMs);
        entry.sim.lengthM = lengthM; // line (→ coupling) may change mid-trip
      } else if (entry.sim) {
        // Trip changed: swap geometry, keeping a smooth position when the old
        // world position lies close to the new shape and near the schedule.
        // The old sim's live bias is the freshest memory of this vehicle.
        const oldSim = entry.sim;
        const oldPos = pointAt(oldSim.geometry.coordinates, oldSim.geometry.cumDistM, oldSim.sM);
        const newSim = createSim(geometry, profile, snapshot, nowMs, lengthM, {
          adaptiveDwell: true,
          initialPaceBias: oldSim.paceBias,
        });
        const proj = projectPointToPolyline(oldPos, geometry.coordinates, geometry.cumDistM);
        const sTarget = targetDistAt(newSim, nowMs);
        if (
          proj.offsetM <= REANCHOR_MAX_OFFSET_M &&
          Math.abs(sTarget - proj.distM) <= TELEPORT_THRESHOLD_M
        ) {
          reanchorSim(newSim, proj.distM, nowMs);
          // Keep the old momentum only when the reanchor left the sim cruising
          // (it may have seeded a dwell/terminal at a nearby stop).
          if (newSim.phase === 'cruise') newSim.vMs = oldSim.vMs;
        }
        entry.sim = newSim;
      } else {
        // Main smooth-mode sims correct tracking error at stops (adaptive
        // dwell); projection sims below never do — they mirror reality.
        entry.sim = createSim(geometry, profile, snapshot, nowMs, lengthM, {
          adaptiveDwell: true,
          initialPaceBias: inheritedBias,
        });
      }
      entry.tripId = snapshot.tripId;
      this.paceBiasMemory.set(key, { bias: entry.sim.paceBias, atMs: nowMs });

      // Dead-reckoning sim for the projected observation: re-seed ONLY when a
      // genuinely new fix (or trip/geometry) arrives — that's the accepted
      // live-mode jump. Between identical polls it keeps integrating smoothly.
      // NO adaptiveDwell here: the projection dead-reckons the raw fix and
      // must keep fixed, reality-mirroring dwells.
      const proj = entry.projSim;
      if (
        !proj ||
        proj.geometry.shapeId !== geometry.shapeId ||
        proj.snapshot.tripId !== snapshot.tripId ||
        proj.obsAtMs !== snapshot.observedAtMs ||
        proj.snapshot.shapeDistM !== snapshot.shapeDistM
      ) {
        // Dead-reckons at the vehicle's LEARNED pace (main sim's live bias) —
        // the projSim never receives applySnapshot, so it cannot learn itself.
        entry.projSim = createSim(geometry, profile, snapshot, nowMs, lengthM, {
          initialPaceBias: entry.sim.paceBias,
        });
      }
    }

    // Remove trams unseen for 90 s (their learned bias stays remembered);
    // prune bias memories not refreshed within the TTL.
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastSeenMs > STALE_AFTER_MS) this.entries.delete(key);
    }
    for (const [key, mem] of this.paceBiasMemory) {
      if (nowMs - mem.atMs > PACE_BIAS_MEMORY_TTL_MS) this.paceBiasMemory.delete(key);
    }

    // Membership may have changed (created/replaced/dropped sims) and
    // applySnapshot may have hard-teleported a sim into another tram — resolve
    // overlaps right away rather than waiting for the next tick.
    this.queueDirty = true;
    this.applyQueueConstraints();
  }

  /**
   * Switch the projection-sim tick cadence. Callers set 'full' while the map
   * renders the live projection every frame (positionMode==='live') and
   * 'coarse' otherwise. Idempotent; takes effect on the next tick().
   */
  setProjectionCadence(cadence: ProjectionCadence): void {
    this.projectionCadence = cadence;
  }

  /** Advance all sims to nowMs. dt derives from the previous tick (clamped). */
  tick(nowMs: number): void {
    this.refreshDaytime(nowMs);
    const dtS =
      this.lastTickMs === null
        ? 0
        : Math.min(Math.max((nowMs - this.lastTickMs) / 1000, 0), MAX_ENGINE_DT_S);
    this.lastTickMs = nowMs;
    if (dtS <= 0) return;

    // Projection sims advance with the same physics but are NOT queue-
    // constrained: they dead-reckon the raw fix, not the rendered fleet.
    // In 'full' cadence they move with the main tick; in 'coarse' they are
    // batch-advanced (in ≤ MAX_ENGINE_DT_S substeps, so physics integration
    // stays identical) at most every PROJ_COARSE_INTERVAL_MS.
    const full = this.projectionCadence === 'full';
    const prevProjMs = this.lastProjTickMs;
    let projSteps: { fromMs: number; toMs: number } | null = null;
    if (prevProjMs === null) {
      // First projection bookkeeping point; integrate this tick's dt in full
      // mode, just anchor the clock in coarse mode.
      if (full) projSteps = { fromMs: nowMs - dtS * 1000, toMs: nowMs };
      this.lastProjTickMs = nowMs;
    } else if (full || nowMs - prevProjMs >= PROJ_COARSE_INTERVAL_MS) {
      // Integrate the whole elapsed span (bounded), so no time is dropped on a
      // coarse→full cadence switch or across coarse intervals.
      const fromMs = Math.max(prevProjMs, nowMs - PROJ_COARSE_MAX_GAP_S * 1000);
      if (nowMs > fromMs) projSteps = { fromMs, toMs: nowMs };
      this.lastProjTickMs = nowMs;
    }

    for (const entry of this.entries.values()) {
      if (entry.sim) tickSim(entry.sim, nowMs, dtS);
      if (entry.projSim && projSteps) {
        // Substep the accumulated gap so the per-step dt clamp never drops time.
        let t = projSteps.fromMs;
        while (t < projSteps.toMs) {
          const step = Math.min(MAX_ENGINE_DT_S * 1000, projSteps.toMs - t);
          t += step;
          tickSim(entry.projSim, t, step / 1000);
        }
      }
    }
    // Car-following runs AFTER all position updates so queues compress
    // correctly regardless of iteration order.
    this.applyQueueConstraints();
  }

  /** Rebuild shapeId → sims queue groups (only groups of ≥ 2 members). */
  private rebuildQueueGroups(): void {
    this.queueDirty = false;
    const byShape = new Map<string, TramSim[]>();
    for (const entry of this.entries.values()) {
      const sim = entry.sim;
      if (!sim) continue;
      const shapeId = sim.geometry.shapeId;
      const group = byShape.get(shapeId);
      if (group) group.push(sim);
      else byShape.set(shapeId, [sim]);
    }
    this.queueGroups.length = 0;
    for (const group of byShape.values()) {
      if (group.length > 1) this.queueGroups.push(group);
    }
  }

  /**
   * Car-following/queueing: within one shapeId, a follower's nose may never
   * come closer than QUEUE_GAP_M to its leader's tail (leader.sM − leader
   * length incl. coupled trailer). Iterates each queue leader → follower so a
   * dwelling/teleported leader compresses the whole queue in one pass:
   *  - inside the buffer → clamp s to the limit and cap speed to the leader's
   *    (a follower queues behind a dwelling leader and departs after it clears);
   *  - approaching it → cap speed to leader speed + braking envelope over the
   *    remaining gap, so followers decelerate smoothly instead of slamming.
   * Trams on different shapeIds (opposite direction / other variants) are
   * intentionally NOT constrained.
   */
  private applyQueueConstraints(): void {
    if (this.queueDirty) this.rebuildQueueGroups();
    for (const group of this.queueGroups) {
      group.sort(compareBySimDist);
      for (let i = group.length - 2; i >= 0; i--) {
        const leader = group[i + 1];
        const follower = group[i];
        const limit = leader.sM - leader.lengthM - QUEUE_GAP_M;
        const gap = limit - follower.sM;
        if (gap <= 0) {
          follower.sM = Math.max(0, limit);
          follower.vMs = Math.min(follower.vMs, leader.vMs);
        } else {
          const vCap = leader.vMs + Math.sqrt(2 * A_BRK * gap);
          if (follower.vMs > vCap) follower.vMs = vCap;
        }
      }
    }
  }

  /** Public state for every tracked tram (UI lists, feature builder input). */
  getStates(nowMs: number = this.lastTickMs ?? Date.now()): TramPublicState[] {
    const out: TramPublicState[] = [];
    for (const entry of this.entries.values()) out.push(this.toPublicState(entry, nowMs));
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

  /** Geometry currently driving a tram's sim (featureBuilder callback). */
  getGeometry(key: string): RouteGeometry | undefined {
    return this.entries.get(key)?.sim?.geometry;
  }

  private toPublicState(entry: Entry, nowMs: number): TramPublicState {
    const { snapshot, sim } = entry;
    const model = this.opts.resolveModel(snapshot);

    if (!sim) {
      // No geometry: hold the raw API position (featureBuilder renders as-is).
      // The observation IS the position — the sim can't deviate from it.
      return {
        key: entry.key,
        snapshot,
        model,
        simDistM: snapshot.shapeDistM,
        simSpeedKmh: 0,
        position: [snapshot.coordinates[0], snapshot.coordinates[1]],
        bearing: snapshot.bearing ?? 0,
        phase: 'unknown',
        observedPosition: [snapshot.coordinates[0], snapshot.coordinates[1]],
        observedBearing: snapshot.bearing ?? 0,
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

    const { geometry } = sim;
    const next = nextUndwelledStop(sim);
    // Honest last AVL fix, placed on the shape (NOT projected forward in time).
    const observedDistM = Math.min(Math.max(snapshot.shapeDistM, 0), geometry.totalM);
    return {
      key: entry.key,
      snapshot,
      model,
      simDistM: sim.sM,
      simSpeedKmh: sim.vMs * 3.6,
      position: pointAt(geometry.coordinates, geometry.cumDistM, sim.sM),
      bearing: bearingAt(geometry.coordinates, geometry.cumDistM, sim.sM),
      phase: sim.phase,
      observedPosition: pointAt(geometry.coordinates, geometry.cumDistM, observedDistM),
      observedBearing: bearingAt(geometry.coordinates, geometry.cumDistM, observedDistM),
      deviationM: Math.abs(sim.sM - observedDistM),
      // Physics-integrated dead-reckoning of the fix (projSim); the schedule-
      // pace projection is a defensive fallback and normally never used.
      projectedObservedDistM: entry.projSim ? entry.projSim.sM : observedDistAt(sim, nowMs),
      nextStopName: next ? next.name : null,
      nextStopEtaS: next
        ? Math.max(0, (next.arrivalMs + snapshot.delaySeconds * 1000 - nowMs) / 1000)
        : null,
      hasGeometry: true,
      paceBias: sim.paceBias,
    };
  }
}
