/// <reference types="jest" />
//
// Per-tram adaptive pace calibration (TramSim.paceBias, engine v2): on each
// genuinely-new AVL fix the predictor compares the real inter-fix average
// MOTION speed against the expected average speed over the same span (cruise
// caps bounded by V_CRUISE_REF_MS) and folds the clamped ratio into a
// recency-weighted EWMA (half-life 150 s). R13 clip-not-drop
// (engine-v2.md §2.2): the STANDING portion of the span — scheduled dwells of
// stops strictly inside it PLUS observed pin/stuck-active time — is deducted
// so the sample measures motion pace; the span is dropped only when no
// confident moving remainder survives. New vehicles start at PACE_BIAS_PRIOR;
// the learned value is inherited across teleports and (via TramEngine's
// per-key memory) across trip changes.

import { TramEngine, PACE_BIAS_MEMORY_TTL_MS } from '@/lib/engine/engine';
import {
  buildSpeedProfile,
  meanCruiseCapOver,
  V_CRUISE_REF_MS,
  V_MAX_MS,
} from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  createSim,
  PACE_BIAS_HALF_LIFE_S,
  PACE_BIAS_MAX_RATIO,
  PACE_BIAS_MIN_RATIO,
  PACE_BIAS_PRIOR,
  STOP_HOLD_MAX_FIX_AGE_S,
  FEED_LATENCY_S,
  tick,
  type TramSim,
} from '@/lib/engine/tramSim';
import type { RouteGeometry } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

const T0 = 1_000_000_000_000;

/** Straight shape, no intermediate stops, generous timetable. */
function straightGeo(lengthM: number): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [lengthM, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: lengthM, arrivalMs: T0 + 3_600_000 },
    ],
  );
}

function makeSim(geo: RouteGeometry, shapeDistM: number, nowMs = T0): TramSim {
  const profile = buildSpeedProfile(geo, { daytime: false });
  return createSim(geo, profile, makeSnapshot({ shapeDistM, observedAtMs: nowMs }), nowMs);
}

/** Expected EWMA value after samples of `ratio` totalling `totalS` seconds. */
function ewma(from: number, ratio: number, totalS: number): number {
  return ratio + (from - ratio) * Math.pow(0.5, totalS / PACE_BIAS_HALF_LIFE_S);
}

