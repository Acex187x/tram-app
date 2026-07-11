/// <reference types="jest" />
//
// TramPublicState.projectedObservedDistM: the last AVL fix dead-reckoned
// forward by the SAME physics as the main sim (speed profile, stops/dwell,
// pace capped by the schedule-projected observation). It must ADVANCE smoothly
// between polls and JUMP (forward or back) when a new fix arrives — that jump
// is the accepted live-mode UX. Null without geometry.

import { TramEngine } from '@/lib/engine/engine';
import { V_MAX_MS } from '@/lib/engine/speedProfile';
import type { TramPublicState } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

const T0 = 1_000_000_000_000;
const STEP_MS = 100;

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

function projected(engine: TramEngine, key: string, nowMs: number): number {
  const p = state(engine, key, nowMs).projectedObservedDistM;
  if (p === null) throw new Error('projection unexpectedly null');
  return p;
}

describe('projectedObservedDistM', () => {
  // Straight 3 km, 10 m/s schedule pace, no intermediate stops.
  const makeGeo = () =>
    makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 20_000 },
        { atM: 3000, arrivalMs: T0 + 280_000, isTerminal: true },
      ],
    );

  it('seeds at the fresh fix and advances smoothly between polls', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);

    // A fresh fix (observedAtMs == now) projects to itself.
    expect(projected(engine, 't', T0)).toBeCloseTo(100, 0);

    // Between polls the projection integrates physics: monotone, per-tick
    // steps bounded by the network max speed — no jumps.
    let prev = projected(engine, 't', T0);
    run(engine, T0, 10, (now) => {
      const p = projected(engine, 't', now);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p - prev).toBeLessThanOrEqual(V_MAX_MS * (STEP_MS / 1000) + 1e-6);
      prev = p;
    });
    expect(prev).toBeGreaterThan(110); // actually moved
  });

  it('is dead-reckoned independently of the (smoothed) sim position', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 10);
    const s = state(engine, 't', now);
    // Both advance, but they are separate integrations (sim trails its target).
    expect(s.projectedObservedDistM).not.toBeNull();
    expect(s.simDistM).toBeGreaterThan(100);
    expect(s.projectedObservedDistM!).toBeGreaterThan(100);
  });

  it('JUMPS backward when a new fix arrives behind the projection', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 500, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 10);
    const before = projected(engine, 't', now);
    expect(before).toBeGreaterThan(500);

    // Fresh fix says the tram is actually back at 450.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 450, observedAtMs: now })], () => geo, now);
    const after = projected(engine, 't', now);
    expect(after).toBeCloseTo(450, 0);
    expect(after).toBeLessThan(before); // jumped BACK — accepted live-mode UX
  });

  it('JUMPS forward when a new fix arrives ahead of the projection', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 5);
    const before = projected(engine, 't', now);

    engine.ingest(
      [makeSnapshot({ key: 't', shapeDistM: before + 300, observedAtMs: now })],
      () => geo,
      now,
    );
    expect(projected(engine, 't', now)).toBeCloseTo(before + 300, 0);
  });

  it('does NOT re-seed when the poll repeats the same (stale) fix', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    const snap = makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 });
    engine.ingest([snap], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 8);
    const before = projected(engine, 't', now);

    // Same observedAtMs + shapeDistM (vehicle didn't report since): the
    // integration continues instead of snapping back to a re-projection.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, now);
    expect(projected(engine, 't', now)).toBe(before);
  });

  it('dwells at stops along the way (same physics as the sim)', () => {
    // Stop at 150 m with a 20 s dwell between the fix (100 m) and the road ahead.
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 150, arrivalMs: T0 + 15_000, departureMs: T0 + 35_000, dwellSeconds: 20 },
        { atM: 3000, arrivalMs: T0 + 600_000, isTerminal: true },
      ],
    );
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);

    let stationaryTicks = 0;
    let prev = projected(engine, 't', T0);
    run(engine, T0, 90, (now) => {
      const p = projected(engine, 't', now);
      expect(p).toBeGreaterThanOrEqual(prev);
      if (p === prev && p >= 147 && p <= 150.01) stationaryTicks++;
      prev = p;
    });
    // Held at the stop for (at least) most of the 20 s dwell…
    expect(stationaryTicks).toBeGreaterThanOrEqual(150); // ≥ 15 s of 100 ms ticks
    // …and departed again afterwards.
    expect(prev).toBeGreaterThan(160);
  });

  it('is null without geometry', () => {
    const engine = makeEngine();
    engine.ingest(
      [makeSnapshot({ key: 'raw', shapeDistM: 42, observedAtMs: T0 })],
      () => undefined,
      T0,
    );
    engine.tick(T0);
    expect(state(engine, 'raw', T0).projectedObservedDistM).toBeNull();
  });
});

describe('projection cadence (setProjectionCadence)', () => {
  const makeGeo = () =>
    makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 20_000 },
        { atM: 3000, arrivalMs: T0 + 280_000, isTerminal: true },
      ],
    );

  function seed(engine: TramEngine): void {
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
  }

  it("'coarse' advances the projection at ~500 ms steps while the main sim stays per-tick", () => {
    const engine = makeEngine();
    engine.setProjectionCadence('coarse');
    seed(engine);

    let projChanges = 0;
    let simChanges = 0;
    let prevProj = projected(engine, 't', T0);
    let prevSim = state(engine, 't', T0).simDistM;
    run(engine, T0, 10, (now) => {
      const p = projected(engine, 't', now);
      expect(p).toBeGreaterThanOrEqual(prevProj); // still monotone
      if (p !== prevProj) projChanges++;
      prevProj = p;
      const sd = state(engine, 't', now).simDistM;
      if (sd !== prevSim) simChanges++;
      prevSim = sd;
    });

    // 100 ticks / 10 s: the projection moved ~every 5th tick (500 ms cadence)…
    expect(projChanges).toBeGreaterThanOrEqual(15);
    expect(projChanges).toBeLessThanOrEqual(25);
    // …while the main (rendered) sim advanced essentially every tick.
    expect(simChanges).toBeGreaterThan(90);
  });

  it("'coarse' integrates the same total motion as 'full' (batched, not dropped)", () => {
    const fullEngine = makeEngine();
    const coarseEngine = makeEngine();
    coarseEngine.setProjectionCadence('coarse');
    seed(fullEngine);
    seed(coarseEngine);

    const now = T0 + 10_000;
    run(fullEngine, T0, 10);
    run(coarseEngine, T0, 10);
    const pFull = projected(fullEngine, 't', now);
    const pCoarse = projected(coarseEngine, 't', now);
    expect(pFull).toBeGreaterThan(110);
    // Same physics over the same wall time; only integration granularity
    // differs (≤ 0.25 s substeps vs 0.1 s ticks) plus at most one pending
    // not-yet-due coarse interval (< 500 ms of motion).
    expect(Math.abs(pFull - pCoarse)).toBeLessThan(8);
  });

  it('switching coarse → full integrates the pending gap instead of dropping it', () => {
    const engine = makeEngine();
    engine.setProjectionCadence('coarse');
    seed(engine);
    let now = run(engine, T0, 5);
    engine.setProjectionCadence('full');
    now = run(engine, now, 5);

    const control = makeEngine();
    seed(control);
    run(control, T0, 10);
    expect(Math.abs(projected(engine, 't', now) - projected(control, 't', now))).toBeLessThan(5);
  });
});
