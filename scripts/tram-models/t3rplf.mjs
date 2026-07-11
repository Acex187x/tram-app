// Tatra T3R.PLF — "wana": a classic-T3-shaped single car with a low-floor
// middle, built new (VarCB3LF shell) 2007-2025 for Prague (8251-8299, 875x).
//
// ACCURACY ROUND 2 — rebuilt against 9 reference photos (Wikimedia Commons:
// cars 8252, 8261, 8263 — front, side, 3/4, roof) + cs.wikipedia.org:
//  * Classic T3 rounded laminate face RETAINED ("klasická čela vozů T3").
//  * Livery: warm greige/ivory body (window band, roof, skirt) + deep
//    crimson-maroon wine belt — NOT silver/PID-red as in round 1.
//  * Iconic face: huge two-piece panorama windshield (1.55→2.47 m); above it
//    a full-width black band with GREEN-YELLOW LED destination display; the
//    wine bib below is two big lobes whose top edge sweeps concavely from
//    belt height at the corners down to a V-tip that touches the bumper —
//    i.e. a wide cream wedge (±1.05 m at top) descends between the round
//    headlights, which sit INSIDE the red lobes.
//  * Massive proud grey metal bumper wraps the nose (0.34–0.52 m), grey
//    apron + coupler with hoses below, white number plate under the glass.
//  * Side: crimson belt 0.62–1.45 m, cream skirt 0.30–0.62 m; the "wings"
//    motif = 4 staggered horizontal cream feather stripes fanning both ways
//    from a descending triangle of stacked cream bars.
//  * 3 right-side doors (folding, tall narrow panes; the MIDDLE one wider,
//    dropping to the 350 mm low floor); 2 windows between doors 1-2, 3
//    between 2-3, 8 on the left; sliding-vent strip near each window top.
//  * Roof: cream; WHITE Thermo-King AC box over the cab, wine-red cover pod
//    behind it, long raised beige hump over the rear half, yellow scissor
//    pantograph at z≈−0.6 on the low roof between them.

import {
  MATERIALS, MeshBuilder, arcAt, arcZAtX, buildWall, coupler,
  floorPlate, mirrorArcZ, noseArc, roofSlab,
  scissorPantograph, skirtBoxes, underframe,
} from './lib.mjs';

// ── Local palette (photo-sampled; keys prefixed to avoid collisions) ─────────
Object.assign(MATERIALS, {
  plfCream: { hex: 0xccc5b2, rough: 0.5, metal: 0.08 }, // warm greige laminate
  plfWine: { hex: 0x8e2130, rough: 0.45, metal: 0.08 }, // crimson-maroon belt
  plfBumper: { hex: 0x9b9c98, rough: 0.38, metal: 0.32 }, // bare-metal bumper
  plfApron: { hex: 0x6e7173, rough: 0.55, metal: 0.2 }, // lower apron / steps
  plfRoof: { hex: 0xb3ac9a, rough: 0.62, metal: 0.1 }, // dirty beige roof hump
  plfWhite: { hex: 0xe9eae5, rough: 0.5, metal: 0.05 }, // Thermo-King AC box
  plfLed: { hex: 0x101408, rough: 0.4, metal: 0, emissive: [0.28, 0.55, 0.08] },
  plfAmber: { hex: 0xc9761f, rough: 0.4, metal: 0, emissive: [0.55, 0.26, 0.04] },
});

const L = 14.1;
const W = 2.5;
const HW = W / 2;

// vertical datums (meters over rail)
const SKIRT = 0.3; // cream skirt bottom edge (sides)
const BELT0 = 0.62; // wine belt bottom
const SILL = 1.45; // window sill = belt top
const WINTOP = 2.32;
const YTOP = 2.72; // wall top / fascia top
const ROOFTOP = 2.98;
const VENT_Y = 2.04; // sliding-vent strip in windows

// face datums
const APRON0 = 0.16, BUMP0 = 0.32, BUMP1 = 0.46;
const GLASS0 = 1.54, GLASS1 = 2.47;

const NOSE = 1.45; // plan depth of each rounded mask
const ZW = L / 2 - NOSE; // walls span [-ZW, ZW]

const CREAM = 'plfCream';
const WINE = 'plfWine';

export const EXPECT = { length: L, width: W };

