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

import {
  MAX_TICK_CATCHUP_MS,
  QUEUE_GAP_M,
  STALE_AFTER_MS,
  TramEngine,
} from '@/lib/engine/engine';
import { V_MAX_MS } from '@/lib/engine/speedProfile';
import type { RouteGeometry, TramPublicState } from '@/lib/types';
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
  it('a cruising follower never overlaps a standing leader at 1000 ms ticks', () => {
    // One shape: the leader is stuck mid-segment at 900 (repeated fixes — v2
    // fixtures stand a tram via observation-pinned holds, not slow
    // timetables); the follower cruises 800 m into it, ticked at 1 Hz.
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 940_000, isTerminal: true },
      ],
    );
    const engine = makeEngine();
    engine.ingest(
      [makeSnapshot({ key: 'slow', shapeDistM: 900, observedAtMs: T0 - 10_000 })],
      () => geo,
      T0 - 10_000,
    );
    engine.ingest(
      [
        makeSnapshot({ key: 'slow', shapeDistM: 900, observedAtMs: T0 }),
        makeSnapshot({ key: 'fast', shapeDistM: 100, observedAtMs: T0 }),
      ],
      () => geo,
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
    // The constraint was binding: the follower attached to the queue limit
    // behind the stuck anchor (the leader's rendered marker itself stands up
    // to its braking-overshoot ahead of the anchor). The 1 Hz cadence runs
    // 0.25 s substeps, so the explicit-Euler brake toward the hold point may
    // overshoot it by a few meters — still safely inside the leader clearance
    // (minGap above is the hard invariant).
    const followerEnd = state(engine, 'fast', end).simDistM;
    expect(minGap).toBeGreaterThanOrEqual(clearance - EPS);
    expect(followerEnd).toBeGreaterThanOrEqual(900 - clearance - 5);
    expect(followerEnd).toBeLessThanOrEqual(900 - clearance + 8);
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

  it('foreground resync seeks forward to wall time without replaying the gap', () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    seedOne(engine, geo);
    engine.tick(T0 + 1_000);
    const before = state(engine, 't', T0 + 1_000).simDistM;

    engine.resetClock();
    const foregroundAt = T0 + 61_000;
    engine.resyncAfterSuspension(foregroundAt);
    const synced = state(engine, 't', foregroundAt).simDistM;

    // The tram is current immediately, before a new feed batch or timer tick.
    expect(synced).toBeGreaterThan(before + 100);
    // The seek is physically/schedule bounded, never an unbounded integration.
    expect(synced).toBeLessThanOrEqual(geo.totalM);

    engine.tick(foregroundAt + 33);
    expect(state(engine, 't', foregroundAt + 33).simDistM).toBeGreaterThanOrEqual(synced);
  });

  it('keeps a fresh platform pin, then releases it after its fix becomes stale', () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    engine.ingest(
      [
        makeSnapshot({
          key: 'platform',
          shapeDistM: 500,
          observedAtMs: T0,
          statePosition: 'at_stop',
        }),
      ],
      () => geo,
      T0,
    );

    engine.resyncAfterSuspension(T0 + 20_000);
    const fresh = state(engine, 'platform', T0 + 20_000);
    expect(fresh.simDistM).toBeCloseTo(500, 3);
    expect(engine.getDebugInfo('platform', T0 + 20_000)?.fixPinActive).toBe(true);

    engine.resyncAfterSuspension(T0 + 61_000);
    const stale = state(engine, 'platform', T0 + 61_000);
    expect(stale.simDistM).toBeGreaterThan(500);
    expect(engine.getDebugInfo('platform', T0 + 61_000)?.fixPinActive).toBe(false);
  });

  it('does not invent movement through an explicit stuck hold', () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    const stopped = makeSnapshot({ key: 'stuck', shapeDistM: 200, observedAtMs: T0 });
    engine.ingest([stopped], () => geo, T0);
    engine.ingest([{ ...stopped, observedAtMs: T0 + 20_000 }], () => geo, T0 + 20_000);
    const held = state(engine, 'stuck', T0 + 20_000);
    expect(engine.getDebugInfo('stuck', T0 + 20_000)?.stuckAtM).toBeCloseTo(200, 3);

    engine.resyncAfterSuspension(T0 + 120_000);
    expect(state(engine, 'stuck', T0 + 120_000).simDistM).toBeCloseTo(held.simDistM, 3);

    // Only real movement in a genuinely newer fix releases the hold.
    engine.ingest(
      [{ ...stopped, shapeDistM: 230, observedAtMs: T0 + 120_000 }],
      () => geo,
      T0 + 120_000,
    );
    expect(engine.getDebugInfo('stuck', T0 + 120_000)?.stuckAtM).toBeNull();
  });

  it('re-applies same-shape queue clearance after every tram seeks independently', () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    engine.ingest(
      [
        makeSnapshot({ key: 'leader', shapeDistM: 400, observedAtMs: T0 }),
        makeSnapshot({ key: 'follower', shapeDistM: 390, observedAtMs: T0 }),
      ],
      () => geo,
      T0,
    );

    engine.resyncAfterSuspension(T0 + 61_000);
    const gap =
      state(engine, 'leader', T0 + 61_000).simDistM -
      state(engine, 'follower', T0 + 61_000).simDistM;
    expect(gap).toBeGreaterThanOrEqual(LEN + QUEUE_GAP_M - EPS);
  });
});

