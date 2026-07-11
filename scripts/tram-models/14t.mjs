// Škoda 14T "Elektra" (Porsche Design) — 5 sections, 30.25 m, unidirectional.
//
// ACCURACY ROUND 2 — rebuilt against 10 reference photos (Wikimedia Commons:
// 9135 Rudolfinum 3/4, 9119 Hlubočepy front, 9144+9244 head-on, 9155
// Geologická nose-side, 9149 Jindřišská full right side, 9144/9140 Braník
// roof shots, + closeup crops). Measured observations driving this file:
//
//  NOSE ("Porsche helmet"):
//   * Smooth ROUNDED helmet, not a wedge: blunt superelliptic plan arc,
//     max protrusion LOW at the bumper (~0.8 m), chin tucked under, panel
//     seam across the bumper at ~0.95 m.
//   * One-piece wrap-around windshield, raked ~40°: glass base ~1.50 m,
//     top ~2.58 m, top set ~0.9 m behind the base. Silver brow above, cab
//     dome rising to the roofline behind it.
//   * Headlights: TWO recessed dark pods at x ±0.62, y 0.95–1.42, each with
//     3 small round lamps stacked vertically (top = amber indicator).
//     NOT at the body edges, NOT large.
//   * Green LED destination display behind the top of the glass; Škoda
//     roundel between the pods; wiper parked hanging from the TOP of the
//     glass; big black mirrors high at the A-pillars.
//  LIVERY (fractions of 3.06 m body height):
//   * Body silver #c4c7cc; DPP red #c22420 (bright, not crimson).
//   * Red field: skirt bottom (0.30 m ≈ 0.10 h) → 2.52 m (≈ 0.82 h); above
//     it a silver roof fascia; window band 1.25–2.28 m with RED pillars.
//   * Red begins ~1.45 m BEFORE the end of the cab section (both sides) —
//     not at the articulation; tail red runs to the rear helmet.
//   * Doors are GREY (unpainted) double-leaf with tall windows; red band
//     above the doors. Right side only: b→1 door (front), c→2, d→1 (rear),
//     e→1 (front), plus narrow silver driver's door on a.
//   * Articulation covers: SILVER-GREY pleated gaiters, full height —
//     silver, not black.
//  ROOF (Braník tow shots): dark equipment well between silver fascias;
//   silver dome only over the cabs; big grey HVAC box behind the dome;
//   cream perforated resistor panels on a/c/e; black boxes everywhere;
//   bundles of 5–6 cables crossing every articulation; yellow-armed
//   single-arm pantograph near the FRONT of section b.
//
// Conventions: Y-up meters, FRONT toward −Z, section origin at center,
// articulated ends stay sealed (closed gaiter prisms).

import {
  MATERIALS, MeshBuilder, arcAt, arcZAtX, bogie, buildWall, floorPlate,
  noseArc, noseBands, mirrorArcZ, roofSlab, underframe, wallSegs,
} from './lib.mjs';

// ── Local photo-sampled palette (registered under 14t-prefixed keys so the
//    shared palette and the other six model builders are untouched). ────────
Object.assign(MATERIALS, {
  silver14t: { hex: 0xcdd0d4, rough: 0.42, metal: 0.28 }, // body silver
  red14t: { hex: 0xc22420, rough: 0.46, metal: 0.06 }, // DPP bright red
  doorGrey14t: { hex: 0x8f959b, rough: 0.52, metal: 0.22 }, // unpainted doors
  gaiter14t: { hex: 0x9aa0a6, rough: 0.75, metal: 0.05 }, // pleated covers
  gaiterDk14t: { hex: 0x787e84, rough: 0.75, metal: 0.05 }, // pleat shadow
  roofwell14t: { hex: 0x43474b, rough: 0.7, metal: 0.08 }, // roof equipment well
  mesh14t: { hex: 0xcfc7ad, rough: 0.85, metal: 0.02 }, // cream resistor mesh
  displayGrn14t: { hex: 0x1c2416, rough: 0.4, metal: 0, emissive: [0.45, 1.0, 0.25] },
  amber14t: { hex: 0xb36a1c, rough: 0.35, metal: 0, emissive: [0.85, 0.4, 0.05] },
  // windshield: rougher + faintly self-lit so the big raked glass reads DARK
  // from every angle instead of blowing out to a silver specular sheet
  winGlass14t: { hex: 0x0d1216, rough: 0.82, metal: 0, emissive: [0.02, 0.026, 0.03] },
});

