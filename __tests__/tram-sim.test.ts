/// <reference types="jest" />

import { A_ACC, A_BRK, buildSpeedProfile, V_MAX_MS } from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  buildScheduleAnchor,
  createSim,
  dwellDurationMs,
  evalScheduleAnchor,
  observedDistAt,
  STOP_REACH_M,
  targetDistAt,
  tick,
  type TramSim,
} from '@/lib/engine/tramSim';
import type { RouteGeometry, RouteStop } from '@/lib/types';
import { makeGeometry, makeSnapshot } from './helpers';

const T0 = 1_000_000_000_000;
const DT = 0.1;

function makeSim(geo: RouteGeometry, shapeDistM = 0, delaySeconds = 0, nowMs = T0): TramSim {
  const profile = buildSpeedProfile(geo, { daytime: false });
  const snapshot = makeSnapshot({ shapeDistM, observedAtMs: nowMs, delaySeconds });
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

describe('schedule anchor', () => {
  const stops: RouteStop[] = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0, departureMs: T0 + 20_000 },
      { atM: 1000, arrivalMs: T0 + 120_000 },
    ],
  ).stops;

  it('is piecewise-linear between stops and flat during dwells', () => {
    const anchor = buildScheduleAnchor(stops, 0);
    expect(evalScheduleAnchor(anchor, T0 - 60_000)).toBe(0); // before departure
    expect(evalScheduleAnchor(anchor, T0 + 10_000)).toBe(0); // dwelling at first stop
    expect(evalScheduleAnchor(anchor, T0 + 70_000)).toBeCloseTo(500, 0); // halfway
    expect(evalScheduleAnchor(anchor, T0 + 999_000)).toBeCloseTo(1000, 3); // after arrival
  });

  it('shifts by delaySeconds', () => {
    const onTime = buildScheduleAnchor(stops, 0);
    const late = buildScheduleAnchor(stops, 60);
    expect(evalScheduleAnchor(late, T0 + 70_000 + 60_000)).toBeCloseTo(
      evalScheduleAnchor(onTime, T0 + 70_000),
      3,
    );
  });
});

describe('straight-line acceleration', () => {
  it('ramps up to vmax with accel ≤ 1.0 m/s² and never exceeds the hard cap', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 3000, arrivalMs: T0 + Math.round((3000 / V_MAX_MS) * 1000) },
      ],
    );
    const sim = makeSim(geo);
    expect(sim.sM).toBe(0);
    expect(sim.vMs).toBe(0);

    // Acceleration is clamped: after 1 s, v ≤ 1.0 m/s (+ eps).
    run(sim, T0, 1);
    expect(sim.vMs).toBeLessThanOrEqual(1.0 + 1e-6);

    let vMax = 0;
    let sPrev = sim.sM;
    run(sim, T0 + 1000, 39, () => {
      vMax = Math.max(vMax, sim.vMs);
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // monotone
      sPrev = sim.sM;
    });
    expect(vMax).toBeGreaterThanOrEqual(13); // reached ~vmax
    expect(vMax).toBeLessThanOrEqual(V_MAX_MS + 1e-6); // catch-up never exceeds the hard cap
  });
});

describe('braking before a sharp 90° curve', () => {
  it('crosses the corner below 30% of vmax and recovers after', () => {
    // Slack schedule (3 m/s pace) → tram runs ahead, pace factor bottoms at 0.55.
    const geo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [500, 500],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 1000, arrivalMs: T0 + Math.round((1000 / 3) * 1000) },
      ],
    );
    const sim = makeSim(geo);
    const cornerSpeeds: number[] = [];
    const afterSpeeds: number[] = [];
    let vBefore = 0;
    run(sim, T0, 240, () => {
      if (sim.sM > 300 && sim.sM < 400) vBefore = Math.max(vBefore, sim.vMs);
      // Sample at/after the apex (incl. the trailing tram-length window): the
      // envelope only requires reaching the curve cap AT the apex point.
      if (sim.sM >= 499 && sim.sM <= 512) cornerSpeeds.push(sim.vMs);
      if (sim.sM >= 700 && sim.sM <= 800) afterSpeeds.push(sim.vMs);
    });

    expect(vBefore).toBeGreaterThan(5); // cruising on the straight
    expect(cornerSpeeds.length).toBeGreaterThan(0); // actually crossed the corner
    expect(Math.max(...cornerSpeeds)).toBeLessThan(0.3 * V_MAX_MS);
    expect(Math.max(...cornerSpeeds)).toBeGreaterThan(0.3); // still moving, no stall
    expect(afterSpeeds.length).toBeGreaterThan(0);
    expect(Math.max(...afterSpeeds)).toBeGreaterThan(4); // accelerates out of the curve
  });
});

