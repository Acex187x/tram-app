// MotionLog core — pure, dependency-injected engine for collecting real-vs-sim
// telemetry so the physics can be recalibrated later. Two independent streams:
//
//   • Passive daily log (motionlogs/<date>.jsonl): every poll, one compact
//     record per tram-with-geometry {t,key,model,line,obsDist,simDist,projDist,
//     devM,lat,lng,mode}. Records are held in a capped in-memory ring buffer and
//     batch-flushed to disk at most once / FLUSH_MS. A flush failure NEVER
//     throws into the caller (the map runtime). The whole log directory is
//     capped (~8 MB) by evicting the oldest files.
//
//   • Ride recording (rides/<ts>-<key>.jsonl): while the user is physically on a
//     tram, GPS fixes (~1 Hz) are correlated with the simulated state and
//     appended live. Auto-stops after RIDE_MAX_MS to spare the battery.
//
// All I/O, time, location and timers are injected (see MotionLogDeps) so the
// buffering/flush/eviction logic is unit-testable with in-memory fakes.
import type { TramPublicState } from '@/lib/types';

// ── injected boundaries ──────────────────────────────────────────────────────

export interface MotionFileInfo {
  /** Path relative to the motion-log base dir, e.g. 'rides/….jsonl'. */
  relPath: string;
  /** Basename incl. extension. */
  name: string;
  /** Absolute file:// uri (for the share sheet). */
  uri: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified epoch ms (0 if unknown). */
  modifiedMs: number;
}

/** Tiny synchronous filesystem seam (expo-file-system in prod, fake in tests). */
export interface MotionLogFS {
  /** Append already-newline-terminated text, creating dirs/file as needed. */
  append(relPath: string, text: string): void;
  /** List files directly under a relative dir (non-recursive). */
  list(relDir: string): MotionFileInfo[];
  /** Delete a file by relPath; no-op when absent. */
  remove(relPath: string): void;
  /** Absolute file:// uri for a relPath. */
  uri(relPath: string): string;
}

export interface LocationSample {
  t: number;
  lat: number;
  lng: number;
  /** m/s, null if unavailable. */
  speed: number | null;
  /** horizontal accuracy in m, null if unavailable. */
  accuracy: number | null;
}

/** Location seam. `start` resolves once watching begins; rejects if denied. */
export interface LocationWatcher {
  start(onSample: (s: LocationSample) => void): Promise<() => void>;
}

export interface MotionLogDeps {
  fs: MotionLogFS;
  location: LocationWatcher;
  /** Current wall-clock ms. */
  now: () => number;
  /** Latest public state for a tram key (from the engine), or undefined. */
  stateProvider: (key: string) => TramPublicState | undefined;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
  /** Override the on-disk budget (defaults to DIR_CAP_BYTES). */
  dirCapBytes?: number;
}

// ── tuning ───────────────────────────────────────────────────────────────────

export const LOG_DIR = 'motionlogs';
export const RIDE_DIR = 'rides';
/** Max unflushed daily-log lines held in memory before oldest are dropped. */
export const MAX_PENDING = 4_000;
/** Flush pending daily-log lines to disk at most this often. */
export const FLUSH_MS = 30_000;
/** Force a flush when the pending buffer reaches this size. */
export const FLUSH_AT_LINES = 600;
/** Total on-disk budget for all motion data; oldest files evicted past this. */
export const DIR_CAP_BYTES = 8 * 1024 * 1024;
/** Auto-stop a ride after this long (battery guard). */
export const RIDE_MAX_MS = 90 * 60 * 1000;

// ── record shapes (kept compact on disk) ─────────────────────────────────────

export interface RideInfo {
  key: string;
  startedMs: number;
  points: number;
  relPath: string;
}

export interface MotionStats {
  logBytes: number;
  rideBytes: number;
  totalBytes: number;
  logCount: number;
  rideCount: number;
  /** Unflushed daily-log lines currently buffered in memory. */
  pending: number;
  riding: boolean;
}

function r(n: number | null | undefined, p = 0): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

