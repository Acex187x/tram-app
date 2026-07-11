/// <reference types="jest" />

// Time-of-day pace model: neutral shipped tables, hour-boundary blending,
// composition with the pace controller / braking envelope / default dwells,
// and bit-identical neutrality of the shipped (all-1.0) tables.

import {
  buildSpeedProfile,
  pragueHour,
  pragueHourFrac,
  TOD_DWELL_TABLE,
  TOD_PACE_TABLE,
  todDwellFactor,
  todPaceFactor,
  V_CRUISE_REF_MS,
  V_MAX_MS,
  vAllowedAt,
} from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  CATCHUP_MAX_FACTOR,
  createSim,
  dwellDurationMs,
  PACE_BIAS_HALF_LIFE_S,
  PACE_BIAS_PRIOR,
  tick,
  type TramSim,
} from '@/lib/engine/tramSim';
import type { RouteGeometry, RouteStop } from '@/lib/types';
import { makeGeometry, makeSnapshot } from './helpers';

// Captured at module load, before any test mutates the tables.
const SHIPPED_PACE = TOD_PACE_TABLE.slice();
const SHIPPED_DWELL = TOD_DWELL_TABLE.slice();

const T0 = 1_000_000_000_000;
const DT = 0.1;

/** Winter timestamp (CET = UTC+1): utcHour:utcMin UTC = (utcHour+1):utcMin Prague. */
function winterUtc(utcHour: number, utcMin = 0, utcSec = 0): number {
  return Date.UTC(2026, 0, 15, utcHour, utcMin, utcSec);
}

afterEach(() => {
  TOD_PACE_TABLE.splice(0, TOD_PACE_TABLE.length, ...SHIPPED_PACE);
  TOD_DWELL_TABLE.splice(0, TOD_DWELL_TABLE.length, ...SHIPPED_DWELL);
});

describe('shipped table shape', () => {
  it('both tables have 24 entries, all exactly 1.0 (neutral until calibrated)', () => {
    expect(SHIPPED_PACE).toHaveLength(24);
    expect(SHIPPED_DWELL).toHaveLength(24);
    expect(SHIPPED_PACE.every((v) => v === 1)).toBe(true);
    expect(SHIPPED_DWELL.every((v) => v === 1)).toBe(true);
  });

  it('factors are exactly 1 at any time of day/year with the shipped tables', () => {
    // 48 h sweep at 7-minute steps plus a summer (CEST) sweep.
    for (let i = 0; i < (48 * 60) / 7; i++) {
      const t = winterUtc(0) + i * 7 * 60_000;
      expect(todPaceFactor(t)).toBe(1);
      expect(todDwellFactor(t)).toBe(1);
    }
    for (let i = 0; i < 24; i++) {
      const t = Date.UTC(2026, 6, 11, i, 13, 37);
      expect(todPaceFactor(t)).toBe(1);
      expect(todDwellFactor(t)).toBe(1);
    }
  });
});

describe('Prague local hour resolution', () => {
  it('resolves winter (CET, UTC+1) fractional hours', () => {
    expect(pragueHourFrac(winterUtc(6, 0))).toBe(7);
    expect(pragueHourFrac(winterUtc(6, 30))).toBe(7.5);
    expect(pragueHour(winterUtc(6, 30))).toBe(7);
    expect(pragueHour(winterUtc(22, 30))).toBe(23);
  });

  it('resolves summer (CEST, UTC+2) hours', () => {
    expect(pragueHourFrac(Date.UTC(2026, 6, 11, 10, 0))).toBe(12);
  });

  it('has sub-minute resolution (seconds blend within the minute)', () => {
    expect(pragueHourFrac(winterUtc(6, 0, 30))).toBeCloseTo(7 + 30 / 3600, 12);
  });
});

