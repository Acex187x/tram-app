// Tatra T3R.P — the modernized T3 workhorse (DPP in-house rebuilds, ~300 cars).
// Reads as a classic T3 at a glance but with the modernization cues verified
// from photos of Prague cars 8239 / 8245 / 8323 / 8538:
//   * wide green-on-black electronic BUSE destination display in the header
//     band above the windshield (vs the t3's small film box),
//   * Lekov half-pantograph (yellow) instead of the full scissor,
//   * dark anti-slip covering over the centre/rear roof, cab A/C box with a
//     red lid behind the front dome,
//   * round halogen headlights with bright bezels + amber corner indicators,
//   * classic cream/red livery with a continuous cream skirt stripe.
// Geometry is authored here (t3-common.mjs is the plain-t3 mask, read-only).

import {
  MeshBuilder, arcZAtX, buildSectionShell, coupler, mirrorArcZ, noseArc,
  roofPod, roofRibs, skirtBoxes,
} from './lib.mjs';

const L = 14.1;
const W = 2.5;
const HW = W / 2;
const Y0 = 0.35; // body underside
const SILL = 1.65; // side window sill
const WINTOP = 2.5;
const YTOP = 2.72;
const ROOFTOP = 3.02;
const NOSE = 1.55; // plan depth of each rounded mask

// Mask band heights (windshield drops lower than the side sills — real T3).
const APRON = 0.55; // cream apron top
const BUMP = 0.65; // dark bumper strip top
const GLASS0 = 1.42; // windshield bottom
const GLASS1 = 2.46; // windshield top

// Plan-arc depths at each band edge (deepest ring = red belt top = bbox tip).
const D_LO = 1.46;
const D_APRON = 1.5;
const D_BUMP = 1.52;
const D_BELT = NOSE;
const D_GLASS1 = 1.32;
const D_FASCIA = 1.14;

const ARC_N = 16;

export const EXPECT = { length: L, width: W };

/** Plan arc for one end. dirZ -1 → front (−Z), +1 → rear. */
function makeArc(dirZ, depth, hw = HW, n = ARC_N) {
  const a = noseArc({ hw, zStart: -(L / 2 - NOSE), depth, n });
  return dirZ > 0 ? mirrorArcZ(a) : a;
}

/** Ribbon between two plan arcs with per-quad material chosen by x midpoint. */
function bandSplit(mb, arc0, arc1, y0, y1, matAt) {
  for (let i = 0; i < arc0.length - 1; i++) {
    mb.quad(
      matAt((arc0[i][0] + arc0[i + 1][0]) / 2),
      [arc0[i][0], y0, arc0[i][1]],
      [arc1[i][0], y1, arc1[i][1]],
      [arc1[i + 1][0], y1, arc1[i + 1][1]],
      [arc0[i + 1][0], y0, arc0[i + 1][1]],
    );
  }
}

/** Round halogen lamp with a bright bezel ring + emissive face. */
function halogenLamp(mb, { x, y, zFace, r, mat, dir }) {
  mb.cylinder('silver', {
    x, y, z: zFace - dir * 0.04, r: r + 0.022, len: 0.08, axis: 'z', seg: 12, caps: false,
  });
  mb.cylinder(mat, {
    x, y, z: zFace - dir * 0.015, r, len: 0.05, axis: 'z', seg: 12, caps: true, capMat: mat,
  });
}

/** Point on the raked windshield surface (front mask), pushed out by `out`. */
function glassPt(dirZ, x, y, out) {
  const d = D_BELT + (D_GLASS1 - D_BELT) * ((y - GLASS0) / (GLASS1 - GLASS0));
  const c = Math.sqrt(Math.max(0, 1 - (x / HW) ** 2));
  return [x, y, dirZ * (L / 2 - NOSE + d * c + out)];
}

