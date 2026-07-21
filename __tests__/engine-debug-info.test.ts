/// <reference types="jest" />
//
// engine.getDebugInfo(key): the additive, on-demand debug view of a tram's
// INTERNAL sim state that drives the debug overlay. It must reflect the live
// physics (phase, speeds, caps, pace bias, error, and the active holds) and be
// undefined for unknown keys / hasSim=false without geometry. Diagnostics only
// — nothing here may influence the simulation or rendering.

import { TramEngine } from '@/lib/engine/engine';
import type { SimDebugInfo } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

const T0 = 1_000_000_000_000;

function makeEngine(): TramEngine {
  return new TramEngine({
    resolveModel: () => makeSpec1(),
    isDaytime: () => false,
    isCoupled: () => false,
  });
}

/** Straight 3 km, one intermediate stop, terminal at the end. */
function makeGeo() {
  return makeGeometry(
    [
      [0, 0],
      [3000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 1500, arrivalMs: T0 + 120_000, departureMs: T0 + 140_000, dwellSeconds: 20 },
      { atM: 3000, arrivalMs: T0 + 600_000, isTerminal: true },
    ],
  );
}

/** L-bend: 1 km east, then a 90° right turn 1 km south — a tight corner at 1000 m. */
function makeCurvedGeo() {
  return makeGeometry(
    [
      [0, 0],
      [1000, 0],
      [1000, -1000],
    ],
    [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 2000, arrivalMs: T0 + 600_000, isTerminal: true },
    ],
  );
}

function run(engine: TramEngine, fromMs: number, seconds: number): number {
  let now = fromMs;
  for (let i = 0; i < seconds * 10; i++) {
    now += 100;
    engine.tick(now);
  }
  return now;
}

function dbg(engine: TramEngine, key: string, nowMs: number): SimDebugInfo {
  const d = engine.getDebugInfo(key, nowMs);
  if (!d) throw new Error(`no debug info for ${key}`);
  return d;
}

