/// <reference types="jest" />

import { QUEUE_GAP_M, TramEngine } from '@/lib/engine/engine';
import { A_ACC, A_BRK, buildSpeedProfile, V_MAX_MS } from '@/lib/engine/speedProfile';
import {
  applySnapshot,
  buildScheduleAnchor,
  CRAWL_V_MS,
  createSim,
  dwellDurationMs,
  DWELL_EXTEND_RELEASE_M,
  DWELL_MAX_EXTEND_S,
  DWELL_MIN_S,
  DWELL_SKIP_ERR_M,
  DWELL_SKIP_ROLL_V_MS,
  DWELL_SKIP_ZONE_M,
  evalScheduleAnchor,
  HARD_BRAKE_ENTER_M,
  observedDistAt,
  OBS_BLEND_WEIGHT,
  STOP_REACH_M,
  targetDistAt,
  tick,
  TRAIL_M,
  type TramSim,
} from '@/lib/engine/tramSim';
import type { RouteGeometry, RouteStop } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

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
    // Slack schedule (3 m/s pace) → the tram cycles between gentle sprints and
    // the hard-brake crawl, so its long-run average stays pace-bound (~3 m/s);
    // the run must be long enough to reach the post-corner sampling window.
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
    run(sim, T0, 310, () => {
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
  it('catches up boldly when behind and never reverses', () => {
    // Departed 60 s ago at 5 m/s pace → sSched(T0) = 300, tram at 0 → e ≈ 290.
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

    // Converged onto the (trail-biased) pace target: the crawl regime bounds
    // any overshoot, so the error stays within the hard-brake band.
    const eEnd = targetDistAt(sim, lastNow) - sim.sM;
    expect(Math.abs(eEnd)).toBeLessThan(HARD_BRAKE_ENTER_M + 25);
    expect(vMax).toBeGreaterThan(13); // ran at (nearly) full allowed speed to catch up
    expect(vMax).toBeLessThanOrEqual(V_MAX_MS + 1e-6); // …never above the hard cap
  });

  it('trail bias: the target rides TRAIL_M behind the projected observation', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 100_000 },
        { atM: 3000, arrivalMs: T0 + 200_000 }, // 10 m/s pace
      ],
    );
    const sim = makeSim(geo, 800);
    // Same trip/schedule: blend components coincide only when obs == sched;
    // here obs (800) is behind sched (1000), so verify the exact blend − trail.
    const sSched = evalScheduleAnchor(sim.lastAnchor, T0);
    const expected = OBS_BLEND_WEIGHT * 800 + (1 - OBS_BLEND_WEIGHT) * sSched - TRAIL_M;
    expect(targetDistAt(sim, T0)).toBeCloseTo(expected, 6);
    // And 30 s later the projected observation has advanced at schedule pace.
    const later = T0 + 30_000;
    const sObs = observedDistAt(sim, later);
    const sSchedLater = evalScheduleAnchor(sim.lastAnchor, later);
    expect(targetDistAt(sim, later)).toBeCloseTo(
      OBS_BLEND_WEIGHT * sObs + (1 - OBS_BLEND_WEIGHT) * sSchedLater - TRAIL_M,
      6,
    );
  });
});

