// Tatra KT8D5.RN2P — 3 sections (~30.3 m), boxy 1980s three-section tram,
// RN2P modernization. Photo-verified facts (Wikimedia refs 9053/9067/9088):
//   * flat front cap with strongly rounded corners; big raked windshield in a
//     BLACK mask, wrapped by a white "horseshoe" (roof fascia, corner pillars,
//     white arc stripe below the glass)
//   * red band with two round halogen headlights; red rises full-height at the
//     corners joining the side waist band; white apron + dark plow below
//   * sides: white body, black-framed windows, red waist band (sill→0.72 m),
//     white skirt covering the bogies; doors on BOTH sides (double-ended car)
//   * end sections: cab flank + door + 3 windows + door; low-floor middle: two
//     plug doors; black semi-pantographs near the cab ends of A and C; long
//     dark resistor boxes on the white roof; middle section suspended.

import {
  MeshBuilder, arcAt, arcZAtX, buildSectionShell, coupler, destinationDisplay,
  mirrorArcZ, resamplePolyline, roofPod, roundLamp, seg, wallSegs,
} from './lib.mjs';

const W = 2.48;
const HW = W / 2;
const LA = 10.0; // end sections
const LB = 9.7; // suspended low-floor middle
const SKB = 0.30; // skirt bottom
const Y0 = 0.72; // wall bottom = red waist band bottom
const WAIST_TOP = 1.55; // top of the red waist band (white gap above, to SILL)
const SILL = 1.68;
const WINTOP = 2.52;
const YTOP = 2.80;
const ROOFTOP = 3.04;
const NOSE = 0.45; // plan depth of the rounded front cap
const DOOR_LOW = 0.32;
const WIN = { targetWin: 1.28, pillar: 0.16 };
const VENT_Y = 2.32;

const MATS = {
  lower: 'redClassic',
  upper: 'white',
  pillar: 'white',
  glass: 'glass',
  door: 'white',
  frame: 'roof',
};

// ── local helpers (lib.mjs is read-only) ─────────────────────────────────────

/** KT8 front cap plan arc: flat face, strongly rounded corners. */
function kt8Arc({ zStart, depth, pull = 0, xs = 1, n = 16 }) {
  const shape = [
    [-1.0, 0], [-1.0, 0.3], [-0.95, 0.58], [-0.86, 0.8], [-0.7, 0.92],
    [-0.45, 0.98], [0, 1],
    [0.45, 0.98], [0.7, 0.92], [0.86, 0.8], [0.95, 0.58], [1.0, 0.3], [1.0, 0],
  ];
  return resamplePolyline(
    shape.map(([u, t]) => [u * HW * xs, zStart + pull - depth * t]),
    n,
  );
}

/** Ribbon between two lifted arcs with a per-quad material chosen by |x|. */
function ribbonMats(mb, low, high, matFn) {
  for (let i = 0; i < low.length - 1; i++) {
    const xMid = (low[i][0] + low[i + 1][0] + high[i][0] + high[i + 1][0]) / 4;
    mb.quad(matFn(Math.abs(xMid)), low[i], high[i], high[i + 1], low[i + 1]);
  }
}

/** Black semi-pantograph; dir = z direction the elbow (knee) points. */
function semiPant(mb, { z, yRoof, dir }) {
  const arm = 0.05;
  const mat = 'trim';
  mb.box('trim', { x: 0, y: yRoof + 0.06, z, w: 1.1, h: 0.12, d: 1.7 });
  const yB = yRoof + 0.12;
  const elbowZ = z + dir * 0.75;
  const headZ = z - dir * 0.55;
  const yE = yRoof + 0.3;
  const yH = yRoof + 0.36;
  for (const sx of [-1, 1]) {
    mb.beam(mat, [sx * 0.16, yB, z - dir * 0.65], [sx * 0.05, yE, elbowZ], arm);
  }
  mb.beam(mat, [0, yE, elbowZ], [0, yH, headZ], arm * 0.9);
  mb.beam(mat, [0, yB + 0.02, z - dir * 0.75], [0, yE - 0.06, elbowZ - dir * 0.12], 0.025);
  mb.box(mat, { x: 0, y: yH + 0.02, z: headZ, w: 1.8, h: 0.045, d: 0.22 });
  for (const sx of [-1, 1]) {
    mb.beam(mat, [sx * 0.88, yH, headZ - dir * 0.1], [sx * 0.72, yH - 0.1, headZ - dir * 0.28], 0.03);
  }
}