const lerp = (a, b, t) => a + (b - a) * t;

/** Plan arc of the mask at a given depth, oriented for dirZ (−1 front). */
function maskArc(dirZ, depth, n) {
  const a = noseArc({ hw: HW, zStart: -ZW, depth, n });
  return dirZ > 0 ? mirrorArcZ(a) : a;
}

/** Bib-surface plan depth at height y (sill = deepest). */
function bibDepth(y) {
  return lerp(1.4, 1.46, (y - BUMP1) / (SILL - BUMP1));
}

/**
 * Column-strip panel painted 12 mm proud of the mask surface (cream V wedge,
 * LED display). `yBot(x)`/`yTop(x)` give edges per column; `depthAt(y)` the
 * mask plan depth to follow.
 */
function facePanel(mb, dirZ, mat, { x0, x1, yBot, yTop, depthAt, cols = 12 }) {
  const lift = 0.012;
  const arcCache = new Map();
  const zAt = (x, y) => {
    const d = depthAt(y);
    let arc = arcCache.get(d);
    if (!arc) { arc = maskArc(dirZ, d, 20); arcCache.set(d, arc); }
    return arcZAtX(arc, x) + dirZ * lift;
  };
  const topF = typeof yTop === 'function' ? yTop : () => yTop;
  for (let i = 0; i < cols; i++) {
    const xa = lerp(x0, x1, i / cols), xb = lerp(x0, x1, (i + 1) / cols);
    const ya = yBot(xa), yb = yBot(xb);
    const ta = topF(xa), tb = topF(xb);
    if (ta - ya < 1e-4 && tb - yb < 1e-4) continue;
    const A = [xa, ya, zAt(xa, ya)], B = [xb, yb, zAt(xb, yb)];
    const C = [xb, tb, zAt(xb, tb)], D = [xa, ta, zAt(xa, ta)];
    if (dirZ < 0) mb.quad(mat, B, A, D, C);
    else mb.quad(mat, A, B, C, D);
  }
}

/** Wine bib ring around the mask (the cream V is overlaid separately). */
function bibRing(mb, dirZ) {
  const ROWS = 2, N = 16;
  for (let r = 0; r < ROWS; r++) {
    const y0 = lerp(BUMP1, SILL, r / ROWS), y1 = lerp(BUMP1, SILL, (r + 1) / ROWS);
    mb.ribbon(WINE,
      arcAt(maskArc(dirZ, bibDepth(y0), N), y0),
      arcAt(maskArc(dirZ, bibDepth(y1), N), y1));
  }
}

/** Cream wedge boundary: V-tip at bumper center, concave rise to the corners. */
const V_W = 1.05, V_TIP = 0.5;
const vBoundary = (x) =>
  V_TIP + (SILL - 0.01 - V_TIP) * Math.pow(Math.min(Math.abs(x) / V_W, 1), 0.7);

