// The whole client physics engine, part 3: clock sync.
//
// WHY THIS EXISTS (protocol goal #3, determinism across users): the curves are
// stamped in SERVER wall-clock time. A device whose clock is 8 s fast would
// evaluate 8 s further along every curve and render the whole fleet ~80 m
// ahead of everyone else's. Correcting `Date.now()` by a measured offset makes
// two phones — different clocks, different join times, one backgrounded for an
// hour — render pixel-identical trams from the same bundle.
//
// offset = serverNowMs − Date.now() sampled at each fetch, smoothed by an
// EWMA over the last few fetches so one scheduler hiccup (a fetch decoded
// 300 ms late behind a busy JS thread) cannot jolt the fleet. The residual
// bias is one-way network latency (`serverNowMs` is stamped before the
// response travels), i.e. tens of ms ≈ centimetres of tram — far below the
// error the offset removes.

/** Samples retained by the EWMA (the protocol's "last 3 fetches"). */
export const CLOCK_WINDOW = 3;

/**
 * Per-sample decay: sample ages 0,1,2 get weights 1, 0.5, 0.25 — the newest
 * fetch dominates while two older ones damp a single bad sample.
 */
export const CLOCK_DECAY = 0.5;

/**
 * Offsets beyond this are still applied (a genuinely wrong device clock can be
 * hours off) but are reported as `implausible` so devtools can say so out loud
 * rather than leaving an operator to wonder why the fleet looks shifted.
 */
export const CLOCK_IMPLAUSIBLE_MS = 60 * 60 * 1000;

/**
 * Rolling clock-offset estimator. Stateless with respect to RENDERING — it
 * only supplies the time at which the pure evaluator is sampled.
 */
export class ClockSync {
  /** Most recent samples, newest last; at most CLOCK_WINDOW entries. */
  private samples: number[] = [];
  private cached = 0;

  /** Record one fetch: the server's stamp and the local clock at receive. */
  sample(serverNowMs: number, receivedAtMs: number): void {
    if (!Number.isFinite(serverNowMs) || !Number.isFinite(receivedAtMs)) return;
    this.samples.push(serverNowMs - receivedAtMs);
    if (this.samples.length > CLOCK_WINDOW) this.samples.shift();
    this.cached = weightedOffset(this.samples);
  }

  /** Drop all samples (feed restart / teardown) — next fetch re-seeds. */
  reset(): void {
    this.samples = [];
    this.cached = 0;
  }

  /** True once at least one fetch has been sampled. */
  get synced(): boolean {
    return this.samples.length > 0;
  }

  /** Current smoothed offset, ms (0 before the first sample). */
  get offsetMs(): number {
    return this.cached;
  }

  /** True when the offset is large enough to suspect a wrong device clock. */
  get implausible(): boolean {
    return this.samples.length > 0 && Math.abs(this.cached) > CLOCK_IMPLAUSIBLE_MS;
  }

  /**
   * Server-corrected wall clock — the ONLY time any trajectory is evaluated
   * at. `localNowMs` is injectable for tests; production passes Date.now().
   */
  now(localNowMs: number): number {
    return localNowMs + this.cached;
  }
}

/**
 * EWMA over a bounded sample window (newest last). Exported pure so the
 * weighting is directly testable without driving a fetch loop.
 */
export function weightedOffset(samples: readonly number[]): number {
  const n = samples.length;
  if (n === 0) return 0;
  let acc = 0;
  let wsum = 0;
  let w = 1;
  for (let i = n - 1; i >= 0; i--) {
    acc += samples[i] * w;
    wsum += w;
    w *= CLOCK_DECAY;
  }
  return acc / wsum;
}