describe('stop dwell + terminal hold', () => {
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
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // never reverses
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

    // Terminal hold: another minute of ticks moves nothing.
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
    const stop: RouteStop = { ...makeGeometry([[0, 0], [100, 0]], [{ atM: 50, arrivalMs: T0 }]).stops[0] };
    stop.dwellSeconds = 0;
    const d1 = dwellDurationMs(stop);
    const d2 = dwellDurationMs(stop);
    expect(d1).toBe(d2); // deterministic
    expect(d1).toBeGreaterThanOrEqual(10_000);
    expect(d1).toBeLessThanOrEqual(26_000);
  });
});

describe('pace controller', () => {
  it('catches up when behind schedule and never reverses', () => {
    // Departed 60 s ago at 5 m/s pace → sSched(T0) = 300, tram at 0 → e = 300.
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 - 60_000 + 600_000 },
      ],
    );
    const sim = makeSim(geo);
    const e0 = evalScheduleAnchor(sim.lastAnchor, T0) - sim.sM;
    expect(e0).toBeCloseTo(300, 0);

    let sPrev = sim.sM;
    let vMax = 0;
    let lastNow = T0;
    run(sim, T0, 120, (now) => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // never reverses
      expect(sim.vMs).toBeGreaterThanOrEqual(0);
      vMax = Math.max(vMax, sim.vMs);
      sPrev = sim.sM;
      lastNow = now;
    });

    const eEnd = evalScheduleAnchor(sim.lastAnchor, lastNow) - sim.sM;
    expect(eEnd).toBeLessThan(50); // caught up
    expect(vMax).toBeGreaterThan(13); // ran at (nearly) full allowed speed to catch up
    expect(vMax).toBeLessThanOrEqual(V_MAX_MS + 1e-6); // …never above the hard cap
  });
});

describe('observation reconciliation (applySnapshot)', () => {
  // 10 m/s schedule pace → the controller has a real equilibrium below vmax.
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

  it('converges toward a fresher observed shapeDistM within ~30 s', () => {
    const sim = makeSim(geo);
    let now = run(sim, T0, 30);

    // Fresh AVL fix: the real tram is 200 m AHEAD of the sim (below teleport).
    const obsDist = sim.sM + 200;
    applySnapshot(sim, makeSnapshot({ shapeDistM: obsDist, observedAtMs: now }), now);
    expect(sim.lastTeleportMs).toBe(0);
    expect(observedDistAt(sim, now) - sim.sM).toBeCloseTo(200, 0);

    let sPrev = sim.sM;
    now = run(sim, now, 30, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // never reverses
      sPrev = sim.sM;
    });
    // ~30 s later the sim has closed most of the 200 m gap to the projected
    // observation (pre-fix the observation was ignored and the gap persisted)…
    expect(Math.abs(observedDistAt(sim, now) - sim.sM)).toBeLessThan(90);
    // …and settles into the controller deadband shortly after.
    now = run(sim, now, 15);
    expect(Math.abs(observedDistAt(sim, now) - sim.sM)).toBeLessThan(60);
  });

  it('slows down — never reverses — when the observation falls behind the sim', () => {
    const sim = makeSim(geo);
    let now = run(sim, T0, 60);
    const vBefore = sim.vMs;
    applySnapshot(
      sim,
      makeSnapshot({ shapeDistM: Math.max(0, sim.sM - 300), observedAtMs: now }),
      now,
    );
    let sPrev = sim.sM;
    now = run(sim, now, 20, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // s NEVER decreases
      expect(sim.vMs).toBeGreaterThanOrEqual(0);
      sPrev = sim.sM;
    });
    expect(sim.vMs).toBeLessThan(vBefore - 1); // eased off to let reality catch up
  });
});

describe('teleport on large observation error', () => {
  const makeGeo = (departedAgoMs: number) =>
    makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - departedAgoMs },
        { atM: 3000, arrivalMs: T0 - departedAgoMs + 600_000 }, // 5 m/s pace
      ],
    );

  it('teleports to the projected OBSERVATION when it disagrees by > 500 m', () => {
    const geo = makeGeo(200_000);
    const sim = makeSim(geo);
    expect(sim.sM).toBe(0);

    applySnapshot(sim, makeSnapshot({ shapeDistM: 1000, observedAtMs: T0 }), T0);
    expect(sim.sM).toBeCloseTo(1000, 0);
    expect(sim.vMs).toBe(0);
    expect(sim.phase).toBe('cruise');
    expect(sim.lastTeleportMs).toBe(T0);
    // Dwell memory rebuilt for the new position: the origin stop is behind.
    expect(sim.dwelledStopSeqs.has(geo.stops[0].sequence)).toBe(true);
    expect(sim.dwelledStopSeqs.has(geo.stops[1].sequence)).toBe(false);
  });

  it('trusts a fresh observation over a large timetable error (no teleport)', () => {
    const geo = makeGeo(200_000); // sSched(T0) = 1000, but the tram is really near 50 m
    const sim = makeSim(geo);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 50, observedAtMs: T0 }), T0);
    expect(sim.sM).toBe(0);
    expect(sim.lastTeleportMs).toBe(0);
    // The pace target stays anchored near the observation, not the timetable.
    expect(targetDistAt(sim, T0)).toBeLessThan(300);
  });

  it('does NOT teleport for observation errors under 500 m', () => {
    const geo = makeGeo(60_000);
    const sim = makeSim(geo);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 300, observedAtMs: T0 }), T0);
    expect(sim.sM).toBe(0);
    expect(sim.lastTeleportMs).toBe(0);
  });
});

