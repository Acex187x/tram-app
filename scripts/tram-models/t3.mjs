// Tatra T3 (historic, museum-livery) — single rigid car 14.1 m × 2.5 m.
// THE iconic 1960s Prague tram. Modeled from reference photos of car 6102
// (Wikimedia Commons / prazsketramvaje.cz):
//  * huge rounded panoramic windshield (sill lower than side windows),
//    thin center seam + cream corner pillars, chrome-ringed pill destination
//    box centered high on the cream brow, two round chrome-ring headlights
//    low in the red mask, chrome bumper strip, cream apron under it,
//  * cream window band + roof over a traffic-red belt, cream skirt strip and
//    maroon lip at the bottom, thin red pinstripe at the roofline,
//  * right side: door at the cab, 2 windows, door, 3 windows, door, quarter
//    window; left side: driver window + 8-window run; sliding-vent dividers,
//  * smooth cream domed roof, grey resistor boxes, RED scissor pantograph.
//
// This file deliberately does NOT use buildT3 from t3-common.mjs — the
// historic car gets its own, more faithful geometry. (t3rp/t3rplf keep
// sharing t3-common.)

import {
  MeshBuilder, arcZAtX, buildWall, coupler, floorPlate, mirrorArcZ,
  noseArc, noseBands, roofPod, scissorPantograph, underframe, wallSegs,
} from './lib.mjs';

const L = 14.1;
const W = 2.5;
const HW = W / 2;
const NOSE = 1.55; // plan depth of each rounded mask
const ZS = L / 2 - NOSE; // wall extent / mask start plane (5.5)

const Y_SKIRT = 0.30; // bottom of maroon lip
const Y0 = 0.63; // bottom of red belt (top of chrome strip level)
const SILL = 1.65; // side window sill
const WINTOP = 2.42;
const YTOP = 2.72; // top of cream band → roof profile starts
const ROOF = 3.02; // roof plateau
const ARC_N = 14;

export const EXPECT = { length: L, width: W };

// ── Mask level stacks: [y, planDepth, halfWidth] head-to-toe profile ─────────
// Depth peaks at the chrome bumper strip (defines the 14.1 m bbox tip), the
// windshield rakes back strongly, the brow leans slightly out over the glass,
// then the roof dome pulls in (tumblehome top).

const FRONT_LEVELS = [
  [0.30, 1.26, 1.13], // apron bottom, tucked in
  [0.55, 1.50, 1.25],
  [0.63, 1.55, 1.25], // chrome strip → proudest ring
  [1.25, 1.49, 1.25], // red mask top
  [1.42, 1.44, 1.25], // cream strip below windshield
  [2.32, 1.08, 1.25], // windshield top (raked)
  [2.36, 1.09, 1.25], // red pinstripe
  [2.60, 1.14, 1.25], // cream brow (destination pill lives here)
  [2.72, 1.06, 1.25],
  [2.88, 0.92, 1.19], // roof dome
  [2.98, 0.70, 0.97],
  [3.02, 0.50, 0.70],
];
const FRONT_MATS = [
  'cream', 'silver', 'redClassic', 'cream', 'glass',
  'redClassic', 'cream', 'cream', 'cream', 'cream', 'cream',
];

// Rear: taller red panel straight up to the (equally huge) rear window.
const REAR_LEVELS = [
  [0.30, 1.26, 1.13],
  [0.55, 1.50, 1.25],
  [0.63, 1.55, 1.25],
  [1.42, 1.46, 1.25], // red all the way up
  [1.47, 1.44, 1.25], // thin cream sill strip
  [2.32, 1.08, 1.25],
  [2.36, 1.09, 1.25],
  [2.60, 1.14, 1.25],
  [2.72, 1.06, 1.25],
  [2.88, 0.92, 1.19],
  [2.98, 0.70, 0.97],
  [3.02, 0.50, 0.70],
];
const REAR_MATS = FRONT_MATS;

/** Build per-level plan arcs for one mask. dirZ −1 = front, +1 = rear. */
function maskArcs(levels, dirZ) {
  return levels.map(([, depth, hw]) => {
    const a = noseArc({ hw, zStart: -ZS, depth, p: 0.7, n: ARC_N });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  });
}

/** z on the mask surface at (x, y), interpolated between level arcs. */
function maskZ(levels, arcs, x, y) {
  for (let i = 0; i < levels.length - 1; i++) {
    const [y0] = levels[i];
    const [y1] = levels[i + 1];
    if (y >= y0 && y <= y1) {
      const t = (y - y0) / (y1 - y0 || 1);
      return arcZAtX(arcs[i], x) * (1 - t) + arcZAtX(arcs[i + 1], x) * t;
    }
  }
  return arcZAtX(arcs[arcs.length - 1], x);
}

