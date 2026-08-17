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

/**
 * Which server-side physics generation publishes the curves we fetch:
 *   'current' — today's shipped bundle. The server default, so NO query param.
 *   'v3'      — the new drive-v3 physics (both tracks regenerated).
 *   'mix'     — fixed(opinion) from v3, smooth from current.
 *
 * The WIRE FORMAT is identical across generations (physics-v3 protocol §Wire),
 * which is the whole point: `parseBundle`, the evaluator and every renderer are
 * untouched by this switch — only the URL changes.
 *
 * Structurally mirrored by `PhysicsEngine` in src/stores/settings.ts; the
 * physics lib deliberately does not import the app's stores (same layering as
 * RenderMode / PositionMode).
 */
export type PhysicsGen = 'current' | 'v3' | 'mix';

/**
 * The bundle URL for one generation. 'current' is the server's default and is
 * sent WITHOUT the param, so a client on the default setting produces byte-for
 * byte the same request it always did (and stays compatible with any server
 * that has never heard of `gen`).
 */
export function trajectoriesUrl(gen: PhysicsGen, base: string = TRAJECTORIES_URL): string {
  return gen === 'current' ? base : `${base}?gen=${gen}`;
}

/**
 * The generation a bundle's `generator` field says it came from.
 *
 * Requesting an unknown generation is deliberately served the PUBLISHED bundle
 * instead of an error, so the request is not evidence of what arrived — this
 * mapping is. A readout comparing this against the requested generation is the
 * only way a silent fallback becomes visible.
 */
export function genFromGenerator(generator: string | null): PhysicsGen {
  if (generator === 'drive-v3') return 'v3';
  if (generator === 'mix') return 'mix';
  return 'current';
}

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
  /** Generation being REQUESTED (mirrors the setting) — not proof of arrival. */
  gen: PhysicsGen;
  /**
   * The newest bundle's own `generator` field: what the server says it served,
   * or null when there is no bundle or the field is absent (= published). Read
   * THIS for the active generation; `gen` above is only the ask.
   */
  serverGen: string | null;
  /** Server-flagged discontinuities observed since start or the last gen swap. */
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
  /** Server physics generation requested by the settings store (see setGen). */
  private gen: PhysicsGen = 'current';

  private current: ParsedBundle | null = null;
  private failures = 0;
  private lastError: string | null = null;
  private lastBundleAtMs = 0;
  private discontinuities = 0;
  private listeners = new Set<() => void>();

  readonly clock = new ClockSync();

  /** `url` is the BASE endpoint; the active generation is appended per fetch. */
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

  /** Server physics generation currently being fetched. */
  get generationId(): PhysicsGen {
    return this.gen;
  }

  /**
   * Switch server physics generation (settings → runtime → here). No-op when
   * unchanged, so the runtime can call it on every settings write.
   *
   * A swap is a HARD cut, not a cross-fade, and that is deliberate:
   *
   * - The in-flight reply belongs to the OLD engine. It is aborted and its
   *   generation counter bumped so it cannot land (same guard start/stop uses).
   * - The decoded bundle is DROPPED. Unlike a background pause — where keeping
   *   the curves is right because they are still the same server's opinion —
   *   curves from the engine the user just left are not the answer to the
   *   question now being asked, and continuing to animate them would be a
   *   frozen ghost of the previous physics. With no bundle every tram falls
   *   back to its raw AVL fix (adapter.ts), so the fleet stays on screen,
   *   stationary and honest, for the ~1 fetch it takes the new gen to land.
   * - The connection machine is left to tell the truth on its own: bundleAgeS
   *   is null again with zero failures, which is exactly its documented cold
   *   start — 'degraded' ("connecting…"), NOT a false 'offline' banner. It
   *   returns to 'live' on the first bundle of the new generation.
   *
   * The clock samples are DROPPED too. Not because the server's wall clock
   * moved — it did not — but because each generation's bundle cache freezes
   * independently, so their `serverNowMs` stamps can sit up to ~2 s apart. The
   * offset is an EWMA over the last three fetches, and letting it span the
   * swap would average two generations' stamps into a clock that matches
   * neither for the next few polls. Re-seeding costs nothing: the refetch
   * below re-syncs from the new generation's own stamp before there is any
   * bundle to evaluate.
   */
  setGen(gen: PhysicsGen): void {
    if (gen === this.gen) return;
    this.gen = gen;
    this.generation += 1;
    this.abort?.abort();
    this.abort = this.running ? new AbortController() : null;
    this.inFlight = false;
    this.current = null;
    this.lastBundleAtMs = 0;
    this.failures = 0;
    this.lastError = null;
    this.discontinuities = 0;
    this.clock.reset();
    this.listeners.forEach((l) => l());
    if (this.running) void this.refresh();
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
      gen: this.gen,
      serverGen: this.current?.generator ?? null,
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
      const response = await fetch(trajectoriesUrl(this.gen, this.url), { signal });
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
