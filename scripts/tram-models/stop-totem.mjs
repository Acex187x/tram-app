// Prague tram-stop totem (unified PID zastávkový označník) → assets/models/stop-totem.glb.
//
// Round-3 rebuild, modeled faithfully on the official unified PID označník
// drawing (user-supplied reference). The real thing is NOT a grey pole — it is
// a tall (~3.5 m), narrow (~0.45 m) RED LADDER FRAME: two vertical red posts
// with red cross-members, standing on two short legs with small base plates.
// Stacked inside the frame, top to bottom:
//   * BLUE square road sign — white inner border, white rounded square with a
//     dark simplified vehicle pictogram.
//   * WHITE info panel — stop-name band + line-number rows (blue chips) + the
//     red "VÝSTUPNÍ" band.
//   * an OPEN section of the frame (visibly hollow — just the two posts),
//     closed at the bottom by a small canopy lid.
//   * solid red display case box.
//   * red timetable case with a WHITE timetable sheet behind a thin white
//     frame, plus the dashed panel ruling from the drawing.
// All reading faces are painted on BOTH broad sides (like the real sign).
//
// Authored in the SAME conventions as the tram sections so it drops straight
// into the Mapbox ModelLayer:
//   * Y-up, meters, real size; origin at the BASE CENTRE (min y ≈ 0).
//   * FRONT (primary info face) toward −Z — RouteNetwork.tsx points it against
//     the direction of travel via modelRotation z = totemBearing.
//   * Single-sided PBR materials from the shared lib.mjs palette (+ the two
//     totem-specific colors registered below).
//
// Run directly to (re)build + validate:  node scripts/tram-models/stop-totem.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MATERIALS, MeshBuilder, octagonProfile, readGlbStats, writeSectionGlb } from './lib.mjs';

// ── totem-specific palette entries (sampled from the official drawing) ───────
// Registered onto the shared palette so MeshBuilder/writeSectionGlb accept
// them; additive only — never collides with the tram material keys.
// Faint same-hue emissive on the reading surfaces mimics the retroreflective
// sign sheeting — keeps the totem legible under every lightPreset (the layer
// runs modelEmissiveStrength 1).
MATERIALS.totemRed = { hex: 0xc4232b, rough: 0.45, metal: 0.06, emissive: [0.30, 0.045, 0.05] }; // PID označník red
MATERIALS.signBlue = { hex: 0x1361ae, rough: 0.42, metal: 0.05, emissive: [0.03, 0.13, 0.28] }; // road-sign blue
MATERIALS.paperWhite = { hex: 0xf4f5f2, rough: 0.5, metal: 0.03, emissive: [0.38, 0.38, 0.37] }; // sign faces / sheets

// ── overall proportions (metres) — measured off the reference drawing ────────
const FRAME_W = 0.45; // outer width across the two posts
const POST = 0.045; // square-tube side of each post (slim, per the drawing)
const POST_X = FRAME_W / 2 - POST / 2; // post centreline
const TOP_Y = 3.46; // top of the frame

// vertical stack (from the ground up, ground = y0)
const CASE_Y0 = 0.8, CASE_Y1 = 1.66; // timetable case
const MID_Y0 = 1.72, MID_Y1 = 2.02; // solid red display case box
const CANOPY_Y = 2.04; // small lid closing the open section
const PANEL_Y0 = 2.52, PANEL_Y1 = 2.96; // white info panel
const SIGN_Y0 = 3.02, SIGN_Y1 = 3.4; // blue SQUARE sign (0.38 m, between posts)
const SIGN_W = 0.38; // sign/panel width = inner frame width (posts flank them)
// open frame section = CANOPY_Y → PANEL_Y0 (posts only, visibly hollow)

// depth: everything hangs on the slim frame, info faces proud toward −Z
const FRAME_D = 0.055;
const SIGN_T = 0.05;
const SIGN_CZ = -0.01; // sign centre z → front face ≈ −0.035
const PANEL_T = 0.045;
const CASE_T = 0.075;

