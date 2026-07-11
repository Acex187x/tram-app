// LocalGolemioFeed — the TramFeed implementation that runs "the backend" on
// the client. Behavior is EXACTLY what TramRuntime used to do inline:
//   • the 5 s Golemio poll loop (fetchTramSnapshots + abort/generation guards),
//   • geometry via the on-device shapeCache (+ scheduler tag promotion),
//   • calibration records handed to the MotionLog storage (lazily required —
//     the module may be absent, and logging must never break the poll loop).
// A future RemoteFeed replaces this class 1:1 (see docs/decisions/backend-plan.md);
// nothing above the TramFeed interface may depend on how batches are produced.

import { promoteTag } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { fetchTramSnapshots } from '@/lib/golemio/vehicles';
import type { TramSnapshot, RouteGeometry } from '@/lib/types';
import type { CalibrationRecord, FeedPriority, FeedStatus, TramFeed } from './types';

export const POLL_MS = 5_000;

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

export interface LocalGolemioFeedOptions {
  /** Calibration storage override (tests). Default: the MotionLog module. */
  calibrationSink?: (records: CalibrationRecord[]) => void;
}

export class LocalGolemioFeed implements TramFeed {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private pollAbort: AbortController | null = null;
  /**
   * Bumped on every stop(). An in-flight poll captures the generation at start
   * and no-ops if it changed — stale completions can't emit after teardown.
   */
  private generation = 0;
  private listeners = new Set<SnapshotListener>();
  private lastBatchAtMs = 0;
  private lastError: string | null = null;
  private readonly calibrationSink: (records: CalibrationRecord[]) => void;

  constructor(options?: LocalGolemioFeedOptions) {
    this.calibrationSink = options?.calibrationSink ?? storeCalibrationInMotionLog;
  }

  /** Start the poll loop + an immediate poll. Idempotent. */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  /** Halt the loop, abort the in-flight poll, invalidate late completions. */
  stop(): void {
    this.generation += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.pollInFlight = false;
  }

  subscribeSnapshots(cb: SnapshotListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getGeometry(tripId: string): RouteGeometry | undefined {
    return shapeCache.getLoaded(tripId);
  }

  requestGeometry(tripIds: string[], priority: FeedPriority): void {
    shapeCache.requestPrefetch(tripIds, priority);
  }

  /**
   * Raise fetch priority for a tapped/followed tram's geometry. First try to
   * promote an already-queued waiter (the common cold-cache case: the citywide
   * poll enqueued this trip at background priority and it is stuck behind the
   * 16-starts/8s queue). If nothing is queued yet, issue it at urgent priority.
   */
  promoteGeometry(tripId: string): void {
    if (!tripId || shapeCache.has(tripId)) return;
    if (!promoteTag(tripId, 0)) shapeCache.requestPrefetch([tripId], 0);
  }

  reportCalibration(records: CalibrationRecord[]): void {
    try {
      this.calibrationSink(records);
    } catch {
      // Telemetry must never throw into the ingest path.
    }
  }

  status(): FeedStatus {
    return { lastBatchAtMs: this.lastBatchAtMs, lastError: this.lastError };
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    const gen = this.generation;
    const abort = new AbortController();
    this.pollAbort = abort;
    try {
      const snapshots = await fetchTramSnapshots({ signal: abort.signal });
      if (gen !== this.generation) return; // stopped mid-flight
      const now = Date.now();
      this.lastBatchAtMs = now;
      this.lastError = null;
      // Subscriber errors surface as a feed error (matches the historic inline
      // poll, where an ingest throw landed in the poll's catch).
      this.listeners.forEach((l) => l(snapshots, now));
    } catch (e) {
      if (gen !== this.generation) return; // aborted by stop(): swallow
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      // Only the still-current generation may clear the in-flight flag / abort
      // handle; a stale completion must not disturb a freshly restarted poll.
      if (gen === this.generation) this.pollInFlight = false;
      if (this.pollAbort === abort) this.pollAbort = null;
    }
  }
}
