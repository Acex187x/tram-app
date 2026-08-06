/// <reference types="jest" />
//
// Engine v2 core semantics (docs/decisions/engine-v2.md §2.2–§2.3):
//  PREDICTOR (tramSim.ts) — reseeds on every genuinely-new fix with a
//  closed-form segmented advance over the fix's TRUE age, cruises at the
//  learned pace under the braking envelope, fixed dwells, terminal
//  latch/un-latch, gap-aware teleport classification.
//  SMOOTHER (smoother.ts, driven through TramEngine) — the r2 regime table:
//  hold-follow platform capture, track band, continuous catch-up ramp, yield
//  hysteresis, per-stop dwell sync, skip roll-through, monotonic sM.

import { TramEngine } from '@/lib/engine/engine';
import {
  A_ACC,
  A_BRK,
  buildSpeedProfile,
  V_CRUISE_REF_MS,
  V_MAX_MS,
} from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  createSim,
  dwellDurationMs,
  FEED_LATENCY_S,
  maxAdvanceM,
  PACE_BIAS_PRIOR,
  STOP_REACH_M,
  TELEPORT_GAP_MARGIN,
  TELEPORT_GAP_MIN_S,
  TELEPORT_THRESHOLD_MAX_M,
  teleportThresholdM,
  TERMINAL_UNLATCH_BEHIND_M,
  tick,
  type TramSim,
} from '@/lib/engine/tramSim';
import {
  DWELL_MIN_S,
  DWELL_SKIP_ROLL_V_MS,
  DWELL_SKIP_ZONE_M,
  TRAIL_M,
} from '@/lib/engine/smoother';
import type { RouteGeometry } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

const T0 = 1_000_000_000_000;
const DT = 0.1;
/** Fresh-sim cruise pace: prior × reference (flat straight, neutral TOD). */
const PRIOR_CRUISE = PACE_BIAS_PRIOR * V_CRUISE_REF_MS; // ≈ 7.254 m/s
/** Closed-form advance of a fix ingested at its own obsAt (latency only), m. */
const LATENCY_ADVANCE_M = FEED_LATENCY_S * PRIOR_CRUISE; // ≈ 21.8 m

function makeSim(geo: RouteGeometry, shapeDistM = 0, nowMs = T0): TramSim {
  const profile = buildSpeedProfile(geo, { daytime: false });
  const snapshot = makeSnapshot({ shapeDistM, observedAtMs: nowMs });
  return createSim(geo, profile, snapshot, nowMs);
}

/** Run the sim for `seconds`, calling cb after every tick. */
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

function makeEngine(): TramEngine {
  return new TramEngine({
    resolveModel: () => makeSpec1(),
    isDaytime: () => false,
    isCoupled: () => false,
  });
}

function runEngine(
  engine: TramEngine,
  fromMs: number,
  seconds: number,
  cb?: (nowMs: number) => void,
): number {
  const steps = Math.round((seconds * 1000) / 100);
  let now = fromMs;
  for (let i = 0; i < steps; i++) {
    now += 100;
    engine.tick(now);
    cb?.(now);
  }
  return now;
}

// ── predictor: acceleration / envelope basics ────────────────────────────────

describe('straight-line acceleration (predictor)', () => {
  it('ramps up with accel ≤ A_ACC and never exceeds the hard cap', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 3000, arrivalMs: T0 + 300_000 },
      ],
    );
    const sim = makeSim(geo);
    // A learned-fast tram: the cruise product exceeds the envelope cap, so
    // the run exercises the accel clamp and the hard V_MAX_MS bound.
    sim.paceBias = 1.3;
    // Mid-segment reseeds seed cruise speed; force a standstill to observe
    // the acceleration clamp from v = 0.
    expect(sim.vMs).toBeGreaterThan(0);
    sim.vMs = 0;

    run(sim, T0, 1);
    expect(sim.vMs).toBeLessThanOrEqual(A_ACC + 1e-6);

    let vMax = 0;
    let sPrev = sim.sM;
    run(sim, T0 + 1000, 39, () => {
      vMax = Math.max(vMax, sim.vMs);
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // monotone between fixes
      sPrev = sim.sM;
    });
    expect(vMax).toBeGreaterThanOrEqual(13); // reached ~the envelope cap
    expect(vMax).toBeLessThanOrEqual(V_MAX_MS + 1e-6);
  });
});