/**
 * Livery strips along non-door wall segments, both faces: white skirt below
 * the red waist band + white gap strip between the band top and window sill.
 */
function liveryStrips(mb, { side, z0, segments }) {
  let z = z0;
  for (const s of segments) {
    if (s.t !== 'door') {
      mb.rectX('white', side * HW, z, z + s.len, SKB, Y0, side);
      mb.rectX('white', side * (HW + 0.002), z, z + s.len, WAIST_TOP, SILL, side);
    }
    z += s.len;
  }
}

/** Roof-edge line-number box above the first door (classic KT8 detail). */
function sideLineBox(mb, { z }) {
  mb.box('black', { x: HW - 0.005, y: 2.62, z, w: 0.06, h: 0.26, d: 0.55 });
  mb.rectX('display', HW + 0.026, z - 0.2, z + 0.2, 2.52, 2.72, 1);
}

/** Dark filler under the articulation faces (below the wall bottom Y0). */
function jointFiller(mb, { zEnd }) {
  mb.box('black', { x: 0, y: 0.5, z: zEnd, w: W - 0.55, h: 0.46, d: 0.12 });
}

/** Cab flank: black window band with the sliding cab window, wraps the mask. */
function cabFlank(mb, { dirZ, flankLen }) {
  const zn = dirZ * (LA / 2 - NOSE);
  const z0 = Math.min(zn, zn - dirZ * flankLen);
  const z1 = Math.max(zn, zn - dirZ * flankLen);
  for (const side of [-1, 1]) {
    mb.rectX('black', side * (HW + 0.004), z0, z1, 1.6, WINTOP + 0.04, side);
    mb.rectX('glass', side * (HW + 0.008), z0 + 0.16, z1 - 0.2, 1.74, 2.42, side);
  }
}

/** Ventilation louvre on the red waist band (right side of the end sections). */
function louvre(mb, { z, sideX = 1 }) {
  mb.rectX('black', sideX * (HW + 0.004), z, z + 0.5, 0.92, 1.32, sideX);
  for (let i = 1; i < 4; i++) {
    const y = 0.92 + i * 0.1;
    mb.rectX('trim', sideX * (HW + 0.007), z + 0.03, z + 0.47, y - 0.012, y + 0.012, sideX);
  }
}

/**
 * RN2P cab mask. dirZ -1 → front of section A; +1 → rear cab of section C.
 * Band stack (bottom→top): plow, white apron (red corners), red headlight
 * band, white arc stripe (red corners), black windshield mask in a white
 * horseshoe, white fascia + roof dome.
 */