/** Front/rear z of a slab centred at cz with thickness t, for face dir ±1. */
const faceZ = (cz, t, dir) => cz + dir * (t / 2);

/**
 * Blue square road sign graphics on one broad face: white inner border,
 * white rounded square, dark simplified vehicle (bus/tram) pictogram.
 * `dir` = outward normal (−1 front / +1 rear); layers stack slightly proud.
 */
function paintSignFace(mb, zFace, dir) {
  const p = (n) => zFace + dir * n;
  const cy = (SIGN_Y0 + SIGN_Y1) / 2;
  const hw = SIGN_W / 2; // sign half-width
  const yB = SIGN_Y0, yT = SIGN_Y1;

  // white inner border frame (inset from the blue edge, like the drawing)
  const inset = 0.024, bw = 0.018;
  const zB = p(0.003);
  mb.rectZ('paperWhite', zB, -hw + inset, hw - inset, yT - inset - bw, yT - inset, dir); // top
  mb.rectZ('paperWhite', zB, -hw + inset, hw - inset, yB + inset, yB + inset + bw, dir); // bottom
  mb.rectZ('paperWhite', zB, -hw + inset, -hw + inset + bw, yB + inset, yT - inset, dir); // left
  mb.rectZ('paperWhite', zB, hw - inset - bw, hw - inset, yB + inset, yT - inset, dir); // right

  // white rounded square (chamfered) carrying the pictogram
  const sq = 0.26;
  const oct = octagonProfile(sq, sq, 0.05).map(([x, y]) => [x, y + cy, p(0.006)]);
  mb.fan('paperWhite', oct, [0, 0, dir]);

  // dark simplified vehicle glyph (side view) on the white square
  const zg = p(0.01);
  mb.rectZ('trim', zg, -0.1, 0.1, cy - 0.048, cy + 0.042, dir); // body
  mb.rectZ('trim', zg, 0.088, 0.104, cy - 0.034, cy + 0.042, dir); // nose
  for (const [x0, x1] of [[-0.086, -0.042], [-0.026, 0.018], [0.042, 0.086]]) { // windows
    mb.rectZ('paperWhite', p(0.014), x0, x1, cy + 0.004, cy + 0.032, dir);
  }
  for (const wx of [-0.055, 0.055]) { // wheels
    mb.cylinder('trim', { x: wx, y: cy - 0.05, z: p(0.012), r: 0.023, len: 0.012, axis: 'z', seg: 10, capMat: 'trim' });
  }
}

/**
 * White info panel graphics on one broad face: dark stop-name band, blue
 * line-number chips, red "VÝSTUPNÍ" band, second chip row — thin stripes
 * suggesting the printed rows of the real panel.
 */
function paintPanelFace(mb, zFace, dir) {
  const p = (n) => zFace + dir * n;
  const hw = SIGN_W / 2 - 0.012;
  const yT = PANEL_Y1, yB = PANEL_Y0;
  const z1 = p(0.003), z2 = p(0.006);

  // hairline dark outline around the panel edge
  const f = 0.005;
  mb.rectZ('trim', z1, -hw, hw, yT - f, yT, dir);
  mb.rectZ('trim', z1, -hw, hw, yB, yB + f, dir);
  mb.rectZ('trim', z1, -hw, -hw + f, yB, yT, dir);
  mb.rectZ('trim', z1, hw - f, hw, yB, yT, dir);

  // stop-name band (bold dark text bar) + separator rule below it
  mb.rectZ('trim', z2, -0.15, 0.15, yT - 0.066, yT - 0.03, dir);
  mb.rectZ('trim', z1, -hw + f, hw - f, yT - 0.086, yT - 0.083, dir);

  // row 1: blue line-number chip + small direction text bar
  mb.rectZ('signBlue', z2, -0.155, -0.07, yT - 0.16, yT - 0.098, dir);
  mb.rectZ('trim', z2, -0.045, 0.13, yT - 0.14, yT - 0.124, dir);
  mb.rectZ('trim', z1, -hw + f, hw - f, yT - 0.172, yT - 0.168, dir);

  // red VÝSTUPNÍ band with a white text stripe hint
  mb.rectZ('totemRed', z2, -hw + 0.015, hw - 0.015, yT - 0.245, yT - 0.185, dir);
  mb.rectZ('paperWhite', p(0.009), -0.11, 0.11, yT - 0.229, yT - 0.201, dir);

  // row 2: two blue line-number chips
  mb.rectZ('signBlue', z2, -0.155, -0.07, yB + 0.03, yB + 0.092, dir);
  mb.rectZ('signBlue', z2, -0.05, 0.035, yB + 0.03, yB + 0.092, dir);
}