describe('braking before a sharp 90° curve (predictor)', () => {
  it('crosses the corner below 30% of vmax and recovers after', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [500, 500],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 1000, arrivalMs: T0 + 150_000 },
      ],
    );
    const sim = makeSim(geo);
    const cornerSpeeds: number[] = [];
    const afterSpeeds: number[] = [];
    let vBefore = 0;
    run(sim, T0, 200, () => {
      if (sim.sM > 300 && sim.sM < 400) vBefore = Math.max(vBefore, sim.vMs);
      if (sim.sM >= 499 && sim.sM <= 512) cornerSpeeds.push(sim.vMs);
      if (sim.sM >= 700 && sim.sM <= 800) afterSpeeds.push(sim.vMs);
    });

    expect(vBefore).toBeGreaterThan(5); // cruising on the straight
    expect(cornerSpeeds.length).toBeGreaterThan(0);
    expect(Math.max(...cornerSpeeds)).toBeLessThan(0.3 * V_MAX_MS);
    expect(Math.max(...cornerSpeeds)).toBeGreaterThan(0.3); // no stall
    expect(afterSpeeds.length).toBeGreaterThan(0);
    expect(Math.max(...afterSpeeds)).toBeGreaterThan(4);
  });
});

// ── predictor: dwell + terminal ──────────────────────────────────────────────

describe('stop dwell + terminal hold (predictor)', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: 500, arrivalMs: T0 + 62_500, departureMs: T0 + 74_500, dwellSeconds: 12 },
      { atM: 1000, arrivalMs: T0 + 137_000, isTerminal: true },
    ],
  );

  it('stops once at the stop, dwells the configured time, departs, then holds at terminal', () => {
    const sim = makeSim(geo);
    let dwellEnterMs = 0;
    let dwellExitMs = 0;
    let dwellEntries = 0;
    let terminalAtMs = 0;
    let prevPhase = sim.phase;
    let sPrev = sim.sM;

    const end = run(sim, T0, 280, (now) => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // never reverses between fixes
      sPrev = sim.sM;
      if (sim.phase === 'dwell' && prevPhase !== 'dwell') {
        dwellEntries++;
        dwellEnterMs = now;
        expect(sim.sM).toBeGreaterThanOrEqual(497.5);
        expect(sim.sM).toBeLessThanOrEqual(500.01);
        expect(sim.vMs).toBe(0);
      }
      if (prevPhase === 'dwell' && sim.phase === 'cruise' && dwellExitMs === 0) dwellExitMs = now;
      if (sim.phase === 'terminal' && terminalAtMs === 0) terminalAtMs = now;
      prevPhase = sim.phase;
    });

    // Dwelled exactly once, for ~12 s (configured, no jitter).
    expect(dwellEntries).toBe(1);
    expect(dwellExitMs).toBeGreaterThan(dwellEnterMs);
    expect((dwellExitMs - dwellEnterMs) / 1000).toBeGreaterThanOrEqual(11.7);
    expect((dwellExitMs - dwellEnterMs) / 1000).toBeLessThanOrEqual(12.5);

    // Reached the terminal and held.
    expect(terminalAtMs).toBeGreaterThan(0);
    expect(sim.phase).toBe('terminal');
    expect(sim.sM).toBeGreaterThanOrEqual(997.5);
    expect(sim.sM).toBeLessThanOrEqual(1000);

    const sAtTerminal = sim.sM;
    run(sim, end, 60, () => {
      expect(sim.phase).toBe('terminal');
      expect(sim.vMs).toBe(0);
    });
    expect(sim.sM).toBe(sAtTerminal);
  });

  it('does not oscillate or re-dwell after departing', () => {
    const sim = makeSim(geo);
    let dwellEntries = 0;
    let prevPhase = sim.phase;
    run(sim, T0, 280, () => {
      if (sim.phase === 'dwell' && prevPhase !== 'dwell') dwellEntries++;
      prevPhase = sim.phase;
    });
    expect(dwellEntries).toBe(1);
  });
});

