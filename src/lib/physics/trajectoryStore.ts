// The whole client physics engine, part 7: where the curves come from.
//
// ONE source since the 2026-08-21 promotion: the Convex push stream
// (convex/trajectories.ts, fed by the predictor's publisher). The store seeds
// from `trajectories:fullSet`, folds the diff batches the subscription
// delivers, and takes the publisher's heartbeat via `trajectories:meta` — so
// curves are on this phone the moment they exist, and a quiet fleet still
// reads as alive. The former HTTP polling transport (5 s against a 2 s JSON
// freeze) and the per-generation `?gen=` switcher are GONE: the engine is
// chosen, and every client rides the published chain.
//
// Lifecycle (perf invariant #3): start() is called ONLY from TramRuntime's
// resume(), stop() from its halt() — so nothing runs while backgrounded. The
// generation counter makes late async completions no-ops, exactly as before.
//
// `ingest()` (adopt one decoded HTTP-shaped bundle) remains as the direct
// payload path for tests and tooling — the wire shape of a vehicle is the same
// on both transports, and parseBundle/parseVehicle are the single decoders.

import { parseBundle, parseVehicle, PROTOCOL_VERSION, type ParsedBundle, type ParsedVehicle } from './bundle';
import { ClockSync } from './clock';
import { connectionState, type ConnectionState } from './connection';
import type {
  ConvexTrajectorySource,
  TrajectoryBatchWire,
  TrajectoryMetaWire,
  TrajectorySink,
} from './convexSource';

/** Fetch/staleness health for the devtools and the connection banner. */
export interface TrajectoryHealth {
  connection: ConnectionState;
  /** Age of the newest publication in seconds, or null when none decoded yet. */
  bundleAgeS: number | null;
  /** Smoothed server−device clock offset, ms. */
  clockOffsetMs: number;
  /** True once at least one publication has been sampled for clock sync. */
  clockSynced: boolean;
  /** True when the offset suggests a badly wrong device clock. */
  clockImplausible: boolean;
  consecutiveFailures: number;
  /** Message of the most recent failure, or null after a success. */
  lastError: string | null;
  /** Vehicles currently held. */
  vehicleCount: number;
  /** What produced the newest bundle per its own field ('drive-v3', …). */
  serverGen: string | null;
  /** Highest trajectory diff-stream seq seen (0 = none). */
  lastSeq: number;
  /** Server-flagged discontinuities observed since start. */
  discontinuities: number;
  /** Local ms of the last successful data arrival (0 = never). */
  lastBundleAtMs: number;
}

export class TrajectoryStore implements TrajectorySink {
  private running = false;
  private generation = 0;
  /** Convex push transport, created lazily on the first start. */
  private convexSource: ConvexTrajectorySource | null = null;

  private current: ParsedBundle | null = null;
  private lastSeqSeen = 0;
  private failures = 0;
  private lastError: string | null = null;
  private lastBundleAtMs = 0;
  private discontinuities = 0;
  private listeners = new Set<() => void>();

  readonly clock = new ClockSync();

  /**
   * `options.convex` opts the store into the Convex push transport — set by
   * the app runtime only, so tests and bare environments construct a store
   * that holds data (via `ingest`/the sink methods) without a WebSocket stack.
   */
  constructor(private readonly options: { convex?: boolean } = {}) {}

  /** Start the transport (when opted in). Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    if (this.options.convex === true) this.tryStartConvex();
  }

  /**
   * Stop the transport and abort in-flight work. The decoded bundle is KEPT:
   * there is no simulation to drift, so on resume the curves are either still
   * valid (a short backgrounding lands inside the same 120 s horizon) or
   * visibly stale, which the connection state reports honestly.
   */
  stop(): void {
    if (!this.running && this.convexSource === null) return;
    this.running = false;
    this.generation += 1;
    this.convexSource?.stop();
  }

  private tryStartConvex(): boolean {
    try {
      if (!this.convexSource) {
        // Lazy require: keeps the convex client stack out of the module graph
        // until a real runtime starts (same discipline as constructFeed()).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ConvexTrajectorySource } = require('./convexSource') as typeof import('./convexSource');
        const env = process.env.EXPO_PUBLIC_CONVEX_URL;
        const url =
          typeof env === 'string' && env.length > 0 ? env : 'https://tram-api.acex.sh';
        this.convexSource = new ConvexTrajectorySource(this, { url });
      }
      this.convexSource.start();
      return true;
    } catch (e) {
      this.convexSource = null;
      this.noteFailure(`convex source failed to start: ${String(e)}`);
      return false;
    }
  }

  /** Notified after each successfully adopted publication (runtime → UI bump). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get bundle(): ParsedBundle | null {
    return this.current;
  }

  getVehicle(key: string): ParsedVehicle | undefined {
    return this.current?.vehicles.get(key);
  }

  /** Server-corrected wall clock — the instant ALL evaluation happens at. */
  nowMs(localNowMs: number = Date.now()): number {
    return this.clock.now(localNowMs);
  }

  /** Age of the newest publication in seconds, or null when none decoded. */
  bundleAgeS(localNowMs: number = Date.now()): number | null {
    if (!this.current) return null;
    return (this.clock.now(localNowMs) - this.current.atMs) / 1000;
  }

  connection(localNowMs: number = Date.now()): ConnectionState {
    return connectionState({
      bundleAgeS: this.bundleAgeS(localNowMs),
      consecutiveFailures: this.failures,
    });
  }

