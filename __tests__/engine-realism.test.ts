/// <reference types="jest" />
//
// Field-feedback realism fixes carried into engine v2 (predictor semantics —
// docs/decisions/engine-v2.md §2.2):
//  #1 stop-hold  — while the latest fix shows the tram standing at a stop, the
//                  predictor keeps dwelling; departs on fix movement or the
//                  latency-aware staleness compromise (45 s on the TRUE age).
//  #2 seed speed — a predictor reseeded between stops starts at cruise pace.
//  #3 stuck-hold — repeated same-position fixes pin the predictor at the fix
//                  (light/jam); the reseed lands AT the fix (the v1 pull-back
//                  is subsumed); a moving fix releases it.
//  R11/R12       — the predictor dead-reckons at the LEARNED pace over the
//                  fix's TRUE age; the schedule is never a pace reference.
//  #7 bearing    — bearingAt never averages across a folded window; geometry-
//                  less trams get movement-derived bearings only.

import { TramEngine } from '@/lib/engine/engine';
import { buildSpeedProfile, V_CRUISE_REF_MS } from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  createSim,
  FEED_LATENCY_S,
  PACE_BIAS_PRIOR,
  STOP_HOLD_MAX_FIX_AGE_S,
  STUCK_FIX_EPS_M,
  tick,
  type TramSim,
} from '@/lib/engine/tramSim';
import { bearingAt, cumulativeDistances } from '@/lib/geo/polyline';
import type { RouteGeometry, TramPublicState } from '@/lib/types';
import { angularDiff, makeGeometry, makeSnapshot, makeSpec1, metersToCoord, ORIGIN } from './helpers';

const T0 = 1_000_000_000_000;
const DT = 0.1;
/** Cruise pace of a fresh sim: prior × reference (flat straight, no TOD). */
const PRIOR_CRUISE = PACE_BIAS_PRIOR * V_CRUISE_REF_MS; // ≈ 7.254 m/s

function run(sim: TramSim, fromMs: number, seconds: number, cb?: (nowMs: number) => void): number {
  const steps = Math.round(seconds / DT);
  let now = fromMs;
  for (let i = 0; i < steps; i++) {
    now += DT * 1000;
    tick(sim, now, DT);
    cb?.(now);
  }
  return now;
}

/** Straight 3 km, terminal stops only. */
function straightGeo(): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [3000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - 100_000 },
      { atM: 3000, arrivalMs: T0 + 500_000 },
    ],
  );
}

function makeEngine(): TramEngine {
  return new TramEngine({
    resolveModel: () => makeSpec1(),
    isDaytime: () => false,
    isCoupled: () => false,
  });
}

function runEngine(engine: TramEngine, fromMs: number, seconds: number, cb?: (n: number) => void): number {
  const steps = Math.round((seconds * 1000) / 100);
  let now = fromMs;
  for (let i = 0; i < steps; i++) {
    now += 100;
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

// ── #2: mid-segment cruise-speed seeding ─────────────────────────────────────

describe('mid-segment seed speed (#2)', () => {
  it('createSim between stops seeds the cruise pace, not 0', () => {
    const geo = straightGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    expect(sim.phase).toBe('cruise');
    expect(sim.vMs).toBeCloseTo(PRIOR_CRUISE, 2);
  });

  it('the seeded speed is bounded by the braking envelope near a stop', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 100_000 },
        { atM: 1032, arrivalMs: T0 + 60_000, departureMs: T0 + 80_000, dwellSeconds: 20 },
        { atM: 3000, arrivalMs: T0 + 400_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    // The latency advance (FEED_LATENCY_S · prior cruise ≈ 36 m) puts the seed
    // ~6 m short of the un-served stop: the envelope bounds the speed there.
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 990, observedAtMs: T0 }), T0);
    expect(sim.sM).toBeCloseTo(990 + FEED_LATENCY_S * PRIOR_CRUISE, 0);
    expect(sim.vMs).toBeLessThan(PRIOR_CRUISE - 1);
    expect(sim.vMs).toBeCloseTo(Math.sqrt(2 * 1.4 * (1032 - sim.sM)), 1);
  });

  it('a sim seeded INTO a dwell stays stopped', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 120_000 },
        { atM: 500, arrivalMs: T0 - 5_000, departureMs: T0 + 10_000 },
        { atM: 1000, arrivalMs: T0 + 120_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 499, observedAtMs: T0 }), T0);
    expect(sim.phase).toBe('dwell');
    expect(sim.vMs).toBe(0);
  });

  it('a reseeded predictor advances immediately (no slow ramp from 0)', () => {
    const engine = makeEngine();
    const geo = straightGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const p0 = state(engine, 't', T0).projectedObservedDistM!;
    const now = runEngine(engine, T0, 2);
    const p1 = state(engine, 't', now).projectedObservedDistM!;
    // ~2 s at ≈ PRIOR_CRUISE from the very first tick — not an accel ramp.
    expect(p1 - p0).toBeGreaterThan(PRIOR_CRUISE * 2 * 0.85);
  });
});

