// RemoteFeed — the TramFeed implementation backed by the Convex backend
// (docs/decisions/backend-convex.md §3). The server polls Golemio every ~2 s
// with a key that never ships in the bundle; this client subscribes to the
// diff stream over Convex's WebSocket and reconstructs the fleet locally:
//
//   start()  → one-shot `stream:fullFleet`   → seed the fleet map → emit
//            → subscribe `stream:batchesSince(lastSeq)`
//   update   → fold `changed`/`removed` rows → EMIT THE MERGED FULL ARRAY
//   seq gap  → the diff stream outran its retention → re-seed from fullFleet
//   stop()   → unsubscribe + close + generation bump: no late callbacks
//
// The merged-full-array rule is the runtime contract, not an implementation
// detail: TramRuntime replaces its snapshot list wholesale on every batch, so
// passing a diff through would silently shrink the fleet (recon §6 / §1).
//
// Phase 1 scope: vehicle streaming only. Geometry still resolves client-side
// through the existing Golemio shape cache — exactly as the deleted
// on-client feed did
// — because Convex geometry serving is rollout step 4 (design §7). Likewise
// calibration records keep going to the local motion log; server-side folding
// is fed by the poller's own AVL stream and needs nothing from the client.
//
// NOT wired in yet: nothing constructs this class. `feedSource` selection in
// the runtime is a separate change (design §7 step 1).

import { ConvexClient } from 'convex/browser';
import { makeFunctionReference, type FunctionReference } from 'convex/server';

import { promoteTag } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import type { CalibrationRecord, FeedPriority, FeedStatus, TramFeed } from './types';

/** Server poll cadence assumed when `pollerState` has not reported one yet. */
export const SERVER_POLL_MS = 2_000;
/** Base/ceiling of the seed (fullFleet) retry backoff — mirrors the local feed. */
export const SEED_RETRY_BASE_MS = 2_000;
export const SEED_RETRY_MAX_MS = 60_000;
/**
 * `batchesSince(seq)` is a *growing* query result: it re-runs on every server
 * batch and returns everything after the seq it was subscribed at. Re-subscribe
 * once the window reaches this many rows so the pushed payload stays small.
 * Re-subscription is loss-free — the cursor is a seq, not a timestamp.
 */
export const RESUBSCRIBE_AFTER_BATCHES = 8;
/**
 * Safety net for a fleet map that drifted (a missed removal, a server restart):
 * re-seed from fullFleet at least this often. One extra query per 5 min.
 */
export const RESEED_INTERVAL_MS = 300_000;
/** Server poller heartbeat older than this reads as "the feed is degraded". */
export const SERVER_STALE_MS = 120_000;

// ————————————————————————————————————————————————————————————————
// Wire contract (convex/stream.ts implements these; see design §1 "Tables").
// ————————————————————————————————————————————————————————————————

/** `pollerState` mirrored to clients: server-side feed health (design §3). */
export interface PollerHealth {
  /** Wall-clock ms of the server's last completed Golemio poll (0 = never). */
  lastPollAtMs: number;
  /** Server poll cadence in ms, if it reports one. */
  pollIntervalMs?: number;
  /** The server's Golemio credential is rejected (401/403). */
  authFailed?: boolean;
  /** Consecutive failed server polls. */
  consecutiveFailures?: number;
  /** Most recent server-side poll error. */
  lastError?: string | null;
  /** Cumulative validation drops (same taxonomy as the client normalizer). */
  rejectedTotal?: number;
  rejectedByReason?: Record<string, number>;
}

/** `stream:fullFleet` — the whole current fleet plus the seq it is current at. */
export interface FullFleetResult {
  /** Latest batch seq reflected by `vehicles` (the resume cursor). */
  seq: number;
  /** Server wall-clock ms when the snapshot was taken. */
  atMs: number;
  vehicles: TramSnapshot[];
  poller?: PollerHealth | null;
}

/** One server poll that changed something (design §1: the `batches` table). */
export interface StreamBatch {
  seq: number;
  atMs: number;
  changed: TramSnapshot[];
  /** Vehicle keys dropped server-side (unseen > STALE_AFTER_MS). */
  removed?: string[];
}

