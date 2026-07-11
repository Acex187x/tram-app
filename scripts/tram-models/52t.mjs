// Škoda 52T "ForCity Plus Praha" — 5 sections, ~32 m, unidirectional, newest
// fleet flagship (deliveries 2025+). ACCURACY ROUND 2 — rebuilt against photo
// references of cars 9503/9506 (Wikimedia Commons: Barrandov, Hlubočepy,
// Vltavská, Dvorecký most, linka 12; 2025-2026):
//
//   * FRONT: one glossy BLACK helmet — windshield, display zone and roof crown
//     are a single black dome from y≈1.2 up and over the roof, wrapping ~1 m
//     back along the rooftop. Body-white A-pillar strips flank the glass from
//     bumper to y≈2.55, then the black crown spans full width.
//   * Bumper band: body-white 0.3→1.2 m with a ~0.95 m wide PID-red vertical
//     stripe down the center (red "pid" wordmark on the left cheek, fleet
//     number right). Škoda logo centered on the black mask.
//   * Headlights: compact LED clusters (3-dot DRL + projector) recessed in the
//     black mask's lower corners at y≈1.42, x≈±0.8.
//   * Amber destination display INSIDE the black at y≈2.7, ~1.35 m wide.
//   * LIVERY (bright PID red on near-white warm grey, alternating blocks):
//     roof-edge band red over rear half of section a + all of b, and all of d;
//     big red lower-body blocks (skirt→sill) on b, c and most of e, carrying
//     white "pid" logos; everything else body white. Left side mirrors.
//   * Window band: tall continuous dark glass 1.42→2.72 with slim black
//     pillars; doors are full-height dark glass leaves dropping to the skirt.
//   * Doors (right side only): 1 at rear of a, 2 in c, 2 in front half of e.
//   * Pantographs on b and d; bogies under a/e (swivel) + b/d (semi-swivel),
//     c suspended. Deep smooth body-colored skirts, light grey roof with low
//     AC pods, black sensor pod behind the front crown.

import {
  MATERIALS, MeshBuilder, arcZAtX, buildSectionShell, destinationDisplay,
  mirrorArcZ, noseArc, roofPod, roofSlab, singleArmPantograph, wallSegs,
} from './lib.mjs';

// ── local palette (hex sampled from 2025-26 photos; keys namespaced "52t") ───
Object.assign(MATERIALS, {
  '52tBody': { hex: 0xe9ebe9, rough: 0.45, metal: 0.08 }, // near-white warm grey
  '52tRed': { hex: 0xc81a2b, rough: 0.48, metal: 0.06 }, // bright PID livery red
  // metal 0.35 (palette cap) suppresses the washed-out diffuse so the helmet
  // reads glossy BLACK in sunlight like the photos, not grey
  '52tMask': { hex: 0x08090c, rough: 0.32, metal: 0.35 },
  '52tGlassF': {
    hex: 0x0a0d12, rough: 0.28, metal: 0.35,
    emissive: [0.012, 0.014, 0.017], // barely-there cab-interior hint
  },
  '52tGlass': {
    hex: 0x111419, rough: 0.3, metal: 0.3,
    emissive: [0.02, 0.023, 0.026], // continuous dark side band
  },
  '52tRoof': { hex: 0xc2c6c8, rough: 0.55, metal: 0.12 },
});

const W = 2.5;
const HW = W / 2;
const LEND = 6.9; // a, e
const LMIDB = 5.8; // b, d
const LMIDC = 5.6; // c
const Y0 = 0.3; // skirt bottom
const SILL = 1.42; // bottom of the dark window band
const WINTOP = 2.72; // top of the glass band
const YTOP = 2.92; // top of the side wall (slim fascia above windows)
const ROOFTOP = 3.12;
const NOSE = 1.3;

