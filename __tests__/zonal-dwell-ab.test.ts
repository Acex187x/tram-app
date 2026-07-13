/// <reference types="jest" />

// R8 gate-2: zonal default-dwell A/B (docs/calibration/analysis-2026-07-13.md,
// round-30 spec). Covers: zonalDwellFactor bbox edges; dwellDurationMs scaling
// the DEFAULT branch only (scheduled computed_dwell never scaled); parity
// gating incl. non-numeric/digit-prefixed fallback keys; flag OFF ⇒
// bit-identical trajectories (trace test, tod-pace pattern); ON ⇒ even trams
// dwell x1.30 at centre stops / x0.90 at outskirts stops while odd trams are
// untouched; composition with adaptive dwell (extend/shorten/skip on top of
// the zonal default) and with the paceBias dwell deduction.
//
// The flag is a module-load const (__DEV__ && EXPO_PUBLIC_ZONAL_DWELL_AB ===
// '1'), so ON/OFF variants are loaded through jest.isolateModules with the
// env var set/unset — babel-preset-expo does NOT inline EXPO_PUBLIC_* under
// jest (inlining is metro-production-only), so the runtime lookup is live.

import type { TramSim } from '@/lib/engine/tramSim';
import type { RouteGeometry } from '@/lib/types';
import { CENTER_ORIGIN, makeGeometry, makeSnapshot, ORIGIN } from './helpers';

type SpeedProfileModule = typeof import('@/lib/engine/speedProfile');
type TramSimModule = typeof import('@/lib/engine/tramSim');
interface EngineModules {
  sp: SpeedProfileModule;
  ts: TramSimModule;
}

const ENV_KEY = 'EXPO_PUBLIC_ZONAL_DWELL_AB';
const T0 = 1_000_000_000_000;
const DT = 0.1;

/** Load fresh speedProfile+tramSim instances with the flag env set/unset. */
function loadEngine(flagValue: string | undefined): EngineModules {
  const prev = process.env[ENV_KEY];
  if (flagValue === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = flagValue;
  let mods: EngineModules | undefined;
  jest.isolateModules(() => {
    mods = {
      sp: jest.requireActual<SpeedProfileModule>('@/lib/engine/speedProfile'),
      ts: jest.requireActual<TramSimModule>('@/lib/engine/tramSim'),
    };
  });
  if (prev === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prev;
  return mods!;
}

const OFF = loadEngine(undefined);
const OFF_EXPLICIT = loadEngine('0');
const ON = loadEngine('1');

// ── zonalDwellFactor bbox ────────────────────────────────────────────────────

describe('zonalDwellFactor bbox edges', () => {
  const { CENTER_BBOX, ZONAL_DWELL_CENTRE, ZONAL_DWELL_OUT, zonalDwellFactor } = OFF.sp;
  const [w, s, e, n] = CENTER_BBOX;
  const eps = 1e-9;

  it('ships the round-30 constants: centre x1.30, outskirts x0.90', () => {
    expect(ZONAL_DWELL_CENTRE).toBe(1.3);
    expect(ZONAL_DWELL_OUT).toBe(0.9);
  });

  it('returns CENTRE strictly inside and OUT strictly outside the bbox', () => {
    expect(zonalDwellFactor([14.42, 50.08])).toBe(ZONAL_DWELL_CENTRE); // CENTER_ORIGIN
    expect(zonalDwellFactor([14.6, 50.05])).toBe(ZONAL_DWELL_OUT); // ORIGIN (east)
    expect(zonalDwellFactor([0, 0])).toBe(ZONAL_DWELL_OUT);
  });

  it('bbox edges are inclusive (same test as zoneCapAt), epsilon outside is OUT', () => {
    const midLng = (w + e) / 2;
    const midLat = (s + n) / 2;
    // All four edges + corners inclusive.
    expect(zonalDwellFactor([w, midLat])).toBe(ZONAL_DWELL_CENTRE);
    expect(zonalDwellFactor([e, midLat])).toBe(ZONAL_DWELL_CENTRE);
    expect(zonalDwellFactor([midLng, s])).toBe(ZONAL_DWELL_CENTRE);
    expect(zonalDwellFactor([midLng, n])).toBe(ZONAL_DWELL_CENTRE);
    expect(zonalDwellFactor([w, s])).toBe(ZONAL_DWELL_CENTRE);
    expect(zonalDwellFactor([e, n])).toBe(ZONAL_DWELL_CENTRE);
    // Epsilon outside each edge.
    expect(zonalDwellFactor([w - eps, midLat])).toBe(ZONAL_DWELL_OUT);
    expect(zonalDwellFactor([e + eps, midLat])).toBe(ZONAL_DWELL_OUT);
    expect(zonalDwellFactor([midLng, s - eps])).toBe(ZONAL_DWELL_OUT);
    expect(zonalDwellFactor([midLng, n + eps])).toBe(ZONAL_DWELL_OUT);
  });

  it('matches zoneCapAt zone classification across a coordinate sweep', () => {
    const { V_CENTER_MS, zoneCapAt } = OFF.sp;
    for (let lng = 14.3; lng <= 14.6; lng += 0.01) {
      for (let lat = 50.0; lat <= 50.15; lat += 0.005) {
        const coord: [number, number] = [lng, lat];
        const centreByCap = zoneCapAt(coord, true) === V_CENTER_MS;
        const centreByDwell = zonalDwellFactor(coord) === ZONAL_DWELL_CENTRE;
        expect(centreByDwell).toBe(centreByCap);
      }
    }
  });
});

// ── flag wiring ──────────────────────────────────────────────────────────────

describe('ZONAL_DWELL_AB flag', () => {
  it('is OFF by default (env unset) and with any value other than "1"', () => {
    expect(OFF.sp.ZONAL_DWELL_AB).toBe(false);
    expect(OFF_EXPLICIT.sp.ZONAL_DWELL_AB).toBe(false);
  });

  it('is ON under __DEV__ with EXPO_PUBLIC_ZONAL_DWELL_AB=1 (jest runs as dev)', () => {
    expect(__DEV__).toBe(true);
    expect(ON.sp.ZONAL_DWELL_AB).toBe(true);
  });
});

// ── dwellDurationMs scaling rules ────────────────────────────────────────────

function defaultDwellGeo(origin: [number, number]): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [1200, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 },
      { atM: 300, arrivalMs: T0 + 60_000 }, // dwellSeconds 0 → DEFAULT dwell path
      { atM: 1200, arrivalMs: T0 + 240_000 },
    ],
    origin,
  );
}

