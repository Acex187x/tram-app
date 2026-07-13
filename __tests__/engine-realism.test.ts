/// <reference types="jest" />
//
// Field-feedback realism fixes (2026-07-13 real-tram ride sessions):
//  #1 stop-hold  — while the latest fix shows the tram standing at a stop, the
//                  sim/projection keeps dwelling; departs on fix movement or a
//                  bounded staleness compromise (STOP_HOLD_MAX_FIX_AGE_S).
//  #2 seed speed — a sim (re)seeded between stops starts at cruise pace, not 0.
//  #3 stuck-hold — repeated same-position fixes pin the sim at the fix
//                  (light/jam); a moving fix releases it into soft catch-up.
//  #4 profile    — bolder A_ACC/A_BRK + a bounded departure burst out of stops
//                  (main smooth sims only; debt repaid via adaptive dwell).
//  R11 (live)    — projection sims dead-reckon at the LEARNED pace: no trail
//                  bias, no schedule-pace target chasing, no crawl.
//  #7 bearing    — bearingAt never averages across a folded window (terminal
//                  loop apex); geometry-less trams get movement-derived
//                  bearings, never the feed's instantaneous bearing at v≈0.

import { TramEngine } from '@/lib/engine/engine';
import { buildSpeedProfile, V_CRUISE_REF_MS } from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  createSim,
  DEPART_BURST_DIST_M,
  DEPART_BURST_FACTOR,
  PACE_BIAS_PRIOR,
  STOP_HOLD_MAX_FIX_AGE_S,
  STUCK_BACK_EPS_M,
  STUCK_BACK_FADE_M,
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

