// Tatra T3R.PLF — "wana": a classic-T3-shaped single car with a low-floor
// middle, built new (VarCB3LF shell) 2006-2010 for Prague (8251-8283, 875x+).
//
// Visual facts verified against photos of cars 8252/8261 (Wikimedia Commons)
// + cs.wikipedia.org/wiki/Tatra_T3R.PLF + tram-bus.cz:
//  * Classic T3 rounded laminate face was deliberately RETAINED ("klasická
//    čela vozů T3") so PLF+P pairs look uniform — NOT the angular Vario mask.
//  * Livery is wine red (vínová) + silver, not red/cream: silver window band,
//    roof and skirt; deep wine-red belt between sill and skirt.
//  * On the face the red belt forms two lobes split by a rounded silver "V"
//    descending between the twin round headlights; chrome bumper strip below.
//  * Thin silver stripes fan out of the middle-door area across the red belt
//    toward both ends ("wings"), on both body sides.
//  * 3 right-side doors; the MIDDLE one is wider and drops to the 350 mm
//    low floor — no steps, deeper skirt panel under it.
//  * Window rhythm: 2 windows between doors 1-2, 3 between 2-3, ~8 on the
//    left; top sliding-vent strip on each window.
//  * Silver roof with darker grey centre walkway, low vent + resistor boxes,
//    brass/yellow scissor pantograph roughly mid-roof.
//  * LED destination display over the windshield + small side display near
//    the middle door; small round taillights at the rear.

import {
  MeshBuilder, arcAt, arcZAtX, buildWall, coupler,
  floorPlate, mirrorArcZ, noseArc, roofPod, roofSlab,
  scissorPantograph, skirtBoxes, underframe,
} from './lib.mjs';

const L = 14.1;
const W = 2.5;
const HW = W / 2;

// vertical datum (meters over rail)
const SKIRT = 0.3; // silver skirt bottom edge
const BELT0 = 0.55; // wine-red belt bottom
const SILL = 1.55; // window sill = belt top
const WINTOP = 2.42;
const YTOP = 2.78; // wall top / fascia top
const ROOFTOP = 3.03;
const VENT_Y = 2.14; // sliding-vent strip in windows

const NOSE = 1.45; // plan depth of each rounded mask
const ZW = L / 2 - NOSE; // walls span [-ZW, ZW]

const SILVER = 'silver';
const RED = 'redDark';

export const EXPECT = { length: L, width: W };

const lerp = (a, b, t) => a + (b - a) * t;

/** Plan arc of the mask at a given depth, oriented for dirZ (−1 front). */
function maskArc(dirZ, depth, n) {
  const a = noseArc({ hw: HW, zStart: -ZW, depth, n });
  return dirZ > 0 ? mirrorArcZ(a) : a;
}

/** Belt-surface depth at height y (nose plan-arc depth, sill = deepest). */
function beltDepth(y) {
  return lerp(1.41, 1.45, (y - BELT0) / (SILL - BELT0));
}

/**
 * Column-strip panel painted 12 mm proud of the mask surface. Used for the
 * rounded silver "V" and the flush LED destination display. `yBot(x)` gives
 * the lower edge per column; `depthAt(y)` the mask plan depth to follow.
 */
function facePanel(mb, dirZ, mat, { x0, x1, yBot, yTop, depthAt, cols = 10 }) {
  const lift = 0.012;
  const zAt = (x, y) => {
    const arc = maskArc(dirZ, depthAt(y), 24);
    return arcZAtX(arc, x) + dirZ * lift;
  };
  for (let i = 0; i < cols; i++) {
    const xa = lerp(x0, x1, i / cols), xb = lerp(x0, x1, (i + 1) / cols);
    const ya = yBot(xa), yb = yBot(xb);
    const A = [xa, ya, zAt(xa, ya)], B = [xb, yb, zAt(xb, yb)];
    const C = [xb, yTop, zAt(xb, yTop)], D = [xa, yTop, zAt(xa, yTop)];
    if (dirZ < 0) mb.quad(mat, B, A, D, C);
    else mb.quad(mat, A, B, C, D);
  }
}

