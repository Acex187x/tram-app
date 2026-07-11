// Tatra T3R.P — the modernized T3 workhorse (DPP in-house rebuilds, ~300 cars).
// ACCURACY ROUND 2 — rebuilt against 8 reference photos of Prague cars
// 8216, 8315, 8318, 8331, 8448, 8456, 8534, 8540 (Wikimedia Commons:
// "DPP 8216, Jindřišská 2019", "DPP 8331, Malostranská 2019", "DPP 8448,
// Klárov 2019", "Lazarská, 8315/8318/8534", "Bulovka, 8456", "Dukelských
// hrdinů, 8540").
//
// Measured observations driving this geometry:
//  * YELLOW SCISSOR pantograph (not a half-panto!) centered on the roof.
//  * Face is dominated by a huge wrap-around two-piece windshield, raked
//    back ~15°, hair-thin corner pillars, thin dark center seam; glass
//    bottom (~1.52 m) sits LOWER than the side window sills (1.65 m).
//  * Wide black BUSE display band spans ~3/4 of the face width directly
//    above the windshield (green-lit line + destination).
//  * Two round chrome-ring headlights at x≈±0.58, y≈0.98; AMBER vertical
//    oval indicators near the outer corners at the same height.
//  * Lower face: traffic-red mask down to a dark-brown bumper rail
//    (0.52–0.63 m), cream rounded chin tucked ~0.28 m under below it.
//  * Livery: red belt from the window sills all the way down, with only a
//    ~0.2 m cream skirt strip at the very bottom; cream everywhere above.
//    Red continues across the lower half of the folding doors.
//  * Roof: clean cream front dome (NO red box), long dark-grey anti-slip /
//    resistor cover over the mid/rear roof, thin conduit down the center.
// Geometry is authored here (t3-common.mjs is the plain-t3 mask, read-only).

import {
  MATERIALS, MeshBuilder, arcZAtX, buildSectionShell, coupler, mirrorArcZ,
  noseArc, roofPod, scissorPantograph, skirtBoxes,
} from './lib.mjs';

// Local palette (t3rp-prefixed keys so no other builder is affected) —
// colors sampled from the reference photos, sun-corrected.
Object.assign(MATERIALS, {
  t3rpRed: { hex: 0xce2a1a, rough: 0.45, metal: 0.06 }, // DPP traffic red
  t3rpBumper: { hex: 0x44322a, rough: 0.62, metal: 0.05 }, // brown bumper rail
  t3rpRoofDark: { hex: 0x3b3e39, rough: 0.72, metal: 0.08 }, // anti-slip cover
  t3rpAmber: { hex: 0xe08414, rough: 0.35, metal: 0, emissive: [0.85, 0.4, 0.04] },
  // BUSE electronic display: near-black glass with green-lit dot-matrix text
  // (emissive kept moderate — a real display reads mostly dark w/ green glow)
  t3rpDisplay: { hex: 0x0e120c, rough: 0.35, metal: 0, emissive: [0.1, 0.32, 0.07] },
});

const L = 14.1;
const W = 2.5;
const HW = W / 2;
const Y0 = 0.35; // body underside
const SILL = 1.65; // side window sill
const WINTOP = 2.45;
const YTOP = 2.72;
const ROOFTOP = 3.02;
const NOSE = 1.55; // plan depth of each rounded mask
const ZS = L / 2 - NOSE; // wall extent / mask start plane

const ARC_N = 16; // smooth rounded nose (file-size gate keeps this ≤16)

export const EXPECT = { length: L, width: W };

// Mask vertical profile: [y, plan depth, half width] rings, chin → roof.
// Depth peaks at the windshield bottom ring (1.44 m) and the glass rakes
// back 0.285 m over its 1.04 m height (≈15°); the chin tucks 0.28 m under.
const GLASS0 = 1.52;
const GLASS1 = 2.52;
const LVL = [
  { y: 0.32, d: 1.26, hw: 1.12 }, // chin bottom (tucked under)
  { y: 0.56, d: 1.47, hw: 1.23 }, // chin top
  { y: 0.67, d: 1.52, hw: 1.245 }, // bumper rail top
  { y: 1.40, d: 1.578, hw: 1.25 }, // red mask top — proudest ring
  { y: GLASS0, d: 1.562, hw: 1.25 }, // cream strip under the glass
  { y: GLASS1, d: 1.29, hw: 1.25 }, // windshield top (strong rake)
  { y: 2.58, d: 1.275, hw: 1.24 }, // thin cream lip over the glass
  { y: 2.80, d: 1.20, hw: 1.22 }, // BUSE display band (brow leans out a hair)
  { y: 2.92, d: 0.98, hw: 1.15 }, // dome
  { y: ROOFTOP, d: 0.55, hw: 1.03 }, // dome top ring (matches roof plateau)
];