/** Straight 3 km, terminal stops only, schedule pace `paceMs`. */
function straightGeo(paceMs: number, departedAgoS = 100): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [3000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - departedAgoS * 1000 },
      { atM: 3000, arrivalMs: T0 - departedAgoS * 1000 + Math.round((3000 / paceMs) * 1000) },
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
    const geo = straightGeo(7);
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
        { atM: 1010, arrivalMs: T0 + 60_000, departureMs: T0 + 80_000, dwellSeconds: 20 },
        { atM: 3000, arrivalMs: T0 + 400_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    // 10 m before an un-served stop: envelope √(2·A_BRK·10) < cruise pace.
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    expect(sim.vMs).toBeLessThan(PRIOR_CRUISE - 1);
    expect(sim.vMs).toBeCloseTo(Math.sqrt(2 * 1.4 * 10), 1);
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

  it('a reseeded projection advances immediately (no slow ramp from 0)', () => {
    const engine = makeEngine();
    const geo = straightGeo(7);
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
  it('holds AT the fix while it repeats, then soft-catches-up on a moving fix', () => {
    const geo = straightGeo(5);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    let now = run(sim, T0, 15); // cruise-seeded, tracking the 5 m/s target
    const sBefore = sim.sM;
    expect(sBefore).toBeGreaterThan(1020);

    // Second genuinely-new fix at the SAME point → the tram is stuck.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    expect(sim.stuckAtM).toBe(1000);

    // The sim brakes to a stand and HOLDS while the schedule target advances.
    now = run(sim, now, 30);
    expect(sim.vMs).toBe(0);
    expect(sim.sM).toBeLessThan(sBefore + 25); // braking distance only — no creep
    const sHeld = sim.sM;

    // Third repeat re-arms the hold; still no creep.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    now = run(sim, now, 20);
    expect(sim.sM).toBe(sHeld);

    // A moving fix releases the hold → soft catch-up (accelerates, no jump).
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1200, observedAtMs: now }), now);
    expect(sim.stuckAtM).toBeNull();
    let sPrev = sim.sM;
    let vMax = 0;
    run(sim, now, 30, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev);
      sPrev = sim.sM;
      vMax = Math.max(vMax, sim.vMs);
    });
    expect(vMax).toBeGreaterThan(3); // actually driving again
    expect(sim.sM).toBeGreaterThan(sHeld + 80);
  });

  it('pulls the sim BACK to the fix when it already drove well past it (audit P2)', () => {
    const geo = straightGeo(5);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    const now = run(sim, T0, 15); // sim cruised/braked well ahead of the fix
    const overshootM = sim.sM - 1000;
    expect(overshootM).toBeGreaterThan(STUCK_BACK_FADE_M); // fixture sanity: a LARGE overshoot

    // Second confirming fix at the same point: the tram never left it — the
    // sim is corrected back to the anchor, rendered as a teleport fade.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    expect(sim.stuckAtM).toBe(1000);
    expect(Math.abs(sim.sM - 1000)).toBeLessThanOrEqual(STUCK_BACK_EPS_M);
    expect(sim.vMs).toBe(0);
    expect(sim.lastTeleportMs).toBe(now);

    // The hold keeps it AT the anchor afterwards.
    run(sim, now, 20);
    expect(sim.sM).toBe(1000);
  });

  it('a small overshoot (≤ STUCK_BACK_EPS_M) stays put — no backward twitch', () => {
    const geo = straightGeo(5);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    const now = run(sim, T0, 1); // barely moved past the fix
    const sBefore = sim.sM;
    expect(sBefore - 1000).toBeGreaterThan(0);
    expect(sBefore - 1000).toBeLessThanOrEqual(STUCK_BACK_EPS_M);

    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    expect(sim.stuckAtM).toBe(1000);
    expect(sim.sM).toBe(sBefore); // held where it is — scatter-scale error
    expect(sim.lastTeleportMs).toBe(0);
  });

  it('a mid-size pull-back snaps quietly, WITHOUT the teleport fade', () => {
    const geo = straightGeo(5);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    const now = run(sim, T0, 2.5);
    const overshootM = sim.sM - 1000;
    expect(overshootM).toBeGreaterThan(STUCK_BACK_EPS_M);
    expect(overshootM).toBeLessThanOrEqual(STUCK_BACK_FADE_M);

    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    expect(sim.sM).toBe(1000);
    expect(sim.lastTeleportMs).toBe(0); // small correction — no fade event
  });

  it('the pull-back re-opens a stop the overshoot had already served', () => {
    // Stop 45 m past the jam point (outside STUCK_NEAR_STOP_M, so the stuck
    // hold still arms): the sim reaches and starts serving it before the
    // confirming fix reveals the tram never left the jam behind it.
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 100_000 },
        { atM: 1045, arrivalMs: T0 + 9_000, departureMs: T0 + 24_000, dwellSeconds: 15 },
        { atM: 3000, arrivalMs: T0 + 300_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    let now = run(sim, T0, 20);
    expect(sim.phase).toBe('dwell'); // serving the 1045 m stop
    expect(sim.sM).toBeGreaterThan(1040);

    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: now }), now);
    expect(sim.sM).toBe(1000);
    expect(sim.phase).toBe('cruise'); // standing via the stuck hold, not a dwell
    expect(sim.vMs).toBe(0);
    expect(sim.minStopDist).toBeLessThan(1045); // the stop is a 0-limit again

    // Jam clears (fresh moving fix): the sim drives on and serves the
    // re-opened stop for real instead of rolling through it.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1100, observedAtMs: now }), now);
    let dwelledAtStop = false;
    now = run(sim, now, 30, () => {
      if (sim.phase === 'dwell' && Math.abs(sim.sM - 1045) < 3) dwelledAtStop = true;
    });
    expect(dwelledAtStop).toBe(true);
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
    const geo = straightGeo(5);
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
    const geo = straightGeo(5);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0 + 15_000);
    expect(sim.stuckAtM).toBeNull();
  });

  it('sub-noise position wiggle still counts as the same point', () => {
    const geo = straightGeo(5);
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

  it('the live projection of a stuck tram stands at the fix instead of driving off', () => {
    const engine = makeEngine();
    const geo = straightGeo(5);
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let now = runEngine(engine, T0, 10);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeGreaterThan(1050);

    // Fresh fix, same position → stuck: the projection jumps back AND holds.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: now })], () => geo, now);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeCloseTo(1000, 0);
    now = runEngine(engine, now, 15);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeCloseTo(1000, 0);

    // Moving fix → jumps to it and dead-reckons again.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1150, observedAtMs: now })], () => geo, now);
    const pAfter = state(engine, 't', now).projectedObservedDistM!;
    expect(pAfter).toBeCloseTo(1150, 0);
    now = runEngine(engine, now, 5);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeGreaterThan(1170);
  });
});

// ── #1: stop-hold (fix pins the dwell) ───────────────────────────────────────

