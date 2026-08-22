/// <reference types="jest" />
//
// The last-mile fix-forward shim — the one thing the client adds to the
// server's physics, and therefore the one place a client-side bug can produce
// motion the lab's gates cannot see (every lab gate scores the SERVED curve;
// none of them evaluate this file).
//
// The properties below are what the shim promises. They are stated as
// invariants over swept grids rather than as spot checks, and — the lesson
// that cost this file its first draft — the grids sweep the FIX as well as the
// clock. A shim proven monotone against one frozen fix says nothing about the
// instant the next fix lands, which is exactly when the owner's «летает за
// фикс» happens.

import {
  coastDistM,
  fixForwardTauMs,
  trackEndSpeedMs,
  COAST_DECAY_MS,
  SMOOTH_CATCHUP_V_MS,
} from '@/lib/physics/fixForward';
import { SLEW_MAX_MS } from '@/lib/physics/adapter';
import { evalTrajectory } from '@/lib/physics/evaluator';
import {
  fixForwardAppliedM,
  renderedDistM,
  renderSpeedMs,
  renderTram,
  catchupVMsFor,
} from '@/lib/physics/render';
import { parseBundle, type ParsedVehicle } from '@/lib/physics/bundle';
import { T0, wireBundle, wireTrack, wireVehicle } from './physicsFixtures';

const IMMEDIATE = Number.POSITIVE_INFINITY;
/** The curves' own anchor fix in the fixtures (emittedAtMs − 8 s). */
const ANCHOR = T0 - 8_000;
/** A fix the server had not seen when it built the curve. */
const NEWER = T0 + 20_000;

/** A track advancing at a constant `speedMs` from (T0, startS). */
function track(startS: number, speedMs: number, n = 13): Float64Array {
  return vehicle({ opinion: wireTrack(T0, startS, speedMs, n) }).opinion;
}

function vehicle(over: Parameters<typeof wireVehicle>[0] = {}): ParsedVehicle {
  const parsed = parseBundle(wireBundle({ vehicles: [wireVehicle(over)] }), T0)!;
  return parsed.vehicles.get(over.key ?? '9201')!;
}

