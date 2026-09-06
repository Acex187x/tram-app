import { modelClipPlanes } from '@/components/model/clipPlanes';
import { orbitToPosition } from '@/components/model/orbitMath';

const min = { x: -1.3, y: 0, z: 0 },
  max = { x: 1.3, y: 4, z: 32 };
it.each([0, 32, 90, 180, 270])(
  'contains every model corner through orbit azimuth %s',
  (azimuthDeg) => {
    const target = { x: 0, y: 2, z: 16 };
    const camera = orbitToPosition({ azimuthDeg, elevationDeg: 14, radiusM: 55 }, target);
    const { near, far } = modelClipPlanes(camera, target, min, max);
    const dx = target.x - camera.x,
      dy = target.y - camera.y,
      dz = target.z - camera.z,
      length = Math.hypot(dx, dy, dz);
    for (const x of [min.x, max.x])
      for (const y of [min.y, max.y])
        for (const z of [min.z, max.z]) {
          const depth = ((x - camera.x) * dx + (y - camera.y) * dy + (z - camera.z) * dz) / length;
          expect(depth).toBeGreaterThan(near);
          expect(depth).toBeLessThan(far);
          // One depth-buffer step is well below an authored 8 mm window separation.
          const quantization = (depth * depth * (far - near)) / (far * near * 65535);
          expect(quantization).toBeLessThan(0.001);
        }
  },
);
it.each([false, true])('preserves tight depth precision for cab inspection, rear=%s', (rear) => {
  const target = { x: 0, y: 2, z: rear ? 31.35 : 0.65 };
  const camera = orbitToPosition(
    { azimuthDeg: rear ? 180 : 0, elevationDeg: 5, radiusM: 8 },
    target,
  );
  const { near, far } = modelClipPlanes(camera, target, min, max);
  expect(near).toBeGreaterThan(5);
  expect(far).toBeLessThan(43);
  expect((8 * 8 * (far - near)) / (far * near * 65535)).toBeLessThan(0.0002);
});
it('keeps a positive near plane when the user zooms inside the bounding box', () => {
  expect(modelClipPlanes({ x: 0, y: 2, z: 2 }, { x: 0, y: 2, z: 16 }, min, max).near).toBe(0.05);
});