/** Plan arc for one end. dirZ -1 → front (−Z), +1 → rear. */
function makeArc(dirZ, depth, hw) {
  const a = noseArc({ hw, zStart: -ZS, depth, n: ARC_N });
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

/** Round halogen lamp with a bright chrome bezel ring + emissive face. */
function halogenLamp(mb, { x, y, zFace, r, mat, dir }) {
  mb.cylinder('silver', {
    x, y, z: zFace - dir * 0.04, r: r + 0.02, len: 0.08, axis: 'z', seg: 12, caps: false,
  });
  mb.cylinder(mat, {
    x, y, z: zFace - dir * 0.015, r, len: 0.05, axis: 'z', seg: 12, caps: true, capMat: mat,
  });
}

/** Point on the raked windshield surface, pushed out by `out`. */
function glassPt(dirZ, x, y, out) {
  const d = 1.562 + (1.29 - 1.562) * ((y - GLASS0) / (GLASS1 - GLASS0));
  const c = Math.sqrt(Math.max(0, 1 - (x / HW) ** 2));
  return [x, y, dirZ * (ZS + d * c + out)];
}

/** One rounded T3R.P mask. Front gets the BUSE display, wipers, mirrors. */
function mask(mb, { dirZ, isFront }) {
  const arcs = LVL.map((l) => makeArc(dirZ, l.d, l.hw));
  const band = (i, matAt) =>
    bandSplit(mb, arcs[i], arcs[i + 1], LVL[i].y, LVL[i + 1].y, matAt);

  band(0, () => 'cream'); // rounded chin
  band(1, () => 't3rpBumper'); // bumper rail
  band(2, () => 't3rpRed'); // red mask
  band(3, () => 'cream'); // cream strip under the glass
  // huge wrap-around windshield — glass almost to the corners
  band(4, (x) => (Math.abs(x) < 1.19 ? 'glass' : 'cream'));
  band(5, () => 'cream'); // thin cream lip over the glass
  // header: front = wide black BUSE band w/ green-lit core, rear = cream
  // with a small green line-number box
  if (isFront) {
    band(6, (x) => {
      const ax = Math.abs(x);
      return ax < 0.74 ? 't3rpDisplay' : ax < 1.02 ? 'black' : 'cream';
    });
  } else {
    band(6, (x) => (x > 0.32 && x < 0.72 ? 't3rpDisplay' : 'cream'));
  }
  band(7, () => 'cream'); // dome
  band(8, () => 'cream');
  mb.fan('cream', arcs[9].map(([x, z]) => [x, ROOFTOP, z]), [0, 1, 0]);

  // headlights low in the red mask (just above the bumper) close to center,
  // amber corner indicators slightly higher near the outer edges
  const dLamp = 1.52 + (1.578 - 1.52) * ((0.9 - 0.67) / (1.4 - 0.67));
  const aLamp = makeArc(dirZ, dLamp, 1.25);
  for (const sx of [-1, 1]) {
    halogenLamp(mb, {
      x: sx * 0.58, y: 0.9,
      zFace: arcZAtX(aLamp, sx * 0.58) + dirZ * 0.06,
      r: isFront ? 0.125 : 0.08,
      mat: isFront ? 'headlight' : 'taillight',
      dir: dirZ,
    });
    mb.box('t3rpAmber', {
      x: sx * 1.02, y: 1.05,
      z: arcZAtX(aLamp, sx * 1.02) + dirZ * 0.01,
      w: 0.13, h: 0.24, d: 0.08,
    });
  }

  // thin dark two-piece windshield seam following the glass rake
  mb.beam('black', glassPt(dirZ, 0, GLASS0, 0.02), glassPt(dirZ, 0, GLASS1, 0.02), 0.035);

  if (isFront) {
    // wipers parked angled across the lower glass
    for (const sx of [-1, 1]) {
      mb.beam('black', glassPt(dirZ, sx * 0.55, 1.6, 0.045), glassPt(dirZ, sx * 0.15, 2.28, 0.045), 0.028);
    }
    // black rear-view mirrors at both A-pillars
    for (const sx of [-1, 1]) {
      const zP = dirZ * (ZS + 0.38);
      mb.beam('black', [sx * 1.17, 2.32, zP - dirZ * 0.06], [sx * 1.27, 2.3, zP], 0.026);
      mb.box('black', { x: sx * 1.28, y: 2.22, z: zP, w: 0.05, h: 0.28, d: 0.17 });
    }
  }

  coupler(mb, { zEnd: dirZ * (L / 2), dir: dirZ });
}

export function buildT3RP() {
  const mb = new MeshBuilder();
  const mats = {
    lower: 't3rpRed',
    upper: 'cream',
    pillar: 'cream',
    glass: 'glass',
    door: 't3rpRed', // red door leaves below the window line (photo-verified)
    frame: 'cream',
  };
  buildSectionShell(mb, {
    length: L, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: 'cab', rear: 'cab', noseDepthF: NOSE, noseDepthR: NOSE,
    rightItems: [
      { t: 'panel', len: 0.1 },
      { t: 'win', len: 0.6 }, // narrow cab sliding window before door 1
      { t: 'panel', len: 0.1 },
      { t: 'door', len: 1.3 },
      { t: 'run', weight: 2.3 },
      { t: 'door', len: 1.3 },
      { t: 'run', weight: 4.2 },
      { t: 'door', len: 1.3 },
    ],
    leftItems: [
      { t: 'panel', len: 0.1 },
      { t: 'win', len: 0.6 }, // driver's window
      { t: 'panel', len: 0.1 },
      { t: 'run' },
    ],
    mats,
    bogies: [], // drawn locally with lighter wheels (file-size budget)
    winOpts: { targetWin: 1.2, pillar: 0.11 }, // T3 window rhythm, thin pillars
    ventY: 2.26, // sliding-vent divider ~72% up the window
    roofMat: 'cream',
  });

  mask(mb, { dirZ: -1, isFront: true });
  mask(mb, { dirZ: 1, isFront: false });

  // bogies — like lib's but with 10-segment wheels (stays under the 150 KB gate)
  for (const bz of [-3.2, 3.2]) {
    mb.box('trim', { x: 0, y: 0.42, z: bz, w: W - 0.75, h: 0.42, d: 2.5 });
    for (const sx of [-1, 1]) {
      mb.box('trim', { x: sx * (W / 2 - 0.16), y: 0.44, z: bz, w: 0.1, h: 0.28, d: 2.25 });
      for (const dz of [-0.9, 0.9]) {
        mb.cylinder('black', {
          x: sx * (W / 2 - 0.32), y: 0.33, z: bz + dz,
          r: 0.33, len: 0.1, axis: 'x', seg: 10,
        });
      }
    }
  }

  // livery: shallow cream skirt strip at the very bottom (photo: ~0.2 m)
  const zw = ZS - 0.02;
  for (const side of [-1, 1]) {
    mb.rectX('cream', side * (HW + 0.004), -zw, zw, Y0, 0.53, side);
  }

  // small green side route-number display behind the first right-side window
  mb.rectX('t3rpDisplay', HW - 0.028, -4.02, -3.72, 2.14, 2.38, 1);

  // roof: long dark anti-slip / resistor cover over the mid + rear roof,
  // thin conduit running forward from the pantograph, low grey pods
  mb.box('t3rpRoofDark', { x: 0, y: ROOFTOP + 0.016, z: 0.7, w: 1.96, h: 0.032, d: 9.0 });
  mb.box('trim', { x: 0, y: ROOFTOP + 0.02, z: -2.85, w: 0.05, h: 0.03, d: 3.3 });
  roofPod(mb, { z: -2.4, y: ROOFTOP + 0.024, w: 1.05, h: 0.13, d: 1.5, mat: 'roof' });
  roofPod(mb, { z: 2.8, y: ROOFTOP + 0.024, w: 1.05, h: 0.11, d: 1.3, mat: 'roof' });
  skirtBoxes(mb, { zs: [-1.6, 0.2, 1.8], width: W });

  // YELLOW full scissor pantograph, roof center — photo-verified on
  // 8216/8331/8448/8534/8456 (round 1 wrongly used a half-panto)
  scissorPantograph(mb, { z: 0, yRoof: ROOFTOP + 0.02, mat: 'brass' });

  return mb;
}

export function sections() {
  return [{ key: 't3rp', build: buildT3RP, expect: EXPECT }];
}
