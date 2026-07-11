// Tatra T3 (historic, museum livery) — single rigid car 14.1 m × 2.5 m.
// THE iconic 1960s Prague tram. ACCURACY ROUND 2 — rebuilt against reference
// photos of museum car 6102 (Wikimedia Commons: "Tram Tatra T3 Praha 6102",
// "…6102-zezadu", "Praha, Nové Město, Florenc-Těšnov, T3 6102, zadní čelo",
// "Smíchovské nádraží, T3 6102", "Albertov, historická Tatra T3 (detail)").
//
// Measured observations driving this geometry (heights in meters, ground = 0):
//  * one HUGE wrap-around panoramic windshield, sill ~1.30, top ~2.36, only a
//    hairline center seam (red gasket), no corner pillars — glass wraps to the
//    cab sides; the cream brow overhangs the glass with a chrome drip strip,
//  * recessed dark destination PILL flush in the brow (gold text), FRONT only,
//  * twin chrome-ring headlights LOW in the red mask (y≈0.63, x≈±0.60), gold
//    fleet number between them, chrome bumper strip at 0.42–0.47 wrapping the
//    nose, deep cream apron below with a maroon lip,
//  * red belt top = window sill (1.55) along the sides, SWEEPING DOWN to 1.14
//    around the cab corners (cream widens under the windshield) — signature,
//  * silver sill strip + silver skirt bead; cream skirt 0.30–0.60 with maroon
//    lip 0.22–0.30 and CUTOUTS over both bogies exposing the wheels,
//  * folding doors with FOUR tall narrow panes reaching low (~1.02), red leaf
//    panel below, 3 doors right side (2 windows, then 3, then 1 between),
//  * left side: driver window + long window run + red louvre vent panel with
//    chrome loop frame near the rear,
//  * rear: even larger window (sill 1.50, two hairline seams), red panel with
//    access hatch + gold number + two oval amber/red taillight pills, round
//    red reflectors on the cream apron, no destination display,
//  * clean cream domed roof (no grey boxes), tall RED scissor pantograph.

import {
  MATERIALS, MeshBuilder, arcZAtX, coupler, floorPlate, mirrorArcZ,
  noseArc, underframe,
} from './lib.mjs';

// ── Local palette (sampled from the 6102 photo set; namespaced t3h*) ─────────
Object.assign(MATERIALS, {
  t3hRed: { hex: 0xc4232b, rough: 0.34, metal: 0.06 }, // fresh vermilion coach paint
  t3hMaroon: { hex: 0x6e181b, rough: 0.42, metal: 0.06 }, // lip + pinstripes
  t3hCream: { hex: 0xf1e5c3, rough: 0.42, metal: 0.04 }, // warm ivory
  t3hGlass: {
    hex: 0x101d24, rough: 0.12, metal: 0.0,
    emissive: [0.012, 0.016, 0.02], // blue-green tint, faint interior
  },
  t3hChrome: { hex: 0xdfe4e8, rough: 0.25, metal: 0.35 }, // bright trim strips
  t3hGold: { hex: 0xc09a42, rough: 0.4, metal: 0.35 }, // fleet number
  t3hAmber: { hex: 0xe08a1e, rough: 0.3, metal: 0, emissive: [0.9, 0.45, 0.06] },
});

const L = 14.1;
const W = 2.5;
const HW = W / 2;
const NOSE = 1.52; // plan depth of each rounded mask (max band depth below)
const ZS = L / 2 - NOSE; // wall extent / mask start plane (5.53)

// vertical datums (from photo proportions, body height 3.02)
const Y0 = 0.63; // red belt bottom along the sides
const SILL = 1.55; // side window sill = belt top
const WINTOP = 2.35;
const VENT = 2.10; // sliding-vent divider
const YTOP = 2.72; // wall top (maroon roofline pinstripe 2.70–2.72)
const ROOF = 3.02;
const SK_BEAD = 0.60; // silver skirt bead 0.60–0.63
const SK_LIP = 0.30; // maroon lip 0.22–0.30
const SK_BOT = 0.22;
const MASK_BELT_TOP = 1.14; // red mask top at the cab corner (sweep low end)
const REAR_BELT_TOP = 1.44;
const ARC_N = 10;
const ARC_P = 0.72;