describe('boundary blending', () => {
  it('interpolates linearly between adjacent hour entries', () => {
    TOD_PACE_TABLE[7] = 0.8;
    TOD_PACE_TABLE[8] = 1.2;
    expect(todPaceFactor(winterUtc(6, 0))).toBeCloseTo(0.8, 12); // 07:00 Prague
    expect(todPaceFactor(winterUtc(6, 30))).toBeCloseTo(1.0, 12); // 07:30 = mid h7..h8
    expect(todPaceFactor(winterUtc(6, 45))).toBeCloseTo(1.1, 12); // 07:45 = 3/4 point
    expect(todPaceFactor(winterUtc(7, 0))).toBeCloseTo(1.2, 12); // 08:00 = entry 8
  });

  it('wraps 23 -> 0 across midnight', () => {
    TOD_PACE_TABLE[23] = 1.2;
    TOD_PACE_TABLE[0] = 0.8;
    expect(todPaceFactor(winterUtc(22, 30))).toBeCloseTo(1.0, 12); // 23:30 Prague
    // No discontinuity at the midnight boundary.
    const before = todPaceFactor(winterUtc(22, 59, 59)); // 23:59:59
    const after = todPaceFactor(winterUtc(23, 0, 0)); // 00:00:00
    expect(Math.abs(before - after)).toBeLessThan(0.01);
  });

  it('blends the dwell table the same way', () => {
    TOD_DWELL_TABLE[7] = 1.0;
    TOD_DWELL_TABLE[8] = 1.4;
    expect(todDwellFactor(winterUtc(6, 30))).toBeCloseTo(1.2, 12);
  });
});

// ── sim composition ──────────────────────────────────────────────────────────

/**
 * Long straight (night profile, cruise reference V_CRUISE_REF_MS everywhere),
 * sim chasing a target far ahead so the controller factor saturates at
 * CATCHUP_MAX_FACTOR in every compared run; paceBias is set below 1 so
 * ref*factor*bias stays UNDER the envelope and the time-of-day scaling is
 * directly observable.
 */
function makeCatchupSim(): TramSim {
  const geo = makeGeometry(
    [
      [0, 0],
      [6000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: 6000, arrivalMs: T0 + 10_000_000 },
    ],
  );
  const profile = buildSpeedProfile(geo, { daytime: false });
  const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 0, observedAtMs: T0 }), T0);
  // Fresh fix 400 m ahead (< teleport threshold): bold catch-up regime.
  applySnapshot(sim, makeSnapshot({ shapeDistM: 400, observedAtMs: T0 }), T0);
  sim.paceBias = 0.6;
  return sim;
}

function runSeconds(sim: TramSim, fromMs: number, seconds: number, cb?: (now: number) => void) {
  let now = fromMs;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    now += DT * 1000;
    tick(sim, now, DT);
    cb?.(now);
  }
  return now;
}

describe('cruise pace composition', () => {
  it('a mocked 0.5 pace entry halves the steady cruise speed vs baseline', () => {
    const base = makeCatchupSim();
    runSeconds(base, T0, 20);
    const vBase = base.vMs;
    // Steady state = cruise reference * CATCHUP_MAX_FACTOR * paceBias, under
    // the envelope (the 13.9 m/s network cap bounds only vAllowed).
    expect(vBase).toBeCloseTo(V_CRUISE_REF_MS * CATCHUP_MAX_FACTOR * 0.6, 9);

    TOD_PACE_TABLE.fill(0.5); // uniform so the current hour is irrelevant
    const halved = makeCatchupSim();
    runSeconds(halved, T0, 20);
    expect(halved.vMs * 2).toBeCloseTo(vBase, 12);
    expect(halved.sM).toBeLessThan(base.sM);
  });

  it('a >1 pace factor never defeats the braking envelope (stops still bind)', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1500, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 700, arrivalMs: T0 + 60_000 },
        { atM: 1500, arrivalMs: T0 + 120_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 0, observedAtMs: T0 }), T0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 450, observedAtMs: T0 }), T0);

    TOD_PACE_TABLE.fill(2); // cruise target would be 2x the cap if unclamped

    let maxV = 0;
    let dwellNow = 0;
    let now = T0;
    for (let i = 0; i < 900 && dwellNow === 0; i++) {
      now += DT * 1000;
      tick(sim, now, DT);
      maxV = Math.max(maxV, sim.vMs);
      // Envelope invariant. The tick enforces the envelope at the PRE-tick
      // position; re-evaluated at the post-tick position, explicit-Euler
      // integration against the sqrt-shaped braking curve overshoots by a few
      // A_BRK*dt near the stop (~0.31 m/s observed at dt=0.1, pre-existing
      // discretization behavior, unrelated to the TOD factor). The hard
      // no-overrun guarantees are the sM/dwell assertions below.
      const vAllowed = vAllowedAt(sim.profile, sim.geometry, sim.sM, sim.minStopDist);
      expect(sim.vMs).toBeLessThanOrEqual(vAllowed + 0.5);
      if (sim.phase === 'dwell') dwellNow = now;
      else expect(sim.sM).toBeLessThanOrEqual(700 + 1e-9); // never slides past the stop
    }
    expect(dwellNow).toBeGreaterThan(0); // reached and stopped at the mid stop
    expect(sim.vMs).toBe(0);
    expect(sim.sM).toBeLessThanOrEqual(700 + 1e-9);
    expect(maxV).toBeGreaterThan(13); // ran at the network cap...
    expect(maxV).toBeLessThanOrEqual(V_MAX_MS + 1e-9); // ...but never above it
  });
});

