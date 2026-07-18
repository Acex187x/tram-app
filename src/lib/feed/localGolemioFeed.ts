// LocalGolemioFeed — the TramFeed implementation that runs "the backend" on
// the client. Behavior is what TramRuntime used to do inline, hardened per the
// 2026-07 review:
//   • the 5 s Golemio poll loop (fetchTramSnapshots + abort/generation guards),
//   • a SESSION AbortController per start(): stop() aborts the in-flight poll
//     AND every geometry prefetch this session issued (queued scheduler
//     waiters leave the queue immediately — no wasted quota after background),
//   • 401/403 auth policy: polling halts and probes once a minute instead of
//     hammering a dead credential every 5 s (status().authFailed drives the
//     indicator),
//   • other failures back off exponentially (offline never causes a storm),
//   • per-reason validation drop counters surface through status(),
//   • calibration records are handed to the MotionLog storage only while the
//     "Passive fleet logging" setting is on (single-user calibration phase:
//     default ON); ride recording is independent of this gate.
// A future RemoteFeed replaces this class 1:1 (see docs/decisions/backend-plan.md);
// nothing above the TramFeed interface may depend on how batches are produced.

import { GolemioHttpError, promoteTag } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import {
  fetchTramSnapshots,
  type SnapshotRejectReason,
  type TramSnapshotBatch,
} from '@/lib/golemio/vehicles';
import type { TramSnapshot, RouteGeometry } from '@/lib/types';
import type { CalibrationRecord, FeedPriority, FeedStatus, TramFeed } from './types';

export const POLL_MS = 5_000;
/** While the key is rejected (401/403), probe this rarely instead of polling. */
export const AUTH_RETRY_MS = 60_000;
/** Ceiling for the consecutive-failure poll backoff. */
export const FAILURE_BACKOFF_MAX_MS = 60_000;

type SnapshotListener = (snapshots: TramSnapshot[], atMs: number) => void;

/** Contract with src/lib/motionlog (may be absent until integration). */
interface MotionLogModule {
  getMotionLog(): { onCalibration(records: readonly CalibrationRecord[]): void };
}

let motionLogModule: MotionLogModule | null | undefined;

/**
 * Default calibration storage: the MotionLog daily JSONL (moved verbatim from
 * TramRuntime.notifyMotionLog). Defensive by contract — the module may not
 * exist, and a logging failure must never disturb the feed.
 */
function storeCalibrationInMotionLog(records: CalibrationRecord[]): void {
  if (motionLogModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      motionLogModule = require('@/lib/motionlog') as MotionLogModule;
    } catch {
      motionLogModule = null;
    }
  }
  if (!motionLogModule?.getMotionLog) return;
  try {
    motionLogModule.getMotionLog().onCalibration(records);
  } catch {
    // Storage errors must never disturb the feed.
  }
}

/**
 * Default passive-logging gate: the "Passive fleet logging" settings toggle.
 * Lazily required so the pure feed stays importable without the store stack;
 * failure means "on" — the app is in its single-user calibration phase and
 * logging is the deliberate default.
 */
function settingsPassiveLoggingEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useSettingsStore } = require('@/stores/settings') as typeof import('@/stores/settings');
    return useSettingsStore.getState().passiveFleetLogging;
  } catch {
    return true;
  }
}

export interface LocalGolemioFeedOptions {
  /** Calibration storage override (tests). Default: the MotionLog module. */
  calibrationSink?: (records: CalibrationRecord[]) => void;
  /** Passive-logging gate override (tests). Default: the settings toggle. */
  passiveLoggingEnabled?: () => boolean;
}