export const EXPECT = { length: L, width: W };

// ── Mask level stacks: [y, planDepth, halfWidth] head-to-toe ────────────────
// Depth peaks across the red mask (0.80–1.14) → defines the 14.1 m bbox tip.
// The windshield rakes back 1.48→1.10, the brow leans back OUT to 1.15
// (visor overhang), then the dome pulls in matching the roof profile.

const FRONT_LEVELS = [
  [0.24, 1.16, 1.19], // apron bottom (maroon lip), tucked in
  [0.32, 1.26, 1.22], // lip top → cream apron
  [0.42, 1.40, 1.24], // apron top / chrome bumper strip
  [0.47, 1.44, 1.25], // bumper strip top → red mask
  [0.80, 1.52, 1.25], // red bulge (proudest ring)
  [1.14, 1.52, 1.25], // red mask top
  [1.17, 1.51, 1.25], // maroon pinstripe
  [1.30, 1.48, 1.25], // cream band → windshield sill
  [2.36, 1.10, 1.24], // windshield top (strong rake)
  [2.40, 1.11, 1.24], // chrome drip strip
  [2.70, 1.15, 1.24], // cream brow (destination pill), leans over the glass
  [2.72, 1.13, 1.25], // maroon roofline pinstripe wraps the brow
  [2.84, 1.02, 1.21], // roof dome — matches side roof profile
  [2.94, 0.80, 1.08],
  [3.02, 0.40, 0.60],
];
const FRONT_MATS = [
  't3hMaroon', 't3hCream', 't3hChrome', 't3hRed', 't3hRed', 't3hMaroon',
  't3hCream', 't3hGlass', 't3hChrome', 't3hCream', 't3hMaroon',
  't3hCream', 't3hCream', 't3hCream',
];

// Rear: red panel straight up to the (even larger) rear window, no pinstripe
// band — a chrome strip sits directly under the glass.
const REAR_LEVELS = [
  [0.24, 1.16, 1.19],
  [0.32, 1.26, 1.22],
  [0.42, 1.40, 1.24],
  [0.47, 1.44, 1.25],
  [0.80, 1.52, 1.25],
  [1.44, 1.50, 1.25], // red all the way up
  [1.50, 1.47, 1.25], // chrome strip under the window
  [2.38, 1.10, 1.24], // rear window (slightly taller than front)
  [2.42, 1.11, 1.24],
  [2.70, 1.15, 1.24],
  [2.72, 1.13, 1.25],
  [2.84, 1.02, 1.21],
  [2.94, 0.80, 1.08],
  [3.02, 0.40, 0.60],
];
const REAR_MATS = [
  't3hMaroon', 't3hCream', 't3hChrome', 't3hRed', 't3hRed', 't3hChrome',
  't3hGlass', 't3hChrome', 't3hCream', 't3hMaroon',
  't3hCream', 't3hCream', 't3hCream',
];

/** Build per-level plan arcs for one mask. dirZ −1 = front, +1 = rear. */
function maskArcs(levels, dirZ) {
  return levels.map(([, depth, hw]) => {
    const a = noseArc({ hw, zStart: -ZS, depth, p: ARC_P, n: ARC_N });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  });
}

/** z on the mask surface at (x, y), interpolated between level arcs. */
function maskZ(levels, arcs, x, y) {
  for (let i = 0; i < levels.length - 1; i++) {
    const [y0] = levels[i];
    const [y1] = levels[i + 1];
    if (y >= y0 && y <= y1) {
      const t = (y - y0) / (y1 - y0 || 1);
      return arcZAtX(arcs[i], x) * (1 - t) + arcZAtX(arcs[i + 1], x) * t;
    }
  }
  return arcZAtX(arcs[arcs.length - 1], x);
}

/** Lift a plan arc to 3D at height y. */
const arcAt = (arc, y) => arc.map(([x, z]) => [x, y, z]);