// ── dwell composition ────────────────────────────────────────────────────────

function makeDwellGeometry(): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [1200, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: 300, arrivalMs: T0 + 60_000 }, // dwellSeconds 0 -> DEFAULT dwell path
      { atM: 1200, arrivalMs: T0 + 240_000 },
    ],
  );
}

/** Run until the sim enters 'dwell'; returns the dwell duration set, ms. */
function runToDwell(geo: RouteGeometry, maxSeconds: number): number | null {
  const profile = buildSpeedProfile(geo, { daytime: false });
  const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 0, observedAtMs: T0 }), T0);
  let now = T0;
  const steps = Math.round(maxSeconds / DT);
  for (let i = 0; i < steps; i++) {
    now += DT * 1000;
    tick(sim, now, DT);
    if (sim.phase === 'dwell') return sim.dwellUntilMs - now;
  }
  return null;
}

describe('default dwell composition', () => {
  it('dwell factor 2 doubles the DEFAULT dwell, scheduled dwell stays untouched', () => {
    const stop = makeDwellGeometry().stops[1];
    expect(stop.dwellSeconds).toBe(0);
    const baseMs = dwellDurationMs(stop); // no time context -> unscaled default

    TOD_DWELL_TABLE.fill(2);
    expect(dwellDurationMs(stop, T0)).toBe(baseMs * 2);
    // Scheduled computed dwell is never time-of-day scaled.
    const scheduled: RouteStop = { ...stop, dwellSeconds: 25 };
    expect(dwellDurationMs(scheduled, T0)).toBe(25_000);
  });

  it('a sim arriving at a default-dwell stop dwells twice as long under factor 2', () => {
    const geo = makeDwellGeometry();
    const neutral = runToDwell(geo, 120);
    expect(neutral).not.toBeNull();
    expect(neutral!).toBeCloseTo(dwellDurationMs(geo.stops[1]), 3);

    TOD_DWELL_TABLE.fill(2);
    const doubled = runToDwell(geo, 120);
    expect(doubled).not.toBeNull();
    expect(doubled!).toBeCloseTo(neutral! * 2, 3);
  });
});

// ── paceBias × TOD composition (updatePaceBias residual learning) ───────────
//
// tick() multiplies the cruise target by ref × factor × paceBias × TOD, so
// updatePaceBias must measure the ratio against expected × TOD as well —
// otherwise the bias re-learns the TOD factor into itself and the factor
// applies TWICE once the table ships non-1.0 entries (night calibration round
// 2026-07-12: composition fixed BEFORE any non-neutral entry lands).

/** Expected EWMA value after one `ratio` sample spanning `totalS` seconds. */
function ewma(from: number, ratio: number, totalS: number): number {
  return ratio + (from - ratio) * Math.pow(0.5, totalS / PACE_BIAS_HALF_LIFE_S);
}

/** Straight geometry, terminal stops only (nothing strictly inside the span). */
function longStraight(lengthM: number): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [lengthM, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: lengthM, arrivalMs: T0 + 1_000_000 },
    ],
  );
}