const W = 2.46;
const HW = W / 2;
const LLONG = 6.95;
const LSHORT = 4.35;
const Y0 = 0.3; // deep smooth skirts
const SILL = 1.25;
const WINTOP = 2.28;
const YTOP = 2.52; // top of the red field
const ROOFTOP = 3.02; // silver fascia / roof well level
const NOSE = 2.0; // helmet depth (windshield base → bumper tip)
const GAITER = 0.3; // visible articulation cover depth per section end
const DOOR = 1.35;
const DOORLOW = 0.42;

const RED = {
  lower: 'red14t', upper: 'red14t', pillar: 'red14t',
  glass: 'glass', door: 'doorGrey14t', frame: 'red14t',
};
const SIL = {
  lower: 'silver14t', upper: 'silver14t', pillar: 'silver14t',
  glass: 'glass', door: 'silver14t', frame: 'silver14t',
};
const WIN = { targetWin: 1.5, pillar: 0.16 };

const lerp = (a, b, t) => a + (b - a) * t;

// ── Porsche helmet cab end ───────────────────────────────────────────────────

/**
 * dirZ -1 → nose of section a, +1 → tail of e. zJoin = z where the flat side
 * walls stop and the helmet shell begins. Tip lands exactly at zJoin ∓ NOSE.
 */