describe('dwellDurationMs zonal factor (default branch only)', () => {
  const { dwellDurationMs } = OFF.ts;
  const stop = defaultDwellGeo(CENTER_ORIGIN).stops[1];

  it('scales the DEFAULT dwell by the passed factor', () => {
    const base = dwellDurationMs(stop, T0);
    expect(dwellDurationMs(stop, T0, 1.3)).toBe(base * 1.3);
    expect(dwellDurationMs(stop, T0, 0.9)).toBe(base * 0.9);
  });

  it('never scales scheduled computed_dwell', () => {
    const scheduled = { ...stop, dwellSeconds: 25 };
    expect(dwellDurationMs(scheduled, T0, 1.3)).toBe(25_000);
    expect(dwellDurationMs(scheduled, T0, 0.9)).toBe(25_000);
    expect(dwellDurationMs(scheduled, T0)).toBe(25_000);
  });

  it('omitted or 1 factor is bit-identical to the pre-experiment value', () => {
    const before = dwellDurationMs(stop, T0);
    expect(Object.is(dwellDurationMs(stop, T0, undefined), before)).toBe(true);
    expect(Object.is(dwellDurationMs(stop, T0, 1), before)).toBe(true);
  });

  it('no-time-context callers keep the unscaled default (informational path)', () => {
    expect(dwellDurationMs(stop, undefined, 1.3)).toBe(dwellDurationMs(stop));
  });
});

// ── parity gating ────────────────────────────────────────────────────────────

function makeSim(
  mods: EngineModules,
  geo: RouteGeometry,
  key: string,
  shapeDistM = 0,
  opts: { adaptiveDwell?: boolean } = {},
): TramSim {
  const profile = mods.sp.buildSpeedProfile(geo, { daytime: false });
  const snapshot = makeSnapshot({ key, shapeDistM, observedAtMs: T0 });
  return mods.ts.createSim(geo, profile, snapshot, T0, undefined, opts);
}