describe('fixForwardTauMs — how far the curve is wound forward', () => {
  const t = track(1_000, 10); // 1000 m at T0, +10 m/s, ends 2200 m at T0+120 s

  it('is the time the curve still needs to reach where the fix says the tram is', () => {
    // Curve says 1200 m at T0+20 s; the fix says 1300 m — the curve needs 10
    // more seconds to get there, so it is 10 s late.
    expect(fixForwardTauMs(t, 1_300, NEWER, ANCHOR)).toBeCloseTo(10_000, 6);
  });

  it('is zero when the curve is level with or ahead of the fix', () => {
    expect(fixForwardTauMs(t, 1_200, NEWER, ANCHOR)).toBe(0);
    expect(fixForwardTauMs(t, 900, NEWER, ANCHOR)).toBe(0);
  });

  it('never winds BACKWARDS — that decision belongs to the server seam rule', () => {
    // A curve that over-ran its fix is the §14.7 class: the server decides
    // whether the newest fix justifies pulling the marker back, with evidence
    // (observed fix-over-fix speed) the client does not hold.
    for (let fixS = 0; fixS <= 1_200; fixS += 50) {
      expect(fixForwardTauMs(t, fixS, NEWER, ANCHOR)).toBe(0);
    }
  });

  it('does NOT fire on a fix the curve was already anchored to', () => {
    // The smooth track starts behind its own anchor fix by design (it resumes
    // from the previous emission). That is continuity, not staleness.
    expect(fixForwardTauMs(t, 1_500, ANCHOR, ANCHOR)).toBe(0);
    expect(fixForwardTauMs(t, 1_500, ANCHOR - 1_000, ANCHOR)).toBe(0);
  });

  it('DOES fire when the bundle omits an anchor (the fix is real data; it wins)', () => {
    expect(fixForwardTauMs(t, 1_300, NEWER, Number.NaN)).toBeCloseTo(10_000, 6);
  });

  it('is Infinity when the tram is past everything the curve predicts', () => {
    expect(fixForwardTauMs(t, 5_000, NEWER, ANCHOR)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is a plain 0 on an empty track and on an absent fix', () => {
    expect(fixForwardTauMs(new Float64Array(0), 1_300, NEWER, ANCHOR)).toBe(0);
    expect(fixForwardTauMs(t, Number.NaN, Number.NaN, ANCHOR)).toBe(0);
  });
});

describe('a hold the tram has already left is SKIPPED, not relocated', () => {
  // The reason this is a time shift and not a space shift. Translating the
  // curve along s would carry its platform hold 100 m down the block and stop
  // the marker dead in mid-segment — the artefact being fixed, relocated.
  const held = vehicle({
    opinion: [
      { t: T0, s: 1_000 }, // standing at the platform…
      { t: T0 + 60_000, s: 1_000 }, // …until T0+60 s
      { t: T0 + 120_000, s: 1_600 }, // then away at 10 m/s
    ],
    smooth: [
      { t: T0, s: 1_000 },
      { t: T0 + 60_000, s: 1_000 },
      { t: T0 + 120_000, s: 1_600 },
    ],
  });
  // The fix proves the tram left: it is 100 m past the platform at T0+20 s.
  const FIX_S = 1_100;

  it('puts the marker on the fix and keeps it MOVING', () => {
    const at20 = renderTram(held, NEWER, 'fixed', FIX_S, NEWER).s;
    const at30 = renderTram(held, NEWER + 10_000, 'fixed', FIX_S, NEWER).s;
    expect(at20).toBeCloseTo(1_100, 6);
    expect(at30).toBeGreaterThan(at20 + 50); // ~10 m/s, not a hold
    expect(renderSpeedMs(held, NEWER, 'fixed', FIX_S, NEWER)).toBeCloseTo(10, 6);
  });

  it('does not stand still anywhere while the tram is provably rolling', () => {
    let prev = -Infinity;
    for (let t = NEWER; t <= NEWER + 40_000; t += 250) {
      const s = renderTram(held, t, 'fixed', FIX_S, NEWER).s;
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('but a tram the fix confirms is AT the platform still holds', () => {
    const s0 = renderTram(held, NEWER, 'fixed', 1_000, NEWER).s;
    const s1 = renderTram(held, NEWER + 20_000, 'fixed', 1_000, NEWER).s;
    expect(s0).toBe(1_000);
    expect(s1).toBe(1_000);
  });
});

describe('rate limiting', () => {
  const v = vehicle();

  it('fixed mode takes the whole shift at once (the protocol lets it jump)', () => {
    expect(catchupVMsFor('fixed')).toBe(IMMEDIATE);
    expect(renderTram(v, NEWER, 'fixed', 1_300, NEWER).s).toBeCloseTo(1_300, 6);
  });

  it('smooth mode approaches the shifted curve at ≤ SMOOTH_CATCHUP_V_MS', () => {
    // The allowance accrues from the CURVE's start (T0), not from the fix —
    // see renderedDistM: measuring it from the fix made the marker give back
    // its catch-up on every AVL update.
    expect(catchupVMsFor('smooth')).toBe(SMOOTH_CATCHUP_V_MS);
    for (let dt = 0; dt <= 100_000; dt += 500) {
      const t = T0 + dt;
      const raw = evalTrajectory(v.smooth, t);
      const drawn = renderTram(v, t, 'smooth', 1_300, NEWER).s;
      expect(drawn - raw).toBeLessThanOrEqual((SMOOTH_CATCHUP_V_MS * dt) / 1000 + 1e-9);
      expect(drawn).toBeGreaterThanOrEqual(raw - 1e-9);
    }
  });

  it('the ramp is anchored to the fix OBSERVATION, so two clients agree', () => {
    // A phone that learned about the fix late must not render a different
    // position from one that learned about it immediately: the only clock in
    // the formula is the server-stamped observedAtMs (protocol goal 3).
    const t = NEWER + 7_000;
    const a = renderTram(v, t, 'smooth', 1_300, NEWER).s;
    const b = renderTram(v, t, 'smooth', 1_300, NEWER).s;
    expect(a).toBe(b);
  });
});

describe('the rendered marker — the properties the field reports are about', () => {
  const v = vehicle();
  const FIX_S = 1_300;

  const sweep = (mode: 'smooth' | 'fixed', step = 250) => {
    const out: { t: number; s: number }[] = [];
    for (let t = T0; t <= T0 + 140_000; t += step) {
      out.push({ t, s: renderTram(v, t, mode, FIX_S, NEWER).s });
    }
    return out;
  };

  it.each(['smooth', 'fixed'] as const)('never moves backwards (%s)', (mode) => {
    const s = sweep(mode);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].s).toBeGreaterThanOrEqual(s[i - 1].s - 1e-9);
    }
  });

  it('never renders behind the fix once the fix is known (fixed)', () => {
    for (const p of sweep('fixed')) {
      if (p.t >= NEWER) expect(p.s).toBeGreaterThanOrEqual(FIX_S - 1e-9);
    }
  });

  it('never stalls mid-segment while the curve is stale (the build-16 bug)', () => {
    // Under the old max() clamp every sample between the fix arriving and the
    // curve climbing past it was identical. Nothing may be flat here: the
    // served curve is moving at 10 m/s the whole time.
    const stale = sweep('fixed').filter((p) => p.t >= NEWER && p.t <= T0 + 100_000);
    for (let i = 1; i < stale.length; i++) {
      expect(stale[i].s - stale[i - 1].s).toBeGreaterThan(0);
    }
  });

  it('never exceeds the protocol V_MAX, even while catching up', () => {
    // The build-13 «догоняет с невозможной скоростью» guard. A time shift adds
    // no speed at all in fixed mode; smooth adds at most 2 m/s.
    for (let t = T0; t <= T0 + 140_000; t += 250) {
      expect(renderSpeedMs(v, t, 'smooth', FIX_S, NEWER)).toBeLessThanOrEqual(16.7);
      expect(renderSpeedMs(v, t, 'fixed', FIX_S, NEWER)).toBeLessThanOrEqual(16.7);
    }
  });

  it('reported speed IS the derivative of the rendered position', () => {
    // Not the raw curve's speed: `phase` reads this number to decide "dwell",
    // so a marker that is coasting or catching up must not report otherwise.
    for (const t of [T0 + 5_000, T0 + 25_000, T0 + 60_000, T0 + 115_000, T0 + 130_000]) {
      for (const mode of ['smooth', 'fixed'] as const) {
        const before = renderTram(v, t - 500, mode, FIX_S, NEWER).s;
        const after = renderTram(v, t + 500, mode, FIX_S, NEWER).s;
        expect(renderSpeedMs(v, t, mode, FIX_S, NEWER)).toBeCloseTo(after - before, 6);
      }
    }
  });

  it('is a pure function — same inputs, same pixel, any number of calls', () => {
    const t = T0 + 33_333;
    const first = renderTram(v, t, 'smooth', FIX_S, NEWER).s;
    for (let i = 0; i < 5; i++) {
      expect(renderTram(v, t, 'smooth', FIX_S, NEWER).s).toBe(first);
    }
  });

  it('degenerates to the served curve when no fix is passed', () => {
    for (let t = T0; t <= T0 + 120_000; t += 5_000) {
      expect(renderTram(v, t, 'fixed').s).toBe(evalTrajectory(v.opinion, t));
    }
  });

  it('fixForwardAppliedM reports exactly the meters it added', () => {
    const t = NEWER + 5_000;
    const drawn = renderTram(v, t, 'fixed', FIX_S, NEWER).s;
    const raw = evalTrajectory(v.opinion, t);
    expect(fixForwardAppliedM(v.opinion, t, IMMEDIATE, FIX_S, NEWER, v.anchorMs)).toBeCloseTo(
      drawn - raw,
      9,
    );
  });
});

describe('monotone while the FIX advances — the class the first draft missed', () => {
  // At runtime the fix is replaced every ~20–30 s under a curve that is
  // replaced every ~5 s. Proving monotonicity against one frozen fix proves
  // nothing about the instant a new one lands, which is when the marker was
  // observed to fly backwards. Sweep both.
  const v = vehicle(); // opinion: 1000 m at T0, +10 m/s

  /** A tram genuinely doing `realVMs`, fixed every `gapS` from T0. */
  const fixAt = (tMs: number, realVMs: number) => ({
    s: 1_000 + (realVMs * (tMs - ANCHOR)) / 1000,
    at: tMs,
  });

  /** Sweep the clock while a fresh fix lands every 20 s. */
  const sweepWithFixes = (mode: 'smooth' | 'fixed', realVMs: number) => {
    const out: { t: number; s: number; raw: number; applied: number }[] = [];
    let fix = fixAt(ANCHOR, realVMs); // the curve's own anchor fix
    for (let t = T0; t <= T0 + 110_000; t += 250) {
      // A fresh fix is observed 2 s before the phone can use it.
      const dueAt = t - 2_000;
      if (dueAt > fix.at + 20_000) fix = fixAt(dueAt, realVMs);
      const track = mode === 'smooth' ? v.smooth : v.opinion;
      out.push({
        t,
        s: renderTram(v, t, mode, fix.s, fix.at).s,
        raw: evalTrajectory(track, t),
        applied: fixForwardAppliedM(track, t, catchupVMsFor(mode), fix.s, fix.at, v.anchorMs),
      });
    }
    return out;
  };

  it.each([
    ['faster than the curve predicted', 13],
    ['exactly as predicted', 10],
    ['stopped dead (a jam the model did not know about)', 0],
  ])('layered monotonicity when the tram is %s', (_label, realVMs) => {
    // Since the hunt1 post-mortem the guarantee is LAYERED: the raw composition
    // may give back ≤ the previously applied allowance at a fix advance (the
    // fix-datum reset), and the per-frame slew guard (adapter.ts) owns strict
    // monotonicity of the on-screen marker. Pin both layers.
    for (const mode of ['smooth', 'fixed'] as const) {
      let prev = -Infinity;
      let prevApplied = 0;
      let guardS = -Infinity;
      let prevT = 0;
      for (const p of sweepWithFixes(mode, realVMs)) {
        // Layer 1: the shim only ever ADDS to the served curve…
        expect(p.s).toBeGreaterThanOrEqual(p.raw - 1e-9);
        // …and a backward step is bounded by what it had previously added.
        if (p.s < prev - 1e-9) {
          expect(prev - p.s).toBeLessThanOrEqual(prevApplied + 1e-6);
        }
        // Layer 2: the guarded on-screen marker (fleet slew guard) is strictly
        // monotone and slew-bounded — the property the field complained about.
        const dtS = guardS === -Infinity ? 0 : (p.t - prevT) / 1000;
        const ceil = guardS === -Infinity ? p.s : guardS + SLEW_MAX_MS * dtS;
        const guarded =
          mode === 'smooth' && guardS !== -Infinity
            ? Math.min(Math.max(p.s, guardS - 0.5), ceil)
            : p.s;
        expect(guarded).toBeGreaterThanOrEqual(guardS - 0.5 - 1e-9);
        guardS = guarded;
        prevT = p.t;
        prev = p.s;
        prevApplied = Math.max(0, p.applied);
      }
      // The guarded marker must end where the raw composition ends — the guard
      // delays, it must never divorce the marker from the physics.
      const last = sweepWithFixes(mode, realVMs).at(-1)!;
      expect(Math.abs(guardS - last.s)).toBeLessThanOrEqual(1);
    }
  });

  it('a tram that stops after running ahead gives back what the shim added — and no more', () => {
    // The one case that genuinely steps backward: τ builds while the tram runs
    // ahead of the curve, then the tram stalls, the curve catches up and τ
    // collapses. That is a correction to newer evidence, not a shim artefact,
    // and the bound is what makes it safe to ship: the shim returns the metres
    // it added and no more, so the marker never lands behind where an
    // unshimmed client would have drawn it. Anything further back is the
    // server's §14.7 seam decision, made with evidence this file lacks.
    //
    // Fixes: sprinting at 14 m/s, then standing still.
    const fixes = [
      { at: ANCHOR, s: 1_000 },
      { at: T0 + 12_000, s: 1_280 }, // ran ahead: the curve says 1120 here
      { at: T0 + 34_000, s: 1_285 }, // then stopped: the curve says 1340
      { at: T0 + 56_000, s: 1_290 },
    ];
    for (const mode of ['smooth', 'fixed'] as const) {
      const trackArr = mode === 'smooth' ? v.smooth : v.opinion;
      let prev: { s: number; applied: number } | null = null;
      let worstBack = 0;
      for (let t = T0; t <= T0 + 100_000; t += 250) {
        const fix = fixes.filter((f) => f.at <= t - 2_000).pop() ?? fixes[0];
        const s = renderTram(v, t, mode, fix.s, fix.at).s;
        const raw = evalTrajectory(trackArr, t);
        expect(s).toBeGreaterThanOrEqual(raw - 1e-9); // never below the curve
        if (prev) {
          const step = prev.s - s;
          if (step > worstBack) worstBack = step;
          expect(step).toBeLessThanOrEqual(prev.applied + 1e-6); // never more than it added
        }
        prev = {
          s,
          applied: fixForwardAppliedM(
            trackArr,
            t,
            catchupVMsFor(mode),
            fix.s,
            fix.at,
            v.anchorMs,
          ),
        };
      }
      expect(worstBack).toBeGreaterThan(0); // the case really does occur
    }
  });

  it('tracks a tram running FASTER than the curve without ever lagging it', () => {
    let fix = fixAt(ANCHOR, 13);
    for (let t = T0; t <= T0 + 90_000; t += 250) {
      const dueAt = t - 2_000;
      if (dueAt > fix.at + 20_000) fix = fixAt(dueAt, 13);
      const s = renderTram(v, t, 'fixed', fix.s, fix.at).s;
      expect(s).toBeGreaterThanOrEqual(fix.s - 1e-9);
    }
  });
});

describe('past-horizon coast — a tram cannot stop dead at the last keyframe', () => {
  it('reads the terminal speed off the final segment, never negative', () => {
    expect(trackEndSpeedMs(track(1_000, 10))).toBeCloseTo(10, 9);
    expect(trackEndSpeedMs(track(1_000, 0))).toBe(0);
    expect(trackEndSpeedMs(new Float64Array(0))).toBe(0);
    expect(trackEndSpeedMs(new Float64Array([T0, 100]))).toBe(0); // one knot
  });

  it('decelerates to a standstill over COAST_DECAY_MS and stays there', () => {
    expect(coastDistM(10, 0)).toBe(0);
    expect(coastDistM(10, COAST_DECAY_MS / 2)).toBeCloseTo(75, 9); // 10·10 − 0.25·100
    expect(coastDistM(10, COAST_DECAY_MS)).toBeCloseTo(100, 9); // half of 20 s × 10
    expect(coastDistM(10, COAST_DECAY_MS * 100)).toBeCloseTo(100, 9);
  });

  it('brakes well inside the protocol A_BRK (1.4 m/s²)', () => {
    // v/decay for the fastest tram the contract allows.
    expect(16.7 / (COAST_DECAY_MS / 1000)).toBeLessThan(1.4);
  });

  it('a tram that ran out of curve while STANDING simply stays standing', () => {
    const held = vehicle({
      opinion: [
        { t: T0, s: 1_000 },
        { t: T0 + 120_000, s: 1_000 },
      ],
      smooth: [
        { t: T0, s: 1_000 },
        { t: T0 + 120_000, s: 1_000 },
      ],
    });
    expect(renderTram(held, T0 + 200_000, 'fixed').s).toBe(1_000);
  });

  it('is monotone and bounded across the whole coast', () => {
    const t = track(1_000, 10);
    let prev = -Infinity;
    for (let dt = 0; dt <= 60_000; dt += 250) {
      const s = renderedDistM(t, T0 + 120_000 + dt, IMMEDIATE, Number.NaN, Number.NaN, ANCHOR);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s).toBeLessThanOrEqual(2_200 + 100 + 1e-9);
      prev = s;
    }
  });

  it('a fix past the whole curve holds at the fix rather than inventing more', () => {
    const v = vehicle();
    // 5000 m is far beyond the curve's 2200 m horizon: τ is undefined.
    const r = renderTram(v, NEWER, 'fixed', 5_000, NEWER);
    expect(r.s).toBe(5_000);
    expect(r.pastHorizon).toBe(true);
  });
});

