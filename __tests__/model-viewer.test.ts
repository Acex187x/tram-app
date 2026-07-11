// Pure math behind the /model/[id] 3D viewer: orbit gestures, consist layout,
// camera framing. The GL screen itself is device-verified; these tests pin the
// math it feeds into three.js.
import { describe, expect, it } from '@jest/globals';

import {
  AZIMUTH_DEG_PER_PX,
  clamp,
  ELEVATION_MAX_DEG,
  ELEVATION_MIN_DEG,
  fitRadius,
  layoutSections,
  normalizeAzimuthDeg,
  orbitToPosition,
  panOrbit,
  pinchOrbit,
  SECTION_GAP_M,
  viewerBackgroundColor,
  type OrbitState,
} from '@/components/model/orbitMath';
import { MODEL_SPECS } from '@/lib/fleet/modelSpecs';

const BASE: OrbitState = { azimuthDeg: -32, elevationDeg: 14, radiusM: 40 };

describe('panOrbit', () => {
  it('maps horizontal translation to azimuth at the documented rate', () => {
    const o = panOrbit(BASE, 100, 0);
    expect(o.azimuthDeg).toBeCloseTo(-32 + 100 * AZIMUTH_DEG_PER_PX, 6);
    expect(o.elevationDeg).toBe(BASE.elevationDeg);
    expect(o.radiusM).toBe(BASE.radiusM);
  });

  it('clamps elevation to [5, 70] degrees', () => {
    expect(panOrbit(BASE, 0, 10_000).elevationDeg).toBe(ELEVATION_MAX_DEG);
    expect(panOrbit(BASE, 0, -10_000).elevationDeg).toBe(ELEVATION_MIN_DEG);
  });

  it('keeps azimuth wrapped to [-180, 180)', () => {
    const o = panOrbit(BASE, 100_000, 0);
    expect(o.azimuthDeg).toBeGreaterThanOrEqual(-180);
    expect(o.azimuthDeg).toBeLessThan(180);
  });
});

describe('pinchOrbit', () => {
  it('scale > 1 dollies closer, scale < 1 dollies away', () => {
    expect(pinchOrbit(BASE, 2, 5, 120).radiusM).toBeCloseTo(20, 6);
    expect(pinchOrbit(BASE, 0.5, 5, 120).radiusM).toBeCloseTo(80, 6);
  });

  it('clamps the dolly range and survives a degenerate scale', () => {
    expect(pinchOrbit(BASE, 100, 5, 120).radiusM).toBe(5);
    expect(pinchOrbit(BASE, 0.01, 5, 120).radiusM).toBe(120);
    expect(pinchOrbit(BASE, 0, 5, 120).radiusM).toBe(120); // no division blow-up
    expect(pinchOrbit(BASE, 2, 5, 120).azimuthDeg).toBe(BASE.azimuthDeg);
  });
});

describe('orbitToPosition', () => {
  const target = { x: 0, y: 1.5, z: 15 };

  it('azimuth 0 puts the camera on the −Z side of the target (facing the nose)', () => {
    const p = orbitToPosition({ azimuthDeg: 0, elevationDeg: 0, radiusM: 10 }, target);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1.5, 6);
    expect(p.z).toBeCloseTo(5, 6);
  });

  it('keeps the camera exactly radiusM from the target for any angles', () => {
    for (const az of [-135, -32, 0, 45, 170]) {
      for (const el of [5, 14, 70]) {
        const p = orbitToPosition({ azimuthDeg: az, elevationDeg: el, radiusM: 22 }, target);
        const d = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
        expect(d).toBeCloseTo(22, 6);
      }
    }
  });

  it('elevation raises the camera above the target', () => {
    const p = orbitToPosition({ azimuthDeg: -32, elevationDeg: 30, radiusM: 10 }, target);
    expect(p.y).toBeGreaterThan(target.y);
  });
});

describe('layoutSections', () => {
  it('lays sections end-to-end with the standard gap (like render-model.mjs)', () => {
    // Two 10 m sections centered on their own origin: extent [-5, 5].
    const offsets = layoutSections([
      { minZ: -5, maxZ: 5 },
      { minZ: -5, maxZ: 5 },
    ]);
    expect(offsets[0]).toBeCloseTo(5, 6); // first section spans [0, 10]
    expect(offsets[1]).toBeCloseTo(15 + SECTION_GAP_M, 6); // second spans [10+gap, 20+gap]
  });

  it('positions a full 15T consist to spec length + gaps', () => {
    const spec = MODEL_SPECS['15t'];
    const extents = spec.sections.map((s) => ({ minZ: -s.lengthM / 2, maxZ: s.lengthM / 2 }));
    const offsets = layoutSections(extents);
    const tailZ = offsets[offsets.length - 1] + extents[extents.length - 1].maxZ;
    const expected =
      spec.sections.reduce((sum, s) => sum + s.lengthM, 0) +
      SECTION_GAP_M * (spec.sections.length - 1);
    expect(tailZ).toBeCloseTo(expected, 6);
    // Nose of the consist sits at z = 0 (the −Z end).
    expect(offsets[0] + extents[0].minZ).toBeCloseTo(0, 6);
  });

  it('handles an empty list', () => {
    expect(layoutSections([])).toEqual([]);
  });
});

describe('fitRadius', () => {
  it('frames longer consists from further away, at any aspect', () => {
    for (const aspect of [0.5, 1, 2]) {
      const short = fitRadius({ x: 2.5, y: 3.1, z: 14.1 }, 40, aspect);
      const long = fitRadius({ x: 2.5, y: 3.5, z: 32 }, 40, aspect);
      expect(long).toBeGreaterThan(short);
      expect(short).toBeGreaterThan(0);
    }
  });

  it('distance is at least the bounding-sphere radius (camera outside the model)', () => {
    const size = { x: 2.46, y: 3.45, z: 32 };
    const r = fitRadius(size, 40, 0.46); // portrait phone
    expect(r).toBeGreaterThan(0.5 * Math.hypot(size.x, size.y, size.z));
  });

  it('falls back to a sane default on degenerate input', () => {
    expect(fitRadius({ x: 0, y: 0, z: 0 }, 40, 1)).toBe(10);
    expect(fitRadius({ x: 1, y: 1, z: 1 }, 0, 1)).toBe(10);
  });
});

describe('misc helpers', () => {
  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('normalizeAzimuthDeg wraps into [-180, 180)', () => {
    expect(normalizeAzimuthDeg(0)).toBe(0);
    expect(normalizeAzimuthDeg(180)).toBe(-180);
    expect(normalizeAzimuthDeg(-180)).toBe(-180);
    expect(normalizeAzimuthDeg(540)).toBe(-180);
    expect(normalizeAzimuthDeg(-361)).toBeCloseTo(-1, 6);
    expect(normalizeAzimuthDeg(725)).toBeCloseTo(5, 6);
  });

  it('viewerBackgroundColor is theme-aware per spec', () => {
    expect(viewerBackgroundColor('dark')).toBe('#101014');
    expect(viewerBackgroundColor('light')).toBe('#ECECF2');
  });
});
