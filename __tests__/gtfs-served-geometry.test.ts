// The backend-served geometry path (client.ts USE_BACKEND_PROXY → convex
// geometry serving, backend-convex.md §7 step 4): served payloads re-narrow
// into RouteGeometry and re-anchor onto the CURRENT service day, and
// fetchTripGeometry dials the backend's /geometry/:tripId — never Golemio.

import { describe, expect, it, jest } from '@jest/globals';

import { USE_BACKEND_PROXY } from '@/lib/golemio/client';
import {
  pragueMidnightEpoch,
  servedToRouteGeometry,
  type ServedGeometry,
} from '@/lib/golemio/gtfs';

/** A two-stop served payload anchored to the service day containing `midnight`. */
function served(midnightMs: number): ServedGeometry {
  const dep = midnightMs + 10 * 3600 * 1000; // 10:00 local
  return {
    tripId: 'T1',
    shapeId: 'S1',
    routeId: 'L22',
    line: '22',
    headsign: 'Bílá Hora',
    serviceMidnightMs: midnightMs,
    coordinates: [
      [14.4, 50.08],
      [14.41, 50.081],
    ],
    cumDistM: [0, 1000],
    totalM: 1000,
    stops: [
      {
        stopId: 'A',
        name: 'First',
        sequence: 1,
        coordinates: [14.4, 50.08],
        distM: 0,
        arrivalMs: dep,
        departureMs: dep,
        dwellSeconds: 0,
        isTerminal: false,
      },
      {
        stopId: 'B',
        name: 'Last',
        sequence: 2,
        coordinates: [14.41, 50.081],
        distM: 1000,
        arrivalMs: dep + 5 * 60_000,
        departureMs: dep + 5 * 60_000,
        dwellSeconds: 0,
        isTerminal: true,
      },
    ],
    builtAtMs: midnightMs,
  };
}

describe('transport switch', () => {
  it('is hard-wired to the backend proxy', () => {
    expect(USE_BACKEND_PROXY).toBe(true);
  });
});

describe('servedToRouteGeometry', () => {
  it('narrows number[] coordinates into tuples without touching values', () => {
    const midnight = pragueMidnightEpoch(Date.now());
    const g = servedToRouteGeometry(served(midnight), midnight + 10 * 3600 * 1000);
    expect(g.coordinates).toEqual([
      [14.4, 50.08],
      [14.41, 50.081],
    ]);
    expect(g.stops[0].coordinates).toEqual([14.4, 50.08]);
    expect(g.totalM).toBe(1000);
    expect(g.line).toBe('22');
  });

  it('keeps stop epochs unchanged when the service day matches', () => {
    const midnight = pragueMidnightEpoch(Date.parse('2026-08-05T12:00:00Z'));
    const nowMs = midnight + 10 * 3600 * 1000 + 60_000; // mid-trip that day
    const g = servedToRouteGeometry(served(midnight), nowMs);
    expect(g.stops[0].departureMs).toBe(midnight + 10 * 3600 * 1000);
  });

  it('re-anchors a payload built on an earlier service day onto today', () => {
    const builtDay = pragueMidnightEpoch(Date.parse('2026-08-04T12:00:00Z'));
    const today = pragueMidnightEpoch(Date.parse('2026-08-06T12:00:00Z'));
    const nowMs = today + 10 * 3600 * 1000; // 10:00 two days later
    const g = servedToRouteGeometry(served(builtDay), nowMs);
    // The whole timetable shifts forward two calendar days; in-day times hold.
    expect(g.stops[0].departureMs).toBe(today + 10 * 3600 * 1000);
    expect(g.stops[1].arrivalMs - g.stops[0].departureMs).toBe(5 * 60_000);
  });
});

describe('fetchTripGeometry over the proxy', () => {
  it('requests /geometry/:tripId and re-anchors the response', async () => {
    jest.resetModules();
    const calls: { path: string; options: unknown }[] = [];
    const midnight = pragueMidnightEpoch(Date.now());
    jest.doMock('@/lib/golemio/client', () => {
      const actual = jest.requireActual<typeof import('@/lib/golemio/client')>(
        '@/lib/golemio/client',
      );
      return {
        ...actual,
        golemioFetch: (path: string, options: unknown) => {
          calls.push({ path, options });
          return Promise.resolve(served(midnight));
        },
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const gtfs = require('@/lib/golemio/gtfs') as typeof import('@/lib/golemio/gtfs');
    const g = await gtfs.fetchTripGeometry('26_22507 260711', {
      nowMs: midnight + 10 * 3600 * 1000,
    });
    expect(calls).toHaveLength(1);
    // Trip ids embed spaces/underscores — the path must be URI-encoded, and it
    // must be the backend route, not a Golemio one.
    expect(calls[0].path).toBe('/geometry/26_22507%20260711');
    expect(g.tripId).toBe('T1');
    jest.dontMock('@/lib/golemio/client');
  });
});
