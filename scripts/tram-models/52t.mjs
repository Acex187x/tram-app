// Škoda 52T "ForCity Plus Praha" — 5 sections, ~32 m, newest fleet flagship
// (deliveries 2025+). Geometry verified against 2025 photos of cars 9503/9506:
//   * Front: huge one-piece glossy BLACK windshield dome (glass from ~1.2 m to
//     ~2.9 m, wrapping the corners), grey "helmet" roof cap above it.
//   * Bumper: light grey with a single vertical dark-red center stripe.
//   * Headlights: two compact LED clusters INSIDE the black dome's lower
//     corners (no full-width strip), amber destination display behind glass.
//   * Livery: warm light-grey body, continuous black flush window band, dark
//     red full-height blocks at door bays wrapping OVER the roof edge; the
//     doorless left side mirrors the red blocks.
//   * Doors (5 × 1300 mm double-leaf, right side only): 1 at rear of section
//     a, 2 in section c, 2 in the front half of section e. b/d have none.
//   * Pantographs on b and d; bogies under a/e (outer) + b/d (center), c is
//     suspended. Smooth deep skirts, grey roof with low AC pods, black sensor
//     pod on the front roof.

import {
  MeshBuilder, arcZAtX, buildSectionShell, destinationDisplay, mirrorArcZ,
  noseArc, roofPod, roofSlab, singleArmPantograph, wallSegs,
} from './lib.mjs';

const W = 2.5;
const HW = W / 2;
const LEND = 6.9; // a, e
const LMIDB = 5.8; // b, d
const LMIDC = 5.6; // c
const Y0 = 0.3; // skirt bottom
const SILL = 1.1; // bottom of the black window band
const WINTOP = 2.48; // top of the glass
const YTOP = 2.95; // top of the side wall
const ROOFTOP = 3.14;
const NOSE = 1.25;

const MATS = {
  lower: 'greyLight',
  upper: 'greyLight',
  pillar: 'black', // continuous flush black window band
  glass: 'glass',
  door: 'redDark',
  frame: 'redDark', // red door bay surrounds
};
const WIN = { targetWin: 1.55, pillar: 0.12 };
const DOOR = { t: 'door', len: 1.3, topMat: 'redDark' };

// ── livery helpers ───────────────────────────────────────────────────────────

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

/**
 * New-PID red door bays: mirror the red block on the doorless left side
 * (below the sill + above the windows) and wrap a red band over the roof
 * edge — the 52T's signature vertical-stripe livery.
 */
function redBays(mb, rawSpans) {
  // photos: adjacent door bays (sections c, e) form ONE contiguous red block
  const spans = [];
  for (const s of rawSpans) {
    const last = spans[spans.length - 1];
    if (last && s[0] - last[1] < 1.2) last[1] = s[1];
    else spans.push([...s]);
  }
  for (const [zd0, zd1] of spans) {
    const zc = (zd0 + zd1) / 2;
    const d = zd1 - zd0 + 0.16;
    mb.box('redDark', { x: -(HW + 0.008), y: (Y0 + SILL) / 2, z: zc, w: 0.016, h: SILL - Y0, d });
    mb.box('redDark', { x: -(HW + 0.008), y: (WINTOP + YTOP) / 2, z: zc, w: 0.016, h: YTOP - WINTOP, d });
    roofSlab(mb, {
      z0: zc - d / 2, z1: zc + d / 2, xw: HW + 0.01,
      yTop: YTOP + 0.015, roofTop: ROOFTOP + 0.012, mat: 'redDark',
    });
  }
}

// ── cab mask (front dirZ −1 / tail dirZ +1) ──────────────────────────────────