describe('hard-brake crawl when the sim ran ahead of reality', () => {
  // Slow 2 m/s schedule: reality takes a while to catch back up, so the crawl
  // regime is clearly observable.
  const geo = makeGeometry(
    [
      [0, 0],
      [3000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - 50_000 },
      { atM: 3000, arrivalMs: T0 - 50_000 + 1_500_000 },
    ],
  );

  it('sim 100 m ahead → crawls (< 1.5 m/s) until reality catches up, then resumes', () => {
    // Sim spawned at 200 m; a fresh fix says the tram is really at 100 m.
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 200, observedAtMs: T0 }), T0);
    expect(sim.sM).toBeCloseTo(200, 0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 100, observedAtMs: T0 }), T0);
    expect(sim.lastTeleportMs).toBe(0); // 100 m error — no teleport

    // e ≈ −(100 + TRAIL_M) → hard-brake regime.
    expect(targetDistAt(sim, T0) - sim.sM).toBeLessThan(-HARD_BRAKE_ENTER_M);

    // Crawl phase: after the brake settles, speed stays below 1.5 m/s while
    // the projected observation slowly closes the gap. s NEVER decreases.
    let sPrev = sim.sM;
    let now = T0;
    now = run(sim, now, 3, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev);
      sPrev = sim.sM;
    });
    let vCrawlMax = 0;
    now = run(sim, now, 60, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev);
      sPrev = sim.sM;
      vCrawlMax = Math.max(vCrawlMax, sim.vMs);
    });
    expect(vCrawlMax).toBeLessThan(1.5);
    expect(vCrawlMax).toBeGreaterThan(0); // still creeping, never frozen/backwards
    expect(sim.crawling).toBe(true);

    // Reality catches up (target advances at 2 m/s vs the 1 m/s crawl): the
    // regime exits and the tram accelerates well past crawl speed.
    let vMaxAfter = 0;
    let exited = false;
    run(sim, now, 60, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev);
      sPrev = sim.sM;
      if (!sim.crawling) exited = true;
      if (exited) vMaxAfter = Math.max(vMaxAfter, sim.vMs);
    });
    expect(exited).toBe(true);
    expect(vMaxAfter).toBeGreaterThan(CRAWL_V_MS + 1);
  });

  it('never moves backwards through brake, crawl and recovery', () => {
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 100, observedAtMs: T0 }), T0);
    run(sim, T0, 20); // pick up speed (and possibly already cycle into a crawl)
    const now0 = T0 + 20_000;
    applySnapshot(sim, makeSnapshot({ shapeDistM: sim.sM - 150, observedAtMs: now0 }), now0);
    let sPrev = sim.sM;
    run(sim, now0, 180, () => {
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // s NEVER decreases
      expect(sim.vMs).toBeGreaterThanOrEqual(0);
      sPrev = sim.sM;
    });
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