describe('createSim initial position', () => {
  it('projects the observed shape distance forward at schedule pace', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 200_000 },
        { atM: 3000, arrivalMs: T0 + 400_000 }, // 5 m/s pace
      ],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    // Observed 10 s ago at 500 m → schedule advanced 50 m since.
    const snapshot = makeSnapshot({ shapeDistM: 500, observedAtMs: T0 - 10_000 });
    const sim = createSim(geo, profile, snapshot, T0);
    expect(sim.sM).toBeCloseTo(550, 0);
    // Stops behind the initial position are marked dwelled.
    expect(sim.dwelledStopSeqs.has(geo.stops[0].sequence)).toBe(true);
  });
});

describe('late tram braking (catch-up never defeats the envelope)', () => {
  // Schedule pace 20 m/s — faster than any tram can go — keeps the pace factor
  // pegged at its 1.65 maximum through the entire stop approach.
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
    let vPrev = sim.vMs;
    let prevPhase: string = sim.phase;
    let dwellEntries = 0;
    let vAtDwellEntry = -1;
    let vMax = 0;

    run(sim, T0, 120, () => {
      vMax = Math.max(vMax, sim.vMs);
      const enteredDwell = sim.phase === 'dwell' && prevPhase !== 'dwell';
      if (enteredDwell) {
        dwellEntries++;
        vAtDwellEntry = vPrev;
      } else {
        // No frame-to-frame speed discontinuity beyond the accel/brake clamps.
        const dv = sim.vMs - vPrev;
        expect(dv).toBeLessThanOrEqual(A_ACC * DT + 1e-9);
        expect(dv).toBeGreaterThanOrEqual(-A_BRK * DT - 1e-9);
      }
      // On the approach, speed obeys the braking envelope toward the stop.
      // (0.6 m/s allowance for accumulated per-frame integration lag; the
      // pre-fix 1.65× envelope violated this by several m/s.)
      if (dwellEntries === 0 && sim.sM > 600 && sim.sM < 1000 - STOP_REACH_M) {
        expect(sim.vMs).toBeLessThanOrEqual(Math.sqrt(2 * A_BRK * (1000 - sim.sM)) + 0.6);
      }
      vPrev = sim.vMs;
      prevPhase = sim.phase;
    });

    // Hard cap holds even at factor 1.65 (no ~66-70 km/h approach).
    expect(vMax).toBeLessThanOrEqual(V_MAX_MS + 1e-9);
    // The stop was neither skipped nor snapped through at speed.
    expect(dwellEntries).toBe(1);
    // Arrival speed ≈ the envelope value at the reach boundary (√(2·A_BRK·2 m)
    // ≈ 2.2 m/s) — nearly stopped, not a 60 km/h → 0 snap like pre-fix.
    expect(vAtDwellEntry).toBeGreaterThanOrEqual(0);
    expect(vAtDwellEntry).toBeLessThan(Math.sqrt(2 * A_BRK * STOP_REACH_M) + 0.8);
  });
});

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

  it('spawning 1 m before a stop dwells there exactly once, until the scheduled departure', () => {
    const geo = makeStopGeo();
    const sim = makeSim(geo, 499);
    // The stop 1 m AHEAD is not silently marked as served — it dwells now.
    expect(sim.phase).toBe('dwell');
    expect(sim.dwellUntilMs).toBe(T0 + 10_000); // remaining dwell = scheduled departure
    expect(sim.dwelledStopSeqs.has(geo.stops[1].sequence)).toBe(true);
    expect(sim.dwelledStopSeqs.has(geo.stops[0].sequence)).toBe(true); // truly behind

    let dwellReEntries = 0;
    let prevPhase: string = sim.phase;
    run(sim, T0, 60, () => {
      if (sim.phase === 'dwell' && prevPhase !== 'dwell') dwellReEntries++;
      prevPhase = sim.phase;
    });
    expect(dwellReEntries).toBe(0); // the seeded dwell was the only one
    expect(sim.sM).toBeGreaterThan(510); // and the tram departed afterwards
  });

  it('feed at_stop initializes a dwell at the feed-declared stop', () => {
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
    expect(sim.dwelledStopSeqs.has(geo.stops[0].sequence)).toBe(true);
    expect(sim.dwelledStopSeqs.has(geo.stops[1].sequence)).toBe(true);
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
    expect(sim.dwelledStopSeqs.has(geo.stops[1].sequence)).toBe(true);
  });
});