describe('paceBias calibration (applySnapshot)', () => {
  it('starts at the fleet prior and converges to ~0.9 for a tram at 90% of reference speed', () => {
    const vReal = 0.9 * V_CRUISE_REF_MS;
    const sim = makeSim(straightGeo(6000), 100);
    expect(sim.paceBias).toBe(PACE_BIAS_PRIOR);

    // 3 fixes, 100 s apart, each advancing at exactly 90% of the reference —
    // honest travel for the gap, so no reseed classifies as a teleport.
    let t = T0;
    let d = 100;
    let prevBias = sim.paceBias;
    for (let k = 0; k < 3; k++) {
      t += 100_000;
      d += vReal * 100;
      applySnapshot(sim, makeSnapshot({ shapeDistM: d, observedAtMs: t }), t);
      expect(sim.paceBias).toBeGreaterThan(prevBias); // monotone toward 0.9
      prevBias = sim.paceBias;
    }
    expect(sim.paceBias).toBeGreaterThanOrEqual(0.75);
    expect(sim.paceBias).toBeLessThanOrEqual(0.9);
    expect(sim.paceBias).toBeCloseTo(ewma(PACE_BIAS_PRIOR, 0.9, 300), 3);
    expect(sim.lastTeleportMs).toBe(0); // calibration, not teleports
  });

  it('recency: after a step change to 120% pace, the bias crosses 1.0 within ~3.5 min', () => {
    const vFast = 1.2 * V_CRUISE_REF_MS; // ratio sample = 1.2 exactly
    const sim = makeSim(straightGeo(6000), 100);
    sim.paceBias = 0.7; // previously-learned slow driver

    let t = T0;
    let d = 100;
    let crossedAfterS: number | null = null;
    for (let k = 1; k <= 7; k++) {
      t += 30_000;
      d += vFast * 30;
      applySnapshot(sim, makeSnapshot({ shapeDistM: d, observedAtMs: t }), t);
      if (crossedAfterS === null && sim.paceBias >= 1.0) crossedAfterS = k * 30;
    }
    expect(crossedAfterS).not.toBeNull();
    expect(crossedAfterS!).toBeLessThanOrEqual(210); // ≤ 3.5 min of fixes
    expect(sim.paceBias).toBeCloseTo(ewma(0.7, 1.2, 210), 3);
  });

  it('clamps each ratio sample to [0.4, 1.6]', () => {
    // Fast outlier: 450 m in 20 s (raw ratio ≈ 1.92) — under the gap-aware
    // teleport floor, so the sample is taken and clamped at 1.6.
    const fast = makeSim(straightGeo(6000), 0);
    applySnapshot(fast, makeSnapshot({ shapeDistM: 450, observedAtMs: T0 + 20_000 }), T0 + 20_000);
    expect(fast.lastTeleportMs).toBe(0);
    expect(fast.paceBias).toBeCloseTo(ewma(PACE_BIAS_PRIOR, PACE_BIAS_MAX_RATIO, 20), 6);

    // Absurdly slow: 20 m in 150 s → the sample is used as 0.4.
    const slow = makeSim(straightGeo(6000), 0);
    applySnapshot(
      slow,
      makeSnapshot({ shapeDistM: 20, observedAtMs: T0 + PACE_BIAS_HALF_LIFE_S * 1000 }),
      T0 + PACE_BIAS_HALF_LIFE_S * 1000,
    );
    expect(slow.paceBias).toBeCloseTo(
      ewma(PACE_BIAS_PRIOR, PACE_BIAS_MIN_RATIO, PACE_BIAS_HALF_LIFE_S),
      6,
    );

    // Long-run: the bias itself can never leave the clamp interval.
    let t = T0 + PACE_BIAS_HALF_LIFE_S * 1000;
    let d = 20;
    for (let k = 0; k < 20; k++) {
      t += 60_000;
      d += 16;
      applySnapshot(slow, makeSnapshot({ shapeDistM: d, observedAtMs: t }), t);
      expect(slow.paceBias).toBeGreaterThanOrEqual(PACE_BIAS_MIN_RATIO);
    }
    expect(slow.paceBias).toBeCloseTo(PACE_BIAS_MIN_RATIO, 1);
  });

  it('skips degenerate samples (Δt < 8 s, Δs < 15 m, backwards fixes, stale fixes)', () => {
    const sim = makeSim(straightGeo(6000), 500);
    sim.paceBias = 0.8;

    applySnapshot(sim, makeSnapshot({ shapeDistM: 600, observedAtMs: T0 + 5_000 }), T0 + 5_000);
    expect(sim.paceBias).toBe(0.8); // Δt = 5 s
    applySnapshot(sim, makeSnapshot({ shapeDistM: 610, observedAtMs: T0 + 35_000 }), T0 + 35_000);
    expect(sim.paceBias).toBe(0.8); // Δs = 10 m
    // Backwards fix (GPS glitch): never a pace sample.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 550, observedAtMs: T0 + 65_000 }), T0 + 65_000);
    expect(sim.paceBias).toBe(0.8);
    // Repeated poll of the same fix (same observedAtMs): not genuinely new.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 550, observedAtMs: T0 + 65_000 }), T0 + 80_000);
    expect(sim.paceBias).toBe(0.8);
  });

  it('deducts scheduled dwell time of stops strictly inside the inter-fix span', () => {
    // Stop with a 20 s dwell at 300 m between the fixes at 100 m and 500 m.
    const geo = makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 300, arrivalMs: T0 + 30_000, departureMs: T0 + 50_000, dwellSeconds: 20 },
        { atM: 2000, arrivalMs: T0 + 300_000 },
      ],
    );
    const sim = makeSim(geo, 100);
    // 400 m in 60 s including the 20 s dwell → motion speed 10 m/s, not 6.67.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 500, observedAtMs: T0 + 60_000 }), T0 + 60_000);
    const motionRatio = 400 / 40 / V_CRUISE_REF_MS; // ≈ 0.855
    expect(sim.paceBias).toBeCloseTo(ewma(PACE_BIAS_PRIOR, motionRatio, 60), 3);
    // Sanity: clearly above what the raw (dwell-polluted) ratio would give.
    expect(sim.paceBias).toBeGreaterThan(
      ewma(PACE_BIAS_PRIOR, 400 / 60 / V_CRUISE_REF_MS, 60) + 0.02,
    );
  });

  it('R13 clip-not-drop: pin-active standing time is deducted from the span', () => {
    // Predictor pinned at a platform by an at_stop fix; the pin holds ~42 s
    // (45 s staleness on the TRUE age), then the tram departs unseen; the next
    // fix lands 300 m on. The 42 s of observed standing must NOT contaminate
    // the pace sample — the moving remainder is the sample (R13).
    const geo = makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 300_000 },
        { atM: 500, arrivalMs: T0 - 10_000, departureMs: T0 + 600_000 },
        { atM: 2000, arrivalMs: T0 + 900_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(
      geo,
      profile,
      makeSnapshot({
        shapeDistM: 500,
        observedAtMs: T0,
        statePosition: 'at_stop',
        lastStopSequence: geo.stops[1].sequence,
      }),
      T0,
    );
    expect(sim.phase).toBe('dwell'); // pinned ON the platform
    // Tick through the pin window and beyond (60 s of wall time).
    let now = T0;
    for (let i = 0; i < 240; i++) {
      now += 250;
      tick(sim, now, 0.25);
    }
    const heldS = STOP_HOLD_MAX_FIX_AGE_S - FEED_LATENCY_S; // 42 s of pin time
    expect(sim.holdAccumMs / 1000).toBeCloseTo(heldS, 0);

    const t1 = T0 + 60_000;
    applySnapshot(sim, makeSnapshot({ shapeDistM: 800, observedAtMs: t1 }), t1);
    // effDt = 60 − 42 = 18 s → the sample measures the MOTION pace.
    const motionRatio = Math.min(PACE_BIAS_MAX_RATIO, 300 / (60 - heldS) / V_CRUISE_REF_MS);
    expect(sim.paceBias).toBeCloseTo(ewma(PACE_BIAS_PRIOR, motionRatio, 60), 3);
    // Clearly above the naive standing-contaminated ratio (~0.43).
    expect(sim.paceBias).toBeGreaterThan(ewma(PACE_BIAS_PRIOR, 300 / 60 / V_CRUISE_REF_MS, 60));
    // …and the accumulator resets for the next span.
    expect(sim.holdAccumMs).toBe(0);
  });

  it('INHERITS the learned bias across a hard teleport, without a pace sample from the jump', () => {
    // The vehicle and driver don't change at a teleport — the learned pace was
    // the one thing the old estimate got right. The teleporting fix itself
    // must NOT feed the EWMA (a 1.9 km re-anchor is not motion).
    const sim = makeSim(straightGeo(6000), 100);
    sim.paceBias = 0.7;
    applySnapshot(sim, makeSnapshot({ shapeDistM: 2000, observedAtMs: T0 + 30_000 }), T0 + 30_000);
    expect(sim.lastTeleportMs).toBe(T0 + 30_000);
    expect(sim.paceBias).toBe(0.7);
  });

  it('createSim seeds paceBias from initialPaceBias (clamped) when provided', () => {
    const geo = straightGeo(6000);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const snap = makeSnapshot({ shapeDistM: 0, observedAtMs: T0 });
    expect(createSim(geo, profile, snap, T0, undefined, { initialPaceBias: 0.8 }).paceBias).toBe(
      0.8,
    );
    expect(createSim(geo, profile, snap, T0, undefined, { initialPaceBias: 3 }).paceBias).toBe(
      PACE_BIAS_MAX_RATIO,
    );
    expect(createSim(geo, profile, snap, T0, undefined, { initialPaceBias: 0.1 }).paceBias).toBe(
      PACE_BIAS_MIN_RATIO,
    );
  });
});