function cabEnd(mb, { dirZ, zJoin }) {
  const abs = Math.abs(zJoin);
  // Horizontal slices: y, plan depth, half-width, bluntness p (noseArc cos^p —
  // p<1 blunter). 12 facets per arc → smooth rounded helmet.
  const spec = {
    lip: { y: 0.3, d: 1.72, hw: HW - 0.1, p: 0.62 },
    chin: { y: 0.52, d: 1.9, hw: HW - 0.03, p: 0.6 },
    bumpLo: { y: 0.78, d: 2.0, hw: HW, p: 0.58 },
    seamLo: { y: 0.94, d: 1.99, hw: HW, p: 0.58 },
    seamHi: { y: 0.98, d: 1.97, hw: HW, p: 0.58 },
    faceTop: { y: 1.42, d: 1.8, hw: HW, p: 0.6 },
    glassLo: { y: 1.46, d: 1.78, hw: HW, p: 0.6 },
    glassMid: { y: 2.0, d: 1.4, hw: HW - 0.01, p: 0.62 },
    glassHi: { y: 2.56, d: 0.95, hw: HW - 0.05, p: 0.66 },
    brow: { y: 2.76, d: 0.7, hw: HW - 0.13, p: 0.7 },
    dome: { y: 3.02, d: 0.34, hw: HW - 0.34, p: 0.8 },
  };
  const A = {};
  for (const [k, s] of Object.entries(spec)) {
    const a = noseArc({ hw: s.hw, zStart: -abs, depth: s.d, p: s.p, n: 12 });
    A[k] = dirZ > 0 ? mirrorArcZ(a) : a;
  }
  noseBands(mb, {
    bands: [
      { y0: 0.3, y1: 0.52, mat: 'silver14t', arc0: A.lip, arc1: A.chin },
      { y0: 0.52, y1: 0.78, mat: 'silver14t', arc0: A.chin, arc1: A.bumpLo },
      { y0: 0.78, y1: 0.94, mat: 'silver14t', arc0: A.bumpLo, arc1: A.seamLo },
      { y0: 0.94, y1: 0.98, mat: 'trim', arc0: A.seamLo, arc1: A.seamHi }, // bumper seam
      { y0: 0.98, y1: 1.42, mat: 'silver14t', arc0: A.seamHi, arc1: A.faceTop },
      { y0: 1.42, y1: 1.46, mat: 'silver14t', arc0: A.faceTop, arc1: A.glassLo },
      { y0: 1.46, y1: 2.0, mat: 'winGlass14t', arc0: A.glassLo, arc1: A.glassMid },
      { y0: 2.0, y1: 2.56, mat: 'winGlass14t', arc0: A.glassMid, arc1: A.glassHi },
      { y0: 2.56, y1: 2.76, mat: 'silver14t', arc0: A.glassHi, arc1: A.brow },
      { y0: 2.76, y1: 3.02, mat: 'silver14t', arc0: A.brow, arc1: A.dome },
    ],
    capMat: 'silver14t',
    capCorners: dirZ < 0
      ? [[HW - 0.34, zJoin], [-(HW - 0.34), zJoin]]
      : [[-(HW - 0.34), abs], [HW - 0.34, abs]],
  });
  // close the underside of the helmet overhang
  mb.fan('trim', [
    ...arcAt(A.lip, 0.3),
    ...(dirZ < 0
      ? [[HW - 0.1, zJoin], [-(HW - 0.1), zJoin]]
      : [[-(HW - 0.1), abs], [HW - 0.1, abs]]).map(([x, z]) => [x, 0.3, z]),
  ], [0, -1, 0]);

  // interpolated shell z at (x, y) between two slices
  const surf = (lo, hi, x, y) =>
    lerp(arcZAtX(A[lo], x), arcZAtX(A[hi], x), (y - spec[lo].y) / (spec[hi].y - spec[lo].y));

  // Recessed dark lamp pods at x ±0.62 with 3 small round lamps each
  // (photos: 9144/9119 — small bezels, top lamp amber, inboard of the corners).
  // The pod is a curvature-following dark band laid over the shell so it never
  // clips the rounded helmet.
  const podY0 = 1.02, podY1 = 1.46;
  const podYs = [1.1, 1.235, 1.37];
  const podX = 0.58;
  for (const sx of [-1, 1]) {
    const podXs = [0.43, 0.5, 0.58, 0.66, 0.73].map((v) => sx * v);
    const band = (y) => podXs.map((px) => [px, y, surf('seamHi', 'faceTop', px, y) + dirZ * 0.018]);
    const lo = band(podY0);
    const hi = band(podY1);
    if ((sx > 0) === (dirZ < 0)) mb.ribbon('black', lo, hi);
    else mb.ribbon('black', lo.slice().reverse(), hi.slice().reverse());
    // close the pod band edges so it reads as an inset unit
    mb.fan('black', [...lo, ...hi.slice().reverse()], [0, -1, 0]);
    mb.fan('black', [...hi, ...lo.slice().reverse()], [0, 1, 0]);
    podYs.forEach((y, i) => {
      const mat = dirZ < 0
        ? (i === 2 ? 'amber14t' : 'headlight')
        : (i === 2 ? 'silver14t' : 'taillight');
      const zFace = surf('seamHi', 'faceTop', sx * podX, y) + dirZ * 0.006;
      // slim silver bezel + emissive puck
      mb.cylinder('silver14t', {
        x: sx * podX, y, z: zFace - dirZ * 0.024, r: 0.062, len: 0.05, axis: 'z', seg: 10, caps: false,
      });
      mb.cylinder(mat, {
        x: sx * podX, y, z: zFace - dirZ * 0.01, r: 0.048, len: 0.032, axis: 'z', seg: 10, caps: true, capMat: mat,
      });
    });
    // small amber turn-repeater on the body flank just behind the helmet
    // (photos: 9135/9155)
    mb.box('amber14t', {
      x: sx * (HW + 0.002), y: 0.98, z: zJoin - dirZ * 0.15,
      w: 0.018, h: 0.07, d: 0.16,
    });
  }

  // Green LED destination display glowing behind the windshield top
  const dispY = 2.34;
  const dispW = dirZ < 0 ? 1.05 : 0.55;
  // (outward from the shell = the dirZ direction: −Z at the nose, +Z at the tail)
  const zDisp = surf('glassMid', 'glassHi', 0, dispY);
  mb.box('black', { x: 0, y: dispY, z: zDisp - dirZ * 0.04, w: dispW + 0.08, h: 0.2, d: 0.04 });
  mb.rectZ('displayGrn14t', zDisp + dirZ * 0.014, -dispW / 2, dispW / 2, dispY - 0.07, dispY + 0.07, dirZ);

  // Škoda roundel between the pods
  const zBadge = surf('seamHi', 'faceTop', 0, 1.3);
  mb.cylinder('trim', { x: 0, y: 1.3, z: zBadge + dirZ * 0.012, r: 0.095, len: 0.025, axis: 'z', seg: 12 });
  mb.cylinder('silver14t', { x: 0, y: 1.3, z: zBadge + dirZ * 0.03, r: 0.062, len: 0.012, axis: 'z', seg: 10 });

  if (dirZ < 0) {
    // wiper parked hanging from the TOP of the glass (photos: 9144, 9155)
    mb.beam('black',
      [0.32, 2.26, surf('glassMid', 'glassHi', 0.32, 2.26) - 0.025],
      [0.02, 1.62, surf('glassLo', 'glassMid', 0.02, 1.62) - 0.025],
      0.022);
    // big black mirrors on curved arms at the A-pillar tops
    for (const sx of [-1, 1]) {
      const zA = zJoin - 0.45;
      mb.beam('black', [sx * (HW - 0.06), 2.5, zA], [sx * (HW + 0.05), 2.42, zA - 0.5], 0.03);
      mb.box('black', {
        x: sx * (HW + 0.06), y: 2.28, z: zA - 0.55,
        w: 0.06, h: 0.3, d: 0.16, bevel: 0.02,
      });
    }
  }
}

