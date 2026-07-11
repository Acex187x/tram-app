import { describe, expect, it } from '@jest/globals';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MODEL_ASSETS, MODEL_SPECS } from '@/lib/fleet/modelSpecs';
import type { TramModelId, TramModelSpec } from '@/lib/types';

const MODELS_DIR = join(__dirname, '../assets/models');
const ALL_IDS: TramModelId[] = ['t3', 't3rp', 't3rplf', 'kt8d5', '14t', '15t', '52t'];
const specs: [TramModelId, TramModelSpec][] = ALL_IDS.map((id) => [id, MODEL_SPECS[id]]);

describe('MODEL_SPECS', () => {
  it('has a spec for every TramModelId', () => {
    for (const [id, spec] of specs) {
      expect(spec).toBeDefined();
      expect(spec.id).toBe(id);
    }
  });

  it.each(specs)('%s: section lengths + joint gaps ≈ totalLengthM (±0.6 m)', (_id, spec) => {
    const sectionSum = spec.sections.reduce((s, sec) => s + sec.lengthM, 0);
    const gaps = spec.jointGapM * (spec.sections.length - 1);
    expect(Math.abs(sectionSum + gaps - spec.totalLengthM)).toBeLessThanOrEqual(0.6);
  });

  it.each(specs)('%s: plausible physical dimensions', (_id, spec) => {
    expect(spec.widthM).toBeGreaterThanOrEqual(2.4);
    expect(spec.widthM).toBeLessThanOrEqual(2.65);
    expect(spec.heightM).toBeGreaterThanOrEqual(3.0);
    expect(spec.heightM).toBeLessThanOrEqual(3.6);
    expect(spec.totalLengthM).toBeGreaterThan(13);
    expect(spec.totalLengthM).toBeLessThan(33);
    for (const sec of spec.sections) {
      expect(sec.lengthM).toBeGreaterThan(3);
      expect(sec.lengthM).toBeLessThanOrEqual(15);
    }
  });

  it('uses unique modelKeys across all specs', () => {
    const keys = specs.flatMap(([, spec]) => spec.sections.map((s) => s.modelKey));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('MODEL_ASSETS', () => {
  it('has an entry for every sections[].modelKey', () => {
    for (const [, spec] of specs) {
      for (const sec of spec.sections) {
        expect(MODEL_ASSETS).toHaveProperty(sec.modelKey);
      }
    }
  });

  it('has no orphan entries that no spec references', () => {
    const referenced = new Set(specs.flatMap(([, spec]) => spec.sections.map((s) => s.modelKey)));
    for (const key of Object.keys(MODEL_ASSETS)) {
      expect(referenced.has(key)).toBe(true);
    }
  });

  it('every modelKey has a generated, non-empty GLB on disk', () => {
    for (const key of Object.keys(MODEL_ASSETS)) {
      const glbPath = join(MODELS_DIR, `${key}.glb`);
      expect(existsSync(glbPath)).toBe(true);
      const size = statSync(glbPath).size;
      expect(size).toBeGreaterThan(1024); // real geometry, not a stub
      expect(size).toBeLessThanOrEqual(150 * 1024); // ≤150 KB per section
    }
  });
});