/** Wine-red belt ring around the mask (the V is overlaid separately). */
function beltRing(mb, dirZ) {
  const ROWS = 3, N = 20;
  for (let r = 0; r < ROWS; r++) {
    const y0 = lerp(BELT0, SILL, r / ROWS), y1 = lerp(BELT0, SILL, (r + 1) / ROWS);
    mb.ribbon(RED,
      arcAt(maskArc(dirZ, beltDepth(y0), N), y0),
      arcAt(maskArc(dirZ, beltDepth(y1), N), y1));
  }
}

/** One classic T3 mask. dirZ −1 = front (headlights + display), +1 = rear. */
function mask(mb, dirZ) {
  const front = dirZ < 0;
  const N = 12;
  const band = (mat, yA, dA, yB, dB) => {
    mb.ribbon(mat, arcAt(maskArc(dirZ, dA, N), yA), arcAt(maskArc(dirZ, dB, N), yB));
  };

  band(SILVER, SKIRT, 1.28, BELT0, 1.41); // skirt ring
  beltRing(mb, dirZ); // wine-red belt
  band(SILVER, SILL, 1.45, SILL + 0.16, 1.41); // strip under windshield
  band('glass', SILL + 0.16, 1.41, 2.52, 1.31); // wraparound windshield (near-vertical)
  band(SILVER, 2.52, 1.31, YTOP, 1.12); // fascia over windshield

  // rounded silver "V" between the headlights (smooth overlay panel),
  // tip dropping almost to the bumper like on the real car
  const V_TIP = 0.62, V_W = 0.48;
  facePanel(mb, dirZ, SILVER, {
    x0: -V_W, x1: V_W,
    yBot: (x) => V_TIP + (SILL - V_TIP) * Math.pow(Math.abs(x) / V_W, 1.5),
    yTop: SILL + 0.001,
    depthAt: beltDepth,
    cols: 12,
  });

  // chrome bumper strip proud of the skirt + black rubber lip below it
  band(SILVER, 0.36, 1.48, 0.52, 1.48);
  band('trim', 0.29, 1.44, 0.36, 1.48);

  // rounded roof falloff over the mask + top cap
  const outer = arcAt(maskArc(dirZ, 1.12, N), YTOP);
  const innerPlan = noseArc({ hw: HW - 0.24, zStart: -ZW, depth: 0.5, n: N });
  const inner = arcAt(dirZ > 0 ? mirrorArcZ(innerPlan) : innerPlan, ROOFTOP);
  mb.ribbon(SILVER, outer, inner);
  mb.fan(SILVER, inner, [0, 1, 0]);

  // twin round lamps sunk into the red lobes
  const lampArc = maskArc(dirZ, 1.44, 24);
  for (const sx of [-1, 1]) {
    lamp(mb, {
      x: sx * 0.72, y: 1.06,
      zFace: arcZAtX(lampArc, sx * 0.72) + dirZ * 0.02,
      r: front ? 0.15 : 0.1,
      mat: front ? 'headlight' : 'taillight',
      dir: dirZ,
    });
  }
  // amber corner indicators outboard of the lamps (half-embedded)
  for (const sx of [-1, 1]) {
    mb.box('display', {
      x: sx * 1.02, y: 1.42, z: arcZAtX(maskArc(dirZ, 1.38, 24), sx * 1.02) + dirZ * 0.005,
      w: 0.13, h: 0.09, d: 0.1,
    });
  }
  // two-piece windshield: thin center divider + A-pillars separating the
  // windshield from the cab side windows, all following the glass rake
  const glassLo = maskArc(dirZ, 1.41, 24), glassHi = maskArc(dirZ, 1.31, 24);
  for (const px of [0, -0.98, 0.98]) {
    mb.beam(SILVER,
      [px, SILL + 0.16, arcZAtX(glassLo, px) + dirZ * 0.02],
      [px, 2.52, arcZAtX(glassHi, px) + dirZ * 0.02],
      px === 0 ? 0.05 : 0.09, 0.035);
  }

  // destination display: flush LED strip in the fascia (small box at rear)
  const fasciaDepth = (y) => lerp(1.31, 1.12, (y - 2.52) / (YTOP - 2.52));
  const dw = front ? 0.46 : 0.16;
  facePanel(mb, dirZ, 'black', {
    x0: -dw - 0.04, x1: dw + 0.04, yBot: () => 2.535, yTop: 2.745,
    depthAt: fasciaDepth, cols: front ? 8 : 3,
  });
  facePanel(mb, dirZ, 'display', {
    x0: -dw, x1: dw, yBot: () => 2.56, yTop: 2.72,
    depthAt: (y) => fasciaDepth(y) + 0.004, cols: front ? 8 : 3,
  });
  coupler(mb, { zEnd: dirZ * (ZW + 1.48), dir: dirZ });
}