/** One rounded T3R.P mask. Front gets BUSE display, wipers, mirrors. */
function mask(mb, { dirZ, isFront }) {
  const arc = (d, hw) => makeArc(dirZ, d, hw);
  const aLo = arc(D_LO);
  const aApron = arc(D_APRON);
  const aBump = arc(D_BUMP);
  const aBelt = arc(D_BELT);
  const aGlass1 = arc(D_GLASS1);
  const aFascia = arc(D_FASCIA);

  // stacked livery bands: cream apron, dark bumper strip, red belt
  bandSplit(mb, aLo, aApron, Y0, APRON, () => 'cream');
  bandSplit(mb, aApron, aBump, APRON, BUMP, () => 'trim');
  bandSplit(mb, aBump, aBelt, BUMP, GLASS0, () => 'redClassic');
  // windshield band: glass centre, cream corner pillars wrapping to the sides
  bandSplit(mb, aBelt, aGlass1, GLASS0, GLASS1,
    (x) => (Math.abs(x) < 1.03 ? 'glass' : 'cream'));

  // header band; front carries the wide curved BUSE line+destination display
  const dAt = (y) => D_GLASS1 + (D_FASCIA - D_GLASS1) * ((y - GLASS1) / (YTOP - GLASS1));
  if (isFront) {
    const strip = (y0, y1, matAt) => bandSplit(mb, arc(dAt(y0)), arc(dAt(y1)), y0, y1, matAt);
    strip(GLASS1, 2.48, () => 'cream');
    strip(2.48, 2.68, (x) => {
      const ax = Math.abs(x);
      return ax < 0.74 ? 'display' : ax < 0.86 ? 'black' : 'cream';
    });
    strip(2.68, YTOP, () => 'cream');
  } else {
    bandSplit(mb, aGlass1, aFascia, GLASS1, YTOP, () => 'cream');
  }

  // rounded roof dome closing the nose top
  const domeHi = arc(0.55, HW - 0.22);
  bandSplit(mb, aFascia, domeHi, YTOP, ROOFTOP, () => 'cream');
  mb.fan('cream', domeHi.map(([x, z]) => [x, ROOFTOP, z]), [0, 1, 0]);

  // lamps on the red belt + amber indicators near the bumper corners
  const aLamp = arc(1.53);
  for (const sx of [-1, 1]) {
    halogenLamp(mb, {
      x: sx * 0.73, y: 1.02,
      zFace: arcZAtX(aLamp, sx * 0.73) + dirZ * 0.08,
      r: isFront ? 0.145 : 0.09,
      mat: isFront ? 'headlight' : 'taillight',
      dir: dirZ,
    });
    mb.box('display', {
      x: sx * 1.02, y: 0.6,
      z: arcZAtX(aBump, sx * 1.02) + dirZ * 0.04,
      w: 0.2, h: 0.09, d: 0.07,
    });
  }

  // two-piece windshield: centre divider following the glass rake
  mb.beam('cream', glassPt(dirZ, 0, GLASS0, 0.025), glassPt(dirZ, 0, GLASS1, 0.025), 0.06, 0.04);

  if (isFront) {
    // wipers parked across the lower glass
    for (const sx of [-1, 1]) {
      mb.beam('black', glassPt(dirZ, sx * 0.62, 1.52, 0.045), glassPt(dirZ, sx * 0.22, 2.18, 0.045), 0.03);
    }
    // black rear-view mirrors at both A-pillars
    const zP = dirZ * (L / 2 - NOSE + 0.05);
    for (const sx of [-1, 1]) {
      mb.beam('black', [sx * 1.18, 2.32, zP - dirZ * 0.08], [sx * 1.26, 2.3, zP], 0.028);
      mb.box('black', { x: sx * 1.27, y: 2.2, z: zP, w: 0.05, h: 0.26, d: 0.16 });
    }
  }

  coupler(mb, { zEnd: dirZ * (L / 2), dir: dirZ });
}

/**
 * Raised Lekov half-pantograph (single arm), knee toward the front — kept
 * prominent so the t3rp reads differently from the t3's full scissor even at
 * map zoom. Stays under the 3.6 m height gate.
 */