/**
 * Timetable case graphics on one broad face: thin white frame, white
 * timetable sheet (upper left) and the dashed panel ruling from the drawing.
 */
function paintCaseFace(mb, zFace, dir) {
  const p = (n) => zFace + dir * n;
  const hw = 0.25;
  const yT = CASE_Y1, yB = CASE_Y0;
  const z1 = p(0.003), z2 = p(0.006);

  // thin white frame just inside the red edge
  const m = 0.018, bw = 0.014;
  mb.rectZ('paperWhite', z1, -hw + m, hw - m, yT - m - bw, yT - m, dir);
  mb.rectZ('paperWhite', z1, -hw + m, hw - m, yB + m, yB + m + bw, dir);
  mb.rectZ('paperWhite', z1, -hw + m, -hw + m + bw, yB + m, yT - m, dir);
  mb.rectZ('paperWhite', z1, hw - m - bw, hw - m, yB + m, yT - m, dir);

  // white timetable sheet, upper-left, with faint schedule ruling
  const sx0 = -hw + 0.045, sx1 = sx0 + 0.185;
  const sy1 = yT - 0.05, sy0 = sy1 - 0.3;
  mb.rectZ('paperWhite', z2, sx0, sx1, sy0, sy1, dir);
  mb.rectZ('trim', p(0.009), sx0 + 0.012, sx1 - 0.012, sy1 - 0.045, sy1 - 0.02, dir); // header
  for (let i = 0; i < 4; i++) {
    const y = sy0 + 0.03 + i * 0.055;
    mb.rectZ('trim', p(0.009), sx0 + 0.012, sx1 - 0.012, y, y + 0.007, dir);
  }

  // dashed dark ruling across the red field (the drawing's dashed grid)
  const dash = (x0, x1, y) => {
    for (let x = x0; x < x1 - 0.01; x += 0.055) {
      mb.rectZ('trim', z2, x, Math.min(x + 0.032, x1), y, y + 0.009, dir);
    }
  };
  dash(-hw + 0.045, hw - 0.045, yB + 0.36);
  dash(-hw + 0.045, hw - 0.045, yB + 0.16);
  for (let y = yB + 0.05; y < yT - 0.06; y += 0.06) { // vertical dashed line
    mb.rectZ('trim', z2, 0.06, 0.069, y, y + 0.035, dir);
  }
}

