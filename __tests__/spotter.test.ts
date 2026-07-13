// Unit tests for src/lib/spotter.ts — target acquisition, hysteresis, the
// departed detector and the missing-timeout, over synthetic fixtures
// (mirrors the arrivals.test.ts fixture style).

import {
  DEPARTED_PAST_M,
  MISSING_TIMEOUT_MS,
  stepSpotter,
  type SpotterTracking,
} from '@/lib/spotter';
import type { RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec3 } from './helpers';

const BASE = 1_700_000_000_000;
const S = 1_000; // ms per second

/** Straight 1 km line 22: Alpha(0m) → Beta(500m) → Gamma(1000m). */
function geoA(tripId = 'trip-a'): RouteGeometry {
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
    tripId,
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
  isCanceled?: boolean;
}): TramPublicState {
  const snapshot: TramSnapshot = makeSnapshot({
    key: opts.key,
    tripId: opts.tripId,
    line: opts.line,
    delaySeconds: opts.delaySeconds ?? 0,
    registrationNumber: Number(opts.key) || null,
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
    observedPosition: [14.6, 50.05],
    observedBearing: 90,
    deviationM: 0,
    projectedObservedDistM: opts.simDistM,
    nextStopName: null,
    nextStopEtaS: null,
    hasGeometry: true,
  };
}

/** A tracking as stepSpotter would produce for the geoA tram heading to Beta. */
function betaTracking(overrides: Partial<SpotterTracking> = {}): SpotterTracking {
  return {
    targetKey: '9201',
    line: '22',
    tripId: 'trip-a',
    stopDistM: 500,
    stopArrivalMs: BASE + 120 * S,
    lastSeenMs: BASE,
    ...overrides,
  };
}

// ── acquisition ──────────────────────────────────────────────────────────────

describe('stepSpotter — acquisition', () => {
  it('acquires the soonest-arriving tram with full tracking anchors', () => {
    const geos = [geoA(), geoB('trip-b', 60, 70, 200)];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 100 }), // Beta @ +120s
      makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }), // Beta @ +60s
    ];
    const res = stepSpotter(null, 'beta', states, geos, BASE);
    expect(res.event).toBe('acquired');
    expect(res.tracking).toEqual({
      targetKey: '8001',
      line: '9',
      tripId: 'trip-b',
      stopDistM: 0,
      stopArrivalMs: BASE + 60 * S,
      lastSeenMs: BASE,
    });
    expect(res.target).toEqual({ tramKey: '8001', line: '9', etaS: 60 });
  });

  it('stays waiting (event none) when nobody has the station ahead', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 900 })];
    const res = stepSpotter(null, 'beta', states, [geoA()], BASE);
    expect(res).toEqual({ tracking: null, event: 'none', target: null });
  });
});

// ── hysteresis ───────────────────────────────────────────────────────────────

describe('stepSpotter — hysteresis', () => {
  it('never re-ranks a held target, even when a sooner candidate appears', () => {
    const geos = [geoA(), geoB('trip-b', 30, 40, 200)];
    const prev = betaTracking(); // holding the 22, Beta @ +120s
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      // The 9 would arrive at Beta 90 s sooner — must NOT steal the target.
      makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }),
    ];
    const res = stepSpotter(prev, 'beta', states, geos, BASE + 10 * S);
    expect(res.event).toBe('none');
    expect(res.tracking?.targetKey).toBe('9201');
    expect(res.tracking?.lastSeenMs).toBe(BASE + 10 * S); // seen-refresh
  });

  it('applies the live delay to the held target ETA', () => {
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200, delaySeconds: 30 }),
    ];
    const res = stepSpotter(betaTracking(), 'beta', states, [geoA()], BASE + 60 * S);
    // Beta @ BASE+120s, +30s delay, now BASE+60s → 90s.
    expect(res.target).toEqual({ tramKey: '9201', line: '22', etaS: 90 });
  });

  it('keeps a tram dwelling at the stop with ETA floored to 0', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 500 })];
    const res = stepSpotter(betaTracking(), 'beta', states, [geoA()], BASE + 300 * S);
    expect(res.event).toBe('none');
    expect(res.target?.etaS).toBe(0);
  });
});

// ── departed detector ────────────────────────────────────────────────────────