/** Round lamp with a CHROME ring. dir = outward z sign of the face. */
function chromeLamp(mb, { x, y, zFace, r, mat, dir }) {
  mb.cylinder('t3hChrome', {
    x, y, z: zFace + dir * 0.02, r: r + 0.025, len: 0.09, axis: 'z', seg: 10, caps: false,
  });
  mb.cylinder(mat, {
    x, y, z: zFace + dir * 0.035, r, len: 0.05, axis: 'z', seg: 10, caps: true, capMat: mat,
  });
}

/** Horizontal oval taillight pill: chrome ring + amber (outer) / red halves. */
function ovalLamp(mb, { x, y, zFace, dir }) {
  const zc = zFace + dir * 0.02;
  mb.box('t3hChrome', { x, y, z: zc, w: 0.30, h: 0.135, d: 0.05, bevel: 0.05 });
  const sx = Math.sign(x) || 1;
  mb.box('t3hAmber', { x: x + sx * 0.068, y, z: zc + dir * 0.02, w: 0.105, h: 0.09, d: 0.035 });
  mb.box('taillight', { x: x - sx * 0.068, y, z: zc + dir * 0.02, w: 0.105, h: 0.09, d: 0.035 });
}

/** One rounded T3 mask. dirZ −1 → front (display + headlights + wipers). */
function t3Mask(mb, dirZ) {
  const levels = dirZ < 0 ? FRONT_LEVELS : REAR_LEVELS;
  const matList = dirZ < 0 ? FRONT_MATS : REAR_MATS;
  const arcs = maskArcs(levels, dirZ);
  for (let i = 0; i < levels.length - 1; i++) {
    mb.ribbon(matList[i], arcAt(arcs[i], levels[i][0]), arcAt(arcs[i + 1], levels[i + 1][0]));
  }
  // top cap (cream) over the last arc
  const top = arcs[arcs.length - 1];
  mb.fan('t3hCream', arcAt(top, levels[levels.length - 1][0]), [0, 1, 0]);

  const glassLo = dirZ < 0 ? 1.30 : 1.50;
  const glassHi = dirZ < 0 ? 2.36 : 2.38;
  const zAt = (x, y) => maskZ(levels, arcs, x, y);
  const out = (z, d) => z + dirZ * d; // push outward (front −Z / rear +Z)

  // hairline glass seams with red gasket look (front: center; rear: ±0.62)
  const seams = dirZ < 0 ? [0] : [-0.62, 0.62];
  for (const sxm of seams) {
    mb.beam('t3hMaroon',
      [sxm, glassLo + 0.02, out(zAt(sxm, glassLo + 0.02), 0.008)],
      [sxm, glassHi - 0.02, out(zAt(sxm, glassHi - 0.02), 0.008)], 0.022, 0.02);
  }

  if (dirZ < 0) {
    // destination pill: thin chrome ring + black casing + warm emissive face,
    // sitting flush in the brow
    const py = 2.54;
    const zc = zAt(0, py);
    mb.box('t3hChrome', { x: 0, y: py, z: out(zc, 0.012), w: 1.16, h: 0.30, d: 0.03, bevel: 0.10 });
    mb.box('black', { x: 0, y: py, z: out(zc, 0.02), w: 1.10, h: 0.26, d: 0.035, bevel: 0.09 });
    mb.rectZ('display', out(zc, 0.04), -0.49, 0.49, py - 0.08, py + 0.08, dirZ);

    // twin chrome-ring headlights LOW in the red mask
    for (const sx of [-1, 1]) {
      chromeLamp(mb, {
        x: sx * 0.60, y: 0.63, zFace: zAt(sx * 0.60, 0.63), r: 0.115,
        mat: 'headlight', dir: -1,
      });
    }
    // gold fleet number between the headlights
    mb.rectZ('t3hGold', out(zAt(0, 0.63), 0.008), -0.18, 0.18, 0.575, 0.685, dirZ);

    // chrome wipers parked in a V from the windshield base
    for (const sx of [-1, 1]) {
      const a = [sx * 0.16, 1.36, out(zAt(sx * 0.16, 1.36), 0.012)];
      const b = [sx * 0.60, 2.06, out(zAt(sx * 0.60, 2.06), 0.012)];
      mb.beam('t3hChrome', a, b, 0.02, 0.016);
      mb.beam('black', b, [sx * 0.42, 2.20, out(zAt(sx * 0.42, 2.20), 0.012)], 0.018, 0.014);
    }
    // round mirror on the right A-pillar (cream housing, chrome stalk)
    mb.beam('t3hChrome', [1.14, 2.14, -ZS + 0.10], [1.26, 2.20, -ZS - 0.16], 0.022);
    mb.box('t3hCream', { x: 1.26, y: 2.14, z: -ZS - 0.18, w: 0.035, h: 0.16, d: 0.13, bevel: 0.04 });
    // safety trough under the apron
    mb.box('trim', { x: 0, y: 0.15, z: -(L / 2) + 0.55, w: 1.6, h: 0.10, d: 0.36 });
  } else {
    // access hatch top-center of the red panel (maroon outline, red lid)
    const hz = zAt(0, 1.24);
    mb.box('t3hMaroon', { x: 0, y: 1.24, z: out(hz, 0.006), w: 0.56, h: 0.30, d: 0.012 });
    mb.box('t3hRed', { x: 0, y: 1.24, z: out(hz, 0.012), w: 0.52, h: 0.26, d: 0.012 });
    // gold fleet number above the taillights
    mb.rectZ('t3hGold', out(zAt(0, 0.98), 0.008), -0.18, 0.18, 0.925, 1.035, dirZ);
    // twin oval taillight pills (amber outer / red inner)
    for (const sx of [-1, 1]) {
      ovalLamp(mb, { x: sx * 0.48, y: 0.62, zFace: zAt(sx * 0.48, 0.62), dir: 1 });
    }
    // round red reflectors on the cream apron
    for (const sx of [-1, 1]) {
      mb.cylinder('taillight', {
        x: sx * 0.72, y: 0.335, z: zAt(sx * 0.72, 0.335) + 0.012,
        r: 0.045, len: 0.025, axis: 'z', seg: 8, caps: true, capMat: 'taillight',
      });
    }
  }
  coupler(mb, { zEnd: dirZ * (L / 2), dir: dirZ });
}

