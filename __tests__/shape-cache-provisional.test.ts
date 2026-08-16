/// <reference types="jest" />
//
// Pack-provisional entries must CONVERGE to authoritative geometry.
//
// A provisional entry (seeded from the shape-deduped cold-start pack) renders
// correctly but carries a sibling trip's stop epochs, so the per-trip fetch has
// to replace it. Two things must hold, and each of them broke once:
//
//   1. getTripGeometry must NOT short-circuit on the resident provisional
//      entry — otherwise the refinement request resolves instantly with the
//      same borrowed timetable and nothing ever converges;
//   2. BOTH write paths (network AND disk) must clear the provisional mark.
//      The disk path originally set memCache and left the flag, so a refined
//      trip stayed flagged and every poll re-queued it forever.

import * as shapeCache from '@/lib/golemio/shapeCache';
import { fetchTripGeometry } from '@/lib/golemio/gtfs';
import type { RouteGeometry } from '@/lib/types';

// Disk layer is a controllable fake. The `mock` prefix is required: jest.mock
// factories are hoisted and may only close over mock-prefixed variables.
const mockDisk: { payload: string | null } = { payload: null };

jest.mock('expo-file-system', () => {
  class FakeFile {
    get exists(): boolean {
      return mockDisk.payload !== null;
    }
    write = jest.fn();
    delete = jest.fn();
    text = jest.fn(async () => mockDisk.payload ?? '');
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

function makeGeometry(tripId: string, shapeId: string): RouteGeometry {
  return {
    shapeId,
    tripId,
    routeId: 'L9',
    line: '9',
    headsign: 'H',
    coordinates: [
      [14.4, 50.08],
      [14.42, 50.08],
    ],
    cumDistM: [0, 1430],
    totalM: 1430,
    stops: [],
  };
}

beforeEach(() => {
  shapeCache.clearMemoryCache();
  fetchGeoMock.mockReset();
  mockDisk.payload = null;
});

it('does not short-circuit on a provisional entry — it refetches and converges', async () => {
  shapeCache.seedProvisional('t1', makeGeometry('t1', 'BORROWED'));
  expect(shapeCache.isProvisional('t1')).toBe(true);

  fetchGeoMock.mockResolvedValue(makeGeometry('t1', 'REAL'));
  const got = await shapeCache.getTripGeometry('t1', 2);

  expect(fetchGeoMock).toHaveBeenCalledTimes(1); // the seed did NOT satisfy it
  expect(got.shapeId).toBe('REAL');
  expect(shapeCache.isProvisional('t1')).toBe(false);
  expect(shapeCache.getAllAuthoritative().map((g) => g.tripId)).toContain('t1');
});

it('clears the provisional mark on the DISK path too (regressed once)', async () => {
  shapeCache.seedProvisional('t2', makeGeometry('t2', 'BORROWED'));
  mockDisk.payload = JSON.stringify({
    savedAt: Date.now(),
    serviceMidnightMs: 0,
    geometry: makeGeometry('t2', 'FROM-DISK'),
  });

  const got = await shapeCache.getTripGeometry('t2', 2);

  expect(fetchGeoMock).not.toHaveBeenCalled(); // disk answered
  expect(got.shapeId).toBe('FROM-DISK');
  expect(shapeCache.isProvisional('t2')).toBe(false);
  expect(shapeCache.getAllAuthoritative().map((g) => g.tripId)).toContain('t2');
});

it('an authoritative entry still short-circuits (no needless refetch)', async () => {
  fetchGeoMock.mockResolvedValue(makeGeometry('t3', 'REAL'));
  await shapeCache.getTripGeometry('t3', 2);
  expect(fetchGeoMock).toHaveBeenCalledTimes(1);

  await shapeCache.getTripGeometry('t3', 2);
  expect(fetchGeoMock).toHaveBeenCalledTimes(1); // served from memory
});

it('requestPrefetch keeps provisional trips in the queue but skips settled ones', async () => {
  shapeCache.seedProvisional('p1', makeGeometry('p1', 'BORROWED'));
  fetchGeoMock.mockResolvedValue(makeGeometry('p1', 'REAL'));

  shapeCache.requestPrefetch(['p1'], 2);
  await new Promise((r) => setTimeout(r, 0));
  expect(fetchGeoMock).toHaveBeenCalledTimes(1);

  // Now authoritative: a further prefetch must not re-issue it.
  fetchGeoMock.mockClear();
  shapeCache.requestPrefetch(['p1'], 2);
  await new Promise((r) => setTimeout(r, 0));
  expect(fetchGeoMock).not.toHaveBeenCalled();
});
