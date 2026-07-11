import { describe, expect, it } from '@jest/globals';

import type { GtfsStopTime, GtfsTripDetail } from '@/lib/golemio/apiTypes';
import {
  buildRouteGeometry,
  computeServiceMidnightMs,
  gtfsSecondsToEpoch,
  parseGtfsTimeSeconds,
  pragueLocalToEpoch,
  pragueMidnightEpoch,
  pragueOffsetSeconds,
  projectDistanceOnPolyline,
  serviceDayShiftMs,
} from '@/lib/golemio/gtfs';
import type { RouteGeometry } from '@/lib/types';

describe('parseGtfsTimeSeconds', () => {
  it('parses ordinary times', () => {
    expect(parseGtfsTimeSeconds('13:26:00')).toBe(13 * 3600 + 26 * 60);
    expect(parseGtfsTimeSeconds('00:00:00')).toBe(0);
  });

  it('parses after-midnight times beyond 24:00', () => {
    expect(parseGtfsTimeSeconds('24:10:00')).toBe(86400 + 600);
    expect(parseGtfsTimeSeconds('25:30:00')).toBe(25 * 3600 + 30 * 60);
    expect(parseGtfsTimeSeconds('26:05:30')).toBe(26 * 3600 + 5 * 60 + 30);
  });

  it('rejects malformed input', () => {
    expect(parseGtfsTimeSeconds('')).toBeNull();
    expect(parseGtfsTimeSeconds(null)).toBeNull();
    expect(parseGtfsTimeSeconds('13:60:00')).toBeNull();
    expect(parseGtfsTimeSeconds('nope')).toBeNull();
  });
});

describe('pragueOffsetSeconds (EU DST rule)', () => {
  it('is +2h (CEST) in summer', () => {
    expect(pragueOffsetSeconds(Date.parse('2026-07-11T12:00:00Z'))).toBe(7200);
  });

  it('is +1h (CET) in winter', () => {
    expect(pragueOffsetSeconds(Date.parse('2026-01-15T12:00:00Z'))).toBe(3600);
  });

  it('switches at the last Sunday of March / October', () => {
    // 2026 DST: starts 29 Mar 01:00 UTC, ends 25 Oct 01:00 UTC.
    expect(pragueOffsetSeconds(Date.parse('2026-03-29T00:30:00Z'))).toBe(3600);
    expect(pragueOffsetSeconds(Date.parse('2026-03-29T01:30:00Z'))).toBe(7200);
    expect(pragueOffsetSeconds(Date.parse('2026-10-25T00:30:00Z'))).toBe(7200);
    expect(pragueOffsetSeconds(Date.parse('2026-10-25T01:30:00Z'))).toBe(3600);
  });
});

