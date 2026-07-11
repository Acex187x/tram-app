// Škoda 14T "Elektra" (Porsche Design) — 5 sections, 30.25 m, unidirectional.
// Verified against photos (Wikimedia: 9115, 9119, 9135, 9155, roof shot 9140):
//   * ALL-SILVER helmet nose (no red on the front), big one-piece raked
//     windshield, two vertical stacks of 3 round headlights low on the nose,
//     black chin slot, green LED destination display behind the glass top.
//   * Red livery = full-height blocks (skirt → above windows) on sections
//     b/c/d + most of e; section a all silver; silver roof shoulder throughout.
//   * Doors right side only: 2 wide double-leaf per short section (b, d),
//     1 single-leaf at rear of e, narrow silver driver's door on a. None on c.
//   * Pantograph (single-arm) sits on short section b, near the front.
//   * Roof: exposed equipment boxes on every section + cable runs crossing
//     the articulations; clean dome over the cab.

import {
  MeshBuilder, arcAt, arcZAtX, bogie, buildSectionShell, buildWall,
  destinationDisplay, floorPlate, jointCap, mirrorArcZ, noseBands,
  roofSlab, roundLamp, singleArmPantograph, underframe, wallSegs, wedgeArc,
} from './lib.mjs';

const W = 2.46;
const HW = W / 2;
const LLONG = 6.95;
const LSHORT = 4.35;
const Y0 = 0.32; // deep smooth skirts
const SILL = 1.12; // low sill — tall window band (photos)
const WINTOP = 2.38;
const YTOP = 2.55; // top of the red field / window surround
const ROOFTOP = 3.0; // silver roof shoulder plateau
const NOSE = 1.9; // cab end depth (windshield base → bumper tip)

// Red zones: red from skirt to above the windows, red pillars, red doors.
const RED = {
  lower: 'redClassic', upper: 'redClassic', pillar: 'redClassic',
  glass: 'glass', door: 'redClassic', frame: 'redClassic',
};
// Silver zones (cab section + tail cap): black window-band pillars.
const SIL = {
  lower: 'silver', upper: 'silver', pillar: 'black',
  glass: 'glass', door: 'redClassic', frame: 'silver',
};
const WIN = { targetWin: 1.5, pillar: 0.14 };

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Porsche helmet cab end. dirZ -1 → nose of section a, +1 → tail of e.
 * zJoin = z where the side walls stop and the cab shell begins.
 */