describe('dwell duration fallback', () => {
  it('uses 18 s ± deterministic 0–8 s jitter when the feed gives none', () => {
    const stop = { ...makeGeometry([[0, 0], [100, 0]], [{ atM: 50, arrivalMs: T0 }]).stops[0] };
    stop.dwellSeconds = 0;
    const d1 = dwellDurationMs(stop);
    const d2 = dwellDurationMs(stop);
    expect(d1).toBe(d2); // deterministic
    expect(d1).toBeGreaterThanOrEqual(10_000);
    expect(d1).toBeLessThanOrEqual(26_000);
  });
});

// ── predictor: reseed-on-fresh-fix (closed-form segmented advance) ───────────

describe('reseed on a genuinely-new fix (closed-form advance)', () => {
  const straight = () =>
    makeGeometry(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 6000, arrivalMs: T0 + 600_000 },
      ],
    );

  it('a just-observed fix seeds at the fix + the hidden-latency advance (R12)', () => {
    const sim = makeSim(straight(), 1000);
    // trueAge = (now − obsAt) + FEED_LATENCY_S = 3 s → ~21.8 m at prior pace.
    expect(sim.sM).toBeGreaterThan(1000);
    expect(sim.sM).toBeLessThanOrEqual(1000 + LATENCY_ADVANCE_M + 1);
    // Mid-segment reseed is MOVING (field feedback #2): cruise-seeded speed.
    expect(sim.vMs).toBeCloseTo(PRIOR_CRUISE, 2);
  });

  it('an old fix advances by trueAge × learned pace on an open straight', () => {
    const geo = straight();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const snapshot = makeSnapshot({ shapeDistM: 500, observedAtMs: T0 - 60_000 });
    const sim = createSim(geo, profile, snapshot, T0);
    const trueAgeS = 60 + FEED_LATENCY_S;
    expect(sim.sM).toBeCloseTo(500 + trueAgeS * PRIOR_CRUISE, 0);
  });

  it('the closed-form advance spends dwell time at stops it crosses', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 700, arrivalMs: T0 - 300_000, dwellSeconds: 20 },
        { atM: 6000, arrivalMs: T0 + 600_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 500, observedAtMs: T0 - 60_000 }), T0);
    const trueAgeS = 60 + FEED_LATENCY_S;
    // 200 m to the stop (~27.6 s), 20 s dwell, remainder cruising.
    const expected = 700 + (trueAgeS - 200 / PRIOR_CRUISE - 20) * PRIOR_CRUISE;
    expect(sim.sM).toBeCloseTo(expected, 0);
    // Clearly short of the naive no-dwell projection.
    expect(sim.sM).toBeLessThan(500 + trueAgeS * PRIOR_CRUISE - 100);
  });

  it('a long blind window can end INSIDE a crossed dwell (standing at the platform)', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 700, arrivalMs: T0 - 300_000, dwellSeconds: 30 },
        { atM: 6000, arrivalMs: T0 + 600_000 },
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    // trueAge ≈ 33 s: ~27.6 s to reach the stop, then 30 s dwell swallows the rest.
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 500, observedAtMs: T0 - 30_000 }), T0);
    expect(sim.phase).toBe('dwell');
    expect(sim.sM).toBeCloseTo(700, 3);
    expect(sim.vMs).toBe(0);
    expect(sim.dwellUntilMs).toBeGreaterThan(T0);
  });

  it('bounds the advance by maxAdvanceM on the true age (physics cap)', () => {
    const sim = makeSim(straight(), 1000);
    sim.paceBias = 1.6; // learned-fast: pace would exceed the reference cap
    const t1 = T0 + 60_000;
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: t1 }), t1 + 30_000);
    // The stuck detector arms only on a REPEAT; this is the same fix value at
    // a new obsAt after movement… it repeats the previous fix distance, so it
    // arms the stuck hold — use a moved fix instead to isolate the cap.
    const sim2 = makeSim(straight(), 0);
    sim2.paceBias = 1.6;
    const t2 = T0 + 90_000;
    applySnapshot(sim2, makeSnapshot({ shapeDistM: 1200, observedAtMs: t2 }), t2 + 60_000);
    const trueAgeS = 60 + FEED_LATENCY_S;
    expect(sim2.sM - 1200).toBeLessThanOrEqual(maxAdvanceM(trueAgeS) + 1e-6);
  });

  it('jumps BACKWARD to a fresh fix behind the estimate (accepted live-mode UX, no fade)', () => {
    const sim = makeSim(straight(), 1000);
    let now = run(sim, T0, 30);
    const before = sim.sM;
    expect(before).toBeGreaterThan(1150);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 900, observedAtMs: now }), now);
    expect(sim.sM).toBeLessThan(before); // reseeded behind
    expect(sim.sM).toBeGreaterThanOrEqual(900);
    expect(sim.lastTeleportMs).toBe(0); // sub-threshold jump — no fade
  });

  it('a repeated poll of the same fix does NOT reseed (keeps integrating)', () => {
    const sim = makeSim(straight(), 1000);
    let now = run(sim, T0, 10);
    const before = sim.sM;
    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), now);
    expect(sim.sM).toBe(before);
    now = run(sim, now, 5);
    expect(sim.sM).toBeGreaterThan(before);
  });
});

