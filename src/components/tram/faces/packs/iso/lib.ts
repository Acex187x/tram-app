// Pack-local helpers for the "iso" pack — cute 3/4 isometric tram portraits.
//
// Camera contract (identical for all 7 models): the tram sits on a 2:1 iso
// grid, FRONT face toward the lower-left, SIDE receding to the upper-right,
// vertical edges stay vertical. Light comes from the front-left, so the front
// face is the lightest body tone, the roof is lighter still, and the side is
// a darker shade.
//
// SIZE NORMALIZATION — the whole pack shares ONE icon gauge:
//   • every body is BODY_H tall,
//   • every body's projected footprint is exactly SPAN = w + l,
//   • isoBox() centers that footprint in the 96×96 viewBox.
// Because the projected bbox is (w+l) wide and (h + (w+l)/2) tall, equal SPAN
// + equal BODY_H ⇒ literally identical silhouette bounds for all models. A
// long tram reads long through its front/side PROPORTION (narrow front, long
// flank, more windows), never through a bigger icon. Do not hand-roll Box
// values in faces — always go through isoBox().
//
// REAL SHAPE, NOT A BOX — every face is drawn against its -34 reference
// photo. The N3() helper projects a full 3D body point (across, back, up) so
// windscreens RAKE backwards, crowns ROUND into the roof and noses slope:
// the front of a model with a slanted nose is never a flat vertical
// parallelogram. Icons sit straight on a TRANSPARENT background — no backdrop
// tile, only a whisper of contact shadow.
//
// Pure module (no react imports) so it stays bundler-friendly.

export type Pt = readonly [number, number];

export interface Box {
  /** Near bottom corner where the front and side faces meet. */
  cx: number;
  cy: number;
  /** Projected front-face width. */
  w: number;
  /** Projected side length. */
  l: number;
  /** Body height. */
  h: number;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Shared body height — identical for every model in the pack. */
export const BODY_H = 24;
/** Shared projected footprint w + l — identical for every model in the pack. */
export const SPAN = 58;

/** Front width of the short T3 family (~14 m cars): a touch wider than the
 * long cars — the flank still dominates, as it does in every photo. */
export const SHORT_W = 23;
/** Front width of the long cars (~30 m): narrow front, long receding flank. */
export const LONG_W = 20;

/**
 * The one true Box factory: give it a front width, get a Box whose projected
 * bounds are identical for every model and centered in the 96×96 viewBox.
 */
export const isoBox = (w: number): Box => ({
  cx: (96 - SPAN) / 2 + w,
  cy: 72,
  w,
  l: SPAN - w,
  h: BODY_H,
});

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

/**
 * Full 3D body point — the tool that kills the cube. a: across the front
 * (0 = near corner → 1 = far-left edge). dpx: PIXELS back along the length
 * axis (0 = nose tip plane). z: 0 = floor → 1 = roofline. A raked windscreen
 * is simply a quad whose top edge has a bigger dpx than its bottom edge.
 */
export const N3 = (b: Box, a: number, dpx: number, z: number): Pt => [
  r1(b.cx - a * b.w + dpx),
  r1(b.cy - (a * b.w) / 2 - dpx / 2 - z * b.h),
];

/** Shift an already-projected point back along the length axis by dpx pixels. */
export const back = (p: Pt, dpx: number): Pt => [r1(p[0] + dpx), r1(p[1] - dpx / 2)];

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

/** Ground-contact shadow under the whole footprint (soft-drawn by isoStage). */
export const ground = (b: Box): string => {
  const left: Pt = [r1(b.cx - b.w - 2), r1(b.cy - b.w / 2 + 1)];
  const near: Pt = [r1(b.cx + 1.5), r1(b.cy + 2)];
  const back: Pt = [r1(b.cx + b.l + 2), r1(b.cy - b.l / 2 + 1)];
  const far: Pt = [r1(b.cx - b.w + b.l), r1(b.cy - b.w / 2 - b.l / 2 - 0.5)];
  return poly(left, near, back, far);
};

/** The square viewBox every iso face is authored in. */
export const VB = '0 0 96 96';

/** Shared pack palette — front tone / darker side tone / lighter roof tone triads. */
export const ISO = {
  outline: '#39323C',
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
  red: '#BC2A20',
  redSide: '#93201A',
  redRoof: '#C63A2E',
  maroon: '#6E1310',
  // 52T / modern white
  white: '#FBFBF9',
  whiteSide: '#D9DCDA',
  whiteRoof: '#FFFFFF',
  // greys
  grey: '#9BA0A6',
  greySide: '#797E85',
  skirt: '#41454C',
  under: '#33363C',
  chrome: '#E7EAED',
  charcoal: '#33363B',
  // lights
  amber: '#FFAF36',
  warm: '#FFE9B8',
  shadow: '#4E483E',
  // T3R.PLF wine bib + champagne-silver body
  wine: '#8A2131',
  wineSide: '#671723',
  silver: '#DCD8CC',
  silverSide: '#B9B3A4',
  silverRoof: '#ECE9E0',
  // modern glossy black (52T visor, 15T windscreen)
  visor: '#191B21',
  // LED destination orange + classic blue route box
  ledOrange: '#FF8F1F',
  blue: '#1D4E9E',
  // Tatra scissor/diamond pantograph yellow
  pantoY: '#C9971F',
} as const;

/** Skewed diamond (rhombus) pantograph path — the Tatra scissor tell. */
export const diamond = (m: Pt, span = 5.2, lift = 4.4, apex = 9.5): string => {
  const [mx, my] = m;
  const left: Pt = [r1(mx - span), r1(my + span / 2 - lift)];
  const right: Pt = [r1(mx + span), r1(my - span / 2 - lift)];
  const top: Pt = [r1(mx), r1(my - apex)];
  return `M${P([mx, my])} L${P(left)} L${P(top)} L${P(right)} Z`;
};

/** Contact bar sitting on the diamond apex. */
export const diamondBar = (m: Pt, apex = 9.5): string => {
  const [mx, my] = m;
  return `M${r1(mx - 3.2)} ${r1(my - apex + 1.6)} L${r1(mx + 3.2)} ${r1(my - apex - 1.6)}`;
};

/** Single-arm pantograph (modern Škoda cars) anchored at roof point p0. */
export const singleArm = (p0: Pt): { arm: string; bar: string } => {
  const knee: Pt = [r1(p0[0] - 1.2), r1(p0[1] - 5.4)];
  const head: Pt = [r1(knee[0] + 4.4), r1(knee[1] - 2.2)];
  return {
    arm: `M${P(p0)} L${P(knee)} L${P(head)}`,
    bar: `M${r1(head[0] - 2.8)} ${r1(head[1] + 1.4)} L${r1(head[0] + 2.8)} ${r1(head[1] - 1.4)}`,
  };
};