/** 'YYYY-MM-DD' in local time for the daily log filename. */
export function dayStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Filesystem-safe compact timestamp 'YYYYMMDD-HHMMSS' for ride filenames. */
export function fileStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Build one compact daily-log record line for a tram (no trailing newline). */
export function pollRecord(s: TramPublicState, t: number): string {
  return JSON.stringify({
    t,
    key: s.key,
    model: s.model.id,
    line: s.snapshot.line,
    obsDist: r(s.snapshot.shapeDistM),
    simDist: r(s.simDistM),
    projDist: r(s.projectedObservedDistM),
    devM: r(s.deviationM, 1),
    kmh: r(s.simSpeedKmh, 1),
    lat: r(s.position[1], 6),
    lng: r(s.position[0], 6),
    mode: s.phase,
  });
}

/** Build one ride record line correlating a GPS fix with the sim (no newline). */
export function rideRecord(sample: LocationSample, s: TramPublicState | undefined): string {
  return JSON.stringify({
    t: sample.t,
    gpsLat: r(sample.lat, 6),
    gpsLng: r(sample.lng, 6),
    gpsSpeed: r(sample.speed, 2),
    gpsAcc: r(sample.accuracy, 1),
    simDist: s ? r(s.simDistM) : null,
    simLat: s ? r(s.position[1], 6) : null,
    simLng: s ? r(s.position[0], 6) : null,
    simKmh: s ? r(s.simSpeedKmh, 1) : null,
    obsDist: s ? r(s.snapshot.shapeDistM) : null,
    projDist: s ? r(s.projectedObservedDistM) : null,
    devM: s ? r(s.deviationM, 1) : null,
    model: s ? s.model.id : null,
    line: s ? s.snapshot.line : null,
    phase: s ? s.phase : null,
  });
}

// ── the engine ───────────────────────────────────────────────────────────────

export class MotionLog {
  private readonly deps: MotionLogDeps;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;
  private readonly dirCapBytes: number;

  /** Unflushed daily-log lines (the in-memory ring buffer). */
  private pending: string[] = [];
  private lastFlushMs = 0;

  private ride: RideInfo | null = null;
  private rideStop: (() => void) | null = null;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;

  private listeners = new Set<() => void>();
  private version = 0;