describe('meanCruiseCapOver', () => {
  it('is the flat cap on a straight and length-weights mixed-cap spans', () => {
    const geo = straightGeo(1000);
    const profile = buildSpeedProfile(geo, { daytime: false });
    expect(meanCruiseCapOver(profile, geo, 100, 900)).toBeCloseTo(V_MAX_MS, 6);

    const geo2 = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 1000, arrivalMs: T0 + 100_000 },
      ],
    );
    const profile2 = buildSpeedProfile(geo2, { daytime: false });
    profile2.vLimit[0] = 5;
    profile2.vLimit[1] = 5;
    profile2.vLimit[2] = 10;
    expect(meanCruiseCapOver(profile2, geo2, 0, 1000)).toBeCloseTo(7.5, 3);
    expect(meanCruiseCapOver(profile2, geo2, 0, 500)).toBeCloseTo(5, 3);
    expect(meanCruiseCapOver(profile2, geo2, 500, 1000)).toBeCloseTo(10, 3);
    expect(meanCruiseCapOver(profile2, geo2, 0, 750)).toBeCloseTo((500 * 5 + 250 * 10) / 750, 3);
    expect(meanCruiseCapOver(profile2, geo2, 250, 250)).toBeCloseTo(5, 6);
  });

  it('bounds per-segment caps by refCapMs (the cruise-reference semantics)', () => {
    const geo = straightGeo(1000);
    const profile = buildSpeedProfile(geo, { daytime: false });
    expect(meanCruiseCapOver(profile, geo, 100, 900, V_CRUISE_REF_MS)).toBeCloseTo(
      V_CRUISE_REF_MS,
      6,
    );
    const geo2 = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 1000, arrivalMs: T0 + 100_000 },
      ],
    );
    const profile2 = buildSpeedProfile(geo2, { daytime: false });
    profile2.vLimit[0] = 5;
    profile2.vLimit[1] = 5;
    profile2.vLimit[2] = 13.9;
    expect(meanCruiseCapOver(profile2, geo2, 0, 1000, V_CRUISE_REF_MS)).toBeCloseTo(
      (500 * 5 + 500 * V_CRUISE_REF_MS) / 1000,
      3,
    );
    expect(meanCruiseCapOver(profile2, geo2, 750, 750, V_CRUISE_REF_MS)).toBeCloseTo(
      V_CRUISE_REF_MS,
      6,
    );
  });
});