describe('parity gating (zonalDwellTreatmentFactor)', () => {
  const centreGeo = defaultDwellGeo(CENTER_ORIGIN);
  const outGeo = defaultDwellGeo(ORIGIN);

  it('flag ON: EVEN registration keys are treated — centre x1.30, outskirts x0.90', () => {
    const centreSim = makeSim(ON, centreGeo, '9200');
    const outSim = makeSim(ON, outGeo, '9200');
    expect(ON.ts.zonalDwellTreatmentFactor(centreSim, centreGeo.stops[1])).toBe(1.3);
    expect(ON.ts.zonalDwellTreatmentFactor(outSim, outGeo.stops[1])).toBe(0.9);
  });

  it('flag ON: ODD keys are control (factor exactly 1 in both zones)', () => {
    expect(ON.ts.zonalDwellTreatmentFactor(makeSim(ON, centreGeo, '9201'), centreGeo.stops[1])).toBe(1);
    expect(ON.ts.zonalDwellTreatmentFactor(makeSim(ON, outGeo, '9201'), outGeo.stops[1])).toBe(1);
  });

  it('flag ON: non-numeric keys are control, incl. digit-prefixed trip-id fallbacks', () => {
    // int(key) in the analysis scripts rejects these — the engine must agree
    // even though parseInt('991_338_x') would happily return 991 (odd) or an
    // even prefix ('9200_x' → 9200).
    for (const key of ['trip-test', '991_338_x', '9200_1_x', '']) {
      const sim = makeSim(ON, centreGeo, key);
      expect(ON.ts.zonalDwellTreatmentFactor(sim, centreGeo.stops[1])).toBe(1);
    }
  });

  it('flag OFF: everyone is control, even an even-key tram at a centre stop', () => {
    for (const mods of [OFF, OFF_EXPLICIT]) {
      const sim = makeSim(mods, centreGeo, '9200');
      expect(mods.ts.zonalDwellTreatmentFactor(sim, centreGeo.stops[1])).toBe(1);
    }
  });
});

// ── end-to-end dwell durations through tick() ────────────────────────────────

/** Drive the sim until it enters 'dwell'; returns the set dwell duration, ms. */
function runToDwellMs(mods: EngineModules, sim: TramSim, maxSeconds: number): number {
  let now = T0;
  const steps = Math.round(maxSeconds / DT);
  for (let i = 0; i < steps; i++) {
    now += DT * 1000;
    mods.ts.tick(sim, now, DT);
    if (sim.phase === 'dwell') return sim.dwellUntilMs - now;
  }
  throw new Error('sim never entered dwell');
}

describe('end-to-end: dwell durations under the flag', () => {
  const centreGeo = defaultDwellGeo(CENTER_ORIGIN);
  const outGeo = defaultDwellGeo(ORIGIN);
  const baseMs = OFF.ts.dwellDurationMs(centreGeo.stops[1]); // TOD neutral ⇒ = timed value

  it('ON + even key: centre stop dwells x1.30, outskirts stop x0.90', () => {
    expect(runToDwellMs(ON, makeSim(ON, centreGeo, '9200'), 120)).toBe(baseMs * 1.3);
    expect(runToDwellMs(ON, makeSim(ON, outGeo, '9200'), 120)).toBe(baseMs * 0.9);
  });

  it('ON + odd key: bit-identical to the OFF dwell in both zones', () => {
    const offCentre = runToDwellMs(OFF, makeSim(OFF, centreGeo, '9201'), 120);
    expect(Object.is(runToDwellMs(ON, makeSim(ON, centreGeo, '9201'), 120), offCentre)).toBe(true);
    expect(runToDwellMs(ON, makeSim(ON, outGeo, '9201'), 120)).toBe(offCentre);
    expect(offCentre).toBe(baseMs);
  });

  it('ON + even key: scheduled computed_dwell is untouched at a centre stop', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1200, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 },
        { atM: 300, arrivalMs: T0 + 60_000, dwellSeconds: 25 },
        { atM: 1200, arrivalMs: T0 + 240_000 },
      ],
      CENTER_ORIGIN,
    );
    expect(runToDwellMs(ON, makeSim(ON, geo, '9200'), 120)).toBe(25_000);
  });

  it('ON + even key: the at_stop SEEDING path applies the zonal factor too', () => {
    // Spawn AT the centre default-dwell stop with the scheduled departure in
    // the past and the feed saying at_stop → seedStopState's fallback dwell.
    const geo = makeGeometry(
      [
        [0, 0],
        [1200, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 120_000 },
        { atM: 300, arrivalMs: T0 - 60_000 }, // departure already passed
        { atM: 1200, arrivalMs: T0 + 240_000 },
      ],
      CENTER_ORIGIN,
    );
    const profile = ON.sp.buildSpeedProfile(geo, { daytime: false });
    const snapshot = makeSnapshot({
      key: '9200',
      shapeDistM: 300,
      observedAtMs: T0,
      statePosition: 'at_stop',
      lastStopSequence: geo.stops[1].sequence,
    });
    const sim = ON.ts.createSim(geo, profile, snapshot, T0);
    expect(sim.phase).toBe('dwell');
    expect(sim.dwellUntilMs - T0).toBe(baseMs * 1.3);
  });
});