export class LocalGolemioFeed implements TramFeed {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  /** Session lifecycle: created on start(), aborted + dropped on stop(). Aborts
   * the in-flight poll and every geometry prefetch issued this session. */
  private sessionAbort: AbortController | null = null;
  private running = false;
  /**
   * Bumped on every start()/stop(). An in-flight poll captures the generation
   * at start and no-ops if it changed — stale completions can't emit after
   * teardown or into a fresh session.
   */
  private generation = 0;
  private listeners = new Set<SnapshotListener>();
  private lastBatchAtMs = 0;
  private lastError: string | null = null;
  /** Poll-cycle bookkeeping for status(): the chrome's fetch indicator. */
  private pollMs = POLL_MS;
  private lastFetchAtMs = 0;
  private nextFetchAtMs = 0;
  // — failure policy state —
  private authFailed = false;
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  /** Poll ticks are skipped until this wall-clock ms (failure backoff). */
  private backoffUntilMs = 0;
  // — validation drop counters (cumulative for the feed's lifetime) —
  private rejectedTotal = 0;
  private rejectedByReason: Partial<Record<SnapshotRejectReason, number>> = {};

  private readonly calibrationSink: (records: CalibrationRecord[]) => void;
  private readonly passiveLoggingEnabled: () => boolean;

  constructor(options?: LocalGolemioFeedOptions) {
    this.calibrationSink = options?.calibrationSink ?? storeCalibrationInMotionLog;
    this.passiveLoggingEnabled =
      options?.passiveLoggingEnabled ?? settingsPassiveLoggingEnabled;
  }