function plusMask(mb, { dirZ }) {
  const zA = LEND / 2 - NOSE; // |z| where the walls start
  const arc = (depth, hw = HW, p = 0.85) => {
    const a = noseArc({ hw, zStart: -zA, depth, p, n: 18 });
    return dirZ > 0 ? mirrorArcZ(a) : a;
  };
  // blunt face with generously rounded shoulders; windshield rakes back
  const arcs = {
    lipLo: arc(1.12),
    lipHi: arc(1.2),
    bumpHi: arc(1.25), // deepest point → nose tip
    frameHi: arc(1.23),
    glassHi: arc(0.82, HW, 0.78),
    domeHi: arc(0.52, HW, 0.85),
    capHi: arc(0.3, HW - 0.22, 0.9),
  };
  noseBands(mb, {
    bands: [
      { y0: Y0, y1: 0.52, mat: 'trim', arc0: arcs.lipLo, arc1: arcs.lipHi },
      { y0: 0.52, y1: 1.06, mat: 'greyLight', arc0: arcs.lipHi, arc1: arcs.bumpHi },
      { y0: 1.06, y1: 1.2, mat: 'black', arc0: arcs.bumpHi, arc1: arcs.frameHi },
      // one-piece windshield flowing into the black dome above (52T signature)
      { y0: 1.2, y1: 2.66, mat: 'glass', arc0: arcs.frameHi, arc1: arcs.glassHi },
      { y0: 2.66, y1: 3.04, mat: 'black', arc0: arcs.glassHi, arc1: arcs.domeHi },
      // slim body-grey helmet cap over the dome
      { y0: 3.04, y1: ROOFTOP, mat: 'greyLight', arc0: arcs.domeHi, arc1: arcs.capHi },
    ],
    capMat: 'roof',
    capCorners: [],
  });

  const tipZ = arcZAtX(arcs.bumpHi, 0);
  // vertical dark-red center stripe down the grey bumper (new PID face)
  mb.box('redDark', { x: 0, y: 0.7, z: tipZ - dirZ * 0.01, w: 0.62, h: 0.74, d: 0.08 });

  // twin compact LED clusters inside the black dome's lower corners
  // (outward direction along z is `dirZ` × positive offset from the arc)
  const lamp = dirZ < 0 ? 'headlight' : 'taillight';
  for (const sx of [-1, 1]) {
    const zl = arcZAtX(arcs.frameHi, sx * 0.68);
    mb.box('black', { x: sx * 0.68, y: 1.26, z: zl + dirZ * 0.015, w: 0.48, h: 0.18, d: 0.07 });
    mb.box(lamp, { x: sx * 0.68, y: 1.26, z: zl + dirZ * 0.05, w: 0.34, h: 0.1, d: 0.06 });
  }

  if (dirZ < 0) {
    // amber destination display right behind the top of the windshield
    destinationDisplay(mb, { zFace: -(zA + 0.88) - 0.02, y: 2.46, w: 1.2, h: 0.19 });
    // red pid wordmark on the left bumper cheek
    mb.box('redDark', { x: -0.58, y: 0.9, z: arcZAtX(arcs.bumpHi, -0.58) - 0.02, w: 0.26, h: 0.11, d: 0.05 });
    // windshield wiper
    const zw = (y) => -(zA + 1.23 - (0.41 * (y - 1.2)) / 1.46) - 0.03;
    mb.beam('black', [0.18, 1.32, zw(1.32)], [-0.32, 2.2, zw(2.2)], 0.03);
  } else {
    // small line-number display at the top of the rear window
    destinationDisplay(mb, { zFace: zA + 0.88 + 0.02, y: 2.46, w: 0.6, h: 0.19, dir: 1 });
  }
  // camera-mirror pods at the A-pillar tops
  for (const sx of [-1, 1]) {
    mb.box('black', { x: sx * (HW + 0.02), y: 2.45, z: -dirZ * (zA + 0.12), w: 0.06, h: 0.1, d: 0.2 });
  }
}

/** noseBands is tiny — inline local version so the helmet band can differ. */
function noseBands(mb, { bands, capMat, capCorners }) {
  let top = null;
  for (const b of bands) {
    mb.ribbon(b.mat, arcAt3(b.arc0, b.y0), arcAt3(b.arc1, b.y1));
    top = b;
  }
  if (top && capCorners) {
    const pts = [...arcAt3(top.arc1, top.y1), ...capCorners.map(([x, z]) => [x, top.y1, z])];
    mb.fan(capMat, pts, [0, 1, 0]);
  }
}
const arcAt3 = (arc, y) => arc.map(([x, z]) => [x, y, z]);

