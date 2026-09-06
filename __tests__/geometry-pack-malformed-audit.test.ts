import { seedFromPack } from '@/lib/golemio/geometryPack';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { straightGeometry, T0 } from './physicsFixtures';
import type { ServedGeometry } from '@/lib/golemio/gtfs';

afterEach(() => shapeCache.clearMemoryCache());
it.each([undefined, [0], [0, NaN]])('does not cache an unusable cumulative axis %s from a pack', (cumDistM) => {
  const geometry = straightGeometry();
  const served = { ...geometry, serviceMidnightMs: T0, builtAtMs: T0, cumDistM } as unknown as ServedGeometry;
  expect(seedFromPack({ atMs: T0, shapes: [served], trips: { test: served.shapeId } }, T0)).toBe(0);
  expect(shapeCache.getLoaded('test')).toBeUndefined();
});
