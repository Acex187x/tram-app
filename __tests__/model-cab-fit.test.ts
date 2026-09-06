import { fitCabRadius, fitRadius } from '@/components/model/orbitMath';

it.each([0.55, 0.8, 1.6])(
  'fits all tilted cab-box corners at aspect %s without whole-sphere padding',
  (aspect) => {
    const size = { x: 2.8, y: 3.6, z: 2.2 };
    const fov = 36,
      elevation = (5 * Math.PI) / 180;
    const distance = fitCabRadius(size, fov, aspect);
    const tanV = Math.tan((fov * Math.PI) / 360);
    for (const x of [-size.x / 2, size.x / 2])
      for (const y of [-size.y / 2, size.y / 2])
        for (const z of [-size.z / 2, size.z / 2]) {
          const screenY = y * Math.cos(elevation) + z * Math.sin(elevation);
          const cameraDepth = distance - (-y * Math.sin(elevation) + z * Math.cos(elevation));
          expect(Math.abs(x) / cameraDepth).toBeLessThan(tanV * aspect);
          expect(Math.abs(screenY) / cameraDepth).toBeLessThan(tanV);
        }
    expect(distance).toBeLessThan(fitRadius(size, fov, aspect));
  },
);
