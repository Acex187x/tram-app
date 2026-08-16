// MotionLog core — pure, dependency-injected engine for collecting real-vs-sim
// telemetry so the physics can be recalibrated later. Two independent streams:
//
//   • Passive daily log (motionlogs/<date>.jsonl): every poll, one compact
//     record per tram-with-geometry {t,key,model,line,obsDist,simDist,projDist,
//     devM,kmh,bias,lat,lng,mode,obsAt,statePos,delayS,nextSeq} (the feed's
//     CalibrationRecord). Records are held in a capped in-memory ring buffer and
//     batch-flushed to disk at most once / FLUSH_MS. A flush failure NEVER
//     throws into the caller (the map runtime). The whole log directory is
//     capped (~8 MB) by evicting the oldest files — but NEVER the active
//     ride file or today's ACTIVE daily-log part (R9: evicting the live log
//     punched 15–20 min holes into the exported history). Instead the active
//     part may overflow the shared cap up to its own soft ceiling
//     (ACTIVE_LOG_ROTATE_BYTES); on reaching it, writing rotates to the next
//     part file '<date>.N.jsonl' and the previous part becomes an evictable
//     archive. (The FS seam has no rename, so rotation redirects the writer
//     to a fresh part instead of renaming the full one away.) Export/listing
//     sees every part — they all live in LOG_DIR.
//
//   • Ride recording (rides/<ts>-<key>.jsonl): while the user is physically on a
//     tram, GPS fixes (~1 Hz) are correlated with the simulated state and
//     appended live (ride schema v4 — see rideRecord and
//     docs/calibration/plan.md). Each fix also runs through the pure GpsFilter
//     (gpsFilter.ts): the RAW fix is always written verbatim, plus the
//     filtered position and its shape projection (fLat/fLng/rej/fDist/fOffM/
//     fLagM). In parallel an optional MotionWatcher (sensors.ts, DeviceMotion
//     ~25 Hz) streams IMU samples that are buffered briefly and appended as
//     compact {type:'motion'} batch lines (≤1 s / ≤MOTION_FLUSH_AT samples per
//     batch — a crash loses at most ~1 s of motion, never any GPS point).
//     Auto-stops after RIDE_MAX_MS to spare the battery. CRASH-SAFETY CONTRACT
//     (two device recordings were lost to the pre-v3 design — see the fix
//     notes below):
//       – startRide writes a {type:'ride-start'} header line IMMEDIATELY, so
//         the file exists on disk from second zero;
//       – every GPS point is appended to disk synchronously (no buffering);
//       – stopRide writes a {type:'ride-end'} footer;
//       – a file whose last line is not a footer was interrupted by process
//         death — recoverOrphanRides() (called at app start) closes it with a
//         {type:'ride-orphaned'} footer; it stays listed/exported like any ride;
//       – ride files are NEVER victims of the disk-cap eviction (this was loss
//         vector #1: completed rides aged out of the 8 MB cap within ~20 min of
//         passive logging). Only clearAll() deletes rides.
//
// All I/O, time, location and timers are injected (see MotionLogDeps) so the
// buffering/flush/eviction logic is unit-testable with in-memory fakes.
//
// Entry-point split (feed boundary refactor): the FEED owns WHEN calibration
// records are produced (TramFeed.reportCalibration per batch); this
// module owns HOW/WHERE they are stored. `onCalibration(records)` is the
// storage entry point; `onPoll(states)` remains as the state-based convenience
// wrapper (it builds the records itself via feed/calibration).
import { toCalibrationRecord, toCalibrationRecords } from '@/lib/feed/calibration';
import type { CalibrationRecord } from '@/lib/feed/types';
import { projectPointToPolyline, type PolylineProjection } from '@/lib/geo/polyline';
import type { RouteGeometry, TramPublicState } from '@/lib/types';

import { GpsFilter, type GpsFilterOutput } from './gpsFilter';

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
  /** Full text content of a file; '' when absent (orphan-recovery scan). */
  read(relPath: string): string;
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

/** How ride GPS fixes are being delivered (honest UI status). */
export type LocationWatchMode = 'background' | 'foreground';

/**
 * One IMU sample (ride schema v4). Nulls where the device/platform withholds
 * a channel (e.g. no gyroscope → no user acceleration / attitude).
 */
