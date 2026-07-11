// Spike: generate an arrow-shaped GLB to calibrate Mapbox model-layer
// orientation (which way z-rotation=0 faces) and validate the GLB pipeline.
// Usage: node scripts/gen-spike-model.mjs
import { Document, NodeIO } from '@gltf-transform/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../assets/models/spike-arrow.glb');

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('scene');
doc.getRoot().setDefaultScene(scene);

function boxPrim(doc, w, h, d, cx, cy, cz) {
  // Box centered at (cx, cy, cz), extents w (x), h (y), d (z). Y-up, meters.
  const x = w / 2, y = h / 2, z = d / 2;
  const corners = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ].map(([a, b, c]) => [a + cx, b + cy, c + cz]);
  const faces = [
    [0, 3, 2, 1], // -z
    [4, 5, 6, 7], // +z
    [0, 1, 5, 4], // -y
    [2, 3, 7, 6], // +y
    [0, 4, 7, 3], // -x
    [1, 2, 6, 5], // +x
  ];
  const pos = [];
  const idx = [];
  for (const f of faces) {
    const base = pos.length / 3;
    for (const vi of f) pos.push(...corners[vi]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const position = doc.createAccessor().setType('VEC3')
    .setArray(new Float32Array(pos)).setBuffer(buffer);
  const indices = doc.createAccessor().setType('SCALAR')
    .setArray(new Uint16Array(idx)).setBuffer(buffer);
  return doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
}

const bodyMat = doc.createMaterial('body').setBaseColorFactor([0.85, 0.83, 0.75, 1]).setRoughnessFactor(0.6).setMetallicFactor(0.1);
const noseMat = doc.createMaterial('nose').setBaseColorFactor([0.75, 0.05, 0.05, 1]).setRoughnessFactor(0.5).setMetallicFactor(0.1);

// Body: 14m long along +Z, 2.5m wide, 3m tall, sitting on ground (y from 0 to 3).
// Nose: red cube at the +Z end (glTF "front" convention) raised on top.
const mesh = doc.createMesh('arrow');
mesh.addPrimitive(boxPrim(doc, 2.5, 3, 14, 0, 1.5, 0).setMaterial(bodyMat));
mesh.addPrimitive(boxPrim(doc, 2.5, 2, 3, 0, 4, 5.5).setMaterial(noseMat));

const node = doc.createNode('arrow').setMesh(mesh);
scene.addChild(node);

const glb = await new NodeIO().writeBinary(doc);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, glb);
console.log('wrote', out, glb.byteLength, 'bytes');