function cabEnd(mb, { dirZ, zJoin }) {
  const abs = Math.abs(zJoin);
  // [y, plan depth, flat front width, half-width] per horizontal slice
  const spec = {
    chin: { y: 0.32, d: 1.7, fw: 1.3, hw: HW - 0.06 },
    bump: { y: 0.55, d: 1.84, fw: 1.35, hw: HW },
    face: { y: 0.75, d: 1.9, fw: 1.35, hw: HW },
    glassLo: { y: 1.28, d: 1.84, fw: 1.5, hw: HW },
    glassHi: { y: 2.58, d: 0.92, fw: 1.35, hw: HW - 0.06 },
    brow: { y: 2.78, d: 0.68, fw: 1.1, hw: HW - 0.14 },
    roof: { y: 3.0, d: 0.34, fw: 0.85, hw: HW - 0.3 },
  };
  const A = {};
  for (const [k, s] of Object.entries(spec)) {
    const a = wedgeArc({ hw: s.hw, zStart: -abs, depth: s.d, frontW: s.fw, n: 20 });
    A[k] = dirZ > 0 ? mirrorArcZ(a) : a;
  }
  noseBands(mb, {
    bands: [
      { y0: 0.32, y1: 0.55, mat: 'trim', arc0: A.chin, arc1: A.bump },
      { y0: 0.55, y1: 0.75, mat: 'silver', arc0: A.bump, arc1: A.face },
      { y0: 0.75, y1: 1.28, mat: 'silver', arc0: A.face, arc1: A.glassLo },
      { y0: 1.28, y1: 2.58, mat: 'glass', arc0: A.glassLo, arc1: A.glassHi },
      { y0: 2.58, y1: 2.78, mat: 'silver', arc0: A.glassHi, arc1: A.brow },
      { y0: 2.78, y1: 3.0, mat: 'silver', arc0: A.brow, arc1: A.roof },
    ],
    capMat: 'silver',
    capCorners: dirZ < 0
      ? [[HW - 0.3, zJoin], [-(HW - 0.3), zJoin]]
      : [[-(HW - 0.3), abs], [HW - 0.3, abs]],
  });
  // close the underside of the cab overhang
  mb.fan('trim', [
    ...arcAt(A.chin, 0.32),
    ...(dirZ < 0
      ? [[HW - 0.06, zJoin, 0.32], [-(HW - 0.06), zJoin, 0.32]]
      : [[-(HW - 0.06), abs, 0.32], [HW - 0.06, abs, 0.32]]).map(([x, z]) => [x, 0.32, z]),
  ], [0, -1, 0]);

  // interpolated shell z at (x, y) between two arc slices
  const surf = (lo, hi, x, y) =>
    lerp(arcZAtX(A[lo], x), arcZAtX(A[hi], x), (y - spec[lo].y) / (spec[hi].y - spec[lo].y));

  // stacked round lamps low on the nose (3 head / 2 tail), photos: x ±0.55
  const lampMat = dirZ < 0 ? 'headlight' : 'taillight';
  const ys = dirZ < 0 ? [0.85, 1.02, 1.19] : [0.88, 1.06];
  for (const sx of [-1, 1]) {
    // dark recessed cluster plate behind the lamp stack
    const yMid = (ys[0] + ys[ys.length - 1]) / 2;
    mb.box('trim', {
      x: sx * 0.55, y: yMid, z: surf('face', 'glassLo', sx * 0.55, yMid) + dirZ * 0.008,
      w: 0.26, h: ys[ys.length - 1] - ys[0] + 0.26, d: 0.016,
    });
    for (const y of ys) {
      roundLamp(mb, {
        x: sx * 0.55, y, zFace: surf('face', 'glassLo', sx * 0.55, y) + dirZ * 0.025,
        r: 0.085, mat: lampMat, dir: dirZ,
      });
    }
  }
  // destination display glowing behind the windshield top
  const dispY = dirZ < 0 ? 2.38 : 2.3;
  destinationDisplay(mb, {
    zFace: surf('glassLo', 'glassHi', 0, dispY) + dirZ * 0.02,
    y: dispY, w: dirZ < 0 ? 1.2 : 0.7, h: dirZ < 0 ? 0.24 : 0.16, dir: dirZ,
  });

  if (dirZ < 0) {
    // Škoda badge between the headlight stacks
    mb.cylinder('black', {
      x: 0, y: 1.15, z: surf('face', 'glassLo', 0, 1.15) + dirZ * 0.015,
      r: 0.1, len: 0.03, axis: 'z', seg: 10,
    });
    // windshield wiper
    mb.beam('black',
      [0.45, 1.4, surf('glassLo', 'glassHi', 0.45, 1.4) + dirZ * 0.03],
      [-0.15, 2.35, surf('glassLo', 'glassHi', -0.15, 2.35) + dirZ * 0.03],
      0.035);
    // side mirrors on slim stalks at the A-pillars
    for (const sx of [-1, 1]) {
      mb.beam('black',
        [sx * (HW - 0.12), 2.42, zJoin + dirZ * 0.15],
        [sx * (HW + 0.02), 2.28, zJoin + dirZ * 0.3], 0.025);
      mb.box('black', {
        x: sx * (HW + 0.03), y: 2.16, z: zJoin + dirZ * 0.32,
        w: 0.05, h: 0.24, d: 0.12,
      });
    }
  }
}

/** Roof cable conduits running to the articulated end(s). */
function roofCables(mb, { z0, z1 }) {
  for (const sx of [-1, 1]) {
    mb.cylinder('trim', {
      x: sx * 0.32, y: ROOFTOP + 0.035, z: (z0 + z1) / 2,
      r: 0.03, len: z1 - z0, axis: 'z', seg: 6,
    });
  }
}

/** Section a — cab, all silver, driver's door, bogie. */
function head() {
  const mb = new MeshBuilder();
  const z0 = -LLONG / 2 + NOSE;
  const z1 = LLONG / 2 - 0.28;
  const common = { xw: HW, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, mats: SIL };
  buildWall(mb, {
    ...common, side: 1, z0,
    segments: wallSegs(z1 - z0, [
      { t: 'panel', len: 0.18 },
      { t: 'door', len: 0.92, mat: 'silver', topMat: 'silver' },
      { t: 'run' },
    ], { targetWin: 1.6, pillar: 0.12 }),
  });
  buildWall(mb, {
    ...common, side: -1, z0,
    segments: wallSegs(z1 - z0, [{ t: 'run' }], { targetWin: 1.6, pillar: 0.12 }),
  });
  roofSlab(mb, { z0, z1, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: 'silver', shrink: 0.3 });
  floorPlate(mb, { z0, z1, xw: HW, y0: Y0 });
  underframe(mb, { z0: z0 + 0.15, z1: z1 - 0.15, width: W, y0: Y0 });
  bogie(mb, { z: 0.5, width: W });
  jointCap(mb, { zWall: z1, zEnd: LLONG / 2, dir: 1, width: W, y0: Y0, yTop: YTOP, roofTop: ROOFTOP, roofShrink: 0.3 });
  cabEnd(mb, { dirZ: -1, zJoin: z0 });
  // roof gear behind the clean cab dome
  mb.box('trim', { x: 0, y: 3.13, z: 1.0, w: 1.35, h: 0.26, d: 1.7, bevel: 0.05 });
  mb.box('roof', { x: 0, y: 3.15, z: 2.45, w: 1.15, h: 0.3, d: 1.3, bevel: 0.06 });
  roofCables(mb, { z0: 1.9, z1: LLONG / 2 });
  return mb;
}