const MATS = {
  lower: '52tBody',
  upper: '52tBody',
  pillar: '52tMask', // slim black pillars → continuous dark band
  glass: '52tGlass',
  door: '52tGlass', // full-height dark glass door leaves
  frame: '52tMask',
};
const WIN = { targetWin: 1.55, pillar: 0.11 };
const DOOR = { t: 'door', len: 1.3, lowY: Y0, topMat: '52tBody' };

// ── livery overlays ──────────────────────────────────────────────────────────

/** z-spans of the doors that wallSegs will produce for `items`. */
function doorSpans(z0, wallLen, items) {
  const spans = [];
  let z = z0;
  for (const s of wallSegs(wallLen, items, WIN)) {
    if (s.t === 'door') spans.push([z, z + s.len]);
    z += s.len;
  }
  return spans;
}

/** Subtract door spans from [a, b] → list of panel-only sub-ranges. */
function cutSpans([a, b], holes) {
  let ranges = [[a, b]];
  for (const [h0, h1] of holes) {
    const next = [];
    for (const [r0, r1] of ranges) {
      if (h1 <= r0 || h0 >= r1) { next.push([r0, r1]); continue; }
      if (h0 > r0 + 0.02) next.push([r0, h0]);
      if (h1 < r1 - 0.02) next.push([h1, r1]);
    }
    ranges = next;
  }
  return ranges;
}

/** Red lower-body block (skirt→sill) on both walls, skipping door bays. */
function redLower(mb, range, rightHoles = []) {
  for (const [za, zb] of cutSpans(range, rightHoles)) {
    mb.box('52tRed', {
      x: HW + 0.008, y: (Y0 + SILL) / 2, z: (za + zb) / 2,
      w: 0.016, h: SILL - Y0, d: zb - za,
    });
  }
  const [za, zb] = range; // left side has no doors — continuous block
  mb.box('52tRed', {
    x: -(HW + 0.008), y: (Y0 + SILL) / 2, z: (za + zb) / 2,
    w: 0.016, h: SILL - Y0, d: zb - za,
  });
}

/** Red roof-edge band (fascia above windows + wrap over the roof slab edge). */
function redRoofBand(mb, [za, zb]) {
  for (const sx of [-1, 1]) {
    mb.box('52tRed', {
      x: sx * (HW + 0.008), y: (WINTOP + YTOP) / 2, z: (za + zb) / 2,
      w: 0.016, h: YTOP - WINTOP, d: zb - za,
    });
  }
  roofSlab(mb, {
    z0: za, z1: zb, xw: HW + 0.01,
    yTop: YTOP + 0.012, roofTop: ROOFTOP + 0.01, mat: '52tRed',
  });
}

/** Small white "pid" wordmark plate on a red lower block. */
function pidLogo(mb, { z, y = 0.95 }) {
  for (const sx of [-1, 1]) {
    mb.box('white', { x: sx * (HW + 0.018), y, z, w: 0.012, h: 0.16, d: 0.42 });
  }
}

// ── cab mask (front dirZ −1 / tail dirZ +1) ──────────────────────────────────

const N = 20; // arc facets — smooth rounded helmet
const arcAt3 = (arc, y) => arc.map(([x, z]) => [x, y, z]);

/** Ribbon between two arcs split into material slices by point index. */
function ribbonSliced(mb, arc0, y0, arc1, y1, parts) {
  for (const p of parts) {
    mb.ribbon(
      p.mat,
      arcAt3(arc0, y0).slice(p.i0, p.i1 + 1),
      arcAt3(arc1, y1).slice(p.i0, p.i1 + 1),
    );
  }
}