describe('τ = ∞ in SMOOTH mode — the overrun fix is walked to, never snapped to', () => {
  // The «телепортируется за новый фикс и стоит» field report (build 18): a fix
  // beyond everything the curve predicts used to snap BOTH modes onto the fix
  // and freeze them there. `fixed` is licensed to jump; `smooth` is not.
  const t = track(1_000, 10); // ends at 2200 m, T0+120 s

  it('never jumps at the instant the overrun fix lands', () => {
    // Just before the fix arrives the smooth marker is on the raw curve.
    const fixAt = T0 + 30_000;
    const before = renderedDistM(t, fixAt, SMOOTH_CATCHUP_V_MS, Number.NaN, Number.NaN, ANCHOR);
    const after = renderedDistM(t, fixAt, SMOOTH_CATCHUP_V_MS, 5_000, fixAt, ANCHOR);
    // The whole 3700 m gap must NOT appear on screen: the step at the fix
    // instant is bounded by the allowance already accrued from the curve's
    // start, never by the size of the overrun.
    expect(after - before).toBeLessThanOrEqual((SMOOTH_CATCHUP_V_MS * 30_000) / 1000 + 1e-9);
    // `fixed` takes it at once — that is the mode's contract.
    expect(renderedDistM(t, fixAt, IMMEDIATE, 5_000, fixAt, ANCHOR)).toBe(5_000);
  });

  it('walks toward the fix at bounded extra speed and stops AT it, monotone', () => {
    const fixAt = T0 + 30_000;
    const fixS = 2_500; // 300 m past the curve's own horizon end
    let prev = -Infinity;
    for (let dt = 0; dt <= 300_000; dt += 500) {
      const now = fixAt + dt;
      const s = renderedDistM(t, now, SMOOTH_CATCHUP_V_MS, fixS, fixAt, ANCHOR);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9); // never backwards
      expect(s).toBeLessThanOrEqual(fixS + 1e-9); // never invents past the fix
      // Extra speed over the raw curve stays inside the catch-up budget
      // (allowance measured from the curve's start, same datum as finite τ).
      const raw = renderedDistM(t, now, SMOOTH_CATCHUP_V_MS, Number.NaN, Number.NaN, ANCHOR);
      expect(s - raw).toBeLessThanOrEqual(
        (SMOOTH_CATCHUP_V_MS * (now - T0)) / 1000 + 1e-9,
      );
      prev = s;
    }
    // It does eventually get there — the walk converges, it does not stall.
    expect(prev).toBeCloseTo(fixS, 6);
  });
});
