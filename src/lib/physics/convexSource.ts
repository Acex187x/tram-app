// The whole client physics engine, part 10: the Convex trajectory transport.
//
// Production curves now arrive the same way fixes do — pushed over the Convex
// WebSocket the moment the predictor publishes them (convex/trajectories.ts),
// instead of a 5 s HTTP poll against a 2 s JSON freeze. That closes most of
// the 7–11 s fix-vs-curve freshness race the fix-forward shim exists for: the
// remaining gap is the predictor's own ML round trip (~2–4 s).
//
// Protocol (mirrors src/lib/feed/remoteFeed.ts, the proven diff-stream fold):
//   1. one-shot `trajectories:fullSet` → seed the store, remember `seq`
//   2. subscribe `trajectories:batchesSince({ sinceSeq })` → fold
//      `changed`/`removed`; the result GROWS at the fixed cursor, so
//      re-subscribe at the advanced cursor every few batches
//   3. seq gap (retention outran the cursor) → back to step 1
//   4. subscribe `trajectories:meta` → staleness heartbeat + clock sync + the
//      active generator, refiring every publisher cycle even when no vehicle
//      changed (a quiet night must not read as a dead predictor).
//
// Lifecycle discipline is the store's (generation-guarded start/stop); this
// class owns only the Convex client and its subscriptions.

import { ConvexClient } from 'convex/browser';
import { makeFunctionReference, type FunctionReference } from 'convex/server';

/** Wire meta — matches `metaValidator` in convex/trajectories.ts. */
export interface TrajectoryMetaWire {
  atMs: number;
  horizonS: number;
  generator: string;
  lastSeq: number;
  publishedAtMs: number;
  serverNowMs: number;
}

export interface TrajectorySeedResult {
  vehicles: unknown[];
  meta: TrajectoryMetaWire | null;
  seq: number;
}

export interface TrajectoryBatchWire {
  seq: number;
  atMs: number;
  changed: unknown[];
  removed?: string[];
}

export interface TrajectoryBatchesResult {
  batches: TrajectoryBatchWire[];
  oldestSeq: number | null;
  latestSeq: number | null;
  serverNowMs: number;
}

export const TRAJ_FULL_SET_QUERY = makeFunctionReference<
  'query',
  Record<string, never>,
  TrajectorySeedResult
>('trajectories:fullSet');

export const TRAJ_BATCHES_QUERY = makeFunctionReference<
  'query',
  { sinceSeq: number },
  TrajectoryBatchesResult
>('trajectories:batchesSince');

export const TRAJ_META_QUERY = makeFunctionReference<
  'query',
  Record<string, never>,
  TrajectoryMetaWire | null
>('trajectories:meta');

/** The slice of ConvexClient this source uses (structural, for tests). */
export interface ConvexTrajectoryClient {
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
}

export const TRAJ_CLOCK_QUERY = makeFunctionReference<
  'query',
  { nonce: string },
  { serverNowMs: number }
>('clock:now');

/** What the source needs from TrajectoryStore (implemented there). */
export interface TrajectorySink {
  seedConvex(vehicles: unknown[], meta: TrajectoryMetaWire | null, receivedAtMs: number): void;
  foldConvex(batch: TrajectoryBatchWire, serverNowMs: number, receivedAtMs: number): void;
  noteConvexMeta(meta: TrajectoryMetaWire, receivedAtMs: number): void;
  noteConvexFailure(message: string): void;
  noteConvexClock(serverNowMs: number, sentAtMs: number, receivedAtMs: number): void;
}

/** Batches folded at one cursor before re-subscribing at the advanced cursor. */
export const RESUBSCRIBE_AFTER_BATCHES = 8;

/** Backoff for seed retries, ms (doubling, capped). */
const SEED_RETRY_MIN_MS = 2_000;
const SEED_RETRY_MAX_MS = 30_000;
/** A disconnected Convex query can stay pending indefinitely. Report the
 * initial wait honestly without multiplying pending requests. */
export const SEED_WAIT_TIMEOUT_MS = 15_000;

export interface ConvexTrajectorySourceOptions {
  url: string;
  /** Client factory override (tests). Default: the real ConvexClient. */
  createClient?: (url: string) => ConvexTrajectoryClient;
}

export class ConvexTrajectorySource {
  private readonly createClient: (url: string) => ConvexTrajectoryClient;
  private client: ConvexTrajectoryClient | null = null;
  private unsubscribeBatches: (() => void) | null = null;
  private unsubscribeMeta: (() => void) | null = null;
  private generation = 0;
  private running = false;
  private lastSeq = -1;
  private batchesAtCursor = 0;
  private seedRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private seedRetryMs = SEED_RETRY_MIN_MS;
  private seedWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private clockRequest = 0;
  private subscriptionGeneration = 0;
  private seeding = false;
  private lastPublicationMs = 0;

  constructor(
    private readonly sink: TrajectorySink,
    private readonly options: ConvexTrajectorySourceOptions,
  ) {
    this.createClient = options.createClient ?? ((url) => new ConvexClient(url));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.client = this.createClient(this.options.url);
    this.subscribeMeta();
    void this.sampleClock();
    void this.seed();
  }

