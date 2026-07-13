/// <reference types="jest" />
//
// Input validation for the vehiclepositions normalizer (2026-07 review):
// missing/invalid KEY fields must DROP the record with a per-reason counter —
// never degrade into plausible-but-false values ([0,0] coordinates, distance
// 0, observedAtMs = Date.now()), which used to teleport trams and feed false
// pace samples into calibration. Includes fuzz coverage over missing/string/
// NaN/Infinity/out-of-range mutations.

import type { VpFeature } from '@/lib/golemio/apiTypes';
import { golemioFetch, GolemioNetworkError } from '@/lib/golemio/client';
import {
  fetchTramSnapshots,
  normalizeFeature,
  PRAGUE_LAT_MAX,
  PRAGUE_LAT_MIN,
  PRAGUE_LNG_MAX,
  PRAGUE_LNG_MIN,
} from '@/lib/golemio/vehicles';

jest.mock('@/lib/golemio/client', () => {
  const actual = jest.requireActual('@/lib/golemio/client');
  return {
    golemioFetch: jest.fn(),
    GolemioNetworkError: actual.GolemioNetworkError,
    GolemioHttpError: actual.GolemioHttpError,
  };
});

const golemioFetchMock = golemioFetch as jest.MockedFunction<typeof golemioFetch>;

/** A fully valid tram feature as the live API delivers it. */
function makeFeature(over?: {
  geometry?: Partial<VpFeature['geometry']>;
  lastPosition?: Partial<VpFeature['properties']['last_position']>;
  trip?: Partial<VpFeature['properties']['trip']>;
  gtfs?: Partial<VpFeature['properties']['trip']['gtfs']>;
}): VpFeature {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [14.42, 50.08],
      ...over?.geometry,
    },
    properties: {
      last_position: {
        bearing: 90,
        delay: { actual: 30, last_stop_arrival: null, last_stop_departure: null },
        is_canceled: false,
        last_stop: { arrival_time: null, departure_time: null, id: 'U1Z1P', sequence: 3 },
        next_stop: {
          arrival_time: '2026-07-13T12:01:00+02:00',
          departure_time: null,
          id: 'U2Z1P',
          sequence: 4,
        },
        origin_timestamp: '2026-07-01T12:00:00+02:00',
        shape_dist_traveled: '5.871',
        speed: null,
        state_position: 'on_track',
        tracking: true,
        ...over?.lastPosition,
      },
      trip: {
        agency_name: { real: 'DPP', scheduled: 'DPP' },
        cis: { line_id: null, trip_number: null },
        gtfs: {
          route_id: 'L9',
          route_short_name: '9',
          route_type: 0,
          trip_headsign: 'Sídliště Řepy',
          trip_id: '9_123_260701',
          trip_short_name: null,
          ...over?.gtfs,
        },
        origin_route_name: null,
        sequence_id: null,
        start_timestamp: null,
        vehicle_registration_number: 9201,
        vehicle_type: null,
        wheelchair_accessible: true,
        air_conditioned: true,
        usb_chargers: null,
        ...over?.trip,
      },
    },
  };
}

function reason(feature: VpFeature): string | null {
  const res = normalizeFeature(feature);
  return res.ok ? null : res.reason;
}

