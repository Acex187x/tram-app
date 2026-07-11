// Tatra KT8D5.RN2P — 3 sections (~30.3 m), boxy 1980s body, modernized
// semicircular nose with a cream stripe wrapping the windshield, classic
// red/cream livery, low-floor middle section, semi-pantographs on a and c.

import {
  MeshBuilder, arcZAtX, buildSectionShell, coupler, destinationDisplay,
  mirrorArcZ, noseBands, resamplePolyline, roofPod, roofRibs, roundLamp,
  singleArmPantograph, skirtBoxes,
} from './lib.mjs';

const W = 2.48;
const HW = W / 2;
const LA = 10.0; // end sections
const LB = 9.7; // suspended middle
const Y0 = 0.35;
const SILL = 1.7;
const WINTOP = 2.55;
const YTOP = 2.78;
const ROOFTOP = 3.06;
const NOSE = 1.0;

const MATS = {
  lower: 'redClassic',
  upper: 'cream',
  pillar: 'cream',
  glass: 'glass',
  door: 'cream',
  frame: 'cream',
};

/** Blunt rounded-rectangle plan arc (boxy KT8 mask). */
function kt8Arc(zStart, depth, n = 14) {
  const d = depth;
  return resamplePolyline(
    [
      [-HW, zStart],
      [-HW + 0.02, zStart - d * 0.5],
      [-HW + 0.16, zStart - d * 0.85],
      [-0.62, zStart - d * 0.98],
      [0, zStart - d],
      [0.62, zStart - d * 0.98],
      [HW - 0.16, zStart - d * 0.85],
      [HW - 0.02, zStart - d * 0.5],
      [HW, zStart],
    ],
    n,
  );
}

/** Modernized RN2P cab mask. dirZ -1 front of section a, +1 rear of c. */
function kt8Mask(mb, { length, dirZ }) {
  const zStartAbs = length / 2 - NOSE;
  const arc = (depth, n = 14) => {
    const a = kt8Arc(-zStartAbs, depth, n);
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  const arcs = {
    bumperLo: arc(0.94),
    beltLo: arc(0.97),
    beltHi: arc(NOSE),
    stripeHi: arc(NOSE), // cream stripe below windshield
    glassHi: arc(0.88),
    stripe2Hi: arc(0.82),
    fasciaHi: arc(0.78),
  };
  noseBands(mb, {
    bands: [
      { y0: Y0, y1: 0.6, mat: 'trim', arc0: arcs.bumperLo, arc1: arcs.beltLo },
      { y0: 0.6, y1: 1.5, mat: 'redClassic', arc0: arcs.beltLo, arc1: arcs.beltHi },
      { y0: 1.5, y1: 1.72, mat: 'cream', arc0: arcs.beltHi, arc1: arcs.stripeHi },
      { y0: 1.72, y1: 2.42, mat: 'glass', arc0: arcs.stripeHi, arc1: arcs.glassHi },
      { y0: 2.42, y1: 2.6, mat: 'cream', arc0: arcs.glassHi, arc1: arcs.stripe2Hi },
      { y0: 2.6, y1: YTOP, mat: 'redClassic', arc0: arcs.stripe2Hi, arc1: arcs.fasciaHi },
    ],
    capMat: 'roof',
    capCorners: [],
  });
  const lampArc = arc(0.98);
  for (const sx of [-1, 1]) {
    roundLamp(mb, {
      x: sx * 0.74,
      y: 1.05,
      zFace: arcZAtX(lampArc, sx * 0.74) + dirZ * 0.04,
      r: dirZ < 0 ? 0.12 : 0.09,
      mat: dirZ < 0 ? 'headlight' : 'taillight',
      dir: dirZ,
    });
  }
  destinationDisplay(mb, { zFace: arcZAtX(arcs.fasciaHi, 0) + dirZ * 0.05, y: 2.62, dir: dirZ });
  coupler(mb, { zEnd: dirZ * (length / 2), dir: dirZ });
}

function buildA() {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LA, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'cab', rear: 'bellows', noseDepthF: NOSE,
    rightItems: [
      { t: 'door', len: 1.3 },
      { t: 'run', weight: 2.6 },
      { t: 'door', len: 1.3 },
      { t: 'run', weight: 3.8 },
    ],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies: [-2.6, 3.2],
    winOpts: { targetWin: 1.25, pillar: 0.16 },
    ventY: 2.2,
  });
  kt8Mask(mb, { length: LA, dirZ: -1 });
  roofRibs(mb, { z0: -3.4, z1: 4.4, xw: W / 2, y: ROOFTOP, count: 8 });
  roofPod(mb, { z: 0.4, y: ROOFTOP, w: 1.4, h: 0.22, d: 1.8 });
  skirtBoxes(mb, { zs: [-0.2, 1.2], width: W });
  singleArmPantograph(mb, { z: 3.2, yRoof: ROOFTOP });
  return mb;
}

function buildB() {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LB, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'bellows',
    rightItems: [
      { t: 'run', weight: 1.6 },
      { t: 'door', len: 1.3, lowY: 0.24 },
      { t: 'run', weight: 2.5 },
      { t: 'door', len: 1.3, lowY: 0.24 },
      { t: 'run', weight: 1.6 },
    ],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies: [], // suspended low-floor middle rides on the articulations
    winOpts: { targetWin: 1.25, pillar: 0.16 },
    ventY: 2.2,
  });
  roofRibs(mb, { z0: -4.4, z1: 4.4, xw: W / 2, y: ROOFTOP, count: 9 });
  roofPod(mb, { z: 0, y: ROOFTOP, w: 1.5, h: 0.24, d: 2.2 });
  skirtBoxes(mb, { zs: [-3.4, 3.4], width: W });
  return mb;
}

function buildC() {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LA, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'cab', noseDepthR: NOSE,
    rightItems: [
      { t: 'run', weight: 3.8 },
      { t: 'door', len: 1.3 },
      { t: 'run', weight: 2.6 },
      { t: 'door', len: 1.3 },
    ],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies: [-3.2, 2.6],
    winOpts: { targetWin: 1.25, pillar: 0.16 },
    ventY: 2.2,
  });
  kt8Mask(mb, { length: LA, dirZ: 1 });
  roofRibs(mb, { z0: -4.4, z1: 3.4, xw: W / 2, y: ROOFTOP, count: 8 });
  roofPod(mb, { z: -0.4, y: ROOFTOP, w: 1.4, h: 0.22, d: 1.8 });
  skirtBoxes(mb, { zs: [-1.2, 0.2], width: W });
  singleArmPantograph(mb, { z: -3.2, yRoof: ROOFTOP });
  return mb;
}

export function sections() {
  return [
    { key: 'kt8d5-a', build: buildA, expect: { length: LA, width: W } },
    { key: 'kt8d5-b', build: buildB, expect: { length: LB, width: W } },
    { key: 'kt8d5-c', build: buildC, expect: { length: LA, width: W } },
  ];
}