describe('adaptive dwell', () => {
  // Flat schedule at the 500 m stop (the timetable says the tram is dwelling
  // there right NOW, with a departure far in the future): the projected
  // observation is frozen, so the tracking error e = target − s changes only
  // via the sim's own motion or a fresh fix — deterministic test conditions.
  const makeAheadGeo = () =>
    makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 530_000 },
        { atM: 500, arrivalMs: T0 - 30_000, departureMs: T0 + 300_000, dwellSeconds: 10 },
        { atM: 1000, arrivalMs: T0 + 800_000 },
      ],
    );

  function makeAdaptiveSim(geo: RouteGeometry, shapeDistM: number, nowMs = T0): TramSim {
    const profile = buildSpeedProfile(geo, { daytime: false });
    const snapshot = makeSnapshot({ shapeDistM, observedAtMs: nowMs });
    return createSim(geo, profile, snapshot, nowMs, undefined, { adaptiveDwell: true });
  }

  /** Drive the sim until it enters 'dwell'; returns the entry timestamp. */
  function runToDwell(sim: TramSim, fromMs: number, maxSeconds: number): number {
    let now = fromMs;
    const steps = Math.round(maxSeconds / DT);
    for (let i = 0; i < steps; i++) {
      now += DT * 1000;
      tick(sim, now, DT);
      if (sim.phase === 'dwell') return now;
    }
    throw new Error('sim never entered dwell');
  }

  /** Run until the sim leaves 'dwell'; returns the exit timestamp. */
  function runToDepart(sim: TramSim, fromMs: number, maxSeconds: number): number {
    let now = fromMs;
    const steps = Math.round(maxSeconds / DT);
    for (let i = 0; i < steps; i++) {
      now += DT * 1000;
      tick(sim, now, DT);
      if (sim.phase !== 'dwell') return now;
    }
    throw new Error('sim never departed the dwell');
  }

  it('ahead by ~30 m at a stop: extends the dwell past the base until a fresh fix closes the gap', () => {
    const geo = makeAheadGeo();
    // Spawn 30 m before the stop; the frozen target sits at ~467.5 m, so on
    // arrival at ~500 m the sim is ~30 m AHEAD of reality.
    const sim = makeAdaptiveSim(geo, 470);
    const enterMs = runToDwell(sim, T0, 30);
    expect(dwellDurationMs(geo.stops[1])).toBe(10_000); // configured base dwell
    expect(targetDistAt(sim, enterMs) - sim.sM).toBeLessThan(-DWELL_EXTEND_RELEASE_M);

    // 5 s PAST the base dwell the sim is still dwelling (phase stays 'dwell'
    // throughout — doors-open rendering keys off it) and holds position.
    let now = run(sim, enterMs, 15, () => {
      expect(sim.phase).toBe('dwell');
      expect(sim.vMs).toBe(0);
    });
    const sAtStop = sim.sM;

    // A fresh fix ahead of the stop recovers e above −8 m → released within
    // ticks (re-evaluated every tick), and the tram departs.
    applySnapshot(sim, makeSnapshot({ shapeDistM: 505, observedAtMs: now }), now);
    expect(targetDistAt(sim, now) - sim.sM).toBeGreaterThan(-DWELL_EXTEND_RELEASE_M);
    const exitMs = runToDepart(sim, now, 2);
    expect((exitMs - now) / 1000).toBeLessThanOrEqual(0.3); // released promptly
    run(sim, exitMs, 10);
    expect(sim.phase).toBe('cruise');
    expect(sim.sM).toBeGreaterThan(sAtStop + 5); // actually departed
  });

  it('extension caps at base + DWELL_MAX_EXTEND_S when reality never catches up', () => {
    const geo = makeAheadGeo();
    const sim = makeAdaptiveSim(geo, 470);
    const enterMs = runToDwell(sim, T0, 30);
    const exitMs = runToDepart(sim, enterMs, 120);
    const dwellS = (exitMs - enterMs) / 1000;
    const baseS = dwellDurationMs(geo.stops[1]) / 1000;
    expect(dwellS).toBeGreaterThanOrEqual(baseS + DWELL_MAX_EXTEND_S - 0.5);
    expect(dwellS).toBeLessThanOrEqual(baseS + DWELL_MAX_EXTEND_S + 0.5);
  });

  it('non-adaptive sims (the projSim default) depart at the base dwell even when ahead', () => {
    const geo = makeAheadGeo();
    const profile = buildSpeedProfile(geo, { daytime: false });
    const sim = createSim(geo, profile, makeSnapshot({ shapeDistM: 470, observedAtMs: T0 }), T0);
    expect(sim.adaptiveDwell).toBe(false); // opt-in only — projSims stay fixed
    const enterMs = runToDwell(sim, T0, 30);
    const exitMs = runToDepart(sim, enterMs, 30);
    expect((exitMs - enterMs) / 1000).toBeGreaterThanOrEqual(9.5);
    expect((exitMs - enterMs) / 1000).toBeLessThanOrEqual(10.5);
  });

  it('behind by ~100 m: rolls through the stop — never dwells, ≤ roll cap in the zone, stop served', () => {
    // ~1.67 m/s schedule; a fresh fix places reality 160 m ahead of the sim,
    // and the error stays > DWELL_SKIP_ERR_M through the stop zone at 60 m.
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 96_000 },
        { atM: 60, arrivalMs: T0 - 60_000, dwellSeconds: 18 },
        { atM: 1000, arrivalMs: T0 + 504_000 },
      ],
    );
    const sim = makeAdaptiveSim(geo, 0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 160, observedAtMs: T0 }), T0);
    expect(sim.lastTeleportMs).toBe(0); // 160 m error — reconcile, don't teleport
    expect(targetDistAt(sim, T0) - sim.sM).toBeGreaterThan(DWELL_SKIP_ERR_M);

    const stop = geo.stops[1];
    let sPrev = sim.sM;
    let sawZone = false;
    run(sim, T0, 40, () => {
      // Doors never open: the real tram already served and left this stop.
      expect(sim.phase).not.toBe('dwell');
      expect(sim.sM).toBeGreaterThanOrEqual(sPrev); // s stays monotonic
      sPrev = sim.sM;
      if (Math.abs(sim.sM - stop.distM) <= DWELL_SKIP_ZONE_M) {
        sawZone = true;
        // Modest roll through the stop zone (small tolerance for the one
        // envelope-limited tick straddling the zone boundary).
        expect(sim.vMs).toBeLessThanOrEqual(DWELL_SKIP_ROLL_V_MS + 0.3);
      }
    });
    expect(sawZone).toBe(true); // actually crossed the platform, didn't stop short
    expect(sim.dwelledStopSeqs.has(stop.sequence)).toBe(true); // marked served
    expect(sim.sM).toBeGreaterThan(stop.distM + 50); // rolled past and moved on
  });

  it('behind by ~30 m: dwells noticeably shorter than the base but well above the minimum', () => {
    // Flat schedule at the 60 m stop; fix at 110 m → e ≈ +30 on arrival.
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 100_000 },
        { atM: 60, arrivalMs: T0 - 50_000, departureMs: T0 + 300_000, dwellSeconds: 16 },
        { atM: 1000, arrivalMs: T0 + 800_000 },
      ],
    );
    const sim = makeAdaptiveSim(geo, 0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 110, observedAtMs: T0 }), T0);

    const enterMs = runToDwell(sim, T0, 30);
    const eEntry = targetDistAt(sim, enterMs) - sim.sM;
    expect(eEntry).toBeGreaterThan(20);
    expect(eEntry).toBeLessThan(40);

    const exitMs = runToDepart(sim, enterMs, 20);
    const dwellS = (exitMs - enterMs) / 1000;
    expect(dwellS).toBeLessThanOrEqual(13); // clearly shorter than the 16 s base
    expect(dwellS).toBeGreaterThanOrEqual(8); // ~16 s × (1 − 30/80) ≈ 10 s
    expect(dwellS).toBeGreaterThanOrEqual(DWELL_MIN_S);
  });

  it('never dwells shorter than DWELL_MIN_S when it does stop', () => {
    // Base dwell 8 s, fix at ~137 m → e ≈ +50 on arrival (between the shorten
    // and skip thresholds): 8 s × (1 − 50/80) = 3 s → clamped to the 4 s floor.
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 100_000 },
        { atM: 60, arrivalMs: T0 - 50_000, departureMs: T0 + 300_000, dwellSeconds: 8 },
        { atM: 1000, arrivalMs: T0 + 800_000 },
      ],
    );
    const sim = makeAdaptiveSim(geo, 0);
    applySnapshot(sim, makeSnapshot({ shapeDistM: 137, observedAtMs: T0 }), T0);

    const enterMs = runToDwell(sim, T0, 30);
    const eEntry = targetDistAt(sim, enterMs) - sim.sM;
    expect(eEntry).toBeGreaterThan(40);
    expect(eEntry).toBeLessThan(DWELL_SKIP_ERR_M); // shortened, not skipped

    const exitMs = runToDepart(sim, enterMs, 20);
    const dwellS = (exitMs - enterMs) / 1000;
    expect(dwellS).toBeGreaterThanOrEqual(DWELL_MIN_S - 0.2);
    expect(dwellS).toBeLessThanOrEqual(DWELL_MIN_S + 0.5);
  });

  it('a follower never overlaps a leader held in an extended dwell (queue clamp wins)', () => {
    const geo = makeAheadGeo(); // frozen target → the leader's dwell extends
    const engine = new TramEngine({
      resolveModel: () => makeSpec1(),
      isDaytime: () => false,
      isCoupled: () => false,
    });
    engine.ingest(
      [
        makeSnapshot({ key: 'lead', shapeDistM: 480, observedAtMs: T0 }),
        makeSnapshot({ key: 'follow', shapeDistM: 460, observedAtMs: T0 }),
      ],
      () => geo,
      T0,
    );
    engine.tick(T0); // arm the tick clock

    const clearance = makeSpec1().totalLengthM + QUEUE_GAP_M;
    const stepMs = 100;
    let leadDwellMs = 0;
    let followMax = 0;
    let now = T0;
    for (let i = 0; i < 700; i++) {
      now += stepMs;
      engine.tick(now);
      const lead = engine.getState('lead', now);
      const follow = engine.getState('follow', now);
      if (!lead || !follow) throw new Error('missing state');
      // THE invariant: the follower's nose never breaches the leader's tail
      // buffer, even while the leader's dwell is adaptively extended.
      expect(follow.simDistM).toBeLessThanOrEqual(lead.simDistM - clearance + 1e-6);
      expect(follow.phase).not.toBe('dwell'); // queued outside the reach window
      if (lead.phase === 'dwell') leadDwellMs += stepMs;
      followMax = Math.max(followMax, follow.simDistM);
    }
    // The leader's dwell really was extended (base is 10 s)…
    expect(leadDwellMs).toBeGreaterThan(40_000);
    // …and the follower pressed right up against the queue limit behind it,
    // so the clamp (not mere distance) is what kept them apart.
    expect(followMax).toBeGreaterThan(500 - clearance - 5);
    expect(followMax).toBeLessThanOrEqual(500 - clearance + 1e-6);
  });
});