// ── Silver pleated articulation gaiter (sealed end-cap) ─────────────────────

/**
 * Sealed silver-grey gaiter over [zWall → zEnd]. Replaces the shared black
 * jointCap look with the 14T's silver pleated covers while keeping the
 * cross-section fully closed (no open hull interior on a lone section).
 * dir: -1 → front (−Z) end, +1 → rear (+Z) end.
 */
function gaiterCap(mb, { zWall, zEnd, dir }) {
  const zN = Math.min(zWall, zEnd);
  const zF = Math.max(zWall, zEnd);
  const shrink = 0.34;
  const profile = [
    [-HW + 0.05, Y0], [HW - 0.05, Y0],
    [HW - 0.05, YTOP], [HW - shrink, ROOFTOP - 0.06],
    [-HW + shrink, ROOFTOP - 0.06], [-(HW - 0.05), YTOP],
  ];
  mb.prismZ('gaiter14t', profile, zN, zF, { capStart: true, capEnd: true });
  // vertical pleats: alternating proud ribs in light/dark grey
  const n = 4;
  const step = (zF - zN) / n;
  for (let i = 0; i < n; i++) {
    const light = i % 2 === 0;
    mb.box(light ? 'gaiter14t' : 'gaiterDk14t', {
      x: 0, y: (Y0 + YTOP) / 2 + 0.03, z: zN + step * (i + 0.5),
      w: light ? W - 0.06 : W - 0.16, h: YTOP - Y0 - 0.02, d: step * 0.72,
    });
  }
}

// ── Roof equipment helpers (Braník roof shots) ───────────────────────────────

