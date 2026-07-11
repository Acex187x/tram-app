// Unit tests for src/lib/arrivals.ts — station grouping, the live arrivals
// board and itinerary wall-clock timing, over synthetic fixtures.

import {
  computeArrivals,
  computeItineraryTiming,
  formatEtaMinutes,
  MAX_ARRIVALS,
  scheduleTravelS,
  stationStops,
} from '@/lib/arrivals';
import type { PlannerLeg, RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec3 } from './helpers';

const BASE = 1_700_000_000_000;
const S = 1_000; // ms per second

/** Straight 1 km east-west line: Alpha(0m) → Beta(500m) → Gamma(1000m). */
function geoA(): RouteGeometry {
  return {
    ...makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, name: 'Alpha', arrivalMs: BASE, departureMs: BASE },
        { atM: 500, name: 'Beta', arrivalMs: BASE + 120 * S, departureMs: BASE + 130 * S },
        { atM: 1000, name: 'Gamma', arrivalMs: BASE + 240 * S },
      ],
    ),
    tripId: 'trip-a',
    line: '22',
    headsign: 'Gamma',
  };
}

/** Line 9 crossing at Beta: Beta(0m) → Delta(800m). */
function geoB(tripId: string, betaArrS: number, betaDepS: number, deltaArrS: number): RouteGeometry {
  return {
    ...makeGeometry(
      [
        [0, 0],
        [0, 800],
      ],
      [
        { atM: 0, name: 'Beta', arrivalMs: BASE + betaArrS * S, departureMs: BASE + betaDepS * S },
        { atM: 800, name: 'Delta', arrivalMs: BASE + deltaArrS * S },
      ],
    ),
    tripId,
    line: '9',
    headsign: 'Delta',
  };
}

function makeState(opts: {
  key: string;
  tripId: string;
  line: string;
  simDistM: number;
  delaySeconds?: number;
  headsign?: string;
  airConditioned?: boolean | null;
  registrationNumber?: number | null;
  isCanceled?: boolean;
}): TramPublicState {
  const snapshot: TramSnapshot = makeSnapshot({
    key: opts.key,
    tripId: opts.tripId,
    line: opts.line,
    headsign: opts.headsign ?? 'Somewhere',
    delaySeconds: opts.delaySeconds ?? 0,
    airConditioned: opts.airConditioned === undefined ? true : opts.airConditioned,
    registrationNumber:
      opts.registrationNumber === undefined ? Number(opts.key) || null : opts.registrationNumber,
    isCanceled: opts.isCanceled ?? false,
  });
  return {
    key: opts.key,
    snapshot,
    model: makeSpec3(),
    simDistM: opts.simDistM,
    simSpeedKmh: 20,
    position: [14.6, 50.05],
    bearing: 90,
    phase: 'cruise',
    nextStopName: null,
    nextStopEtaS: null,
    hasGeometry: true,
  };
}

// ── stationStops ─────────────────────────────────────────────────────────────

describe('stationStops', () => {
  it('groups all platforms of a name and collects serving lines sorted', () => {
    const geos = [geoA(), geoB('trip-b', 200, 210, 380)];
    const station = stationStops('beta', geos);
    expect(station).not.toBeNull();
    expect(station!.name).toBe('Beta');
    expect(station!.key).toBe('beta');
    expect(station!.lines).toEqual(['9', '22']);
    expect(station!.coordinates).toEqual(geos[0].stops[1].coordinates);
  });

  it('returns null for a station no loaded geometry mentions', () => {
    expect(stationStops('omega', [geoA()])).toBeNull();
  });

  it('matches diacritics-insensitively via normalized keys', () => {
    const geo = {
      ...makeGeometry(
        [
          [0, 0],
          [100, 0],
        ],
        [
          { atM: 0, name: 'Malostranská', arrivalMs: BASE },
          { atM: 100, name: 'Gamma', arrivalMs: BASE + 60 * S },
        ],
      ),
      tripId: 'trip-dia',
      line: '12',
    };
    const station = stationStops('malostranska', [geo]);
    expect(station?.name).toBe('Malostranská');
    expect(station?.lines).toEqual(['12']);
  });
});