// ── Side walls ───────────────────────────────────────────────────────────────

const ss = (t) => t * t * (3 - 2 * t); // smoothstep for the belt sweep

/**
 * Cab-corner sweep: the red belt top dives from the side sill (1.55) to the
 * mask belt top around the corner, cream widening above; the skirt bands
 * simultaneously morph from the side stack to the front apron stack.
 * yMask/ySide — belt-top heights at the mask end / interior end.
 * maskEnd: 'lo' → mask side is at z0 (front), 'hi' → at z1 (rear).
 */
function sweepPanel(mb, side, z0, z1, yMask, ySide, maskEnd) {
  const x = side * HW;
  const N = 3;
  const beltAt = (t) => {
    const tm = maskEnd === 'lo' ? t : 1 - t; // 0 at mask end → yMask
    return yMask + (ySide - yMask) * ss(tm);
  };
  // skirt stack heights [maroonLo, maroonHi, creamHi, silverHi, (red bottom)]
  const stackMask = [0.24, 0.32, 0.42, 0.47];
  const stackSide = [SK_BOT, SK_LIP, SK_BEAD, Y0];
  const stackAt = (t) => {
    const tm = maskEnd === 'lo' ? t : 1 - t;
    return stackMask.map((v, i) => v + (stackSide[i] - v) * tm);
  };
  const quadOut = (mat, za, ya0, ya1, zb, yb0, yb1, dx = 0) => {
    const xx = side * (HW + dx);
    const a = [xx, ya0, za], b = [xx, yb0, zb], c = [xx, yb1, zb], d = [xx, ya1, za];
    if (side > 0) mb.quad(mat, a, b, c, d);
    else mb.quad(mat, b, a, d, c);
  };
  for (let i = 0; i < N; i++) {
    const t0 = i / N, t1 = (i + 1) / N;
    const za = z0 + (z1 - z0) * t0, zb = z0 + (z1 - z0) * t1;
    const b0 = beltAt(t0), b1 = beltAt(t1);
    const s0 = stackAt(t0), s1 = stackAt(t1);
    quadOut('t3hMaroon', za, s0[0], s0[1], zb, s1[0], s1[1]); // lip
    quadOut('t3hCream', za, s0[1], s0[2], zb, s1[1], s1[2]); // skirt cream
    quadOut('t3hChrome', za, s0[2], s0[3], zb, s1[2], s1[3]); // bead/bumper strip
    quadOut('t3hRed', za, s0[3], b0, zb, s1[3], b1); // belt
    quadOut('t3hMaroon', za, b0, b0 + 0.03, zb, b1, b1 + 0.03, 0.004); // pinstripe
    quadOut('t3hCream', za, b0 + 0.03, WINTOP, zb, b1 + 0.03, WINTOP); // cream above
  }
  // upper cream band + roofline pinstripe
  mb.rectX('t3hCream', x, z0, z1, WINTOP, 2.70, side);
  mb.rectX('t3hMaroon', x, z0, z1, 2.70, YTOP, side);
}

