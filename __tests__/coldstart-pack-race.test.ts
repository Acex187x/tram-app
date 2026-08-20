/// <reference types="jest" />
//
// SCRATCH DIAGNOSTIC (uncommitted) — reproduces the cold-start ordering that
// makes the geometry pack a no-op.
//
// Cold start order in TramRuntime.resume():
//   feed.start()  → Convex WS + stream:fullFleet  (~18 KB, ~150 ms)
//   trajectories.start()
//   warmGeometryPack()                            (~150 KB–1 MB gz, slower)
//
// Whichever lands first wins. When fullFleet lands first, onSnapshots calls
// requestGeometry(...) for every missing trip; getTripGeometry registers each
// trip in shapeCache's `inFlight` map SYNCHRONOUSLY. seedProvisional() then
// refuses every one of them (`if (memCache.has || inFlight.has) return false`),
// so seedFromPack returns 0 and warmGeometryPack bails on `seeded === 0`.

import * as shapeCache from '@/lib/golemio/shapeCache';
import { seedFromPack, type GeometryPack } from '@/lib/golemio/geometryPack';
import { fetchTripGeometry } from '@/lib/golemio/gtfs';
import type { ServedGeometry } from '@/lib/golemio/gtfs';

jest.mock('expo-file-system', () => {
  class FakeFile {
    get exists(): boolean {
      return false;
    }
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

jest.mock('@/lib/golemio/gtfs', () => {
  const actual = jest.requireActual('@/lib/golemio/gtfs');
  return { ...actual, fetchTripGeometry: jest.fn() };
});

const fetchGeoMock = fetchTripGeometry as jest.MockedFunction<typeof fetchTripGeometry>;

const SERVICE_MIDNIGHT = Date.UTC(2026, 7, 16, 0, 0, 0);

function servedShape(shapeId: string, tripId: string): ServedGeometry {
  return {
    tripId,
    shapeId,
    routeId: 'L22',
    line: '22',
    headsign: 'Bílá Hora',
    serviceMidnightMs: SERVICE_MIDNIGHT,
    coordinates: [
      [14.4, 50.08],
      [14.41, 50.08],
      [14.42, 50.08],
    ],
    cumDistM: [0, 715, 1430],
    totalM: 1430,
    stops: [
      {
        stopId: 'U1Z1',
        name: 'A',
        sequence: 1,
        coordinates: [14.4, 50.08],
        distM: 0,
        arrivalMs: SERVICE_MIDNIGHT + 36_000_000,
        departureMs: SERVICE_MIDNIGHT + 36_000_000,
        dwellSeconds: 0,
        isTerminal: false,
      },
      {
        stopId: 'U2Z1',
        name: 'B',
        sequence: 2,
        coordinates: [14.42, 50.08],
        distM: 1430,
        arrivalMs: SERVICE_MIDNIGHT + 36_120_000,
        departureMs: SERVICE_MIDNIGHT + 36_120_000,
        dwellSeconds: 0,
        isTerminal: true,
      },
    ],
    builtAtMs: SERVICE_MIDNIGHT + 36_000_000,
  };
}

const TRIPS = ['t1', 't2', 't3', 't4', 't5'];

const PACK: GeometryPack = {
  atMs: SERVICE_MIDNIGHT + 36_000_000,
  shapes: [servedShape('S1', 't1')],
  trips: Object.fromEntries(TRIPS.map((t) => [t, 'S1'])),
};

beforeEach(() => {
  shapeCache.clearMemoryCache();
  fetchGeoMock.mockReset();
  // Per-trip fetch that never resolves within the test — exactly what a queued
  // scheduler waiter looks like for the first ~140 s of a cold start.
  fetchGeoMock.mockImplementation(() => new Promise(() => {}));
});

test('REGRESSION GUARD: a queued per-trip fetch must NOT block the pack seed', () => {
  // 1. fullFleet lands → runtime warms every missing trip.
  shapeCache.requestPrefetch(TRIPS, 2);
  // 2. Pack lands a moment later.
  const seeded = seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
  // Before the fix this was 0: seedProvisional bailed on `inFlight.has(tripId)`,
  // so the pack was a no-op on EVERY cold start and all ~285 trams stayed bare
  // dots until their individual fetches drained the 16-starts/8 s scheduler.
  expect(seeded).toBe(TRIPS.length);
  for (const t of TRIPS) {
    expect(shapeCache.has(t)).toBe(true);
    expect(shapeCache.isProvisional(t)).toBe(true); // still refined in background
  }
});

test('CONTROL: pack-first ordering seeds everything', () => {
  const seeded = seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
  expect(seeded).toBe(TRIPS.length);
  for (const t of TRIPS) expect(shapeCache.has(t)).toBe(true);
});