/** Build the totem MeshBuilder. */
export function build() {
  const mb = new MeshBuilder();

  // ── two red posts, ground → top, with small base plates (the short legs) ──
  for (const sx of [-1, 1]) {
    const x = sx * POST_X;
    mb.box('totemRed', { x, y: TOP_Y / 2, z: 0, w: POST, h: TOP_Y, d: FRAME_D });
    mb.box('totemRed', { x, y: 0.015, z: 0, w: 0.13, h: 0.03, d: 0.13 }); // base plate
  }

  // ── red cross-members tying the posts together (the ladder rungs) ─────────
  const rung = (yc, h = POST) =>
    mb.box('totemRed', { x: 0, y: yc, z: 0, w: FRAME_W - POST, h, d: FRAME_D });
  rung(TOP_Y - POST / 2); // top bar above the blue sign
  rung((SIGN_Y0 + PANEL_Y1) / 2); // between sign and info panel
  rung(PANEL_Y0 - 0.025); // below the info panel (top of the open section)
  rung((CASE_Y1 + MID_Y0) / 2, 0.045); // between display box and timetable case
  rung(CASE_Y0 - 0.02, 0.045); // below the timetable case

  // ── blue square road sign (top) ───────────────────────────────────────────
  mb.box('signBlue', { x: 0, y: (SIGN_Y0 + SIGN_Y1) / 2, z: SIGN_CZ, w: SIGN_W, h: SIGN_Y1 - SIGN_Y0, d: SIGN_T });
  paintSignFace(mb, faceZ(SIGN_CZ, SIGN_T, -1), -1);
  paintSignFace(mb, faceZ(SIGN_CZ, SIGN_T, +1), +1);

  // ── white info panel ──────────────────────────────────────────────────────
  mb.box('paperWhite', { x: 0, y: (PANEL_Y0 + PANEL_Y1) / 2, z: SIGN_CZ, w: SIGN_W, h: PANEL_Y1 - PANEL_Y0, d: PANEL_T });
  paintPanelFace(mb, faceZ(SIGN_CZ, PANEL_T, -1), -1);
  paintPanelFace(mb, faceZ(SIGN_CZ, PANEL_T, +1), +1);

  // ── open frame section: nothing between the posts (visibly hollow) ────────
  // canopy lid closing it at the bottom, slightly proud toward the front
  mb.box('totemRed', { x: 0, y: CANOPY_Y, z: -0.025, w: 0.5, h: 0.035, d: FRAME_D + 0.09 });

  // ── solid red display case box ────────────────────────────────────────────
  mb.box('totemRed', { x: 0, y: (MID_Y0 + MID_Y1) / 2, z: -0.005, w: 0.42, h: MID_Y1 - MID_Y0, d: 0.07 });

  // ── red timetable case with white sheet + dashed ruling ───────────────────
  mb.box('totemRed', { x: 0, y: (CASE_Y0 + CASE_Y1) / 2, z: -0.005, w: 0.52, h: CASE_Y1 - CASE_Y0, d: CASE_T });
  paintCaseFace(mb, faceZ(-0.005, CASE_T, -1), -1);
  paintCaseFace(mb, faceZ(-0.005, CASE_T, +1), +1);

  return mb;
}

// ── run-as-script: write + validate ───────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const outPath = join(dirname(fileURLToPath(import.meta.url)), '../../assets/models/stop-totem.glb');
  const bytes = await writeSectionGlb({ outPath, name: 'stop-totem', mb: build() });
  const stats = await readGlbStats(outPath);
  const [sx, sy, sz] = stats.size;
  const problems = [];
  if (bytes > 50 * 1024) problems.push(`file ${(bytes / 1024).toFixed(1)}KB > 50KB`);
  if (stats.min[1] < -0.02) problems.push(`sinks below ground: minY ${stats.min[1].toFixed(3)}`);
  if (sy < 3.3 || sy > 3.6) problems.push(`height ${sy.toFixed(2)}m outside [3.3, 3.6]`);
  if (sx < 0.4 || sx > 0.6) problems.push(`width ${sx.toFixed(2)}m outside [0.4, 0.6]`);
  if (Math.abs(stats.min[0] + stats.max[0]) > 0.06) problems.push(`not x-centered: [${stats.min[0].toFixed(2)}, ${stats.max[0].toFixed(2)}]`);
  console.table([{
    model: 'stop-totem', 'w m': sx.toFixed(2), 'h m': sy.toFixed(2), 'd m': sz.toFixed(2),
    tris: stats.tris, KB: (bytes / 1024).toFixed(1), ok: problems.length ? problems.join('; ') : 'ok',
  }]);
  if (problems.length) {
    console.error(`\nstop-totem validation failed.`);
    process.exit(1);
  }
  console.log(`\nstop-totem.glb written to ${outPath} and validated.`);
}
