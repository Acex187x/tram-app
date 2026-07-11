// Škoda 15T "ForCity Alfa" — 3 sections, 31.4 m, the iconic modern Prague
// tram (Patrik Kotas design). Bulbous full-width rounded nose with a huge
// raked wraparound windshield, swept teardrop headlight clusters in a red
// front mask, red band along the window line over a white body, grey skirts,
// 2 red double doors per section (right side only — unidirectional) plus a
// narrow driver door over the first bogie, roof AC pods, pantograph on B.
//
// Visual facts verified 2026-07 (cs.wikipedia / skodagroup / prazsketramvaje):
// 6 double doors (2/section, right side), driver single door front right,
// 4 bogies (ends + 2 Jacobs under the joints, extremely short overhangs).

import {
  MeshBuilder, arcZAtX, buildSectionShell, destinationDisplay, mirrorArcZ,
  noseArc, noseBands, roofPod, roundLamp, singleArmPantograph, wallSegs,
} from './lib.mjs';

const W = 2.46;
const HW = W / 2;
const L = 10.3;

// Vertical datum (livery boundaries)
const SKIRT_Y0 = 0.34; // grey skirt bottom
const Y0 = 0.62; // white body bottom edge (skirt top)
const SILL = 1.12; // window sill = red band bottom
const WINTOP = 2.42; // window top
const YTOP = 2.62; // red band top edge
const ROOFTOP = 3.06;
const NOSE = 1.85;
const TAIL = 1.7;
const DOOR_LOW = 0.35; // passenger doors drop through the skirt (low floor)

const MATS = {
  lower: 'white',
  upper: 'redClassic',
  pillar: 'redClassic',
  glass: 'glass',
  door: 'redClassic',
  frame: 'redClassic',
};
// Big single-piece windows are THE 15T side signature
const WIN = { targetWin: 1.9, pillar: 0.14 };

// ── Cab face (nose dir=-1 / tail dir=+1): stacked ribbon bands ───────────────