/** Dark equipment well between the silver fascias. */
function roofWell(mb, { z0, z1 }) {
  mb.box('roofwell14t', {
    x: 0, y: ROOFTOP + 0.02, z: (z0 + z1) / 2,
    w: 2 * (HW - 0.36), h: 0.05, d: z1 - z0 - 0.04,
  });
}

/** Bundle of cables crossing an articulation end. */
function cableRun(mb, { zEnd, dir, n = 5 }) {
  for (let i = 0; i < n; i++) {
    const x = -0.45 + (i / (n - 1)) * 0.9;
    mb.cylinder('trim', {
      x, y: ROOFTOP + 0.075, z: zEnd - dir * 0.42,
      r: 0.022, len: 0.8, axis: 'z', seg: 5,
    });
  }
}

/** Cream perforated resistor panel (flat, slightly proud of the well). */
function meshPanel(mb, { z, w = 1.35, d = 1.15 }) {
  mb.box('mesh14t', { x: 0, y: ROOFTOP + 0.075, z, w, h: 0.07, d, bevel: 0.02 });
}

/** Black equipment box in the roof well. */
function roofBox(mb, { z, w = 1.3, h = 0.26, d = 1.4, x = 0, mat = 'trim' }) {
  mb.box(mat, { x, y: ROOFTOP + 0.04 + h / 2, z, w, h, d, bevel: Math.min(0.05, h / 3) });
}

/** Yellow-armed single-arm pantograph, semi-raised (photos: LEKOV, beige). */
function pantograph14t(mb, { z }) {
  const yR = ROOFTOP + 0.04;
  mb.box('trim', { x: 0, y: yR + 0.05, z, w: 1.05, h: 0.1, d: 1.6 });
  for (const [dx, dz] of [[-0.42, -0.65], [0.42, -0.65], [-0.42, 0.65], [0.42, 0.65]]) {
    mb.cylinder('trim', { x: dx, y: yR + 0.09, z: z + dz, r: 0.04, len: 0.1, axis: 'y', seg: 6 });
  }
  const yB = yR + 0.1;
  const elbowZ = z - 0.7, headZ = z + 0.5;
  const yE = yR + 0.34, yH = yR + 0.4;
  for (const sx of [-1, 1]) {
    mb.beam('brass', [sx * 0.14, yB, z + 0.6], [sx * 0.04, yE, elbowZ], 0.05);
  }
  mb.beam('brass', [0, yE, elbowZ], [0, yH, headZ], 0.045);
  mb.beam('brass', [0, yB + 0.02, z + 0.7], [0, yE - 0.07, elbowZ + 0.12], 0.025);
  mb.box('trim', { x: 0, y: yH + 0.03, z: headZ, w: 1.75, h: 0.05, d: 0.24 });
  for (const sx of [-1, 1]) {
    mb.beam('trim', [sx * 0.85, yH + 0.03, headZ - 0.1], [sx * 0.68, yH - 0.09, headZ - 0.3], 0.03);
  }
}

/** Green LED side-destination strip at the top of a window (inside the glass). */
function sideDisplay(mb, { side, z, w = 0.55 }) {
  mb.rectX('displayGrn14t', side * (HW - 0.035), z - w / 2, z + w / 2, WINTOP - 0.2, WINTOP - 0.06, side);
}

// ── Cab flank with the raked trapezoid driver's window ───────────────────────

/**
 * First 1.35 m of the cab side wall: driver's window whose front edge slants
 * parallel to the windshield rake (photos: 9155, 9149).
 */