/** Lean round lamp (fewer segments than lib's roundLamp — byte budget). */
function lamp(mb, { x, y, zFace, r, mat, dir }) {
  mb.cylinder('trim', {
    x, y, z: zFace - dir * 0.05, r: r + 0.02, len: 0.1, axis: 'z', seg: 9, caps: false,
  });
  mb.cylinder(mat, {
    x, y, z: zFace - dir * 0.02, r, len: 0.05, axis: 'z', seg: 9, caps: true, capMat: mat,
  });
}

/** Lean bogie: frame + side frames + 4 wheels at 10 segments (vs lib's 16). */
function leanBogie(mb, { z, width, axleSpacing = 1.8, wheelR = 0.33 }) {
  mb.box('trim', { x: 0, y: 0.42, z, w: width - 0.75, h: 0.42, d: axleSpacing + 0.7 });
  for (const sx of [-1, 1]) {
    mb.box('trim', { x: sx * (width / 2 - 0.16), y: 0.44, z, w: 0.1, h: 0.28, d: axleSpacing + 0.45 });
  }
  const xOff = width / 2 - 0.32;
  for (const dz of [-axleSpacing / 2, axleSpacing / 2]) {
    for (const sx of [-1, 1]) {
      mb.cylinder('black', {
        x: sx * xOff, y: wheelR, z: z + dz, r: wheelR, len: 0.1, axis: 'x', seg: 10,
      });
    }
  }
}

/** Segment list for the 3-door right wall, windows scaled to fill exactly. */
function rightSegs(wallLen) {
  const p = (len = 0.18) => ({ t: 'panel', len });
  const win = (len) => ({ t: 'win', len });
  const segs = [
    { t: 'door', len: 1.35, lowY: SKIRT },
    p(), win(1.15), p(), win(1.15), p(),
    { t: 'door', len: 1.7, lowY: 0.22 }, // wide low-floor door → the "vana"
    p(), win(1.05), p(), win(1.05), p(), win(1.05), p(),
    { t: 'door', len: 1.35, lowY: SKIRT },
  ];
  const total = segs.reduce((s, g) => s + g.len, 0);
  const winSum = segs.filter((g) => g.t === 'win').reduce((s, g) => s + g.len, 0);
  const k = (wallLen - (total - winSum)) / winSum;
  for (const g of segs) if (g.t === 'win') g.len *= k;
  return segs;
}

/** Uniform 8-window left wall. */
function leftSegs(wallLen) {
  const P = 0.18, NWIN = 8;
  const win = (wallLen - (NWIN + 1) * P) / NWIN;
  const segs = [{ t: 'panel', len: P }];
  for (let i = 0; i < NWIN; i++) segs.push({ t: 'win', len: win }, { t: 'panel', len: P });
  return segs;
}

/** Thin livery stripe painted just proud of the wall plane. */
function stripe(mb, side, z0, y0, z1, y1, h = 0.09) {
  const x = side * (HW + 0.004);
  const a = [x, y0, z0], b = [x, y1, z1], c = [x, y1 + h, z1], d = [x, y0 + h, z0];
  if (side > 0) mb.quad(SILVER, b, a, d, c);
  else mb.quad(SILVER, a, b, c, d);
}

