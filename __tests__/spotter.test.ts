// Unit tests for src/lib/spotter.ts — target acquisition, hysteresis, the
// departed detector and the missing-timeout, over synthetic fixtures
// (mirrors the arrivals.test.ts fixture style).

import {
  DEPARTED_PAST_M,
  MISSING_TIMEOUT_MS,
  PREEMPT_HOLDOFF_MS,
  PREEMPT_MARGIN_S,
  REEVAL_INTERVAL_MS,
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

/**
 * Line 9 APPROACHING Beta: Delta(0m, dep BASE) → Beta(800m, arr BASE+100s).
 * A tram at simDistM d has a position ETA to Beta of (100 − d/8) seconds,
 * so rival ETAs can be dialed in precisely for the preemption tests.
 */
function geoC(tripId = 'trip-c'): RouteGeometry {
  return {
    ...makeGeometry(
      [
        [0, 800],
        [0, 0],
      ],
      [
        { atM: 0, name: 'Delta', arrivalMs: BASE, departureMs: BASE },
        { atM: 800, name: 'Beta', arrivalMs: BASE + 100 * S },
      ],
    ),
    tripId,
    line: '9',
    headsign: 'Beta',
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
    acquiredMs: BASE,
    lastSeenMs: BASE,
    lastReevalMs: BASE,
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
      acquiredMs: BASE,
      lastSeenMs: BASE,
      lastReevalMs: BASE,
    });
    // Position-based chip ETA: the 9 is physically AT the platform → 0.
    expect(res.target).toEqual({ tramKey: '8001', line: '9', etaS: 0 });
  });

  it('acquires the PHYSICALLY closest tram, not the stalest-delay schedule ETA', () => {
    // The 22 is late: its delay-shifted schedule ETA clamped to 0 (schedule
    // time long past, feed delay lagging), but it is physically 300 m short
    // of Beta. The 9 is 80 m out (position ETA 10 s). The board's schedule
    // ranking would put the 22 first; the spotter must pick the 9.
    const geos = [geoA(), geoC()];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      makeState({ key: '8001', tripId: 'trip-c', line: '9', simDistM: 720 }),
    ];
    const res = stepSpotter(null, 'beta', states, geos, BASE + 300 * S);
    expect(res.event).toBe('acquired');
    expect(res.tracking?.targetKey).toBe('8001');
    expect(res.target?.etaS).toBe(10);
  });

  it('stays waiting (event none) when nobody has the station ahead', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 900 })];
    const res = stepSpotter(null, 'beta', states, [geoA()], BASE);
    expect(res).toEqual({ tracking: null, event: 'none', target: null });
  });
});

// ── hysteresis ───────────────────────────────────────────────────────────────