function cabFlank(mb, { side, z0, len = 1.35, slant = 0.8 }) {
  const x = side * HW;
  const xg = side * (HW - 0.045);
  const z1 = z0 + len;
  mb.rectX('silver14t', x, z0, z1, Y0, SILL, side);
  mb.rectX('silver14t', x, z0, z1, WINTOP, YTOP, side);
  // front filler triangle above the slant edge
  mb.fan('silver14t', [[x, SILL, z0], [x, WINTOP, z0 + slant], [x, WINTOP, z0]], [side, 0, 0]);
  // raked glass trapezoid
  mb.fan('glass', [
    [xg, SILL, z0 + 0.02], [xg, SILL, z1], [xg, WINTOP, z1], [xg, WINTOP, z0 + slant + 0.02],
  ], [side, 0, 0]);
  // jambs
  const [xi, xo] = side > 0 ? [xg, x] : [x, xg];
  mb.rectY('silver14t', SILL, xi, xo, z0 + 0.02, z1, 1);
  mb.rectY('silver14t', WINTOP, xi, xo, z0 + slant, z1, -1);
  mb.rectZ('silver14t', z1, xi, xo, SILL, WINTOP, -1);
  mb.quad('silver14t',
    [x, SILL, z0 + 0.02], [xg, SILL, z0 + 0.02],
    [xg, WINTOP, z0 + slant + 0.02], [x, WINTOP, z0 + slant + 0.02]);
  return z1;
}

// ── Sections ─────────────────────────────────────────────────────────────────

/** Section a — cab; silver, driver's door, red rear panel; bogie. */
function head() {
  const mb = new MeshBuilder();
  const z0 = -LLONG / 2 + NOSE;
  const z1 = LLONG / 2 - GAITER;
  const zRed = z1 - 1.45; // red livery starts BEFORE the articulation (photos)
  const common = { xw: HW, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP };

  // right side: raked driver window | silver driver door | window || red window
  let z = cabFlank(mb, { side: 1, z0 });
  buildWall(mb, {
    ...common, side: 1, z0: z, mats: SIL,
    segments: wallSegs(zRed - z, [
      { t: 'door', len: 0.85, mat: 'silver14t', topMat: 'silver14t' },
      { t: 'run' },
    ], { targetWin: 1.3, pillar: 0.14 }),
  });
  buildWall(mb, {
    ...common, side: 1, z0: zRed, mats: RED,
    segments: wallSegs(z1 - zRed, [{ t: 'run' }], { targetWin: 1.2, pillar: 0.12 }),
  });
  // left side: raked window | silver windows || red window (+ green display)
  z = cabFlank(mb, { side: -1, z0 });
  buildWall(mb, {
    ...common, side: -1, z0: z, mats: SIL,
    segments: wallSegs(zRed - z, [{ t: 'run' }], { targetWin: 1.35, pillar: 0.14 }),
  });
  buildWall(mb, {
    ...common, side: -1, z0: zRed, mats: RED,
    segments: wallSegs(z1 - zRed, [{ t: 'run' }], { targetWin: 1.2, pillar: 0.12 }),
  });
  sideDisplay(mb, { side: -1, z: zRed + 0.72 });

  roofSlab(mb, { z0, z1, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: 'silver14t', shrink: 0.34 });
  floorPlate(mb, { z0, z1, xw: HW, y0: Y0 });
  underframe(mb, { z0: z0 + 0.15, z1: z1 - 0.15, width: W, y0: Y0 });
  bogie(mb, { z: 0.55, width: W });
  gaiterCap(mb, { zWall: z1, zEnd: LLONG / 2, dir: 1 });
  cabEnd(mb, { dirZ: -1, zJoin: z0 });

  // roof: silver dome stays clean over the cab; behind it the dark well with
  // the big grey HVAC box, cream resistor panels and black kit (Braník shots)
  roofWell(mb, { z0: z0 + 0.9, z1 });
  mb.box('roof', { x: 0, y: ROOFTOP + 0.19, z: 0.05, w: 1.35, h: 0.34, d: 1.05, bevel: 0.05 });
  meshPanel(mb, { z: 1.25 });
  meshPanel(mb, { z: 2.45, d: 0.95 });
  roofBox(mb, { z: -0.75, w: 1.1, h: 0.18, d: 0.7 });
  cableRun(mb, { zEnd: LLONG / 2, dir: 1 });
  return mb;
}

