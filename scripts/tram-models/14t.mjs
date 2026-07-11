// Škoda 14T "Elektra" (Porsche Design) — 5 sections, 30.25 m. Angular wedge
// nose, sharply raked windshield, trapezoid headlights, silver body with red
// front chin + red doors. Sections a/c/e long (bogies), b/d short (suspended).

import {
  MeshBuilder, arcZAtX, buildSectionShell, destinationDisplay, mirrorArcZ,
  noseBands, roofPod, singleArmPantograph, skirtBoxes, wedgeArc,
} from './lib.mjs';

const W = 2.46;
const HW = W / 2;
const LLONG = 6.95;
const LSHORT = 4.35;
const Y0 = 0.38;
const SILL = 1.72;
const WINTOP = 2.62;
const YTOP = 2.85;
const ROOFTOP = 3.12;
const NOSE = 1.35;

const MATS = {
  lower: 'silver',
  upper: 'silver',
  pillar: 'trim',
  glass: 'glass',
  door: 'redClassic',
  frame: 'silver',
};
const WIN = { targetWin: 1.45, pillar: 0.14 };

/** Porsche wedge mask. dirZ -1 → nose of a, +1 → tail of e. */
function wedgeMask(mb, { dirZ }) {
  const zStartAbs = LLONG / 2 - NOSE;
  const rake = dirZ < 0 ? 1 : 0.55; // tail is less raked than the nose
  const arc = (depth, frontW = 1.0, n = 14) => {
    const a = wedgeArc({ hw: HW, zStart: -zStartAbs, depth, frontW, n });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  const arcs = {
    chinLo: arc(1.24),
    chinHi: arc(1.3),
    maskLo: arc(1.32),
    maskHi: arc(NOSE),
    glassHi: arc(NOSE - 0.63 * rake, 1.3), // strong windshield rake
    fasciaHi: arc(NOSE - 0.75 * rake, 1.4),
  };
  noseBands(mb, {
    bands: [
      { y0: Y0, y1: 0.58, mat: 'trim', arc0: arcs.chinLo, arc1: arcs.chinHi },
      { y0: 0.58, y1: 1.16, mat: 'redClassic', arc0: arcs.chinHi, arc1: arcs.maskLo },
      { y0: 1.16, y1: 1.62, mat: 'silver', arc0: arcs.maskLo, arc1: arcs.maskHi },
      { y0: 1.62, y1: WINTOP, mat: 'glass', arc0: arcs.maskHi, arc1: arcs.glassHi },
      { y0: WINTOP, y1: YTOP, mat: 'silver', arc0: arcs.glassHi, arc1: arcs.fasciaHi },
    ],
    capMat: 'roof',
    capCorners: [],
  });
  // trapezoid lamps low on the cheek panels
  const lampArc = arc(1.33);
  for (const sx of [-1, 1]) {
    mb.box(dirZ < 0 ? 'headlight' : 'taillight', {
      x: sx * 0.6,
      y: 0.86,
      z: arcZAtX(lampArc, sx * 0.6) + dirZ * 0.02,
      w: 0.3,
      h: 0.12,
      d: 0.08,
    });
  }
  if (dirZ < 0) {
    destinationDisplay(mb, { zFace: arcZAtX(arcs.fasciaHi, 0) - 0.05, y: 2.72, w: 0.9, h: 0.2 });
  }
}

function long({ cab, tail, pantograph }) {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LLONG, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: cab ? 'cab' : 'joint',
    rear: tail ? 'cab' : 'bellows',
    noseDepthF: cab ? NOSE : 0,
    noseDepthR: tail ? NOSE : 0,
    rightItems: cab
      ? [{ t: 'door', len: 1.3 }, { t: 'run' }]
      : tail
        ? [{ t: 'run' }, { t: 'door', len: 1.3 }]
        : [{ t: 'run', weight: 2.6 }, { t: 'door', len: 1.3 }, { t: 'run', weight: 2.7 }],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies: [cab ? -0.6 : tail ? 0.6 : 0],
    winOpts: WIN,
  });
  if (cab) wedgeMask(mb, { dirZ: -1 });
  if (tail) wedgeMask(mb, { dirZ: 1 });
  roofPod(mb, { z: cab ? 1.4 : tail ? -1.4 : 1.6, y: ROOFTOP, w: 1.5, h: 0.22, d: 1.9 });
  roofPod(mb, { z: cab ? 2.8 : tail ? -2.8 : -1.8, y: ROOFTOP, w: 1.1, h: 0.16, d: 0.8 });
  skirtBoxes(mb, { zs: cab ? [1.2, 2.4] : tail ? [-2.4, -1.2] : [-2.2, 2.2], width: W, y: 0.3 });
  // roof cabling conduits running along the section
  for (const sx of [-1, 1]) {
    mb.cylinder('roof', {
      x: sx * 0.72, y: ROOFTOP + 0.04, z: cab ? 0.6 : tail ? -0.6 : 0,
      r: 0.04, len: LLONG - 3.4, axis: 'z', seg: 8,
    });
  }
  if (pantograph) singleArmPantograph(mb, { z: -0.6, yRoof: ROOFTOP });
  return mb;
}

function short() {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LSHORT, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'bellows',
    rightItems: [{ t: 'run', weight: 1 }, { t: 'door', len: 1.3 }, { t: 'run', weight: 1 }],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies: [], // suspended between neighbors
    winOpts: { targetWin: 1.2, pillar: 0.14 },
  });
  roofPod(mb, { z: 0.3, y: ROOFTOP, w: 1.3, h: 0.18, d: 1.4 });
  roofPod(mb, { z: -1.1, y: ROOFTOP, w: 1.0, h: 0.14, d: 0.7 });
  skirtBoxes(mb, { zs: [-0.9, 0.9], width: W, y: 0.3 });
  return mb;
}

export function sections() {
  const eLong = { length: LLONG, width: W };
  const eShort = { length: LSHORT, width: W };
  return [
    { key: '14t-a', build: () => long({ cab: true }), expect: eLong },
    { key: '14t-b', build: short, expect: eShort },
    { key: '14t-c', build: () => long({ pantograph: true }), expect: eLong },
    { key: '14t-d', build: short, expect: eShort },
    { key: '14t-e', build: () => long({ tail: true }), expect: eLong },
  ];
}
