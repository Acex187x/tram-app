/// <reference types="jest" />
//
// The pure evaluator — the entire client physics engine (physics-v3-protocol
// §"Client pure evaluator"). Everything the map draws comes out of these four
// functions, so this suite pins their edges hard: the clamp that stops the app
// animating beyond its data, the binary search, the lerp, and the inverse used
// for stop ETAs.

import {
  crossingTimeMs,
  evalSpeedMs,
  evalTrajectory,
  knotCount,
  trackEndMs,
  trackEndS,
  trackStartMs,
} from '@/lib/physics/evaluator';

/** Interleave [t,s,…] the way parseBundle packs a wire track. */
function track(knots: [number, number][]): Float64Array {
  const out = new Float64Array(knots.length * 2);
  knots.forEach(([t, s], i) => {
    out[i * 2] = t;
    out[i * 2 + 1] = s;
  });
  return out;
}

/** 24-knot, 120 s horizon at 10 m/s — the protocol's maximum-size track. */
function maxTrack(startMs = 1_000_000): Float64Array {
  const knots: [number, number][] = [];
  for (let i = 0; i < 24; i++) knots.push([startMs + i * 5_000, i * 50]);
  return track(knots);
}

describe('evalTrajectory', () => {
  const t = track([
    [1_000, 100],
    [2_000, 120],
    [4_000, 200],
  ]);

  it('returns the exact s at every knot', () => {
    expect(evalTrajectory(t, 1_000)).toBe(100);
    expect(evalTrajectory(t, 2_000)).toBe(120);
    expect(evalTrajectory(t, 4_000)).toBe(200);
  });

  it('interpolates linearly inside a segment', () => {
    expect(evalTrajectory(t, 1_500)).toBeCloseTo(110, 9);
    expect(evalTrajectory(t, 3_000)).toBeCloseTo(160, 9);
  });

  it('CLAMPS before the first knot — never extrapolates backwards', () => {
    expect(evalTrajectory(t, 0)).toBe(100);
    expect(evalTrajectory(t, -1e12)).toBe(100);
  });

  it('CLAMPS after the last knot — the tram freezes, it does not run on', () => {
    // This is the honesty rule: past the horizon the app shows the last thing
    // the server said, forever, rather than inventing motion.
    expect(evalTrajectory(t, 4_001)).toBe(200);
    expect(evalTrajectory(t, 1e12)).toBe(200);
  });

  it('is monotone non-decreasing over a monotone track', () => {
    let prev = -Infinity;
    for (let ms = 500; ms <= 4_500; ms += 37) {
      const s = evalTrajectory(t, ms);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('binary-searches correctly across a full 24-knot track', () => {
    const big = maxTrack(0);
    for (let i = 0; i < 24; i++) expect(evalTrajectory(big, i * 5_000)).toBe(i * 50);
    // Midpoints of every segment.
    for (let i = 0; i < 23; i++) {
      expect(evalTrajectory(big, i * 5_000 + 2_500)).toBeCloseTo(i * 50 + 25, 9);
    }
  });

  it('survives an empty track and a single knot', () => {
    expect(Number.isNaN(evalTrajectory(new Float64Array(0), 1_000))).toBe(true);
    const one = track([[1_000, 42]]);
    expect(evalTrajectory(one, 0)).toBe(42);
    expect(evalTrajectory(one, 1_000)).toBe(42);
    expect(evalTrajectory(one, 9_999)).toBe(42);
  });

  it('holds position across a flat (modal stop) segment', () => {
    // The protocol's modal stop rule: the curve HOLDS at the platform, then
    // departs at full pace. The evaluator must reproduce it exactly flat.
    const held = track([
      [0, 500],
      [20_000, 500],
      [30_000, 600],
    ]);
    expect(evalTrajectory(held, 5_000)).toBe(500);
    expect(evalTrajectory(held, 19_999)).toBe(500);
    expect(evalTrajectory(held, 25_000)).toBeCloseTo(550, 9);
  });
});

describe('track accessors', () => {
  const t = maxTrack(1_000);
  it('report the horizon edges', () => {
    expect(knotCount(t)).toBe(24);
    expect(trackStartMs(t)).toBe(1_000);
    expect(trackEndMs(t)).toBe(1_000 + 23 * 5_000);
    expect(trackEndS(t)).toBe(23 * 50);
  });
  it('are NaN for an empty track', () => {
    expect(Number.isNaN(trackStartMs(new Float64Array(0)))).toBe(true);
    expect(Number.isNaN(trackEndMs(new Float64Array(0)))).toBe(true);
  });
});

describe('evalSpeedMs (central finite difference)', () => {
  it('recovers a constant pace', () => {
    const t = maxTrack(0); // 50 m per 5 s = 10 m/s
    expect(evalSpeedMs(t, 30_000)).toBeCloseTo(10, 9);
  });

  it('reads zero while the curve holds at a stop', () => {
    const held = track([
      [0, 500],
      [30_000, 500],
      [40_000, 600],
    ]);
    expect(evalSpeedMs(held, 15_000)).toBe(0);
  });

  it('never reports negative speed, even on a non-monotone server bug', () => {
    const broken = track([
      [0, 500],
      [10_000, 400],
    ]);
    expect(evalSpeedMs(broken, 5_000)).toBe(0);
  });

  it('is zero past the horizon (the clamp makes both samples equal)', () => {
    const t = maxTrack(0);
    expect(evalSpeedMs(t, trackEndMs(t) + 60_000)).toBe(0);
  });
});

describe('crossingTimeMs (the inverse — stop ETAs)', () => {
  const t = maxTrack(0); // s = 0..1150 over 0..115 s

  it('inverts evalTrajectory at the knots', () => {
    for (let i = 0; i < 24; i++) expect(crossingTimeMs(t, i * 50)).toBeCloseTo(i * 5_000, 6);
  });

  it('inverts inside a segment', () => {
    expect(crossingTimeMs(t, 25)).toBeCloseTo(2_500, 6);
    expect(evalTrajectory(t, crossingTimeMs(t, 337))).toBeCloseTo(337, 6);
  });

  it('returns the first knot time for a target already behind the curve', () => {
    expect(crossingTimeMs(t, -100)).toBe(0);
    expect(crossingTimeMs(t, 0)).toBe(0);
  });

  it('returns NaN BEYOND the horizon — there is no honest ETA out there', () => {
    expect(Number.isNaN(crossingTimeMs(t, trackEndS(t) + 1))).toBe(true);
    expect(Number.isNaN(crossingTimeMs(t, 1e9))).toBe(true);
  });

  it('resolves a flat hold to the moment the curve leaves it', () => {
    const held = track([
      [0, 500],
      [20_000, 500],
      [30_000, 600],
    ]);
    // 500 m is first reached at t=0 (the curve starts there).
    expect(crossingTimeMs(held, 500)).toBe(0);
    expect(crossingTimeMs(held, 550)).toBeCloseTo(25_000, 6);
  });
});

// ── the budget ──────────────────────────────────────────────────────────────
//
// The frame path must be arithmetic-only: ~120 visible trams evaluated at
// display rate is ~14k calls/s, so 100k calls has to be comfortably sub-100 ms
// or the whole "physics is free on the client" claim is false.
describe('performance budget', () => {
  it('runs 100_000 evalTrajectory calls on a 24-knot track in under 100 ms', () => {
    const t = maxTrack(1_000_000);
    const span = trackEndMs(t) - trackStartMs(t);
    const base = trackStartMs(t);
    // Warm up so the first timed call is not paying for lazy compilation.
    let warm = 0;
    for (let i = 0; i < 10_000; i++) warm += evalTrajectory(t, base + (i % span));
    expect(Number.isFinite(warm)).toBe(true);

    const started = Date.now();
    let acc = 0;
    for (let i = 0; i < 100_000; i++) {
      // Sweep the whole horizon so every binary-search depth is exercised.
      acc += evalTrajectory(t, base + ((i * 977) % span));
    }
    const elapsedMs = Date.now() - started;
    expect(Number.isFinite(acc)).toBe(true);
    // Reported so a regression shows up as a number, not just a pass/fail.
    console.log(`[bench] 100k evalTrajectory calls (24 knots): ${elapsedMs} ms`);
    expect(elapsedMs).toBeLessThan(100);
  });
});