// ── predictor: gap-aware teleport classification ─────────────────────────────

describe('gap-aware teleport classification', () => {
  const straight = () =>
    makeGeometry(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 6000, arrivalMs: T0 + 600_000 },
      ],
    );

  it('an 810 m jump after a 90 s fix gap is honest travel — no teleport fade', () => {
    const sim = makeSim(straight(), 0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 810, observedAtMs: T0 + 90_000 }), T0 + 90_000);
    expect(sim.lastTeleportMs).toBe(0);
    expect(sim.sM).toBeGreaterThanOrEqual(810);
  });

  it('a true desync jump stamps the teleport fade regardless of the gap', () => {
    const sim = makeSim(straight(), 0);
    const t1 = T0 + 90_000;
    applySnapshot(sim, makeSnapshot({ shapeDistM: 2500, observedAtMs: t1 }), t1);
    expect(sim.lastTeleportMs).toBe(t1);
    expect(sim.sM).toBeGreaterThanOrEqual(2500);
  });

  it('teleportThresholdM: gap-scaled between the calibrated floor and the desync cap', () => {
    const floor = TELEPORT_GAP_MIN_S * V_CRUISE_REF_MS * TELEPORT_GAP_MARGIN;
    expect(teleportThresholdM(0)).toBeCloseTo(floor, 5); // cold start clamps up
    expect(teleportThresholdM(100)).toBeCloseTo(
      Math.min(TELEPORT_THRESHOLD_MAX_M, 100 * V_CRUISE_REF_MS * TELEPORT_GAP_MARGIN),
      5,
    );
    expect(teleportThresholdM(600)).toBe(TELEPORT_THRESHOLD_MAX_M);
    expect(teleportThresholdM(80)).toBeGreaterThan(teleportThresholdM(50));
  });

  it('maxAdvanceM grows linearly with the fix age at cruise-reference pace', () => {
    for (const ageS of [0, 30, 60, 120, 300]) {
      expect(maxAdvanceM(ageS)).toBeCloseTo(ageS * V_CRUISE_REF_MS, 9);
    }
    expect(maxAdvanceM(-5)).toBe(0);
  });
});

// ── predictor: terminal un-latch ─────────────────────────────────────────────