/** One classic T3 mask. dirZ −1 = front (headlights + display), +1 = rear. */
function mask(mb, dirZ) {
  const front = dirZ < 0;
  const N = 12;
  const band = (mat, yA, dA, yB, dB, n = N) => {
    mb.ribbon(mat, arcAt(maskArc(dirZ, dA, n), yA), arcAt(maskArc(dirZ, dB, n), yB));
  };

  // grey apron + massive proud metal bumper wrapping the nose
  band('plfApron', APRON0, 1.3, BUMP0, 1.38);
  band('plfBumper', BUMP0, 1.5, BUMP1 - 0.03, 1.52);
  band('plfBumper', BUMP1 - 0.03, 1.52, BUMP1, 1.46);

  bibRing(mb, dirZ); // wine bib 0.52→1.45

  // cream V wedge descending between the headlights to the bumper
  facePanel(mb, dirZ, CREAM, {
    x0: -V_W, x1: V_W,
    yBot: vBoundary, yTop: SILL + 0.002,
    depthAt: bibDepth, cols: 12,
  });

  band(CREAM, SILL, 1.46, GLASS0, 1.44); // number band under windshield
  band('glass', GLASS0, 1.44, GLASS1, 1.3); // panorama windshield (slight rake)
  band(CREAM, GLASS1, 1.3, YTOP, 1.1); // fascia / display brow

  // rounded roof falloff over the mask + top cap
  const outer = arcAt(maskArc(dirZ, 1.1, N), YTOP);
  const innerPlan = noseArc({ hw: HW - 0.26, zStart: -ZW, depth: 0.48, n: N });
  const inner = arcAt(dirZ > 0 ? mirrorArcZ(innerPlan) : innerPlan, ROOFTOP);
  mb.ribbon(CREAM, outer, inner);
  mb.fan(CREAM, inner, [0, 1, 0]);

  // twin round lamps INSIDE the red lobes, metal rims
  const lampArc = maskArc(dirZ, 1.43, 20);
  for (const sx of [-1, 1]) {
    lamp(mb, {
      x: sx * 0.66, y: 1.0,
      zFace: arcZAtX(lampArc, sx * 0.66) + dirZ * 0.02,
      r: front ? 0.15 : 0.09,
      mat: front ? 'headlight' : 'taillight',
      dir: dirZ,
    });
  }
  // amber vertical indicator pills on the corner curve
  for (const sx of [-1, 1]) {
    mb.box('plfAmber', {
      x: sx * 1.06, y: 1.3, z: arcZAtX(maskArc(dirZ, 1.36, 20), sx * 1.06) + dirZ * 0.01,
      w: 0.09, h: 0.22, d: 0.09,
    });
  }
  // white number plate + thin center divider + slim A-pillars on the glass
  const plateArc = maskArc(dirZ, 1.455, 20);
  mb.box('plfWhite', {
    x: 0.32, y: 1.51, z: arcZAtX(plateArc, 0.32) + dirZ * 0.005,
    w: 0.42, h: 0.13, d: 0.02,
  });
  const glassLo = maskArc(dirZ, 1.44, 20), glassHi = maskArc(dirZ, 1.3, 20);
  for (const px of [0, -1.06, 1.06]) {
    mb.beam(CREAM,
      [px, GLASS0, arcZAtX(glassLo, px) + dirZ * 0.02],
      [px, GLASS1, arcZAtX(glassHi, px) + dirZ * 0.02],
      px === 0 ? 0.03 : 0.07, 0.03);
  }
  // wipers (front only): two black arms resting across the lower glass
  if (front) {
    for (const sx of [-0.62, 0.28]) {
      const zb = arcZAtX(glassLo, sx) + dirZ * 0.03;
      const zt = arcZAtX(glassHi, sx + 0.26) + dirZ * 0.03;
      mb.beam('black', [sx, GLASS0 + 0.02, zb], [sx + 0.26, GLASS0 + 0.62, zt], 0.025);
    }
  }

  // destination display: full-width black band + green-yellow LED strip,
  // recessed into the fascia right above the windshield
  const fasciaDepth = (y) => lerp(1.3, 1.1, (y - GLASS1) / (YTOP - GLASS1));
  const dw = front ? 0.88 : 0.3;
  facePanel(mb, dirZ, 'black', {
    x0: -dw - 0.05, x1: dw + 0.05, yBot: () => 2.5, yTop: 2.71,
    depthAt: fasciaDepth, cols: front ? 8 : 3,
  });
  facePanel(mb, dirZ, 'plfLed', {
    x0: -dw, x1: dw, yBot: () => 2.54, yTop: 2.66,
    depthAt: (y) => fasciaDepth(y) + 0.004, cols: front ? 8 : 3,
  });
  coupler(mb, { zEnd: dirZ * (ZW + NOSE + 0.03), dir: dirZ });
}

/** Round lamp with bare-metal rim (9 segments — byte budget). */
function lamp(mb, { x, y, zFace, r, mat, dir }) {
  mb.cylinder('plfBumper', {
    x, y, z: zFace - dir * 0.05, r: r + 0.025, len: 0.1, axis: 'z', seg: 9, caps: false,
  });
  mb.cylinder(mat, {
    x, y, z: zFace - dir * 0.02, r, len: 0.05, axis: 'z', seg: 9, caps: true, capMat: mat,
  });
}