export interface MotionSample {
  /** Wall-clock ms at delivery. */
  t: number;
  /** User acceleration (gravity removed), m/s². */
  ax: number | null;
  ay: number | null;
  az: number | null;
  /** Rotation rate, deg/s. */
  ra: number | null;
  rb: number | null;
  rg: number | null;
  /** Attitude (orientation in space), rad. */
  oa: number | null;
  ob: number | null;
  og: number | null;
}

/**
 * High-rate motion seam (expo-sensors DeviceMotion in prod, fake in tests).
 * `start` resolves once samples flow; rejects when unavailable/denied — the
 * core treats that as "GPS-only ride", never as a failed recording.
 */
export interface MotionWatcher {
  start(onSample: (s: MotionSample) => void): Promise<() => void>;
}

/** Location seam. `start` resolves once watching begins; rejects if denied. */
export interface LocationWatcher {
  start(onSample: (s: LocationSample) => void): Promise<() => void>;
  /**
   * How the active watch delivers fixes: 'background' (survives the app being
   * backgrounded — expo-location task updates) or 'foreground' (dies on
   * suspend — the watchPositionAsync fallback). null when not watching or the
   * implementation can't tell (fakes).
   */
  mode?(): LocationWatchMode | null;
}

export interface MotionLogDeps {
  fs: MotionLogFS;
  location: LocationWatcher;
  /**
   * Optional high-rate IMU stream recorded alongside ride GPS (schema v4
   * motion batches). A missing/failing watcher degrades to a GPS-only ride.
   */
  motion?: MotionWatcher;
  /** Current wall-clock ms. */
  now: () => number;
  /** Latest public state for a tram key (from the engine), or undefined. */
  stateProvider: (key: string) => TramPublicState | undefined;
  /**
   * Geometry currently driving a tram's sim (engine.getGeometry), for
   * projecting the rider's GPS onto the tram's shape (gpsDist/lagM ride
   * fields). Optional seam; ride fields are null without it.
   */
  geometry?: (key: string) => RouteGeometry | undefined;
  /**
   * Current position-mode setting ('smooth' | 'live' | 'raw' | 'ml'), for ride
   * records — which rendering the user was visually comparing the tram
   * against. Passed through verbatim into the ride line's posMode field.
   * Optional seam so the pure core stays store-free; null when absent.
   */
  positionMode?: () => string;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
  /** Override the on-disk budget (defaults to DIR_CAP_BYTES). */
  dirCapBytes?: number;
  /** Override the active daily-log rotation ceiling (defaults to ACTIVE_LOG_ROTATE_BYTES). */
  activeLogRotateBytes?: number;
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
/**
 * Total on-disk budget for all motion data; oldest files evicted past this.
 * Raised 8 → 24 MB for schema v4: a 90 min ride with 25 Hz motion batches is
 * ~8 MB by itself, and rides are never evicted — an 8 MB cap would force every
 * passive-log archive out within one long ride.
 */
export const DIR_CAP_BYTES = 24 * 1024 * 1024;
/**
 * Soft ceiling for the ACTIVE daily-log part alone. The active part is never
 * evicted by the disk cap (R9), so the directory may exceed DIR_CAP_BYTES by
 * up to this much; once the active part itself reaches this size, writing
 * rotates to the next '<date>.N.jsonl' part and the full part becomes an
 * evictable archive.
 */
export const ACTIVE_LOG_ROTATE_BYTES = 16 * 1024 * 1024;
/** Auto-stop a ride after this long (battery guard). */
export const RIDE_MAX_MS = 90 * 60 * 1000;
/** Ride on-disk schema version, written into the ride-start header. */
export const RIDE_SCHEMA = 'v4';
/** Flush buffered motion samples to the ride file at least this often. */
export const MOTION_FLUSH_MS = 1_000;
/** …or as soon as this many samples are buffered (25 ≈ 1 s at 25 Hz). */
export const MOTION_FLUSH_AT = 25;
/**
 * Hard memory bound on unflushed motion samples across append failures
 * (~20 s at 25 Hz); oldest are shed past this. GPS points are NEVER buffered.
 */
export const MOTION_MAX_PENDING = 500;

// ── record shapes (kept compact on disk) ─────────────────────────────────────

export interface RideInfo {
  key: string;
  startedMs: number;
  points: number;
  relPath: string;
  /** Wall-clock ms of the last appended GPS point; null before the first. */
  lastPointMs: number | null;
  /** IMU samples flushed to disk so far (v4 motion batches). */
  motionSamples: number;
  /** GPS fixes rejected as outliers by the filter (still written raw). */
  gpsRejects: number;
}

/** What stopRide hands back for the "ride saved" confirmation UI. */
export interface RideStopResult {
  uri: string;
  relPath: string;
  points: number;
  /** On-disk size after the ride-end footer, bytes (0 if unlistable). */
  bytes: number;
  /** IMU samples recorded (v4 motion batches). */
  motionSamples: number;
  /** GPS fixes flagged as outliers by the filter. */
  gpsRejects: number;
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

/** RelPath of a daily-log part: part 0 is the plain '<date>.jsonl'. */
export function logPartRel(day: string, part: number): string {
  return `${LOG_DIR}/${day}${part > 0 ? `.${part}` : ''}.jsonl`;
}

/**
 * Build one compact daily-log record line for a tram (no trailing newline).
 * Field order + rounding now live in feed/calibration.ts — the record IS the
 * feed's CalibrationRecord, serialized.
 */
export function pollRecord(s: TramPublicState, t: number): string {
  return JSON.stringify(toCalibrationRecord(s, t));
}

/**
 * Build one ride record line correlating a GPS fix with the sim (no newline).
 * Field order is the on-disk format — new fields are APPENDED so old lines
 * remain a strict prefix (same rule as feed/calibration CalibrationRecord).
 * `gpsProj` is the rider's GPS fix projected onto the tram's shape (null
 * without geometry) — it yields the ground-truth lag metric lagM.
 */
export function rideRecord(
  sample: LocationSample,
  s: TramPublicState | undefined,
  posMode?: string | null,
  gpsProj?: PolylineProjection | null,
  filt?: GpsFilterOutput | null,
  fProj?: PolylineProjection | null,
): string {
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
    // physics v3: the «fixed» (raw model opinion) curve replaced the deleted
    // dead-reckoned projection in this column — same role, new source.
    projDist: s ? r(s.fixedDistM) : null,
    devM: s ? r(s.deviationM, 1) : null,
    model: s ? s.model.id : null,
    line: s ? s.snapshot.line : null,
    phase: s ? s.phase : null,
    // Ride schema v2 — appended AFTER the historic fields (old parsers see a
    // strict prefix; detect by presence of `obsAt`). Raw AVL context + learned
    // bias, keyed like the daily-log v2 fields, for ground-truth matching:
    // GPS vs sim vs raw AVL vs projection with real dwells + stop anchoring.
    obsAt: s ? r(s.snapshot.observedAtMs) : null,
    statePos: s ? (s.snapshot.statePosition ?? null) : null,
    delayS: s ? r(s.snapshot.delaySeconds) : null,
    nextSeq: s ? r(s.snapshot.nextStopSequence) : null,
    // paceBias died with the client engine (pace is learned server-side now);
    // the column stays for the JSONL prefix contract and is always null.
    bias: null,
    posMode: posMode ?? null,
    // Ride schema v3 — appended AFTER the v2 fields (old parsers see a strict
    // prefix; detect by presence of `gpsDist`). The rider's GPS projected onto
    // the tram's shape — the ground-truth lag of the real tram (which the
    // rider is sitting in) vs the simulation:
    //   gpsDist  distance along the shape of the rider's projected GPS (m)
    //   gpsOffM  perpendicular offset GPS↔shape (m) — projection quality gate
    //   lagM     simDist − gpsDist; POSITIVE = the simulation runs AHEAD of
    //            the real tram. The headline calibration metric.
    gpsDist: gpsProj ? r(gpsProj.distM, 1) : null,
    gpsOffM: gpsProj ? r(gpsProj.offsetM, 1) : null,
    lagM: gpsProj && s && Number.isFinite(s.simDistM) ? r(s.simDistM - gpsProj.distM, 1) : null,
    // Ride schema v4 — appended AFTER the v3 fields (old parsers see a strict
    // prefix; detect by presence of `tripId`).
    //   tripId          trip the sim/AVL context belongs to (can change mid-ride)
    //   fLat/fLng       FILTERED rider position (GpsFilter: accuracy+jump gates
    //                   + alpha-beta smoothing); on a rejected fix this is the
    //                   coasted prediction — see `rej`
    //   rej             null = accepted; 'acc' (bad horizontalAccuracy) or
    //                   'jump' (physically impossible displacement). The RAW
    //                   fix above is always recorded verbatim either way.
    //   fDist/fOffM     filtered position projected onto the tram's shape
    //   fLagM           simDist − fDist — the PREFERRED ground-truth lag
    //                   (lagM from the raw fix is kept for comparison)
    tripId: s ? (s.snapshot.tripId ?? null) : null,
    fLat: filt ? r(filt.lat, 6) : null,
    fLng: filt ? r(filt.lng, 6) : null,
    rej: filt ? filt.reason : null,
    fDist: fProj ? r(fProj.distM, 1) : null,
    fOffM: fProj ? r(fProj.offsetM, 1) : null,
    fLagM: fProj && s && Number.isFinite(s.simDistM) ? r(s.simDistM - fProj.distM, 1) : null,
  });
}

