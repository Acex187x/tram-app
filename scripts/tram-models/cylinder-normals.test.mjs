// Regression check for MDL-1: cylinder() side faces must have OUTWARD normals
// on all three axes. Materials are authored single-sided (setDoubleSided(false)),
// so an inward-facing wall is back-face culled and the part (e.g. a headlight
// bezel built on the z axis via roundLamp) visually disappears at oblique
// angles. This asserts dot(faceNormal, radialDirection) > 0 for every side
// triangle of an x-, y- and z-axis cylinder.
//
// Standalone node test (not part of the jest suite — lib.mjs is pure ESM and
// pulls in @gltf-transform). Run: node scripts/tram-models/cylinder-normals.test.mjs
import { MeshBuilder } from './lib.mjs';

/** Radial (perpendicular-to-axis) direction of a point relative to the cylinder axis. */
function radialDir(axis, p) {
  if (axis === 'x') return [0, p[1], p[2]];
  if (axis === 'y') return [p[0], 0, p[2]];
  return [p[0], p[1], 0]; // z
}

let failures = 0;
let checked = 0;

for (const axis of ['x', 'y', 'z']) {
  const mb = new MeshBuilder();
  // Off-origin center to make sure the check uses centroid-relative radials,
  // not absolute coordinates. Side walls only (caps have axial normals).
  const center = { x: 0.7, y: 1.3, z: -0.4, r: 0.6, len: 1.4, axis, seg: 12, caps: false };
  mb.cylinder('trim', center);

  for (const g of mb.groups.values()) {
    for (let t = 0; t < g.idx.length; t += 3) {
      const i0 = g.idx[t];
      // Flat-shaded: all 3 verts of a triangle share one normal.
      const n = [g.nrm[i0 * 3], g.nrm[i0 * 3 + 1], g.nrm[i0 * 3 + 2]];
      // Centroid of the triangle.
      const c = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const vi = g.idx[t + k];
        c[0] += g.pos[vi * 3]; c[1] += g.pos[vi * 3 + 1]; c[2] += g.pos[vi * 3 + 2];
      }
      c[0] /= 3; c[1] /= 3; c[2] /= 3;
      // Radial direction from the cylinder axis to the centroid.
      const rel = [c[0] - center.x, c[1] - center.y, c[2] - center.z];
      const rad = radialDir(axis, rel);
      const dot = n[0] * rad[0] + n[1] * rad[1] + n[2] * rad[2];
      checked++;
      if (!(dot > 0)) {
        failures++;
        console.error(
          `axis ${axis}: inward-facing side triangle ${t / 3} — ` +
          `normal [${n.map((v) => v.toFixed(3))}] · radial [${rad.map((v) => v.toFixed(3))}] = ${dot.toFixed(4)} (want > 0)`,
        );
      }
    }
  }
}

if (failures > 0) {
  console.error(`\ncylinder-normals: ${failures}/${checked} side triangles face inward.`);
  process.exit(1);
}
console.log(`cylinder-normals: OK — all ${checked} side triangles (x/y/z) face outward.`);