  constructor(deps: MotionLogDeps) {
    this.deps = deps;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h));
    this.dirCapBytes = deps.dirCapBytes ?? DIR_CAP_BYTES;
    // Anchor the flush clock to construction so the first poll doesn't flush a
    // single record immediately (throttle measures elapsed since last flush).
    this.lastFlushMs = deps.now();
  }

  // — passive daily logging —

  /**
   * Called once per poll by the map runtime. Appends a record for every tram
   * with geometry to the in-memory buffer and opportunistically flushes.
   * Guaranteed not to throw.
   */
  onPoll(states: readonly TramPublicState[], nowMs: number): void {
    try {
      for (const s of states) {
        if (!s.hasGeometry) continue;
        this.pending.push(pollRecord(s, nowMs));
      }
      this.capPending();
      if (this.pending.length >= FLUSH_AT_LINES || nowMs - this.lastFlushMs >= FLUSH_MS) {
        this.flush(nowMs);
      }
    } catch {
      // A logging failure must never disturb the runtime.
    }
  }

  /** Hard memory bound: shed the oldest unflushed lines past MAX_PENDING. */
  private capPending(): void {
    if (this.pending.length > MAX_PENDING) {
      this.pending.splice(0, this.pending.length - MAX_PENDING);
    }
  }

  /**
   * Append buffered daily-log lines to today's file, then enforce the disk cap.
   * On a write failure the lines are kept for the next attempt (bounded by
   * MAX_PENDING), so a transient FS error doesn't lose data outright.
   */
  flush(nowMs: number = this.deps.now()): void {
    this.lastFlushMs = nowMs;
    if (this.pending.length === 0) {
      this.enforceDirCap();
      return;
    }
    const lines = this.pending;
    this.pending = [];
    try {
      this.deps.fs.append(`${LOG_DIR}/${dayStamp(nowMs)}.jsonl`, lines.join('\n') + '\n');
    } catch {
      // Re-buffer for retry, then re-apply the memory bound.
      this.pending = lines.concat(this.pending);
      this.capPending();
      return;
    }
    this.enforceDirCap();
  }

  /** Evict the oldest files (across both dirs) until under the disk cap. */
  private enforceDirCap(): void {
    try {
      const files = [...this.deps.fs.list(LOG_DIR), ...this.deps.fs.list(RIDE_DIR)];
      let total = files.reduce((n, f) => n + f.size, 0);
      if (total <= this.dirCapBytes) return;
      // Oldest first, but never delete the file the active ride is writing.
      const activeRel = this.ride?.relPath;
      const victims = files
        .filter((f) => f.relPath !== activeRel)
        .sort((a, b) => a.modifiedMs - b.modifiedMs);
      for (const f of victims) {
        if (total <= this.dirCapBytes) break;
        this.deps.fs.remove(f.relPath);
        total -= f.size;
      }
    } catch {
      // ignore — capping is best-effort
    }
  }

  // — ride recording —

  isRiding(): boolean {
    return this.ride !== null;
  }

  rideInfo(): RideInfo | null {
    return this.ride ? { ...this.ride } : null;
  }

  /**
   * Begin a GPS ride recording for `tramKey`. One at a time. Resolves true when
   * watching started, false if a ride is already active or permission failed.
   */
  async startRide(tramKey: string): Promise<boolean> {
    if (this.ride) return false;
    const startedMs = this.deps.now();
    const relPath = `${RIDE_DIR}/${fileStamp(startedMs)}-${sanitizeKey(tramKey)}.jsonl`;
    // Claim the slot before awaiting so concurrent calls can't double-start.
    this.ride = { key: tramKey, startedMs, points: 0, relPath };
    this.notify();
    try {
      this.rideStop = await this.deps.location.start((sample) => this.onRideSample(sample));
    } catch {
      this.ride = null;
      this.rideStop = null;
      this.notify();
      return false;
    }
    // Guard against a stop() that landed while we were awaiting permission.
    if (!this.ride) {
      this.rideStop?.();
      this.rideStop = null;
      return false;
    }
    this.autoStopTimer = this.setTimer(() => void this.stopRide(), RIDE_MAX_MS);
    return true;
  }

  private onRideSample(sample: LocationSample): void {
    const ride = this.ride;
    if (!ride) return;
    try {
      const state = this.deps.stateProvider(ride.key);
      this.deps.fs.append(ride.relPath, rideRecord(sample, state) + '\n');
      ride.points += 1;
      // Rides are low-volume; still keep total disk usage bounded.
      if (ride.points % 30 === 0) this.enforceDirCap();
      this.notify();
    } catch {
      // never throw from a location callback
    }
  }

  /** Stop the active ride; returns its file uri (or null if not riding). */
  async stopRide(): Promise<string | null> {
    const ride = this.ride;
    if (!ride) return null;
    this.ride = null;
    if (this.autoStopTimer != null) {
      this.clearTimer(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    try {
      this.rideStop?.();
    } catch {
      // ignore
    }
    this.rideStop = null;
    this.flush(this.deps.now());
    this.notify();
    return this.deps.fs.uri(ride.relPath);
  }

  // — export / stats —

  listLogFiles(): MotionFileInfo[] {
    return this.sorted(this.safeList(LOG_DIR));
  }

  listRideFiles(): MotionFileInfo[] {
    return this.sorted(this.safeList(RIDE_DIR));
  }

  /** All motion-data file uris (logs + rides), newest first. Flushes first. */
  async exportAll(): Promise<string[]> {
    this.flush(this.deps.now());
    return [...this.listRideFiles(), ...this.listLogFiles()].map((f) => f.uri);
  }

  stats(): MotionStats {
    const logs = this.safeList(LOG_DIR);
    const rides = this.safeList(RIDE_DIR);
    const logBytes = logs.reduce((n, f) => n + f.size, 0);
    const rideBytes = rides.reduce((n, f) => n + f.size, 0);
    return {
      logBytes,
      rideBytes,
      totalBytes: logBytes + rideBytes,
      logCount: logs.length,
      rideCount: rides.length,
      pending: this.pending.length,
      riding: this.ride !== null,
    };
  }

  /** Delete every stored motion-log + ride file. Stops any active ride first. */
  clearAll(): void {
    if (this.ride) void this.stopRide();
    this.pending = [];
    for (const f of [...this.safeList(LOG_DIR), ...this.safeList(RIDE_DIR)]) {
      try {
        this.deps.fs.remove(f.relPath);
      } catch {
        // ignore
      }
    }
    this.notify();
  }

  // — subscription (UI) —

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Monotonic counter bumped on every change — a stable useSyncExternalStore snapshot. */
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

  private safeList(dir: string): MotionFileInfo[] {
    try {
      return this.deps.fs.list(dir);
    } catch {
      return [];
    }
  }

  private sorted(files: MotionFileInfo[]): MotionFileInfo[] {
    return [...files].sort((a, b) => b.modifiedMs - a.modifiedMs);
  }
}