/** Round lamp with a CHROME ring (lib's roundLamp uses dark trim). */
function chromeLamp(mb, { x, y, zFace, r, mat, dir }) {
  // dir is the outward z sign of the face (−1 front / +1 rear)
  mb.cylinder('silver', {
    x, y, z: zFace + dir * 0.02, r: r + 0.025, len: 0.09, axis: 'z', seg: 12, caps: false,
  });
  mb.cylinder(mat, {
    x, y, z: zFace + dir * 0.035, r, len: 0.05, axis: 'z', seg: 12, caps: true, capMat: mat,
  });
}

/** One rounded T3 mask. dirZ −1 → front (has display + headlights). */
function t3Mask(mb, dirZ) {
  const levels = dirZ < 0 ? FRONT_LEVELS : REAR_LEVELS;
  const matList = dirZ < 0 ? FRONT_MATS : REAR_MATS;
  const arcs = maskArcs(levels, dirZ);
  noseBands(mb, {
    bands: levels.slice(0, -1).map(([y0], i) => ({
      y0, y1: levels[i + 1][0], mat: matList[i], arc0: arcs[i], arc1: arcs[i + 1],
    })),
    capMat: 'cream',
    capCorners: [],
  });

  const glassLo = dirZ < 0 ? 1.42 : 1.47;
  const glassHi = 2.32;
  const zGlass = (x, y) => maskZ(levels, arcs, x, y) + dirZ * 0.02; // proud of glass

  // cream corner pillars framing the panoramic glass + center seam
  const pillarXs = dirZ < 0 ? [-0.98, 0, 0.98] : [-0.98, -0.5, 0.5, 0.98];
  for (const px of pillarXs) {
    const wPx = Math.abs(px) > 0.6 ? 0.07 : 0.035;
    mb.beam('cream', [px, glassLo + 0.01, zGlass(px, glassLo + 0.01)],
      [px, glassHi - 0.01, zGlass(px, glassHi - 0.01)], wPx, 0.03);
  }

  if (dirZ < 0) {
    // destination pill: chrome ring + black casing + warm emissive face
    const zc = maskZ(levels, arcs, 0, 2.48);
    mb.box('silver', { x: 0, y: 2.48, z: zc + 0.045, w: 1.24, h: 0.34, d: 0.10, bevel: 0.12 });
    mb.box('black', { x: 0, y: 2.48, z: zc - 0.005, w: 1.16, h: 0.27, d: 0.11, bevel: 0.09 });
    mb.rectZ('display', zc - 0.062, -0.46, 0.46, 2.40, 2.56, -1);

    // twin round headlights low in the red band
    for (const sx of [-1, 1]) {
      chromeLamp(mb, {
        x: sx * 0.58, y: 0.95, zFace: maskZ(levels, arcs, sx * 0.58, 0.95),
        r: 0.13, mat: 'headlight', dir: -1,
      });
    }
    // parked wipers on the glass
    for (const sx of [-1, 1]) {
      mb.beam('black',
        [sx * 0.58, 1.50, zGlass(sx * 0.58, 1.50) - 0.012],
        [sx * 0.22, 1.95, zGlass(sx * 0.22, 1.95) - 0.012], 0.018, 0.015);
    }
    // chrome mirror beside the windshield (right side)
    mb.beam('silver', [1.20, 2.18, -ZS + 0.12], [1.26, 2.22, -ZS - 0.10], 0.025);
    mb.box('silver', { x: 1.26, y: 2.14, z: -ZS - 0.11, w: 0.03, h: 0.17, d: 0.12 });
    // safety plow under the apron
    mb.box('trim', { x: 0, y: 0.19, z: -(L / 2) + 0.52, w: 1.7, h: 0.13, d: 0.42 });
  } else {
    // twin horizontal oval taillights (amber indicator + red brake) above the
    // chrome bumper strip
    for (const sx of [-1, 1]) {
      const zf = maskZ(levels, arcs, sx * 0.60, 0.78) + 0.035;
      mb.box('display', { x: sx * 0.60 - 0.085, y: 0.78, z: zf, w: 0.16, h: 0.13, d: 0.06, bevel: 0.04 });
      mb.box('taillight', { x: sx * 0.60 + 0.085, y: 0.78, z: zf, w: 0.16, h: 0.13, d: 0.06, bevel: 0.04 });
    }
  }
  coupler(mb, { zEnd: dirZ * (L / 2), dir: dirZ });
}