// ── #3: stuck detection ──────────────────────────────────────────────────────

describe('stuck-hold on repeated same-position fixes (#3)', () => {
  it('reseeds AT the repeated fix, holds there, then dead-reckons again on a moving fix', () => {
    const geo = straightGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    let now = run(sim, T0, 15); // dead-reckoning ahead of the fix
    expect(sim.sM).toBeGreaterThan(1100);

    // Second genuinely-new fix at the SAME point → the tram is stuck: the
    // reseed lands AT the fix (v1's separate pull-back path is subsumed).
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    expect(sim.stuckAtM).toBe(1000);
    expect(sim.sM).toBe(1000);
    expect(sim.vMs).toBe(0);

    // The hold keeps it AT the fix while ticks pass.
    now = run(sim, now, 30);
    expect(sim.sM).toBe(1000);
    expect(sim.vMs).toBe(0);

    // Third repeat re-arms; still standing.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    now = run(sim, now, 20);
    expect(sim.sM).toBe(1000);

    // A moving fix releases the hold → reseeds at the new fix and drives on.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1200, observedAtMs: now }), now);
    expect(sim.stuckAtM).toBeNull();
    expect(sim.sM).toBeGreaterThanOrEqual(1200);
    let sPrev = sim.sM;
    let vMax = 0;
    run(sim, now, 30, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev);
      sPrev = sim.sM;
      vMax = Math.max(vMax, sim.vMs);
    });
    expect(vMax).toBeGreaterThan(3); // actually driving again
  });

  it('the stale-fix staleness release does NOT apply to stuck-holds (jams outlast the cadence)', () => {
    const geo = straightGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    let now = run(sim, T0, 15);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    expect(sim.stuckAtM).toBe(1000);
    // Two minutes of silence: the hold persists (only movement releases it).
    now = run(sim, now, 120);
    expect(sim.sM).toBe(1000);
    expect(sim.vMs).toBe(0);
  });

  it('repeated fixes NEAR A STOP are a dwell, not a jam (no stuck-hold)', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 100_000 },
        { atM: 1020, arrivalMs: T0 - 10_000, departureMs: T0 + 20_000 },
        { atM: 3000, arrivalMs: T0 + 400_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 + 20_000 }), T0 + 20_000);
    expect(sim.stuckAtM).toBeNull();
  });

  it('an at_stop feed state never arms the stuck-hold', () => {
    const geo = straightGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    applySnapshot(
      sim,
      makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 + 20_000, statePosition: 'at_stop' }),
      T0 + 20_000,
    );
    expect(sim.stuckAtM).toBeNull();
  });

  it('a repeated POLL of the same fix (same observedAtMs) is not stuck evidence', () => {
    const geo = straightGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0 + 15_000);
    expect(sim.stuckAtM).toBeNull();
  });

  it('sub-noise position wiggle still counts as the same point', () => {
    const geo = straightGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    const wiggle = STUCK_FIX_EPS_M - 1;
    applySnapshot(
      sim,
      makeSnapshot({ shapeDistM: 1000 + wiggle, observedAtMs: T0 + 20_000 }),
      T0 + 20_000,
    );
    expect(sim.stuckAtM).toBe(1000 + wiggle);
  });

  it('live mode: the predictor of a stuck tram stands at the fix instead of driving off', () => {
    const engine = makeEngine();
    const geo = straightGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let now = runEngine(engine, T0, 10);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeGreaterThan(1050);

    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: now })], () => geo, now);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeCloseTo(1000, 0);
    now = runEngine(engine, now, 15);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeCloseTo(1000, 0);

    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1150, observedAtMs: now })], () => geo, now);
    const pAfter = state(engine, 't', now).projectedObservedDistM!;
    expect(pAfter).toBeGreaterThanOrEqual(1150);
    now = runEngine(engine, now, 5);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeGreaterThan(1170);
  });

  it('smooth mode: the smoother stands with the stuck predictor (hold-follow), never drives away', () => {
    const engine = makeEngine();
    const geo = straightGeo();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let now = runEngine(engine, T0, 10);
    // Confirming repeat: the predictor snaps back to 1000 and stands. The
    // smoother is AHEAD of it now — it must stand too (no 3 m/s escape).
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: now })], () => geo, now);
    const sAfterSnap = state(engine, 't', now).simDistM;
    let sMax = sAfterSnap;
    now = runEngine(engine, now, 30, (t) => {
      const st = state(engine, 't', t);
      sMax = Math.max(sMax, st.simDistM);
    });
    // Bounded overshoot only — the physical braking distance from cruise
    // (v²/2·A_BRK ≈ 19 m) — then standing. Never a 3 m/s drive-away.
    expect(sMax - sAfterSnap).toBeLessThan(25);
    expect(state(engine, 't', now).simSpeedKmh).toBeLessThan(1);
    expect(engine.getDebugInfo('t', now)!.regime).toBe('hold-follow');
  });
});