/**
 * One side wall. items: [{t:'sweepF'|'sweepR'|'panel'|'win'|'door', len}].
 * The belt (red + silver sill strip) and the upper cream band + maroon
 * roofline pinstripe are drawn as CONTINUOUS runs between doors/sweeps
 * (fewer quads); segments only add their middle band.
 * Doors: 4 tall narrow panes reaching low, red leaf panel below.
 * doorsOpen: folding leaves bunched at the jambs (~80% open), dark doorway
 * with a warm interior glow behind (map-scale dwell read).
 */
function t3Wall(mb, side, items, doorsOpen = false) {
  const x = side * HW;
  const xg = side * (HW - 0.05); // glass plane

  // continuous belt + top runs across panel/win stretches
  let z = -ZS;
  let runStart = null;
  const flush = (zEnd) => {
    if (runStart === null) return;
    mb.rectX('t3hRed', x, runStart, zEnd, Y0, 1.51, side);
    mb.rectX('t3hChrome', x, runStart, zEnd, 1.51, SILL, side);
    runStart = null;
  };
  for (const it of items) {
    const z1 = z + it.len;
    if (it.t === 'panel' || it.t === 'win') {
      if (runStart === null) runStart = z;
    } else {
      flush(z);
    }
    if (it.t !== 'sweepF' && it.t !== 'sweepR') {
      // cream band above windows + maroon pinstripe run over doors too
      if (runStart === null && it.t === 'door') {
        mb.rectX('t3hCream', x, z, z1, WINTOP, 2.70, side);
        mb.rectX('t3hMaroon', x, z, z1, 2.70, YTOP, side);
      }
    }
    z = z1;
  }
  flush(z);
  // top bands over the whole panel/win extent in one go per gap
  z = -ZS;
  let topStart = null;
  const flushTop = (zEnd) => {
    if (topStart === null) return;
    mb.rectX('t3hCream', x, topStart, zEnd, WINTOP, 2.70, side);
    mb.rectX('t3hMaroon', x, topStart, zEnd, 2.70, YTOP, side);
    topStart = null;
  };
  for (const it of items) {
    const z1 = z + it.len;
    if (it.t === 'panel' || it.t === 'win') {
      if (topStart === null) topStart = z;
    } else {
      flushTop(z);
    }
    z = z1;
  }
  flushTop(z);

  z = -ZS;
  for (const it of items) {
    const z1 = z + it.len;
    if (it.t === 'sweepF') {
      sweepPanel(mb, side, z, z1, MASK_BELT_TOP, SILL, 'lo');
    } else if (it.t === 'sweepR') {
      sweepPanel(mb, side, z, z1, REAR_BELT_TOP, SILL, 'hi');
    } else if (it.t === 'panel') {
      mb.rectX('t3hCream', x, z, z1, SILL, WINTOP, side);
    } else if (it.t === 'win') {
      mb.rectX('t3hGlass', xg, z, z1, SILL, WINTOP, side);
      // sill/header jambs + silver sliding-vent divider (classic Tatra glazing)
      const [xi, xo] = side > 0 ? [xg, x] : [x, xg];
      mb.rectY('t3hCream', SILL, xi, xo, z, z1, 1);
      mb.rectY('t3hCream', WINTOP, xi, xo, z, z1, -1);
      mb.rectX('t3hChrome', side * (HW - 0.035), z, z1, VENT - 0.015, VENT + 0.015, side);
    } else if (it.t === 'door') {
      const f = 0.05; // cream frame strips
      const yd = 0.38; // leaf bottom (below belt, as real)
      const gLo = 1.02, gHi = 2.32; // tall narrow panes reach low
      const xd = side * (HW - 0.035); // leaf plane
      const xdg = side * (HW - 0.06); // pane plane
      mb.rectX('t3hCream', x, z, z + f, yd, WINTOP, side);
      mb.rectX('t3hCream', x, z1 - f, z1, yd, WINTOP, side);
      mb.rectX('t3hCream', xd, z + f, z1 - f, gHi, WINTOP, side); // header strip
      // jambs + underside step filler
      const [xi, xo] = side > 0 ? [xd, x] : [x, xd];
      mb.rectZ('t3hCream', z + f, xi, xo, yd, WINTOP, 1);
      mb.rectZ('t3hCream', z1 - f, xi, xo, yd, WINTOP, -1);
      mb.rectX('black', side * (HW - 0.06), z + f, z1 - f, SK_BOT, yd, side);
      if (!doorsOpen) {
        // red leaf panel below the panes
        mb.rectX('t3hRed', xd, z + f, z1 - f, yd, gLo, side);
        // 4 narrow panes separated by cream mullions
        const span = it.len - 2 * f;
        const mull = 0.045;
        const paneW = (span - 5 * mull) / 4;
        let pz = z + f;
        for (let p = 0; p < 5; p++) {
          mb.rectX('t3hCream', xd, pz, pz + mull, gLo, gHi, side);
          if (p < 4) mb.rectX('t3hGlass', xdg, pz + mull, pz + mull + paneW, gLo, gHi, side);
          pz += mull + paneW;
        }
        // center fold groove
        const zc = (z + z1) / 2;
        mb.rectX('black', side * (HW - 0.028), zc - 0.012, zc + 0.012, yd, gHi, side);
        mb.rectY('t3hCream', yd, xi, xo, z + f, z1 - f, -1);
      } else {
        // OPEN: folding leaves bunched at the jambs — a narrow stub each side
        const zc0 = z + f;
        const zc1 = z1 - f;
        const stub = 0.2 * ((zc1 - zc0) / 2);
        for (const [za, zb] of [[zc0, zc0 + stub], [zc1 - stub, zc1]]) {
          mb.rectX('t3hRed', xd, za, zb, yd, gLo, side);
          mb.rectX('t3hCream', xd, za, zb, gLo, gHi, side);
        }
        const zo0 = zc0 + stub;
        const zo1 = zc1 - stub;
        const xb = side * (HW - 0.30); // doorway back plane
        const [pi, po] = side > 0 ? [xb, xd] : [xd, xb];
        mb.rectX('doorwayDark', xb, zo0, zo1, yd, gHi, side);
        mb.rectX('doorGlow', side * (HW - 0.28), zo0 + 0.04, zo1 - 0.04,
          yd + 0.08, gHi - 0.3, side);
        // seal the doorway pocket
        mb.rectY('doorwayDark', yd + 0.01, pi, po, zo0, zo1, 1);
        mb.rectY('doorwayDark', gHi, pi, po, zo0, zo1, -1);
        mb.rectZ('doorwayDark', zo0, pi, po, yd, gHi, 1);
        mb.rectZ('doorwayDark', zo1, pi, po, yd, gHi, -1);
        mb.rectY('doorwayDark', yd, xi, xo, zc0, zc1, -1);
      }
    }
    z = z1;
  }
}

