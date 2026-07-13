/// <reference types="jest" />
//
// shapeCache lifecycle-abort semantics (2026-07 review): the feed session's
// AbortSignal flows through requestPrefetch/getTripGeometry into the GTFS
// fetch, and acts as a generation guard — a completion that lands AFTER the
// session aborted must not write the memory cache or disk, and a fresh caller
// joining a dying session's in-flight task retries instead of failing.

import { GolemioAbortError } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { fetchTripGeometry } from '@/lib/golemio/gtfs';
import type { RouteGeometry } from '@/lib/types';

// Keep the disk layer inert: no expo-file-system natives in a unit test.
jest.mock('expo-file-system', () => {
  class FakeFile {
    exists = false;
    write = jest.fn();
    delete = jest.fn();
    text = jest.fn(async () => '');
  }
  class FakeDirectory {
    exists = true;
    create = jest.fn();
  }
  return { File: FakeFile, Directory: FakeDirectory, Paths: { cache: '/tmp' } };
});

jest.mock('@/lib/golemio/gtfs', () => ({
  fetchTripGeometry: jest.fn(),
  geometryServiceMidnight: jest.fn(() => 0),
  serviceDayShiftMs: jest.fn(() => 0),
}));

const fetchGeoMock = fetchTripGeometry as jest.MockedFunction<typeof fetchTripGeometry>;

function makeGeometry(tripId: string): RouteGeometry {
  return {
    shapeId: 's',
    tripId,
    routeId: 'L9',
    line: '9',
    headsign: 'X',
    coordinates: [
      [14.4, 50.0],
      [14.41, 50.01],
    ],
    cumDistM: [0, 1000],
    totalM: 1000,
    stops: [],
  };
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

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  shapeCache.clearMemoryCache();
});

describe('getTripGeometry abort/generation guard', () => {
  it('threads the signal through to the GTFS fetch', async () => {
    const ctl = new AbortController();
    fetchGeoMock.mockResolvedValueOnce(makeGeometry('t1'));
    await shapeCache.getTripGeometry('t1', 1, ctl.signal);
    expect(fetchGeoMock).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ priority: 1, signal: ctl.signal }),
    );
  });

  it('an already-aborted signal never touches the network', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(shapeCache.getTripGeometry('t1', 1, ctl.signal)).rejects.toBeInstanceOf(
      GolemioAbortError,
    );
    expect(fetchGeoMock).not.toHaveBeenCalled();
  });

  it('a LATE completion after abort neither caches in memory nor rethrows silently', async () => {
    const ctl = new AbortController();
    const d = deferred<RouteGeometry>();
    // Simulate a transport that ignores the signal (worst case): the promise
    // resolves successfully AFTER the session died.
    fetchGeoMock.mockImplementationOnce(() => d.promise);

    const p = shapeCache.getTripGeometry('t1', 2, ctl.signal);
    const rejection = expect(p).rejects.toBeInstanceOf(GolemioAbortError);
    await flush();
    ctl.abort();
    d.resolve(makeGeometry('t1'));
    await rejection;

    // The stale session's result must NOT have polluted the cache.
    expect(shapeCache.has('t1')).toBe(false);
    expect(shapeCache.getLoaded('t1')).toBeUndefined();
  });

  it('a fresh caller joining a dying session retries with its own lifecycle', async () => {
    const dying = new AbortController();
    const d1 = deferred<RouteGeometry>();
    fetchGeoMock.mockImplementationOnce(() => d1.promise);
    const first = shapeCache.getTripGeometry('t1', 2, dying.signal);
    const firstRejection = expect(first).rejects.toBeInstanceOf(GolemioAbortError);
    await flush();

    // Second consumer (planner / new session) joins while the first is in flight.
    fetchGeoMock.mockResolvedValueOnce(makeGeometry('t1'));
    const second = shapeCache.getTripGeometry('t1', 1);
    await flush();

    dying.abort();
    d1.reject(new GolemioAbortError());
    await firstRejection;

    // The joiner re-issues the fetch and succeeds.
    await expect(second).resolves.toMatchObject({ tripId: 't1' });
    expect(fetchGeoMock).toHaveBeenCalledTimes(2);
    expect(shapeCache.has('t1')).toBe(true);
  });

  it('requestPrefetch with an aborted signal is a no-op', () => {
    const ctl = new AbortController();
    ctl.abort();
    shapeCache.requestPrefetch(['a', 'b', 'c'], 2, ctl.signal);
    expect(fetchGeoMock).not.toHaveBeenCalled();
  });

  it('requestPrefetch forwards the signal so stop() cancels a cold prefetch', async () => {
    const ctl = new AbortController();
    const d = deferred<RouteGeometry>();
    fetchGeoMock.mockImplementationOnce(() => d.promise);
    shapeCache.requestPrefetch(['t1'], 2, ctl.signal);
    await flush();
    expect(fetchGeoMock).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ signal: ctl.signal }),
    );

    ctl.abort();
    d.reject(new GolemioAbortError()); // what the real transport does on abort
    await flush();
    expect(shapeCache.has('t1')).toBe(false); // nothing cached, nothing thrown
  });
});