function face(mb, { dir }) {
  const isFront = dir < 0;
  const D = isFront ? NOSE : TAIL;
  const zsAbs = L / 2 - D;
  /** plan arc at given depth/half-width; mirrored for the tail. p<1 = blunt */
  const A = (depth, hw = HW, p = 0.62) => {
    const a = noseArc({ hw, zStart: -zsAbs, depth, p, n: 18 });
    return isFront ? a : mirrorArcZ(a);
  };

  const maskTop = isFront ? 1.46 : 1.52; // red mask up to windshield gasket
  const bands = isFront
    ? [
        // slim dark bumper, tucked in at the bottom
        { y0: 0.3, y1: 0.52, mat: 'trim', arc0: A(D - 0.26, HW - 0.05, 0.72), arc1: A(D - 0.04, HW - 0.02, 0.66) },
        // red mask dips down over the whole nose (side band sweeps down here)
        { y0: 0.52, y1: maskTop, mat: 'redClassic', arc0: A(D - 0.04, HW - 0.02, 0.66), arc1: A(D) },
        // black glazing gasket under the windshield
        { y0: maskTop, y1: maskTop + 0.07, mat: 'black', arc0: A(D), arc1: A(D - 0.02) },
        // huge strongly-raked wraparound windshield in three facet rows
        { y0: maskTop + 0.07, y1: 2.08, mat: 'glass', arc0: A(D - 0.02), arc1: A(D - 0.26) },
        { y0: 2.08, y1: 2.46, mat: 'glass', arc0: A(D - 0.26), arc1: A(D - 0.52) },
        { y0: 2.46, y1: 2.72, mat: 'glass', arc0: A(D - 0.52), arc1: A(D - 0.78) },
        // slim red brow + grey roof dome
        { y0: 2.72, y1: 2.82, mat: 'redClassic', arc0: A(D - 0.78), arc1: A(D - 0.86, HW - 0.1) },
        { y0: 2.82, y1: ROOFTOP, mat: 'roof', arc0: A(D - 0.86, HW - 0.1), arc1: A(D - 1.12, HW - 0.26) },
      ]
    : [
        { y0: 0.3, y1: 0.52, mat: 'trim', arc0: A(D - 0.26, HW - 0.05, 0.72), arc1: A(D - 0.04, HW - 0.02, 0.66) },
        { y0: 0.52, y1: maskTop, mat: 'redClassic', arc0: A(D - 0.04, HW - 0.02, 0.66), arc1: A(D) },
        { y0: maskTop, y1: maskTop + 0.07, mat: 'black', arc0: A(D), arc1: A(D - 0.02) },
        // rear glass: smaller, less raked
        { y0: maskTop + 0.07, y1: 2.12, mat: 'glass', arc0: A(D - 0.02), arc1: A(D - 0.18) },
        { y0: 2.12, y1: 2.55, mat: 'glass', arc0: A(D - 0.18), arc1: A(D - 0.42) },
        { y0: 2.55, y1: 2.82, mat: 'redClassic', arc0: A(D - 0.42), arc1: A(D - 0.62, HW - 0.1) },
        { y0: 2.82, y1: ROOFTOP, mat: 'roof', arc0: A(D - 0.62, HW - 0.1), arc1: A(D - 0.95, HW - 0.26) },
      ];
  noseBands(mb, { bands, capMat: 'roof', capCorners: [] });

  // ── Light clusters ──
  // beams run mostly across x, so `w` is their z-thickness (protrusion) and
  // `h` the visible face height — keep w slim so the bbox stays centered.
  const proud = A(D + 0.01);
  const zAt = (arc, x) => arcZAtX(arc, x);
  if (isFront) {
    // swept teardrop "eyebrows": round projector lamp at the inner end, then a
    // slim white LED swoosh climbing the cheek, ending in an amber blinker tip
    for (const sx of [-1, 1]) {
      const P = ([x, y]) => [sx * x, y, zAt(proud, sx * x)];
      mb.beam('headlight', P([0.44, 0.76]), P([0.76, 0.9]), 0.08, 0.11);
      mb.beam('headlight', P([0.76, 0.9]), P([1.04, 1.18]), 0.07, 0.08);
      mb.beam('display', P([1.04, 1.18]), P([1.12, 1.3]), 0.05, 0.07); // amber blinker tip
      roundLamp(mb, { x: sx * 0.33, y: 0.74, zFace: zAt(proud, sx * 0.33), r: 0.09, dir: -1 });
    }
    // destination display glowing right at the windshield top (glass at y≈2.5
    // is depth ≈ D−0.56 → center z = −zsAbs − (D−0.56); face 5 cm proud)
    destinationDisplay(mb, { zFace: -zsAbs - (D - 0.56) - 0.05, y: 2.52, w: 1.08, h: 0.19, dir: -1 });
    // single wiper resting across the lower windshield
    mb.beam('black', [-0.55, 1.62, zAt(A(D - 0.04), -0.55)], [0.12, 2.12, -zsAbs - (D - 0.29)], 0.03);
    // mirror/camera pods at the windshield side edges
    for (const sx of [-1, 1]) {
      mb.beam('black', [sx * (HW - 0.04), 2.3, -zsAbs + 0.14], [sx * (HW + 0.03), 2.27, -zsAbs + 0.12], 0.03);
      mb.box('black', { x: sx * (HW + 0.035), y: 2.24, z: -zsAbs + 0.12, w: 0.06, h: 0.2, d: 0.12 });
    }
  } else {
    for (const sx of [-1, 1]) {
      const P = ([x, y]) => [sx * x, y, zAt(proud, sx * x)];
      mb.beam('taillight', P([0.42, 0.82]), P([0.98, 1.18]), 0.07, 0.09);
      roundLamp(mb, { x: sx * 0.32, y: 0.78, zFace: zAt(proud, sx * 0.32), r: 0.08, mat: 'taillight', dir: 1 });
    }
    // small rear line-number display (glass at y≈2.35 is depth ≈ D−0.31)
    destinationDisplay(mb, { zFace: zsAbs + (D - 0.31) + 0.05, y: 2.35, w: 0.5, h: 0.18, dir: 1 });
  }
}

// ── Skirts + side route displays (need resolved wall segments) ───────────────

function sideFurniture(mb, { z0, rightSegs, leftSegs }) {
  const xs = HW - 0.045; // skirt slightly recessed behind the wall plane
  for (const [side, segs] of [[1, rightSegs], [-1, leftSegs]]) {
    let z = z0;
    let shownDisplay = false;
    for (const s of segs) {
      const z1 = z + s.len;
      const drops = s.t === 'door' && (s.lowY ?? DOOR_LOW) < 0.6;
      if (!drops) {
        // grey skirt band between the door cutouts (wheel rims peek below)
        mb.rectX('roof', side * xs, z, z1, SKIRT_Y0 + 0.04, Y0 + 0.02, side);
      } else if (side > 0 && !shownDisplay) {
        // amber route display in the red band above the first passenger door
        const zc = (z + z1) / 2;
        mb.rectX('display', side * (HW + 0.004), zc - 0.3, zc + 0.3, 2.46, 2.58, side);
        shownDisplay = true;
      }
      z = z1;
    }
  }
}

// ── Section assembly ─────────────────────────────────────────────────────────

