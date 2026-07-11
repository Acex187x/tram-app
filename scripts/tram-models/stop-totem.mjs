// Prague tram-stop totem (PID zastávkový označník) → assets/models/stop-totem.glb.
//
// Round-2 rebuild. The user reported the old totem "не как в реальной жизни" —
// it was a lone RED CIRCLE with a tram in it, which actually reads as the road
// PROHIBITION sign "no trams". A real Prague označník is a slim grey pole
// carrying a RECTANGULAR white PID sign board (portrait), on which a small red
// roundel with a dark tram pictogram + a "ZASTÁVKA"/stop-name area sit, with a
// thin yellow accent stripe; an A4 glass timetable case hangs lower on the pole;
// a small foot at the base. Everything is DOUBLE-SIDED (the board reads the same
// from −Z and +Z, like the real sign).
//
// Authored in the SAME conventions as the tram sections so it drops straight
// into the Mapbox ModelLayer:
//   * Y-up, meters, real size; origin at the BASE CENTRE (min y ≈ 0).
//   * FRONT (primary reading face) toward −Z.
//   * Single-sided PBR materials from the shared lib.mjs palette — so any
//     surface a camera can see is painted on BOTH faces.
//
// Run directly to (re)build + validate:  node scripts/tram-models/stop-totem.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MeshBuilder, readGlbStats, writeSectionGlb } from './lib.mjs';

// ── overall proportions (metres) ─────────────────────────────────────────────
const POLE_R = 0.05;
const POLE_TOP = 3.0; // grey galvanised shaft top
const BASE_H = 0.16;

// white sign board (portrait), mounted on the −Z side of the pole
const BOARD_W = 0.36;
const BOARD_H = 0.66;
const BOARD_T = 0.05; // thickness
const BOARD_CY = 2.5; // board centre height
const BOARD_BACK = -(POLE_R + 0.025); // board back face (toward pole)
const BOARD_CZ = BOARD_BACK - BOARD_T / 2; // board centre z (negative → in front)

// glass timetable case (A4 portrait) lower on the pole
const CASE_W = 0.4;
const CASE_H = 0.56;
const CASE_T = 0.06;
const CASE_CY = 1.5;
const CASE_BACK = -(POLE_R + 0.02);
const CASE_CZ = CASE_BACK - CASE_T / 2;

/**
 * Paint one broad face of the sign board (white PID panel):
 *   red border frame · red roundel with dark tram glyph · stop-name bars ·
 *   yellow accent stripe. `dir` = outward normal (−1 front / +1 rear); graphics
 *   are stacked slightly proud of `zFace` along the outward direction so they
 *   never z-fight the white panel.
 */
function paintBoardFace(mb, zFace, dir) {
  const p = (n) => zFace + dir * n; // n m proud, outward
  const hw = BOARD_W / 2;
  const yTop = BOARD_CY + BOARD_H / 2;
  const yBot = BOARD_CY - BOARD_H / 2;

  // thin red border frame around the panel edge
  const bf = 0.02; // frame width
  const zF = p(0.004);
  mb.rectZ('redClassic', zF, -hw, hw, yTop - bf, yTop, dir); // top
  mb.rectZ('redClassic', zF, -hw, hw, yBot, yBot + bf, dir); // bottom
  mb.rectZ('redClassic', zF, -hw, -hw + bf, yBot, yTop, dir); // left
  mb.rectZ('redClassic', zF, hw - bf, hw, yBot, yTop, dir); // right

  // ── red roundel with dark tram pictogram (top of the board) ───────────────
  const ry = yTop - 0.14; // roundel centre
  mb.cylinder('redClassic', { x: 0, y: ry, z: p(0.008), r: 0.12, len: 0.014, axis: 'z', seg: 12, capMat: 'redClassic' });
  mb.cylinder('white', { x: 0, y: ry, z: p(0.016), r: 0.09, len: 0.014, axis: 'z', seg: 12, capMat: 'white' });
  // simplified tram silhouette (side view), dark, on the white field
  const zg = p(0.026);
  mb.rectZ('trim', zg, -0.066, 0.066, ry - 0.03, ry + 0.028, dir); // body
  mb.rectZ('trim', zg, -0.055, 0.02, ry + 0.028, ry + 0.05, dir); // raked roof
  for (const wx of [-0.032, 0.032]) { // two windows (white gaps)
    mb.rectZ('white', p(0.03), wx - 0.018, wx + 0.018, ry - 0.006, ry + 0.022, dir);
  }
  for (const wx of [-0.04, 0.04]) { // two wheels
    mb.rectZ('trim', p(0.03), wx - 0.014, wx + 0.014, ry - 0.044, ry - 0.03, dir);
  }
  mb.rectZ('trim', zg, 0.03, 0.042, ry + 0.05, ry + 0.084, dir); // trolley/pantograph stub

  // ── PID yellow header band just under the roundel ─────────────────────────
  mb.rectZ('brass', p(0.006), -hw + bf, hw - bf, yTop - 0.30, yTop - 0.26, dir);

  // ── stop-name area: bold name bar + thin sub-line ─────────────────────────
  mb.rectZ('trim', p(0.006), -0.14, 0.14, yTop - 0.40, yTop - 0.355, dir); // name (bold)
  mb.rectZ('trim', p(0.006), -0.11, 0.11, yTop - 0.44, yTop - 0.42, dir); // sub-line (thin)

  // ── line-number chips row near the bottom ─────────────────────────────────
  for (const nx of [-0.13, -0.045, 0.04, 0.11]) {
    mb.rectZ('redClassic', p(0.006), nx, nx + 0.055, yBot + 0.06, yBot + 0.10, dir); // line badges
  }
}