describe('stepSpotter — departed', () => {
  it('keeps the target exactly at the departed boundary, drops it 1 m past', () => {
    const at = (simDistM: number) =>
      stepSpotter(
        betaTracking(),
        'beta',
        [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM })],
        [geoA()],
        BASE + 140 * S,
      );
    expect(at(500 + DEPARTED_PAST_M).event).toBe('none');
    expect(at(500 + DEPARTED_PAST_M + 1).event).toBe('lost'); // nobody else inbound
  });

  it('switches to the next arrival when the target departs', () => {
    const geos = [geoA(), geoB('trip-b', 200, 210, 380)];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 600 }), // 100 m past Beta
      makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }),
    ];
    const res = stepSpotter(betaTracking(), 'beta', states, geos, BASE + 140 * S);
    expect(res.event).toBe('switched');
    expect(res.tracking?.targetKey).toBe('8001');
    expect(res.target?.line).toBe('9');
  });

  it('treats a trip change as departed and excludes the tram for that step only', () => {
    // Same physical tram rolled onto a fresh trip (distances reset) — the
    // old visit is over; alone in the data it goes to waiting this step...
    const geos = [geoA(), geoA('trip-a2')];
    const states = [makeState({ key: '9201', tripId: 'trip-a2', line: '22', simDistM: 0 })];
    const res = stepSpotter(betaTracking(), 'beta', states, geos, BASE + 600 * S);
    expect(res.event).toBe('lost');
    expect(res.tracking).toBeNull();
    // ...and is legitimately re-acquired on the new trip the next step.
    const res2 = stepSpotter(null, 'beta', states, geos, BASE + 601 * S);
    expect(res2.event).toBe('acquired');
    expect(res2.tracking?.tripId).toBe('trip-a2');
  });

  it('drops a target whose trip gets canceled', () => {
    const geos = [geoA(), geoB('trip-b', 200, 210, 380)];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200, isCanceled: true }),
      makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }),
    ];
    const res = stepSpotter(betaTracking(), 'beta', states, geos, BASE + 10 * S);
    expect(res.event).toBe('switched');
    expect(res.tracking?.targetKey).toBe('8001');
  });

  it('goes lost with no successor and reports no target', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 700 })];
    const res = stepSpotter(betaTracking(), 'beta', states, [geoA()], BASE + 150 * S);
    expect(res).toEqual({ tracking: null, event: 'lost', target: null });
  });
});

// ── missing-from-feed timeout ────────────────────────────────────────────────

describe('stepSpotter — missing target', () => {
  it('holds a briefly-missing target (≤ timeout) with a schedule-only ETA', () => {
    const prev = betaTracking({ lastSeenMs: BASE });
    const res = stepSpotter(prev, 'beta', [], [geoA()], BASE + MISSING_TIMEOUT_MS);
    expect(res.event).toBe('none');
    expect(res.tracking).toBe(prev); // unchanged — lastSeenMs NOT refreshed
    // Beta @ BASE+120s − now (BASE+15s) = 105s, delay unknown while missing.
    expect(res.target).toEqual({ tramKey: '9201', line: '22', etaS: 105 });
  });

  it('refreshes lastSeenMs when the target reappears within the timeout', () => {
    const prev = betaTracking({ lastSeenMs: BASE });
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 300 })];
    const res = stepSpotter(prev, 'beta', states, [geoA()], BASE + 10 * S);
    expect(res.event).toBe('none');
    expect(res.tracking?.lastSeenMs).toBe(BASE + 10 * S);
  });

  it('switches to the next arrival once missing longer than the timeout', () => {
    const geos = [geoA(), geoB('trip-b', 200, 210, 380)];
    const states = [makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 })];
    const res = stepSpotter(
      betaTracking({ lastSeenMs: BASE }),
      'beta',
      states,
      geos,
      BASE + MISSING_TIMEOUT_MS + 1,
    );
    expect(res.event).toBe('switched');
    expect(res.tracking?.targetKey).toBe('8001');
  });

  it('goes lost when missing past the timeout with nobody else inbound', () => {
    const res = stepSpotter(
      betaTracking({ lastSeenMs: BASE }),
      'beta',
      [],
      [geoA()],
      BASE + MISSING_TIMEOUT_MS + 1,
    );
    expect(res).toEqual({ tracking: null, event: 'lost', target: null });
  });
});