describe('pragueLocalToEpoch (DST-aware local→UTC)', () => {
  it('resolves an ordinary summer wall clock (CEST)', () => {
    // 2026-07-11 16:00 Prague = 14:00Z.
    expect(new Date(pragueLocalToEpoch(2026, 6, 11, 16, 0, 0)).toISOString()).toBe(
      '2026-07-11T14:00:00.000Z',
    );
  });

  it('resolves an ordinary winter wall clock (CET)', () => {
    // 2026-01-15 12:00 Prague = 11:00Z.
    expect(new Date(pragueLocalToEpoch(2026, 0, 15, 12, 0, 0)).toISOString()).toBe(
      '2026-01-15T11:00:00.000Z',
    );
  });

  it('spring-forward: 03:30 on the transition day is 01:30Z (CEST)', () => {
    // 2026-03-29: at 02:00 CET clocks jump to 03:00 CEST. 03:30 CEST = 01:30Z.
    expect(new Date(pragueLocalToEpoch(2026, 2, 29, 3, 30, 0)).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('spring-forward: the nonexistent 02:30 rolls forward past the gap', () => {
    // 02:30 does not exist; roll forward using CET → 01:30Z (= 03:30 CEST).
    expect(new Date(pragueLocalToEpoch(2026, 2, 29, 2, 30, 0)).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('fall-back: the repeated 02:30 picks the FIRST occurrence (CEST)', () => {
    // 2026-10-25: at 03:00 CEST clocks fall back to 02:00 CET. 02:30 happens
    // twice; the first (CEST) instant is 00:30Z, the second (CET) is 01:30Z.
    expect(new Date(pragueLocalToEpoch(2026, 9, 25, 2, 30, 0)).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('fall-back: an unambiguous later time resolves to CET', () => {
    // 04:00 on 2026-10-25 is after the fall-back → CET → 03:00Z.
    expect(new Date(pragueLocalToEpoch(2026, 9, 25, 4, 0, 0)).toISOString()).toBe(
      '2026-10-25T03:00:00.000Z',
    );
  });
});

describe('gtfsSecondsToEpoch (DST-aware service-day resolution)', () => {
  it('matches naive addition away from DST boundaries', () => {
    const mid = pragueMidnightEpoch(Date.parse('2026-07-11T12:00:00Z'));
    // 13:26:00 on a summer day.
    expect(gtfsSecondsToEpoch(mid, 13 * 3600 + 26 * 60)).toBe(mid + (13 * 3600 + 26 * 60) * 1000);
  });

  it('is one hour off from naive addition across the spring transition', () => {
    // Service day 2026-03-28 (CET). GTFS 03:30 the next morning belongs to the
    // 2026-03-28 service day only if <24:00; use same-day 03:30 = 12600s but on
    // the transition day itself: service day 2026-03-29, arrival 05:00 CEST.
    const mid = pragueMidnightEpoch(Date.parse('2026-03-29T12:00:00Z'));
    // 05:00 CEST = 03:00Z. Naive addition (mid + 5h) would give 04:00Z (wrong).
    const arr = gtfsSecondsToEpoch(mid, 5 * 3600);
    expect(new Date(arr).toISOString()).toBe('2026-03-29T03:00:00.000Z');
    expect(arr).not.toBe(mid + 5 * 3600 * 1000);
  });

  it('after-midnight overflow (>24:00) crossing the fall-back transition', () => {
    // Service day 2026-10-24 (CEST). GTFS 26:30 → 02:30 local on 2026-10-25,
    // the repeated fall-back hour → first occurrence 00:30Z.
    const mid = pragueMidnightEpoch(Date.parse('2026-10-24T12:00:00Z'));
    const arr = gtfsSecondsToEpoch(mid, 26 * 3600 + 30 * 60);
    expect(new Date(arr).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('after-midnight overflow crossing the spring transition rolls forward', () => {
    // Service day 2026-03-28 (CET). GTFS 26:30 → 02:30 local on 2026-03-29,
    // the nonexistent spring gap → rolls forward to 01:30Z.
    const mid = pragueMidnightEpoch(Date.parse('2026-03-28T12:00:00Z'));
    const arr = gtfsSecondsToEpoch(mid, 26 * 3600 + 30 * 60);
    expect(new Date(arr).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('computeServiceMidnightMs', () => {
  it('picks today for a daytime trip', () => {
    const now = Date.parse('2026-07-11T14:00:00Z'); // 16:00 Prague
    const first = parseGtfsTimeSeconds('13:26:00')!;
    const last = parseGtfsTimeSeconds('14:14:00')!;
    expect(computeServiceMidnightMs(first, last, now)).toBe(
      pragueMidnightEpoch(now),
    );
  });

  it('picks the previous service day for an after-midnight night trip', () => {
    // now = 2026-07-12 01:00 Prague (= 2026-07-11T23:00Z)
    const now = Date.parse('2026-07-11T23:00:00Z');
    const first = parseGtfsTimeSeconds('24:10:00')!; // 00:10 next day
    const last = parseGtfsTimeSeconds('25:30:00')!; // 01:30 next day
    const midnight = computeServiceMidnightMs(first, last, now);
    // Service day is 2026-07-11 (Prague), i.e. previous calendar day.
    expect(midnight).toBe(
      pragueMidnightEpoch(Date.parse('2026-07-11T10:00:00Z')),
    );
    // The last arrival resolves to 2026-07-12 01:30 Prague = 2026-07-11T23:30Z.
    const lastArrivalMs = midnight + last * 1000;
    expect(new Date(lastArrivalMs).toISOString()).toBe('2026-07-11T23:30:00.000Z');
  });
});

describe('projectDistanceOnPolyline', () => {
  const coords: [number, number][] = [
    [14.4, 50.0],
    [14.41, 50.0],
    [14.42, 50.0],
  ];
  // ~712m per 0.01° lng at lat 50.
  const cum = [0, 712, 1424];

  it('projects a point near the middle to the middle distance', () => {
    const d = projectDistanceOnPolyline([14.41, 50.0005], coords, cum);
    expect(d).toBeGreaterThan(650);
    expect(d).toBeLessThan(780);
  });

  it('clamps to the start for a point before the line', () => {
    const d = projectDistanceOnPolyline([14.39, 50.0], coords, cum);
    expect(d).toBe(0);
  });

  it('honors a lower bound on a loop so a later stop projects forward', () => {
    // A shape that goes out east, then loops back west over the SAME longitudes
    // (offset north). A stop near 14.41 is nearest the early (outbound) leg but,
    // by stop_sequence, belongs to the late (inbound) leg.
    const loop: [number, number][] = [
      [14.4, 50.0], // 0
      [14.42, 50.0], // outbound (lat 50.0)
      [14.42, 50.012], // turn
      [14.4, 50.012], // inbound (lat 50.012, over the outbound longitudes)
    ];
    // Cumulative meters (approx): 0, ~1431, ~2757, ~4188.
    const loopCum = [0, 1431, 2757, 4188];
    // Stop is closer to the outbound leg (0.004° vs 0.008°). Unbounded it snaps
    // backward onto the outbound leg (~715 m).
    const dUnbounded = projectDistanceOnPolyline([14.41, 50.004], loop, loopCum, 0);
    expect(dUnbounded).toBeLessThan(1500);
    // With a lower bound past the outbound leg it must project forward onto the
    // inbound leg instead, keeping the stop series monotonic.
    const d = projectDistanceOnPolyline([14.41, 50.004], loop, loopCum, 2600);
    expect(d).toBeGreaterThanOrEqual(2600);
  });
});

describe('serviceDayShiftMs (TIME-2 re-anchoring)', () => {
  function geoWith(midnight: number): RouteGeometry {
    return {
      shapeId: 's',
      tripId: 't',
      routeId: 'L1',
      line: '1',
      headsign: 'H',
      coordinates: [],
      cumDistM: [],
      totalM: 0,
      stops: [
        {
          stopId: 'a',
          name: 'A',
          sequence: 1,
          coordinates: [0, 0],
          distM: 0,
          arrivalMs: gtfsSecondsToEpoch(midnight, 13 * 3600),
          departureMs: gtfsSecondsToEpoch(midnight, 13 * 3600),
          dwellSeconds: 0,
          isTerminal: false,
        },
        {
          stopId: 'b',
          name: 'B',
          sequence: 2,
          coordinates: [0, 0],
          distM: 100,
          arrivalMs: gtfsSecondsToEpoch(midnight, 14 * 3600),
          departureMs: gtfsSecondsToEpoch(midnight, 14 * 3600),
          dwellSeconds: 0,
          isTerminal: true,
        },
      ],
    };
  }

  it('returns 0 when the stored day is the current service day', () => {
    const now = Date.parse('2026-07-11T12:00:00Z'); // 14:00 Prague, mid-trip
    const mid = pragueMidnightEpoch(now);
    expect(serviceDayShiftMs(geoWith(mid), mid, now)).toBe(0);
  });

  it('shifts a day-stale cached geometry forward to the current day', () => {
    // Cached yesterday (2026-07-10), read today (2026-07-11) at trip time.
    const fetchMid = pragueMidnightEpoch(Date.parse('2026-07-10T12:00:00Z'));
    const readNow = Date.parse('2026-07-11T12:00:00Z');
    const shift = serviceDayShiftMs(geoWith(fetchMid), fetchMid, readNow);
    const currentMid = pragueMidnightEpoch(readNow);
    expect(shift).toBe(currentMid - fetchMid);
    // A stale 13:00 arrival re-anchors to today's 13:00 Prague.
    const staleArr = gtfsSecondsToEpoch(fetchMid, 13 * 3600);
    expect(new Date(staleArr + shift).toISOString()).toBe(
      new Date(gtfsSecondsToEpoch(currentMid, 13 * 3600)).toISOString(),
    );
  });
});

describe('buildRouteGeometry', () => {
  function shape(seq: number, lng: number, lat: number, km: number) {
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [lng, lat] as [number, number] },
      properties: { shape_dist_traveled: km, shape_id: 'N91V1', shape_pt_sequence: seq },
    };
  }
  function stopTime(
    seq: number,
    id: string,
    name: string,
    lng: number,
    lat: number,
    km: number | null,
    arrival: string,
  ): GtfsStopTime {
    return {
      arrival_time: arrival,
      departure_time: arrival,
      drop_off_type: '0',
      pickup_type: '0',
      shape_dist_traveled: km,
      stop_headsign: null,
      stop_id: id,
      stop_sequence: seq,
      trip_id: 'night-trip',
      computed_dwell_time_seconds: seq === 1 ? 20 : 0,
      headsign_icons: null,
      stop_icons: null,
      stop: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: {
          location_type: 0,
          parent_station: null,
          platform_code: 'A',
          stop_id: id,
          stop_name: name,
          wheelchair_boarding: 1,
          zone_id: 'P',
          level_id: null,
        },
      },
    };
  }

  const detail: GtfsTripDetail = {
    route_id: 'L91',
    service_id: 's',
    shape_id: 'N91V1',
    trip_headsign: 'Depo',
    trip_id: 'night-trip',
    direction_id: 0,
    wheelchair_accessible: 1,
    bikes_allowed: 1,
    shapes: [
      shape(1, 14.4, 50.0, 0),
      shape(2, 14.41, 50.0, 0.712),
      shape(3, 14.42, 50.0, 1.424),
    ],
    stop_times: [
      stopTime(1, 'U1Z1P', 'Start', 14.4, 50.0, 0, '24:10:00'),
      stopTime(2, 'U2Z1P', 'Middle', 14.41, 50.0, null, '24:50:00'), // missing distM → projected
      stopTime(3, 'U3Z1P', 'Depo', 14.42, 50.0, 1.424, '25:30:00'),
    ],
  };

  const now = Date.parse('2026-07-11T23:00:00Z'); // 2026-07-12 01:00 Prague
  const geo = buildRouteGeometry(detail, now);

  it('converts km to meters for shape and stops', () => {
    expect(geo.totalM).toBeCloseTo(1424, 0);
    expect(geo.cumDistM).toEqual([0, 712, 1424]);
    expect(geo.stops[0].distM).toBe(0);
    expect(geo.stops[2].distM).toBe(1424);
  });

  it('projects a stop that is missing shape_dist_traveled', () => {
    expect(geo.stops[1].distM).toBeGreaterThan(600);
    expect(geo.stops[1].distM).toBeLessThan(800);
  });

  it('derives line from route_id and marks the terminal', () => {
    expect(geo.line).toBe('91');
    expect(geo.stops[2].isTerminal).toBe(true);
    expect(geo.stops[0].isTerminal).toBe(false);
  });

  it('resolves after-midnight arrival times into monotonically increasing epochs', () => {
    expect(geo.stops[0].arrivalMs).toBeLessThan(geo.stops[1].arrivalMs);
    expect(geo.stops[1].arrivalMs).toBeLessThan(geo.stops[2].arrivalMs);
    // Last stop = 2026-07-12 01:30 Prague = 2026-07-11T23:30Z.
    expect(new Date(geo.stops[2].arrivalMs).toISOString()).toBe(
      '2026-07-11T23:30:00.000Z',
    );
  });

  it('carries dwell seconds', () => {
    expect(geo.stops[0].dwellSeconds).toBe(20);
    expect(geo.stops[2].dwellSeconds).toBe(0);
  });
});
