/// <reference types="jest" />
//
// LocalGolemioFeed: the client-side TramFeed implementation. Locks the poll
// loop semantics moved verbatim out of TramRuntime — 5 s cadence with an
// immediate first poll, single-flight (no overlapping polls), abort +
// generation guards on stop() (a late completion neither emits nor mutates
// status), error/health reporting, shapeCache/scheduler delegation, and the
// calibration sink hand-off — plus the 2026-07 hardening: session-level abort
// (stop() cancels geometry prefetches too), the 401 slow-probe policy,
// consecutive-failure backoff, validation drop counters, and the passive
// fleet-logging gate.

import {
  AUTH_RETRY_MS,
  LocalGolemioFeed,
  POLL_MS,
} from '@/lib/feed/localGolemioFeed';
import type { CalibrationRecord } from '@/lib/feed/types';
import { GolemioHttpError, promoteTag } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import {
  fetchTramSnapshots,
  type SnapshotRejectReason,
  type TramSnapshotBatch,
} from '@/lib/golemio/vehicles';
import type { TramSnapshot } from '@/lib/types';
import { makeSnapshot } from './helpers';

jest.mock('@/lib/golemio/vehicles', () => ({
  fetchTramSnapshots: jest.fn(),
}));
jest.mock('@/lib/golemio/shapeCache', () => ({
  getLoaded: jest.fn(),
  requestPrefetch: jest.fn(),
  has: jest.fn(() => false),
}));
jest.mock('@/lib/golemio/client', () => {
  const actual = jest.requireActual('@/lib/golemio/client');
  return {
    promoteTag: jest.fn(() => false),
    GolemioHttpError: actual.GolemioHttpError,
  };
});

const fetchMock = fetchTramSnapshots as jest.MockedFunction<typeof fetchTramSnapshots>;
const promoteTagMock = promoteTag as jest.MockedFunction<typeof promoteTag>;
const hasMock = shapeCache.has as jest.MockedFunction<typeof shapeCache.has>;
const prefetchMock = shapeCache.requestPrefetch as jest.MockedFunction<
  typeof shapeCache.requestPrefetch
>;

const T0 = 1_000_000_000_000;

// The failure backoff jitters by ×(0.85 + random·0.3). Pin random to 0.5 so
// the multiplier is exactly 1.0 and backoff windows land exactly on poll
// ticks — otherwise every exact-tick assertion below is a coin flip.
beforeEach(() => {
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  (Math.random as unknown as jest.Mock).mockRestore();
});

/** Build a TramSnapshotBatch the way the hardened vehicles module does. */
function batch(
  snapshots: TramSnapshot[] = [],
  rejected: Partial<Record<SnapshotRejectReason, number>> = {},
): TramSnapshotBatch {
  const full: Record<SnapshotRejectReason, number> = {
    'missing-core': 0,
    'bad-coordinates': 0,
    'bad-distance': 0,
    'missing-timestamp': 0,
    ...rejected,
  };
  return {
    snapshots,
    rejected: full,
    rejectedTotal: Object.values(full).reduce((a, b) => a + b, 0),
  };
}