/**
 * Sections b/d — short, suspended, red. One grey double door:
 * b → door at the FRONT + green display window (pantograph over the front),
 * d → window first, door at the REAR (mirror). Photos: 9149 side.
 */
function short({ pantograph = false, doorsOpen = false } = {}) {
  const mb = new MeshBuilder();
  const z0 = -LSHORT / 2 + GAITER;
  const z1 = LSHORT / 2 - GAITER;
  const common = { xw: HW, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, mats: RED, doorLowY: DOORLOW };
  const items = pantograph
    ? [{ t: 'panel', len: 0.12 }, { t: 'door', len: DOOR }, { t: 'run' }]
    : [{ t: 'run' }, { t: 'door', len: DOOR }, { t: 'panel', len: 0.12 }];
  buildWall(mb, { ...common, side: 1, z0, doorsOpen, segments: wallSegs(z1 - z0, items, { targetWin: 1.5, pillar: 0.14 }) });
  buildWall(mb, { ...common, side: -1, z0, segments: wallSegs(z1 - z0, [{ t: 'run' }], { targetWin: 1.4, pillar: 0.14 }) });
  sideDisplay(mb, { side: 1, z: pantograph ? z0 + DOOR + 0.6 : z1 - DOOR - 0.6 });

  roofSlab(mb, { z0, z1, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: 'silver14t', shrink: 0.34 });
  floorPlate(mb, { z0, z1, xw: HW, y0: Y0 });
  underframe(mb, { z0: z0 + 0.1, z1: z1 - 0.1, width: W, y0: Y0 });
  gaiterCap(mb, { zWall: z0, zEnd: -LSHORT / 2, dir: -1 });
  gaiterCap(mb, { zWall: z1, zEnd: LSHORT / 2, dir: 1 });

  roofWell(mb, { z0, z1 });
  if (pantograph) {
    pantograph14t(mb, { z: -0.55 });
    roofBox(mb, { z: 1.25, w: 1.15, h: 0.2, d: 1.0 });
  } else {
    roofBox(mb, { z: 0.15, w: 1.3, h: 0.3, d: 1.55 });
    roofBox(mb, { z: -1.35, w: 1.0, h: 0.16, d: 0.7 });
  }
  cableRun(mb, { zEnd: -LSHORT / 2, dir: -1 });
  cableRun(mb, { zEnd: LSHORT / 2, dir: 1 });
  return mb;
}

/** Section c — long middle, red, TWO grey doors on the right, center bogie. */
function mid({ doorsOpen = false } = {}) {
  const mb = new MeshBuilder();
  const z0 = -LLONG / 2 + GAITER;
  const z1 = LLONG / 2 - GAITER;
  const common = { xw: HW, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, mats: RED, doorLowY: DOORLOW };
  buildWall(mb, {
    ...common, side: 1, z0, doorsOpen,
    segments: wallSegs(z1 - z0, [
      { t: 'panel', len: 0.12 },
      { t: 'door', len: DOOR },
      { t: 'run', weight: 1 },
      { t: 'door', len: DOOR },
      { t: 'run', weight: 1.6 },
    ], { targetWin: 1.45, pillar: 0.14 }),
  });
  buildWall(mb, { ...common, side: -1, z0, segments: wallSegs(z1 - z0, [{ t: 'run' }], WIN) });

  roofSlab(mb, { z0, z1, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: 'silver14t', shrink: 0.34 });
  floorPlate(mb, { z0, z1, xw: HW, y0: Y0 });
  underframe(mb, { z0: z0 + 0.1, z1: z1 - 0.1, width: W, y0: Y0 });
  bogie(mb, { z: 0, width: W });
  gaiterCap(mb, { zWall: z0, zEnd: -LLONG / 2, dir: -1 });
  gaiterCap(mb, { zWall: z1, zEnd: LLONG / 2, dir: 1 });

  roofWell(mb, { z0, z1 });
  roofBox(mb, { z: -2.0, w: 1.35, h: 0.28, d: 1.6 });
  meshPanel(mb, { z: 0.2, w: 1.25, d: 1.3 });
  roofBox(mb, { z: 1.9, w: 1.15, h: 0.2, d: 1.2 });
  cableRun(mb, { zEnd: -LLONG / 2, dir: -1 });
  cableRun(mb, { zEnd: LLONG / 2, dir: 1 });
  return mb;
}