/** Lean bogie: frame + side frames + 4 wheels at 10 segments (vs lib's 16). */
function leanBogie(mb, { z, width, axleSpacing = 1.9, wheelR = 0.33 }) {
  mb.box('trim', { x: 0, y: 0.42, z, w: width - 0.75, h: 0.42, d: axleSpacing + 0.7 });
  for (const sx of [-1, 1]) {
    mb.box('trim', { x: sx * (width / 2 - 0.16), y: 0.44, z, w: 0.1, h: 0.28, d: axleSpacing + 0.45 });
  }
  const xOff = width / 2 - 0.32;
  for (const dz of [-axleSpacing / 2, axleSpacing / 2]) {
    for (const sx of [-1, 1]) {
      mb.cylinder('black', {
        x: sx * xOff, y: wheelR, z: z + dz, r: wheelR, len: 0.1, axis: 'x', seg: 8,
      });
    }
  }
}

/** Segment list for the 3-door right wall, windows scaled to fill exactly. */
function rightSegs(wallLen) {
  const p = (len = 0.2) => ({ t: 'panel', len });
  const win = (len) => ({ t: 'win', len });
  const segs = [
    { t: 'door', len: 1.3, lowY: SKIRT },
    p(), win(1.2), p(), win(1.2), p(),
    { t: 'door', len: 1.72, lowY: 0.24 }, // wide low-floor door → the "vana"
    p(), win(1.1), p(), win(1.1), p(), win(1.1), p(),
    { t: 'door', len: 1.3, lowY: SKIRT },
  ];
  const total = segs.reduce((s, g) => s + g.len, 0);
  const winSum = segs.filter((g) => g.t === 'win').reduce((s, g) => s + g.len, 0);
  const k = (wallLen - (total - winSum)) / winSum;
  for (const g of segs) if (g.t === 'win') g.len *= k;
  return segs;
}

/** Uniform 8-window left wall. */
function leftSegs(wallLen) {
  const P = 0.2, NWIN = 8;
  const win = (wallLen - (NWIN + 1) * P) / NWIN;
  const segs = [{ t: 'panel', len: P }];
  for (let i = 0; i < NWIN; i++) segs.push({ t: 'win', len: win }, { t: 'panel', len: P });
  return segs;
}

/** Horizontal livery stripe painted just proud of the wall plane. */
function stripe(mb, side, mat, zA, zB, y0, h) {
  const x = side * (HW + 0.005);
  const z0 = Math.min(zA, zB), z1 = Math.max(zA, zB);
  if (z1 - z0 < 0.05) return;
  mb.rectX(mat, x, z0, z1, y0, y0 + h, side);
}

/**
 * The DPP "wings" motif: a descending triangle of stacked cream bars at
 * `centerZ`, with 4 staggered feather stripes fanning toward the front and
 * rear (clipped to [fwdLimit, rearLimit] so they never cross a door).
 */
function wingMotif(mb, side, centerZ, fwdLimit, rearLimit) {
  const H = 0.075;
  // feathers: continuous rows through the center, staggered lengths
  const rows = [
    { y: 1.32, len: 2.75 },
    { y: 1.18, len: 2.15 },
    { y: 1.04, len: 1.55 },
    { y: 0.9, len: 0.95 },
  ];
  for (const r of rows) {
    stripe(mb, side, CREAM,
      Math.max(centerZ - r.len, fwdLimit),
      Math.min(centerZ + r.len, rearLimit), r.y, H);
  }
  // descending triangle of stacked bars tapering below the feathers
  const bars = [
    { y: 0.76, w: 1.35 }, { y: 0.62, w: 0.9 }, { y: 0.48, w: 0.45 },
  ];
  for (const b of bars) {
    stripe(mb, side, CREAM, centerZ - b.w / 2, centerZ + b.w / 2, b.y, H);
  }
}

/** Cream mullions over a door's glass → reads as tall narrow folding panes. */
function doorMullions(mb, side, z0, z1, lowY) {
  const glassTop = WINTOP;
  for (const t of [0.3, 0.7]) {
    const z = lerp(z0, z1, t);
    mb.box(CREAM, {
      x: side * (HW - 0.02), y: (SILL + glassTop) / 2, z,
      w: 0.03, h: glassTop - SILL, d: 0.07,
    });
  }
  // lower glass hint: dark panel strip below sill on each leaf (folding doors
  // have panes reaching further down than the side windows)
  mb.rectX('glass', side * (HW - 0.028), z0 + 0.16, z1 - 0.16, Math.max(lowY + 0.55, 0.92), SILL, side);
}