/** Feed a fix with the sim pinned onto it (no teleport interference). */
function applyFixPinned(sim: TramSim, shapeDistM: number, atMs: number): void {
  sim.sM = Math.min(Math.max(shapeDistM, sim.sM), sim.geometry.totalM);
  applySnapshot(sim, makeSnapshot({ shapeDistM, observedAtMs: atMs }), atMs);
}

describe('updatePaceBias measures against expected × todPaceFactor (residual learning)', () => {
  it('under a uniform 0.5 table a tram at 45% of the reference is ratio 0.9, not 0.45', () => {
    TOD_PACE_TABLE.fill(0.5);
    const vReal = 0.45 * V_CRUISE_REF_MS;
    const geo = longStraight(6000);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 100, observedAtMs: T0 }), T0);
    applyFixPinned(sim, 100 + vReal * 100, T0 + 100_000);
    // real / (expected × tod) = 0.45·ref / (ref × 0.5) = 0.9 — the residual.
    expect(sim.paceBias).toBeCloseTo(ewma(PACE_BIAS_PRIOR, 0.9, 100), 6);
  });

  it('evaluates the hour-blended factor at the inter-fix MIDPOINT', () => {
    TOD_PACE_TABLE[7] = 0.5;
    TOD_PACE_TABLE[8] = 1.5;
    // Fix span 07:10 → 07:20 Prague (winter): midpoint 07:15 blends h7..h8 at
    // the quarter point → 0.5 + (1.5 − 0.5) × 0.25 = 0.75.
    const t1 = winterUtc(6, 10);
    const t2 = winterUtc(6, 20);
    const vReal = 0.675 * V_CRUISE_REF_MS; // ratio = 0.675 / 0.75 = 0.9
    const geo = longStraight(8000);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 100, observedAtMs: t1 }), t1);
    applyFixPinned(sim, 100 + vReal * 600, t2);
    expect(sim.paceBias).toBeCloseTo(ewma(PACE_BIAS_PRIOR, 0.9, 600), 6);
  });

  it('with the shipped neutral table the learned ratio is unchanged (regression guard)', () => {
    const vReal = 0.9 * V_CRUISE_REF_MS;
    const geo = longStraight(6000);
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 100, observedAtMs: T0 }), T0);
    applyFixPinned(sim, 100 + vReal * 100, T0 + 100_000);
    expect(sim.paceBias).toBeCloseTo(ewma(PACE_BIAS_PRIOR, 0.9, 100), 6);
  });
});

// ── neutrality: the shipped table is a bit-identical no-op ──────────────────

/** Full [sM, vMs] trajectory of a 100 s run over the dwell geometry. */
function trajectory(): number[] {
  const geo = makeDwellGeometry();
  const profile = buildSpeedProfile(geo, { daytime: false });
  const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 0, observedAtMs: T0 }), T0);
  const out: number[] = [];
  let now = T0;
  for (let i = 0; i < 1000; i++) {
    now += DT * 1000;
    tick(sim, now, DT);
    out.push(sim.sM, sim.vMs);
  }
  return out;
}

describe('neutrality of the shipped tables', () => {
  it('the hook is live (a non-neutral table changes the trajectory) yet the shipped 1.0 table reproduces it bit-identically', () => {
    // Baseline with the shipped (all-1.0) tables. Since todPaceFactor and
    // todDwellFactor return exactly 1 (asserted above) and x * 1.0 === x in
    // IEEE-754, this trajectory is bit-identical to the pre-hook physics.
    const baseline = trajectory();

    // Prove the hook is actually wired into the sim: a non-neutral table
    // must produce a different trajectory.
    TOD_PACE_TABLE.fill(0.5);
    TOD_DWELL_TABLE.fill(2);
    const perturbed = trajectory();
    expect(perturbed).not.toEqual(baseline);

    // Restore the shipped values: the run must match the baseline EXACTLY.
    TOD_PACE_TABLE.splice(0, TOD_PACE_TABLE.length, ...SHIPPED_PACE);
    TOD_DWELL_TABLE.splice(0, TOD_DWELL_TABLE.length, ...SHIPPED_DWELL);
    const restored = trajectory();
    expect(restored.length).toBe(baseline.length);
    expect(restored.every((v, i) => Object.is(v, baseline[i]))).toBe(true);
  });
});
