// Škoda 15T "ForCity Alfa" — 3 sections, 31.4 m, the iconic modern Prague
// tram (Patrik Kotas design). ACCURACY ROUND 2, rebuilt against 13 reference
// photos (Wikimedia Commons, regs 9201/9203/9209/9220/9237/9258/9389).
//
// Signature look (heights measured off photos, body ≈ 3.1 m tall):
//   * horizontal banding wraps CONTINUOUSLY around the whole car:
//     black under-lip 0.16–0.30, RED bumper/skirt 0.30–0.96, SILVER band
//     0.96–1.44 (reg no., headlights, logo), continuous gloss-BLACK glazing
//     ribbon 1.48–2.72 (pillars invisible), silver cant strip 2.72–2.90,
//     dark charcoal roof; the RED cap only over the cab dome.
//   * face: blunt rounded-rect plan (flat central ~1.3 m, corner r ≈ 0.5),
//     huge raked windshield (top recessed ~0.65 m ≈ 27°), destination display
//     behind the glass top-center, black "chin" dip below the windshield
//     center, red A-pillar strips framing the glass, TWIN ROUND headlights in
//     the silver band + slim white DRL slots in the red bumper.
//   * doors: full-height dark glass leaves w/ thin red edge strips (2 double
//     doors/section, right side only + narrow driver door), dropping through
//     the silver/red bands; deep red skirts + proud bogie covers hide the
//     wheels; articulation joints wear LIGHT GREY cover panels.

import {
  MATERIALS, MeshBuilder, arcZAtX, buildSectionShell, destinationDisplay,
  mirrorArcZ, resamplePolyline, roofPod, roundLamp, singleArmPantograph,
  wallSegs,
} from './lib.mjs';

// Local 15T materials (photo-sampled) — injected into the shared palette under
// 15t-prefixed keys so other builders are unaffected.
Object.assign(MATERIALS, {
  red15: { hex: 0xdf3a24, rough: 0.35, metal: 0.08 }, // DPP bright traffic red
  silver15: { hex: 0xe0e3e6, rough: 0.36, metal: 0.26 }, // bright band silver
  roofDark15: { hex: 0x4b5054, rough: 0.62, metal: 0.12 }, // charcoal roof
  doorDark15: { hex: 0x1c1f24, rough: 0.4, metal: 0.05 }, // dark glass door leaf
  blackGloss15: { hex: 0x0e1116, rough: 0.28, metal: 0.05 }, // masked pillars/gaskets
  glass15: { hex: 0x0c0f13, rough: 0.3, metal: 0, emissive: [0.018, 0.02, 0.023] },
});

const W = 2.46;
const HW = W / 2;
const L = 10.3;
const L2 = L / 2;

// Vertical datum (photo-measured livery boundaries)
const LIP_Y0 = 0.16; // black under-lip bottom
const SKIRT_Y0 = 0.3; // red skirt bottom
const Y0 = 0.95; // wall bottom = silver band bottom (red skirt built separately)
const SILL = 1.45; // silver band top = black glazing ribbon bottom
const WINTOP = 2.72; // glazing ribbon top
const YTOP = 2.9; // silver cant strip top
const ROOFTOP = 3.08;
const NOSE = 1.55; // cab-end depth (bumper chin reaches the section end plane)
const DOOR_LOW = 0.35; // passenger door drop (low floor)

const MATS = {
  lower: 'silver15',
  upper: 'silver15', // cant-rail strip above the glazing ribbon
  pillar: 'blackGloss15', // pillars vanish into the black band
  glass: 'glass15',
  door: 'doorDark15',
  frame: 'blackGloss15',
};
// Long panes + hairline pillars → one continuous black ribbon
const WIN = { targetWin: 2.3, pillar: 0.08 };

