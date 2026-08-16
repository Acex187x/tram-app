/// <reference types="jest" />

// Contract between the points FC and the sprite-driven map layers
// (TramLayers tram-dots / tram-badge-markers / tram-badges[-pinned]):
//  1. every sprite name the layers' iconImage EXPRESSIONS can produce exists
//     in a registry (dot-*/fav-star in MAP_ICON_ASSETS, face-<pack>-<modelId>
//     in ICON_PACKS[pack].sprites) and as a generated PNG on disk;
//  2. buildFrame keeps emitting the point props those expressions AND the
//     declutter filters read (line, modelId, bearing, favorite, selected) —
//     the icon variants + collision pinning are derived from existing props
//     precisely so the 60 Hz push payload does not grow.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { FACE_SPRITE_SCALE, ICON_PACKS, ICON_PACK_IDS } from '@/lib/fleet/iconPacks';
import { MAP_ICON_ASSETS, MAP_ICON_SCALE } from '@/lib/fleet/modelSpecs';
import { buildFrame } from '@/lib/render/featureBuilder';
import type { TramModelId, Viewport } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1, ORIGIN } from './helpers';

const ICONS_DIR = join(__dirname, '../assets/images/map-icons');
const FACES_DIR = join(__dirname, '../assets/images/faces');
const ALL_MODEL_IDS: TramModelId[] = ['t3', 't3rp', 't3rplf', 'kt8d5', '14t', '15t', '52t'];

/**
 * Every MAP_ICON_ASSETS name the dot/star layers' iconImage expressions can
 * evaluate to. (The cap-* capsule sprites remain in the registry/on disk but
 * no layer references them since the face-badge redesign.)
 */
const EXPECTED_DOT_SPRITES = [
  ...['day', 'night'].flatMap((variant) => [`dot-${variant}`, `dot-${variant}-fav`]),
  'fav-star',
];

describe('map icon sprites', () => {
  it('MAP_ICON_ASSETS contains every name the dot/star layer expressions produce', () => {
    for (const name of EXPECTED_DOT_SPRITES) {
      expect(Object.keys(MAP_ICON_ASSETS)).toContain(name);
    }
  });

  it.each(EXPECTED_DOT_SPRITES)('%s.png is generated and non-empty', (name) => {
    const file = join(ICONS_DIR, `${name}.png`);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(200);
  });

  it('sprite count stays fixed and small (perf invariant: ≤ 20)', () => {
    expect(Object.keys(MAP_ICON_ASSETS).length).toBeLessThanOrEqual(20);
    expect(MAP_ICON_SCALE).toBeGreaterThanOrEqual(1);
  });
});

describe('face badge sprites (band-2 model badges)', () => {
  it('every pack covers exactly the model ids the faceIcon expression can produce', () => {
    // The badge layers' iconImage is concat('face-<pack>-', modelId) over the
    // SELECTED pack — every pack must therefore have one sprite per
    // TramModelId, nothing more (registered-image count stays flat: 4 × 7).
    for (const packId of ICON_PACK_IDS) {
      expect(Object.keys(ICON_PACKS[packId].sprites).sort()).toEqual(
        [...ALL_MODEL_IDS].sort(),
      );
    }
  });

  it.each(ICON_PACK_IDS.flatMap((p) => ALL_MODEL_IDS.map((id) => [p, id] as const)))(
    'faces/%s/%s.png exists and is non-empty',
    (packId, id) => {
      const file = join(FACES_DIR, packId, `${id}.png`);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(200);
    },
  );

  it('face sprite scale is a sane pixel ratio', () => {
    expect(FACE_SPRITE_SCALE).toBeGreaterThanOrEqual(1);
  });
});

describe('points FC props consumed by the icon expressions', () => {
  it('emits line/modelId/bearing/favorite for every tram (and nothing model-icon-specific extra)', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [],
    );
    const viewport: Viewport = { bbox: [ORIGIN[0] - 1, ORIGIN[1] - 1, ORIGIN[0] + 1, ORIGIN[1] + 1], zoom: 12 };
    const state = {
      key: 'T1',
      snapshot: makeSnapshot({ key: 'T1', line: '92', shapeDistM: 500 }),
      model: makeSpec1(),
      simDistM: 500,
      simSpeedKmh: 20,
      position: [ORIGIN[0], ORIGIN[1]] as [number, number],
      bearing: 90,
      phase: 'cruise' as const,
      observedPosition: [ORIGIN[0], ORIGIN[1]] as [number, number],
      observedBearing: 90,
      deviationM: 0,
      fixedDistM: 500,
      pastHorizon: false,
      nextStopName: null,
      nextStopEtaS: null,
      hasGeometry: true,
    };
    const frame = buildFrame([state], viewport, {
      selectedKey: null,
      favoriteKeys: new Set(['T1']),
      coupledPairFn: () => false,
      getGeometry: () => geo,
      nowMs: 1,
    });
    expect(frame.points.features).toHaveLength(1);
    const props = frame.points.features[0].properties;
    // The exact fields DOT_ICON / CAP_ICON / iconRotate read:
    expect(props.line).toBe('92'); // night-line variant switch (to-number ≥ 90)
    expect(ALL_MODEL_IDS).toContain(props.modelId); // cap-<modelId>-<variant>
    expect(typeof props.bearing).toBe('number'); // iconRotate
    expect(props.favorite).toBe(1); // -fav / fav-star
    expect(props.geometryless).toBe(0); // has geometry → drawn on-shape, not a dot
    // Payload guard: no unexpected prop creep on the 60 Hz push path.
    expect(Object.keys(props).sort()).toEqual(
      ['bearing', 'favorite', 'geometryless', 'key', 'line', 'modelId', 'selected', 'stale'].sort(),
    );
  });
});
