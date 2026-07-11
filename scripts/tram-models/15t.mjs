// Škoda 15T "ForCity Alfa" — 3 sections, 31.4 m, the iconic modern Prague
// tram. Bulbous rounded nose, wraparound windshield (faceted), swept eyebrow
// headlights, red band along the windows over a white body, roof AC pods.

import {
  MeshBuilder, arcZAtX, buildSectionShell, destinationDisplay, mirrorArcZ,
  noseArc, noseBands, roofPod, singleArmPantograph, skirtBoxes,
} from './lib.mjs';

const W = 2.46;
const HW = W / 2;
const L = 10.3;
const Y0 = 0.32;
const SILL = 1.55;
const WINTOP = 2.6;
const YTOP = 2.85;
const ROOFTOP = 3.1;
const NOSE = 1.7;

const MATS = {
  lower: 'white',
  upper: 'redClassic',
  pillar: 'redClassic',
  glass: 'glass',
  door: 'redClassic',
  frame: 'white',
};
const WIN = { targetWin: 1.5, pillar: 0.16 };

/** Bulbous ForCity mask. dirZ -1 → nose of a, +1 → tail of c. */
function alfaMask(mb, { dirZ }) {
  const zStartAbs = L / 2 - NOSE;
  const rake = dirZ < 0 ? 1 : 0.75;
  const arc = (depth, p = 0.85, n = 16) => {
    const a = noseArc({ hw: HW, zStart: -zStartAbs, depth, p, n });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  const arcs = {
    bumperLo: arc(1.6),
    maskLo: arc(1.65),
    maskHi: arc(NOSE),
    glassMid: arc(NOSE - 0.12 * rake, 0.82),
    glassHi: arc(NOSE - 0.5 * rake, 0.8),
    fasciaHi: arc(NOSE - 0.66 * rake, 0.78),
  };
  noseBands(mb, {
    bands: [
      { y0: Y0, y1: 0.52, mat: 'trim', arc0: arcs.bumperLo, arc1: arcs.maskLo },
      { y0: 0.52, y1: 1.5, mat: 'redClassic', arc0: arcs.maskLo, arc1: arcs.maskHi },
      // wraparound windshield in two facet rows (approximated curvature)
      { y0: 1.5, y1: 2.12, mat: 'glass', arc0: arcs.maskHi, arc1: arcs.glassMid },
      { y0: 2.12, y1: WINTOP, mat: 'glass', arc0: arcs.glassMid, arc1: arcs.glassHi },
      { y0: WINTOP, y1: YTOP, mat: 'redClassic', arc0: arcs.glassHi, arc1: arcs.fasciaHi },
    ],
    capMat: 'roof',
    capCorners: [],
  });
  // swept "eyebrow" light clusters hugging the mask cheeks
  const browArc = arc(1.68);
  const mat = dirZ < 0 ? 'headlight' : 'taillight';
  for (const sx of [-1, 1]) {
    const zIn = arcZAtX(browArc, sx * 0.3) + dirZ * 0.03;
    const zMid = arcZAtX(browArc, sx * 0.78) + dirZ * 0.03;
    const zOut = arcZAtX(browArc, sx * 1.05) + dirZ * 0.05;
    mb.beam(mat, [sx * 0.3, 1.38, zIn], [sx * 0.78, 1.44, zMid], 0.1, 0.08);
    mb.beam(mat, [sx * 0.78, 1.44, zMid], [sx * 1.05, 1.54, zOut], 0.08, 0.07);
  }
  if (dirZ < 0) {
    destinationDisplay(mb, { zFace: arcZAtX(arcs.fasciaHi, 0) - 0.05, y: 2.7, w: 1.0, h: 0.22 });
  }
}

function build({ cab, tail, pantograph }) {
  const mb = new MeshBuilder();
  buildSectionShell(mb, {
    length: L, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: cab ? 'cab' : 'joint',
    rear: tail ? 'cab' : 'bellows',
    noseDepthF: cab ? NOSE : 0,
    noseDepthR: tail ? NOSE : 0,
    rightItems: cab
      ? [
          { t: 'door', len: 1.4 },
          { t: 'run', weight: 2.2 },
          { t: 'door', len: 1.4 },
          { t: 'run', weight: 3.3 },
        ]
      : tail
        ? [
            { t: 'run', weight: 3.3 },
            { t: 'door', len: 1.4 },
            { t: 'run', weight: 2.2 },
            { t: 'door', len: 1.4 },
          ]
        : [
            { t: 'run', weight: 1.6 },
            { t: 'door', len: 1.4 },
            { t: 'run', weight: 3.5 },
            { t: 'door', len: 1.4 },
            { t: 'run', weight: 2.0 },
          ],
    leftItems: [{ t: 'run' }],
    mats: MATS,
    // pivoting bogies under the ends + Jacobs bogies at the articulations
    bogies: cab ? [-1.2, 3.8] : tail ? [-3.8, 1.2] : [-3.8, 3.8],
    winOpts: WIN,
  });
  if (cab) alfaMask(mb, { dirZ: -1 });
  if (tail) alfaMask(mb, { dirZ: 1 });
  roofPod(mb, { z: cab ? 2.2 : tail ? -2.2 : 2.6, y: ROOFTOP, w: 1.6, h: 0.3, d: 2.4 });
  if (!cab && !tail) roofPod(mb, { z: -2.6, y: ROOFTOP, w: 1.6, h: 0.3, d: 2.4 });
  roofPod(mb, { z: cab ? -0.6 : tail ? 0.6 : 0, y: ROOFTOP, w: 1.0, h: 0.16, d: 1.2 });
  skirtBoxes(mb, { zs: cab ? [1.4, 2.6] : tail ? [-2.6, -1.4] : [-1.4, 1.2], width: W, y: 0.26 });
  if (pantograph) singleArmPantograph(mb, { z: 0, yRoof: ROOFTOP });
  return mb;
}

export function sections() {
  const expect = { length: L, width: W };
  return [
    { key: '15t-a', build: () => build({ cab: true }), expect },
    { key: '15t-b', build: () => build({ pantograph: true }), expect },
    { key: '15t-c', build: () => build({ tail: true }), expect },
  ];
}
