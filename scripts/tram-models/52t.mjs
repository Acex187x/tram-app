// Škoda 52T "ForCity Plus Praha" — 5 sections, ~32 m, newest fleet flagship.
// New PID livery: light grey body, black window band, dark-red vertical door
// bays wrapping above the windows, dark-red front with a black windshield
// dome, thin LED strip headlights. Pantographs on b and d.

import {
  MeshBuilder, arcZAtX, buildSectionShell, destinationDisplay, mirrorArcZ,
  noseArc, noseBands, roofPod, singleArmPantograph, skirtBoxes,
} from './lib.mjs';

const W = 2.5;
const HW = W / 2;
const LEND = 6.9; // a, e
const LMIDB = 5.8; // b, d
const LMIDC = 5.6; // c
const Y0 = 0.3;
const SILL = 1.6;
const WINTOP = 2.62;
const YTOP = 2.88;
const ROOFTOP = 3.14;
const NOSE = 1.25;

const MATS = {
  lower: 'greyLight',
  upper: 'greyLight',
  pillar: 'black', // continuous black window band
  glass: 'glass',
  door: 'redDark',
  frame: 'greyLight',
};
const WIN = { targetWin: 1.5, pillar: 0.14 };
// dark-red door bays wrap over the window band
const DOOR = { t: 'door', len: 1.4, topMat: 'redDark' };

/** Smooth ForCity Plus mask, flatter than the 15T. dirZ -1 nose / +1 tail. */
function plusMask(mb, { length, dirZ }) {
  const zStartAbs = length / 2 - NOSE;
  const rake = dirZ < 0 ? 1 : 0.8;
  const arc = (depth, p = 1.05, n = 14) => {
    const a = noseArc({ hw: HW, zStart: -zStartAbs, depth, p, n });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  const arcs = {
    bumperLo: arc(1.18),
    maskLo: arc(1.22),
    ledLo: arc(NOSE),
    ledHi: arc(NOSE),
    maskHi: arc(1.24),
    glassHi: arc(NOSE - 0.5 * rake, 0.9),
    domeHi: arc(NOSE - 0.62 * rake, 0.88),
  };
  const led = dirZ < 0 ? 'headlight' : 'taillight';
  noseBands(mb, {
    bands: [
      { y0: Y0, y1: 0.52, mat: 'trim', arc0: arcs.bumperLo, arc1: arcs.maskLo },
      { y0: 0.52, y1: 1.04, mat: 'redDark', arc0: arcs.maskLo, arc1: arcs.ledLo },
      // thin LED strip across the mask
      { y0: 1.04, y1: 1.1, mat: led, arc0: arcs.ledLo, arc1: arcs.ledHi },
      { y0: 1.1, y1: 1.6, mat: 'redDark', arc0: arcs.ledHi, arc1: arcs.maskHi },
      // windshield merging into a black dome above (52T signature)
      { y0: 1.6, y1: 2.62, mat: 'glass', arc0: arcs.maskHi, arc1: arcs.glassHi },
      { y0: 2.62, y1: YTOP, mat: 'black', arc0: arcs.glassHi, arc1: arcs.domeHi },
    ],
    capMat: 'roof',
    capCorners: [],
  });
  if (dirZ < 0) {
    destinationDisplay(mb, { zFace: arcZAtX(arcs.domeHi, 0) - 0.05, y: 2.74, w: 1.0, h: 0.2 });
  }
  // dark-red center stripe below the windshield (new PID face)
  mb.box('redDark', {
    x: 0, y: 0.78, z: arcZAtX(arcs.ledLo, 0) + dirZ * 0.04, w: 0.55, h: 0.5, d: 0.1,
  });
}

/** Prominent bogie skirt cover panels (52T signature clean skirts). */
function bogieCovers(mb, { z }) {
  for (const sx of [-1, 1]) {
    mb.box('greyLight', { x: sx * (HW + 0.012), y: 0.62, z, w: 0.025, h: 0.62, d: 2.5 });
  }
}

function buildEnd({ tail }) {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: LEND, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: tail ? 'joint' : 'cab',
    rear: tail ? 'cab' : 'bellows',
    noseDepthF: tail ? 0 : NOSE,
    noseDepthR: tail ? NOSE : 0,
    rightItems: tail ? [{ t: 'run' }, { ...DOOR }] : [{ ...DOOR }, { t: 'run' }],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies: [tail ? 0.9 : -0.9],
    winOpts: WIN,
  });
  plusMask(mb, { length: LEND, dirZ: tail ? 1 : -1 });
  bogieCovers(mb, { z: tail ? 0.9 : -0.9 });
  roofPod(mb, { z: tail ? -1.6 : 1.6, y: ROOFTOP, w: 1.6, h: 0.26, d: 2.0 });
  roofPod(mb, { z: tail ? -3.1 : 3.1, y: ROOFTOP, w: 1.2, h: 0.18, d: 0.9 });
  return mb;
}

function buildMid({ length, pantograph }) {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'joint', rear: 'bellows',
    rightItems: [{ t: 'run', weight: 1 }, { ...DOOR }, { t: 'run', weight: 1 }],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies: pantograph ? [0] : [], // semi-swivel bogies under b/d, c suspended
    winOpts: WIN,
  });
  if (pantograph) {
    singleArmPantograph(mb, { z: 0, yRoof: ROOFTOP });
    roofPod(mb, { z: length / 2 - 1.5, y: ROOFTOP, w: 1.3, h: 0.2, d: 1.2 });
    bogieCovers(mb, { z: 0 });
  } else {
    roofPod(mb, { z: 0, y: ROOFTOP, w: 1.6, h: 0.26, d: 2.2 });
    skirtBoxes(mb, { zs: [-1.4, 1.4], width: W, y: 0.24 });
  }
  return mb;
}

export function sections() {
  const eEnd = { length: LEND, width: W };
  return [
    { key: '52t-a', build: () => buildEnd({ tail: false }), expect: eEnd },
    { key: '52t-b', build: () => buildMid({ length: LMIDB, pantograph: true }), expect: { length: LMIDB, width: W } },
    { key: '52t-c', build: () => buildMid({ length: LMIDC }), expect: { length: LMIDC, width: W } },
    { key: '52t-d', build: () => buildMid({ length: LMIDB, pantograph: true }), expect: { length: LMIDB, width: W } },
    { key: '52t-e', build: () => buildEnd({ tail: true }), expect: eEnd },
  ];
}