describe('normalizeFeature validation', () => {
  it('normalizes a fully valid feature (km string → meters, ISO → epoch ms)', () => {
    const res = normalizeFeature(makeFeature());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot).toMatchObject({
      key: '9201',
      registrationNumber: 9201,
      tripId: '9_123_260701',
      line: '9',
      shapeDistM: 5871,
      observedAtMs: Date.parse('2026-07-01T12:00:00+02:00'),
      coordinates: [14.42, 50.08],
      bearing: 90,
      delaySeconds: 30,
      statePosition: 'on_track',
      nextStopSequence: 4,
      wheelchairAccessible: true,
      airConditioned: true,
      isCanceled: false,
    });
  });

  it('drops records missing core identity instead of guessing', () => {
    expect(reason({ type: 'Feature' } as unknown as VpFeature)).toBe('missing-core');
    expect(
      reason({
        ...makeFeature(),
        properties: { trip: makeFeature().properties.trip },
      } as unknown as VpFeature),
    ).toBe('missing-core');
    expect(reason(makeFeature({ gtfs: { trip_id: '' } }))).toBe('missing-core');
    expect(
      reason(makeFeature({ gtfs: { trip_id: 123 as unknown as string } })),
    ).toBe('missing-core');
    expect(
      reason(makeFeature({ gtfs: { route_id: null as unknown as string } })),
    ).toBe('missing-core');
  });

  it('drops bad coordinates instead of defaulting to [0,0]', () => {
    const cases: unknown[] = [
      undefined,
      [],
      [14.42],
      ['14.42', '50.08'],
      [Number.NaN, 50.08],
      [14.42, Number.POSITIVE_INFINITY],
      [0, 0], // the historic poison value itself is out of range
      [PRAGUE_LNG_MIN - 0.1, 50.08],
      [PRAGUE_LNG_MAX + 0.1, 50.08],
      [14.42, PRAGUE_LAT_MIN - 0.1],
      [14.42, PRAGUE_LAT_MAX + 0.1],
    ];
    for (const coordinates of cases) {
      const f = makeFeature();
      (f.geometry as { coordinates: unknown }).coordinates = coordinates;
      expect(reason(f)).toBe('bad-coordinates');
    }
    // Missing geometry entirely.
    const noGeom = makeFeature() as unknown as { geometry?: unknown };
    delete noGeom.geometry;
    expect(reason(noGeom as VpFeature)).toBe('bad-coordinates');
  });

  it('drops unknown/invalid shape_dist instead of pretending the tram is at 0 m', () => {
    for (const value of [null, undefined, '', 'abc', 'NaN', 'Infinity', '-1', '150']) {
      expect(
        reason(makeFeature({ lastPosition: { shape_dist_traveled: value as string | null } })),
      ).toBe('bad-distance');
    }
    // Numeric edge: 0 km is a legitimate position (route start), not invalid.
    expect(
      reason(makeFeature({ lastPosition: { shape_dist_traveled: '0' } })),
    ).toBeNull();
  });

  it('drops records without a usable origin_timestamp instead of substituting Date.now()', () => {
    for (const value of [null, undefined, '', 'not-a-date']) {
      expect(
        reason(makeFeature({ lastPosition: { origin_timestamp: value as string | null } })),
      ).toBe('missing-timestamp');
    }
  });

  it('non-key fields degrade gracefully (never reject, never fabricate numbers)', () => {
    const res = normalizeFeature(
      makeFeature({
        lastPosition: {
          bearing: 'east' as unknown as number,
          delay: null,
          last_stop: null,
          next_stop: null,
          state_position: '' as unknown as string,
        },
        trip: {
          vehicle_registration_number: Number.NaN,
          wheelchair_accessible: null,
          air_conditioned: null,
          usb_chargers: null,
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot).toMatchObject({
      key: '9_123_260701', // falls back to trip id when the reg number is unusable
      registrationNumber: null,
      bearing: null,
      delaySeconds: 0,
      statePosition: 'unknown',
      lastStopId: null,
      nextStopSequence: null,
      nextStopArrivalMs: null,
      wheelchairAccessible: false,
      airConditioned: null,
    });
  });

  it('fuzz: random key-field mutations always drop with a reason — never a quasi-valid snapshot', () => {
    const poisons: unknown[] = [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -Number.MAX_VALUE,
      '',
      'garbage',
      [],
      {},
      [Number.NaN, Number.NaN],
      [1e9, -1e9],
    ];
    const now = Date.now();
    let mutations = 0;
    for (const poison of poisons) {
      const targets: ((f: VpFeature) => void)[] = [
        (f) => ((f.geometry as { coordinates: unknown }).coordinates = poison),
        (f) =>
          ((f.properties.last_position as { shape_dist_traveled: unknown }).shape_dist_traveled =
            poison),
        (f) =>
          ((f.properties.last_position as { origin_timestamp: unknown }).origin_timestamp =
            poison),
        (f) => ((f.properties.trip.gtfs as { trip_id: unknown }).trip_id = poison),
      ];
      for (const mutate of targets) {
        const f = makeFeature();
        mutate(f);
        const res = normalizeFeature(f);
        mutations += 1;
        if (!res.ok) continue; // dropped with a reason — the desired outcome
        // The rare survivors must be fully sane — no poison leaked through.
        const s = res.snapshot;
        expect(Number.isFinite(s.shapeDistM)).toBe(true);
        expect(s.shapeDistM).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(s.observedAtMs)).toBe(true);
        expect(s.coordinates).not.toEqual([0, 0]);
        expect(s.coordinates[0]).toBeGreaterThanOrEqual(PRAGUE_LNG_MIN);
        expect(s.coordinates[0]).toBeLessThanOrEqual(PRAGUE_LNG_MAX);
        expect(s.coordinates[1]).toBeGreaterThanOrEqual(PRAGUE_LAT_MIN);
        expect(s.coordinates[1]).toBeLessThanOrEqual(PRAGUE_LAT_MAX);
        // No fabricated "fresh fix": the timestamp must come from the input.
        expect(Math.abs(s.observedAtMs - now)).toBeGreaterThan(1_000);
      }
    }
    expect(mutations).toBeGreaterThan(30);
  });
});

describe('fetchTramSnapshots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters non-trams silently, counts tram rejections by reason', async () => {
    const bus = makeFeature({ gtfs: { route_type: 3 } });
    const good = makeFeature();
    const badDist = makeFeature({ lastPosition: { shape_dist_traveled: null } });
    const badTime = makeFeature({ lastPosition: { origin_timestamp: 'garbage' } });
    golemioFetchMock.mockResolvedValueOnce({
      type: 'FeatureCollection',
      features: [bus, good, badDist, badTime],
    });

    const batch = await fetchTramSnapshots();
    expect(batch.snapshots).toHaveLength(1);
    expect(batch.rejectedTotal).toBe(2);
    expect(batch.rejected).toEqual({
      'missing-core': 0,
      'bad-coordinates': 0,
      'bad-distance': 1,
      'missing-timestamp': 1,
    });
  });

  it('rejects a malformed payload before ingest instead of emitting an empty city', async () => {
    for (const payload of [null, 'nonsense', {}, { features: 'not-an-array' }]) {
      golemioFetchMock.mockResolvedValueOnce(payload);
      await expect(fetchTramSnapshots()).rejects.toThrow(GolemioNetworkError);
    }
  });

  it('passes signal + retries through to the client', async () => {
    const ctl = new AbortController();
    golemioFetchMock.mockResolvedValueOnce({ type: 'FeatureCollection', features: [] });
    await fetchTramSnapshots({ signal: ctl.signal, retries: 0 });
    expect(golemioFetchMock).toHaveBeenCalledWith(
      '/v2/vehiclepositions',
      expect.objectContaining({ signal: ctl.signal, retries: 0, priority: 0 }),
    );
  });
});