/** Sections b/d — short, suspended, red, two double doors; b carries the pantograph. */
function short({ pantograph = false } = {}) {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LSHORT, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'bellows',
    rightItems: [{ t: 'door', len: 1.42 }, { t: 'run' }, { t: 'door', len: 1.42 }],
    leftItems: [{ t: 'run' }],
    mats: RED, roofMat: 'silver', roofShrink: 0.3,
    bogies: [], // suspended between neighbors
    winOpts: { targetWin: 1.3, pillar: 0.14 },
  });
  if (pantograph) {
    singleArmPantograph(mb, { z: -0.2, yRoof: ROOFTOP, mat: 'brass' }); // beige LEKOV arm
    mb.box('roof', { x: 0, y: ROOFTOP + 0.07, z: 1.4, w: 1.25, h: 0.14, d: 1.1, bevel: 0.04 });
  } else {
    mb.box('roof', { x: 0, y: ROOFTOP + 0.175, z: 0, w: 1.3, h: 0.35, d: 1.7, bevel: 0.06 });
    mb.box('trim', { x: 0, y: ROOFTOP + 0.09, z: -1.4, w: 1.0, h: 0.18, d: 0.8, bevel: 0.04 });
  }
  roofCables(mb, { z0: -LSHORT / 2, z1: LSHORT / 2 });
  return mb;
}

/** Section c — long middle, red, windows only, center bogie. */
function mid() {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LLONG, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'bellows',
    rightItems: [{ t: 'run' }],
    leftItems: [{ t: 'run' }],
    mats: RED, roofMat: 'silver', roofShrink: 0.3,
    bogies: [0],
    winOpts: WIN,
  });
  mb.box('trim', { x: 0, y: 3.15, z: -0.8, w: 1.45, h: 0.3, d: 2.6, bevel: 0.06 });
  mb.box('roof', { x: 0, y: 3.11, z: 1.6, w: 1.15, h: 0.22, d: 1.5, bevel: 0.05 });
  roofCables(mb, { z0: -LLONG / 2, z1: LLONG / 2 });
  return mb;
}

/** Section e — tail cab: red through the last (single-leaf) door, silver tail cap. */
function tail() {
  const mb = new MeshBuilder();
  const z0 = -LLONG / 2 + 0.06;
  const z1 = LLONG / 2 - NOSE;
  const common = { xw: HW, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP };
  // right: red windows + the rear single-leaf door ending right at the tail cap
  buildWall(mb, {
    ...common, side: 1, z0, mats: RED,
    segments: wallSegs(z1 - z0, [{ t: 'run' }, { t: 'door', len: 1.0 }], WIN),
  });
  // left: red run, then a silver stub with one window wrapping into the tail
  const zSplit = 0.2;
  buildWall(mb, {
    ...common, side: -1, z0, mats: RED,
    segments: wallSegs(zSplit - z0, [{ t: 'run' }], WIN),
  });
  buildWall(mb, {
    ...common, side: -1, z0: zSplit, mats: SIL,
    segments: wallSegs(z1 - zSplit, [{ t: 'run' }], { targetWin: 1.2, pillar: 0.12 }),
  });
  roofSlab(mb, { z0, z1, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: 'silver', shrink: 0.3 });
  floorPlate(mb, { z0, z1, xw: HW, y0: Y0 });
  underframe(mb, { z0: z0 + 0.15, z1: z1 - 0.15, width: W, y0: Y0 });
  bogie(mb, { z: -0.5, width: W });
  jointCap(mb, { zWall: z0, zEnd: -LLONG / 2, dir: -1, width: W, y0: Y0, yTop: YTOP, roofTop: ROOFTOP, roofShrink: 0.3 });
  cabEnd(mb, { dirZ: 1, zJoin: z1 });
  mb.box('trim', { x: 0, y: 3.13, z: -1.7, w: 1.35, h: 0.26, d: 1.7, bevel: 0.05 });
  mb.box('roof', { x: 0, y: 3.1, z: -0.3, w: 1.1, h: 0.2, d: 1.1, bevel: 0.05 });
  roofCables(mb, { z0: -LLONG / 2, z1: -0.6 });
  return mb;
}

export function sections() {
  const eLong = { length: LLONG, width: W };
  const eShort = { length: LSHORT, width: W };
  return [
    { key: '14t-a', build: head, expect: eLong },
    { key: '14t-b', build: () => short({ pantograph: true }), expect: eShort },
    { key: '14t-c', build: mid, expect: eLong },
    { key: '14t-d', build: () => short(), expect: eShort },
    { key: '14t-e', build: tail, expect: eLong },
  ];
}
