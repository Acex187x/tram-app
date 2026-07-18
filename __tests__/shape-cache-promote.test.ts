/// <reference types="jest" />
//
// shapeCache geometry-throughput hardening (red-dot fix, 2026-07-18):
//   • requestPrefetch re-issued at a HIGHER priority for a trip that is
//     already queued/in flight PROMOTES its scheduler waiter (promoteTag)
//     instead of silently dropping the request — a background-warmed trip
//     whose tram scrolled into the viewport jumps the background lane;
//   • subscribeLoaded fires whenever a geometry lands in the memory cache
//     (feed.subscribeGeometry → the runtime's debounced re-ingest, which is
//     what revives a geometry-less tram without a tap).

import * as shapeCache from '@/lib/golemio/shapeCache';
import { demoteTag, promoteTag } from '@/lib/golemio/client';
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

// Real client module except promoteTag/demoteTag (observed) — the scheduler
// itself is covered by golemio-client tests.
jest.mock('@/lib/golemio/client', () => ({
  ...jest.requireActual('@/lib/golemio/client'),
  promoteTag: jest.fn(() => true),
  demoteTag: jest.fn(() => true),
}));

const fetchGeoMock = fetchTripGeometry as jest.MockedFunction<typeof fetchTripGeometry>;
const promoteTagMock = promoteTag as jest.MockedFunction<typeof promoteTag>;
const demoteTagMock = demoteTag as jest.MockedFunction<typeof demoteTag>;

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

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('shapeCache prefetch promotion + loaded notifications', () => {
  beforeEach(() => {
    shapeCache.clearMemoryCache();
    fetchGeoMock.mockReset();
    promoteTagMock.mockClear();
    demoteTagMock.mockClear();
  });

  it('re-requesting an in-flight trip at a higher priority promotes its waiter', async () => {
    const d = deferred<RouteGeometry>();
    fetchGeoMock.mockReturnValue(d.promise);

    shapeCache.requestPrefetch(['trip-a'], 2);
    await flush(); // let the in-flight task pass its disk read
    expect(promoteTagMock).not.toHaveBeenCalled();

    // Tram scrolled into the viewport: the poll re-requests at priority 1.
    shapeCache.requestPrefetch(['trip-a'], 1);
    expect(promoteTagMock).toHaveBeenCalledWith('trip-a', 1);

    // A repeated BACKGROUND request never promotes — it DEMOTES the queued
    // waiter instead (the tram left the viewport; priorities are re-asserted
    // both ways every poll) and never re-issues the fetch.
    promoteTagMock.mockClear();
    shapeCache.requestPrefetch(['trip-a'], 2);
    expect(promoteTagMock).not.toHaveBeenCalled();
    expect(demoteTagMock).toHaveBeenCalledWith('trip-a', 2);
    expect(fetchGeoMock).toHaveBeenCalledTimes(1); // still a single fetch

    d.resolve(makeGeometry('trip-a'));
    await flush();
  });

  it('a cold-start burst re-requested across polls issues exactly ONE fetch per trip', async () => {
    const d = deferred<RouteGeometry>();
    fetchGeoMock.mockReturnValue(d.promise);

    // Poll 1 (cold start): the whole visible fleet is missing.
    shapeCache.requestPrefetch(['trip-x', 'trip-y', 'trip-z'], 1);
    await flush(); // in-flight tasks pass their disk reads
    expect(fetchGeoMock).toHaveBeenCalledTimes(3);

    // Polls 2–3 re-request the same still-missing trips at shifting
    // priorities (viewport moved): only promotions/demotions, no new fetches.
    shapeCache.requestPrefetch(['trip-x', 'trip-y', 'trip-z'], 2);
    shapeCache.requestPrefetch(['trip-y', 'trip-z'], 1);
    expect(fetchGeoMock).toHaveBeenCalledTimes(3);

    d.resolve(makeGeometry('trip-x'));
    await flush();
  });

  it('subscribeLoaded fires once a geometry lands in the memory cache', async () => {
    const d = deferred<RouteGeometry>();
    fetchGeoMock.mockReturnValue(d.promise);
    const onLoaded = jest.fn();
    const unsub = shapeCache.subscribeLoaded(onLoaded);

    shapeCache.requestPrefetch(['trip-b'], 2);
    await flush();
    expect(onLoaded).not.toHaveBeenCalled();

    d.resolve(makeGeometry('trip-b'));
    await flush();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(shapeCache.getLoaded('trip-b')).toBeDefined();

    // Unsubscribed listeners stay silent.
    unsub();
    const d2 = deferred<RouteGeometry>();
    fetchGeoMock.mockReturnValue(d2.promise);
    shapeCache.requestPrefetch(['trip-c'], 2);
    await flush();
    d2.resolve(makeGeometry('trip-c'));
    await flush();
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not break the fetch path or other listeners', async () => {
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const unsubBad = shapeCache.subscribeLoaded(bad);
    const unsubGood = shapeCache.subscribeLoaded(good);

    fetchGeoMock.mockResolvedValue(makeGeometry('trip-d'));
    await expect(shapeCache.getTripGeometry('trip-d', 1)).resolves.toBeDefined();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();

    unsubBad();
    unsubGood();
  });
});