export function buildT3RPLF() {
  const mb = new MeshBuilder();
  const wallLen = 2 * ZW;
  const mats = {
    lower: WINE, upper: CREAM, pillar: CREAM,
    glass: 'glass', door: CREAM, frame: CREAM,
  };

  const segsR = rightSegs(wallLen);
  const segsL = leftSegs(wallLen);
  const common = {
    xw: HW, z0: -ZW, y0: BELT0, sill: SILL, winTop: WINTOP, yTop: YTOP,
    mats, doorLowY: SKIRT, ventY: VENT_Y,
  };
  buildWall(mb, { ...common, side: 1, segments: segsR });
  buildWall(mb, { ...common, side: -1, segments: segsL });

  // door extents on the right wall (for skirt gaps + wings + mullions)
  const doors = [];
  let z = -ZW;
  for (const s of segsR) {
    if (s.t === 'door') doors.push([z, z + s.len, s.lowY]);
    z += s.len;
  }
  const [d1z0, d1z1] = doors[0];
  const [midZ0, midZ1] = doors[1];
  const [d3z0] = doors[2];
  for (const [z0, z1, lowY] of doors) doorMullions(mb, 1, z0, z1, lowY);

  // cream skirt band between doors (right) and continuous (left)
  const cuts = [-ZW, d1z0, d1z1, midZ0, midZ1, d3z0, doors[2][1], ZW];
  for (let i = 0; i < cuts.length; i += 2) {
    if (cuts[i + 1] - cuts[i] > 1e-6) mb.rectX(CREAM, HW, cuts[i], cuts[i + 1], SKIRT, BELT0, 1);
  }
  mb.rectX(CREAM, -HW, -ZW, ZW, SKIRT, BELT0, -1);

  // low-floor "vana": deeper apron panel under the middle-door zone
  mb.box('plfApron', {
    x: 0, y: 0.23, z: (midZ0 + midZ1) / 2,
    w: W - 0.02, h: 0.14, d: midZ1 - midZ0 + 0.4,
  });
  // small amber skirt markers (flat proud quads — byte budget)
  for (const sz of [-2.6, 2.6]) {
    for (const sx of [-1, 1]) {
      mb.rectX('plfAmber', sx * (HW + 0.006), sz - 0.035, sz + 0.035, 0.42, 0.49, sx);
    }
  }

  // wings: left side centered mid-car; right side centered in the bay
  // forward of the middle door, feathers clipped clear of the doors
  wingMotif(mb, -1, 0, -ZW + 0.2, ZW - 0.2);
  wingMotif(mb, 1, (d1z1 + midZ0) / 2, d1z1 + 0.08, midZ0 - 0.08);
  // rear-half feathers on the right side (between middle and rear door)
  for (const r of [{ y: 1.32, len: 2.6 }, { y: 1.18, len: 1.9 }, { y: 1.04, len: 1.2 }]) {
    stripe(mb, 1, CREAM, midZ1 + 0.1, Math.min(midZ1 + 0.1 + r.len, d3z0 - 0.08), r.y, 0.075);
  }

  // side destination display just behind the middle door, over the windows
  mb.box('black', { x: HW - 0.05, y: 2.5, z: midZ1 + 0.45, w: 0.12, h: 0.2, d: 0.62 });
  mb.rectX('plfLed', HW + 0.004, midZ1 + 0.2, midZ1 + 0.7, 2.42, 2.58, 1);

  // roof: cream slab; white AC box over the cab, wine cover pod behind it,
  // long raised beige hump over the rear half, scissor pantograph between
  roofSlab(mb, { z0: -ZW, z1: ZW, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: CREAM, shrink: 0.26 });
  mb.box('plfWhite', { x: 0, y: ROOFTOP + 0.15, z: -4.5, w: 1.52, h: 0.3, d: 1.45, bevel: 0.06 });
  mb.box(WINE, { x: 0, y: ROOFTOP + 0.09, z: -3.15, w: 1.38, h: 0.18, d: 1.15, bevel: 0.05 });
  mb.box('plfRoof', { x: 0, y: ROOFTOP + 0.077, z: 2.7, w: 1.32, h: 0.155, d: 4.2, bevel: 0.05 });
  mb.box('roof', { x: 0, y: ROOFTOP + 0.18, z: 3.4, w: 0.9, h: 0.055, d: 1.1 }); // hump vent
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
