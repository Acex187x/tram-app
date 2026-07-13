/// <reference types="jest" />
//
// Substep time integration in TramEngine.tick() (audit 2026-07-13 P0): the
// engine used to clamp one tick's dt to 0.25 s, so the rideBackground 1 Hz
// keep-alive cadence simulated at QUARTER speed — corrupting simDist/lagM in
// every backgrounded ride recording. tick() now integrates the whole elapsed
// interval in ≤ 0.25 s substeps (whole fleet per substep, queue constraints
// after each), with a bounded catch-up budget and an explicit clock reset for
// true pause/resume:
//   • cadence convergence — 16/100/250/1000 ms ticks reach ~the same state;
//   • two-tram queues never overlap on a coarse cadence;
//   • a pause gap beyond MAX_TICK_CATCHUP_MS is dropped, not replayed;
//   • resetClock() makes the next tick an anchor (no integration at all).

import { MAX_TICK_CATCHUP_MS, QUEUE_GAP_M, TramEngine } from '@/lib/engine/engine';
import { V_MAX_MS } from '@/lib/engine/speedProfile';
import type { RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

const T0 = 1_000_000_000_000;
const LEN = makeSpec1().totalLengthM;
const EPS = 1e-6;

function makeEngine(): TramEngine {
  return new TramEngine({
    resolveModel: () => makeSpec1(),
    isDaytime: () => false,
    isCoupled: () => false,
  });
}

/** Tick the engine from fromMs for `seconds` at a fixed cadence. */
function runAt(
  engine: TramEngine,
  fromMs: number,
  seconds: number,
  cadenceMs: number,
  cb?: (nowMs: number) => void,
): number {
  const endMs = fromMs + seconds * 1000;
  let now = fromMs;
  while (now < endMs) {
    now = Math.min(now + cadenceMs, endMs);
    engine.tick(now);
    cb?.(now);
  }
  return now;
}

function state(engine: TramEngine, key: string, nowMs: number): TramPublicState {
  const s = engine.getState(key, nowMs);
  if (!s) throw new Error(`no state for ${key}`);
  return s;
}

/** Straight 3 km with a mid-route stop (exercises dwell entry across cadences). */
function fixtureGeo(): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [3000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - 100_000 },
      { atM: 500, arrivalMs: T0 + 55_000, departureMs: T0 + 70_000, dwellSeconds: 15 },
      { atM: 3000, arrivalMs: T0 + 400_000, isTerminal: true },
    ],
  );
}

function seedOne(engine: TramEngine, geo: RouteGeometry): void {
  engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
  engine.tick(T0); // arm the clock (anchor tick)
}

describe('tick cadence convergence (P0: no more quarter-speed background sim)', () => {
  const CADENCES = [16, 100, 250, 1000] as const;

  it('16/100/250/1000 ms cadences integrate ~the same 10 s of motion', () => {
    const finals = CADENCES.map((cadence) => {
      const engine = makeEngine();
      const geo = fixtureGeo();
      seedOne(engine, geo);
      const end = runAt(engine, T0, 10, cadence);
      return state(engine, 't', end);
    });

    const base = finals[0]; // 16 ms ≈ ground truth
    // Sanity: the tram actually moved a cruise-scale distance (the old clamp
    // yielded ~option/4 of it at 1000 ms cadence).
    expect(base.simDistM).toBeGreaterThan(140);
    for (const s of finals) {
      expect(Math.abs(s.simDistM - base.simDistM)).toBeLessThan(3);
      expect(Math.abs(s.simSpeedKmh - base.simSpeedKmh)).toBeLessThan(2);
      expect(s.phase).toBe(base.phase);
    }
  });

  it('the 1 Hz cadence is no longer 4× slow (regression form of the P0 bug)', () => {
    const fine = makeEngine();
    const coarse = makeEngine();
    const geo = fixtureGeo();
    seedOne(fine, geo);
    seedOne(coarse, geo);
    const end = T0 + 10_000;
    runAt(fine, T0, 10, 100);
    runAt(coarse, T0, 10, 1000);
    const fineDist = state(fine, 't', end).simDistM - 100;
    const coarseDist = state(coarse, 't', end).simDistM - 100;
    // The old clamp integrated only 2.5 of the 10 s at 1 Hz (ratio ≈ 0.25).
    expect(coarseDist / fineDist).toBeGreaterThan(0.95);
    expect(coarseDist / fineDist).toBeLessThan(1.05);
  });

  it('cadences converge through a dwell too (stop served at the same wall time)', () => {
    const finals = CADENCES.map((cadence) => {
      const engine = makeEngine();
      const geo = fixtureGeo();
      seedOne(engine, geo);
      // 150 s: reach the 500 m stop, dwell, depart — at every cadence.
      const end = runAt(engine, T0, 150, cadence);
      return state(engine, 't', end);
    });
    const base = finals[0];
    expect(base.simDistM).toBeGreaterThan(520); // departed the stop again
    for (const s of finals) {
      expect(Math.abs(s.simDistM - base.simDistM)).toBeLessThan(8);
      expect(s.phase).toBe(base.phase);
    }
  });

  it('live projections integrate full wall time at 1 Hz as well', () => {
    const fine = makeEngine();
    const coarse = makeEngine();
    const geo = fixtureGeo();
    seedOne(fine, geo);
    seedOne(coarse, geo);
    const end = T0 + 10_000;
    runAt(fine, T0, 10, 100);
    runAt(coarse, T0, 10, 1000);
    const pFine = state(fine, 't', end).projectedObservedDistM!;
    const pCoarse = state(coarse, 't', end).projectedObservedDistM!;
    expect(pFine).toBeGreaterThan(140);
    expect(Math.abs(pFine - pCoarse)).toBeLessThan(3);
  });
});