describe('getDebugInfo', () => {
  it('returns undefined for an unknown key', () => {
    expect(makeEngine().getDebugInfo('nope', T0)).toBeUndefined();
  });

  it('reports hasSim=false with raw AVL fields when there is no geometry', () => {
    const engine = makeEngine();
    engine.ingest(
      [makeSnapshot({ key: 'raw', shapeDistM: 42, observedAtMs: T0 - 5_000 })],
      () => undefined,
      T0,
    );
    engine.tick(T0);
    const d = dbg(engine, 'raw', T0);
    expect(d.hasSim).toBe(false);
    expect(d.phase).toBe('unknown');
    expect(d.obsDistM).toBeCloseTo(42, 0);
    expect(d.simDistM).toBeCloseTo(42, 0);
    expect(d.targetDistM).toBeNull();
    expect(d.errorM).toBeNull();
    expect(d.paceBias).toBeNull();
    expect(d.projDistM).toBeNull();
    // Fix age comes from the observation timestamp.
    expect(d.fixAgeMs).toBeCloseTo(5_000, -2);
  });

  it('exposes live physics for a cruising tram (speeds, caps, bias, error)', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 8);
    const d = dbg(engine, 't', now);

    expect(d.hasSim).toBe(true);
    expect(d.phase).toBe('cruise');
    expect(d.simDistM).toBeGreaterThan(100); // it moved
    expect(d.simSpeedKmh).toBeGreaterThan(0);
    // Both caps are exposed and positive (they are distinct limits: vAllowed is
    // the braking envelope, cruiseCap the zone/curve cruise ceiling).
    expect(d.cruiseCapKmh!).toBeGreaterThan(0);
    expect(d.vAllowedKmh!).toBeGreaterThan(0);
    expect(d.paceBias).toBeGreaterThan(0);
    // error e = target − sim, consistent with the exposed positions.
    expect(d.targetDistM).not.toBeNull();
    expect(d.errorM!).toBeCloseTo(d.targetDistM! - d.simDistM, 5);
  });

  it('flags a fix-pinned dwell hold at a stop', () => {
    const engine = makeEngine();
    // Start AT the intermediate stop (1500 m), feed says at_stop there.
    const geo = makeGeo();
    engine.ingest(
      [
        makeSnapshot({
          key: 't',
          shapeDistM: 1500,
          observedAtMs: T0,
          statePosition: 'at_stop',
          lastStopSequence: 2,
        }),
      ],
      () => geo,
      T0,
    );
    engine.tick(T0);
    const d = dbg(engine, 't', T0 + 1_000);
    expect(d.phase).toBe('dwell');
    expect(d.fixStopDistM).not.toBeNull();
    expect(d.fixPinActive).toBe(true);
    expect(d.dwellUntilMs).toBeGreaterThan(0);
    // Standing at the platform → ~zero speed.
    expect(d.simSpeedKmh).toBeCloseTo(0, 1);
  });

  it('surfaces a stuck-hold from repeated same-position fixes', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    // Two genuinely-new fixes at the same mid-segment point (away from stops).
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 600, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 6);
    engine.ingest(
      [makeSnapshot({ key: 't', shapeDistM: 600, observedAtMs: now })],
      () => geo,
      now,
    );
    const d = dbg(engine, 't', now);
    expect(d.stuckAtM).not.toBeNull();
    expect(d.stuckAtM!).toBeCloseTo(600, 0);
  });

  it('exposes the additive raw internals with consistent units (straight track)', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 300, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 6);
    const d = dbg(engine, 't', now);

    // Raw speed mirrors the km/h field.
    expect(d.simSpeedMs!).toBeCloseTo(d.simSpeedKmh / 3.6, 5);
    // Cruise aim is positive and never above the braking envelope cap.
    expect(d.cruiseTargetKmh!).toBeGreaterThan(0);
    // Caps present; straight track → no curve constraint (κ≈0, radius ∞→null).
    expect(d.zoneCapKmh!).toBeGreaterThan(0);
    expect(d.curveKappa!).toBeCloseTo(0, 4);
    expect(d.curveRadiusM).toBeNull();
    expect(d.curveCapKmh!).toBeGreaterThan(45); // ≈ V_MAX 50 km/h off any curve
    expect(d.todPaceFactor!).toBeCloseTo(1, 6); // shipped TOD table is neutral
    // Staleness clock = raw age + feed latency (3 s).
    expect(d.staleFixAgeMs).toBeCloseTo(d.fixAgeMs + 3_000, -2);
    // Context echoed from the snapshot.
    expect(d.statePosition).toBe('on_track');
    expect(d.delaySeconds).toBe(0);
    expect(d.lengthM!).toBeGreaterThan(0);
    expect(d.minStopDistM).not.toBeNull();
    expect(d.burstUntilM).toBeGreaterThanOrEqual(0);
    expect(d.skipRollUntilM).toBeGreaterThanOrEqual(0);
  });

  it('reports curvature and a reduced curve cap at a tight corner', () => {
    const engine = makeEngine();
    const geo = makeCurvedGeo();
    // Seed the sim right at the 90° corner (1000 m along the L-bend).
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const d = dbg(engine, 't', T0);
    expect(d.curveKappa!).toBeGreaterThan(0);
    expect(d.curveRadiusM).not.toBeNull();
    expect(d.curveRadiusM!).toBeGreaterThan(0);
    // A tight bend caps well below the 50 km/h network max.
    expect(d.curveCapKmh!).toBeLessThan(45);
    // The braking envelope near the corner is likewise below the network max.
    expect(d.vAllowedKmh!).toBeLessThan(50);
  });

  it('populates the additive internals on the no-geometry (raw-dot) branch', () => {
    const engine = makeEngine();
    engine.ingest(
      [makeSnapshot({ key: 'raw', shapeDistM: 42, observedAtMs: T0 - 5_000, delaySeconds: 30 })],
      () => undefined,
      T0,
    );
    engine.tick(T0);
    const d = dbg(engine, 'raw', T0);
    expect(d.hasSim).toBe(false);
    expect(d.simSpeedMs).toBe(0);
    expect(d.cruiseTargetKmh).toBeNull();
    expect(d.zoneCapKmh).toBeNull();
    expect(d.curveCapKmh).toBeNull();
    expect(d.curveKappa).toBeNull();
    expect(d.curveRadiusM).toBeNull();
    expect(d.todPaceFactor).toBeNull();
    expect(d.lengthM).toBeNull();
    expect(d.minStopDistM).toBeNull();
    expect(d.staleFixAgeMs).toBeCloseTo(5_000 + 3_000, -2);
    expect(d.statePosition).toBe('on_track');
    expect(d.delaySeconds).toBe(30);
  });

  it('does not mutate the simulation (pure read)', () => {
    const engine = makeEngine();
    const geo = makeGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    const now = run(engine, T0, 5);
    const before = engine.getState('t', now)!.simDistM;
    // Reading debug info repeatedly must not advance or perturb the sim.
    for (let i = 0; i < 20; i++) engine.getDebugInfo('t', now);
    expect(engine.getState('t', now)!.simDistM).toBe(before);
  });
});