/**
 * One compact motion batch line (no newline): `t0` = wall-clock ms of the
 * first sample, `n` = sample count, `s` = per-sample arrays
 * [dtMs, ax, ay, az, ra, rb, rg, oa, ob, og] (dt relative to t0; user accel
 * m/s² 3 dp, rotation rate deg/s 2 dp, attitude rad 3 dp; null where the
 * device withholds a channel). Carries `type:'motion'` so pre-v4 parsers skip
 * it as an unknown meta line.
 */
export function motionRecord(samples: readonly MotionSample[]): string {
  const t0 = samples[0]?.t ?? 0;
  return JSON.stringify({
    type: 'motion',
    t0,
    n: samples.length,
    s: samples.map((m) => [
      Math.max(0, Math.round(m.t - t0)),
      r(m.ax, 3),
      r(m.ay, 3),
      r(m.az, 3),
      r(m.ra, 2),
      r(m.rb, 2),
      r(m.rg, 2),
      r(m.oa, 3),
      r(m.ob, 3),
      r(m.og, 3),
    ]),
  });
}

/** Ride file header line (no newline) — written the instant a ride starts. */
export function rideStartRecord(
  tramKey: string,
  s: TramPublicState | undefined,
  t: number,
): string {
  return JSON.stringify({
    type: 'ride-start',
    tramKey,
    model: s ? s.model.id : null,
    line: s ? s.snapshot.line : null,
    t,
    schema: RIDE_SCHEMA,
    // v4: appended after the historic header fields (key-based parsers only).
    tripId: s ? (s.snapshot.tripId ?? null) : null,
  });
}

