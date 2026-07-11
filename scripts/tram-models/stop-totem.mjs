// Prague tram-stop totem (JŽP-style) → assets/models/stop-totem.glb.
//
// A slim ~3.2 m pole carrying the classic red-and-white circular tram-stop sign
// (a simplified tram glyph in the white centre), a small timetable case below,
// and a tiny concrete base. Authored in the SAME conventions as the tram
// sections so it drops straight into the Mapbox ModelLayer:
//   * Y-up, meters, real size; origin at the BASE CENTRE (min y ≈ 0).
//   * FRONT toward −Z (the sign face + timetable read from −Z).
//   * Single-sided PBR materials from the shared lib.mjs palette.
//
// Run directly to (re)build + validate:  node scripts/tram-models/stop-totem.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MeshBuilder, readGlbStats, writeSectionGlb } from './lib.mjs';

const POLE_R = 0.05;
const POLE_TOP = 2.82; // pole shaft top (sign hub sits here)
const BASE_H = 0.14;
const SIGN_Y = 2.86; // centre of the circular sign
const SIGN_R = 0.34; // outer (red) radius
const FRONT = -1; // sign + timetable face −Z

/** Build the totem MeshBuilder. */
export function build() {
  const mb = new MeshBuilder();

  // ── tiny concrete base ─────────────────────────────────────────────────────
  mb.box('roof', { x: 0, y: BASE_H / 2, z: 0, w: 0.4, h: BASE_H, d: 0.4, bevel: 0.04 });
  mb.box('trim', { x: 0, y: BASE_H + 0.02, z: 0, w: 0.22, h: 0.06, d: 0.22 }); // flange

  // ── slim pole ──────────────────────────────────────────────────────────────
  const poleY0 = BASE_H + 0.05;
  mb.cylinder('silver', {
    x: 0, y: (poleY0 + POLE_TOP) / 2, z: 0,
    r: POLE_R, len: POLE_TOP - poleY0, axis: 'y', seg: 10,
  });
  mb.cylinder('silver', { x: 0, y: POLE_TOP + 0.02, z: 0, r: POLE_R + 0.02, len: 0.05, axis: 'y', seg: 10 }); // cap

  // ── circular red/white sign facing −Z ───────────────────────────────────────
  const zHub = 0; // sign centred on the pole
  const zRed = zHub + FRONT * (POLE_R + 0.02);
  const zWhite = zRed + FRONT * 0.02;
  const zGlyph = zWhite + FRONT * 0.015;
  // short arm from the pole to the sign hub
  mb.box('silver', { x: 0, y: SIGN_Y, z: FRONT * 0.03, w: 0.05, h: 0.05, d: 0.14 });
  // red disc (outer ring) + white disc (inner field)
  mb.cylinder('redClassic', { x: 0, y: SIGN_Y, z: zRed, r: SIGN_R, len: 0.04, axis: 'z', seg: 26, capMat: 'redClassic' });
  mb.cylinder('white', { x: 0, y: SIGN_Y, z: zWhite, r: SIGN_R - 0.07, len: 0.03, axis: 'z', seg: 26, capMat: 'white' });

  // ── simplified tram glyph in the white field ────────────────────────────────
  const gy = SIGN_Y;
  // body + raked front, dark
  mb.box('trim', { x: 0, y: gy + 0.01, z: zGlyph, w: 0.34, h: 0.15, d: 0.018 });
  mb.box('trim', { x: 0, y: gy + 0.105, z: zGlyph, w: 0.24, h: 0.05, d: 0.018 }); // roof hump
  // three little windows
  for (const wx of [-0.1, 0, 0.1]) {
    mb.box('glass', { x: wx, y: gy + 0.03, z: zGlyph + FRONT * 0.006, w: 0.06, h: 0.07, d: 0.01 });
  }
  // two wheels + a trolley pole stub
  for (const wx of [-0.11, 0.11]) {
    mb.cylinder('black', { x: wx, y: gy - 0.085, z: zGlyph + FRONT * 0.004, r: 0.028, len: 0.012, axis: 'z', seg: 10 });
  }
  mb.box('trim', { x: 0.04, y: gy + 0.19, z: zGlyph, w: 0.012, h: 0.11, d: 0.012 }); // pantograph stub

  // ── timetable case below the sign ───────────────────────────────────────────
  const tY = 1.55;
  const zCase = FRONT * (POLE_R + 0.03);
  mb.box('trim', { x: 0, y: tY, z: zCase, w: 0.42, h: 0.62, d: 0.06 }); // dark casing
  mb.box('silver', { x: 0, y: tY, z: zCase, w: 0.44, h: 0.64, d: 0.02 }); // frame lip
  // white timetable sheet on the −Z face, with a red header strip
  const zFace = zCase + FRONT * 0.032;
  mb.rectZ('white', zFace, -0.18, 0.18, tY - 0.27, tY + 0.22, FRONT);
  mb.rectZ('redClassic', zFace + FRONT * 0.002, -0.18, 0.18, tY + 0.22, tY + 0.29, FRONT);
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
