// Tatra KT8D5.RN2P — 3 sections (30.3 m × 2.48 m, body height 3.145 m), boxy
// 1980s three-section bidirectional tram, RN2P modernization.
//
// ACCURACY ROUND 2 — rebuilt against photo references (Wikimedia Commons:
// 9053, 9059, 9060, 9062 door closeup, 9067, 9076, 9079, 9081):
//   * livery stack, identical on sides AND face, wrapping the nose:
//       0.34–0.66 white skirt | 0.66–1.56 red band | 1.56–1.66 white stripe |
//       1.66–2.76 ANTHRACITE window band | 2.76+ white roofline/dome
//   * face: the whole window-band zone is a glossy BLACK mask — raked
//     two-pane windshield with a center divider, green-LED destination
//     display embedded at the mask TOP, mask wraps the corners into the
//     black cab flank with its tall sliding window
//   * red band: big round headlight (outer) + small round lamp (inner) per
//     side, vertical rectangular blinker/tail stacks on the corner rounding
//   * silver bumper beam wrapping the face, dark plow + coupler beneath
//   * grey door leaves with tall glass (drops below the side-window sill),
//     dark frames; first door reads as part of the dark band
//   * roof: white; flat dark slab over each cab, semi-pantograph with YELLOW
//     base + lower arms near the cab ends of A and C, long dark resistor
//     boxes toward the articulation; suspended low-floor middle section.

import {
  MATERIALS, MeshBuilder, arcAt, arcZAtX, buildSectionShell, coupler,
  mirrorArcZ, resamplePolyline, roofPod, roundLamp, seg, wallSegs,
} from './lib.mjs';

// ── local palette (kt8-namespaced; sampled from the reference photos) ────────
MATERIALS.kt8Red = { hex: 0xcc2a2f, rough: 0.45, metal: 0.08 }; // DPP red
MATERIALS.kt8Grey = { hex: 0x43474b, rough: 0.52, metal: 0.08 }; // window band
MATERIALS.kt8White = { hex: 0xf5f6f4, rough: 0.45, metal: 0.05 }; // body white
MATERIALS.kt8Green = { // green LED destination / line-number displays
  hex: 0x0e1510, rough: 0.4, metal: 0, emissive: [0.16, 0.62, 0.18],
};

const W = 2.48;
const HW = W / 2;
const LA = 10.0; // end sections
const LB = 9.7; // suspended low-floor middle
const SKB = 0.34; // skirt bottom
const Y0 = 0.66; // wall bottom = red band bottom
const RED_TOP = 1.56; // red band top
const BAND_BOT = 1.66; // anthracite window band bottom (white stripe below)
const SILL = 1.84;
const WINTOP = 2.62;
const YTOP = 2.76; // anthracite band top = white roofline bottom
const ROOFTOP = 3.10;
const NOSE = 0.45; // plan depth of the front cap
const DOOR_LOW = 0.30;
const WIN = { targetWin: 1.28, pillar: 0.16 };
const VENT_Y = 2.38; // horizontal vent divider near the window top
const FLANK = 1.45; // black cab-flank band length behind the nose

const MATS = {
  lower: 'kt8Red',
  upper: 'kt8Grey',
  pillar: 'kt8Grey',
  glass: 'glass',
  door: 'roof', // silver-grey door leaves
  frame: 'trim',
};

// ── local helpers (lib.mjs is read-only) ─────────────────────────────────────