// ── Cab face: horizontal ribbon bands over blunt rounded-rect plan arcs ──────
// Levels define the vertical profile: y, forward depth d (chin at 0.6–0.96
// protrudes most, windshield rakes back 0.65 m), half-width and corner radius.
const LEVELS = [
  { y: 0.16, d: 1.26, hw: HW - 0.1, r: 0.4 },
  { y: 0.3, d: 1.4, hw: HW - 0.03, r: 0.46 },
  { y: 0.62, d: 1.55, hw: HW - 0.005, r: 0.52 }, // bumper chin (frontmost)
  { y: 0.96, d: 1.49, hw: HW, r: 0.52 },
  { y: 1.01, d: 1.41, hw: HW, r: 0.5 }, // bumper→silver step
  { y: 1.44, d: 1.35, hw: HW, r: 0.5 },
  { y: 1.48, d: 1.32, hw: HW, r: 0.54 }, // windshield base gasket
  { y: 1.98, d: 1.12, hw: HW, r: 0.6 },
  { y: 2.42, d: 0.9, hw: HW, r: 0.65 },
  { y: 2.74, d: 0.68, hw: HW - 0.01, r: 0.68 }, // windshield top
  { y: 2.96, d: 0.5, hw: HW - 0.11, r: 0.6 }, // red roof cap
  { y: 3.08, d: 0.24, hw: HW - 0.32, r: 0.48 }, // roof dome (meets roof slab)
];
const BAND_MATS = [
  'trim', 'red15', 'red15', 'blackGloss15', 'silver15', 'blackGloss15',
  'glass15', 'glass15', 'glass15', 'red15', 'roofDark15',
];

/** Blunt rounded-rectangle plan arc (left → right), tip at zStart − depth. */
function roundedArc({ hw, zStart, depth, r, n = 20 }) {
  const rr = Math.min(r, depth * 0.9, hw * 0.8);
  const zc = zStart - depth + rr; // corner-circle center z
  const pts = [[-hw, zStart]];
  const k = 6; // quarter-arc facets
  for (let i = 0; i <= k; i++) {
    const th = Math.PI + (i / k) * (Math.PI / 2); // 180° → 270°
    pts.push([-hw + rr + rr * Math.cos(th), zc + rr * Math.sin(th)]);
  }
  for (let i = 0; i <= k; i++) {
    const th = Math.PI * 1.5 + (i / k) * (Math.PI / 2); // 270° → 360°
    pts.push([hw - rr + rr * Math.cos(th), zc + rr * Math.sin(th)]);
  }
  pts.push([hw, zStart]);
  return resamplePolyline(pts, n);
}