/**
 * Skirt with bogie cutouts. spans: [[z0,z1],…] where skirt EXISTS;
 * cutSpans: bogie cutouts that get a maroon top edging instead.
 */
function t3Skirt(mb, side, spans, cutSpans) {
  for (const [z0, z1] of spans) {
    mb.rectX('t3hChrome', side * (HW - 0.002), z0, z1, SK_BEAD, Y0, side);
    mb.rectX('t3hCream', side * (HW - 0.004), z0, z1, SK_LIP, SK_BEAD, side);
    mb.rectX('t3hMaroon', side * (HW - 0.006), z0, z1, SK_BOT, SK_LIP, side);
  }
  for (const [z0, z1] of cutSpans) {
    mb.rectX('t3hMaroon', side * (HW - 0.004), z0, z1, SK_BEAD, Y0, side);
    // vertical maroon edges of the cutout
    for (const ze of [z0, z1]) {
      mb.rectX('t3hMaroon', side * (HW - 0.004), ze - 0.02, ze + 0.02, SK_LIP, SK_BEAD, side);
    }
  }
}

/** Red louvre vent panel with chrome loop frame (left side, near the rear). */
function louvrePanel(mb, side, zc) {
  const w = 0.95, h = 0.68, yc = 1.03;
  const x0 = side * (HW + 0.008);
  mb.rectX('t3hChrome', x0, zc - w / 2 - 0.03, zc + w / 2 + 0.03, yc - h / 2 - 0.03, yc + h / 2 + 0.03, side);
  mb.rectX('t3hRed', side * (HW + 0.014), zc - w / 2, zc + w / 2, yc - h / 2, yc + h / 2, side);
  for (let i = 0; i < 6; i++) {
    const y = yc - h / 2 + 0.08 + i * 0.095;
    mb.rectX('t3hMaroon', side * (HW + 0.02), zc - w / 2 + 0.05, zc + w / 2 - 0.05, y, y + 0.022, side);
  }
}