describe('paceBias applied to the predictor (integration)', () => {
  it('a slower-than-reference tram converges and stops sprint-and-reseed oscillating', () => {
    const vReal = 0.7 * V_MAX_MS; // ≈ 9.73 m/s ≈ 0.83× reference
    const geo = straightGeo(6000);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 0, observedAtMs: T0 }), T0);

    // 400 s of 10 Hz ticks with a genuine fix every 20 s at exactly 70% pace.
    const DT = 0.1;
    let now = T0;
    let obsD = 0;
    let vMax = 0;
    let maxReseedJump = 0;
    for (let step = 1; step <= 4000; step++) {
      now += DT * 1000;
      if (step % 200 === 0) {
        obsD += vReal * 20;
        const before = sim.sM;
        applySnapshot(sim, makeSnapshot({ shapeDistM: obsD, observedAtMs: now }), now);
        if (step > 3000) maxReseedJump = Math.max(maxReseedJump, Math.abs(sim.sM - before));
      }
      tick(sim, now, DT);
      if (step > 3000) vMax = Math.max(vMax, sim.vMs);
    }

    expect(sim.lastTeleportMs).toBe(0);
    // Converged from the 0.62 prior toward vReal / V_CRUISE_REF_MS ≈ 0.83.
    expect(sim.paceBias).toBeGreaterThan(0.75);
    expect(sim.paceBias).toBeLessThan(0.9);
    // Calibrated: cruises near the tram's real pace…
    expect(vMax).toBeLessThan(11);
    expect(vMax).toBeGreaterThan(0.8 * vReal);
    // …so consecutive reseeds land nearly in place (no sprint-and-yank).
    expect(maxReseedJump).toBeLessThan(45);
  });
});

// ── per-key bias memory (TramEngine) ─────────────────────────────────────────