// ── flag OFF ⇒ bit-identical trajectories (trace test, tod-pace pattern) ────

/** Full [sM, vMs] trace of a 140 s run over the centre default-dwell geometry. */
function trajectory(mods: EngineModules, key: string): number[] {
  const sim = makeSim(mods, defaultDwellGeo(CENTER_ORIGIN), key);
  const out: number[] = [];
  let now = T0;
  for (let i = 0; i < 1400; i++) {
    now += DT * 1000;
    mods.ts.tick(sim, now, DT);
    out.push(sim.sM, sim.vMs);
  }
  return out;
}

describe('flag OFF is a bit-identical no-op', () => {
  it('OFF (unset) === OFF ("0") === ON-control (odd key); ON-treatment differs', () => {
    const baseline = trajectory(OFF, '9200'); // even key, centre — flag off
    // Env "0" is just as off — every sample Object.is-identical.
    const off0 = trajectory(OFF_EXPLICIT, '9200');
    expect(off0.length).toBe(baseline.length);
    expect(off0.every((v, i) => Object.is(v, baseline[i]))).toBe(true);
    // The key plays no role anywhere else in the physics: an ODD (control)
    // tram under the ACTIVE flag reproduces the baseline bit-identically.
    const onControl = trajectory(ON, '9201');
    expect(onControl.length).toBe(baseline.length);
    expect(onControl.every((v, i) => Object.is(v, baseline[i]))).toBe(true);
    // And the hook is live: the treated tram's trajectory must differ.
    expect(trajectory(ON, '9200')).not.toEqual(baseline);
  });
});

// ── composition with adaptive dwell (extend / shorten / skip) ───────────────

