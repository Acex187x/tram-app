// Mapbox style-expression helpers shared by the map layers.
//
// WHY THIS MODULE EXISTS (regression 2026-08-16, build 13 "bare circle" trams):
// the Mapbox style spec allows `["zoom"]` ONLY as the input to a *top-level*
// "step"/"interpolate" expression of a property value. Nesting a zoom ramp
// inside any other expression is not a warning — the native SDK rejects the
// WHOLE layer:
//
//   error | inserting layer failed at position default: "zoom" expression may
//   only be used as input to a top-level "step" or "interpolate" expression
//
// Physics v3 introduced `dimIfStale` as `["*", ramp, STALE_FACTOR]`. Because
// four of its five call sites pass a zoom ramp (the 3D ModelLayer's fade-in,
// the band-1/2 teardrops and BADGE_BAND_OPACITY), those five layers silently
// never entered the style: the 3D models, teardrops and face badges all
// vanished and every tram fell back to the one layer whose expression stayed
// legal — a plain CircleLayer. Hence "3D models never render, every tram is a
// bare circle", with the geometry pipeline perfectly healthy all along.
//
// Keeping these helpers in a pure module (no React, no @rnmapbox imports) is
// deliberate: it lets __tests__/map-style-expressions.test.ts assert the
// invariant directly, so this class of bug cannot reach a device again.

/** Opacity multiplier applied to a frozen ("stale") tram. */
export const STALE_DIM = 0.42;

/**
 * `1` for a live tram, STALE_DIM for one whose curve ran out. Zoom-independent
 * by construction — that is what makes folding it into a ramp's outputs below
 * an exact, not approximate, rewrite.
 */
export const STALE_FACTOR = ['case', ['==', ['get', 'stale'], 1], STALE_DIM, 1];

/** True for `["interpolate", …]` / `["step", …]` — the two zoom-ramp forms. */
function isRamp(expr: unknown): expr is unknown[] {
  return Array.isArray(expr) && (expr[0] === 'interpolate' || expr[0] === 'step');
}

/**
 * Multiply an opacity expression by the stale-dim factor, keeping any `["zoom"]`
 * ramp at the TOP level of the property value.
 *
 * For a ramp, the factor is folded into each OUTPUT stop instead of wrapping the
 * ramp — `interpolate(z → v) * f` and `interpolate(z → v * f)` are identical
 * when `f` does not depend on zoom (it depends only on the per-feature `stale`
 * prop), and only the latter is legal. Non-ramp bases (plain numbers) keep the
 * simple multiply, which was always valid.
 *
 * Stop layout:
 *   ["interpolate", <interpolation>, <input>, s0, v0, s1, v1, …]  → outputs at 4,6,…
 *   ["step",        <input>, <default>,      s0, v0, …]           → outputs at 2,4,…
 */
export function dimIfStale(base: unknown): number {
  if (!isRamp(base)) {
    return ['*', base, STALE_FACTOR] as unknown as number;
  }
  const out = [...base];
  // First output index: interpolate carries an extra interpolation-type slot.
  const firstOutput = base[0] === 'interpolate' ? 4 : 2;
  for (let i = firstOutput; i < out.length; i += 2) {
    out[i] = ['*', out[i], STALE_FACTOR];
  }
  return out as unknown as number;
}

/**
 * Test/diagnostic helper: report every `["zoom"]` that is NOT the input of the
 * top-level ramp, i.e. exactly what the native SDK rejects. Returns a list of
 * JSON-path-ish breadcrumbs so a failing assertion names the offender.
 */
export function findIllegalZoomRefs(expr: unknown, path = '$'): string[] {
  const bad: string[] = [];
  const walk = (node: unknown, at: string, topLevel: boolean): void => {
    if (!Array.isArray(node)) return;
    if (node[0] === 'zoom') {
      bad.push(at);
      return;
    }
    if (topLevel && isRamp(node)) {
      // The ramp's INPUT slot is the one legal place for ["zoom"].
      const inputIdx = node[0] === 'interpolate' ? 2 : 1;
      node.forEach((child, i) => {
        if (i === inputIdx && Array.isArray(child) && child[0] === 'zoom') return;
        walk(child, `${at}[${i}]`, false);
      });
      return;
    }
    node.forEach((child, i) => walk(child, `${at}[${i}]`, false));
  };
  walk(expr, path, true);
  return bad;
}