/**
 * Paint one broad face of the timetable case: white sheet, red header strip,
 * faint schedule ruling. `dir` = outward normal.
 */
function paintCaseFace(mb, zFace, dir) {
  const p = (n) => zFace + dir * n;
  const hw = CASE_W / 2 - 0.03;
  const yTop = CASE_CY + CASE_H / 2 - 0.03;
  const yBot = CASE_CY - CASE_H / 2 + 0.03;
  mb.rectZ('white', p(0.002), -hw, hw, yBot, yTop, dir); // sheet
  mb.rectZ('redClassic', p(0.006), -hw, hw, yTop - 0.06, yTop, dir); // header strip
  for (let i = 0; i < 5; i++) { // schedule ruling
    const y = yBot + 0.03 + i * ((yTop - 0.08 - yBot) / 7);
    mb.rectZ('trim', p(0.006), -hw + 0.02, hw - 0.02, y, y + 0.008, dir);
  }
}

/** Build the totem MeshBuilder. */
export function build() {
  const mb = new MeshBuilder();

  // ── base foot: small concrete/steel plinth + flange ──────────────────────
  mb.box('trim', { x: 0, y: BASE_H / 2, z: 0, w: 0.34, h: BASE_H, d: 0.34, bevel: 0.05 });
  mb.box('silver', { x: 0, y: BASE_H + 0.015, z: 0, w: 0.2, h: 0.05, d: 0.2 }); // flange

  // ── slim grey galvanised pole + top cap ──────────────────────────────────
  const poleY0 = BASE_H + 0.03;
  mb.cylinder('silver', {
    x: 0, y: (poleY0 + POLE_TOP) / 2, z: 0,
    r: POLE_R, len: POLE_TOP - poleY0, axis: 'y', seg: 10,
  });
  mb.cylinder('silver', { x: 0, y: POLE_TOP + 0.015, z: 0, r: POLE_R + 0.018, len: 0.04, axis: 'y', seg: 8 }); // cap

  // ── white sign board (double-sided) on the −Z side of the pole ────────────
  // two short brackets from pole to board so it reads as bolted-on
  for (const by of [BOARD_CY + 0.22, BOARD_CY - 0.22]) {
    mb.box('silver', { x: 0, y: by, z: (BOARD_BACK - POLE_R) / 2, w: 0.05, h: 0.05, d: POLE_R - BOARD_BACK + 0.01 });
  }
  mb.box('white', { x: 0, y: BOARD_CY, z: BOARD_CZ, w: BOARD_W, h: BOARD_H, d: BOARD_T }); // panel
  paintBoardFace(mb, BOARD_CZ - BOARD_T / 2, -1); // front (−Z)
  paintBoardFace(mb, BOARD_CZ + BOARD_T / 2, +1); // rear (+Z)

  // ── A4 glass timetable case (double-sided) lower on the pole ──────────────
  mb.box('trim', { x: 0, y: CASE_CY, z: CASE_CZ, w: CASE_W, h: CASE_H, d: CASE_T }); // dark casing
  mb.box('silver', { x: 0, y: CASE_CY, z: CASE_CZ - 0.002, w: CASE_W + 0.02, h: CASE_H + 0.02, d: 0.02 }); // frame lip (front)
  mb.box('silver', { x: 0, y: CASE_CY, z: CASE_CZ + CASE_T / 2, w: CASE_W + 0.02, h: CASE_H + 0.02, d: 0.02 }); // frame lip (rear)
  paintCaseFace(mb, CASE_CZ - CASE_T / 2, -1);
  paintCaseFace(mb, CASE_CZ + CASE_T / 2, +1);

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
  if (bytes > 30 * 1024) problems.push(`file ${(bytes / 1024).toFixed(1)}KB > 30KB`);
  if (stats.min[1] < -0.02) problems.push(`sinks below ground: minY ${stats.min[1].toFixed(3)}`);
  if (sy < 2.9 || sy > 3.35) problems.push(`height ${sy.toFixed(2)}m outside [2.9, 3.35]`);
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