/** Drain pending microtasks under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('LocalGolemioFeed poll loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    jest.clearAllMocks();
    hasMock.mockReturnValue(false);
    promoteTagMock.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls immediately on start() and emits the batch with its wall-clock time', async () => {
    const snapshots = [makeSnapshot()];
    fetchMock.mockResolvedValueOnce(batch(snapshots));
    const feed = new LocalGolemioFeed();
    const batches: { snapshots: TramSnapshot[]; atMs: number }[] = [];
    feed.subscribeSnapshots((s, atMs) => batches.push({ snapshots: s, atMs }));

    feed.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush();

    expect(batches).toEqual([{ snapshots, atMs: T0 }]);
    expect(feed.status()).toEqual({
      lastBatchAtMs: T0,
      lastError: null,
      lastFetchAtMs: T0,
      nextFetchAtMs: T0 + POLL_MS,
      inFlight: false,
      pollIntervalMs: POLL_MS,
      authFailed: false,
      consecutiveFailures: 0,
      rejectedTotal: 0,
      rejectedByReason: {},
    });
    feed.stop();
  });

  it('the poll requests no client-level retries (the loop is the retry mechanism)', async () => {
    fetchMock.mockResolvedValueOnce(batch());
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ retries: 0, signal: expect.any(AbortSignal) }),
    );
    feed.stop();
  });

  it('start() is idempotent and the loop re-polls every POLL_MS', async () => {
    fetchMock.mockResolvedValue(batch());
    const feed = new LocalGolemioFeed();
    feed.start();
    feed.start(); // no second immediate poll, no second interval
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    feed.stop();
  });

  it('never overlaps polls: a due tick is skipped while one is in flight', async () => {
    const d = deferred<TramSnapshotBatch>();
    fetchMock.mockImplementationOnce(() => d.promise);
    fetchMock.mockResolvedValue(batch());
    const feed = new LocalGolemioFeed();
    feed.start();
    await jest.advanceTimersByTimeAsync(POLL_MS); // first poll still pending
    expect(fetchMock).toHaveBeenCalledTimes(1);

    d.resolve(batch());
    await flush();
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    feed.stop();
  });

  it('a failed poll sets lastError; the next success clears it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    fetchMock.mockResolvedValueOnce(batch());
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(feed.status().lastError).toBe('boom');
    expect(feed.status().lastBatchAtMs).toBe(0);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(feed.status()).toMatchObject({ lastBatchAtMs: T0 + POLL_MS, lastError: null });
    feed.stop();
  });

  it('a subscriber throw surfaces as a feed error (historic inline-poll semantics)', async () => {
    fetchMock.mockResolvedValueOnce(batch([makeSnapshot()]));
    const feed = new LocalGolemioFeed();
    feed.subscribeSnapshots(() => {
      throw new Error('ingest exploded');
    });
    feed.start();
    await flush();
    expect(feed.status().lastError).toBe('ingest exploded');
    feed.stop();
  });

  it('stop() aborts the in-flight poll and a late completion neither emits nor mutates status', async () => {
    const d = deferred<TramSnapshotBatch>();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((opts) => {
      signal = opts?.signal;
      return d.promise;
    });
    const feed = new LocalGolemioFeed();
    const batches: TramSnapshot[][] = [];
    feed.subscribeSnapshots((s) => batches.push(s));
    feed.start();
    expect(signal?.aborted).toBe(false);

    feed.stop();
    expect(signal?.aborted).toBe(true);

    // Late resolve after stop(): generation guard swallows it.
    d.resolve(batch([makeSnapshot()]));
    await flush();
    expect(batches).toHaveLength(0);
    expect(feed.status()).toMatchObject({
      lastBatchAtMs: 0,
      lastError: null,
      // Stopped: no next fetch is projected and no poll is in flight.
      nextFetchAtMs: 0,
      inFlight: false,
      pollIntervalMs: 0,
    });
  });

  it('a late REJECTION after stop() is swallowed too (no stale lastError)', async () => {
    const d = deferred<TramSnapshotBatch>();
    fetchMock.mockImplementationOnce(() => d.promise);
    const feed = new LocalGolemioFeed();
    feed.start();
    feed.stop();
    d.reject(new Error('aborted'));
    await flush();
    expect(feed.status().lastError).toBeNull();
  });

  it('status() exposes the poll cycle: inFlight during a fetch, next-fetch projection, cadence override', async () => {
    const d = deferred<TramSnapshotBatch>();
    fetchMock.mockImplementationOnce(() => d.promise);
    fetchMock.mockResolvedValue(batch());
    const feed = new LocalGolemioFeed();

    // Before start(): everything zero/off.
    expect(feed.status()).toMatchObject({
      lastFetchAtMs: 0,
      nextFetchAtMs: 0,
      inFlight: false,
      pollIntervalMs: 0,
    });

    feed.start(10_000); // cadence override (rideBackground path)
    expect(feed.status()).toMatchObject({
      lastFetchAtMs: T0,
      nextFetchAtMs: T0 + 10_000,
      inFlight: true,
      pollIntervalMs: 10_000,
    });

    d.resolve(batch());
    await flush();
    expect(feed.status().inFlight).toBe(false);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(feed.status()).toMatchObject({
      lastFetchAtMs: T0 + 10_000,
      nextFetchAtMs: T0 + 20_000,
    });
    feed.stop();
    expect(feed.status()).toMatchObject({ nextFetchAtMs: 0, pollIntervalMs: 0 });
  });

  it('unsubscribe stops delivery', async () => {
    fetchMock.mockResolvedValue(batch());
    const feed = new LocalGolemioFeed();
    const cb = jest.fn();
    const unsub = feed.subscribeSnapshots(cb);
    unsub();
    feed.start();
    await flush();
    expect(cb).not.toHaveBeenCalled();
    feed.stop();
  });
});

describe('LocalGolemioFeed auth-failure policy (401/403)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('401 halts the 5 s loop and probes once per AUTH_RETRY_MS instead', async () => {
    fetchMock.mockRejectedValue(new GolemioHttpError(401));
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(feed.status().authFailed).toBe(true);
    expect(feed.status().lastError).toContain('401');
    expect(feed.status().nextFetchAtMs).toBe(T0 + AUTH_RETRY_MS);

    // The normal cadence is dead: several POLL_MS ticks fire nothing.
    await jest.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The slow probe fires at AUTH_RETRY_MS — and re-arms while still 401.
    await jest.advanceTimersByTimeAsync(AUTH_RETRY_MS - POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush();
    expect(feed.status().authFailed).toBe(true);
    await jest.advanceTimersByTimeAsync(AUTH_RETRY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    feed.stop();
  });

  it('a successful probe recovers: authFailed clears and the 5 s loop resumes', async () => {
    fetchMock.mockRejectedValueOnce(new GolemioHttpError(401));
    fetchMock.mockResolvedValue(batch());
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(feed.status().authFailed).toBe(true);

    await jest.advanceTimersByTimeAsync(AUTH_RETRY_MS);
    await flush();
    expect(feed.status().authFailed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Normal cadence again.
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    feed.stop();
  });

  it('a probe failing for a NON-auth reason keeps probing slowly (no dead feed)', async () => {
    fetchMock.mockRejectedValueOnce(new GolemioHttpError(401));
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fetchMock.mockResolvedValue(batch());
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();

    await jest.advanceTimersByTimeAsync(AUTH_RETRY_MS); // probe → offline
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(feed.status().authFailed).toBe(true);

    await jest.advanceTimersByTimeAsync(AUTH_RETRY_MS); // next probe → success
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(feed.status().authFailed).toBe(false);
    feed.stop();
  });

  it('stop() during auth-failure cancels the pending probe', async () => {
    fetchMock.mockRejectedValue(new GolemioHttpError(403));
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(feed.status().authFailed).toBe(true);
    feed.stop();
    await jest.advanceTimersByTimeAsync(AUTH_RETRY_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(feed.status().authFailed).toBe(false);
  });
});

describe('LocalGolemioFeed failure backoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    jest.clearAllMocks();
    // Deterministic jitter: 0.85 + 0.5 * 0.3 = 1.0 → backoff = pollMs * 2^(n-1).
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.useRealTimers();
    (Math.random as jest.Mock).mockRestore?.();
  });

  it('consecutive failures back off exponentially instead of hammering every tick', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush(); // failure #1 at T0 → next attempt allowed at T0+5s
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(feed.status().consecutiveFailures).toBe(1);

    await jest.advanceTimersByTimeAsync(POLL_MS); // T0+5s → attempt #2
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(feed.status().consecutiveFailures).toBe(2);

    // Backoff is now 10 s: the tick at T0+10s is skipped, T0+15s runs.
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(feed.status().consecutiveFailures).toBe(3);

    // Backoff 20 s: ticks at +5/+10/+15 skipped, +20 runs.
    await jest.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    feed.stop();
  });

  it('a success resets the backoff and failure counter', async () => {
    fetchMock.mockRejectedValueOnce(new Error('blip'));
    fetchMock.mockResolvedValue(batch());
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(feed.status().consecutiveFailures).toBe(1);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(feed.status().consecutiveFailures).toBe(0);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3); // normal cadence
    feed.stop();
  });

  it('honors a server Retry-After larger than the computed backoff', async () => {
    fetchMock.mockRejectedValue(new GolemioHttpError(429, undefined, 30_000));
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush(); // failure #1: backoff would be 5 s, Retry-After says 30 s
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(feed.status().nextFetchAtMs).toBe(T0 + 30_000);

    await jest.advanceTimersByTimeAsync(POLL_MS * 5); // T0+25s: all skipped
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(POLL_MS); // T0+30s
    expect(fetchMock).toHaveBeenCalledTimes(2);
    feed.stop();
  });
});

describe('LocalGolemioFeed validation drop counters', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('accumulates per-reason rejection counts across batches in status()', async () => {
    fetchMock.mockResolvedValueOnce(batch([], { 'bad-distance': 2, 'missing-timestamp': 1 }));
    fetchMock.mockResolvedValueOnce(batch([], { 'bad-distance': 1, 'bad-coordinates': 4 }));
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(feed.status().rejectedTotal).toBe(3);
    expect(feed.status().rejectedByReason).toEqual({
      'bad-distance': 2,
      'missing-timestamp': 1,
    });

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(feed.status().rejectedTotal).toBe(8);
    expect(feed.status().rejectedByReason).toEqual({
      'bad-distance': 3,
      'missing-timestamp': 1,
      'bad-coordinates': 4,
    });
    feed.stop();
  });
});

describe('LocalGolemioFeed session abort (geometry prefetch lifecycle)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    jest.clearAllMocks();
    hasMock.mockReturnValue(false);
    promoteTagMock.mockReturnValue(false);
    fetchMock.mockResolvedValue(batch());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('requestGeometry hands the session signal to the prefetch; stop() aborts it', () => {
    const feed = new LocalGolemioFeed();
    feed.start();
    feed.requestGeometry(['a', 'b'], 2);
    expect(prefetchMock).toHaveBeenCalledWith(['a', 'b'], 2, expect.any(AbortSignal));
    const signal = prefetchMock.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    feed.stop();
    expect(signal.aborted).toBe(true);
  });

  it('promoteGeometry fallback prefetch is bound to the session signal too', () => {
    const feed = new LocalGolemioFeed();
    feed.start();
    feed.promoteGeometry('cold-trip');
    expect(prefetchMock).toHaveBeenCalledWith(['cold-trip'], 0, expect.any(AbortSignal));
    const signal = prefetchMock.mock.calls[0][2] as AbortSignal;
    feed.stop();
    expect(signal.aborted).toBe(true);
  });

  it('a new start() is a fresh session: its signal is not the aborted one', () => {
    const feed = new LocalGolemioFeed();
    feed.start();
    feed.requestGeometry(['a'], 2);
    const first = prefetchMock.mock.calls[0][2] as AbortSignal;
    feed.stop();
    expect(first.aborted).toBe(true);

    feed.start();
    feed.requestGeometry(['b'], 2);
    const second = prefetchMock.mock.calls[1][2] as AbortSignal;
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
    feed.stop();
  });
});

describe('LocalGolemioFeed geometry + calibration delegation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hasMock.mockReturnValue(false);
    promoteTagMock.mockReturnValue(false);
  });

  it('getGeometry reads the shape cache synchronously', () => {
    const feed = new LocalGolemioFeed();
    feed.getGeometry('trip-1');
    expect(shapeCache.getLoaded).toHaveBeenCalledWith('trip-1');
  });

  it('requestGeometry forwards the batch + priority to requestPrefetch', () => {
    const feed = new LocalGolemioFeed();
    feed.requestGeometry(['a', 'b'], 2);
    expect(shapeCache.requestPrefetch).toHaveBeenCalledWith(['a', 'b'], 2, undefined);
  });

  it('promoteGeometry: no-op when cached; promoteTag first; urgent prefetch as fallback', () => {
    const feed = new LocalGolemioFeed();

    hasMock.mockReturnValueOnce(true);
    feed.promoteGeometry('cached-trip');
    expect(promoteTagMock).not.toHaveBeenCalled();
    expect(shapeCache.requestPrefetch).not.toHaveBeenCalled();

    // A queued waiter exists → promoted in place, no re-issue.
    promoteTagMock.mockReturnValueOnce(true);
    feed.promoteGeometry('queued-trip');
    expect(promoteTagMock).toHaveBeenCalledWith('queued-trip', 0);
    expect(shapeCache.requestPrefetch).not.toHaveBeenCalled();

    // Nothing queued → issue at urgent priority.
    feed.promoteGeometry('cold-trip');
    expect(shapeCache.requestPrefetch).toHaveBeenCalledWith(['cold-trip'], 0, undefined);
  });

  it('reportCalibration hands records to the sink and swallows sink errors', () => {
    const sink = jest.fn();
    const feed = new LocalGolemioFeed({
      calibrationSink: sink,
      passiveLoggingEnabled: () => true,
    });
    const records: CalibrationRecord[] = [
      {
        t: T0,
        key: '9201',
        model: '15t',
        line: '9',
        obsDist: 300,
        simDist: 290,
        projDist: 300,
        devM: 10,
        kmh: 25,
        bias: null,
        lat: 50.08,
        lng: 14.42,
        mode: 'cruise',
        obsAt: T0 - 2_000,
        statePos: 'on_track',
        delayS: 15,
        nextSeq: 4,
      },
    ];
    feed.reportCalibration(records);
    expect(sink).toHaveBeenCalledWith(records);

    sink.mockImplementation(() => {
      throw new Error('storage full');
    });
    expect(() => feed.reportCalibration(records)).not.toThrow();
  });

  it('passive-logging gate OFF: records are neither buffered nor written', () => {
    const sink = jest.fn();
    let enabled = true;
    const feed = new LocalGolemioFeed({
      calibrationSink: sink,
      passiveLoggingEnabled: () => enabled,
    });
    const records: CalibrationRecord[] = [];

    feed.reportCalibration(records);
    expect(sink).toHaveBeenCalledTimes(1);

    enabled = false;
    feed.reportCalibration(records);
    expect(sink).toHaveBeenCalledTimes(1); // gate held: no sink call at all

    enabled = true;
    feed.reportCalibration(records);
    expect(sink).toHaveBeenCalledTimes(2); // live toggle: back on without restart
  });

  it('a throwing gate is swallowed (never into the ingest path)', () => {
    const sink = jest.fn();
    const feed = new LocalGolemioFeed({
      calibrationSink: sink,
      passiveLoggingEnabled: () => {
        throw new Error('store exploded');
      },
    });
    expect(() => feed.reportCalibration([])).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });
});