/** Section e — tail cab: grey door at the FRONT, red to the rear helmet. */
function tail({ doorsOpen = false } = {}) {
  const mb = new MeshBuilder();
  const z0 = -LLONG / 2 + GAITER;
  const z1 = LLONG / 2 - NOSE;
  const zSil = z1 - 0.55; // silver only right at the helmet
  const common = { xw: HW, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, doorLowY: DOORLOW };
  // right: grey door at the front, then windows, silver stub at the tail
  buildWall(mb, {
    ...common, side: 1, z0, mats: RED, doorsOpen,
    segments: wallSegs(zSil - z0, [
      { t: 'panel', len: 0.12 },
      { t: 'door', len: DOOR },
      { t: 'run' },
    ], { targetWin: 1.45, pillar: 0.14 }),
  });
  buildWall(mb, {
    ...common, side: 1, z0: zSil, mats: SIL,
    segments: [{ t: 'panel', len: z1 - zSil }],
  });
  // left: red windows, silver stub
  buildWall(mb, {
    ...common, side: -1, z0, mats: RED,
    segments: wallSegs(zSil - z0, [{ t: 'run' }], WIN),
  });
  buildWall(mb, {
    ...common, side: -1, z0: zSil, mats: SIL,
    segments: [{ t: 'panel', len: z1 - zSil }],
  });

  roofSlab(mb, { z0, z1, xw: HW, yTop: YTOP, roofTop: ROOFTOP, mat: 'silver14t', shrink: 0.34 });
  floorPlate(mb, { z0, z1, xw: HW, y0: Y0 });
  underframe(mb, { z0: z0 + 0.15, z1: z1 - 0.15, width: W, y0: Y0 });
  bogie(mb, { z: -0.55, width: W });
  gaiterCap(mb, { zWall: z0, zEnd: -LLONG / 2, dir: -1 });
  cabEnd(mb, { dirZ: 1, zJoin: z1 });

  roofWell(mb, { z0, z1: z1 - 0.9 });
  mb.box('roof', { x: 0, y: ROOFTOP + 0.17, z: -0.15, w: 1.3, h: 0.3, d: 1.0, bevel: 0.05 });
  meshPanel(mb, { z: -1.35, d: 0.95 });
  roofBox(mb, { z: -2.45, w: 1.15, h: 0.2, d: 1.0 });
  cableRun(mb, { zEnd: -LLONG / 2, dir: -1 });
  return mb;
}

export function sections() {
  const eLong = { length: LLONG, width: W };
  const eShort = { length: LSHORT, width: W };
  // 14t-a carries only the narrow silver DRIVER door → no doors-open variant
  return [
    { key: '14t-a', build: head, expect: eLong },
    {
      key: '14t-b', expect: eShort,
      build: () => short({ pantograph: true }),
      buildOpen: () => short({ pantograph: true, doorsOpen: true }),
    },
    {
      key: '14t-c', expect: eLong,
      build: () => mid(),
      buildOpen: () => mid({ doorsOpen: true }),
    },
    {
      key: '14t-d', expect: eShort,
      build: () => short(),
      buildOpen: () => short({ doorsOpen: true }),
    },
    {
      key: '14t-e', expect: eLong,
      build: () => tail(),
      buildOpen: () => tail({ doorsOpen: true }),
    },
  ];
}