/** True when a parsed ride-file line is a closing footer. */
function isRideFooter(rec: unknown): boolean {
  const type = (rec as { type?: unknown } | null)?.type;
  return type === 'ride-end' || type === 'ride-orphaned';
}

// ── the engine ───────────────────────────────────────────────────────────────

export class MotionLog {
  private readonly deps: MotionLogDeps;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;
  private readonly dirCapBytes: number;
  private readonly activeLogRotateBytes: number;

  /** Unflushed daily-log lines (the in-memory ring buffer). */
  private pending: string[] = [];
  private lastFlushMs = 0;

  /** Rotation part index of the active daily log (0 = plain '<date>.jsonl'). */
  private logPart = 0;
  /** dayStamp the part index belongs to ('' forces a rescan on next use). */
  private logPartDay = '';

  private ride: RideInfo | null = null;
  private rideStop: (() => void) | null = null;
  /** Stop handle of the active motion (IMU) watcher; null = GPS-only ride. */
  private rideMotionStop: (() => void) | null = null;
  /** Motion samples awaiting their next ≤1 s batch append. */
  private motionPending: MotionSample[] = [];
  private lastMotionFlushMs = 0;
  /** Per-ride GPS outlier filter (gpsFilter.ts); fresh on every startRide. */
  private gpsFilter: GpsFilter | null = null;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Wall-clock ms past which the active ride must stop (battery guard),
   * checked in EVERY location callback: the autoStopTimer alone is unreliable
   * — iOS suspends JS timers while backgrounded, and location deliveries can
   * long outlive the timer's intended firing moment.
   */
  private rideDeadlineMs: number | null = null;