/** Bogie: dark frame + 4 wheels, visible through the skirt cutouts. */
function t3Bogie(mb, { z }) {
  mb.box('trim', { x: 0, y: 0.45, z, w: W - 0.9, h: 0.36, d: 2.55 });
  for (const dz of [-0.95, 0.95]) {
    for (const sx of [-1, 1]) {
      mb.cylinder('black', {
        x: sx * 0.92, y: 0.33, z: z + dz, r: 0.33, len: 0.09, axis: 'x', seg: 8,
      });
      // (axle boxes omitted — hidden behind the skirt at map scale)
    }
  }
}

/** Tall RED scissor pantograph (Prague historic cars), deployed. */
function t3Pantograph(mb, { z, yRoof }) {
  const mat = 't3hRed';
  const arm = 0.045;
  for (const [dx, dz] of [[-0.48, -0.55], [0.48, -0.55], [-0.48, 0.55], [0.48, 0.55]]) {
    mb.cylinder('trim', { x: dx, y: yRoof + 0.05, z: z + dz, r: 0.04, len: 0.10, axis: 'y', seg: 6 });
  }
  const yB = yRoof + 0.11, yM = yRoof + 0.32, yT = yRoof + 0.50;
  for (const sx of [-1, 1]) {
    const x = sx * 0.44;
    mb.beam(mat, [x, yB, z - 0.55], [x, yB, z + 0.55], 0.038); // base tube
    mb.beam(mat, [x, yB, z - 0.55], [x, yM, z + 0.30], arm); // scissor diagonals
    mb.beam(mat, [x, yB, z + 0.55], [x, yM, z - 0.30], arm);
    mb.beam(mat, [x, yM, z + 0.30], [x * 0.55, yT, z + 0.04], arm * 0.85); // upper arms
    mb.beam(mat, [x, yM, z - 0.30], [x * 0.55, yT, z - 0.04], arm * 0.85);
  }
  mb.beam(mat, [-0.44, yM, z + 0.30], [0.44, yM, z + 0.30], 0.03);
  mb.beam(mat, [-0.44, yM, z - 0.30], [0.44, yM, z - 0.30], 0.03);
  // collector head: red bow + 2 dark contact strips + drooped horns
  mb.box(mat, { x: 0, y: yT + 0.02, z, w: 1.75, h: 0.04, d: 0.24 });
  for (const dz of [-0.07, 0.07]) {
    mb.box('trim', { x: 0, y: yT + 0.052, z: z + dz, w: 1.75, h: 0.022, d: 0.05 });
  }
  for (const sx of [-1, 1]) {
    mb.beam(mat, [sx * 0.875, yT + 0.02, z], [sx * 0.68, yT - 0.11, z], 0.025);
  }
}