describe('stepSpotter — hysteresis & preemption', () => {
  it('holds the target within the re-eval interval, even if a sooner tram appears', () => {
    const geos = [geoA(), geoB('trip-b', 30, 40, 200)];
    const prev = betaTracking(); // holding the 22, Beta @ +120s, reeval @ BASE
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      // Sooner, but the re-eval clock hasn't elapsed → no preemption yet.
      makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }),
    ];
    const res = stepSpotter(prev, 'beta', states, geos, BASE + (REEVAL_INTERVAL_MS - 1));
    expect(res.event).toBe('none');
    expect(res.tracking?.targetKey).toBe('9201');
    expect(res.tracking?.lastReevalMs).toBe(BASE); // clock not reset
  });

  it('preempts to a meaningfully-sooner tram once the re-eval interval elapses', () => {
    const geos = [geoA(), geoB('trip-b', 30, 40, 200)];
    const prev = betaTracking(); // 22, Beta @ +120s
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      // The 9 reaches Beta ~90 s sooner — well past PREEMPT_MARGIN_S.
      makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 }),
    ];
    const res = stepSpotter(prev, 'beta', states, geos, BASE + 10 * S);
    expect(res.event).toBe('switched');
    expect(res.tracking?.targetKey).toBe('8001');
    expect(res.tracking?.line).toBe('9');
    expect(res.tracking?.lastReevalMs).toBe(BASE + 10 * S);
  });

  it('does NOT preempt when the rival is within the margin (no churn)', () => {
    // Held 22 at 200 m → position ETA 72 s; the 9 at 248 m of geoC → 69 s.
    // Only 3 s sooner (< PREEMPT_MARGIN_S) — held through the re-rank.
    const geos = [geoA(), geoC()];
    const prev = betaTracking();
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      makeState({ key: '8001', tripId: 'trip-c', line: '9', simDistM: 248 }),
    ];
    const res = stepSpotter(prev, 'beta', states, geos, BASE + 10 * S);
    expect(res.event).toBe('none');
    expect(res.tracking?.targetKey).toBe('9201');
    expect(res.tracking?.lastReevalMs).toBe(BASE + 10 * S); // re-ranked, held
  });

  it('preempts a tram arriving just over the margin sooner (old 20 s margin missed these)', () => {
    // Held 22 → position ETA 72 s; the 9 at 320 m of geoC → 60 s: 12 s sooner.
    // Past PREEMPT_MARGIN_S (6 s) but inside the old 20 s blind window.
    const geos = [geoA(), geoC()];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      makeState({ key: '8001', tripId: 'trip-c', line: '9', simDistM: 320 }),
    ];
    const res = stepSpotter(betaTracking(), 'beta', states, geos, BASE + 10 * S);
    expect(res.event).toBe('switched');
    expect(res.tracking?.targetKey).toBe('8001');
    expect(res.target?.etaS).toBe(60);
  });

  it('still preempts when the held schedule ETA is clamped to 0 (late tram, laggy delay)', () => {
    // now = BASE+300s: the held 22's delay-shifted schedule time is long past
    // (schedule ETA 0) while it is physically 300 m short of Beta (72 s).
    // Under schedule ETAs no rival could EVER beat 0 + margin — the original
    // "another tram arrives first" bug. Position ETAs keep preemption alive:
    // the 9 is 40 m out (5 s) and takes over.
    const geos = [geoA(), geoC()];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      makeState({ key: '8001', tripId: 'trip-c', line: '9', simDistM: 760 }),
    ];
    const res = stepSpotter(betaTracking(), 'beta', states, geos, BASE + 300 * S);
    expect(res.event).toBe('switched');
    expect(res.tracking?.targetKey).toBe('8001');
    expect(res.target?.etaS).toBe(5);
  });

  it('holds through the post-acquisition holdoff even against a much sooner rival', () => {
    // 2 s after acquiring (≥ re-eval interval, < PREEMPT_HOLDOFF_MS) a rival
    // physically at the platform does not yet steal the camera.
    const geos = [geoA(), geoC()];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
      makeState({ key: '8001', tripId: 'trip-c', line: '9', simDistM: 800 }),
    ];
    const res = stepSpotter(betaTracking(), 'beta', states, geos, BASE + 2 * S);
    expect(BASE + 2 * S - BASE).toBeLessThan(PREEMPT_HOLDOFF_MS);
    expect(res.event).toBe('none');
    expect(res.tracking?.targetKey).toBe('9201');
    expect(res.tracking?.lastReevalMs).toBe(BASE + 2 * S); // clock still resets
  });

  it('does not churn between two near-equal trams across repeated re-ranks', () => {
    // Held 72 s; the rival's position ETA jitters 67–69 s (1–5 s sooner, all
    // within the 6 s margin) — the spotter must hold the 22 every step.
    const geos = [geoA(), geoC()];
    let tracking: SpotterTracking | null = betaTracking();
    const rivalDistM = [264, 248, 256, 260]; // ETAs 67, 69, 68, 67.5→68 s
    rivalDistM.forEach((d, i) => {
      const states = [
        makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200 }),
        makeState({ key: '8001', tripId: 'trip-c', line: '9', simDistM: d }),
      ];
      const res = stepSpotter(tracking, 'beta', states, geos, BASE + (10 + i) * S);
      expect(res.event).toBe('none');
      expect(res.tracking?.targetKey).toBe('9201');
      tracking = res.tracking;
    });
    expect(PREEMPT_MARGIN_S).toBeGreaterThanOrEqual(5); // guard: margin stays sane
  });

  it('held ETA follows the tram’s physical position, not the laggy feed delay', () => {
    // Feed claims 300 s of delay, but the tram is physically 300 m from Beta:
    // position ETA 72 s. The old schedule+delay ETA would have read 360 s.
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 200, delaySeconds: 300 }),
    ];
    const res = stepSpotter(betaTracking(), 'beta', states, [geoA()], BASE + 60 * S);
    expect(res.target).toEqual({ tramKey: '9201', line: '22', etaS: 72 });
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
