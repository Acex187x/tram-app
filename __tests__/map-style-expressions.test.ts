// Regression pin for the build-13 "every tram is a bare circle" bug.
//
// Mapbox rejects an ENTIRE layer whose property nests `["zoom"]` inside another
// expression ("inserting layer failed at position default: …"). Physics v3's
// dimIfStale wrapped zoom ramps in ["*", …], which silently removed the 3D
// ModelLayer, both teardrop layers and both face-badge layers from the style.
// Nothing in the app surfaced it: the geometry pipeline was healthy, the fleet
// was live, and the only tram layer left standing drew a plain circle.

import {
  STALE_DIM,
  STALE_FACTOR,
  dimIfStale,
  findIllegalZoomRefs,
} from '@/lib/render/styleExpr';

/** The exact shape of BADGE_BAND_OPACITY / the ModelLayer fade in TramLayers. */
const ZOOM_RAMP = ['interpolate', ['linear'], ['zoom'], 13.2, 0, 14.8, 1];
const ZOOM_STEP = ['step', ['zoom'], 0, 14.8, 1];

/** Minimal evaluator for the subset of expressions these helpers produce. */
function evaluate(expr: unknown, zoom: number, stale: boolean): number {
  if (typeof expr === 'number') return expr;
  if (!Array.isArray(expr)) throw new Error(`unsupported node: ${String(expr)}`);
  switch (expr[0]) {
    case 'interpolate': {
      const input = evaluate(expr[2], zoom, stale);
      const stops: [number, number][] = [];
      for (let i = 3; i < expr.length; i += 2) {
        stops.push([expr[i] as number, evaluate(expr[i + 1], zoom, stale)]);
      }
      if (input <= stops[0][0]) return stops[0][1];
      const last = stops[stops.length - 1];
      if (input >= last[0]) return last[1];
      for (let i = 0; i < stops.length - 1; i++) {
        const [z0, v0] = stops[i];
        const [z1, v1] = stops[i + 1];
        if (input >= z0 && input <= z1) {
          return v0 + ((input - z0) / (z1 - z0)) * (v1 - v0);
        }
      }
      return last[1];
    }
    case 'step': {
      const input = evaluate(expr[1], zoom, stale);
      let out = evaluate(expr[2], zoom, stale);
      for (let i = 3; i < expr.length; i += 2) {
        if (input >= (expr[i] as number)) out = evaluate(expr[i + 1], zoom, stale);
      }
      return out;
    }
    case 'zoom':
      return zoom;
    case '*':
      return expr.slice(1).reduce<number>((a, n) => a * evaluate(n, zoom, stale), 1);
    case 'case':
      return evaluate(expr[1], zoom, stale) ? evaluate(expr[2], zoom, stale) : evaluate(expr[3], zoom, stale);
    case '==':
      return evaluate(expr[1], zoom, stale) === evaluate(expr[2], zoom, stale) ? 1 : 0;
    case 'get':
      if (expr[1] === 'stale') return stale ? 1 : 0;
      throw new Error(`unsupported get: ${String(expr[1])}`);
    default:
      throw new Error(`unsupported op: ${String(expr[0])}`);
  }
}

describe('findIllegalZoomRefs', () => {
  it('accepts a zoom ramp at the top level', () => {
    expect(findIllegalZoomRefs(ZOOM_RAMP)).toEqual([]);
    expect(findIllegalZoomRefs(ZOOM_STEP)).toEqual([]);
  });

  it('catches the exact shape Mapbox rejected in build 13', () => {
    // This IS the old dimIfStale output — the test must fail on it, or it
    // would not have caught the regression.
    const broken = ['*', ZOOM_RAMP, STALE_FACTOR];
    expect(findIllegalZoomRefs(broken).length).toBeGreaterThan(0);
  });

  it('catches a zoom buried in a case', () => {
    expect(findIllegalZoomRefs(['case', ['==', ['zoom'], 5], 1, 0]).length).toBeGreaterThan(0);
  });
});

describe('dimIfStale', () => {
  it('keeps zoom legal for every ramp form', () => {
    expect(findIllegalZoomRefs(dimIfStale(ZOOM_RAMP))).toEqual([]);
    expect(findIllegalZoomRefs(dimIfStale(ZOOM_STEP))).toEqual([]);
  });

  it('keeps zoom legal for a constant base', () => {
    expect(findIllegalZoomRefs(dimIfStale(1))).toEqual([]);
    expect(findIllegalZoomRefs(dimIfStale(0.9))).toEqual([]);
  });

  it('leaves a live tram undimmed and dims a stale one, at every zoom', () => {
    for (const zoom of [12, 13.2, 14, 14.8, 16, 18]) {
      const live = evaluate(dimIfStale(ZOOM_RAMP), zoom, false);
      const stale = evaluate(dimIfStale(ZOOM_RAMP), zoom, true);
      const base = evaluate(ZOOM_RAMP, zoom, false);
      expect(live).toBeCloseTo(base, 10);
      expect(stale).toBeCloseTo(base * STALE_DIM, 10);
    }
  });

  it('is numerically identical to the (illegal) multiply it replaces', () => {
    // Proves the rewrite is exact, not an approximation — the whole reason it
    // is safe to fold the factor into the ramp's outputs.
    for (const zoom of [12, 13.9, 14.8, 17]) {
      for (const stale of [false, true]) {
        expect(evaluate(dimIfStale(ZOOM_RAMP), zoom, stale)).toBeCloseTo(
          evaluate(['*', ZOOM_RAMP, STALE_FACTOR], zoom, stale),
          10,
        );
      }
    }
  });

  it('does not mutate the base expression', () => {
    const base = ['interpolate', ['linear'], ['zoom'], 13.2, 0, 14.8, 1];
    const snapshot = JSON.stringify(base);
    dimIfStale(base);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