function cabMask(mb, { dirZ }) {
  const zA = LEND / 2 - NOSE; // |z| where the walls start
  const mk = (depth, hw = HW, p = 0.72) => {
    const a = noseArc({ hw, zStart: -zA, depth, p, n: N });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  // side-view profile: bumper leans slightly out, windshield nearly upright
  // (gentle rake), then the black crown curls hard back over the roof.
  const aSkirt = mk(1.12);
  const aBump0 = mk(1.18);
  const aBump1 = mk(1.3); // deepest point → nose tip at ±L/2 exactly
  const aMask1 = mk(1.26);
  const aGlass1 = mk(1.06);
  const aDisp1 = mk(0.88);
  const aCrown1 = mk(0.5, HW - 0.3, 0.8);

  // material slices: [0..3] & [17..20] = body-white A-pillar strips;
  // bumper band center [7..13] = the wide PID-red front stripe.
  const pill = (mat) => [
    { i0: 0, i1: 3, mat: '52tBody' },
    { i0: 3, i1: 17, mat },
    { i0: 17, i1: 20, mat: '52tBody' },
  ];
  const stripe = [
    { i0: 0, i1: 7, mat: '52tBody' },
    { i0: 7, i1: 13, mat: '52tRed' },
    { i0: 13, i1: 20, mat: '52tBody' },
  ];
  ribbonSliced(mb, aSkirt, Y0, aBump0, 0.46, stripe); // skirt lip tuck-in
  ribbonSliced(mb, aBump0, 0.46, aBump1, 1.2, stripe); // bumper band
  // lamp zone: black wraps the full corner (photos: mask meets the side wall)
  mb.ribbon('52tMask', arcAt3(aBump1, 1.2), arcAt3(aMask1, 1.6));
  ribbonSliced(mb, aMask1, 1.6, aGlass1, 2.55, pill('52tGlassF')); // windshield
  mb.ribbon('52tMask', arcAt3(aGlass1, 2.55), arcAt3(aDisp1, 2.86)); // display
  mb.ribbon('52tMask', arcAt3(aDisp1, 2.86), arcAt3(aCrown1, ROOFTOP)); // crown
  // black cap over the crown arc (arc endpoints sit on the wall-start plane,
  // so the arc itself is a closed plan polygon) + glossy roof wrap behind it
  mb.fan('52tMask', arcAt3(aCrown1, ROOFTOP), [0, 1, 0]);
  const zWrap0 = dirZ < 0 ? -zA : zA - 1.05;
  roofSlab(mb, {
    z0: zWrap0, z1: zWrap0 + 1.05, xw: HW + 0.006,
    yTop: YTOP + 0.008, roofTop: ROOFTOP + 0.008, mat: '52tMask',
  });
  // black swoosh: mask height carries onto the cab sides above the window band
  for (const sx of [-1, 1]) {
    mb.box('52tMask', {
      x: sx * (HW + 0.006), y: (WINTOP + YTOP) / 2, z: zWrap0 + 0.425,
      w: 0.012, h: YTOP - WINTOP, d: 0.85,
    });
  }

  const zOf = (depth) => -dirZ * (zA + depth);
  /** z of the sloped mask surface at (x, y): lerp two arcs by height. */
  const surfZ = (x, y, arcLo, yLo, arcHi, yHi) => {
    const t = (y - yLo) / (yHi - yLo);
    return arcZAtX(arcLo, x) + t * (arcZAtX(arcHi, x) - arcZAtX(arcLo, x));
  };

  // headlight clusters recessed in the mask's lower corners: dark pocket +
  // LED DRL strip + round projector lens (tail: red taillight strips)
  for (const sx of [-1, 1]) {
    const x = sx * 0.78;
    const zs = surfZ(x, 1.42, aBump1, 1.2, aMask1, 1.6);
    mb.box('black', { x, y: 1.42, z: zs + dirZ * 0.02, w: 0.46, h: 0.22, d: 0.08 });
    if (dirZ < 0) {
      mb.box('headlight', { x: x - sx * 0.06, y: 1.44, z: zs + dirZ * 0.075, w: 0.26, h: 0.08, d: 0.04 });
      mb.cylinder('headlight', {
        x: x + sx * 0.17, y: 1.42, z: zs + dirZ * 0.075, r: 0.055, len: 0.04, axis: 'z', seg: 10,
      });
    } else {
      mb.box('taillight', { x, y: 1.44, z: zs + dirZ * 0.075, w: 0.3, h: 0.07, d: 0.04 });
    }
  }

  // Škoda winged-arrow roundel on the black mask center (x=0 → tip depth)
  mb.cylinder('silver', {
    x: 0, y: 1.62, z: surfZ(0, 1.62, aMask1, 1.6, aGlass1, 2.55) - dirZ * 0.012,
    r: 0.085, len: 0.03, axis: 'z', seg: 12,
  });
  // anti-collision LiDAR box low on the mask
  mb.box('black', { x: 0, y: 1.32, z: surfZ(0, 1.32, aBump1, 1.2, aMask1, 1.6) - dirZ * 0.01, w: 0.3, h: 0.12, d: 0.06 });

  // amber destination display inside the black band — flat face sitting just
  // proud of the dome tip so it never sinks behind the curved band
  const wDisp = dirZ < 0 ? 1.05 : 0.55;
  const zDisp = surfZ(0, 2.7, aGlass1, 2.55, aDisp1, 2.86);
  destinationDisplay(mb, { zFace: zDisp + dirZ * 0.025, y: 2.7, w: wDisp, h: 0.2, dir: dirZ });

  if (dirZ < 0) {
    // red "pid" wordmark on the left bumper cheek
    const zl = surfZ(-0.85, 0.88, aBump0, 0.46, aBump1, 1.2);
    mb.box('52tRed', { x: -0.85, y: 0.88, z: zl + dirZ * 0.012, w: 0.3, h: 0.13, d: 0.05 });
    // single large windshield wiper parked diagonally
    const zw = (y) => surfZ(0.1, y, aMask1, 1.6, aGlass1, 2.55) - dirZ * 0.035;
    mb.beam('black', [0.55, 1.7, zw(1.7)], [-0.35, 2.35, zw(2.35)], 0.03);
  } else {
    const zl = surfZ(0.85, 0.88, aBump0, 0.46, aBump1, 1.2);
    mb.box('52tRed', { x: 0.85, y: 0.88, z: zl + dirZ * 0.012, w: 0.3, h: 0.13, d: 0.05 });
  }
  // slim camera-mirror pods high on the A-pillars (stay inside width gate)
  for (const sx of [-1, 1]) {
    mb.box('black', {
      x: sx * (HW + 0.02), y: 2.5, z: -dirZ * (zA + 0.1), w: 0.06, h: 0.12, d: 0.2,
    });
  }
}

/** Smooth body-colored skirt panels over a bogie (52T's clean flush look). */
function bogieCovers(mb, { z }) {
  for (const sx of [-1, 1]) {
    mb.box('52tBody', { x: sx * (HW + 0.01), y: 0.62, z, w: 0.02, h: 0.64, d: 2.5 });
  }
}

// ── sections ─────────────────────────────────────────────────────────────────

/** Shared shell call; returns wall extent for livery painting. */
function shell(mb, { length, front, rear, rightItems, bogies, doorsOpen }) {
  const { z0, z1 } = buildSectionShell(mb, {
    length, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front, rear,
    noseDepthF: front === 'cab' ? NOSE : 0,
    noseDepthR: rear === 'cab' ? NOSE : 0,
    rightItems,
    leftItems: [{ t: 'run' }],
    mats: MATS,
    roofMat: '52tRoof',
    bogies,
    winOpts: WIN,
    doorsOpen,
  });
  return { z0, z1 };
}

function buildEnd({ tail, doorsOpen }) {
  const mb = new MeshBuilder();
  const rightItems = tail
    ? [{ t: 'run', weight: 0.3 }, { ...DOOR }, { t: 'run', weight: 0.7 }, { ...DOOR }, { t: 'run', weight: 2.0 }]
    : [{ t: 'run', weight: 2.0 }, { ...DOOR }, { t: 'run', weight: 0.35 }];
  const { z0, z1 } = shell(mb, {
    length: LEND,
    front: tail ? 'joint' : 'cab',
    rear: tail ? 'cab' : 'bellows',
    rightItems,
    bogies: [tail ? 1.2 : -1.2],
    doorsOpen,
  });
  cabMask(mb, { dirZ: tail ? 1 : -1 });
  bogieCovers(mb, { z: tail ? 1.2 : -1.2 });
  const holes = doorSpans(z0, z1 - z0, rightItems);
  if (tail) {
    // red lower block over the door half of e (rear of block fades to white tail)
    redLower(mb, [z0, 0.65], holes);
    pidLogo(mb, { z: 0.4 });
  } else {
    // red roof band starts behind the black crown wrap and runs into section b
    redRoofBand(mb, [z0 + 1.1, z1]);
  }
  // low AC pod + black sensor pod tucked behind the cab crown
  roofPod(mb, { z: tail ? -1.3 : 1.3, y: ROOFTOP, w: 1.55, h: 0.18, d: 2.1, mat: '52tRoof' });
  roofPod(mb, {
    z: tail ? (LEND / 2 - NOSE - 1.35) : -(LEND / 2 - NOSE - 1.35),
    y: ROOFTOP, w: 0.7, h: 0.12, d: 0.6, mat: 'black',
  });
  return mb;
}

function buildMid({ length, pantograph, redRoof, doorsOpen }) {
  const mb = new MeshBuilder();
  const rightItems = pantograph
    ? [{ t: 'run' }]
    : [{ t: 'run', weight: 0.5 }, { ...DOOR }, { t: 'run', weight: 1 }, { ...DOOR }, { t: 'run', weight: 0.5 }];
  const { z0, z1 } = shell(mb, {
    length,
    front: 'joint',
    rear: 'bellows',
    rightItems,
    bogies: pantograph ? [0] : [], // b/d semi-swivel bogies, c suspended
    doorsOpen,
  });
  if (pantograph) {
    singleArmPantograph(mb, { z: 0, yRoof: ROOFTOP });
    for (const zc of [-1.95, 1.95]) {
      roofPod(mb, { z: zc, y: ROOFTOP, w: 1.35, h: 0.15, d: 1.0, mat: '52tRoof' });
    }
    bogieCovers(mb, { z: 0 });
    if (redRoof) redRoofBand(mb, [z0, z1]);
    // b also carries a red lower block (livery photo: red skirt band under b)
    if (redRoof === 'b') redLower(mb, [z0, z1]);
  } else {
    roofPod(mb, { z: 0, y: ROOFTOP, w: 1.55, h: 0.18, d: 2.2, mat: '52tRoof' });
    const holes = doorSpans(z0, z1 - z0, rightItems);
    redLower(mb, [z0, z1], holes); // section c: big red lower block w/ pid
    pidLogo(mb, { z: (z0 + z1) / 2 });
  }
  return mb;
}

export function sections() {
  const eEnd = { length: LEND, width: W };
  // b/d carry pantographs and have NO passenger doors → no open variant
  return [
    {
      key: '52t-a', expect: eEnd,
      build: () => buildEnd({ tail: false }),
      buildOpen: () => buildEnd({ tail: false, doorsOpen: true }),
    },
    { key: '52t-b', build: () => buildMid({ length: LMIDB, pantograph: true, redRoof: 'b' }), expect: { length: LMIDB, width: W } },
    {
      key: '52t-c', expect: { length: LMIDC, width: W },
      build: () => buildMid({ length: LMIDC }),
      buildOpen: () => buildMid({ length: LMIDC, doorsOpen: true }),
    },
    { key: '52t-d', build: () => buildMid({ length: LMIDB, pantograph: true, redRoof: true }), expect: { length: LMIDB, width: W } },
    {
      key: '52t-e', expect: eEnd,
      build: () => buildEnd({ tail: true }),
      buildOpen: () => buildEnd({ tail: true, doorsOpen: true }),
    },
  ];
}
