/// <reference types="jest" />
//
// Junction conflict yield (complex-junction collisions, 2026-07-19): trams on
// CROSSING shapes (different bearings — invisible to the same-direction
// cross-shape queue) must not drive visually through each other's sides at a
// junction. The engine discovers the crossing point at ingest and makes the
// tram that is FARTHER from it yield — a braking-envelope speed cap toward a
// hold point short of the conflict zone. Strictly speed-only: no sM rewrites,
// no teleports; the trams separate in TIME. While the crossing is contested,
// both trams additionally pass it at the moderate SWITCH_SLOW_V_MS cap
// (switch/junction slow-down heuristic).

import {
  JUNCTION_ZONE_M,
  SWITCH_SLOW_V_MS,
  TramEngine,
} from '@/lib/engine/engine';
import type { RouteGeometry, TramPublicState } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

const T0 = 1_000_000_000_000;
const STEP_MS = 100;
const LEN = makeSpec1().totalLengthM;

function makeEngine(): TramEngine {
  return new TramEngine({
    resolveModel: () => makeSpec1(),
    isDaytime: () => false,
    isCoupled: () => false,
  });
}

function run(
  engine: TramEngine,
  fromMs: number,
  seconds: number,
  cb?: (nowMs: number) => void,
): number {
  const steps = Math.round((seconds * 1000) / STEP_MS);
  let now = fromMs;
  for (let i = 0; i < steps; i++) {
    now += STEP_MS;
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

/** Eastbound 600 m shape crossing shape-B at world (300, 0). */
function eastboundGeo(departedAgoS: number): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [600, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - departedAgoS * 1000 },
      { atM: 600, arrivalMs: T0 - departedAgoS * 1000 + 86_000, isTerminal: true }, // ~7 m/s
    ],
  );
}

/** Northbound 600 m shape (x = 300), crossing the eastbound one at its 300 m mark. */
function northboundGeo(departedAgoS: number): RouteGeometry {
  return {
    ...makeGeometry(
      [
        [300, -300],
        [300, 300],
      ],
      [
        { atM: 0, arrivalMs: T0 - departedAgoS * 1000 },
        { atM: 600, arrivalMs: T0 - departedAgoS * 1000 + 86_000, isTerminal: true }, // ~7 m/s
      ],
    ),
    tripId: 'trip-B',
    shapeId: 'shape-B',
    line: '22',
  };
}

