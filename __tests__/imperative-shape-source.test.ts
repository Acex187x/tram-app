/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IMPERATIVE_SOURCE_FILES = [
  'src/components/map/TramLayers.tsx',
  'src/components/map/RouteNetwork.tsx',
  'src/components/map/PlannerOverlay.tsx',
  'src/components/map/RideOverlay.tsx',
];

describe('imperatively-fed ShapeSources', () => {
  it.each(IMPERATIVE_SOURCE_FILES)('%s bypasses Fabric for live shape updates', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/<ShapeSource\b[^>]*\bshape=/g);
    expect(source).not.toMatch(/\.setNativeProps\s*\(/g);
    expect(source).toMatch(/\.updateShape\s*\(/g);
  });
});