describe('terminal un-latch (fresh observation far behind the latched position)', () => {
  const makeTerminalGeo = () =>
    makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 1000, arrivalMs: T0 - 300_000, isTerminal: true },
      ],
    );

  /** A predictor latched in 'terminal' at the geometry end. */
  function makeLatchedSim() {
    const geo = makeTerminalGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    expect(sim.phase).toBe('terminal');
    expect(sim.sM).toBeCloseTo(1000, 0);
    return sim;
  }

  it('re-anchors BACKWARD to a fresh fix > 150 m behind, fade-stamped, and resumes', () => {
    const sim = makeLatchedSim();
    const t1 = T0 + 20_000;
    const res = applySnapshot(sim, makeSnapshot({ shapeDistM: 700, observedAtMs: t1 }), t1);
    expect(res.terminalUnlatched).toBe(true);
    expect(sim.sM).toBeGreaterThanOrEqual(700);
    expect(sim.sM).toBeLessThan(1000 - TERMINAL_UNLATCH_BEHIND_M + 60);
    expect(sim.phase).toBe('cruise');
    expect(sim.vMs).toBeGreaterThan(0); // re-anchored mid-segment = moving
    expect(sim.lastTeleportMs).toBe(t1); // sanctioned backward correction fades

    let sPrev = sim.sM;
    run(sim, t1, 60, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev);
      sPrev = sim.sM;
    });
    expect(sim.sM).toBeGreaterThan(750);
  });

  it('holds the latch when the fresh fix is within the 150 m tolerance', () => {
    const sim = makeLatchedSim();
    const t1 = T0 + 20_000;
    const res = applySnapshot(sim, makeSnapshot({ shapeDistM: 900, observedAtMs: t1 }), t1);
    expect(res.terminalUnlatched).toBe(false);
    expect(sim.phase).toBe('terminal');
    expect(sim.sM).toBeCloseTo(1000, 0);
    expect(sim.lastTeleportMs).toBe(0);
  });

  it('ignores STALE fixes (a repeated poll of the pre-latch observation)', () => {
    const geo = makeTerminalGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 600, observedAtMs: T0 }), T0);
    sim.sM = 1000;
    sim.phase = 'terminal';
    sim.vMs = 0;
    // The next poll repeats the SAME fix — not evidence, no un-latch.
    const res = applySnapshot(sim, makeSnapshot({ shapeDistM: 600, observedAtMs: T0 }), T0 + 15_000);
    expect(res.freshFix).toBe(false);
    expect(sim.phase).toBe('terminal');
    expect(sim.sM).toBe(1000);
    // A genuinely fresh fix at the same spot IS evidence → un-latch.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 600, observedAtMs: T0 + 30_000 }), T0 + 30_000);
    expect(sim.phase).toBe('cruise');
    expect(sim.sM).toBeGreaterThanOrEqual(600);
    expect(sim.sM).toBeLessThan(700);
  });
});

// ── predictor: dwell seeding near stops ──────────────────────────────────────

describe('spawning near a stop (dwell seeding)', () => {
  const makeStopGeo = () =>
    makeGeometry(
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

  it('spawning 1 m before a stop with a future departure dwells there', () => {
    const geo = makeStopGeo();
    const sim = makeSim(geo, 499);
    expect(sim.phase).toBe('dwell');
    expect(sim.sM).toBeCloseTo(500, 3);
    expect(sim.vMs).toBe(0);
    // Remaining dwell honours the scheduled departure (timing point).
    expect(sim.dwellUntilMs).toBeGreaterThanOrEqual(T0 + 10_000);
  });

  it('feed at_stop initializes a dwell at the feed-declared stop until its departure', () => {
    const geo = makeStopGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const snapshot = makeSnapshot({
      shapeDistM: 500,
      observedAtMs: T0,
      statePosition: 'at_stop',
      lastStopSequence: geo.stops[1].sequence,
    });
    const sim = createSim(geo, profile, snapshot, T0);
    expect(sim.phase).toBe('dwell');
    expect(sim.dwellUntilMs).toBe(T0 + 10_000);
    expect(sim.fixStopDistM).toBe(geo.stops[1].distM);
  });

  it('marks a reach-window stop as served (no dwell) when its departure already passed', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 120_000 },
        { atM: 500, arrivalMs: T0 - 60_000, departureMs: T0 - 45_000 },
        { atM: 1000, arrivalMs: T0 + 120_000 },
      ],
    );
    const sim = makeSim(geo, 499);
    expect(sim.phase).toBe('cruise');
    expect(sim.sM).toBeGreaterThan(499);
  });
});

// ── predictor: late-tram braking ─────────────────────────────────────────────

