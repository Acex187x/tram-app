// Pack-local helpers for the "iso" pack — cute 3/4 isometric tram portraits.
// Camera contract (identical for all 7 models): the tram sits on a 2:1 iso
// grid, FRONT face toward the lower-left, SIDE receding to the upper-right,
// vertical edges stay vertical. Light comes from the front-left, so the front
// face is the lightest body tone, the roof is lighter still, and the side is
// a darker shade. Every face draws its own soft ground shadow + cel outline
// so icons read on both light and dark backgrounds.
//
// Pure module (no react imports) so it stays bundler-friendly.

export type Pt = readonly [number, number];

export interface Box {
  /** Near bottom corner where the front and side faces meet. */
  cx: number;
  cy: number;
  /** Projected front-face width. */
  w: number;
  /** Projected side length (long models get a bigger l). */
  l: number;
  /** Body height. */
  h: number;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Front plane. u: 0 = near corner → 1 = far-left edge. v: 0 = floor → 1 = roofline. */
export const F = (b: Box, u: number, v: number): Pt => [
  r1(b.cx - u * b.w),
  r1(b.cy - (u * b.w) / 2 - v * b.h),
];

/** Side plane. u: 0 = near corner → 1 = rear. v: 0 = floor → 1 = roofline. */
export const S = (b: Box, u: number, v: number): Pt => [
  r1(b.cx + u * b.l),
  r1(b.cy - (u * b.l) / 2 - v * b.h),
];

/** Roof plane. u: across width (0 = side edge → 1 = far-left). v: along length (0 = front → 1 = rear). */
export const R = (b: Box, u: number, v: number): Pt => [
  r1(b.cx - u * b.w + v * b.l),
  r1(b.cy - b.h - (u * b.w) / 2 - (v * b.l) / 2),
];

/** Point → path fragment. */
export const P = (p: Pt): string => `${p[0]} ${p[1]}`;

export const poly = (...pts: Pt[]): string => `M${pts.map(P).join(' L')} Z`;

/** Axis-aligned rect on the FRONT plane (projected parallelogram). */
export const fQuad = (b: Box, u0: number, v0: number, u1: number, v1: number): string =>
  poly(F(b, u0, v0), F(b, u1, v0), F(b, u1, v1), F(b, u0, v1));

/** Axis-aligned rect on the SIDE plane. */
export const sQuad = (b: Box, u0: number, v0: number, u1: number, v1: number): string =>
  poly(S(b, u0, v0), S(b, u1, v0), S(b, u1, v1), S(b, u0, v1));

/** Axis-aligned rect on the ROOF plane. */
export const rQuad = (b: Box, u0: number, v0: number, u1: number, v1: number): string =>
  poly(R(b, u0, v0), R(b, u1, v0), R(b, u1, v1), R(b, u0, v1));

/** Soft ground-contact shadow under the whole footprint. */
export const ground = (b: Box): string => {
  const left: Pt = [r1(b.cx - b.w - 2.5), r1(b.cy - b.w / 2 + 1)];
  const near: Pt = [r1(b.cx + 1.5), r1(b.cy + 2.5)];
  const back: Pt = [r1(b.cx + b.l + 2.5), r1(b.cy - b.l / 2 + 1)];
  const far: Pt = [r1(b.cx - b.w + b.l), r1(b.cy - b.w / 2 - b.l / 2 - 0.5)];
  return poly(left, near, back, far);
};

/** The square viewBox every iso face is authored in. */
export const VB = '0 0 96 96';

/** Shared pack palette — front tone / darker side tone / lighter roof tone triads. */
export const ISO = {
  outline: '#2E2532',
  // glazing
  glass: '#2B3746',
  glassSide: '#212B37',
  glassDoor: '#31404F',
  glint: '#CBE6F2',
  // Prague cream (T3 family)
  cream: '#F5E8CC',
  creamSide: '#DECBA3',
  creamRoof: '#FBF3DF',
  // PID red
  red: '#B5271E',
  redSide: '#8E1B13',
  redRoof: '#C63A2E',
  maroon: '#6E1310',
  // 52T / modern white
  white: '#F7F8F5',
  whiteSide: '#D6DAD8',
  whiteRoof: '#FFFFFF',
  // greys
  grey: '#9BA0A6',
  greySide: '#797E85',
  skirt: '#41454C',
  under: '#2C2F35',
  chrome: '#E7EAED',
  charcoal: '#33363B',
  // lights
  amber: '#FFAF36',
  warm: '#FFE9B8',
  shadow: '#151021',
} as const;