function build({ cab, tail, pantograph }) {
  const mb = new MeshBuilder();
  const driverDoor = { t: 'door', len: 0.78, lowY: Y0 }; // steps over bogie — no drop
  const door = () => ({ t: 'door', len: 1.32 });
  const rightItems = cab
    ? [driverDoor, { t: 'run', weight: 1.0 }, door(), { t: 'run', weight: 2.3 }, door(), { t: 'run', weight: 1.1 }]
    : tail
      ? [{ t: 'run', weight: 0.8 }, door(), { t: 'run', weight: 2.2 }, door(), { t: 'run', weight: 1.0 }]
      : [{ t: 'run', weight: 1.0 }, door(), { t: 'run', weight: 2.0 }, door(), { t: 'run', weight: 1.0 }];
  const leftItems = cab
    ? [{ t: 'win', len: 0.95 }, { t: 'panel', len: 0.18 }, { t: 'run' }] // driver side window
    : [{ t: 'run' }];

  const { z0, z1 } = buildSectionShell(mb, {
    length: L, width: W, y0: Y0, sill: SILL, winTop: WINTOP, yTop: YTOP, roofTop: ROOFTOP,
    front: cab ? 'cab' : 'joint',
    rear: tail ? 'cab' : 'bellows',
    noseDepthF: cab ? NOSE : 0,
    noseDepthR: tail ? TAIL : 0,
    rightItems,
    leftItems,
    mats: MATS,
    doorLowY: DOOR_LOW,
    glassInset: 0.04,
    // 4 bogies per tram: ends + Jacobs under each joint (owned by the section
    // ahead of it so the consist shows exactly one bogie per articulation).
    bogies: cab ? [-2.6, 3.9] : tail ? [2.55] : [3.9],
    roofShrink: 0.24,
    winOpts: WIN,
  });

  sideFurniture(mb, {
    z0,
    rightSegs: wallSegs(z1 - z0, rightItems, WIN),
    leftSegs: wallSegs(z1 - z0, leftItems, WIN),
  });

  if (cab) face(mb, { dir: -1 });
  if (tail) face(mb, { dir: 1 });

  // red mask sweeps diagonally down into the side band at the cab ends —
  // a thin red wedge over the white zone, just proud of the wall plane
  if (cab || tail) {
    const zEnd = cab ? z0 : z1;
    const zIn = cab ? z0 + 0.85 : z1 - 0.85;
    for (const side of [-1, 1]) {
      const x = side * (HW + 0.003);
      mb.fan('redClassic', [[x, 0.52, zEnd], [x, SILL, zEnd], [x, SILL, zIn]], [side, 0, 0]);
    }
  }

  // ── Roof equipment: big AC pod + secondary box + low conduit spine ──
  if (cab) {
    roofPod(mb, { z: -0.8, y: ROOFTOP, w: 1.5, h: 0.3, d: 2.6 }); // hump behind the cab dome
    roofPod(mb, { z: 2.7, y: ROOFTOP, w: 1.2, h: 0.2, d: 1.5 });
    mb.box('roof', { x: 0, y: ROOFTOP + 0.05, z: 1.2, w: 0.5, h: 0.1, d: 4.4 });
    mb.box('roof', { x: 0, y: ROOFTOP + 0.04, z: -2.6, w: 0.34, h: 0.08, d: 0.6 }); // antenna base
  } else if (tail) {
    roofPod(mb, { z: 0.8, y: ROOFTOP, w: 1.5, h: 0.3, d: 2.6 });
    roofPod(mb, { z: -2.7, y: ROOFTOP, w: 1.2, h: 0.2, d: 1.5 });
    mb.box('roof', { x: 0, y: ROOFTOP + 0.05, z: -1.2, w: 0.5, h: 0.1, d: 4.4 });
  } else {
    roofPod(mb, { z: 1.4, y: ROOFTOP, w: 1.5, h: 0.3, d: 2.6 });
    roofPod(mb, { z: 4.0, y: ROOFTOP, w: 1.1, h: 0.18, d: 1.3 });
    mb.box('roof', { x: 0, y: ROOFTOP + 0.05, z: 0.6, w: 0.5, h: 0.1, d: 5.6 });
  }
  if (pantograph) singleArmPantograph(mb, { z: -2.4, yRoof: ROOFTOP });
  return mb;
}

export function sections() {
  const expect = { length: L, width: W };
  return [
    { key: '15t-a', build: () => build({ cab: true }), expect },
    { key: '15t-b', build: () => build({ pantograph: true }), expect },
    { key: '15t-c', build: () => build({ tail: true }), expect },
  ];
}
