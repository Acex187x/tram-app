/// <reference types="jest" />
//
// shapeCache failure memory (the "roundel-forever" fix, 2026-07-19):
//   • a FAILED geometry fetch is never cached as success and is NOT re-issued
//     by every 5 s poll — it enters a per-trip re-check backoff (short for
//     transient errors, long for 404/"not in the GTFS dataset");
//   • once the backoff elapses the next poll's warm-up retries and the
//     geometry resolves — a visible tram can not stay a roundel forever
//     because of one bad fetch;
//   • a degenerate 200 payload (no usable shape) is treated as a failure, not
//     cached for 3 days as an empty "success";
//   • an urgent (priority 0, tapped-tram) request bypasses the backoff.

import * as shapeCache from '@/lib/golemio/shapeCache';
import {
  GolemioHttpError,
  GolemioNetworkError,
} from '@/lib/golemio/client';
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

function makeGeometry(tripId: string, partial?: Partial<RouteGeometry>): RouteGeometry {
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
    ...partial,
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const T0 = 1_700_000_000_000;
let now = T0;

describe('shapeCache failure memory', () => {
  beforeEach(() => {
    shapeCache.clearMemoryCache();
    fetchGeoMock.mockReset();
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a transient failure backs off, then retries and RESOLVES (never stuck)', async () => {
    fetchGeoMock.mockRejectedValueOnce(new GolemioNetworkError('offline'));

    shapeCache.requestPrefetch(['trip-a'], 1);
    await flush();
    expect(fetchGeoMock).toHaveBeenCalledTimes(1);
    expect(shapeCache.has('trip-a')).toBe(false);
    const fail = shapeCache.getGeometryFailure('trip-a');
    expect(fail?.kind).toBe('transient');
    expect(fail?.attempts).toBe(1);
    expect(fail?.nextRetryAtMs).toBe(now + shapeCache.TRANSIENT_RETRY_BASE_MS);

    // Re-polls INSIDE the backoff window issue no new fetch (no per-poll hammering).
    shapeCache.requestPrefetch(['trip-a'], 1);
    shapeCache.requestPrefetch(['trip-a'], 2);
    await flush();
    expect(fetchGeoMock).toHaveBeenCalledTimes(1);

    // Backoff elapsed → the next poll's warm-up retries → geometry lands.
    const onLoaded = jest.fn();
    const unsub = shapeCache.subscribeLoaded(onLoaded);
    now += shapeCache.TRANSIENT_RETRY_BASE_MS + 1;
    fetchGeoMock.mockResolvedValueOnce(makeGeometry('trip-a'));
    shapeCache.requestPrefetch(['trip-a'], 1);
    await flush();
    expect(fetchGeoMock).toHaveBeenCalledTimes(2);
    expect(shapeCache.getLoaded('trip-a')).toBeDefined();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    // Success clears the failure memory.
    expect(shapeCache.getGeometryFailure('trip-a')).toBeUndefined();
    unsub();
  });

  it('repeated transient failures double the backoff (capped)', async () => {
    fetchGeoMock.mockRejectedValue(new GolemioNetworkError('offline'));

    shapeCache.requestPrefetch(['trip-b'], 1);
    await flush();
    now += shapeCache.TRANSIENT_RETRY_BASE_MS + 1;
    shapeCache.requestPrefetch(['trip-b'], 1);
    await flush();

    const fail = shapeCache.getGeometryFailure('trip-b');
    expect(fail?.attempts).toBe(2);
    expect(fail?.nextRetryAtMs).toBe(now + 2 * shapeCache.TRANSIENT_RETRY_BASE_MS);
    expect(fetchGeoMock).toHaveBeenCalledTimes(2);
  });

  it('404 (trip not in the GTFS dataset) enters the LONG "missing" backoff', async () => {
    fetchGeoMock.mockRejectedValueOnce(new GolemioHttpError(404, 'not found'));

    shapeCache.requestPrefetch(['trip-c'], 1);
    await flush();
    const fail = shapeCache.getGeometryFailure('trip-c');
    expect(fail?.kind).toBe('missing');
    expect(fail?.nextRetryAtMs).toBe(now + shapeCache.MISSING_RETRY_BASE_MS);

    // Well past the TRANSIENT base but inside the missing window: still quiet.
    now += shapeCache.TRANSIENT_RETRY_BASE_MS * 3;
    shapeCache.requestPrefetch(['trip-c'], 1);
    await flush();
    expect(fetchGeoMock).toHaveBeenCalledTimes(1);

    // A later dataset refresh CAN make the trip appear — the re-check happens.
    now = T0 + shapeCache.MISSING_RETRY_BASE_MS + 1;
    fetchGeoMock.mockResolvedValueOnce(makeGeometry('trip-c'));
    shapeCache.requestPrefetch(['trip-c'], 1);
    await flush();
    expect(shapeCache.getLoaded('trip-c')).toBeDefined();
    expect(shapeCache.getGeometryFailure('trip-c')).toBeUndefined();
  });

  it('a degenerate 200 payload (no usable shape) is NOT cached as success', async () => {
    const onLoaded = jest.fn();
    const unsub = shapeCache.subscribeLoaded(onLoaded);
    fetchGeoMock.mockResolvedValueOnce(
      makeGeometry('trip-d', { coordinates: [], cumDistM: [], totalM: 0 }),
    );

    shapeCache.requestPrefetch(['trip-d'], 1);
    await flush();
    // Neither resolvable nor announced — the tram keeps its loading roundel …
    expect(shapeCache.has('trip-d')).toBe(false);
    expect(shapeCache.getLoaded('trip-d')).toBeUndefined();
    expect(onLoaded).not.toHaveBeenCalled();
    // … but the WHY is recorded, with the slow re-check schedule.
    const fail = shapeCache.getGeometryFailure('trip-d');
    expect(fail?.kind).toBe('degenerate');
    expect(fail?.nextRetryAtMs).toBe(now + shapeCache.MISSING_RETRY_BASE_MS);

    // The re-check eventually recovers when upstream fixes the payload.
    now += shapeCache.MISSING_RETRY_BASE_MS + 1;
    fetchGeoMock.mockResolvedValueOnce(makeGeometry('trip-d'));
    shapeCache.requestPrefetch(['trip-d'], 1);
    await flush();
    expect(shapeCache.getLoaded('trip-d')).toBeDefined();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('an urgent (tapped-tram) request bypasses the failure backoff', async () => {
    fetchGeoMock.mockRejectedValueOnce(new GolemioHttpError(404, 'not found'));
    shapeCache.requestPrefetch(['trip-e'], 1);
    await flush();
    expect(fetchGeoMock).toHaveBeenCalledTimes(1);

    // Deep inside the missing-backoff window, a tap still tries right now.
    fetchGeoMock.mockResolvedValueOnce(makeGeometry('trip-e'));
    shapeCache.requestPrefetch(['trip-e'], 0);
    await flush();
    expect(fetchGeoMock).toHaveBeenCalledTimes(2);
    expect(shapeCache.getLoaded('trip-e')).toBeDefined();
  });

  it('getTripGeometry rejects FAST with GeometryUnavailableError during backoff', async () => {
    fetchGeoMock.mockRejectedValueOnce(new GolemioNetworkError('offline'));
    shapeCache.requestPrefetch(['trip-f'], 1);
    await flush();

    await expect(shapeCache.getTripGeometry('trip-f', 1)).rejects.toBeInstanceOf(
      shapeCache.GeometryUnavailableError,
    );
    // The fast rejection consumed no network attempt.
    expect(fetchGeoMock).toHaveBeenCalledTimes(1);
  });

  it('a lifecycle abort is NOT recorded as a failure (next session retries at once)', async () => {
    const { GolemioAbortError } = jest.requireActual<
      typeof import('@/lib/golemio/client')
    >('@/lib/golemio/client');
    fetchGeoMock.mockRejectedValueOnce(new GolemioAbortError());

    shapeCache.requestPrefetch(['trip-g'], 1);
    await flush();
    expect(shapeCache.getGeometryFailure('trip-g')).toBeUndefined();

    // A fresh session's warm-up retries immediately — no backoff window.
    fetchGeoMock.mockResolvedValueOnce(makeGeometry('trip-g'));
    shapeCache.requestPrefetch(['trip-g'], 1);
    await flush();
    expect(shapeCache.getLoaded('trip-g')).toBeDefined();
  });
});