function face(mb, { dir }) {
  const isFront = dir < 0;
  const zEdge = isFront ? -(L2 - NOSE) : L2 - NOSE; // wall start/end plane
  /** oriented plan arc for a given level (or interpolated params) */
  const A = ({ d, hw, r }) => {
    const a = roundedArc({ hw, zStart: -(L2 - NOSE), depth: d, r });
    return isFront ? a : mirrorArcZ(a);
  };
  /** level params interpolated at height y */
  const lerpLevel = (y) => {
    let i = 0;
    while (i < LEVELS.length - 2 && LEVELS[i + 1].y < y) i++;
    const a = LEVELS[i], b = LEVELS[i + 1];
    const t = Math.min(1, Math.max(0, (y - a.y) / (b.y - a.y)));
    return { d: a.d + (b.d - a.d) * t, hw: a.hw + (b.hw - a.hw) * t, r: a.r + (b.r - a.r) * t };
  };
  /** face z at (x, y) — for lamps/wipers/mirrors sitting on the curved skin */
  const zAt = (x, y) => arcZAtX(A(lerpLevel(y)), x);

  // Band stack (each pair of adjacent levels shares one arc → watertight)
  const arcs = LEVELS.map((lv) => A(lv));
  for (let i = 0; i < BAND_MATS.length; i++) {
    const lo = arcs[i].map(([x, z]) => [x, LEVELS[i].y, z]);
    const hi = arcs[i + 1].map(([x, z]) => [x, LEVELS[i + 1].y, z]);
    mb.ribbon(BAND_MATS[i], lo, hi);
  }
  // top cap: dome arc ends exactly at (±hw, zEdge) → arc-chord fan closes it
  mb.fan('roofDark15', arcs[LEVELS.length - 1].map(([x, z]) => [x, ROOFTOP, z]), [0, 1, 0]);

  // Black "chin" dip below the windshield center (reg-number patch between the
  // silver headlight cheeks) — hugs the silver band, 18 mm proud.
  {
    const y0 = 1.03, y1 = 1.46;
    const xs = [];
    for (let i = 0; i <= 6; i++) xs.push(-0.62 + (i / 6) * 1.24);
    if (!isFront) xs.reverse();
    const proud = isFront ? -0.018 : 0.018;
    const lo = xs.map((x) => [x, y0, zAt(x, y0 + 0.02) + proud]);
    const hi = xs.map((x) => [x, y1, zAt(x, y1 - 0.02) + proud]);
    mb.ribbon('blackGloss15', lo, hi);
  }

  // Red A-pillar strips framing the windshield (roof cap → silver band)
  for (const sx of [-1, 1]) {
    const x = sx * 1.1;
    const ys = [1.48, 1.98, 2.42, 2.76];
    for (let i = 0; i < ys.length - 1; i++) {
      const p0 = [x, ys[i], zAt(x, ys[i]) + (isFront ? -0.02 : 0.02)];
      const p1 = [x, ys[i + 1], zAt(x, ys[i + 1]) + (isFront ? -0.02 : 0.02)];
      mb.beam('red15', p0, p1, 0.07, 0.05);
    }
  }

  if (isFront) {
    // Twin round headlights in the silver band, both sides
    for (const sx of [-1, 1]) {
      roundLamp(mb, { x: sx * 0.66, y: 1.18, zFace: zAt(sx * 0.66, 1.18) - 0.01, r: 0.09, dir: -1 });
      roundLamp(mb, { x: sx * 0.9, y: 1.18, zFace: zAt(sx * 0.9, 1.18) - 0.01, r: 0.09, dir: -1 });
      // slim white DRL slot in the red bumper
      const zb = zAt(sx * 0.55, 0.6);
      mb.box('black', { x: sx * 0.55, y: 0.6, z: zb + 0.01, w: 0.36, h: 0.09, d: 0.05 });
      mb.rectZ('headlight', zb - 0.017, sx * 0.55 - 0.15, sx * 0.55 + 0.15, 0.575, 0.625, -1);
    }
    // destination display glowing just behind the windshield top center
    destinationDisplay(mb, { zFace: zAt(0, 2.56) - 0.035, y: 2.56, w: 1.0, h: 0.18, dir: -1 });
    // two long wipers parked leaning right
    mb.beam('black', [-0.6, 1.52, zAt(-0.6, 1.52) - 0.025], [-0.15, 2.4, zAt(-0.15, 2.4) - 0.025], 0.035);
    mb.beam('black', [0.12, 1.52, zAt(0.12, 1.52) - 0.025], [0.58, 2.42, zAt(0.58, 2.42) - 0.025], 0.035);
  } else {
    // Rear: twin round red taillights + round bumper reds + small display
    for (const sx of [-1, 1]) {
      roundLamp(mb, { x: sx * 0.66, y: 1.18, zFace: zAt(sx * 0.66, 1.18) + 0.01, r: 0.085, mat: 'taillight', dir: 1 });
      roundLamp(mb, { x: sx * 0.9, y: 1.18, zFace: zAt(sx * 0.9, 1.18) + 0.01, r: 0.085, mat: 'taillight', dir: 1 });
      roundLamp(mb, { x: sx * 0.52, y: 0.66, zFace: zAt(sx * 0.52, 0.66) + 0.01, r: 0.055, mat: 'taillight', dir: 1 });
    }
    destinationDisplay(mb, { zFace: zAt(0, 2.56) + 0.035, y: 2.56, w: 0.55, h: 0.17, dir: 1 });
    mb.beam('black', [-0.35, 1.55, zAt(-0.35, 1.55) + 0.025], [0.15, 2.35, zAt(0.15, 2.35) + 0.025], 0.035);
  }

  // Škoda logo disc on the chin patch
  mb.cylinder('silver15', {
    x: 0, y: 1.12, z: zAt(0, 1.12) + dir * 0.028, r: 0.055, len: 0.025, axis: 'z', seg: 10,
  });

  // Mirror pods at the windshield side edges (both ends on the real car)
  for (const sx of [-1, 1]) {
    const zm = zEdge + dir * -0.12;
    mb.beam('black', [sx * (HW - 0.06), 2.34, zm], [sx * 1.26, 2.36, zm + dir * 0.06], 0.03);
    mb.box('black', { x: sx * 1.27, y: 2.28, z: zm + dir * 0.06, w: 0.06, h: 0.2, d: 0.12 });
  }
}

