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

/** What the source needs from TrajectoryStore (implemented there). */
export interface TrajectorySink {
  seedConvex(vehicles: unknown[], meta: TrajectoryMetaWire | null, receivedAtMs: number): void;
  foldConvex(batch: TrajectoryBatchWire, serverNowMs: number, receivedAtMs: number): void;
  noteConvexMeta(meta: TrajectoryMetaWire, receivedAtMs: number): void;
  noteConvexFailure(message: string): void;
}

/** Batches folded at one cursor before re-subscribing at the advanced cursor. */
export const RESUBSCRIBE_AFTER_BATCHES = 8;

/** Backoff for seed retries, ms (doubling, capped). */
const SEED_RETRY_MIN_MS = 2_000;
const SEED_RETRY_MAX_MS = 30_000;

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
    void this.seed();
  }

  stop(): void {
    if (!this.running && this.client === null) return;
    this.running = false;
    this.generation += 1;
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

  private async seed(): Promise<void> {
    const gen = this.generation;
    const client = this.client;
    if (!client) return;
    try {
      const result = await client.query(TRAJ_FULL_SET_QUERY, {});
      if (gen !== this.generation) return;
      this.sink.seedConvex(result.vehicles, result.meta, Date.now());
      this.lastSeq = result.seq;
      this.seedRetryMs = SEED_RETRY_MIN_MS;
      this.subscribeBatches();
    } catch (e) {
      if (gen !== this.generation) return;
      this.sink.noteConvexFailure(e instanceof Error ? e.message : String(e));
      this.seedRetryTimer = setTimeout(() => {
        this.seedRetryTimer = null;
        if (gen === this.generation) void this.seed();
      }, this.seedRetryMs);
      this.seedRetryMs = Math.min(SEED_RETRY_MAX_MS, this.seedRetryMs * 2);
    }
  }

  private subscribeBatches(): void {
    const gen = this.generation;
    const client = this.client;
    if (!client) return;
    this.unsubscribeBatches?.();
    this.batchesAtCursor = 0;
    const sinceSeq = this.lastSeq;
    this.unsubscribeBatches = client.onUpdate(
      TRAJ_BATCHES_QUERY,
      { sinceSeq },
      (result) => {
        if (gen !== this.generation) return;
        this.onBatches(result);
      },
      (e) => {
        if (gen !== this.generation) return;
        this.sink.noteConvexFailure(e.message);
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
        this.sink.noteConvexMeta(result, Date.now());
      },
      () => {
        // Meta is a convenience heartbeat; batch/seed errors already report.
      },
    );
  }
}