/** `stream:batchesSince` — the diff window after the subscribed seq. */
export interface BatchesSinceResult {
  batches: StreamBatch[];
  /** Oldest seq still retained; > our cursor + 1 means we were outrun. */
  oldestSeq: number;
  latestSeq: number;
  poller?: PollerHealth | null;
}

export const FULL_FLEET_QUERY = makeFunctionReference<
  'query',
  Record<string, never>,
  FullFleetResult
>('stream:fullFleet');

export const BATCHES_SINCE_QUERY = makeFunctionReference<
  'query',
  { sinceSeq: number },
  BatchesSinceResult
>('stream:batchesSince');

/**
 * The slice of `ConvexClient` (convex/browser — the non-React client) this feed
 * uses. Declared structurally so tests can inject a fake without a WebSocket.
 */
export interface ConvexStreamClient {
  query<Q extends FunctionReference<'query'>>(
    query: Q,
    args: Q['_args'],
  ): Promise<Awaited<Q['_returnType']>>;
  onUpdate<Q extends FunctionReference<'query'>>(
    query: Q,
    args: Q['_args'],
    callback: (result: Q['_returnType']) => unknown,
    onError?: (e: Error) => unknown,
  ): () => void;
  close(): Promise<void>;
  /** Optional: drives `status().inFlight` (true while the WS is reconnecting). */
  connectionState?(): { isWebSocketConnected: boolean };
}

type SnapshotListener = (snapshots: TramSnapshot[], atMs: number) => void;

// ————————————————————————————————————————————————————————————————
// Calibration sink — the same lazy-require discipline the on-client feed used:
// feed stays importable without the store/motionlog stack, and telemetry
// failures never reach the ingest path.
// ————————————————————————————————————————————————————————————————

/** Contract with src/lib/motionlog (may be absent until integration). */
interface MotionLogModule {
  getMotionLog(): { onCalibration(records: readonly CalibrationRecord[]): void };
}

let motionLogModule: MotionLogModule | null | undefined;

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
 * Passive-logging gate: the "Passive fleet logging" settings toggle, required
 * lazily so the pure feed stays importable without the store stack; failure
 * means "on" (single-user calibration phase — logging is the deliberate default).
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface RemoteFeedOptions {
  /** Convex deployment URL, e.g. https://happy-otter-123.convex.cloud. */
  url: string;
  /** Client factory override (tests). Default: the real ConvexClient. */
  createClient?: (url: string) => ConvexStreamClient;
  /** Calibration storage override (tests). Default: the MotionLog module. */
  calibrationSink?: (records: CalibrationRecord[]) => void;
  /** Passive-logging gate override (tests). Default: the settings toggle. */
  passiveLoggingEnabled?: () => boolean;
}

export class RemoteFeed implements TramFeed {
  private readonly url: string;
  private readonly createClient: (url: string) => ConvexStreamClient;
  private readonly calibrationSink: (records: CalibrationRecord[]) => void;
  private readonly passiveLoggingEnabled: () => boolean;

  private client: ConvexStreamClient | null = null;
  private unsubscribeBatches: (() => void) | null = null;
  private running = false;
  /**
   * Bumped on every start()/stop(). Every async continuation (seed query,
   * subscription callback, retry/throttle timer) captures it and no-ops on a
   * mismatch — the standard generation-guard discipline for a poll loop.
   */
  private generation = 0;
  /** Session lifecycle for geometry prefetches: aborted + dropped on stop(). */
  private sessionAbort: AbortController | null = null;

  /** The reconstructed fleet, keyed by TramSnapshot.key. */
  private fleet = new Map<string, TramSnapshot>();
  /** Resume cursor: the highest folded batch seq (-1 = not seeded yet). */
  private lastSeq = -1;
  private lastSeedAtMs = 0;
  private poller: PollerHealth | null = null;