  stop(): void {
    if (!this.running && this.client === null) return;
    this.running = false;
    this.generation += 1;
    this.seeding = false;
    if (this.seedWaitTimer) clearTimeout(this.seedWaitTimer);
    this.seedWaitTimer = null;
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = null;
    if (this.seedRetryTimer) {
      clearTimeout(this.seedRetryTimer);
      this.seedRetryTimer = null;
    }
    this.unsubscribeBatches?.();
    this.unsubscribeBatches = null;
    this.unsubscribeMeta?.();
    this.unsubscribeMeta = null;
    const client = this.client;
    this.client = null;
    if (client) void client.close().catch(() => undefined);
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async sampleClock(): Promise<void> {
    const gen = this.generation;
    const client = this.client;
    if (!client) return;
    const sentAtMs = Date.now();
    try {
      const result = await client.query(TRAJ_CLOCK_QUERY, {
        nonce: `${sentAtMs}-${++this.clockRequest}-${Math.random().toString(36).slice(2)}`,
      });
      if (gen !== this.generation) return;
      this.sink.noteConvexClock(result.serverNowMs, sentAtMs, Date.now());
    } catch {
      // Older deployments may not expose clock:now yet. Retain the previous
      // estimate/device time; stale cached metadata is never a fallback clock.
    }
    if (gen === this.generation)
      this.clockTimer = setTimeout(() => {
        this.clockTimer = null;
        void this.sampleClock();
      }, 60_000);
  }

  private async seed(): Promise<void> {
    const gen = this.generation;
    const client = this.client;
    if (!client || this.seeding) return;
    this.seeding = true;
    const waitTimer = setTimeout(() => {
      if (gen === this.generation && this.seeding)
        this.sink.noteConvexFailure('Trajectory seed timed out waiting for the server');
      if (this.seedWaitTimer === waitTimer) this.seedWaitTimer = null;
    }, SEED_WAIT_TIMEOUT_MS);
    this.seedWaitTimer = waitTimer;
    try {
      const result = await client.query(TRAJ_FULL_SET_QUERY, {});
      if (gen !== this.generation) return;
      this.seeding = false;
      this.sink.seedConvex(result.vehicles, result.meta, Date.now());
      this.lastSeq = result.seq;
      this.lastPublicationMs = result.meta?.publishedAtMs ?? 0;
      this.seedRetryMs = SEED_RETRY_MIN_MS;
      this.subscribeBatches();
    } catch (e) {
      if (gen !== this.generation) return;
      this.seeding = false;
      this.sink.noteConvexFailure(e instanceof Error ? e.message : String(e));
      this.scheduleSeedRetry(gen);
    } finally {
      clearTimeout(waitTimer);
      if (this.seedWaitTimer === waitTimer) this.seedWaitTimer = null;
    }
  }

  private scheduleSeedRetry(gen: number): void {
    if (this.seedRetryTimer || gen !== this.generation) return;
    this.seedRetryTimer = setTimeout(() => {
      this.seedRetryTimer = null;
      if (gen === this.generation) void this.seed();
    }, this.seedRetryMs);
    this.seedRetryMs = Math.min(SEED_RETRY_MAX_MS, this.seedRetryMs * 2);
  }

  private subscribeBatches(): void {
    const gen = this.generation;
    const client = this.client;
    if (!client) return;
    this.unsubscribeBatches?.();
    this.batchesAtCursor = 0;
    const subGen = ++this.subscriptionGeneration;
    const sinceSeq = this.lastSeq;
    this.unsubscribeBatches = client.onUpdate(
      TRAJ_BATCHES_QUERY,
      { sinceSeq },
      (result) => {
        if (gen !== this.generation || subGen !== this.subscriptionGeneration) return;
        this.onBatches(result);
      },
      (e) => {
        if (gen !== this.generation || subGen !== this.subscriptionGeneration) return;
        this.sink.noteConvexFailure(e.message);
        // onUpdate query errors can terminate that subscription. A healthy
        // metadata socket is not proof that vehicle diffs are still flowing.
        this.subscriptionGeneration += 1;
        this.unsubscribeBatches?.();
        this.unsubscribeBatches = null;
        this.scheduleSeedRetry(gen);
      },
    );
  }

  private onBatches(result: TrajectoryBatchesResult): void {
    const fresh = result.batches.filter((b) => b.seq > this.lastSeq);
    // Retention outran the cursor: the batches between lastSeq and the oldest
    // surviving row are gone. Reseed from scratch (same rule as RemoteFeed).
    if (
      fresh.length > 0 &&
      fresh[0].seq !== this.lastSeq + 1 &&
      result.oldestSeq !== null &&
      result.oldestSeq > this.lastSeq + 1
    ) {
      this.reseed();
      return;
    }
    const receivedAtMs = Date.now();
    for (const batch of fresh) {
      this.sink.foldConvex(batch, result.serverNowMs, receivedAtMs);
      this.lastSeq = batch.seq;
      this.batchesAtCursor += 1;
    }
    // The subscribed result grows at a fixed cursor; advance it periodically
    // so each push carries only the new batches.
    if (this.batchesAtCursor >= RESUBSCRIBE_AFTER_BATCHES) this.subscribeBatches();
  }

  private reseed(): void {
    this.subscriptionGeneration += 1;
    this.unsubscribeBatches?.();
    this.unsubscribeBatches = null;
    void this.seed();
  }

  private subscribeMeta(): void {
    const gen = this.generation;
    const client = this.client;
    if (!client) return;
    this.unsubscribeMeta = client.onUpdate(
      TRAJ_META_QUERY,
      {},
      (result) => {
        if (gen !== this.generation || result === null) return;
        // A lower head after backend reset cannot be resumed with the old
        // cursor (every new batch would otherwise be filtered out forever).
        if (
          !this.seeding &&
          this.lastSeq >= 0 &&
          result.lastSeq < this.lastSeq &&
          result.publishedAtMs >= this.lastPublicationMs
        )
          this.reseed();
        this.lastPublicationMs = Math.max(this.lastPublicationMs, result.publishedAtMs);
        this.sink.noteConvexMeta(result, Date.now());
      },
      () => {
        // Meta is a convenience heartbeat; batch/seed errors already report.
      },
    );
  }
}
