/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IMPERATIVE_SOURCE_FILES = [
  'src/components/map/TramLayers.tsx',
  'src/components/map/RouteNetwork.tsx',
  'src/components/map/PlannerOverlay.tsx',
  'src/components/map/RideOverlay.tsx',
  'src/components/debug/DebugMapTraces.tsx',
];

describe('imperatively-fed ShapeSources', () => {
  it.each(IMPERATIVE_SOURCE_FILES)('%s bypasses Fabric for live shape updates', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/<ShapeSource\b[^>]*\bshape=/g);
    expect(source).not.toMatch(/\.setNativeProps\s*\(/g);
    expect(source).toMatch(/\.updateShape\s*\(/g);
  });

  it('does not continuously re-push an empty close-zoom points source', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/map/TramLayers.tsx'),
      'utf8',
    );
    expect(source).toContain('const pointsEmpty = frame.points.features.length === 0');
    expect(source).toContain('if (!pointsEmpty || !pointsEmptyRef.current)');
  });

  it('caps native Mapbox rendering at 60 fps on ProMotion displays', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/index.tsx'), 'utf8');
    expect(source).toContain('const MAP_MAX_FPS = 60');
    expect(source).toContain('preferredFramesPerSecond={MAP_MAX_FPS}');
  });
});