export function buildT3Historic({ doorsOpen = false } = {}) {
  const mb = new MeshBuilder();

  // right side (front→rear): cab sweep, door, 2 windows, door, 3 windows,
  // door, quarter window, rear sweep — verified against 6102 photos
  const p = (len) => ({ t: 'panel', len });
  const w = (len) => ({ t: 'win', len });
  const rightItems = [
    { t: 'sweepF', len: 0.50 },
    { t: 'door', len: 1.30 },
    p(0.11), w(0.96), p(0.10), w(0.96), p(0.11),
    { t: 'door', len: 1.30 },
    p(0.11), w(0.96), p(0.10), w(0.96), p(0.10), w(0.96), p(0.11),
    { t: 'door', len: 1.30 },
    p(0.06), w(0.60), p(0.06),
    { t: 'sweepR', len: 0.40 },
  ];
  // left side: driver window + continuous 8-window run
  const leftItems = [
    { t: 'sweepF', len: 0.50 },
    p(0.06), w(0.70), p(0.11),
    w(1.06), p(0.10), w(1.06), p(0.10), w(1.06), p(0.10), w(1.06), p(0.10),
    w(1.06), p(0.10), w(1.06), p(0.10), w(1.06), p(0.10), w(1.06), p(0.11),
    { t: 'sweepR', len: 0.40 },
  ];
  const sum = (items) => items.reduce((s, i) => s + i.len, 0);
  for (const [name, items] of [['right', rightItems], ['left', leftItems]]) {
    const d = sum(items) - 2 * ZS;
    if (Math.abs(d) > 1e-9) throw new Error(`${name} wall off by ${d.toFixed(4)} m`);
  }

  t3Wall(mb, 1, rightItems, doorsOpen);
  t3Wall(mb, -1, leftItems);

  // skirts: solid between the bogies + tail pieces; cutouts expose the wheels
  t3Skirt(mb, 1,
    [[-2.0, -1.49], [-0.19, 2.0], [4.41, 5.13]],
    [[-3.73, -2.0], [2.0, 3.11]]);
  t3Skirt(mb, -1,
    [[-5.03, -4.4], [-2.0, 2.0], [4.4, 5.13]],
    [[-4.4, -2.0], [2.0, 4.4]]);

  // louvre vent panel on the left flank near the rear
  louvrePanel(mb, -1, 4.55);

  // smooth cream domed roof (the real T3 roof is clean, no ribs/boxes)
  const roofProfile = [
    [-HW, YTOP], [HW, YTOP], [1.21, 2.84], [1.08, 2.94], [0.60, ROOF],
    [-0.60, ROOF], [-1.08, 2.94], [-1.21, 2.84],
  ];
  mb.prismZ('t3hCream', roofProfile, -ZS, ZS);

  // masks
  t3Mask(mb, -1);
  t3Mask(mb, 1);

  // underfloor + bogies (wheels show through the skirt cutouts, as real)
  floorPlate(mb, { z0: -ZS, z1: ZS, xw: HW, y0: SK_LIP });
  underframe(mb, { z0: -ZS + 0.2, z1: ZS - 0.2, width: W, y0: SK_LIP });
  t3Bogie(mb, { z: -3.2 });
  t3Bogie(mb, { z: 3.2 });

  // clean roof kit: two low cream vent humps + tall red scissor pantograph
  mb.box('t3hCream', { x: 0, y: ROOF + 0.035, z: 1.7, w: 0.55, h: 0.07, d: 1.0 });
  mb.box('t3hCream', { x: 0, y: ROOF + 0.03, z: -3.0, w: 0.5, h: 0.06, d: 0.7 });
  t3Pantograph(mb, { z: -0.5, yRoof: ROOF });

  return mb;
}

export function sections() {
  return [{
    key: 't3',
    build: () => buildT3Historic(),
    buildOpen: () => buildT3Historic({ doorsOpen: true }),
    expect: EXPECT,
  }];
}