  /** Start the poll loop + an immediate poll. Idempotent. New session every time. */
  start(pollMs: number = POLL_MS): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.sessionAbort = new AbortController();
    this.pollMs = pollMs;
    this.authFailed = false;
    this.consecutiveFailures = 0;
    this.backoffUntilMs = 0;
    this.pollTimer = setInterval(() => void this.poll(), pollMs);
    void this.poll();
  }

  /**
   * Halt the loop and CANCEL all of this session's outstanding work: the
   * in-flight poll, queued/in-flight geometry prefetches (scheduler waiters
   * leave the queue immediately) and any pending auth probe. The generation
   * bump invalidates late completions.
   */
  stop(): void {
    this.generation += 1;
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer);
    this.authRetryTimer = null;
    this.sessionAbort?.abort();
    this.sessionAbort = null;
    this.pollInFlight = false;
    this.authFailed = false;
    this.consecutiveFailures = 0;
    this.backoffUntilMs = 0;
  }

  subscribeSnapshots(cb: SnapshotListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getGeometry(tripId: string): RouteGeometry | undefined {
    return shapeCache.getLoaded(tripId);
  }

  /** Geometry-landed events (optional TramFeed capability): the shape cache
   *  announces every trip geometry that becomes resolvable via getGeometry. */
  subscribeGeometry(cb: () => void): () => void {
    return shapeCache.subscribeLoaded(cb);
  }

  requestGeometry(tripIds: string[], priority: FeedPriority): void {
    shapeCache.requestPrefetch(tripIds, priority, this.sessionAbort?.signal);
  }

  /**
   * Raise fetch priority for a tapped/followed tram's geometry. First try to
   * promote an already-queued waiter (the common cold-cache case: the citywide
   * poll enqueued this trip at background priority and it is stuck behind the
   * 16-starts/8s queue). If nothing is queued yet, issue it at urgent priority.
   */
  promoteGeometry(tripId: string): void {
    if (!tripId || shapeCache.has(tripId)) return;
    if (!promoteTag(tripId, 0)) {
      shapeCache.requestPrefetch([tripId], 0, this.sessionAbort?.signal);
    }
  }

  reportCalibration(records: CalibrationRecord[]): void {
    try {
      // Passive fleet logging is user-switchable (Settings → Motion data).
      // Off = records are neither buffered nor written; ride recording is a
      // separate stream and is NOT affected by this gate.
      if (!this.passiveLoggingEnabled()) return;
      this.calibrationSink(records);
    } catch {
      // Telemetry must never throw into the ingest path.
    }
  }

  status(): FeedStatus {
    const running = this.running;
    return {
      lastBatchAtMs: this.lastBatchAtMs,
      lastError: this.lastError,
      lastFetchAtMs: this.lastFetchAtMs,
      nextFetchAtMs: running ? this.nextFetchAtMs : 0,
      inFlight: this.pollInFlight,
      pollIntervalMs: running ? this.pollMs : 0,
      authFailed: this.authFailed,
      consecutiveFailures: this.consecutiveFailures,
      rejectedTotal: this.rejectedTotal,
      rejectedByReason: { ...this.rejectedByReason } as Record<string, number>,
    };
  }

  private accumulateRejections(batch: TramSnapshotBatch): void {
    if (batch.rejectedTotal <= 0) return;
    this.rejectedTotal += batch.rejectedTotal;
    for (const [reason, count] of Object.entries(batch.rejected)) {
      if (!count) continue;
      const key = reason as SnapshotRejectReason;
      this.rejectedByReason[key] = (this.rejectedByReason[key] ?? 0) + count;
    }
  }

  /** 401/403: the key is rejected — stop the 5 s loop, probe once a minute. */
  private enterAuthFailure(): void {
    this.authFailed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer);
    this.authRetryTimer = setTimeout(() => {
      this.authRetryTimer = null;
      void this.poll();
    }, AUTH_RETRY_MS);
    this.nextFetchAtMs = Date.now() + AUTH_RETRY_MS;
  }

  /** A poll succeeded while in auth-failure mode: resume the normal cadence. */
  private recoverFromAuthFailure(): void {
    this.authFailed = false;
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer);
    this.authRetryTimer = null;
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
    }
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    // Failure backoff: skip due ticks until the backoff window elapses, so a
    // dead network/upstream is probed progressively slower, not every 5 s.
    if (Date.now() < this.backoffUntilMs) return;
    this.pollInFlight = true;
    // Cycle bookkeeping for the chrome's fetch indicator (status()). The
    // interval is anchored at start(), so "now + pollMs" tracks the real next
    // tick to within timer jitter — plenty for a 1 Hz UI ring.
    this.lastFetchAtMs = Date.now();
    this.nextFetchAtMs = this.lastFetchAtMs + this.pollMs;
    const gen = this.generation;
    const signal = this.sessionAbort?.signal;
    try {
      // retries: 0 — the poll loop is its own retry mechanism; client-level
      // retries would overlap the next tick and double-spend rate quota.
      const batch = await fetchTramSnapshots({ signal, retries: 0 });
      if (gen !== this.generation) return; // stopped mid-flight
      const now = Date.now();
      this.lastBatchAtMs = now;
      this.lastError = null;
      this.consecutiveFailures = 0;
      this.backoffUntilMs = 0;
      if (this.authFailed) this.recoverFromAuthFailure();
      this.accumulateRejections(batch);
      // Subscriber errors surface as a feed error (matches the historic inline
      // poll, where an ingest throw landed in the poll's catch).
      this.listeners.forEach((l) => l(batch.snapshots, now));
    } catch (e) {
      if (gen !== this.generation) return; // aborted by stop(): swallow
      this.lastError = e instanceof Error ? e.message : String(e);
      if (e instanceof GolemioHttpError && (e.status === 401 || e.status === 403)) {
        this.enterAuthFailure();
      } else if (this.authFailed) {
        // Still in auth-failure mode and the probe failed for another reason
        // (e.g. offline): keep probing at the slow cadence — the normal
        // interval is stopped, so the probe must reschedule itself.
        this.enterAuthFailure();
      } else {
        this.consecutiveFailures += 1;
        // Exponential backoff with mild jitter, floored by Retry-After.
        const backoff = Math.min(
          this.pollMs * 2 ** (this.consecutiveFailures - 1),
          FAILURE_BACKOFF_MAX_MS,
        );
        const jittered = backoff * (0.85 + Math.random() * 0.3);
        const retryAfter =
          e instanceof GolemioHttpError && e.retryAfterMs != null ? e.retryAfterMs : 0;
        this.backoffUntilMs = Date.now() + Math.max(jittered, retryAfter);
        this.nextFetchAtMs = this.backoffUntilMs;
      }
    } finally {
      // Only the still-current generation may clear the in-flight flag; a
      // stale completion must not disturb a freshly restarted poll.
      if (gen === this.generation) this.pollInFlight = false;
    }
  }
}