describe('stop-hold: the sim never departs ahead of an at-stop fix (#1)', () => {
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

  it('fresh at_stop fixes keep re-arming the hold; a moving fix releases it promptly', () => {
    const geo = stopGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const snap = () =>
      makeSnapshot({
        shapeDistM: 499,
        observedAtMs: T0,
        statePosition: 'at_stop',
        lastStopSequence: geo.stops[1].sequence,
      });
    const sim = createSim(geo, profile, snap(), T0, undefined, { adaptiveDwell: true });
    expect(sim.phase).toBe('dwell');

    // Scheduled departure (T0+8 s) passes, base dwell passes — but every 20 s
    // a FRESH fix still shows the tram standing at the platform: keep holding.
    let now = T0;
    for (let k = 1; k <= 4; k++) {
      now = run(sim, now, 20);
      expect(sim.phase).toBe('dwell');
      applySnapshot(
        sim,
        makeSnapshot({
          shapeDistM: 499,
          observedAtMs: now,
          statePosition: 'at_stop',
          lastStopSequence: geo.stops[1].sequence,
        }),
        now,
      );
    }
    expect(sim.sM).toBeLessThanOrEqual(500.01); // 88 s after arrival: still there

    // Fresh MOVING fix → the tram departed: release within ticks.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 540, observedAtMs: now }), now);
    now = run(sim, now, 5);
    expect(sim.phase).toBe('cruise');
    expect(sim.sM).toBeGreaterThan(505);
  });

  it('with NO fresh fixes the hold expires after STOP_HOLD_MAX_FIX_AGE_S (bounded compromise)', () => {
    const geo = stopGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(
      geo,
      profile,
      makeSnapshot({
        shapeDistM: 499,
        observedAtMs: T0,
        statePosition: 'at_stop',
        lastStopSequence: geo.stops[1].sequence,
      }),
      T0,
    );
    expect(sim.phase).toBe('dwell');
    // Still held at the platform right before the staleness budget runs out…
    run(sim, T0, STOP_HOLD_MAX_FIX_AGE_S - 2);
    expect(sim.phase).toBe('dwell');
    // …and departed shortly after it does (the feed is silent — the tram most
    // likely left between fixes; waiting forever would be worse).
    run(sim, T0 + (STOP_HOLD_MAX_FIX_AGE_S - 2) * 1000, 10);
    expect(sim.phase).toBe('cruise');
  });

  it('the live projection is held at the stop by the pinning fix too', () => {
    const geo = stopGeo();
    const engine = makeEngine();
    const atStopSnap = (atMs: number) =>
      makeSnapshot({
        key: 't',
        shapeDistM: 499,
        observedAtMs: atMs,
        statePosition: 'at_stop',
        lastStopSequence: geo.stops[1].sequence,
      });
    engine.ingest([atStopSnap(T0)], () => geo, T0);
    engine.tick(T0);

    // 40 s with one fresh at-stop fix in between: the projection never leaves.
    let now = runEngine(engine, T0, 20);
    engine.ingest([atStopSnap(now)], () => geo, now);
    now = runEngine(engine, now, 20);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeLessThanOrEqual(500.01);

    // The tram really departs → fresh moving fix → the projection moves out.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 530, observedAtMs: now })], () => geo, now);
    now = runEngine(engine, now, 10);
    expect(state(engine, 't', now).projectedObservedDistM!).toBeGreaterThan(540);
  });
});

// ── #4: departure burst (motion profile) ─────────────────────────────────────

describe('departure burst (#4)', () => {
  // Frozen target at the 500 m stop, long straight after it.
  function burstGeo(): RouteGeometry {
    return makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 530_000 },
        { atM: 500, arrivalMs: T0 - 30_000, departureMs: T0 + 300_000, dwellSeconds: 10 },
        { atM: 3000, arrivalMs: T0 + 800_000 },
      ],
    );
  }

  function departAndMeasure(adaptive: boolean): { vPeak: number; burstSet: boolean } {
    const geo = burstGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(
      geo,
      profile,
      makeSnapshot({ shapeDistM: 460, observedAtMs: T0 }),
      T0,
      undefined,
      { adaptiveDwell: adaptive },
    );
    // Drive into the dwell.
    let now = T0;
    for (let i = 0; i < 300 && sim.phase !== 'dwell'; i++) {
      now += DT * 1000;
      tick(sim, now, DT);
    }
    expect(sim.phase).toBe('dwell');
    // Release: fresh fix well past the stop (also clears any fix-hold), then
    // measure the exit speed over the burst window.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 560, observedAtMs: now }), now);
    let vPeak = 0;
    let burstSet = false;
    for (let i = 0; i < 600; i++) {
      now += DT * 1000;
      tick(sim, now, DT);
      if (sim.burstUntilM > 0) burstSet = true;
      if (sim.sM > 505 && sim.sM < 505 + DEPART_BURST_DIST_M) vPeak = Math.max(vPeak, sim.vMs);
      if (sim.sM > 700) break;
    }
    return { vPeak, burstSet };
  }

  it('adaptive (main) sims exit stops with a bounded cruise boost', () => {
    const adaptive = departAndMeasure(true);
    const plain = departAndMeasure(false);
    expect(adaptive.burstSet).toBe(true);
    expect(plain.burstSet).toBe(false);
    // The burst multiplies the cruise product: clearly faster than the
    // non-burst exit over the same window, bounded by factor × burst.
    expect(adaptive.vPeak).toBeGreaterThan(plain.vPeak + 1);
    expect(adaptive.vPeak).toBeLessThanOrEqual(plain.vPeak * DEPART_BURST_FACTOR + 0.5);
  });
});