// ── #1: stop-hold (fix pins the dwell) ───────────────────────────────────────

describe('stop-hold: the predictor never departs ahead of an at-stop fix (#1)', () => {
  /** Stop at 500 m whose scheduled departure is already close/past. */
  function stopGeo(): RouteGeometry {
    return makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 300_000 },
        { atM: 500, arrivalMs: T0 - 10_000, departureMs: T0 + 8_000, dwellSeconds: 12 },
        { atM: 2000, arrivalMs: T0 + 300_000 },
      ],
    );
  }

  const atStopSnap = (atMs: number, geo: RouteGeometry) =>
    makeSnapshot({
      shapeDistM: 499,
      observedAtMs: atMs,
      statePosition: 'at_stop',
      lastStopSequence: geo.stops[1].sequence,
    });

  it('fresh at_stop fixes keep re-arming the hold; a moving fix releases it promptly', () => {
    const geo = stopGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, atStopSnap(T0, geo), T0);
    expect(sim.phase).toBe('dwell');
    expect(sim.sM).toBeCloseTo(500, 3); // pinned ONTO the platform

    // Scheduled departure passes, base dwell passes — but every 20 s a FRESH
    // fix still shows the tram standing at the platform: keep holding.
    let now = T0;
    for (let k = 1; k <= 4; k++) {
      now = run(sim, now, 20);
      expect(sim.phase).toBe('dwell');
      applySnapshot(sim, atStopSnap(now, geo), now);
    }
    expect(sim.sM).toBeLessThanOrEqual(500.01); // 80+ s after arrival: still there

    // Fresh MOVING fix → the tram departed: reseed ahead within one ingest.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 540, observedAtMs: now }), now);
    expect(sim.sM).toBeGreaterThanOrEqual(540);
    now = run(sim, now, 5);
    expect(sim.phase).toBe('cruise');
  });

  it('with NO fresh fixes the hold expires at STOP_HOLD_MAX_FIX_AGE_S − FEED_LATENCY_S (R12)', () => {
    const geo = stopGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, atStopSnap(T0, geo), T0);
    expect(sim.phase).toBe('dwell');
    // The fix is FEED_LATENCY_S older than obsAt claims, so the staleness
    // clock runs on (age + FEED_LATENCY_S) and the hold releases EARLIER.
    const releaseS = STOP_HOLD_MAX_FIX_AGE_S - FEED_LATENCY_S;
    expect(FEED_LATENCY_S).toBeGreaterThan(0);
    run(sim, T0, releaseS - 2);
    expect(sim.phase).toBe('dwell'); // still held just before the budget
    run(sim, T0 + (releaseS - 2) * 1000, 10);
    expect(sim.phase).toBe('cruise'); // …and departed shortly after
    expect(sim.lastTeleportMs).toBe(0); // smooth departure, never a teleport
  });

  it('a fresh re-arm is unaffected by the latency (only OLD fixes age out)', () => {
    const geo = stopGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, atStopSnap(T0, geo), T0);
    let now = run(sim, T0, 20);
    applySnapshot(sim, atStopSnap(now, geo), now);
    now = run(sim, now, FEED_LATENCY_S + 5);
    expect(sim.phase).toBe('dwell');
    expect(sim.sM).toBeLessThanOrEqual(500.01);
  });

  it('smooth mode: the rendered marker holds AT the platform through the pin (hold-follow)', () => {
    const geo = stopGeo();
    const engine = makeEngine();
    engine.ingest([{ ...atStopSnap(T0, geo), key: 't' }], () => geo, T0);
    engine.tick(T0);

    let now = runEngine(engine, T0, 20, (t) => {
      const st = state(engine, 't', t);
      expect(st.simDistM).toBeLessThanOrEqual(500.01);
    });
    engine.ingest([{ ...atStopSnap(now, geo), key: 't' }], () => geo, now);
    now = runEngine(engine, now, 20, (t) => {
      expect(state(engine, 't', t).simDistM).toBeLessThanOrEqual(500.01);
    });
    // The tram really departs → fresh moving fix → the marker follows out.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 530, observedAtMs: now })], () => geo, now);
    now = runEngine(engine, now, 15);
    expect(state(engine, 't', now).simDistM).toBeGreaterThan(505);
  });

  it('live mode: the predictor is held at the stop by the pinning fix too', () => {
    const geo = stopGeo();
    const engine = makeEngine();
    engine.ingest([{ ...atStopSnap(T0, geo), key: 't' }], () => geo, T0);
    engine.tick(T0);

    let now = runEngine(engine, T0, 20);
    engine.ingest([{ ...atStopSnap(now, geo), key: 't' }], () => geo, now);
    now = runEngine(engine, now, 20);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeLessThanOrEqual(500.01);

    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 530, observedAtMs: now })], () => geo, now);
    now = runEngine(engine, now, 10);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeGreaterThan(540);
  });
});