// ── computeArrivals ──────────────────────────────────────────────────────────

describe('computeArrivals', () => {
  it('lists a tram approaching the station with schedule+delay ETA', () => {
    const geos = [geoA()];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 100, delaySeconds: 30 }),
    ];
    const now = BASE + 60 * S;
    const arrivals = computeArrivals('beta', states, geos, now);
    expect(arrivals).toHaveLength(1);
    // Beta scheduled BASE+120s, +30s delay, minus now (BASE+60s) → 90s.
    expect(arrivals[0].etaS).toBe(90);
    expect(arrivals[0].tramKey).toBe('9201');
    expect(arrivals[0].line).toBe('22');
    expect(arrivals[0].airConditioned).toBe(true);
    expect(arrivals[0].regNumber).toBe(9201);
    expect(arrivals[0].model.id).toBe('15t');
  });

  it('excludes trams that already passed the station', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 600 })];
    expect(computeArrivals('beta', states, [geoA()], BASE)).toHaveLength(0);
    // ...but the stop further down the line still counts.
    expect(computeArrivals('gamma', states, [geoA()], BASE)).toHaveLength(1);
  });

  it('includes a tram dwelling AT the station with eta floored to 0', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 500 })];
    const arrivals = computeArrivals('beta', states, [geoA()], BASE + 300 * S);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].etaS).toBe(0);
  });

  it('skips trams without loaded geometry and canceled trips', () => {
    const states = [
      makeState({ key: '1', tripId: 'trip-unknown', line: '22', simDistM: 0 }),
      makeState({ key: '2', tripId: 'trip-a', line: '22', simDistM: 0, isCanceled: true }),
    ];
    expect(computeArrivals('beta', states, [geoA()], BASE)).toHaveLength(0);
  });

  it('sorts by ETA and caps the board at MAX_ARRIVALS', () => {
    const geos = [geoA(), geoB('trip-b', 60, 70, 200)];
    const states: TramPublicState[] = [];
    for (let i = 0; i < MAX_ARRIVALS + 2; i++) {
      states.push(
        makeState({ key: `90${10 + i}`, tripId: 'trip-a', line: '22', simDistM: 100, delaySeconds: i * 60 }),
      );
    }
    states.push(makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }));
    const arrivals = computeArrivals('beta', states, geos, BASE);
    expect(arrivals).toHaveLength(MAX_ARRIVALS);
    // The line-9 tram (Beta at BASE+60s) beats every 22 (BASE+120s + delays).
    expect(arrivals[0].tramKey).toBe('8001');
    const etas = arrivals.map((a) => a.etaS);
    expect([...etas].sort((a, b) => a - b)).toEqual(etas);
  });
});

// ── computeItineraryTiming ───────────────────────────────────────────────────

function leg(line: string, from: string, to: string): PlannerLeg {
  return {
    line,
    fromStopId: `${from}-id`,
    fromStopName: from,
    toStopId: `${to}-id`,
    toStopName: to,
    stopCount: 1,
    coordinates: [],
  };
}

