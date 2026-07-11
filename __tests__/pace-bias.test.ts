/// <reference types="jest" />
//
// Per-tram adaptive pace calibration (TramSim.paceBias): on each genuinely-new
// AVL fix the sim compares the real inter-fix average speed against the
// profile-expected average cruise speed over the same span and folds the
// clamped ratio into a recency-weighted EWMA (half-life 150 s). The bias then
// scales the pace controller's cruise target so a consistently-slow tram is
// simulated at its own pace between fixes instead of sprint-and-crawl.

import {
  buildSpeedProfile,
  meanCruiseCapOver,
  V_MAX_MS,
} from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  createSim,
  HARD_BRAKE_ENTER_M,
  PACE_BIAS_HALF_LIFE_S,
  PACE_BIAS_MAX_RATIO,
  PACE_BIAS_MIN_RATIO,
  targetDistAt,
  tick,
  type TramSim,
} from '@/lib/engine/tramSim';
import type { RouteGeometry } from '@/lib/types';
import { makeGeometry, makeSnapshot } from './helpers';

const T0 = 1_000_000_000_000;

/** Straight shape, no intermediate stops, schedule pace `paceMs` m/s. */
function straightGeo(lengthM: number, paceMs: number): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [lengthM, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: lengthM, arrivalMs: T0 + Math.round((lengthM / paceMs) * 1000) },
    ],
  );
}

function makeSim(geo: RouteGeometry, shapeDistM: number, nowMs = T0): TramSim {
  const profile = buildSpeedProfile(geo, { daytime: false });
  return createSim(geo, profile, makeSnapshot({ shapeDistM, observedAtMs: nowMs }), nowMs);
}

/**
 * Feed a fix and pin the sim position onto it, so a fix sequence can be
 * applied without ticking physics in between (no teleport interference).
 */
function applyFixPinned(sim: TramSim, shapeDistM: number, atMs: number): void {
  sim.sM = Math.min(Math.max(shapeDistM, sim.sM), sim.geometry.totalM);
  applySnapshot(sim, makeSnapshot({ shapeDistM, observedAtMs: atMs }), atMs);
}

/** Expected EWMA value after samples of `ratio` totalling `totalS` seconds. */
function ewma(from: number, ratio: number, totalS: number): number {
  return ratio + (from - ratio) * Math.pow(0.5, totalS / PACE_BIAS_HALF_LIFE_S);
}

describe('paceBias calibration (applySnapshot)', () => {
  it('starts at 1 and converges to ~0.7 for a tram consistently at 70% of profile speed', () => {
    const vReal = 0.7 * V_MAX_MS;
    const sim = makeSim(straightGeo(6000, vReal), 100);
    expect(sim.paceBias).toBe(1);

    // 3 fixes, 100 s apart, each advancing at exactly 70% of the 13.9 m/s cap.
    let t = T0;
    let d = 100;
    let prevBias = sim.paceBias;
    for (let k = 0; k < 3; k++) {
      t += 100_000;
      d += vReal * 100;
      applyFixPinned(sim, d, t);
      expect(sim.paceBias).toBeLessThan(prevBias); // monotone toward 0.7
      prevBias = sim.paceBias;
    }
    expect(sim.paceBias).toBeGreaterThanOrEqual(0.6);
    expect(sim.paceBias).toBeLessThanOrEqual(0.8);
    expect(sim.paceBias).toBeCloseTo(ewma(1, 0.7, 300), 3);
    expect(sim.lastTeleportMs).toBe(0); // calibration, not teleports
  });

  it('recency: after a step change to 120% pace, the bias crosses 1.0 within ~3.5 min', () => {
    const vFast = 1.2 * V_MAX_MS; // ratio sample = 1.2 exactly
    const sim = makeSim(straightGeo(6000, vFast), 100);
    sim.paceBias = 0.7; // previously-learned slow driver

    let t = T0;
    let d = 100;
    let crossedAfterS: number | null = null;
    for (let k = 1; k <= 7; k++) {
      t += 30_000;
      d += vFast * 30;
      applyFixPinned(sim, d, t);
      if (crossedAfterS === null && sim.paceBias >= 1.0) crossedAfterS = k * 30;
    }
    expect(crossedAfterS).not.toBeNull();
    expect(crossedAfterS!).toBeLessThanOrEqual(210); // ≤ 3.5 min of fixes
    expect(sim.paceBias).toBeCloseTo(ewma(0.7, 1.2, 210), 3);
  });

  it('clamps each ratio sample to [0.4, 1.6]', () => {
    // Absurdly fast: 3× the cap → the sample is used as 1.6, not 3.
    const fast = makeSim(straightGeo(20_000, V_MAX_MS), 0);
    applyFixPinned(fast, 3 * V_MAX_MS * PACE_BIAS_HALF_LIFE_S, T0 + PACE_BIAS_HALF_LIFE_S * 1000);
    expect(fast.paceBias).toBeCloseTo(ewma(1, PACE_BIAS_MAX_RATIO, PACE_BIAS_HALF_LIFE_S), 6);

    // Absurdly slow: 20 m in 150 s → the sample is used as 0.4.
    const slow = makeSim(straightGeo(6000, V_MAX_MS), 0);
    applyFixPinned(slow, 20, T0 + PACE_BIAS_HALF_LIFE_S * 1000);
    expect(slow.paceBias).toBeCloseTo(ewma(1, PACE_BIAS_MIN_RATIO, PACE_BIAS_HALF_LIFE_S), 6);

    // Long-run: the bias itself can never leave the clamp interval.
    let t = T0 + PACE_BIAS_HALF_LIFE_S * 1000;
    let d = 20;
    for (let k = 0; k < 20; k++) {
      t += 60_000;
      d += 16;
      applyFixPinned(slow, d, t);
      expect(slow.paceBias).toBeGreaterThanOrEqual(PACE_BIAS_MIN_RATIO);
    }
    expect(slow.paceBias).toBeCloseTo(PACE_BIAS_MIN_RATIO, 1);
  });

  it('skips degenerate samples (Δt < 8 s, Δs < 15 m, backwards fixes, stale fixes)', () => {
    const sim = makeSim(straightGeo(6000, V_MAX_MS), 500);
    sim.paceBias = 0.8;

    applyFixPinned(sim, 600, T0 + 5_000); // Δt = 5 s
    expect(sim.paceBias).toBe(0.8);
    applyFixPinned(sim, 610, T0 + 35_000); // Δs = 10 m
    expect(sim.paceBias).toBe(0.8);
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
    applyFixPinned(sim, 500, T0 + 60_000);
    const motionRatio = 400 / 40 / V_MAX_MS; // ≈ 0.719
    expect(sim.paceBias).toBeCloseTo(ewma(1, motionRatio, 60), 3);
    // Sanity: clearly above what the raw (dwell-polluted) ratio would give.
    expect(sim.paceBias).toBeGreaterThan(ewma(1, 400 / 60 / V_MAX_MS, 60) + 0.02);
  });

  it('resets to 1.0 on a hard teleport', () => {
    const sim = makeSim(straightGeo(6000, V_MAX_MS), 100);
    sim.paceBias = 0.7;
    applySnapshot(sim, makeSnapshot({ shapeDistM: 2000, observedAtMs: T0 + 30_000 }), T0 + 30_000);
    expect(sim.lastTeleportMs).toBe(T0 + 30_000);
    expect(sim.paceBias).toBe(1);
  });
});