function kt8Mask(mb, { length, dirZ }) {
  const zs = -(length / 2 - NOSE); // arcs authored for the −Z end
  const A = (depth, pull = 0, xs = 1) => {
    const a = kt8Arc({ zStart: zs, depth, pull, xs });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  const base = A(NOSE);
  const wsBot = A(NOSE - 0.03, 0.02);
  const wsTop = A(NOSE - 0.12, 0.1, 0.99);
  const b8Top = A(NOSE - 0.15, 0.13, 0.97);
  const b9Top = A(NOSE - 0.23, 0.2, 0.91);
  const capXs = (HW - 0.22) / HW;
  const b10Top = A(NOSE - 0.33, 0.3, capXs);

  const whiteRedCorners = (ax) => (ax > 1.02 ? 'redClassic' : 'white');
  const bands = [
    { y0: 0.22, y1: 0.4, a0: base, a1: base, m: () => 'trim' },
    { y0: 0.4, y1: 0.72, a0: base, a1: base, m: () => 'white' },
    { y0: 0.72, y1: 0.92, a0: base, a1: base, m: whiteRedCorners },
    { y0: 0.92, y1: 1.3, a0: base, a1: base, m: () => 'redClassic' },
    { y0: 1.3, y1: 1.56, a0: base, a1: base, m: whiteRedCorners },
    { y0: 1.56, y1: 1.66, a0: base, a1: wsBot, m: (ax) => (ax < 1.04 ? 'black' : 'white') },
    {
      y0: 1.66, y1: 2.46, a0: wsBot, a1: wsTop,
      m: (ax) => (ax < 0.95 ? 'glass' : ax < 1.08 ? 'black' : 'white'),
    },
    { y0: 2.46, y1: 2.62, a0: wsTop, a1: b8Top, m: (ax) => (ax < 1.04 ? 'black' : 'white') },
    { y0: 2.62, y1: YTOP, a0: b8Top, a1: b9Top, m: () => 'white' },
    { y0: YTOP, y1: ROOFTOP, a0: b9Top, a1: b10Top, m: () => 'white' },
  ];
  for (const b of bands) {
    ribbonMats(mb, arcAt(b.a0, b.y0), arcAt(b.a1, b.y1), b.m);
  }

  // top cap: close the roof dome back to the wall-start line
  const zn = dirZ * (length / 2 - NOSE);
  const topArc = arcAt(b10Top, ROOFTOP);
  const sgn = Math.sign(topArc[topArc.length - 1][0]) || 1;
  mb.fan('white', [
    ...topArc,
    [sgn * (HW - 0.22), ROOFTOP, zn],
    [-sgn * (HW - 0.22), ROOFTOP, zn],
  ], [0, 1, 0]);
  // bottom cap: close the underside of the cap
  const botArc = arcAt(base, 0.22);
  mb.fan('trim', [...botArc, [sgn * HW, 0.22, zn], [-sgn * HW, 0.22, zn]], [0, -1, 0]);

  // headlights (front) / taillights (rear cab), small companion lamps inboard
  const lampZ = (x) => arcZAtX(base, x) + dirZ * 0.02;
  for (const sx of [-1, 1]) {
    roundLamp(mb, {
      x: sx * 0.7, y: 1.11, zFace: lampZ(sx * 0.7),
      r: dirZ < 0 ? 0.115 : 0.105,
      mat: dirZ < 0 ? 'headlight' : 'taillight',
      dir: dirZ,
    });
    roundLamp(mb, {
      x: sx * 0.44, y: 1.11, zFace: lampZ(sx * 0.44), r: 0.055,
      mat: dirZ < 0 ? 'taillight' : 'headlight',
      dir: dirZ,
    });
    // orange corner blinkers on the corner rounding
    mb.box('brass', {
      x: sx * 1.09, y: 1.11, z: arcZAtX(base, sx * 1.09) + dirZ * 0.02,
      w: 0.09, h: 0.16, d: 0.06,
    });
  }

  // destination display: green-lit strip at the top of the windshield
  destinationDisplay(mb, {
    zFace: arcZAtX(b8Top, 0) + dirZ * 0.045, y: 2.54, w: 1.25, h: 0.14, dir: dirZ,
  });

  // windshield wiper
  const wz = (x, y01) => arcZAtX(y01 > 0.5 ? wsTop : wsBot, x) + dirZ * 0.045;
  mb.beam('black', [0.32, 1.7, wz(0.32, 0)], [-0.18, 2.36, wz(-0.18, 1)], 0.022);

  // center plow blade under the coupler
  mb.box('trim', {
    x: 0, y: 0.16, z: arcZAtX(base, 0) - dirZ * 0.04,
    w: 1.35, h: 0.14, d: 0.07,
  });
  coupler(mb, { zEnd: dirZ * (length / 2), dir: dirZ });
}

// ── sections ─────────────────────────────────────────────────────────────────

function endItems(dirZ) {
  // cab flank + door + 3 windows + door + tail panel (mirrored for section C)
  const items = [
    seg('panel', 1.35),
    seg('door', 1.3),
    { t: 'run', weight: 1 },
    seg('door', 1.3),
    seg('panel', 0.25),
  ];
  return dirZ < 0 ? items : items.reverse();
}

function buildEnd(dirZ) {
  const mb = new MeshBuilder();
  const items = endItems(dirZ);
  const shellCfg = {
    length: LA, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: dirZ < 0 ? 'cab' : 'joint',
    rear: dirZ < 0 ? 'bellows' : 'cab',
    noseDepthF: dirZ < 0 ? NOSE : 0,
    noseDepthR: dirZ < 0 ? 0 : NOSE,
    rightItems: items,
    leftItems: items,
    mats: MATS,
    roofMat: 'white',
    bogies: dirZ < 0 ? [-3.25, 2.95] : [-2.95, 3.25],
    doorLowY: DOOR_LOW,
    winOpts: WIN,
    ventY: VENT_Y,
  };
  const { z0, z1 } = buildSectionShell(mb, shellCfg);
  const segments = wallSegs(z1 - z0, items, WIN);
  for (const side of [-1, 1]) liveryStrips(mb, { side, z0, segments });

  kt8Mask(mb, { length: LA, dirZ });
  cabFlank(mb, { dirZ, flankLen: 1.3 });
  louvre(mb, { z: dirZ < 0 ? -1.55 : 1.05, sideX: 1 });
  sideLineBox(mb, { z: dirZ * 2.5 });
  jointFiller(mb, { zEnd: dirZ * -1 * (LA / 2 - 0.07) });

  // roof: black semi-pantograph near the cab end + long dark resistor boxes
  semiPant(mb, { z: dirZ * 2.4, yRoof: ROOFTOP, dir: dirZ });
  mb.box('trim', { x: 0, y: ROOFTOP + 0.08, z: -dirZ * 1.9, w: 0.95, h: 0.16, d: 3.1 });
  mb.box('roof', { x: 0.62, y: ROOFTOP + 0.05, z: -dirZ * 1.6, w: 0.28, h: 0.1, d: 2.2 });
  roofPod(mb, { z: -dirZ * 3.9, y: ROOFTOP, w: 1.15, h: 0.16, d: 1.0, mat: 'roof' });
  return mb;
}

const buildA = () => buildEnd(-1);
const buildC = () => buildEnd(1);

function buildB() {
  const mb = new MeshBuilder();
  const items = [
    { t: 'run', weight: 1 },
    seg('door', 1.3),
    { t: 'run', weight: 3.2 },
    seg('door', 1.3),
    { t: 'run', weight: 1 },
  ];
  const { z0, z1 } = buildSectionShell(mb, {
    length: LB, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'bellows',
    rightItems: items,
    leftItems: items,
    mats: MATS,
    roofMat: 'white',
    bogies: [], // suspended low-floor middle rides on the articulations
    doorLowY: DOOR_LOW,
    winOpts: WIN,
    ventY: VENT_Y,
  });
  const segments = wallSegs(z1 - z0, items, WIN);
  for (const side of [-1, 1]) liveryStrips(mb, { side, z0, segments });
  jointFiller(mb, { zEnd: -(LB / 2 - 0.07) });
  jointFiller(mb, { zEnd: LB / 2 - 0.34 });

  roofPod(mb, { z: -1.6, y: ROOFTOP, w: 1.3, h: 0.18, d: 1.7, mat: 'roof' });
  roofPod(mb, { z: 1.6, y: ROOFTOP, w: 1.3, h: 0.18, d: 1.7, mat: 'roof' });
  mb.box('roof', { x: 0, y: ROOFTOP + 0.05, z: 0, w: 0.4, h: 0.1, d: 1.2 });
  return mb;
}

export function sections() {
  return [
    { key: 'kt8d5-a', build: buildA, expect: { length: LA, width: W } },
    { key: 'kt8d5-b', build: buildB, expect: { length: LB, width: W } },
    { key: 'kt8d5-c', build: buildC, expect: { length: LA, width: W } },
  ];
}