function lekovPantograph(mb, { z, yRoof }) {
  // four insulators + base frame
  for (const [dx, dz] of [[-0.42, -0.55], [0.42, -0.55], [-0.42, 0.55], [0.42, 0.55]]) {
    mb.cylinder('trim', { x: dx, y: yRoof + 0.05, z: z + dz, r: 0.04, len: 0.1, axis: 'y', seg: 8 });
  }
  const yB = yRoof + 0.12;
  mb.box('trim', { x: 0, y: yB, z, w: 0.96, h: 0.06, d: 1.25 });
  const elbow = [0, yRoof + 0.34, z - 0.72];
  const head = [0, yRoof + 0.47, z + 0.5];
  // twin lower arms converging on the knee
  for (const sx of [-1, 1]) {
    mb.beam('brass', [sx * 0.26, yB + 0.04, z + 0.52], [sx * 0.05, elbow[1], elbow[2]], 0.05);
  }
  mb.beam('brass', elbow, head, 0.045); // upper arm
  mb.beam('brass', [0, yB + 0.04, z + 0.66], [0, elbow[1] - 0.09, elbow[2] + 0.14], 0.024); // balance rod
  // collector head + down-swept horns
  mb.box('trim', { x: 0, y: head[1] + 0.035, z: head[2], w: 1.75, h: 0.045, d: 0.22 });
  for (const sx of [-1, 1]) {
    mb.beam('trim', [sx * 0.84, head[1] + 0.03, head[2] - 0.08], [sx * 0.68, head[1] - 0.12, head[2] - 0.28], 0.028);
  }
}

export function buildT3RP() {
  const mb = new MeshBuilder();
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
      { t: 'door', len: 1.35 },
      { t: 'run', weight: 4.1 },
      { t: 'door', len: 1.35 },
    ],
    leftItems: [{ t: 'run' }],
    mats,
    bogies: [-3.2, 3.2],
    winOpts: { targetWin: 1.18, pillar: 0.17 },
    ventY: 2.24,
    roofMat: 'cream',
  });

  mask(mb, { dirZ: -1, isFront: true });
  mask(mb, { dirZ: 1, isFront: false });

  // livery: continuous cream skirt stripe under the red belt (both sides)
  const zw = L / 2 - NOSE - 0.02;
  for (const side of [-1, 1]) {
    mb.rectX('cream', side * (HW + 0.004), -zw, zw, Y0, 0.58, side);
  }

  // side route-number display tucked at the top of the first right-side window
  mb.box('black', { x: HW - 0.045, y: 2.32, z: -3.85, w: 0.05, h: 0.28, d: 0.4 });
  mb.rectX('display', HW - 0.018, -4.02, -3.68, 2.21, 2.43, 1);

  // roof: cream ribs at the front, dark anti-slip covering centre → rear
  roofRibs(mb, { z0: -4.7, z1: -3.4, xw: HW, y: ROOFTOP, count: 4, mat: 'cream' });
  mb.box('trim', { x: 0, y: ROOFTOP + 0.014, z: 0.65, w: 1.78, h: 0.028, d: 7.9 });
  roofPod(mb, { z: -2.5, y: ROOFTOP + 0.03, w: 1.1, h: 0.2, d: 1.4, mat: 'trim' });
  roofPod(mb, { z: 2.6, y: ROOFTOP + 0.03, w: 1.1, h: 0.18, d: 1.2, mat: 'trim' });
  // cab air-conditioning box behind the front dome (cream body, red lid)
  roofPod(mb, { z: -4.35, y: ROOFTOP, w: 1.26, h: 0.22, d: 1.05, mat: 'cream' });
  roofPod(mb, { z: -4.35, y: ROOFTOP + 0.22, w: 1.26, h: 0.06, d: 1.05, mat: 'redClassic' });
  skirtBoxes(mb, { zs: [-1.5, 0.1, 1.7], width: W });

  // Lekov half-pantograph (yellow), mid-roof — the T3R.P giveaway vs the t3
  lekovPantograph(mb, { z: 0.6, yRoof: ROOFTOP + 0.028 });

  return mb;
}

export function sections() {
  return [{ key: 't3rp', build: buildT3RP, expect: EXPECT }];
}
