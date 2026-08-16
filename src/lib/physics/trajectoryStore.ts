// The whole client physics engine, part 7: the one network call it makes.
//
// ONE bundle for the WHOLE fleet every 5 s (protocol §Wire). Not per tram, not
// on demand — the server publishes the fleet's next ~120 s of motion and the
// client reads it. Between fetches there is zero network and zero simulation:
// the map is drawing arithmetic over Float64Arrays.
//
// Lifecycle (perf invariant #3): start() is called ONLY from TramRuntime's
// resume(), stop() from its halt() — so nothing polls while backgrounded. Every
// fetch captures the generation counter before awaiting and discards its
// response if start/stop cycled meanwhile, so a reply landing after a pause can
// never mutate the store or be mistaken for fresh data on the next resume.

import { parseBundle, type ParsedBundle, type ParsedVehicle } from './bundle';
import { ClockSync } from './clock';
import { connectionState, type ConnectionState } from './connection';

export const TRAJECTORIES_URL = 'https://tram-lab.acex.sh/api/trajectories/v2';
/** Publication cadence of the predictor service; polling faster only re-reads its cache. */
export const TRAJECTORY_POLL_MS = 5_000;

/** Fetch/staleness health for the devtools and the connection banner. */
export interface TrajectoryHealth {
  connection: ConnectionState;
  /** Age of the newest bundle in seconds, or null when none decoded yet. */
  bundleAgeS: number | null;
  /** Smoothed server−device clock offset, ms. */
  clockOffsetMs: number;
  /** True once at least one bundle has been sampled for clock sync. */
  clockSynced: boolean;
  /** True when the offset suggests a badly wrong device clock. */
  clockImplausible: boolean;
  consecutiveFailures: number;
  /** Message of the most recent failure, or null after a success. */
  lastError: string | null;
  /** Vehicles in the newest bundle. */
  vehicleCount: number;
  /** Cumulative server-flagged discontinuities observed since start. */
  discontinuities: number;
  /** Local ms of the last successful decode (0 = never). */
  lastBundleAtMs: number;
  inFlight: boolean;
  /** Active poll cadence, ms (0 = stopped). */
  pollIntervalMs: number;
}

export class TrajectoryStore {
  private timer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private inFlight = false;
  private generation = 0;
  private pollMs = TRAJECTORY_POLL_MS;

  private current: ParsedBundle | null = null;
  private failures = 0;
  private lastError: string | null = null;
  private lastBundleAtMs = 0;
  private discontinuities = 0;
  private listeners = new Set<() => void>();

  readonly clock = new ClockSync();

  constructor(private readonly url: string = TRAJECTORIES_URL) {}

  /** Start polling + fetch immediately. Idempotent. */
  start(pollMs: number = TRAJECTORY_POLL_MS): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.pollMs = pollMs;
    this.abort = new AbortController();
    this.timer = setInterval(() => void this.refresh(), pollMs);
    void this.refresh();
  }

  /**
   * Stop polling and abort the in-flight fetch. The decoded bundle is KEPT:
   * unlike the old engine there is no simulation to drift, so on resume the
   * curves are either still valid (a short backgrounding lands inside the same
   * 120 s horizon and the fleet is instantly correct) or visibly stale, which
   * the connection state reports honestly within one frame.
   */
  stop(): void {
    if (!this.running && this.timer === null) return;
    this.running = false;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    this.inFlight = false;
  }

  /** Notified after each successfully decoded bundle (runtime → UI bump). */
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

  /** Age of the newest bundle in seconds, or null when none decoded. */
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
      discontinuities: this.discontinuities,
      lastBundleAtMs: this.lastBundleAtMs,
      inFlight: this.inFlight,
      pollIntervalMs: this.running ? this.pollMs : 0,
    };
  }

  /**
   * Adopt a decoded response body. Exposed for the fetch path and for tests.
   * Returns false when the payload was unusable — the previous bundle then
   * keeps rendering and simply ages (the connection state tells the truth).
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

  /** One poll cycle. Never throws — an unreachable server means stale data. */
  private async refresh(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const gen = this.generation;
    const signal = this.abort?.signal;
    this.inFlight = true;
    try {
      const response = await fetch(this.url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (gen !== this.generation) return; // stopped / restarted while in flight
      this.ingest(payload, Date.now());
    } catch (error) {
      if (gen !== this.generation) return;
      this.noteFailure(String(error));
      if (__DEV__) console.log(`[physics] trajectory fetch failed: ${String(error)}`);
    } finally {
      if (gen === this.generation) this.inFlight = false;
    }
  }
}