  health(localNowMs: number = Date.now()): TrajectoryHealth {
    return {
      connection: this.connection(localNowMs),
      bundleAgeS: this.bundleAgeS(localNowMs),
      clockOffsetMs: this.clock.offsetMs,
      clockSynced: this.clock.synced,
      clockImplausible: this.clock.implausible,
      consecutiveFailures: this.failures,
      lastError: this.lastError,
      vehicleCount: this.current?.vehicles.size ?? 0,
      serverGen: this.current?.generator ?? null,
      lastSeq: this.lastSeqSeen,
      discontinuities: this.discontinuities,
      lastBundleAtMs: this.lastBundleAtMs,
    };
  }

  /**
   * Adopt a decoded HTTP-shaped bundle body. The direct payload path for
   * tests/tooling. Returns false when the payload was unusable — the previous
   * bundle then keeps rendering and simply ages.
   */
  ingest(payload: unknown, receivedAtMs: number = Date.now()): boolean {
    const next = parseBundle(payload, receivedAtMs);
    if (!next) {
      this.noteFailure('malformed bundle');
      return false;
    }
    // Count server-flagged breaks: a vehicle whose NEW emission is flagged.
    const prev = this.current;
    for (const v of next.vehicles.values()) {
      if (!v.discontinuity) continue;
      const before = prev?.vehicles.get(v.key);
      if (!before || before.emittedAtMs !== v.emittedAtMs) this.discontinuities += 1;
    }
    this.current = next;
    this.clock.sample(next.serverNowMs, receivedAtMs);
    this.failures = 0;
    this.lastError = null;
    this.lastBundleAtMs = receivedAtMs;
    this.listeners.forEach((l) => l());
    return true;
  }

  private noteFailure(message: string): void {
    this.failures += 1;
    this.lastError = message;
  }

  // ── TrajectorySink (the Convex push transport feeds the store here) ────────

  /** Adopt a full `trajectories:fullSet` result (seed / reseed). */
  seedConvex(vehiclesRaw: unknown[], meta: TrajectoryMetaWire | null, receivedAtMs: number): void {
    const vehicles = new Map<string, ParsedVehicle>();
    for (const raw of vehiclesRaw) {
      const parsed = parseVehicle(raw);
      if (parsed) vehicles.set(parsed.key, parsed);
    }
    const serverNowMs = meta?.serverNowMs ?? receivedAtMs;
    const prev = this.current;
    for (const v of vehicles.values()) {
      if (!v.discontinuity) continue;
      const before = prev?.vehicles.get(v.key);
      if (!before || before.emittedAtMs !== v.emittedAtMs) this.discontinuities += 1;
    }
    this.current = {
      protocolVersion: PROTOCOL_VERSION,
      serverNowMs,
      atMs: meta?.atMs ?? serverNowMs,
      horizonS: meta?.horizonS ?? 0,
      vehicles,
      generator: meta?.generator ?? null,
      receivedAtMs,
    };
    this.clock.sample(serverNowMs, receivedAtMs);
    this.lastSeqSeen = meta?.lastSeq ?? this.lastSeqSeen;
    this.failures = 0;
    this.lastError = null;
    this.lastBundleAtMs = receivedAtMs;
    this.listeners.forEach((l) => l());
  }

  /** Fold one diff batch into the live bundle (mutates the vehicle map). */
  foldConvex(batch: TrajectoryBatchWire, serverNowMs: number, receivedAtMs: number): void {
    const cur = this.current;
    if (!cur) return; // seed lands first by protocol; a stray push is ignored
    for (const raw of batch.changed) {
      const parsed = parseVehicle(raw);
      if (!parsed) continue;
      const before = cur.vehicles.get(parsed.key);
      if (parsed.discontinuity && (!before || before.emittedAtMs !== parsed.emittedAtMs)) {
        this.discontinuities += 1;
      }
      cur.vehicles.set(parsed.key, parsed);
    }
    if (batch.removed) {
      for (const key of batch.removed) cur.vehicles.delete(key);
    }
    if (batch.atMs > cur.atMs) cur.atMs = batch.atMs;
    if (serverNowMs > cur.serverNowMs) cur.serverNowMs = serverNowMs;
    if (batch.seq > this.lastSeqSeen) this.lastSeqSeen = batch.seq;
    this.clock.sample(serverNowMs, receivedAtMs);
    this.failures = 0;
    this.lastError = null;
    this.lastBundleAtMs = receivedAtMs;
    this.listeners.forEach((l) => l());
  }

  /**
   * Publisher heartbeat: advances bundle age + clock even when no vehicle
   * changed, so a quiet fleet does not decay into a false 'offline' banner.
   * Deliberately does NOT reset the failure counter — a live heartbeat with a
   * failing seed must keep reporting the seed failure.
   */
  noteConvexMeta(meta: TrajectoryMetaWire, receivedAtMs: number): void {
    this.clock.sample(meta.serverNowMs, receivedAtMs);
    if (meta.lastSeq > this.lastSeqSeen) this.lastSeqSeen = meta.lastSeq;
    const cur = this.current;
    if (cur) {
      if (meta.atMs > cur.atMs) cur.atMs = meta.atMs;
      if (meta.serverNowMs > cur.serverNowMs) cur.serverNowMs = meta.serverNowMs;
      cur.generator = meta.generator;
      this.listeners.forEach((l) => l());
    }
  }

  noteConvexFailure(message: string): void {
    this.noteFailure(message);
  }
}