describe('queue constraints hold on a coarse cadence (whole-fleet substeps)', () => {
  it('a fast follower never overlaps its slow leader at 1000 ms ticks', () => {
    // Different trips on one shape: slow leader (~3 m/s schedule), fast
    // follower (~13 m/s schedule) starting 400 m behind — same fixture family
    // as engine-queue's catch-up test, but ticked at 1 Hz.
    const line: [number, number][] = [
      [0, 0],
      [3000, 0],
    ];
    const slow = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 3000, arrivalMs: T0 + 940_000, isTerminal: true },
    ]);
    const fast: RouteGeometry = {
      ...makeGeometry(line, [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 165_000, isTerminal: true },
      ]),
      tripId: 'trip-fast',
    };
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? fast : slow);
    const engine = makeEngine();
    engine.ingest(
      [
        makeSnapshot({ key: 'slow', shapeDistM: 400, observedAtMs: T0 }),
        makeSnapshot({ key: 'fast', shapeDistM: 0, observedAtMs: T0, tripId: 'trip-fast' }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);

    const clearance = LEN + QUEUE_GAP_M;
    let minGap = Infinity;
    const end = runAt(engine, T0, 150, 1000, (now) => {
      const gap = state(engine, 'slow', now).simDistM - state(engine, 'fast', now).simDistM;
      minGap = Math.min(minGap, gap);
      expect(gap).toBeGreaterThanOrEqual(clearance - EPS);
    });
    // The constraint was binding (the fast tram actually attached to the queue).
    const endGap = state(engine, 'slow', end).simDistM - state(engine, 'fast', end).simDistM;
    expect(minGap).toBeGreaterThanOrEqual(clearance - EPS);
    expect(endGap).toBeLessThan(clearance + 15);
  });
});

describe('catch-up budget and clock reset (pause gaps are not replayed)', () => {
  it('a multi-minute tick gap integrates at most MAX_TICK_CATCHUP_MS of motion', () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    seedOne(engine, geo);
    engine.tick(T0 + 1000); // normal tick, tram cruising
    const before = state(engine, 't', T0 + 1000).simDistM;

    const later = T0 + 1000 + 5 * 60_000; // 5 min "suspension" without resetClock
    engine.tick(later);
    const after = state(engine, 't', later).simDistM;
    const budgetCapM = (MAX_TICK_CATCHUP_MS / 1000) * V_MAX_MS;
    expect(after - before).toBeGreaterThan(0); // the trailing budget IS integrated
    expect(after - before).toBeLessThanOrEqual(budgetCapM + EPS);
  });

  it('resetClock() turns the next tick into an anchor — zero motion', () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    seedOne(engine, geo);
    engine.tick(T0 + 1000);
    const before = state(engine, 't', T0 + 1000).simDistM;

    engine.resetClock();
    const later = T0 + 61_000;
    engine.tick(later); // first tick after a true pause: anchors only
    expect(state(engine, 't', later).simDistM).toBe(before);

    // …and normal integration resumes from the anchor.
    engine.tick(later + 1000);
    const resumed = state(engine, 't', later + 1000).simDistM;
    expect(resumed).toBeGreaterThan(before);
    expect(resumed - before).toBeLessThanOrEqual(V_MAX_MS + EPS); // ~1 s of motion
  });
});
