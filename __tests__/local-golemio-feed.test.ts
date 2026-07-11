/// <reference types="jest" />
//
// LocalGolemioFeed: the client-side TramFeed implementation. Locks the poll
// loop semantics moved verbatim out of TramRuntime — 5 s cadence with an
// immediate first poll, single-flight (no overlapping polls), abort +
// generation guards on stop() (a late completion neither emits nor mutates
// status), error/health reporting, shapeCache/scheduler delegation, and the
// calibration sink hand-off.

import { LocalGolemioFeed, POLL_MS } from '@/lib/feed/localGolemioFeed';
import type { CalibrationRecord } from '@/lib/feed/types';
import { promoteTag } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { fetchTramSnapshots } from '@/lib/golemio/vehicles';
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
jest.mock('@/lib/golemio/client', () => ({
  promoteTag: jest.fn(() => false),
}));

const fetchMock = fetchTramSnapshots as jest.MockedFunction<typeof fetchTramSnapshots>;
const promoteTagMock = promoteTag as jest.MockedFunction<typeof promoteTag>;
const hasMock = shapeCache.has as jest.MockedFunction<typeof shapeCache.has>;

const T0 = 1_000_000_000_000;

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
    fetchMock.mockResolvedValueOnce(snapshots);
    const feed = new LocalGolemioFeed();
    const batches: { snapshots: TramSnapshot[]; atMs: number }[] = [];
    feed.subscribeSnapshots((s, atMs) => batches.push({ snapshots: s, atMs }));

    feed.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush();

    expect(batches).toEqual([{ snapshots, atMs: T0 }]);
    expect(feed.status()).toEqual({ lastBatchAtMs: T0, lastError: null });
    feed.stop();
  });

  it('start() is idempotent and the loop re-polls every POLL_MS', async () => {
    fetchMock.mockResolvedValue([]);
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
    const d = deferred<TramSnapshot[]>();
    fetchMock.mockImplementationOnce(() => d.promise);
    fetchMock.mockResolvedValue([]);
    const feed = new LocalGolemioFeed();
    feed.start();
    await jest.advanceTimersByTimeAsync(POLL_MS); // first poll still pending
    expect(fetchMock).toHaveBeenCalledTimes(1);

    d.resolve([]);
    await flush();
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    feed.stop();
  });

  it('a failed poll sets lastError; the next success clears it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    fetchMock.mockResolvedValueOnce([]);
    const feed = new LocalGolemioFeed();
    feed.start();
    await flush();
    expect(feed.status().lastError).toBe('boom');
    expect(feed.status().lastBatchAtMs).toBe(0);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(feed.status()).toEqual({ lastBatchAtMs: T0 + POLL_MS, lastError: null });
    feed.stop();
  });

  it('a subscriber throw surfaces as a feed error (historic inline-poll semantics)', async () => {
    fetchMock.mockResolvedValueOnce([makeSnapshot()]);
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
    const d = deferred<TramSnapshot[]>();
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
    d.resolve([makeSnapshot()]);
    await flush();
    expect(batches).toHaveLength(0);
    expect(feed.status()).toEqual({ lastBatchAtMs: 0, lastError: null });
  });

  it('a late REJECTION after stop() is swallowed too (no stale lastError)', async () => {
    const d = deferred<TramSnapshot[]>();
    fetchMock.mockImplementationOnce(() => d.promise);
    const feed = new LocalGolemioFeed();
    feed.start();
    feed.stop();
    d.reject(new Error('aborted'));
    await flush();
    expect(feed.status().lastError).toBeNull();
  });

  it('unsubscribe stops delivery', async () => {
    fetchMock.mockResolvedValue([]);
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
    expect(shapeCache.requestPrefetch).toHaveBeenCalledWith(['a', 'b'], 2);
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
    expect(shapeCache.requestPrefetch).toHaveBeenCalledWith(['cold-trip'], 0);
  });

  it('reportCalibration hands records to the sink and swallows sink errors', () => {
    const sink = jest.fn();
    const feed = new LocalGolemioFeed({ calibrationSink: sink });
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
      },
    ];
    feed.reportCalibration(records);
    expect(sink).toHaveBeenCalledWith(records);

    sink.mockImplementation(() => {
      throw new Error('storage full');
    });
    expect(() => feed.reportCalibration(records)).not.toThrow();
  });
});