describe('paceBias inheritance across trips and respawns (TramEngine per-key memory)', () => {
  const KEY = '9201';
  const vReal = 0.9 * V_CRUISE_REF_MS;

  function makeEngine(): TramEngine {
    return new TramEngine({
      resolveModel: () => makeSpec1(),
      isDaytime: () => false,
      isCoupled: () => false,
    });
  }

  /** Straight 6 km shape with a distinct trip/shape id. */
  function geoFor(tripId: string): RouteGeometry {
    const geo = makeGeometry(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 6000, arrivalMs: T0 + Math.round((6000 / vReal) * 1000) },
      ],
    );
    return { ...geo, tripId, shapeId: `shape-${tripId}` };
  }

  /** Ingest a learning sequence of fixes at 90% of reference pace, ticking the
   *  engine between polls (no teleports — jumps stay well under threshold). */
  function learn(engine: TramEngine, geo: RouteGeometry, fixes: number): number {
    let t = T0;
    let d = 0;
    engine.ingest(
      [makeSnapshot({ key: KEY, tripId: geo.tripId, shapeDistM: 0, observedAtMs: t })],
      () => geo,
      t,
    );
    engine.tick(t);
    for (let k = 1; k < fixes; k++) {
      for (let i = 0; i < 600; i++) {
        t += 100;
        engine.tick(t);
      }
      d += vReal * 60;
      engine.ingest(
        [makeSnapshot({ key: KEY, tripId: geo.tripId, shapeDistM: d, observedAtMs: t })],
        () => geo,
        t,
      );
    }
    return t;
  }

  function bias(engine: TramEngine, atMs: number): number {
    const s = engine.getState(KEY, atMs);
    if (!s || s.paceBias === undefined) throw new Error('no paceBias in state');
    return s.paceBias;
  }

  it('a NEW vehicle starts at the prior; a trip change keeps the learned bias', () => {
    const engine = makeEngine();
    const tripA = geoFor('trip-A');
    engine.ingest(
      [makeSnapshot({ key: KEY, tripId: 'trip-A', shapeDistM: 0, observedAtMs: T0 })],
      () => tripA,
      T0,
    );
    expect(bias(engine, T0)).toBe(PACE_BIAS_PRIOR); // genuinely new vehicle

    const tEnd = learn(engine, tripA, 6);
    const learned = bias(engine, tEnd);
    expect(learned).toBeGreaterThan(PACE_BIAS_PRIOR + 0.1); // actually learned up

    // Same vehicle switches to a new trip: fresh sim, inherited bias.
    const tripB = geoFor('trip-B');
    const t2 = tEnd + 5_000;
    engine.ingest(
      [makeSnapshot({ key: KEY, tripId: 'trip-B', shapeDistM: 0, observedAtMs: t2 })],
      () => tripB,
      t2,
    );
    expect(bias(engine, t2)).toBeCloseTo(learned, 10);
  });

  it('a vehicle dropped for > STALE_AFTER_MS but within the TTL respawns with its learned bias', () => {
    const engine = makeEngine();
    const tripA = geoFor('trip-A');
    const tEnd = learn(engine, tripA, 6);
    const learned = bias(engine, tEnd);

    const tGap = tEnd + 120_000;
    engine.ingest([], () => tripA, tGap);
    expect(engine.getState(KEY, tGap)).toBeUndefined();

    const tBack = tEnd + 180_000;
    engine.ingest(
      [makeSnapshot({ key: KEY, tripId: 'trip-A', shapeDistM: 3000, observedAtMs: tBack })],
      () => tripA,
      tBack,
    );
    expect(bias(engine, tBack)).toBeCloseTo(learned, 10);
  });

  it('memory expires after PACE_BIAS_MEMORY_TTL_MS: a long-gone vehicle restarts at the prior', () => {
    const engine = makeEngine();
    const tripA = geoFor('trip-A');
    const tEnd = learn(engine, tripA, 6);
    expect(bias(engine, tEnd)).toBeGreaterThan(PACE_BIAS_PRIOR + 0.1);

    engine.ingest([], () => tripA, tEnd + 120_000);
    expect(engine.getState(KEY, tEnd + 120_000)).toBeUndefined();

    const tLater = tEnd + PACE_BIAS_MEMORY_TTL_MS + 60_000;
    engine.ingest(
      [makeSnapshot({ key: KEY, tripId: 'trip-A', shapeDistM: 5000, observedAtMs: tLater })],
      () => tripA,
      tLater,
    );
    expect(bias(engine, tLater)).toBe(PACE_BIAS_PRIOR);
  });
});
