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
import { buildSpeedProfile, type SpeedProfile } from './speedProfile';
import {
  applySnapshot,
  createSim,
  nextUndwelledStop,
  reanchorSim,
  targetDistAt,
  tick as tickSim,
  TELEPORT_THRESHOLD_M,
  type TramSim,
} from './tramSim';

/** Trams unseen for this long are dropped. */
export const STALE_AFTER_MS = 90_000;
/** Max offset when re-projecting a tram onto a new trip's geometry, meters. */
const REANCHOR_MAX_OFFSET_M = 100;
/** Max dt for one engine tick, seconds (larger gaps are clamped). */
const MAX_ENGINE_DT_S = 0.25;

export interface TramEngineOptions {
  /** Maps a snapshot to its fleet model spec (injected — keeps engine pure). */
  resolveModel: (snapshot: TramSnapshot) => TramModelSpec;
  /** Override daytime detection (07:00–19:00 Prague time by default). */
  isDaytime?: (nowMs: number) => boolean;
}

interface Entry {
  key: string;
  snapshot: TramSnapshot;
  tripId: string;
  lastSeenMs: number;
  sim: TramSim | null;
}

let pragueHourFormatter: Intl.DateTimeFormat | null | undefined;

function pragueHour(nowMs: number): number {
  if (pragueHourFormatter === undefined) {
    try {
      pragueHourFormatter = new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hour12: false,
        timeZone: 'Europe/Prague',
      });
    } catch {
      pragueHourFormatter = null;
    }
  }
  if (pragueHourFormatter) {
    const h = parseInt(pragueHourFormatter.format(new Date(nowMs)), 10);
    if (!Number.isNaN(h)) return h % 24;
  }
  // Fallback: CET/CEST approximation.
  return (new Date(nowMs).getUTCHours() + 2) % 24;
}

/** Default daytime rule: 07:00–19:00 Prague time. */
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
  private readonly opts: TramEngineOptions;

  constructor(opts: TramEngineOptions) {
    this.opts = opts;
  }

  private isDaytime(nowMs: number): boolean {
    return (this.opts.isDaytime ?? defaultIsDaytime)(nowMs);
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
        entry = { key, snapshot, tripId: snapshot.tripId, lastSeenMs: nowMs, sim: null };
        this.entries.set(key, entry);
      }
      entry.snapshot = snapshot;
      entry.lastSeenMs = nowMs;

      if (!geometry) {
        // No geometry (yet, or trip changed and the new shape isn't loaded):
        // hold the raw API position; drop a sim that belongs to a stale trip.
        if (entry.tripId !== snapshot.tripId) entry.sim = null;
        entry.tripId = snapshot.tripId;
        continue;
      }

      const profile = this.getProfile(geometry, daytime);

      if (entry.sim && entry.tripId === snapshot.tripId) {
        applySnapshot(entry.sim, snapshot, nowMs);
      } else if (entry.sim) {
        // Trip changed: swap geometry, keeping a smooth position when the old
        // world position lies close to the new shape and near the schedule.
        const oldSim = entry.sim;
        const oldPos = pointAt(oldSim.geometry.coordinates, oldSim.geometry.cumDistM, oldSim.sM);
        const newSim = createSim(geometry, profile, snapshot, nowMs);
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
        entry.sim = createSim(geometry, profile, snapshot, nowMs);
      }
      entry.tripId = snapshot.tripId;
    }

    // Remove trams unseen for 90 s.
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastSeenMs > STALE_AFTER_MS) this.entries.delete(key);
    }
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
    for (const entry of this.entries.values()) {
      if (entry.sim) tickSim(entry.sim, nowMs, dtS);
    }
  }

  /** Public state for every tracked tram (UI lists, feature builder input). */
  getStates(nowMs: number = this.lastTickMs ?? Date.now()): TramPublicState[] {
    const out: TramPublicState[] = [];
    for (const entry of this.entries.values()) out.push(this.toPublicState(entry, nowMs));
    return out;
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
      return {
        key: entry.key,
        snapshot,
        model,
        simDistM: snapshot.shapeDistM,
        simSpeedKmh: 0,
        position: [snapshot.coordinates[0], snapshot.coordinates[1]],
        bearing: snapshot.bearing ?? 0,
        phase: 'unknown',
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
    return {
      key: entry.key,
      snapshot,
      model,
      simDistM: sim.sM,
      simSpeedKmh: sim.vMs * 3.6,
      position: pointAt(geometry.coordinates, geometry.cumDistM, sim.sM),
      bearing: bearingAt(geometry.coordinates, geometry.cumDistM, sim.sM),
      phase: sim.phase,
      nextStopName: next ? next.name : null,
      nextStopEtaS: next
        ? Math.max(0, (next.arrivalMs + snapshot.delaySeconds * 1000 - nowMs) / 1000)
        : null,
      hasGeometry: true,
    };
  }
}