// ── Skirts, bogie covers, door edges, side display ───────────────────────────

function sideFurniture(mb, { z0, z1, rightSegs, leftSegs }) {
  for (const [side, segs] of [[1, rightSegs], [-1, leftSegs]]) {
    // continuous black under-lip below the skirt line
    mb.rectX('trim', side * (HW - 0.07), z0, z1, LIP_Y0, SKIRT_Y0 + 0.01, side);
    let z = z0;
    let shownDisplay = false;
    for (const s of segs) {
      const zn = z + s.len;
      const drops = s.t === 'door' && (s.lowY ?? DOOR_LOW) < 0.6;
      if (s.t !== 'door' || !drops) {
        // deep red skirt band (wraps continuously from the bumper)
        mb.rectX('red15', side * (HW - 0.006), z, zn, SKIRT_Y0, Y0 + 0.01, side);
      }
      if (s.t === 'door' && drops) {
        // thin red leaf-edge strips on the dark glass leaves
        for (const [za, zb] of [[z + 0.06, z + 0.11], [zn - 0.11, zn - 0.06]]) {
          mb.rectX('red15', side * (HW - 0.02), za, zb, 0.38, 2.6, side);
        }
        if (side > 0 && !shownDisplay) {
          // amber route display inside the black band above the first door
          const zc = (z + zn) / 2;
          mb.rectX('display', side * (HW - 0.008), zc - 0.3, zc + 0.3, 2.26, 2.42, side);
          shownDisplay = true;
        }
      }
      z = zn;
    }
  }
}

/** Slightly proud red cover boxes hiding the wheels (deep-skirt look). */
function bogieCover(mb, { z, d = 2.1 }) {
  mb.box('red15', { x: 0, y: (SKIRT_Y0 + Y0) / 2 + 0.005, z, w: W + 0.02, h: Y0 - SKIRT_Y0 + 0.03, d, bevel: 0.05 });
}

/** Articulation covers continuing the livery banding across the joint. */
function jointCovers(mb, { zWall, zEnd }) {
  const zA = Math.min(zWall, zEnd) + 0.005, zB = Math.max(zWall, zEnd) - 0.005;
  for (const side of [-1, 1]) {
    const x = side * (HW + 0.002);
    mb.rectX('red15', x, zA, zB, SKIRT_Y0 + 0.04, Y0, side); // red skirt
    mb.rectX('silver15', x, zA, zB, Y0, SILL, side); // silver band
    mb.rectX('trim', x, zA, zB, SILL, WINTOP, side); // dark bellows
    mb.rectX('silver15', x, zA, zB, WINTOP, YTOP - 0.02, side); // cant strip
  }
}

// ── Section assembly ─────────────────────────────────────────────────────────