/** KT8 front cap plan arc: flat face, rounded corners (radius ≈ 0.3 m). */
function kt8Arc({ zStart, depth, pull = 0, xs = 1, n = 20 }) {
  const shape = [
    [-1.0, 0], [-1.0, 0.3], [-0.96, 0.56], [-0.88, 0.78], [-0.74, 0.91],
    [-0.5, 0.98], [-0.25, 1], [0, 1], [0.25, 1],
    [0.5, 0.98], [0.74, 0.91], [0.88, 0.78], [0.96, 0.56], [1.0, 0.3], [1.0, 0],
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

/** Horizontal shelf ring between an outer and inner arc at height y. */
function shelf(mb, mat, outer, inner, y, up) {
  const lo = arcAt(up ? outer : inner, y);
  const hi = arcAt(up ? inner : outer, y);
  for (let i = 0; i < lo.length - 1; i++) {
    mb.quad(mat, lo[i], hi[i], hi[i + 1], lo[i + 1]);
  }
}

/**
 * Black semi-pantograph, yellow base frame + lower arms (photo 9062).
 * dir = z direction the elbow (knee) points.
 */
function semiPant(mb, { z, yRoof, dir }) {
  const arm = 0.05;
  mb.box('brass', { x: 0, y: yRoof + 0.06, z, w: 1.1, h: 0.12, d: 1.7 });
  const yB = yRoof + 0.12;
  const elbowZ = z + dir * 0.75;
  const headZ = z - dir * 0.55;
  const yE = yRoof + 0.3;
  const yH = yRoof + 0.36;
  for (const sx of [-1, 1]) {
    mb.beam('brass', [sx * 0.16, yB, z - dir * 0.65], [sx * 0.05, yE, elbowZ], arm);
  }
  mb.beam('trim', [0, yE, elbowZ], [0, yH, headZ], arm * 0.9);
  mb.beam('trim', [0, yB + 0.02, z - dir * 0.75], [0, yE - 0.06, elbowZ - dir * 0.12], 0.025);
  mb.box('trim', { x: 0, y: yH + 0.02, z: headZ, w: 1.8, h: 0.045, d: 0.22 });
  for (const sx of [-1, 1]) {
    mb.beam('trim', [sx * 0.88, yH, headZ - dir * 0.1], [sx * 0.72, yH - 0.1, headZ - dir * 0.28], 0.03);
  }
}

/**
 * Livery overlays along the walls (both faces). Non-door segments: white
 * skirt below the wall, white stripe + anthracite under-sill strip painted
 * over the shell's red lower zone. Door segments: extend the door glass
 * below the sill (KT8 door windows drop lower than the side windows).
 */
function liveryStrips(mb, { side, z0, segments }) {
  let z = z0;
  for (const s of segments) {
    if (s.t === 'door') {
      const f = 0.05;
      mb.rectX('glass', side * (HW - 0.026), z + f + 0.09, z + s.len - f - 0.09, 1.30, SILL, side);
    } else {
      mb.rectX('kt8White', side * HW, z, z + s.len, SKB, Y0, side);
      mb.rectX('kt8White', side * (HW + 0.002), z, z + s.len, RED_TOP, BAND_BOT, side);
      mb.rectX('kt8Grey', side * (HW + 0.002), z, z + s.len, BAND_BOT, SILL, side);
    }
    z += s.len;
  }
}

/** Green-LED line-number box at the top of the anthracite band. */
function sideLineBox(mb, { z }) {
  for (const side of [-1, 1]) {
    mb.box('black', { x: side * (HW - 0.01), y: 2.56, z, w: 0.06, h: 0.22, d: 0.45 });
    mb.rectX('kt8Green', side * (HW + 0.022), z - 0.16, z + 0.16, 2.48, 2.64, side);
  }
}

/** Dark filler under the articulation faces (below the wall bottom Y0). */
function jointFiller(mb, { zEnd }) {
  mb.box('black', { x: 0, y: 0.48, z: zEnd, w: W - 0.55, h: 0.42, d: 0.12 });
}

/**
 * Black cab flank: continues the face mask around the corner — black band
 * over the full anthracite zone with the tall sliding cab window.
 */
function cabFlank(mb, { dirZ }) {
  const zn = dirZ * (LA / 2 - NOSE);
  const z0 = Math.min(zn, zn - dirZ * FLANK);
  const z1 = Math.max(zn, zn - dirZ * FLANK);
  for (const side of [-1, 1]) {
    mb.rectX('black', side * (HW + 0.004), z0, z1, BAND_BOT, YTOP, side);
    const [g0, g1] = dirZ < 0 ? [z0 + 0.10, z1 - 0.28] : [z0 + 0.28, z1 - 0.10];
    mb.rectX('glass', side * (HW + 0.008), g0, g1, 1.80, 2.52, side);
    // horizontal slider split of the cab window
    mb.rectX('black', side * (HW + 0.010), g0, g1, 2.14, 2.17, side);
  }
}

/** Ventilation louvre on the red waist band next to the cab. */
function louvre(mb, { z }) {
  for (const side of [-1, 1]) {
    mb.rectX('black', side * (HW + 0.004), z, z + 0.55, 0.94, 1.34, side);
    for (let i = 1; i < 4; i++) {
      const y = 0.94 + i * 0.1;
      mb.rectX('trim', side * (HW + 0.007), z + 0.03, z + 0.52, y - 0.012, y + 0.012, side);
    }
  }
}

/**
 * RN2P cab face. dirZ -1 → front of section A; +1 → rear cab of section C.
 * Bottom→top: plow band, white apron, red band (headlights + corner
 * blinkers), white stripe, glossy black mask (raked windshield + green
 * destination display at the top), white roof dome. Silver bumper wraps the
 * face proud of the body.
 */
function kt8Mask(mb, { length, dirZ }) {
  const zs = -(length / 2 - NOSE); // arcs authored for the −Z end
  const A = (depth, pull = 0, xs = 1) => {
    const a = kt8Arc({ zStart: zs, depth, pull, xs });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  const base = A(NOSE);
  const wsBot = A(NOSE - 0.04, 0.03); // windshield bottom (rake starts)
  const wsTop = A(NOSE - 0.20, 0.17, 0.985); // windshield top — real rake
  const dspBot = A(NOSE - 0.225, 0.19, 0.975);
  const dspTop = A(NOSE - 0.28, 0.24, 0.95);
  const mskTop = A(NOSE - 0.30, 0.26, 0.93);
  const domeXs = (HW - 0.24) / HW;
  const domeTop = A(NOSE - 0.38, 0.34, domeXs);

  const bands = [
    { y0: 0.20, y1: SKB, a0: base, a1: base, m: () => 'trim' },
    { y0: SKB, y1: Y0, a0: base, a1: base, m: () => 'kt8White' },
    { y0: Y0, y1: RED_TOP, a0: base, a1: base, m: () => 'kt8Red' },
    { y0: RED_TOP, y1: BAND_BOT, a0: base, a1: base, m: () => 'kt8White' },
    { y0: BAND_BOT, y1: 1.70, a0: base, a1: wsBot, m: () => 'black' },
    { // two-pane windshield in the black mask, wraps to slim black A-pillars
      y0: 1.70, y1: 2.46, a0: wsBot, a1: wsTop,
      m: (ax) => (ax < 1.06 ? 'glass' : 'black'),
    },
    { y0: 2.46, y1: 2.53, a0: wsTop, a1: dspBot, m: () => 'black' },
    { // destination display embedded at the mask top, green LED glow
      y0: 2.53, y1: 2.74, a0: dspBot, a1: dspTop,
      m: (ax) => (ax < 0.62 ? 'kt8Green' : 'black'),
    },
    { y0: 2.74, y1: 2.94, a0: dspTop, a1: mskTop, m: () => 'black' },
    { y0: 2.94, y1: ROOFTOP, a0: mskTop, a1: domeTop, m: () => 'kt8White' },
  ];
  for (const b of bands) {
    ribbonMats(mb, arcAt(b.a0, b.y0), arcAt(b.a1, b.y1), b.m);
  }

  // top cap: close the roof dome back to the wall-start line
  const zn = dirZ * (length / 2 - NOSE);
  const topArc = arcAt(domeTop, ROOFTOP);
  const sgn = Math.sign(topArc[topArc.length - 1][0]) || 1;
  mb.fan('kt8White', [
    ...topArc,
    [sgn * (HW - 0.24), ROOFTOP, zn],
    [-sgn * (HW - 0.24), ROOFTOP, zn],
  ], [0, 1, 0]);
  // bottom cap: close the underside of the cap
  const botArc = arcAt(base, 0.20);
  mb.fan('trim', [...botArc, [sgn * HW, 0.20, zn], [-sgn * HW, 0.20, zn]], [0, -1, 0]);

  // ── silver bumper beam, proud of the face, wrapping the corners ──
  const bump = A(NOSE, -0.04);
  ribbonMats(mb, arcAt(bump, 0.32), arcAt(bump, 0.48), () => 'roof');
  shelf(mb, 'roof', bump, base, 0.48, true);
  shelf(mb, 'roof', bump, base, 0.32, false);
  // dark rubber rubbing strip across the bumper
  const bumpStrip = A(NOSE, -0.048);
  ribbonMats(mb, arcAt(bumpStrip, 0.375), arcAt(bumpStrip, 0.425), () => 'trim');

  // ── lights on the red band: big outer + small inner round lamps ──
  const lampZ = (x) => arcZAtX(base, x) + dirZ * 0.02;
  for (const sx of [-1, 1]) {
    roundLamp(mb, {
      x: sx * 0.72, y: 1.12, zFace: lampZ(sx * 0.72), r: 0.11,
      mat: dirZ < 0 ? 'headlight' : 'taillight', dir: dirZ,
    });
    roundLamp(mb, {
      x: sx * 0.50, y: 1.12, zFace: lampZ(sx * 0.50), r: 0.055,
      mat: 'headlight', dir: dirZ,
    });
    // vertical blinker/tail stack on the corner rounding
    const cz = arcZAtX(base, sx * 1.06);
    mb.box('trim', { x: sx * 1.06, y: 1.14, z: cz + dirZ * 0.005, w: 0.13, h: 0.5, d: 0.08 });
    mb.box('brass', { x: sx * 1.06, y: 1.26, z: cz - dirZ * 0.038, w: 0.10, h: 0.18, d: 0.015 });
    mb.box('taillight', { x: sx * 1.06, y: 1.02, z: cz - dirZ * 0.038, w: 0.10, h: 0.18, d: 0.015 });
  }

  // windshield center divider + two wipers (beams following the glass rake)
  const wz = (x, y01) => arcZAtX(y01 > 0.5 ? wsTop : wsBot, x) + dirZ * 0.03;
  mb.beam('black', [0, 1.70, wz(0, 0)], [0, 2.46, wz(0, 1)], 0.04);
  for (const sx of [-1, 1]) {
    mb.beam('black', [sx * 0.62, 1.75, wz(sx * 0.62, 0)], [sx * 0.12, 2.38, wz(sx * 0.12, 1)], 0.022);
  }

  // rear-view mirrors on stalks beside the A-pillars
  for (const sx of [-1, 1]) {
    const mz = zs + 0.16;
    const zApplied = dirZ > 0 ? -mz : mz;
    mb.beam('trim', [sx * (HW - 0.02), 2.42, zApplied], [sx * (HW + 0.05), 2.32, zApplied - dirZ * 0.06], 0.022);
    mb.box('trim', { x: sx * (HW + 0.055), y: 2.24, z: zApplied - dirZ * 0.06, w: 0.035, h: 0.20, d: 0.15 });
  }

  // center plow blade + coupler under the bumper
  mb.box('trim', {
    x: 0, y: 0.16, z: arcZAtX(base, 0) - dirZ * 0.02,
    w: 1.35, h: 0.13, d: 0.07,
  });
  coupler(mb, { zEnd: dirZ * (length / 2), dir: dirZ });
}

// ── sections ─────────────────────────────────────────────────────────────────

function endItems(dirZ) {
  // cab flank + door + 3 windows + door + short tail panel (mirrored for C)
  const items = [
    seg('panel', FLANK),
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
  const { z0, z1 } = buildSectionShell(mb, {
    length: LA, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: dirZ < 0 ? 'cab' : 'joint',
    rear: dirZ < 0 ? 'bellows' : 'cab',
    noseDepthF: dirZ < 0 ? NOSE : 0,
    noseDepthR: dirZ < 0 ? 0 : NOSE,
    rightItems: items,
    leftItems: items,
    mats: MATS,
    roofMat: 'kt8White',
    bogies: dirZ < 0 ? [-3.25, 2.95] : [-2.95, 3.25],
    doorLowY: DOOR_LOW,
    winOpts: WIN,
    ventY: VENT_Y,
  });
  const segments = wallSegs(z1 - z0, items, WIN);
  for (const side of [-1, 1]) liveryStrips(mb, { side, z0, segments });

  kt8Mask(mb, { length: LA, dirZ });
  cabFlank(mb, { dirZ });
  louvre(mb, { z: dirZ < 0 ? -1.45 : 0.9 });
  sideLineBox(mb, { z: dirZ * 2.35 });
  jointFiller(mb, { zEnd: dirZ * -1 * (LA / 2 - 0.07) });

  // roof: flat dark slab over the cab, yellow-based semi-pantograph behind
  // it, long dark resistor boxes toward the articulation end
  mb.box('trim', {
    x: 0, y: ROOFTOP + 0.045, z: dirZ * (LA / 2 - NOSE - 0.85),
    w: 1.9, h: 0.09, d: 1.3,
  });
  semiPant(mb, { z: dirZ * 2.35, yRoof: ROOFTOP, dir: dirZ });
  mb.box('trim', { x: 0.32, y: ROOFTOP + 0.075, z: -dirZ * 1.7, w: 0.8, h: 0.15, d: 2.9 });
  mb.box('roof', { x: -0.55, y: ROOFTOP + 0.05, z: -dirZ * 1.5, w: 0.3, h: 0.1, d: 2.1 });
  roofPod(mb, { z: -dirZ * 3.9, y: ROOFTOP, w: 1.15, h: 0.15, d: 1.0, mat: 'roof' });
  return mb;
}

const buildA = () => buildEnd(-1);
const buildC = () => buildEnd(1);

function buildB() {
  const mb = new MeshBuilder();
  const items = [
    seg('panel', 0.45),
    seg('door', 1.3),
    { t: 'run', weight: 1 },
    seg('door', 1.3),
    seg('panel', 0.45),
  ];
  const { z0, z1 } = buildSectionShell(mb, {
    length: LB, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'bellows',
    rightItems: items,
    leftItems: items,
    mats: MATS,
    roofMat: 'kt8White',
    bogies: [], // suspended low-floor middle rides on the articulations
    doorLowY: DOOR_LOW,
    winOpts: WIN,
    ventY: VENT_Y,
  });
  const segments = wallSegs(z1 - z0, items, WIN);
  for (const side of [-1, 1]) liveryStrips(mb, { side, z0, segments });
  jointFiller(mb, { zEnd: -(LB / 2 - 0.07) });
  jointFiller(mb, { zEnd: LB / 2 - 0.34 });

  mb.box('trim', { x: 0, y: ROOFTOP + 0.075, z: -1.5, w: 0.85, h: 0.15, d: 2.2 });
  roofPod(mb, { z: 1.6, y: ROOFTOP, w: 1.25, h: 0.16, d: 1.7, mat: 'roof' });
  mb.box('roof', { x: 0, y: ROOFTOP + 0.05, z: 0.1, w: 0.4, h: 0.1, d: 1.2 });
  return mb;
}

export function sections() {
  return [
    { key: 'kt8d5-a', build: buildA, expect: { length: LA, width: W } },
    { key: 'kt8d5-b', build: buildB, expect: { length: LB, width: W } },
    { key: 'kt8d5-c', build: buildC, expect: { length: LA, width: W } },
  ];
}