describe('viewport state reads (close-map allocation budget)', () => {
  it('omits off-screen entries before public-state allocation while preserving a followed key', () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    engine.ingest(
      [
        makeSnapshot({ key: 'near', shapeDistM: 100, observedAtMs: T0 }),
        makeSnapshot({
          key: 'far',
          tripId: 'missing-shape',
          coordinates: [0, 0],
          observedAtMs: T0,
        }),
      ],
      (tripId) => (tripId === geo.tripId ? geo : undefined),
      T0,
    );

    const bbox: [number, number, number, number] = [14.5, 50, 14.7, 50.1];
    const publicReads = jest.spyOn(
      engine as unknown as { toPublicState: (...args: unknown[]) => TramPublicState },
      'toPublicState',
    );
    expect(engine.getStatesInBounds(T0, bbox).map((s) => s.key)).toEqual(['near']);
    expect(publicReads).toHaveBeenCalledTimes(1);
    publicReads.mockClear();
    expect(engine.getStatesInBounds(T0, bbox, 'far').map((s) => s.key)).toEqual([
      'near',
      'far',
    ]);
    expect(publicReads).toHaveBeenCalledTimes(2);
  });

  it("anchors culling per render mode: 'raw' culls by the fix, boolean stays live/smooth", () => {
    const engine = makeEngine();
    const geo = fixtureGeo();
    // The tram's raw coordinate sits OUTSIDE the bbox while its sims (fix at
    // 100 m along the shape near ORIGIN) are INSIDE — the raw anchor must
    // exclude it, the smooth/live anchors must include it.
    engine.ingest(
      [
        makeSnapshot({
          key: 't',
          shapeDistM: 100,
          observedAtMs: T0,
          coordinates: [14.9, 50.05],
        }),
      ],
      () => geo,
      T0,
    );
    engine.tick(T0);
    const bbox: [number, number, number, number] = [14.5, 50, 14.7, 50.1];
    expect(engine.getStatesInBounds(T0, bbox, null, null, 'smooth').map((s) => s.key)).toEqual(['t']);
    expect(engine.getStatesInBounds(T0, bbox, null, null, 'live').map((s) => s.key)).toEqual(['t']);
    expect(engine.getStatesInBounds(T0, bbox, null, null, true).map((s) => s.key)).toEqual(['t']);
    expect(engine.getStatesInBounds(T0, bbox, null, null, 'raw')).toEqual([]);
    // …and the raw anchor includes it when the bbox covers the raw coordinate.
    const rawBbox: [number, number, number, number] = [14.8, 50, 15.0, 50.1];
    expect(engine.getStatesInBounds(T0, rawBbox, null, null, 'raw').map((s) => s.key)).toEqual(['t']);
  });
});

describe('long-uptime engine resource bounds', () => {
  it('drops speed profiles after their last vehicle entry expires', () => {
    const engine = makeEngine();
    const first = fixtureGeo();
    const second: RouteGeometry = {
      ...fixtureGeo(),
      shapeId: 'shape-next',
      tripId: 'trip-next',
    };
    engine.ingest(
      [makeSnapshot({ key: 'old', tripId: first.tripId, observedAtMs: T0 })],
      () => first,
      T0,
    );

    const profileCache = (engine as unknown as { profiles: Map<string, unknown> }).profiles;
    expect([...profileCache.keys()]).toEqual([first.shapeId]);

    const later = T0 + STALE_AFTER_MS + 1;
    engine.ingest(
      [makeSnapshot({ key: 'new', tripId: second.tripId, observedAtMs: later })],
      () => second,
      later,
    );

    expect([...profileCache.keys()]).toEqual([second.shapeId]);
    expect(engine.getState('old', later)).toBeUndefined();
  });
});