  private listeners = new Set<SnapshotListener>();
  private lastBatchAtMs = 0;
  private lastError: string | null = null;
  private lastFetchAtMs = 0;
  private nextFetchAtMs = 0;
  private seedInFlight = false;
  private consecutiveFailures = 0;
  private seedRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Requested delivery throttle (start(pollMs)). 0 = deliver every server push
   * — the point of the backend. The runtime's rideBackground mode asks for
   * 10 s, which here throttles emission rather than slowing the server.
   */
  private throttleMs = 0;
  private lastDeliverAtMs = 0;
  private deliverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemoteFeedOptions) {
    this.url = options.url;
    this.createClient = options.createClient ?? ((url) => new ConvexClient(url));
    this.calibrationSink = options.calibrationSink ?? storeCalibrationInMotionLog;
    this.passiveLoggingEnabled = options.passiveLoggingEnabled ?? settingsPassiveLoggingEnabled;
  }

  // — lifecycle —

  /**
   * Connect, seed from fullFleet, then stream diffs. Idempotent (a second
   * start() while running is a no-op). Every start
   * is a fresh session: new client, new abort controller, empty fleet.
   */
  start(pollMs?: number): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.sessionAbort = new AbortController();
    this.throttleMs = pollMs != null && pollMs > 0 ? pollMs : 0;
    this.fleet.clear();
    this.lastSeq = -1;
    this.lastSeedAtMs = 0;
    this.lastDeliverAtMs = 0;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.poller = null;
    this.client = this.createClient(this.url);
    void this.seed(this.generation);
  }

  /**
   * Tear the session down completely: unsubscribe, close the socket, cancel
   * timers, abort queued geometry prefetches (they leave the scheduler queue
   * without spending a rate-limit slot). The generation bump guarantees no
   * snapshot callback fires afterwards.
   */
  stop(): void {
    this.generation += 1;
    this.running = false;
    this.teardownSubscription();
    if (this.seedRetryTimer) clearTimeout(this.seedRetryTimer);
    this.seedRetryTimer = null;
    if (this.deliverTimer) clearTimeout(this.deliverTimer);
    this.deliverTimer = null;
    this.sessionAbort?.abort();
    this.sessionAbort = null;
    const client = this.client;
    this.client = null;
    try {
      void client?.close();
    } catch {
      // A close failure must not propagate into teardown.
    }
    this.seedInFlight = false;
    this.consecutiveFailures = 0;
    this.poller = null;
  }

  subscribeSnapshots(cb: SnapshotListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // — geometry: phase 1 delegates to the client-side Golemio shape cache —

  getGeometry(tripId: string): RouteGeometry | undefined {
    return shapeCache.getLoaded(tripId);
  }

  subscribeGeometry(cb: () => void): () => void {
    return shapeCache.subscribeLoaded(cb);
  }

  requestGeometry(tripIds: string[], priority: FeedPriority): void {
    shapeCache.requestPrefetch(tripIds, priority, this.sessionAbort?.signal);
  }

  promoteGeometry(tripId: string): void {
    // A pack-seeded (provisional) trip already renders, but its stop TIMELINE
    // is withheld until the authoritative per-trip geometry lands. Tapping the
    // tram is exactly the "user poke" the urgent lane exists for, so treat
    // provisional as not-yet-resolved here and let it jump the background queue.
    if (!tripId || (shapeCache.has(tripId) && !shapeCache.isProvisional(tripId))) return;
    if (!promoteTag(tripId, 0)) {
      shapeCache.requestPrefetch([tripId], 0, this.sessionAbort?.signal);
    }
  }

  // — calibration —

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

  // — health —

  status(): FeedStatus {
    const running = this.running;
    const cadence = this.cadenceMs();
    return {
      lastBatchAtMs: this.lastBatchAtMs,
      lastError: this.effectiveError(),
      lastFetchAtMs: this.lastFetchAtMs,
      nextFetchAtMs: running ? this.nextFetchAtMs : 0,
      inFlight: this.seedInFlight || this.socketDown(),
      pollIntervalMs: running ? cadence : 0,
      authFailed: this.poller?.authFailed === true,
      consecutiveFailures: this.consecutiveFailures || this.poller?.consecutiveFailures || 0,
      rejectedTotal: this.poller?.rejectedTotal ?? 0,
      rejectedByReason: { ...(this.poller?.rejectedByReason ?? {}) },
    };
  }

  /** Delivery cadence: the requested throttle, else the server's poll cadence. */
  private cadenceMs(): number {
    if (this.throttleMs > 0) return this.throttleMs;
    const server = this.poller?.pollIntervalMs;
    return server != null && server > 0 ? server : SERVER_POLL_MS;
  }

  /** True while the WS is down but the feed is running (a fetch is "pending"). */
  private socketDown(): boolean {
    if (!this.running || !this.client?.connectionState) return false;
    try {
      return !this.client.connectionState().isWebSocketConnected;
    } catch {
      return false;
    }
  }

  /**
   * Client-side error first; otherwise surface the SERVER's feed health — a
   * capability the local feed never had: the app can say "the upstream feed is
   * degraded" even though this client is perfectly connected (design §3).
   */
  private effectiveError(): string | null {
    if (this.lastError) return this.lastError;
    const p = this.poller;
    if (!p) return null;
    if (p.lastError) return `server: ${p.lastError}`;
    if (p.authFailed) return 'server: Golemio auth failed';
    if (p.lastPollAtMs > 0 && Date.now() - p.lastPollAtMs > SERVER_STALE_MS) {
      return 'server: feed stale';
    }
    return null;
  }

  // — streaming —

  /** One-shot fullFleet: seed the fleet map, emit it, then stream the diffs. */
  private async seed(gen: number): Promise<void> {
    const client = this.client;
    if (!client || gen !== this.generation) return;
    this.seedInFlight = true;
    const startedAt = Date.now();
    this.lastFetchAtMs = startedAt;
    this.nextFetchAtMs = startedAt + this.cadenceMs();
    try {
      const result = await client.query(FULL_FLEET_QUERY, {});
      if (gen !== this.generation) return; // stopped mid-flight
      this.fleet.clear();
      for (const vehicle of result?.vehicles ?? []) {
        if (vehicle?.key) this.fleet.set(vehicle.key, vehicle);
      }
      this.lastSeq = Number.isFinite(result?.seq) ? result.seq : 0;
      this.lastSeedAtMs = Date.now();
      if (result?.poller) this.poller = result.poller;
      this.consecutiveFailures = 0;
      this.deliver(Date.now());
      this.subscribeBatches(gen);
    } catch (e) {
      if (gen !== this.generation) return; // torn down: swallow
      this.lastError = errorMessage(e);
      this.consecutiveFailures += 1;
      this.scheduleSeedRetry(gen);
    } finally {
      // Only the still-current generation may clear the flag — a stale
      // completion must not disturb a freshly restarted session.
      if (gen === this.generation) this.seedInFlight = false;
    }
  }

  /** Exponential backoff with mild jitter — same shape as the local feed's. */
  private scheduleSeedRetry(gen: number): void {
    const backoff = Math.min(
      SEED_RETRY_BASE_MS * 2 ** (this.consecutiveFailures - 1),
      SEED_RETRY_MAX_MS,
    );
    const delay = backoff * (0.85 + Math.random() * 0.3);
    this.nextFetchAtMs = Date.now() + delay;
    if (this.seedRetryTimer) clearTimeout(this.seedRetryTimer);
    this.seedRetryTimer = setTimeout(() => {
      this.seedRetryTimer = null;
      if (gen !== this.generation || !this.running) return;
      void this.seed(gen);
    }, delay);
  }

  private subscribeBatches(gen: number): void {
    const client = this.client;
    if (!client || gen !== this.generation || !this.running) return;
    this.teardownSubscription();
    const sinceSeq = this.lastSeq;
    this.unsubscribeBatches = client.onUpdate(
      BATCHES_SINCE_QUERY,
      { sinceSeq },
      (result) => this.onBatches(gen, result),
      (e) => this.onSubscriptionError(gen, e),
    );
  }

  private teardownSubscription(): void {
    const unsubscribe = this.unsubscribeBatches;
    this.unsubscribeBatches = null;
    try {
      unsubscribe?.();
    } catch {
      // Unsubscribing must never throw into teardown.
    }
  }

  /**
   * Fold a diff window into the fleet map and emit the MERGED FULL ARRAY. Rows
   * at or below the cursor are ignored (a re-subscription re-delivers the
   * overlap), and a cursor the retention window has outrun forces a re-seed.
   */
  private onBatches(gen: number, result: BatchesSinceResult | null | undefined): void {
    if (gen !== this.generation || !this.running) return;
    if (result?.poller) this.poller = result.poller;
    const batches = Array.isArray(result?.batches) ? result.batches : [];
    this.lastFetchAtMs = Date.now();

    // Seq gap: the diff stream dropped rows we never saw, so the merged fleet
    // would be wrong from here on. Re-seed instead of guessing.
    const oldest = batches.length > 0 ? batches[0]?.seq : result?.oldestSeq;
    if (this.lastSeq >= 0 && typeof oldest === 'number' && oldest > this.lastSeq + 1) {
      this.reseed(gen);
      return;
    }

    let folded = 0;
    let lastBatchServerAtMs = 0;
    for (const batch of batches) {
      if (!batch || !(batch.seq > this.lastSeq)) continue;
      for (const vehicle of batch.changed ?? []) {
        if (vehicle?.key) this.fleet.set(vehicle.key, vehicle);
      }
      for (const key of batch.removed ?? []) this.fleet.delete(key);
      this.lastSeq = batch.seq;
      if (typeof batch.atMs === 'number') lastBatchServerAtMs = batch.atMs;
      folded += 1;
    }
    if (folded === 0) return; // re-run with nothing new (e.g. our re-subscribe)

    // The server's `batchesSince` deliberately omits poller health (it would
    // wake every subscriber on each 2 s heartbeat write) — but a folded batch
    // IS heartbeat evidence: the server ingested a poll at `atMs`. Without this
    // the health snapshot from the seed ages past SERVER_STALE_MS and every
    // client falsely reports "server: feed stale" between re-seeds. An update
    // that DOES carry poller health (already folded above) wins as-is.
    if (
      !result?.poller &&
      this.poller &&
      lastBatchServerAtMs > this.poller.lastPollAtMs
    ) {
      // A published batch is only ever written by a SUCCESSFUL applyPoll, which
      // also clears the failure fields server-side — mirror that, or a
      // transient error captured at seed time sticks until the next re-seed.
      this.poller = {
        ...this.poller,
        lastPollAtMs: lastBatchServerAtMs,
        lastError: null,
        authFailed: false,
        consecutiveFailures: 0,
      };
    }

    this.consecutiveFailures = 0;
    this.scheduleDeliver(gen);

    // Drift guard + payload guard, in that order: a periodic re-seed also
    // re-subscribes at the fresh cursor, so it subsumes the window trim.
    if (this.lastSeedAtMs > 0 && Date.now() - this.lastSeedAtMs >= RESEED_INTERVAL_MS) {
      this.reseed(gen);
    } else if (batches.length >= RESUBSCRIBE_AFTER_BATCHES) {
      this.subscribeBatches(gen);
    }
  }

  /** Transport/query errors: recorded, not fatal — Convex reconnects itself. */
  private onSubscriptionError(gen: number, e: Error): void {
    if (gen !== this.generation || !this.running) return;
    this.lastError = errorMessage(e);
    this.consecutiveFailures += 1;
  }

  private reseed(gen: number): void {
    if (gen !== this.generation || !this.running) return;
    this.teardownSubscription();
    void this.seed(gen);
  }

  /**
   * Deliver now, or coalesce into one trailing delivery when the runtime asked
   * for a slower cadence (rideBackground). Folding always happens immediately —
   * only the emit is throttled, so a delayed batch is never a stale one.
   */
  private scheduleDeliver(gen: number): void {
    const now = Date.now();
    if (this.throttleMs <= 0) {
      this.deliver(now);
      return;
    }
    const dueAtMs = this.lastDeliverAtMs + this.throttleMs;
    if (now >= dueAtMs) {
      this.deliver(now);
      return;
    }
    if (this.deliverTimer) return; // a trailing delivery is already armed
    this.deliverTimer = setTimeout(() => {
      this.deliverTimer = null;
      if (gen !== this.generation || !this.running) return;
      this.deliver(Date.now());
    }, dueAtMs - now);
  }

  /** Emit the merged full fleet with the delivery wall-clock (never fix time). */
  private deliver(atMs: number): void {
    if (!this.running) return;
    this.lastDeliverAtMs = atMs;
    this.lastBatchAtMs = atMs;
    this.lastError = null;
    this.nextFetchAtMs = atMs + this.cadenceMs();
    const snapshots = Array.from(this.fleet.values());
    try {
      this.listeners.forEach((l) => l(snapshots, atMs));
    } catch (e) {
      // A subscriber throw surfaces as a feed error (the on-client feed
      // semantics) instead of escaping into Convex's callback dispatch.
      this.lastError = errorMessage(e);
    }
  }
}