// ── R11/R12: predictor pace is learned, never the schedule ───────────────────

describe('predictor pace (R11: learned pace, no schedule reference)', () => {
  function scheduleGeo(paceMs: number): RouteGeometry {
    return makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 100_000 },
        { atM: 3000, arrivalMs: T0 - 100_000 + Math.round((3000 / paceMs) * 1000) },
      ],
    );
  }

  it('advances at the learned pace even when the schedule sprints at 20 m/s', () => {
    const engine = makeEngine();
    const geo = scheduleGeo(20);
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = runEngine(engine, T0, 20);
    const p = state(engine, 't', now).projectedObservedDistM!;
    const expected = 100 + LATENCY_ADVANCE() + PRIOR_CRUISE * 20;
    expect(p).toBeGreaterThan(expected - 15);
    expect(p).toBeLessThan(expected + 15);
  });

  it('never crawls when the schedule falls behind the fix (1 m/s timetable)', () => {
    const engine = makeEngine();
    const geo = scheduleGeo(1);
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = runEngine(engine, T0, 20);
    const p = state(engine, 't', now).projectedObservedDistM!;
    expect(p).toBeGreaterThan(100 + PRIOR_CRUISE * 20 - 15);
  });

  function LATENCY_ADVANCE(): number {
    return FEED_LATENCY_S * PRIOR_CRUISE;
  }
});

// ── #7: bearing robustness ───────────────────────────────────────────────────

describe('bearing never turns perpendicular (#7)', () => {
  it('bearingAt at a folded window (terminal-loop apex) follows the rails, not the chord', () => {
    const coords = [
      metersToCoord(ORIGIN, 0, 0),
      metersToCoord(ORIGIN, 200, 0),
      metersToCoord(ORIGIN, 0, 3),
    ];
    const cum = cumulativeDistances(coords);
    const apex = cum[1]; // 200 m
    const b = bearingAt(coords, cum, apex);
    expect(angularDiff(b, 270)).toBeLessThan(10);
    expect(angularDiff(b, 0)).toBeGreaterThan(60);
  });

  it('geometry-less trams derive bearing ONLY from movement, never the feed bearing at v≈0', () => {
    const engine = makeEngine();
    const noGeo = () => undefined;
    const at = (x: number, y: number) => {
      const c = metersToCoord(ORIGIN, x, y);
      return [c[0], c[1]] as [number, number];
    };

    engine.ingest(
      [makeSnapshot({ key: 't', coordinates: at(0, 0), bearing: 45, observedAtMs: T0 })],
      noGeo,
      T0,
    );
    expect(state(engine, 't', T0).bearing).toBe(0);

    engine.ingest(
      [makeSnapshot({ key: 't', coordinates: at(2, 0), bearing: 137, observedAtMs: T0 + 5_000 })],
      noGeo,
      T0 + 5_000,
    );
    expect(state(engine, 't', T0 + 5_000).bearing).toBe(0);

    engine.ingest(
      [makeSnapshot({ key: 't', coordinates: at(52, 0), bearing: null, observedAtMs: T0 + 10_000 })],
      noGeo,
      T0 + 10_000,
    );
    expect(angularDiff(state(engine, 't', T0 + 10_000).bearing, 90)).toBeLessThan(3);
  });
});