// ── R11: projection dead-reckons at the learned pace ─────────────────────────

describe('live projection pace (R11 fix)', () => {
  it('advances at the learned pace — NOT at the (faster) schedule pace, no trail bias', () => {
    const engine = makeEngine();
    const geo = straightGeo(20); // schedule sprints at 20 m/s — reality does not
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = runEngine(engine, T0, 20);
    const p = state(engine, 't', now).projectedObservedDistM!;
    // 20 s at the prior pace ≈ 145 m; the old schedule-chasing projection ran
    // at up to catch-up × prior ≈ 10.9 m/s (≈ 220 m) here.
    const expected = 100 + PRIOR_CRUISE * 20;
    expect(p).toBeGreaterThan(expected - 15);
    expect(p).toBeLessThan(expected + 15);
  });

  it('never enters the crawl regime when the schedule falls behind the fix', () => {
    const engine = makeEngine();
    const geo = straightGeo(1); // schedule crawls at 1 m/s — old projSim would too
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = runEngine(engine, T0, 20);
    const p = state(engine, 't', now).projectedObservedDistM!;
    // Dead-reckons at the learned pace regardless of the slow timetable.
    expect(p).toBeGreaterThan(100 + PRIOR_CRUISE * 20 - 15);
  });
});

// ── #7: bearing robustness ───────────────────────────────────────────────────

describe('bearing never turns perpendicular (#7)', () => {
  it('bearingAt at a folded window (terminal-loop apex) follows the rails, not the chord', () => {
    // Out-and-back stub: east 200 m, then straight back with a 3 m lateral
    // offset — the classic terminal turnaround digitization. The ±2 m window
    // at the apex spans both legs; its chord points ~north (perpendicular to
    // the rails). The fold guard must fall back to the segment direction.
    const coords = [
      metersToCoord(ORIGIN, 0, 0),
      metersToCoord(ORIGIN, 200, 0),
      metersToCoord(ORIGIN, 0, 3),
    ];
    const cum = cumulativeDistances(coords);
    const apex = cum[1]; // 200 m
    const b = bearingAt(coords, cum, apex);
    // Direction of the return leg ≈ west (270°, +small northward component).
    expect(angularDiff(b, 270)).toBeLessThan(10);
    // And definitely NOT the perpendicular chord (≈ 0°/north).
    expect(angularDiff(b, 0)).toBeGreaterThan(60);
  });

  it('geometry-less trams hold a movement-derived bearing, ignoring feed bearing at v≈0', () => {
    const engine = makeEngine();
    const noGeo = () => undefined;
    const at = (x: number, y: number) => {
      const c = metersToCoord(ORIGIN, x, y);
      return [c[0], c[1]] as [number, number];
    };

    // Spawn: nothing better than the feed bearing exists yet.
    engine.ingest(
      [makeSnapshot({ key: 't', coordinates: at(0, 0), bearing: 45, observedAtMs: T0 })],
      noGeo,
      T0,
    );
    expect(state(engine, 't', T0).bearing).toBe(45);

    // Standing (moved 2 m) with a garbage instantaneous bearing: HOLD the old one.
    engine.ingest(
      [makeSnapshot({ key: 't', coordinates: at(2, 0), bearing: 137, observedAtMs: T0 + 5_000 })],
      noGeo,
      T0 + 5_000,
    );
    expect(state(engine, 't', T0 + 5_000).bearing).toBe(45);

    // Real movement (50 m east): bearing derives from the position track (≈ 90°),
    // even when the feed reports none.
    engine.ingest(
      [makeSnapshot({ key: 't', coordinates: at(52, 0), bearing: null, observedAtMs: T0 + 10_000 })],
      noGeo,
      T0 + 10_000,
    );
    expect(angularDiff(state(engine, 't', T0 + 10_000).bearing, 90)).toBeLessThan(3);
  });
});