describe('braking into stops (the envelope always wins)', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [2000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: 1000, arrivalMs: T0 + 50_000, departureMs: T0 + 70_000, dwellSeconds: 20 },
      { atM: 2000, arrivalMs: T0 + 150_000 },
    ],
  );

  it('approaches an isolated stop on the braking envelope and arrives smoothly', () => {
    const sim = makeSim(geo);
    sim.paceBias = 1.5; // learned-fast — the envelope must still bind
    let vPrev = sim.vMs;
    let prevPhase: string = sim.phase;
    let dwellEntries = 0;
    let vAtDwellEntry = -1;
    let vMax = 0;

    run(sim, T0, 180, () => {
      vMax = Math.max(vMax, sim.vMs);
      const enteredDwell = sim.phase === 'dwell' && prevPhase !== 'dwell';
      const enteredTerminal = sim.phase === 'terminal' && prevPhase !== 'terminal';
      if (enteredDwell) {
        dwellEntries++;
        vAtDwellEntry = vPrev;
      } else if (!enteredTerminal) {
        // Stop/terminal capture zeroes v via the reach clamp; every other
        // frame obeys the accel/brake clamps.
        const dv = sim.vMs - vPrev;
        expect(dv).toBeLessThanOrEqual(A_ACC * DT + 1e-9);
        expect(dv).toBeGreaterThanOrEqual(-A_BRK * DT - 1e-9);
      }
      if (dwellEntries === 0 && sim.sM > 600 && sim.sM < 1000 - STOP_REACH_M) {
        expect(sim.vMs).toBeLessThanOrEqual(Math.sqrt(2 * A_BRK * (1000 - sim.sM)) + 0.6);
      }
      vPrev = sim.vMs;
      prevPhase = sim.phase;
    });

    expect(vMax).toBeLessThanOrEqual(V_MAX_MS + 1e-9);
    expect(dwellEntries).toBe(1);
    expect(vAtDwellEntry).toBeGreaterThanOrEqual(0);
    expect(vAtDwellEntry).toBeLessThan(Math.sqrt(2 * A_BRK * STOP_REACH_M) + 0.8);
  });
});

// ── smoother (through the engine): core regime pins ──────────────────────────