describe('junction conflict yield (crossing shapes)', () => {
  it('the farther tram yields — they cross in sequence, never overlapping on the junction', () => {
    // A (eastbound) is 60 m out, B (northbound) 70 m out — without a yield
    // both bodies would occupy the crossing within the same few seconds.
    const geoA = eastboundGeo(240 / 7);
    const geoB = northboundGeo(230 / 7);
    const resolve = (tripId: string) => (tripId === 'trip-B' ? geoB : geoA);
    const engine = makeEngine();
    engine.ingest(
      [
        makeSnapshot({ key: 'A', shapeDistM: 240, observedAtMs: T0 }),
        makeSnapshot({ key: 'B', shapeDistM: 230, observedAtMs: T0, tripId: 'trip-B', line: '22' }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);

    let prevA = -Infinity;
    let prevB = -Infinity;
    let backwardJump = 0;
    let tPassA = 0;
    let tPassB = 0;
    let minVBWhileACrossing = Infinity;
    let maxVAOnJunction = 0;
    const end = run(engine, T0, 45, (now) => {
      const sA = state(engine, 'A', now).simDistM;
      const sB = state(engine, 'B', now).simDistM;
      // Speed-only guarantee: neither tram is ever moved backwards.
      backwardJump = Math.max(backwardJump, prevA - sA, prevB - sB);
      prevA = sA;
      prevB = sB;
      // THE invariant: both bodies never cover the crossing simultaneously.
      const aOn = sA >= 299 && sA - LEN <= 301;
      const bOn = sB >= 299 && sB - LEN <= 301;
      expect(aOn && bOn).toBe(false);
      if (tPassA === 0 && sA >= 300) tPassA = now;
      if (tPassB === 0 && sB >= 300) tPassB = now;
      // While A's body is around the junction, the yielder holds (brakes to
      // a near-stand at the hold point instead of driving in).
      if (aOn) minVBWhileACrossing = Math.min(minVBWhileACrossing, state(engine, 'B', now).simSpeedKmh);
      // Switch slow-down: A passes the contested crossing moderately.
      if (sA >= 285 && sA <= 310) {
        maxVAOnJunction = Math.max(maxVAOnJunction, state(engine, 'A', now).simSpeedKmh / 3.6);
      }
    });

    expect(backwardJump).toBeLessThanOrEqual(1e-6);
    // A (closer) crossed first; B yielded and crossed after.
    expect(tPassA).toBeGreaterThan(0);
    expect(tPassB).toBeGreaterThan(tPassA);
    // The yielder genuinely braked while the priority tram crossed…
    expect(minVBWhileACrossing).toBeLessThan(4); // km/h — near-stand at the hold
    // …and was released afterwards: both are well past the junction.
    expect(state(engine, 'A', end).simDistM).toBeGreaterThan(340);
    expect(state(engine, 'B', end).simDistM).toBeGreaterThan(340);
    // Contested-junction slow-down: moderate pass, envelope-smooth (small
    // per-substep accel overshoot above the cap is the only slack).
    expect(maxVAOnJunction).toBeLessThanOrEqual(SWITCH_SLOW_V_MS + 0.5);
  });

  it('the yielder holds clear of the zone, not merely short of the crossing point', () => {
    const geoA = eastboundGeo(240 / 7);
    const geoB = northboundGeo(230 / 7);
    const resolve = (tripId: string) => (tripId === 'trip-B' ? geoB : geoA);
    const engine = makeEngine();
    engine.ingest(
      [
        makeSnapshot({ key: 'A', shapeDistM: 240, observedAtMs: T0 }),
        makeSnapshot({ key: 'B', shapeDistM: 230, observedAtMs: T0, tripId: 'trip-B', line: '22' }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);
    run(engine, T0, 12, (now) => {
      const sA = state(engine, 'A', now).simDistM;
      const sB = state(engine, 'B', now).simDistM;
      // Until A's tail clears the junction, B's head stays out of the zone
      // (small envelope-integration slack only).
      if (sA - LEN <= 301) {
        expect(sB).toBeLessThanOrEqual(300 - JUNCTION_ZONE_M + 1.5);
      }
    });
  });

  it('a priority tram standing OUTSIDE the zone (dwelling short of the junction) blocks nobody', () => {
    // A dwells at a platform 30 m before the crossing (departure far in the
    // future); B on the crossing shape must pass instead of waiting forever.
    const geoA: RouteGeometry = makeGeometry(
      [
        [0, 0],
        [600, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 120_000 },
        { atM: 270, arrivalMs: T0 - 5_000, departureMs: T0 + 300_000 },
        { atM: 600, arrivalMs: T0 + 400_000, isTerminal: true },
      ],
    );
    const geoB = northboundGeo(230 / 7);
    const resolve = (tripId: string) => (tripId === 'trip-B' ? geoB : geoA);
    const engine = makeEngine();
    engine.ingest(
      [
        makeSnapshot({
          key: 'A',
          shapeDistM: 270,
          observedAtMs: T0,
          statePosition: 'at_stop',
          lastStopSequence: geoA.stops[1].sequence,
        }),
        makeSnapshot({ key: 'B', shapeDistM: 230, observedAtMs: T0, tripId: 'trip-B', line: '22' }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);
    const end = run(engine, T0, 30);
    // A stayed dwelling at its platform…
    expect(state(engine, 'A', end).phase).toBe('dwell');
    expect(state(engine, 'A', end).simDistM).toBeCloseTo(270, 0);
    // …and B crossed the junction freely instead of holding at the zone edge.
    expect(state(engine, 'B', end).simDistM).toBeGreaterThan(340);
  });

  it('trams far from any crossing are not affected (no false yields on approach)', () => {
    // Both > 200 m from the crossing: the pair may exist, but neither the
    // hold envelope nor the switch cap binds at that distance — both cruise.
    const geoA = eastboundGeo(80 / 7);
    const geoB = northboundGeo(60 / 7);
    const resolve = (tripId: string) => (tripId === 'trip-B' ? geoB : geoA);
    const engine = makeEngine();
    engine.ingest(
      [
        makeSnapshot({ key: 'A', shapeDistM: 80, observedAtMs: T0 }),
        makeSnapshot({ key: 'B', shapeDistM: 60, observedAtMs: T0, tripId: 'trip-B', line: '22' }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);
    let minV = Infinity;
    run(engine, T0, 8, (now) => {
      const a = state(engine, 'A', now);
      const b = state(engine, 'B', now);
      if (a.simDistM > 100 && a.simDistM < 180) minV = Math.min(minV, a.simSpeedKmh / 3.6);
      if (b.simDistM > 100 && b.simDistM < 180) minV = Math.min(minV, b.simSpeedKmh / 3.6);
    });
    // Both kept cruising near the fresh-sim pace (~7.25 m/s), no phantom brake.
    expect(minV).toBeGreaterThan(6);
  });
});
