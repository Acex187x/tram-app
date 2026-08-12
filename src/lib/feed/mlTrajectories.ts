// Experimental 'ml' position mode — the lab's opinion, rendered raw.
//
// The research lab (lab/, tram-lab.acex.sh) runs its own 24/7 predictor and
// publishes, per vehicle, a short series of ABSOLUTE-time keyframes
// (t = wall-clock ms, s = meters along the trip shape). This store keeps the
// latest published set and answers one question: "where does the lab think
// tram K is at nowMs?" — by piecewise-LINEAR interpolation between the two
// bracketing keyframes, clamped to the first/last point outside the range.
//
// DELIBERATELY DUMB (that IS the experiment): no smoothing, no fades, no
// physics, no teleport thresholds. Everything clever lives server-side. If a
// key is unknown or its trip changed under us, this returns null and the
// caller falls back to the raw fix — a tram is never hidden over a missing
// trajectory.
//
// Lifecycle mirrors LocalGolemioFeed's: start()/stop() are called ONLY by
// TramRuntime — start on resume while positionMode === 'ml', stop on pause, on
// leaving the mode, and on teardown. So there is ZERO network in the other
// three modes and while backgrounded (perf invariant #3), and the generation
// guard drops in-flight responses that land after a stop.

export const ML_TRAJECTORIES_URL = 'https://tram-lab.acex.sh/api/trajectories';
/** Publication cadence of the lab feed; polling faster only re-reads its cache. */
export const ML_POLL_MS = 5_000;

/** One keyframe: absolute wall time → distance along the trip shape, meters. */
export interface MlTrajectoryPoint {
  t: number;
  s: number;
}

/** The stored form of one vehicle's published trajectory. */
export interface MlTrajectory {
  /** Trip the keyframes were computed for — a trip change invalidates them. */
  tripId: string;
  /** Ascending in `t`; ~13 points spanning ~120 s (lab/src/config.ts). */
  points: MlTrajectoryPoint[];
}

export class MlTrajectoryStore {
  private timer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private inFlight = false;
  /**
   * Bumped on every start()/stop(). A fetch captures it before awaiting and
   * discards its response if it changed — a reply landing after a pause must
   * never mutate the store (and must never be mistaken for fresh data on the
   * next resume).
   */
  private generation = 0;
  private byKey = new Map<string, MlTrajectory>();

  constructor(private readonly url: string = ML_TRAJECTORIES_URL) {}

  /** Start polling + fetch immediately. Idempotent. */
  start(pollMs: number = ML_POLL_MS): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.abort = new AbortController();
    this.timer = setInterval(() => void this.refresh(), pollMs);
    void this.refresh();
  }

  /** Stop polling, abort the in-flight fetch, and drop the published set. */
  stop(): void {
    if (!this.running && this.timer === null) return;
    this.running = false;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    // Held keyframes go stale within their 120 s horizon, and re-entering the
    // mode refetches at once — keeping them would render a minutes-old opinion
    // for one frame after resume.
    this.byKey.clear();
  }

  /** Number of vehicles in the current published set (diagnostics/tests). */
  get size(): number {
    return this.byKey.size;
  }

  /**
   * Lab-predicted distance along the shape for `key` at `nowMs`, or null when
   * the vehicle is absent from the published set or its trip changed since the
   * trajectory was computed (caller falls back to the raw fix).
   *
   * Piecewise-linear between bracketing keyframes; clamped to the first/last
   * point outside the published range. Allocation-free — this runs per visible
   * tram per pushed frame (perf invariant #8).
   */
  evalDistM(key: string, tripId: string, nowMs: number): number | null {
    const entry = this.byKey.get(key);
    if (!entry || entry.tripId !== tripId) return null;
    const points = entry.points;
    const n = points.length;
    if (n === 0) return null;
    if (nowMs <= points[0].t) return points[0].s;
    const last = points[n - 1];
    if (nowMs >= last.t) return last.s;
    for (let i = 1; i < n; i++) {
      const b = points[i];
      if (nowMs > b.t) continue;
      const a = points[i - 1];
      const span = b.t - a.t;
      if (span <= 0) return b.s; // duplicate/non-ascending stamps: take the later one
      return a.s + ((b.s - a.s) * (nowMs - a.t)) / span;
    }
    return last.s;
  }

  /**
   * Replace the published set from a decoded response body. Exposed for the
   * fetch path and for tests; malformed payloads are ignored wholesale (the
   * previous set keeps rendering rather than the fleet snapping to raw fixes).
   */
  ingest(payload: unknown): void {
    const vehicles = (payload as { vehicles?: unknown } | null)?.vehicles;
    if (!Array.isArray(vehicles)) return;
    const next = new Map<string, MlTrajectory>();
    for (const raw of vehicles) {
      const vehicle = raw as { key?: unknown; tripId?: unknown; points?: unknown };
      if (typeof vehicle?.key !== 'string' || typeof vehicle.tripId !== 'string') continue;
      if (!Array.isArray(vehicle.points)) continue;
      const points: MlTrajectoryPoint[] = [];
      for (const p of vehicle.points) {
        const { t, s } = (p ?? {}) as { t?: unknown; s?: unknown };
        if (typeof t === 'number' && typeof s === 'number' && Number.isFinite(t) && Number.isFinite(s)) {
          points.push({ t, s });
        }
      }
      if (points.length > 0) next.set(vehicle.key, { tripId: vehicle.tripId, points });
    }
    this.byKey = next;
  }

  /** One poll cycle. Never throws — an unreachable lab just means null reads. */
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
      this.ingest(payload);
    } catch (error) {
      if (__DEV__ && gen === this.generation) {
        console.log(`[ml-trajectories] fetch failed: ${String(error)}`);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

let store: MlTrajectoryStore | null = null;

/** The app-wide store singleton (created lazily; owned by TramRuntime). */
export function getMlTrajectories(): MlTrajectoryStore {
  if (!store) store = new MlTrajectoryStore();
  return store;
}

/**
 * Stable module-level resolver handed to the render/cull call sites. Defined
 * once so the per-frame path passes a reference instead of allocating a fresh
 * closure on every push (perf invariant #8).
 */
export function mlDistM(key: string, tripId: string, nowMs: number): number | null {
  return getMlTrajectories().evalDistM(key, tripId, nowMs);
}