describe('smoother chases the predictor (v2 §3.3 pins)', () => {
  const straight = () =>
    makeGeometry(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 6000, arrivalMs: T0 + 600_000 },
      ],
    );

  it('mode-consistency (track regime): converged smooth and live speeds agree on identical data', () => {
    const engine = makeEngine();
    const geo = straight();
    // Fixes advancing at exactly the prior cruise pace: the predictor reseeds
    // with position continuity and the smoother stays inside the track band.
    let now = T0;
    let fixD = 500;
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: fixD, observedAtMs: now })], () => geo, now);
    engine.tick(now);
    let maxSpeedGapMs = 0;
    let teleports = 0;
    for (let k = 0; k < 6; k++) {
      // Settle 6 s after each reseed, then compare speeds over the next 14 s.
      now = runEngine(engine, now, 6);
      now = runEngine(engine, now, 14, (t) => {
        const st = engine.getState('t', t)!;
        const dbg = engine.getDebugInfo('t', t)!;
        expect(dbg.regime).toBe('track');
        if (dbg.lastTeleportMs > 0) teleports++;
        const vSmooth = st.simSpeedKmh / 3.6;
        maxSpeedGapMs = Math.max(maxSpeedGapMs, Math.abs(vSmooth - PRIOR_CRUISE));
      });
      fixD += PRIOR_CRUISE * 20;
      engine.ingest([makeSnapshot({ key: 't', shapeDistM: fixD, observedAtMs: now })], () => geo, now);
    }
    expect(teleports).toBe(0);
    // Track-regime factor stays within ~±15% of vPred at |err| ≤ 40 — the two
    // rendered modes cruise at the same speed class on identical data.
    expect(maxSpeedGapMs).toBeLessThan(0.2 * PRIOR_CRUISE);
  });

  it('catch-up divergence is transient: err shrinks monotonically back into the band', () => {
    const engine = makeEngine();
    const geo = straight();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 500, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let now = runEngine(engine, T0, 5);
    // Fresh fix +150 m: the predictor reseeds ahead; the smoother must close
    // the gap without ever exceeding it again.
    const st0 = engine.getState('t', now)!;
    engine.ingest(
      [makeSnapshot({ key: 't', shapeDistM: st0.projectedObservedDistM! + 150, observedAtMs: now })],
      () => geo,
      now,
    );
    let prevErr = Infinity;
    let sawCatchup = false;
    now = runEngine(engine, now, 40, (t) => {
      const dbg = engine.getDebugInfo('t', t)!;
      if (dbg.regime === 'catchup') sawCatchup = true;
      const err = dbg.errPredM!;
      expect(err).toBeLessThanOrEqual(prevErr + 0.5); // monotone shrink (tick noise)
      prevErr = Math.min(prevErr, err);
    });
    expect(sawCatchup).toBe(true);
    const dbgEnd = engine.getDebugInfo('t', now)!;
    expect(Math.abs(dbgEnd.errPredM!)).toBeLessThanOrEqual(40);
    expect(dbgEnd.regime).toBe('track');
  });

  it('yield: smoother ahead of a moving predictor eases off, never pedestrian, and recovers', () => {
    const engine = makeEngine();
    const geo = straight();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let now = runEngine(engine, T0, 10);
    // Fresh fix 180 m BEHIND the smoother: even after the latency advance the
    // predictor reseeds well back and keeps moving; the smoother yields
    // (never reverses, never stalls).
    const smooth0 = engine.getState('t', now)!.simDistM;
    engine.ingest(
      [makeSnapshot({ key: 't', shapeDistM: Math.max(0, smooth0 - 180), observedAtMs: now })],
      () => geo,
      now,
    );
    let sPrev = -Infinity;
    let vMin = Infinity;
    let sawYield = false;
    now = runEngine(engine, now, 20, (t) => {
      const st = engine.getState('t', t)!;
      const dbg = engine.getDebugInfo('t', t)!;
      expect(st.simDistM).toBeGreaterThanOrEqual(sPrev); // monotone
      sPrev = st.simDistM;
      if (dbg.regime === 'yield') {
        sawYield = true;
        vMin = Math.min(vMin, st.simSpeedKmh / 3.6);
      }
    });
    expect(sawYield).toBe(true);
    expect(vMin).toBeGreaterThanOrEqual(3.0 - 0.35); // never below the yield floor
  });

  it('hold-follow platform capture: the smoother dwells ON the platform, doors open', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 300_000 },
        { atM: 500, arrivalMs: T0 - 10_000, departureMs: T0 + 600_000, dwellSeconds: 30 },
        { atM: 2000, arrivalMs: T0 + 900_000 },
      ],
    );
    const engine = makeEngine();
    // Predictor approaches the stop from 350 m out and dwells there.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 350, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let captured = false;
    runEngine(engine, T0, 60, (t) => {
      const st = engine.getState('t', t)!;
      const dbg = engine.getDebugInfo('t', t)!;
      // Whenever the predictor dwells at the platform (stop-reach window),
      // the smoother must not park TRAIL_M short of it in the street: it
      // closes the gap, captures the platform and opens its doors.
      if (
        dbg.projDistM !== null &&
        Math.abs(dbg.projDistM - 500) <= STOP_REACH_M &&
        st.phase === 'dwell'
      ) {
        expect(st.simDistM).toBeGreaterThanOrEqual(500 - STOP_REACH_M - 0.5);
        expect(st.simDistM).toBeLessThanOrEqual(500 + 1e-6);
        // ON the predictor, not trailing it by TRAIL_M.
        expect(Math.abs(st.simDistM - dbg.projDistM)).toBeLessThanOrEqual(STOP_REACH_M + 0.5);
        captured = true;
      }
    });
    expect(captured).toBe(true); // the smoother joined the dwell ON the platform
  });

  it('terminal un-latch propagation: the smoother backward fade-teleports off a wrong terminal', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 1000, arrivalMs: T0 - 300_000, isTerminal: true },
      ],
    );
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 1000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let now = runEngine(engine, T0, 10);
    const latched = engine.getState('t', now)!;
    expect(latched.phase).toBe('terminal');
    expect(latched.simDistM).toBeCloseTo(1000, 0);

    // Fresh fix 300 m behind: the predictor un-latches; the smoother MUST
    // follow it backward (the err is far below the gap-aware threshold — this
    // is the sanctioned propagation, not the teleport rule).
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 700, observedAtMs: now })], () => geo, now);
    const after = engine.getState('t', now)!;
    expect(after.phase).not.toBe('terminal');
    expect(after.simDistM).toBeLessThan(800);
    const dbg = engine.getDebugInfo('t', now)!;
    expect(dbg.lastTeleportMs).toBe(now); // rendered as a fade, not a reverse drive

    // …and normal tracking resumes forward.
    let sPrev = after.simDistM;
    now = runEngine(engine, now, 20, (t) => {
      const st = engine.getState('t', t)!;
      expect(st.simDistM).toBeGreaterThanOrEqual(sPrev);
      sPrev = st.simDistM;
    });
    expect(sPrev).toBeGreaterThan(after.simDistM + 50);
  });
});

