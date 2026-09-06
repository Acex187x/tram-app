// Rebuild from the new, editable Blender source; validate the actual exported
// GLBs with Khronos plus app-specific geometry and GPU budgets.
// node scripts/generate-tram-models.mjs [ids] [--render] [--validate-only]
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import validator from 'gltf-validator';
import { readGlbStats } from './tram-models/lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const models = {
  t3: [14.0], t3rp: [14.0], t3rplf: [15.1], kt8d5: [10.9, 6.5, 10.9],
  '14t': [6.265, 5.48, 3.38, 5.48, 6.265], '15t': [10.4, 8.6, 10.4],
  '52t': [9, 3.5, 3.79, 3.5, 9],
};
const gaps = { kt8d5: 1, '14t': .845, '15t': 1, '52t': .8 };
const noOpen = new Set(['14t-a', '14t-c', '52t-b', '52t-d']);
const args = process.argv.slice(2);
const ids = args.filter(a => !a.startsWith('--'));
if (!ids.length) ids.push(...Object.keys(models));
if (ids.some(id => !(id in models))) throw new Error('Unknown tram model');
if (!args.includes('--validate-only')) {
  const blender = process.env.BLENDER_BIN ?? '/Applications/Blender.app/Contents/MacOS/Blender';
  const result = spawnSync(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python',
    join(root, 'scripts/tram-models/blender_fleet.py'), '--', ...ids,
    ...(args.includes('--render') ? ['--render'] : [])], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const rows = [];
const viewerRows = [];
for (const id of ids) {
  let total = 0;
  for (const [i, length] of models[id].entries()) {
    const key = models[id].length === 1 ? id : `${id}-${String.fromCharCode(97 + i)}`;
    for (const name of noOpen.has(key) ? [key] : [key, `${key}-open`]) {
      const path = join(root, 'assets/models', `${name}.glb`);
      const bytes = readFileSync(path);
      const result = await validator.validateBytes(bytes, { uri: `${name}.glb` });
      if (result.issues.numErrors || result.issues.numWarnings) {
        throw new Error(`${name}: ${JSON.stringify(result.issues)}`);
      }
      const stats = await readGlbStats(path);
      const [w, h, l] = stats.size;
      const doc = await new NodeIO().read(path);
      const materials = doc.getRoot().listMaterials();
      const problems = [];
      const frontExtension = i > 0 ? gaps[id] / 2 : id === 'kt8d5' ? .470 : 0;
      const rearExtension = i < models[id].length - 1 ? gaps[id] / 2 : id === 'kt8d5' ? .470 : 0;
      const couplers = id.startsWith('t3') ? (id === 't3rplf' ? 1.10 : 1.104) : 0;
      if (Math.abs(l - length - frontExtension - rearExtension - couplers) > .12) problems.push(`length ${l} != body ${length} + attachments`);
      // Cab mirrors extend beyond the certified body width, which remains in
      // MODEL_SPECS; measure attachments separately from body proportions.
      const hasCab = i === 0 || (id === 'kt8d5' && i === models[id].length - 1);
      if (w < 2.4 || w > (hasCab ? 2.93 : name.endsWith('-open') ? 2.75 : 2.68)) problems.push(`width ${w}`);
      // Roof height remains in MODEL_SPECS. Raised collectors reach 4.7–5.2 m.
      if (h < 3 || h > 5.25) problems.push(`height ${h}`);
      if (stats.min[1] < -.01) problems.push('below rails');
      if (Math.abs(stats.min[2] + stats.max[2] - rearExtension + frontExtension) > .08) problems.push('Z origin drift');
      if (Math.abs(stats.min[0] + stats.max[0]) > (name.endsWith('-open') ? .22 : .12)) problems.push('X origin drift');
      if (bytes.length > (id.startsWith('t3') ? 250 : 200) * 1024) problems.push('file budget');
      if (stats.tris > 12000) problems.push('triangle budget');
      if (doc.getRoot().listTextures().length) problems.push('unexpected texture');
      if (materials.some(m => m.getDoubleSided() || m.getAlphaMode() !== 'OPAQUE')) problems.push('expensive material');
      if (problems.length) throw new Error(`${name}: ${problems.join(', ')}`);
      if (name === key) total += stats.tris;
      rows.push({ key: name, triangles: stats.tris, KB: +(statSync(path).size / 1024).toFixed(1),
        length: +l.toFixed(3), width: +w.toFixed(3), height: +h.toFixed(3), materials: materials.length,
        errors: result.issues.numErrors, warnings: result.issues.numWarnings });
    }
    const viewerPath = join(root, 'assets/models', `${key}-viewer.glb`);
    const viewerBytes = readFileSync(viewerPath);
    const validation = await validator.validateBytes(viewerBytes, { uri: `${key}-viewer.glb` });
    if (validation.issues.numErrors || validation.issues.numWarnings) throw new Error(`${key} viewer: ${JSON.stringify(validation.issues)}`);
    const viewer = await new NodeIO().read(viewerPath);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let doors = 0, indicators = 0;
    for (const node of viewer.getRoot().listNodes()) {
      const extras = node.getExtras();
      if ('doorOpenTranslation' in extras) {
        if (!Array.isArray(extras.doorOpenTranslation) || extras.doorOpenTranslation.length !== 3 || !extras.doorOpenTranslation.every(Number.isFinite) || !Number.isFinite(extras.doorOpenRotationY)) throw new Error(`${key}: malformed door mechanism`);
        doors++;
      }
      if ('indicatorSide' in extras) {
        if (!['left', 'right'].includes(extras.indicatorSide)) throw new Error(`${key}: malformed indicator side`);
        indicators++;
      }
      const matrix = node.getWorldMatrix();
      for (const prim of node.getMesh()?.listPrimitives() ?? []) {
        const positions = prim.getAttribute('POSITION').getArray();
        for (let v = 0; v < positions.length; v += 3) {
          for (let axis = 0; axis < 3; axis++) {
            const value = matrix[axis] * positions[v] + matrix[4 + axis] * positions[v + 1] + matrix[8 + axis] * positions[v + 2] + matrix[12 + axis];
            min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
          }
        }
      }
    }
    const closed = await readGlbStats(join(root, 'assets/models', `${key}.glb`));
    if (min.some((v, axis) => Math.abs(v - closed.min[axis]) > .001 || Math.abs(max[axis] - closed.max[axis]) > .001)) throw new Error(`${key}: viewer parts do not assemble to the map geometry`);
    if (!noOpen.has(key) && !doors) throw new Error(`${key}: missing movable passenger doors`);
    if (noOpen.has(key) && doors) throw new Error(`${key}: driver/doorless section marked as passenger animation`);
    viewerRows.push({ key: `${key}-viewer`, KB: +(viewerBytes.length / 1024).toFixed(1), movableLeaves: doors, indicatorLenses: indicators, errors: 0, warnings: 0 });
  }
  if (total > 12000) throw new Error(`${id}: whole vehicle ${total} triangles exceeds 12000`);
}
console.table(rows);
writeFileSync(join(root, 'docs/model-previews/validation.json'), JSON.stringify(rows, null, 2) + '\n');
writeFileSync(join(root, 'docs/model-previews/viewer-validation.json'), JSON.stringify(viewerRows, null, 2) + '\n');
console.log(`Validated ${rows.length} map GLBs and ${viewerRows.length} articulated viewer GLBs; matching closed geometry, valid mechanisms, no glTF warnings.`);