describe('meanCruiseCapOver', () => {
  it('is the flat cap on a straight and length-weights mixed-cap spans', () => {
    const geo = straightGeo(1000, V_MAX_MS);
    const profile = buildSpeedProfile(geo, { daytime: false });
    expect(meanCruiseCapOver(profile, geo, 100, 900)).toBeCloseTo(V_MAX_MS, 6);

    // Synthetic profile: first half capped at 5 m/s, second at 10 m/s.
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
    // 750 m span: 500 m at 5 + 250 m at 10 → 6.67.
    expect(meanCruiseCapOver(profile2, geo2, 0, 750)).toBeCloseTo((500 * 5 + 250 * 10) / 750, 3);
    // Degenerate span falls back to the point cap.
    expect(meanCruiseCapOver(profile2, geo2, 250, 250)).toBeCloseTo(5, 6);
  });
});

describe('paceBias applied to the pace controller (integration)', () => {
  it('a 70%-pace tram stops sprint-and-crawl oscillating once calibrated', () => {
    const vReal = 0.7 * V_MAX_MS; // ≈ 9.73 m/s, also the schedule pace
    const geo = straightGeo(6000, vReal);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 0, observedAtMs: T0 }), T0);

    // 400 s of 10 Hz ticks with a genuine fix every 20 s at exactly 70% pace.
    const DT = 0.1;
    let now = T0;
    let obsD = 0;
    let minE = Infinity;
    let vMax = 0;
    let crawled = false;
    for (let step = 1; step <= 4000; step++) {
      now += DT * 1000;
      if (step % 200 === 0) {
        obsD += vReal * 20;
        applySnapshot(sim, makeSnapshot({ shapeDistM: obsD, observedAtMs: now }), now);
      }
      tick(sim, now, DT);
      if (step > 3000) {
        // Converged window (t > 300 s): measure tracking quality.
        minE = Math.min(minE, targetDistAt(sim, now) - sim.sM);
        vMax = Math.max(vMax, sim.vMs);
        if (sim.crawling) crawled = true;
      }
    }

    expect(sim.lastTeleportMs).toBe(0);
    expect(sim.paceBias).toBeGreaterThan(0.6);
    expect(sim.paceBias).toBeLessThan(0.85);
    // Calibrated: cruises near the tram's real pace instead of sprinting to
    // the 13.9 m/s cap and then hard-brake crawling.
    expect(crawled).toBe(false);
    expect(minE).toBeGreaterThan(-HARD_BRAKE_ENTER_M);
    expect(vMax).toBeLessThan(12.5);
    expect(vMax).toBeGreaterThan(0.8 * vReal); // still actually moving at pace
  });
});