  private listeners = new Set<() => void>();
  private version = 0;

  constructor(deps: MotionLogDeps) {
    this.deps = deps;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h));
    this.dirCapBytes = deps.dirCapBytes ?? DIR_CAP_BYTES;
    this.activeLogRotateBytes = deps.activeLogRotateBytes ?? ACTIVE_LOG_ROTATE_BYTES;
    // Anchor the flush clock to construction so the first poll doesn't flush a
    // single record immediately (throttle measures elapsed since last flush).
    this.lastFlushMs = deps.now();
  }

  // — passive daily logging —

  /**
   * Storage entry point, called once per snapshot batch by the feed
   * (TramFeed.reportCalibration). Appends every record to the
   * in-memory buffer and opportunistically flushes. An empty batch still
   * advances the flush clock check. Guaranteed not to throw. `nowMs` defaults
   * to the batch time carried by the records (all records in a batch share it).
   */
  onCalibration(records: readonly CalibrationRecord[], nowMs?: number): void {
    try {
      const t = nowMs ?? (records.length > 0 ? records[records.length - 1].t : this.deps.now());
      for (const rec of records) {
        this.pending.push(JSON.stringify(rec));
      }
      this.capPending();
      if (this.pending.length >= FLUSH_AT_LINES || t - this.lastFlushMs >= FLUSH_MS) {
        this.flush(t);
      }
    } catch {
      // A logging failure must never disturb the runtime.
    }
  }

  /**
   * State-based convenience wrapper (historic entry point): builds records for
   * every tram with geometry, then stores them. Guaranteed not to throw.
   */
  onPoll(states: readonly TramPublicState[], nowMs: number): void {
    try {
      this.onCalibration(toCalibrationRecords(states, nowMs), nowMs);
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
      this.enforceDirCap(nowMs);
      return;
    }
    const lines = this.pending;
    this.pending = [];
    try {
      this.deps.fs.append(this.activeLogRel(nowMs), lines.join('\n') + '\n');
    } catch {
      // Re-buffer for retry, then re-apply the memory bound.
      this.pending = lines.concat(this.pending);
      this.capPending();
      return;
    }
    // Order matters: enforce the cap while THIS part is still the protected
    // active one, then retire it if it crossed the rotation ceiling — so a
    // freshly-full part is never evicted in the same breath it was written.
    this.enforceDirCap(nowMs);
    this.maybeRotate(nowMs);
  }

  /** RelPath of the active daily-log part for `nowMs` (rescans on day change). */
  private activeLogRel(nowMs: number): string {
    const day = dayStamp(nowMs);
    if (day !== this.logPartDay) {
      this.logPartDay = day;
      this.logPart = this.findCurrentPart(day);
    }
    return logPartRel(day, this.logPart);
  }

  /**
   * Highest on-disk part index for `day` — so a relaunched app resumes the
   * part it left off at instead of re-appending to an already-full part.
   * Returns highest+1 when that part already reached the rotation ceiling.
   */
  private findCurrentPart(day: string): number {
    try {
      const re = new RegExp(`^${day}(?:\\.(\\d+))?\\.jsonl$`);
      let part = 0;
      let size = 0;
      for (const f of this.deps.fs.list(LOG_DIR)) {
        const m = re.exec(f.name);
        if (!m) continue;
        const p = m[1] ? parseInt(m[1], 10) : 0;
        if (p >= part) {
          part = p;
          size = f.size;
        }
      }
      return size >= this.activeLogRotateBytes ? part + 1 : part;
    } catch {
      return 0;
    }
  }

  /** Retire the active daily-log part once it reaches the rotation ceiling. */
  private maybeRotate(nowMs: number): void {
    try {
      const rel = this.activeLogRel(nowMs);
      const f = this.deps.fs.list(LOG_DIR).find((x) => x.relPath === rel);
      if (f && f.size >= this.activeLogRotateBytes) {
        // The full part becomes an evictable archive; the next flush appends
        // to a fresh '<date>.<part>.jsonl'.
        this.logPart += 1;
      }
    } catch {
      // ignore — rotation is best-effort
    }
  }

  /**
   * Evict the oldest DAILY-LOG files until under the disk cap. Ride files are
   * NEVER victims — completed rides used to age out of the shared cap within
   * ~20 min of passive logging (~400 KB/min of calibration records), which is
   * how the first two device recordings were lost. Rides are tiny (~1 Hz,
   * ≤90 min) and only clearAll() deletes them; they still count toward the
   * total, so log archives are evicted more eagerly while rides exist. Today's
   * ACTIVE daily-log part is also protected (R9: evicting the live log punched
   * holes into the exported history) — if only protected files remain the cap
   * may be exceeded, bounded by the active part's own rotation ceiling
   * (ACTIVE_LOG_ROTATE_BYTES, see maybeRotate).
   */
  private enforceDirCap(nowMs: number = this.deps.now()): void {
    try {
      const files = [...this.deps.fs.list(LOG_DIR), ...this.deps.fs.list(RIDE_DIR)];
      let total = files.reduce((n, f) => n + f.size, 0);
      if (total <= this.dirCapBytes) return;
      const activeLog = this.activeLogRel(nowMs);
      const victims = files
        .filter((f) => f.relPath.startsWith(`${LOG_DIR}/`) && f.relPath !== activeLog)
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
   * On-disk size of the active ride file, bytes (0 when idle/unlistable) —
   * the RideRecorder's "on disk" live readout.
   */
  rideFileBytes(): number {
    const ride = this.ride;
    if (!ride) return 0;
    return this.safeList(RIDE_DIR).find((f) => f.relPath === ride.relPath)?.size ?? 0;
  }

  /**
   * How the active ride's GPS fixes are delivered: 'background' (recording
   * survives backgrounding), 'foreground' (fallback — dies on suspend), or
   * null while idle / still acquiring the watch (honest UI status).
   */
  rideLocationMode(): LocationWatchMode | null {
    if (!this.ride || !this.rideStop) return null;
    return this.deps.location.mode?.() ?? null;
  }

  /**
   * True while the active ride is also recording high-rate IMU motion
   * (DeviceMotion started successfully); false = GPS-only (honest UI status).
   */
  rideMotionActive(): boolean {
    return this.ride !== null && this.rideMotionStop !== null;
  }

  /**
   * Begin a GPS ride recording for `tramKey`. One at a time. Resolves true when
   * watching started, false if a ride is already active or permission failed.
   * Crash-safety: the ride file + its {type:'ride-start'} header hit the disk
   * BEFORE the (possibly slow) permission/watch acquisition — a process death
   * at any later moment leaves a valid JSONL that orphan recovery closes.
   */
  async startRide(tramKey: string): Promise<boolean> {
    if (this.ride) return false;
    const startedMs = this.deps.now();
    const relPath = `${RIDE_DIR}/${fileStamp(startedMs)}-${sanitizeKey(tramKey)}.jsonl`;
    // Claim the slot before awaiting so concurrent calls can't double-start.
    this.ride = {
      key: tramKey,
      startedMs,
      points: 0,
      relPath,
      lastPointMs: null,
      motionSamples: 0,
      gpsRejects: 0,
    };
    // Fresh per-ride filter/motion state BEFORE any await: background-task
    // location delivery can begin while startRide is still awaiting.
    this.gpsFilter = new GpsFilter();
    this.motionPending = [];
    this.lastMotionFlushMs = startedMs;
    // Deadline is an absolute timestamp (not just a timer): survives JS-timer
    // suspension and is enforced in every location callback.
    this.rideDeadlineMs = startedMs + RIDE_MAX_MS;
    try {
      this.deps.fs.append(relPath, rideStartRecord(tramKey, this.deps.stateProvider(tramKey), startedMs) + '\n');
    } catch {
      // Header is best-effort — point appends may still succeed later.
    }
    this.notify();
    try {
      this.rideStop = await this.deps.location.start((sample) => this.onRideSample(sample));
    } catch {
      this.ride = null;
      this.rideDeadlineMs = null;
      this.rideStop = null;
      this.gpsFilter = null;
      this.motionPending = [];
      try {
        // Nothing was recorded — drop the header-only file instead of leaving
        // a phantom "ride" in the export list.
        this.deps.fs.remove(relPath);
      } catch {
        // ignore
      }
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
    this.notify(); // rideLocationMode is known now
    // High-rate IMU stream — strictly best-effort AFTER GPS is secured: an
    // unavailable sensor / denied motion permission degrades to a GPS-only
    // ride, never a failed one.
    if (this.deps.motion) {
      try {
        const stopMotion = await this.deps.motion.start((m) => this.onMotionSample(m));
        if (this.ride) {
          this.rideMotionStop = stopMotion;
          this.notify(); // rideMotionActive is known now
        } else {
          // The ride stopped while the sensor was starting up.
          try {
            stopMotion();
          } catch {
            // ignore
          }
        }
      } catch {
        this.rideMotionStop = null;
      }
    }
    return true;
  }

  /** Buffer an IMU sample; batch-append at most every MOTION_FLUSH_MS/AT. */
  private onMotionSample(m: MotionSample): void {
    if (!this.ride) return;
    try {
      this.motionPending.push(m);
      const now = this.deps.now();
      if (
        this.motionPending.length >= MOTION_FLUSH_AT ||
        now - this.lastMotionFlushMs >= MOTION_FLUSH_MS
      ) {
        this.flushMotion(now);
      }
    } catch {
      // never throw from a sensor callback
    }
  }

  /**
   * Append the buffered motion samples as one {type:'motion'} batch line.
   * On a write failure the samples are retained for the next attempt (bounded
   * by MOTION_MAX_PENDING). notify() fires only here (≤1 Hz), never per
   * 25 Hz sample — perf invariant #1.
   */
  private flushMotion(nowMs: number): void {
    const ride = this.ride;
    if (!ride || this.motionPending.length === 0) return;
    this.lastMotionFlushMs = nowMs;
    const batch = this.motionPending;
    this.motionPending = [];
    try {
      this.deps.fs.append(ride.relPath, motionRecord(batch) + '\n');
      ride.motionSamples += batch.length;
      this.notify();
    } catch {
      this.motionPending = batch.concat(this.motionPending);
      if (this.motionPending.length > MOTION_MAX_PENDING) {
        this.motionPending.splice(0, this.motionPending.length - MOTION_MAX_PENDING);
      }
    }
  }

  private onRideSample(sample: LocationSample): void {
    const ride = this.ride;
    if (!ride) return;
    // Deadline check on EVERY sample: if the JS auto-stop timer never fired
    // (app suspension), the first delivery past the deadline closes the ride
    // properly (footer + watcher teardown) instead of recording forever.
    const deadline = this.rideDeadlineMs;
    if (deadline != null && this.deps.now() >= deadline) {
      void this.stopRide();
      return;
    }
    try {
      const state = this.deps.stateProvider(ride.key);
      const posMode = this.deps.positionMode?.() ?? null;
      // Ground truth (v3): the rider's GPS projected onto the tram's shape.
      const geom = this.deps.geometry?.(ride.key);
      const gpsProj =
        geom && geom.coordinates.length > 1
          ? projectPointToPolyline([sample.lng, sample.lat], geom.coordinates, geom.cumDistM)
          : null;
      // v4: outlier-filtered position (raw fix is still written verbatim) and
      // ITS shape projection — the preferred fDist/fLagM ground truth.
      const filt =
        this.gpsFilter?.push({
          t: sample.t,
          lat: sample.lat,
          lng: sample.lng,
          accuracy: sample.accuracy,
        }) ?? null;
      if (filt && !filt.accepted) ride.gpsRejects += 1;
      const fProj =
        filt && filt.lat != null && filt.lng != null && geom && geom.coordinates.length > 1
          ? projectPointToPolyline([filt.lng, filt.lat], geom.coordinates, geom.cumDistM)
          : null;
      // Appended to disk IMMEDIATELY (never buffered) — a crash/jetsam loses
      // at most the point being written, not the recording.
      this.deps.fs.append(
        ride.relPath,
        rideRecord(sample, state, posMode, gpsProj, filt, fProj) + '\n',
      );
      ride.points += 1;
      ride.lastPointMs = this.deps.now();
      // Backstop for the motion batch clock: while backgrounded, GPS callbacks
      // are the only reliable ticks — an overdue motion batch flushes here
      // even if the 25 Hz stream has stalled.
      if (this.motionPending.length > 0 && this.deps.now() - this.lastMotionFlushMs >= MOTION_FLUSH_MS) {
        this.flushMotion(this.deps.now());
      }
      // Rides are low-volume; still keep total disk usage bounded (rides are
      // never victims — this evicts log archives to compensate).
      if (ride.points % 30 === 0) this.enforceDirCap();
      this.notify();
    } catch {
      // never throw from a location callback
    }
  }

  /** Stop the active ride; returns the saved file info (null if not riding). */
  async stopRide(): Promise<RideStopResult | null> {
    const ride = this.ride;
    if (!ride) return null;
    // Stop + drain the motion stream while `this.ride` is still set (the tail
    // batch must land BEFORE the footer so the file stays footer-terminated).
    try {
      this.rideMotionStop?.();
    } catch {
      // ignore
    }
    this.rideMotionStop = null;
    this.flushMotion(this.deps.now());
    this.motionPending = [];
    this.gpsFilter = null;
    this.ride = null;
    this.rideDeadlineMs = null;
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
    try {
      this.deps.fs.append(
        ride.relPath,
        JSON.stringify({
          type: 'ride-end',
          t: this.deps.now(),
          points: ride.points,
          // v4: appended after the historic footer fields.
          motionSamples: ride.motionSamples,
          gpsRejects: ride.gpsRejects,
        }) + '\n',
      );
    } catch {
      // best-effort — an unclosed file is orphan-recovered on next launch
    }
    this.flush(this.deps.now());
    this.notify();
    return {
      uri: this.deps.fs.uri(ride.relPath),
      relPath: ride.relPath,
      points: ride.points,
      bytes: this.safeList(RIDE_DIR).find((f) => f.relPath === ride.relPath)?.size ?? 0,
      motionSamples: ride.motionSamples,
      gpsRejects: ride.gpsRejects,
    };
  }

  /**
   * Close ride files left open by a previous process death: any file in
   * rides/ whose last line is not a {type:'ride-end'|'ride-orphaned'} footer
   * gets a {type:'ride-orphaned', t} footer appended. The data recorded up to
   * the death is intact (points are written synchronously) and the file stays
   * listed/exported like any completed ride. Call once at app start (the
   * singleton factory does). Returns the number of files closed; never throws.
   */
  recoverOrphanRides(): number {
    let recovered = 0;
    try {
      for (const f of this.safeList(RIDE_DIR)) {
        if (this.ride && f.relPath === this.ride.relPath) continue; // live ride
        try {
          const text = this.deps.fs.read(f.relPath);
          const lines = text.trimEnd().split('\n');
          const last = lines[lines.length - 1] ?? '';
          let closed = false;
          try {
            closed = isRideFooter(JSON.parse(last));
          } catch {
            // corrupt/half-written tail line — definitely interrupted
          }
          if (!closed) {
            // A file killed mid-append may lack its trailing newline — the
            // footer must start a FRESH line, or it would concatenate onto the
            // torn tail and recovery would re-orphan the file forever.
            const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
            this.deps.fs.append(
              f.relPath,
              sep + JSON.stringify({ type: 'ride-orphaned', t: this.deps.now() }) + '\n',
            );
            recovered += 1;
          }
        } catch {
          // per-file best-effort
        }
      }
    } catch {
      // recovery must never break startup
    }
    if (recovered > 0) this.notify();
    return recovered;
  }

  // — export / stats —

  listLogFiles(): MotionFileInfo[] {
    return this.sorted(this.safeList(LOG_DIR));
  }

  listRideFiles(): MotionFileInfo[] {
    return this.sorted(this.safeList(RIDE_DIR));
  }

  /** Full JSONL text of a ride file ('' when unreadable) — list/preview UI. */
  readRideFile(relPath: string): string {
    try {
      return this.deps.fs.read(relPath);
    } catch {
      return '';
    }
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
    // Everything is gone — restart daily-log rotation from part 0.
    this.logPartDay = '';
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