describe('computeItineraryTiming', () => {
  it('times a direct leg from the next live tram (delay-shifted)', () => {
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 0, delaySeconds: 60 }),
    ];
    const timing = computeItineraryTiming([leg('22', 'Alpha', 'Gamma')], states, [geoA()], BASE);
    expect(timing.legs).toHaveLength(1);
    const l = timing.legs[0];
    expect(l.tram?.key).toBe('9201');
    expect(l.tram?.airConditioned).toBe(true);
    // Departure = Alpha dep (BASE) + 60s delay; travel = Gamma arr − Alpha dep = 240s.
    expect(l.departureMs).toBe(BASE + 60 * S);
    expect(l.arrivalMs).toBe(BASE + 300 * S);
    expect(l.travelS).toBe(240);
    expect(timing.departureMs).toBe(l.departureMs);
    expect(timing.arrivalMs).toBe(l.arrivalMs);
  });

  it('falls back to schedule-only when the only tram already passed the from-stop', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 600 })];
    const timing = computeItineraryTiming([leg('22', 'Alpha', 'Beta')], states, [geoA()], BASE);
    const l = timing.legs[0];
    expect(l.tram).toBeNull();
    expect(l.departureMs).toBeNull();
    expect(l.arrivalMs).toBeNull();
    expect(l.travelS).toBe(120); // Beta arr − Alpha dep from the schedule
    expect(timing.departureMs).toBeNull();
  });

  it('chains transfers: picks the first connecting tram departing after arrival', () => {
    const geos = [geoA(), geoB('trip-b', 200, 210, 380), geoB('trip-b2', 500, 510, 680)];
    const states = [
      // Leg 1: delayed 120s → departs Alpha BASE+120s, arrives Beta BASE+240s.
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 0, delaySeconds: 120 }),
      // trip-b departs Beta at BASE+210s — BEFORE we arrive → must be skipped.
      makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }),
      // trip-b2 departs Beta at BASE+510s → the connection.
      makeState({ key: '8002', tripId: 'trip-b2', line: '9', simDistM: 0 }),
    ];
    const legs = [leg('22', 'Alpha', 'Beta'), leg('9', 'Beta', 'Delta')];
    const timing = computeItineraryTiming(legs, states, geos, BASE);

    expect(timing.legs[0].arrivalMs).toBe(BASE + 240 * S);
    expect(timing.legs[1].tram?.key).toBe('8002');
    expect(timing.legs[1].departureMs).toBe(BASE + 510 * S);
    expect(timing.legs[1].arrivalMs).toBe(BASE + 680 * S);
    expect(timing.arrivalMs).toBe(BASE + 680 * S);
  });

  it('floors a live departure at now when the schedule slot is in the past', () => {
    const now = BASE + 60 * S; // Alpha departure (BASE) already passed, tram still before it
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 0 })];
    const timing = computeItineraryTiming([leg('22', 'Alpha', 'Beta')], states, [geoA()], now);
    expect(timing.legs[0].departureMs).toBe(now);
    expect(timing.legs[0].arrivalMs).toBe(now + 120 * S);
  });

  it('stops chaining wall times after a schedule-only leg', () => {
    const geos = [geoA(), geoB('trip-b', 200, 210, 380)];
    // No live tram on 22; a live tram on 9 exists but leg 1 has no wall time.
    const states = [makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 })];
    const legs = [leg('22', 'Alpha', 'Beta'), leg('9', 'Beta', 'Delta')];
    const timing = computeItineraryTiming(legs, states, geos, BASE);
    expect(timing.legs[0].tram).toBeNull();
    expect(timing.legs[0].travelS).toBe(120);
    expect(timing.legs[1].tram).toBeNull(); // unknown wait → schedule-only too
    expect(timing.legs[1].travelS).toBe(170);
    expect(timing.arrivalMs).toBeNull();
  });
});

// ── small helpers ────────────────────────────────────────────────────────────

describe('scheduleTravelS', () => {
  it('reads the minimum scheduled travel across line variants', () => {
    const geos = [geoB('trip-b', 200, 210, 380), geoB('trip-b2', 500, 510, 700)];
    expect(scheduleTravelS('9', 'beta', 'delta', geos)).toBe(170);
    expect(scheduleTravelS('9', 'delta', 'beta', geos)).toBeNull(); // wrong direction
    expect(scheduleTravelS('22', 'beta', 'delta', geos)).toBeNull(); // wrong line
  });
});

describe('formatEtaMinutes', () => {
  it('formats now / minutes', () => {
    expect(formatEtaMinutes(0)).toBe('now');
    expect(formatEtaMinutes(44)).toBe('now');
    expect(formatEtaMinutes(45)).toBe('1 min');
    expect(formatEtaMinutes(130)).toBe('2 min');
  });
});