/** Smooth full-depth skirt panels over a bogie (52T's clean look). */
function bogieCovers(mb, { z }) {
  for (const sx of [-1, 1]) {
    mb.box('greyLight', { x: sx * (HW + 0.01), y: 0.6, z, w: 0.02, h: 0.6, d: 2.5 });
  }
}

// ── sections ─────────────────────────────────────────────────────────────────

function buildEnd({ tail }) {
  const mb = new MeshBuilder();
  const rightItems = tail
    ? [{ t: 'run', weight: 0.3 }, { ...DOOR }, { t: 'run', weight: 0.7 }, { ...DOOR }, { t: 'run', weight: 2.0 }]
    : [{ t: 'run', weight: 2.0 }, { ...DOOR }, { t: 'run', weight: 0.35 }];
  buildSectionShellLocal(mb, {
    length: LEND,
    front: tail ? 'joint' : 'cab',
    rear: tail ? 'cab' : 'bellows',
    rightItems,
    bogies: [tail ? 1.2 : -1.2],
  });
  plusMask(mb, { dirZ: tail ? 1 : -1 });
  bogieCovers(mb, { z: tail ? 1.2 : -1.2 });
  // AC pod + (front only) black anti-collision sensor pod behind the helmet
  roofPod(mb, { z: tail ? -1.2 : 1.2, y: ROOFTOP, w: 1.5, h: 0.22, d: 2.1 });
  if (!tail) roofPod(mb, { z: -1.55, y: ROOFTOP, w: 0.8, h: 0.13, d: 0.7, mat: 'black' });
  else roofPod(mb, { z: 1.7, y: ROOFTOP, w: 1.0, h: 0.14, d: 0.8 });
  return mb;
}

function buildMid({ length, pantograph }) {
  const mb = new MeshBuilder();
  const rightItems = pantograph
    ? [{ t: 'run' }]
    : [{ t: 'run', weight: 0.5 }, { ...DOOR }, { t: 'run', weight: 1 }, { ...DOOR }, { t: 'run', weight: 0.5 }];
  buildSectionShellLocal(mb, {
    length,
    front: 'joint',
    rear: 'bellows',
    rightItems,
    bogies: pantograph ? [0] : [], // b/d semi-swivel bogies, c suspended
  });
  if (pantograph) {
    singleArmPantograph(mb, { z: 0, yRoof: ROOFTOP });
    for (const zc of [-1.95, 1.95]) {
      roofPod(mb, { z: zc, y: ROOFTOP, w: 1.3, h: 0.16, d: 1.0 });
    }
    bogieCovers(mb, { z: 0 });
  } else {
    roofPod(mb, { z: 0, y: ROOFTOP, w: 1.5, h: 0.22, d: 2.2 });
  }
  return mb;
}

/** Shared shell call + red livery bays derived from the right-wall doors. */
function buildSectionShellLocal(mb, { length, front, rear, rightItems, bogies }) {
  const L2 = length / 2;
  const z0 = front === 'cab' ? -L2 + NOSE : -L2 + 0.06;
  const z1 = rear === 'cab' ? L2 - NOSE : rear === 'bellows' ? L2 - 0.28 : L2 - 0.06;
  buildSectionShell(mb, {
    length, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front, rear,
    noseDepthF: front === 'cab' ? NOSE : 0,
    noseDepthR: rear === 'cab' ? NOSE : 0,
    rightItems,
    leftItems: [{ t: 'run' }],
    mats: MATS,
    bogies,
    winOpts: WIN,
  });
  redBays(mb, doorSpans(z0, z1 - z0, rightItems));
}

export function sections() {
  const eEnd = { length: LEND, width: W };
  return [
    { key: '52t-a', build: () => buildEnd({ tail: false }), expect: eEnd },
    { key: '52t-b', build: () => buildMid({ length: LMIDB, pantograph: true }), expect: { length: LMIDB, width: W } },
    { key: '52t-c', build: () => buildMid({ length: LMIDC }), expect: { length: LMIDC, width: W } },
    { key: '52t-d', build: () => buildMid({ length: LMIDB, pantograph: true }), expect: { length: LMIDB, width: W } },
    { key: '52t-e', build: () => buildEnd({ tail: true }), expect: eEnd },
  ];
}
