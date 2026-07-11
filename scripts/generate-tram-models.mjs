// Build tram section GLBs into assets/models/, then read each file back and
// validate bounding box, triangle count and file size. Fails loudly on any
// violation so a broken model can never ship silently.
//
// Usage:
//   node scripts/generate-tram-models.mjs            # build ALL models
//   node scripts/generate-tram-models.mjs 15t kt8d5  # build ONLY those models
//
// Each model id maps to its own builder file under scripts/tram-models/ and
// writes only its own section GLBs — so 7 per-model agents can run in parallel
// without touching each other's outputs.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGlbStats, writeSectionGlb } from './tram-models/lib.mjs';
import { sections as t3 } from './tram-models/t3.mjs';
import { sections as t3rp } from './tram-models/t3rp.mjs';
import { sections as t3rplf } from './tram-models/t3rplf.mjs';
import { sections as kt8d5 } from './tram-models/kt8d5.mjs';
import { sections as s14t } from './tram-models/14t.mjs';
import { sections as s15t } from './tram-models/15t.mjs';
import { sections as s52t } from './tram-models/52t.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../assets/models');

// One entry per tram model. `sections` yields that model's section builders;
// `lengthM` is the real vehicle length for the whole-tram triangle floor.
const MODELS = {
  t3: { sections: t3, lengthM: 14.1 },
  t3rp: { sections: t3rp, lengthM: 14.1 },
  t3rplf: { sections: t3rplf, lengthM: 14.1 },
  kt8d5: { sections: kt8d5, lengthM: 30.3 },
  '14t': { sections: s14t, lengthM: 30.25 },
  '15t': { sections: s15t, lengthM: 31.4 },
  '52t': { sections: s52t, lengthM: 32 },
};

// Validation gates (docs/architecture.md conventions + task budget)
const LENGTH_TOL = 0.3; // section length within spec ±0.3 m
const HEIGHT_RANGE = [3.0, 3.6];
const WIDTH_RANGE = [2.4, 2.65];
const MAX_BYTES = 150 * 1024; // per section GLB
const MAX_TRIS = 12000; // hard per-section cap (whole trams stay in budget)

// Resolve which models to build from CLI args (no args → all).
const requested = process.argv.slice(2);
const unknown = requested.filter((id) => !(id in MODELS));
if (unknown.length > 0) {
  console.error(
    `Unknown model id(s): ${unknown.join(', ')}. ` +
      `Valid ids: ${Object.keys(MODELS).join(', ')}.`,
  );
  process.exit(2);
}
const selectedIds = requested.length > 0 ? requested : Object.keys(MODELS);

let failures = 0;
const rows = [];

for (const id of selectedIds) {
  for (const { key, build, expect } of MODELS[id].sections()) {
    const outPath = join(OUT_DIR, `${key}.glb`);
    const mb = build();
    const bytes = await writeSectionGlb({ outPath, name: key, mb });
    const stats = await readGlbStats(outPath);

    const problems = [];
    const [sx, sy, sz] = stats.size;
    if (Math.abs(sz - expect.length) > LENGTH_TOL) {
      problems.push(`length ${sz.toFixed(2)}m vs spec ${expect.length}m`);
    }
    if (sy < HEIGHT_RANGE[0] || sy > HEIGHT_RANGE[1]) {
      problems.push(`height ${sy.toFixed(2)}m outside [${HEIGHT_RANGE}]`);
    }
    if (sx < WIDTH_RANGE[0] || sx > WIDTH_RANGE[1]) {
      problems.push(`width ${sx.toFixed(2)}m outside [${WIDTH_RANGE}]`);
    }
    if (stats.min[1] < -0.01) problems.push(`sinks below ground: minY ${stats.min[1].toFixed(3)}`);
    if (Math.abs(stats.min[2] + stats.max[2]) > 0.05) {
      problems.push(`not centered on z: [${stats.min[2].toFixed(2)}, ${stats.max[2].toFixed(2)}]`);
    }
    if (Math.abs(stats.min[0] + stats.max[0]) > 0.05) {
      problems.push(`not centered on x: [${stats.min[0].toFixed(2)}, ${stats.max[0].toFixed(2)}]`);
    }
    if (bytes > MAX_BYTES) problems.push(`file ${(bytes / 1024).toFixed(0)}KB > 150KB`);
    if (stats.tris > MAX_TRIS) problems.push(`${stats.tris} tris > ${MAX_TRIS}`);

    rows.push({
      model: key,
      'len m': sz.toFixed(2),
      'w m': sx.toFixed(2),
      'h m': sy.toFixed(2),
      tris: stats.tris,
      KB: (bytes / 1024).toFixed(1),
      ok: problems.length === 0 ? 'ok' : problems.join('; '),
    });
    if (problems.length > 0) failures++;
  }
}

console.table(rows);

// Whole-tram triangle budget: 3000–12000 per full ~30 m tram, with the floor
// scaled proportionally for shorter vehicles (a 14 m single-car T3 warrants
// roughly half the floor of a 32 m five-section set). Only the models we built
// this run are checked.
for (const id of selectedIds) {
  const { lengthM } = MODELS[id];
  const keys = MODELS[id].sections().map((s) => s.key);
  const total = keys.reduce((s, k) => s + Number(rows.find((r) => r.model === k)?.tris ?? 0), 0);
  const floor = Math.round(3000 * Math.min(1, lengthM / 30));
  const ok = total >= floor && total <= 12000;
  console.log(`${id.padEnd(7)} total tris: ${total} ${ok ? '' : ` ⚠ outside ${floor}–12000`}`);
  if (!ok) failures++;
}

if (failures > 0) {
  console.error(`\n${failures} validation failure(s) — see table above.`);
  process.exit(1);
}
console.log(`\nAll ${rows.length} section GLB(s) for [${selectedIds.join(', ')}] written to ${OUT_DIR} and validated.`);
