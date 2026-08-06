// Live "on-line position" tracker for the DEBUG overlay. The user is physically
// inside the followed tram, so their filtered GPS projected onto that tram's
// shape IS the real tram's along-shape position — the ground truth the debug
// view compares the simulation against.
//
// This is INDEPENDENT of ride recording: it runs whenever the debug overlay is
// mounted (debugMode on), with or without an active ride. It deliberately does
// NOT reuse createExpoLocationWatcher (that drives the single shared
// RIDE_LOCATION_TASK background task — starting it here would clobber a live
// ride's handler). Instead it uses a plain FOREGROUND watchPositionAsync: a
// debug tool that only needs to work while the app is on-screen.
//
// The GPS is smoothed/outlier-gated with the SAME GpsFilter the ride recorder
// uses (gpsFilter.ts), so the on-line position the overlay shows matches the
// fLat/fLng/fDist/fLagM written into the ride record. Pure projection lives in
// projectOnlineFix (unit-tested); the locator wires the live seams.
import { projectPointToPolyline, type PolylineProjection } from '@/lib/geo/polyline';
import type { RouteGeometry } from '@/lib/types';

import type { LocationSample, LocationWatcher } from './core';
import { GpsFilter, type GpsRejectReason } from './gpsFilter';

/** Latest live fix: raw device GPS + its filtered (smoothed) estimate. */
export interface OnlineFix {
  /** Wall-clock ms of the fix. */
  t: number;
  gpsLat: number;
  gpsLng: number;
  /** Horizontal accuracy, m (null when the platform withholds it). */
  accuracyM: number | null;
  /** Raw device ground speed, m/s (null if unavailable). */
  speedMs: number | null;
  /** Filtered position (null before the filter anchors); coasted on a reject. */
  fLat: number | null;
  fLng: number | null;
  /** Filtered ground speed, m/s (null before anchoring). */
  fSpeedMs: number | null;
  /** null = accepted; 'acc'|'jump' = rejected outlier (raw is still recorded). */
  rej: GpsRejectReason | null;
}

/** An online fix projected onto the followed tram's shape. */
export interface OnlineProjection {
  /** Raw GPS projected onto the shape: along-shape distance + perp offset, m. */
  gpsDistM: number;
  gpsOffM: number;
  /** Filtered GPS projected onto the shape — the on-line position (m). null
   *  when the filter hasn't anchored yet. */
  fDistM: number | null;
  fOffM: number | null;
}

/**
 * Pure: project a live online fix onto a tram's shape. Returns null when the
 * geometry is unusable (fewer than two vertices). Filtered fields are null
 * until the GpsFilter has anchored (no filtered position yet).
 */
export function projectOnlineFix(
  fix: OnlineFix,
  geometry: RouteGeometry | undefined,
): OnlineProjection | null {
  if (!geometry || geometry.coordinates.length < 2) return null;
  const raw: PolylineProjection = projectPointToPolyline(
    [fix.gpsLng, fix.gpsLat],
    geometry.coordinates,
    geometry.cumDistM,
  );
  let f: PolylineProjection | null = null;
  if (fix.fLat != null && fix.fLng != null) {
    f = projectPointToPolyline([fix.fLng, fix.fLat], geometry.coordinates, geometry.cumDistM);
  }
  return {
    gpsDistM: raw.distM,
    gpsOffM: raw.offsetM,
    fDistM: f ? f.distM : null,
    fOffM: f ? f.offsetM : null,
  };
}

/**
 * Forward-extrapolate an on-line along-shape distance to `nowMs` using the
 * fix's filtered ground speed — a smooth 10 Hz readout of the rider's
 * position between the ~1 Hz foreground GPS fixes (the debug overlay timer
 * calls this on every 10 Hz sample). `baseDistM` is the fix projected onto the shape
 * (fDistM ?? gpsDistM); the advance is speed·Δt, forward-only and clamped to a
 * short horizon so a stalled/stale fix can't run the readout away. Returns
 * baseDistM unchanged when there is no usable speed, null when inputs are
 * unusable. Pure — unit-tested; nothing here feeds the simulation.
 */
export function projectOnlineDistAt(
  baseDistM: number | null,
  fix: OnlineFix | null,
  nowMs: number,
  maxExtrapS = 3,
): number | null {
  if (baseDistM == null || fix == null) return null;
  const speed = fix.fSpeedMs ?? fix.speedMs;
  if (speed == null || !Number.isFinite(speed) || speed <= 0) return baseDistM;
  const dtS = Math.min(Math.max((nowMs - fix.t) / 1000, 0), maxExtrapS);
  return baseDistM + speed * dtS;
}

export interface OnlineLocatorDeps {
  location: LocationWatcher;
  now: () => number;
}

/**
 * Retain-counted live GPS locator. `retain()` starts a foreground watch (the
 * first retainer); `release()` stops it (the last). Latest fix is exposed
 * synchronously via latest(); subscribers are notified per fix (~1–2 Hz).
 */
export class OnlineLocator {
  private readonly deps: OnlineLocatorDeps;
  private refCount = 0;
  private starting = false;
  private stopFn: (() => void) | null = null;
  private filter: GpsFilter | null = null;
  private latestFix: OnlineFix | null = null;
  private lastError: string | null = null;
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(deps: OnlineLocatorDeps) {
    this.deps = deps;
  }

  /** Start the watch while at least one caller holds the locator. */
  retain(): void {
    this.refCount += 1;
    if (this.refCount === 1) void this.begin();
  }

  release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) this.end();
  }

  private async begin(): Promise<void> {
    if (this.stopFn || this.starting) return;
    this.starting = true;
    this.lastError = null;
    this.filter = new GpsFilter();
    try {
      const stop = await this.deps.location.start((s) => this.onSample(s));
      // Released while the (async) permission/watch acquisition was in flight.
      if (this.refCount === 0) {
        try {
          stop();
        } catch {
          // ignore
        }
        this.starting = false;
        return;
      }
      this.stopFn = stop;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'location unavailable';
    }
    this.starting = false;
    this.notify();
  }

  private end(): void {
    try {
      this.stopFn?.();
    } catch {
      // ignore
    }
    this.stopFn = null;
    this.filter = null;
    this.latestFix = null;
    this.notify();
  }

  private onSample(s: LocationSample): void {
    try {
      const out =
        this.filter?.push({ t: s.t, lat: s.lat, lng: s.lng, accuracy: s.accuracy }) ?? null;
      this.latestFix = {
        t: s.t,
        gpsLat: s.lat,
        gpsLng: s.lng,
        accuracyM: s.accuracy,
        speedMs: s.speed,
        fLat: out ? out.lat : null,
        fLng: out ? out.lng : null,
        fSpeedMs: out ? out.speedMs : null,
        rej: out ? out.reason : null,
      };
      this.notify();
    } catch {
      // never throw from a location callback
    }
  }

  /** Latest live fix, or null before the first delivery. */
  latest(): OnlineFix | null {
    return this.latestFix;
  }

  /** True once the foreground watch is running. */
  active(): boolean {
    return this.stopFn !== null;
  }

  /** Last start error message (permission denied / unavailable), or null. */
  error(): string | null {
    return this.lastError;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion(): number {
    return this.version;
  }

  private notify(): void {
    this.version += 1;
    this.listeners.forEach((l) => {
      try {
        l();
      } catch {
        // ignore listener errors
      }
    });
  }
}