/** Cheap bogie: the deep T3 skirts hide most of it — low-poly wheels. */
function t3Bogie(mb, { z }) {
  mb.box('trim', { x: 0, y: 0.42, z, w: W - 0.8, h: 0.4, d: 2.5 });
  for (const dz of [-0.95, 0.95]) {
    for (const sx of [-1, 1]) {
      mb.cylinder('black', {
        x: sx * 0.93, y: 0.33, z: z + dz, r: 0.33, len: 0.09, axis: 'x', seg: 8,
      });
    }
  }
}

/** Side skirt: cream strip + maroon lip, cream interrupted at doors. */
function skirt(mb, side, segments) {
  const quadOut = (mat, xLo, yLo, xHi, yHi, za, zb) => {
    const [z0, z1] = side > 0 ? [za, zb] : [zb, za];
    mb.quad(mat,
      [side * xLo, yLo, z0], [side * xHi, yHi, z0],
      [side * xHi, yHi, z1], [side * xLo, yLo, z1]);
  };
  // maroon lip runs the whole side
  quadOut('redDark', 1.165, Y_SKIRT, 1.205, 0.42, -ZS, ZS);
  // cream strip, skipped under doors
  let z = -ZS;
  for (const s of segments) {
    const z1 = z + s.len;
    if (s.t !== 'door') quadOut('cream', 1.205, 0.42, HW, Y0, z, z1);
    z = z1;
  }
}

export function buildT3Historic() {
  const mb = new MeshBuilder();
  const mats = {
    lower: 'redClassic', upper: 'cream', pillar: 'cream',
    glass: 'glass', door: 'cream', frame: 'cream',
  };
  const winOpts = { targetWin: 1.02, pillar: 0.15 };

  // side walls — rhythm verified against photos of 6102
  const rightItems = [
    { t: 'panel', len: 0.12 },
    { t: 'door', len: 1.35 },
    { t: 'run', weight: 2 }, // 2 windows
    { t: 'door', len: 1.35 },
    { t: 'run', weight: 3 }, // 3 windows
    { t: 'door', len: 1.35 },
    { t: 'panel', len: 0.14 }, { t: 'win', len: 0.78 }, { t: 'panel', len: 0.14 },
  ];
  const leftItems = [
    { t: 'panel', len: 0.26 }, { t: 'win', len: 0.80 }, // driver window
    { t: 'run', weight: 1 }, // 8-window run
    { t: 'panel', len: 0.30 },
  ];
  const segsR = wallSegs(2 * ZS, rightItems, winOpts);
  const segsL = wallSegs(2 * ZS, leftItems, winOpts);
  const wallCfg = {
    xw: HW, z0: -ZS, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP,
    mats, doorLowY: 0.38, ventY: 2.16,
  };
  buildWall(mb, { ...wallCfg, side: 1, segments: segsR });
  buildWall(mb, { ...wallCfg, side: -1, segments: segsL });
  skirt(mb, 1, segsR);
  skirt(mb, -1, segsL);

  // thin red pinstripe along the rooflines
  for (const side of [-1, 1]) {
    mb.rectX('redClassic', side * (HW + 0.004), -ZS, ZS, 2.44, 2.475, side);
  }

  // rounded roof (smooth cream dome — the real T3 roof has no ribs)
  const roofProfile = [
    [-HW, YTOP], [HW, YTOP], [1.19, 2.88], [0.97, 2.98], [0.70, ROOF],
    [-0.70, ROOF], [-0.97, 2.98], [-1.19, 2.88],
  ];
  mb.prismZ('cream', roofProfile, -ZS, ZS);

  // masks
  t3Mask(mb, -1);
  t3Mask(mb, 1);

  // underfloor + bogies (deep skirts hide most of the wheels — as real)
  floorPlate(mb, { z0: -ZS, z1: ZS, xw: HW, y0: Y_SKIRT });
  underframe(mb, { z0: -ZS + 0.2, z1: ZS - 0.2, width: W, y0: Y_SKIRT });
  t3Bogie(mb, { z: -3.2 });
  t3Bogie(mb, { z: 3.2 });

  // roof kit: grey resistor boxes + RED scissor pantograph (Prague cars)
  roofPod(mb, { z: 0.9, y: ROOF, w: 0.95, h: 0.16, d: 1.7, mat: 'roof' });
  roofPod(mb, { z: 2.5, y: ROOF, w: 0.85, h: 0.13, d: 1.1, mat: 'roof' });
  roofPod(mb, { z: -3.1, y: ROOF, w: 0.7, h: 0.10, d: 0.8, mat: 'roof' });
  scissorPantograph(mb, { z: -0.5, yRoof: ROOF, mat: 'redClassic' });

  return mb;
}

export function sections() {
  return [{ key: 't3', build: () => buildT3Historic(), expect: EXPECT }];
}