function build({ cab, tail, pantograph, doorsOpen }) {
  const mb = new MeshBuilder();
  // driver door steps over a bogie (no drop) and never opens for boarding
  const driverDoor = { t: 'door', len: 0.78, lowY: Y0, noOpen: true };
  const door = () => ({ t: 'door', len: 1.32 });
  // run weights tuned so no drop-door overlaps a bogie cover
  const rightItems = cab
    ? [driverDoor, { t: 'run', weight: 1.4 }, door(), { t: 'run', weight: 1.55 }, door(), { t: 'run', weight: 2.1 }]
    : tail
      ? [{ t: 'run', weight: 0.55 }, door(), { t: 'run', weight: 1.9 }, door(), { t: 'run', weight: 1.75 }]
      : [{ t: 'run', weight: 1.0 }, door(), { t: 'run', weight: 1.8 }, door(), { t: 'run', weight: 1.2 }];
  const leftItems = [{ t: 'run' }]; // doorless left side: one continuous ribbon

  const bogies = cab ? [-2.55, 3.9] : tail ? [2.4] : [3.9];
  const { z0, z1 } = buildSectionShell(mb, {
    length: L, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: cab ? 'cab' : 'joint',
    rear: tail ? 'cab' : 'bellows',
    noseDepthF: cab ? NOSE : 0,
    noseDepthR: tail ? NOSE : 0,
    rightItems,
    leftItems,
    mats: MATS,
    roofMat: 'roofDark15',
    doorLowY: DOOR_LOW,
    glassInset: 0.015,
    // 4 bogies per tram: ends + Jacobs under each articulation (owned by the
    // section ahead of it so the consist shows exactly one bogie per joint).
    bogies,
    roofShrink: 0.32,
    winOpts: WIN,
    doorsOpen,
  });

  sideFurniture(mb, {
    z0, z1,
    rightSegs: wallSegs(z1 - z0, rightItems, WIN),
    leftSegs: wallSegs(z1 - z0, leftItems, WIN),
  });
  for (const bz of bogies) bogieCover(mb, { z: bz });

  if (cab) face(mb, { dir: -1 });
  if (tail) face(mb, { dir: 1 });
  if (!cab) jointCovers(mb, { zWall: z0, zEnd: -L2 });
  if (!tail) jointCovers(mb, { zWall: z1, zEnd: L2 });

  // ── Roof equipment: charcoal, low and wide (photo layout) ──
  if (cab) {
    roofPod(mb, { z: -0.4, y: ROOFTOP, w: 1.6, h: 0.2, d: 2.6, mat: 'roofDark15' });
    roofPod(mb, { z: 2.6, y: ROOFTOP, w: 1.3, h: 0.16, d: 1.6, mat: 'roofDark15' });
    mb.box('roofDark15', { x: 0, y: ROOFTOP + 0.04, z: 1.1, w: 0.45, h: 0.08, d: 4.4 });
    mb.box('trim', { x: 0, y: ROOFTOP + 0.04, z: -2.2, w: 0.3, h: 0.08, d: 0.5 }); // antenna base
  } else if (tail) {
    roofPod(mb, { z: 0.4, y: ROOFTOP, w: 1.6, h: 0.2, d: 2.6, mat: 'roofDark15' });
    roofPod(mb, { z: -2.6, y: ROOFTOP, w: 1.3, h: 0.16, d: 1.6, mat: 'roofDark15' });
    mb.box('roofDark15', { x: 0, y: ROOFTOP + 0.04, z: -1.1, w: 0.45, h: 0.08, d: 4.4 });
  } else {
    roofPod(mb, { z: 0.9, y: ROOFTOP, w: 1.55, h: 0.3, d: 2.6, mat: 'roofDark15' });
    roofPod(mb, { z: 3.6, y: ROOFTOP, w: 1.2, h: 0.18, d: 1.4, mat: 'roofDark15' });
    mb.box('roofDark15', { x: 0, y: ROOFTOP + 0.04, z: -0.9, w: 0.45, h: 0.08, d: 3.0 });
  }
  if (pantograph) singleArmPantograph(mb, { z: -2.6, yRoof: ROOFTOP });
  return mb;
}

export function sections() {
  const expect = { length: L, width: W };
  return [
    {
      key: '15t-a', expect,
      build: () => build({ cab: true }),
      buildOpen: () => build({ cab: true, doorsOpen: true }),
    },
    {
      key: '15t-b', expect,
      build: () => build({ pantograph: true }),
      buildOpen: () => build({ pantograph: true, doorsOpen: true }),
    },
    {
      key: '15t-c', expect,
      build: () => build({ tail: true }),
      buildOpen: () => build({ tail: true, doorsOpen: true }),
    },
  ];
}