/** Silver "wing" stripes fanning out of the middle-door zone on the belt. */
function wingStripes(mb, side, doorZ0, doorZ1) {
  const fans = [
    { y: 1.32, dy: -0.26, len: 2.4 },
    { y: 1.0, dy: -0.2, len: 1.9 },
    { y: 0.72, dy: -0.12, len: 1.4 },
  ];
  for (const f of fans) {
    stripe(mb, side, doorZ0 - 0.06, f.y, doorZ0 - 0.06 - f.len, f.y + f.dy); // → front
    stripe(mb, side, doorZ1 + 0.06, f.y, doorZ1 + 0.06 + f.len, f.y + f.dy); // → rear
  }
}

export function buildT3RPLF() {
  const mb = new MeshBuilder();
  const wallLen = 2 * ZW;
  const mats = {
    lower: RED, upper: SILVER, pillar: SILVER,
    glass: 'glass', door: SILVER, frame: SILVER,
  };

  const segsR = rightSegs(wallLen);
  const segsL = leftSegs(wallLen);
  const common = {
    xw: HW, z0: -ZW, y0: BELT0, sill: SILL, winTop: WINTOP, yTop: YTOP,
    mats, doorLowY: SKIRT, ventY: VENT_Y,
  };
  buildWall(mb, { ...common, side: 1, segments: segsR });
  buildWall(mb, { ...common, side: -1, segments: segsL });

  // door extents on the right wall (for skirt gaps + stripes + low floor)
  const doors = [];
  let z = -ZW;
  for (const s of segsR) {
    if (s.t === 'door') doors.push([z, z + s.len]);
    z += s.len;
  }
  const [midZ0, midZ1] = doors[1];

  // silver skirt band between doors (right) and continuous (left)
  const cuts = [-ZW, ...doors.flat(), ZW];
  for (let i = 0; i < cuts.length; i += 2) {
    if (cuts[i + 1] - cuts[i] > 1e-6) mb.rectX(SILVER, HW, cuts[i], cuts[i + 1], SKIRT, BELT0, 1);
  }
  mb.rectX(SILVER, -HW, -ZW, ZW, SKIRT, BELT0, -1);

  // low-floor "vana": deeper skirt panel under the middle-door zone
  mb.box(SILVER, {
    x: 0, y: 0.24, z: (midZ0 + midZ1) / 2,
    w: W + 0.006, h: 0.16, d: midZ1 - midZ0 + 0.5,
  });

  wingStripes(mb, 1, midZ0, midZ1);
  wingStripes(mb, -1, midZ0, midZ1);

  // side destination display just behind the middle door, over the windows
  mb.box('black', { x: HW - 0.05, y: 2.55, z: midZ1 + 0.45, w: 0.12, h: 0.2, d: 0.6 });
  mb.rectX('display', HW + 0.004, midZ1 + 0.18, midZ1 + 0.72, 2.47, 2.63, 1);

  // roof: silver slab, darker centre walkway, ribs, vents, resistor boxes
  roofSlab(mb, { z0: -ZW, z1: ZW, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: SILVER, shrink: 0.24 });
  mb.box('roof', { x: 0, y: ROOFTOP + 0.024, z: 0, w: 1.6, h: 0.048, d: 9.6 });
  roofPod(mb, { z: -3.5, y: ROOFTOP, w: 1.0, h: 0.14, d: 1.2, mat: 'roof' });
  roofPod(mb, { z: 2.4, y: ROOFTOP, w: 1.05, h: 0.2, d: 1.8, mat: 'trim' });
  roofPod(mb, { z: 3.9, y: ROOFTOP, w: 0.8, h: 0.12, d: 0.9, mat: 'roof' });
  scissorPantograph(mb, { z: -0.6, yRoof: ROOFTOP });

  // underfloor
  floorPlate(mb, { z0: -ZW, z1: ZW, xw: HW, y0: BELT0 });
  underframe(mb, { z0: -ZW + 0.15, z1: ZW - 0.15, width: W, y0: BELT0 });
  skirtBoxes(mb, { zs: [-2.2, 2.3], width: W, y: 0.24, h: 0.16 });
  for (const bz of [-3.2, 3.2]) leanBogie(mb, { z: bz, width: W });

  mask(mb, -1);
  mask(mb, 1);
  return mb;
}

export function sections() {
  return [{ key: 't3rplf', build: buildT3RPLF, expect: EXPECT }];
}