describe('adaptive dwell composes on top of the zonal default', () => {
  it('extend: ahead-forever holds zonalBase + DWELL_MAX_EXTEND_S at a centre stop', () => {
    // Flat schedule at the 500 m DEFAULT-dwell stop: target frozen ~32 m
    // behind the platform, so the extension holds until the hard cap.
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 530_000 },
        { atM: 500, arrivalMs: T0 - 30_000, departureMs: T0 + 300_000 },
        { atM: 1000, arrivalMs: T0 + 800_000 },
      ],
      CENTER_ORIGIN,
    );
    const sim = makeSim(ON, geo, '9200', 470, { adaptiveDwell: true });
    let now = T0;
    let enterMs = 0;
    let exitMs = 0;
    for (let i = 0; i < 2000 && exitMs === 0; i++) {
      now += DT * 1000;
      ON.ts.tick(sim, now, DT);
      if (sim.phase === 'dwell' && enterMs === 0) enterMs = now;
      if (enterMs > 0 && sim.phase !== 'dwell') exitMs = now;
    }
    expect(enterMs).toBeGreaterThan(0);
    expect(exitMs).toBeGreaterThan(0);
    const dwellS = (exitMs - enterMs) / 1000;
    const zonalBaseS = (ON.ts.dwellDurationMs(geo.stops[1]) / 1000) * 1.3;
    const unscaledBaseS = ON.ts.dwellDurationMs(geo.stops[1]) / 1000;
    expect(dwellS).toBeGreaterThanOrEqual(zonalBaseS + ON.ts.DWELL_MAX_EXTEND_S - 0.5);
    expect(dwellS).toBeLessThanOrEqual(zonalBaseS + ON.ts.DWELL_MAX_EXTEND_S + 0.5);
    // The extension window sits on top of the ZONAL base, not the unscaled one.
    expect(dwellS).toBeGreaterThan(unscaledBaseS + ON.ts.DWELL_MAX_EXTEND_S + 1);
  });

  it('shorten: behind ~30 m, the treated dwell is the zonal default x the same trim', () => {
    const mkGeo = () =>
      makeGeometry(
        [
          [0, 0],
          [1000, 0],
        ],
        [
          { atM: 0, arrivalMs: T0 - 100_000 },
          { atM: 60, arrivalMs: T0 - 50_000, departureMs: T0 + 300_000 }, // default dwell
          { atM: 1000, arrivalMs: T0 + 800_000 },
        ],
        CENTER_ORIGIN,
      );
    const runShortened = (key: string): number => {
      const geo = mkGeo();
      const sim = makeSim(ON, geo, key, 0, { adaptiveDwell: true });
      ON.ts.applySnapshot(sim, makeSnapshot({ key, shapeDistM: 110, observedAtMs: T0 }), T0);
      return runToDwellMs(ON, sim, 60);
    };
    const treated = runShortened('9200');
    const control = runShortened('9201');
    // Identical dynamics up to dwell entry (the factor only changes the dwell
    // length), so the trim factor matches and the ratio is exactly x1.30 —
    // unless either leg hit the DWELL_MIN_S floor, which would break the ratio.
    expect(control).toBeGreaterThan(ON.ts.DWELL_MIN_S * 1000);
    expect(treated / control).toBeCloseTo(1.3, 6);
    // And both are genuinely shortened vs their bases.
    const baseMs = ON.ts.dwellDurationMs(mkGeo().stops[1]);
    expect(control).toBeLessThan(baseMs);
    expect(treated).toBeLessThan(baseMs * 1.3);
  });

  it('skip: badly behind, a treated centre tram still skips the dwell entirely', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 96_000 },
        { atM: 60, arrivalMs: T0 - 60_000 }, // default dwell
        { atM: 1000, arrivalMs: T0 + 504_000 },
      ],
      CENTER_ORIGIN,
    );
    const sim = makeSim(ON, geo, '9200', 0, { adaptiveDwell: true });
    ON.ts.applySnapshot(sim, makeSnapshot({ key: '9200', shapeDistM: 160, observedAtMs: T0 }), T0);
    let now = T0;
    for (let i = 0; i < 400; i++) {
      now += DT * 1000;
      ON.ts.tick(sim, now, DT);
      expect(sim.phase).not.toBe('dwell'); // doors never open
    }
    expect(sim.dwelledStopSeqs.has(geo.stops[1].sequence)).toBe(true); // served
    expect(sim.sM).toBeGreaterThan(geo.stops[1].distM + 50); // rolled past
  });
});

// ── composition with the paceBias dwell deduction ────────────────────────────

describe('paceBias dwell deduction uses the treated factor', () => {
  it('a treated tram deducts the zonal centre dwell and learns a higher bias', () => {
    const mkGeo = () =>
      makeGeometry(
        [
          [0, 0],
          [6000, 0],
        ],
        [
          { atM: 0, arrivalMs: T0 },
          { atM: 3000, arrivalMs: T0 + 300_000 }, // default dwell, strictly inside the span
          { atM: 6000, arrivalMs: T0 + 1_000_000 },
        ],
        CENTER_ORIGIN,
      );
    const learn = (key: string): number => {
      const geo = mkGeo();
      const sim = makeSim(ON, geo, key, 100);
      const fixDist = 100 + 0.9 * ON.sp.V_CRUISE_REF_MS * 300; // ~3260 m in 300 s
      // Pin the sim onto the fix so the 3+ km jump reconciles instead of teleporting.
      sim.sM = Math.min(fixDist, geo.totalM);
      ON.ts.applySnapshot(
        sim,
        makeSnapshot({ key, shapeDistM: fixDist, observedAtMs: T0 + 300_000 }),
        T0 + 300_000,
      );
      return sim.paceBias;
    };
    const treated = learn('9200');
    const control = learn('9201');
    // Bigger estimated dwell deduction (x1.30) ⇒ shorter effective motion time
    // ⇒ higher measured pace ratio for the treated tram.
    expect(treated).toBeGreaterThan(control);
    expect(control).toBeGreaterThan(ON.ts.PACE_BIAS_PRIOR); // sample actually landed
  });
});