// ── smoother: stop rules (§2.3) ──────────────────────────────────────────────

describe('smoother stop rules', () => {
  it('arriving after the predictor departed (err ≤ 60): a brief min-dwell blink', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 300_000 },
        { atM: 500, arrivalMs: T0 - 10_000, dwellSeconds: 8 },
        { atM: 2000, arrivalMs: T0 + 900_000 },
      ],
    );
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 430, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    // The predictor (seeded ~450, trail puts the smoother ~10 m behind it)
    // reaches the stop first, dwells 8 s and departs; the smoother arrives
    // while/after and must not dwell the full duration once reality left.
    let dwellStart = 0;
    let dwellEnd = 0;
    runEngine(engine, T0, 60, (t) => {
      const st = engine.getState('t', t)!;
      if (st.phase === 'dwell' && Math.abs(st.simDistM - 500) <= STOP_REACH_M) {
        if (dwellStart === 0) dwellStart = t;
        dwellEnd = t;
      }
    });
    expect(dwellStart).toBeGreaterThan(0); // doors did open at the platform
    const dwellS = (dwellEnd - dwellStart) / 1000;
    // Sync dwell while the predictor dwells + prompt release after: the
    // smoother's total platform time stays in the same class as reality's 8 s
    // (never the unbounded / full-default wait).
    expect(dwellS).toBeGreaterThanOrEqual(DWELL_MIN_S - 0.5);
    expect(dwellS).toBeLessThanOrEqual(8 + DWELL_MIN_S + 2);
  });

  it('badly behind (err > 60) at a served stop: skip — roll through ≤ cap, doors closed', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 300_000 },
        { atM: 300, arrivalMs: T0 - 10_000, dwellSeconds: 18 },
        { atM: 2000, arrivalMs: T0 + 900_000 },
      ],
    );
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 250, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    let now = runEngine(engine, T0, 2);
    // Fresh fix far ahead: reality has long served and left the 300 m stop.
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 500, observedAtMs: now })], () => geo, now);
    let sawZone = false;
    let sPrev = -Infinity;
    now = runEngine(engine, now, 40, (t) => {
      const st = engine.getState('t', t)!;
      expect(st.simDistM).toBeGreaterThanOrEqual(sPrev);
      sPrev = st.simDistM;
      if (Math.abs(st.simDistM - 300) <= DWELL_SKIP_ZONE_M) {
        sawZone = true;
        expect(st.phase).not.toBe('dwell'); // doors stay closed
        expect(st.simSpeedKmh / 3.6).toBeLessThanOrEqual(DWELL_SKIP_ROLL_V_MS + 0.3);
      }
    });
    expect(sawZone).toBe(true);
    expect(engine.getState('t', now)!.simDistM).toBeGreaterThan(300 + 50);
  });

  it('the smoother trails a moving predictor by ~TRAIL_M in steady tracking', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 600_000 },
        { atM: 6000, arrivalMs: T0 + 600_000 },
      ],
    );
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 't', shapeDistM: 500, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = runEngine(engine, T0, 30);
    const st = engine.getState('t', now)!;
    const gap = st.projectedObservedDistM! - st.simDistM;
    expect(gap).toBeGreaterThan(TRAIL_M - 8);
    expect(gap).toBeLessThan(TRAIL_M + 12);
  });
});
