import type { Vec3 } from './orbitMath';

/** Tight depth range for thin window/frame layers, including cab views whose
 * target differs from the consist centre. Expo's WebGL1 render target uses a
 * 16-bit depth buffer: near=.1/far=600 loses centimetres at normal tram distance.
 * Project the complete AABB onto camera forward; this is exact for the box and
 * needs only scalar arithmetic, rather than allocating eight transformed corners.
 */
export function modelClipPlanes(camera: Vec3, target: Vec3, min: Vec3, max: Vec3) {
  const dx = target.x - camera.x,
    dy = target.y - camera.y,
    dz = target.z - camera.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 0)) return { near: 0.05, far: 100 };
  const nx = dx / length,
    ny = dy / length,
    nz = dz / length;
  const centreDepth =
    ((min.x + max.x) / 2 - camera.x) * nx +
    ((min.y + max.y) / 2 - camera.y) * ny +
    ((min.z + max.z) / 2 - camera.z) * nz;
  const halfDepth =
    ((max.x - min.x) / 2) * Math.abs(nx) +
    ((max.y - min.y) / 2) * Math.abs(ny) +
    ((max.z - min.z) / 2) * Math.abs(nz);
  // Door animation can move geometry outside its authored closed AABB.
  const margin = 1;
  const near = Math.max(0.05, centreDepth - halfDepth - margin);
  const far = Math.max(near + 1, centreDepth + halfDepth + margin);
  return { near, far };
}
