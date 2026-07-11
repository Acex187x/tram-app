// Tatra T3 family — t3 (historic), t3rp (T3R.P), t3rplf (T3R.PLF).
// Single rigid car ~14.1 m × 2.5 m, body height ~3.1 m. Classic silhouette:
// rounded laminate front/rear masks, cream window band + roof over a traffic-
// red belt, twin round headlights, scissor pantograph, 3 doors right side.

import {
  MeshBuilder, arcZAtX, buildSectionShell, coupler, destinationDisplay,
  mirrorArcZ, noseArc, noseBands, roofPod, roofRibs, roundLamp,
  scissorPantograph, skirtBoxes,
} from './lib.mjs';

const L = 14.1;
const W = 2.5;
const HW = W / 2;
const Y0 = 0.35;
const SILL = 1.65;
const WINTOP = 2.5;
const YTOP = 2.72;
const ROOFTOP = 3.02;
const NOSE = 1.55; // plan depth of each rounded mask

/**
 * Rounded T3 mask at one end. dirZ -1 → front (−Z), +1 → rear.
 * palette: { mask (belt color), fascia (above windshield) }.
 */
function t3Mask(mb, { dirZ, palette, hasDisplay }) {
  const zStart = dirZ * (L / 2 - NOSE);
  const arc = (depth, n = 24) => {
    const a = noseArc({ hw: HW, zStart: -Math.abs(zStart), depth, n });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  const arcs = {
    bumperLo: arc(1.46),
    beltLo: arc(1.5),
    beltHi: arc(NOSE), // deepest ring → defines the bbox tip
    glassHi: arc(1.3),
    fasciaHi: arc(1.14),
  };
  noseBands(mb, {
    bands: [
      { y0: Y0, y1: 0.48, mat: 'trim', arc0: arcs.bumperLo, arc1: arcs.beltLo },
      { y0: 0.48, y1: SILL, mat: palette.mask, arc0: arcs.beltLo, arc1: arcs.beltHi },
      { y0: SILL, y1: WINTOP, mat: 'glass', arc0: arcs.beltHi, arc1: arcs.glassHi },
      { y0: WINTOP, y1: YTOP, mat: palette.fascia, arc0: arcs.glassHi, arc1: arcs.fasciaHi },
    ],
    capMat: palette.roof,
    capCorners: [],
  });
  // twin round lamps on the belt band
  const lampArc = arc(1.52);
  for (const sx of [-1, 1]) {
    roundLamp(mb, {
      x: sx * 0.72,
      y: 1.06,
      zFace: arcZAtX(lampArc, sx * 0.72) + dirZ * 0.09,
      r: dirZ < 0 ? 0.15 : 0.1,
      mat: dirZ < 0 ? 'headlight' : 'taillight',
      dir: dirZ,
    });
  }
  // two-piece windshield: thin center divider following the glass rake
  mb.beam(palette.fascia, [0, SILL, arcZAtX(arcs.beltHi, 0) + dirZ * 0.025],
    [0, WINTOP, arcZAtX(arcs.glassHi, 0) + dirZ * 0.025], 0.06, 0.04);
  // turn indicators outboard of the lamps
  for (const sx of [-1, 1]) {
    mb.box('display', {
      x: sx * 1.0, y: 1.06, z: arcZAtX(lampArc, sx * 1.0) + dirZ * 0.03,
      w: 0.16, h: 0.1, d: 0.07,
    });
  }
  coupler(mb, { zEnd: dirZ * (L / 2), dir: dirZ });
  if (hasDisplay) {
    const tip = arcZAtX(arcs.glassHi, 0);
    destinationDisplay(mb, { zFace: tip + dirZ * 0.05, y: 2.6, dir: dirZ });
    // small route-number box beside the destination display
    destinationDisplay(mb, {
      zFace: arcZAtX(arcs.glassHi, 0.58) + dirZ * 0.05,
      y: 2.6, w: 0.24, h: 0.2, dir: dirZ, x: 0.58,
    });
  }
}

/** @param {'t3' | 't3rp' | 't3rplf'} variant */
function buildT3(variant) {
  const mb = new MeshBuilder();
  const plf = variant === 't3rplf';
  const mats = {
    lower: 'redClassic',
    upper: 'cream',
    pillar: 'cream',
    glass: 'glass',
    door: 'cream',
    frame: 'cream',
  };
  buildSectionShell(mb, {
    length: L, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'cab', rear: 'cab', noseDepthF: NOSE, noseDepthR: NOSE,
    rightItems: [
      { t: 'door', len: 1.35 },
      { t: 'run', weight: 2.85 },
      // PLF: wider plug door dropping to the low-floor "vana" middle
      plf ? { t: 'door', len: 1.6, lowY: 0.22 } : { t: 'door', len: 1.35 },
      { t: 'run', weight: 4.1 },
      { t: 'door', len: 1.35 },
    ],
    leftItems: [{ t: 'run' }],
    mats,
    bogies: [-3.2, 3.2],
    winOpts: { targetWin: 1.18, pillar: 0.17 },
    ventY: 2.24,
    roofMat: plf ? 'roof' : 'cream',
  });

  // masks: classic cream fascia; PLF wears the modernized silver-grey mask
  const palette = plf
    ? { mask: 'silver', fascia: 'silver', roof: 'roof' }
    : { mask: 'redClassic', fascia: 'cream', roof: 'cream' };
  t3Mask(mb, { dirZ: -1, palette, hasDisplay: true });
  t3Mask(mb, { dirZ: 1, palette, hasDisplay: false });

  // roof kit: ribs, resistor boxes + scissor pantograph (brass-yellow in Prague)
  roofRibs(mb, { z0: -4.6, z1: 4.6, xw: HW, y: ROOFTOP, count: 10, mat: plf ? 'roof' : 'cream' });
  roofPod(mb, { z: -2.6, y: ROOFTOP, w: 1.1, h: 0.2, d: 1.5, mat: 'trim' });
  roofPod(mb, { z: 2.2, y: ROOFTOP, w: 1.1, h: 0.18, d: 1.2, mat: 'trim' });
  if (plf) roofPod(mb, { z: 0.9, y: ROOFTOP, w: 1.4, h: 0.24, d: 1.6, mat: 'roof' });
  skirtBoxes(mb, { zs: [-1.4, 0.2, 1.6], width: W });
  scissorPantograph(mb, { z: -0.5, yRoof: ROOFTOP });
  return mb;
}

export function sections() {
  const expect = { length: L, width: W };
  return [
    { key: 't3', build: () => buildT3('t3'), expect },
    { key: 't3rp', build: () => buildT3('t3rp'), expect },
    { key: 't3rplf', build: () => buildT3('t3rplf'), expect },
  ];
}
