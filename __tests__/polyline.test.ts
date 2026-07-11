/// <reference types="jest" />

import {
  bearingAt,
  bearingBetween,
  cumulativeDistances,
  curvatureProfile,
  destinationPoint,
  haversineM,
  pointAt,
  projectPointToPolyline,
  segmentIndexAt,
  type LngLat,
} from '@/lib/geo/polyline';
import { angularDiff, makeGeometry, metersToCoord, ORIGIN } from './helpers';

describe('haversineM', () => {
  it('measures 0.01° of latitude as ~1112 m', () => {
    const a: LngLat = [14.42, 50.08];
    const b: LngLat = [14.42, 50.09];
    expect(haversineM(a, b)).toBeCloseTo(1111.95, -1);
  });

  it('is zero for identical points', () => {
    expect(haversineM([14.42, 50.08], [14.42, 50.08])).toBe(0);
  });

  it('is symmetric', () => {
    const a: LngLat = [14.4, 50.05];
    const b: LngLat = [14.5, 50.1];
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
  });
});

describe('cumulativeDistances', () => {
  it('starts at 0 and is monotonically non-decreasing', () => {
    const coords: LngLat[] = [
      metersToCoord(ORIGIN, 0, 0),
      metersToCoord(ORIGIN, 100, 0),
      metersToCoord(ORIGIN, 100, 0), // duplicate
      metersToCoord(ORIGIN, 100, 250),
    ];
    const cum = cumulativeDistances(coords);
    expect(cum[0]).toBe(0);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1]);
    expect(cum[cum.length - 1]).toBeCloseTo(350, 0);
  });
});

describe('pointAt', () => {
  const coords: LngLat[] = [
    metersToCoord(ORIGIN, 0, 0),
    metersToCoord(ORIGIN, 1000, 0),
  ];
  const cum = cumulativeDistances(coords);

  it('interpolates linearly along a straight line', () => {
    const mid = pointAt(coords, cum, cum[1] / 2);
    const expected = metersToCoord(ORIGIN, 500, 0);
    expect(haversineM(mid, expected)).toBeLessThan(1);
  });

  it('clamps below 0 to the start', () => {
    expect(pointAt(coords, cum, -50)).toEqual(coords[0]);
  });

  it('clamps beyond the end to the last vertex', () => {
    expect(pointAt(coords, cum, 99999)).toEqual(coords[1]);
  });

  it('survives duplicate vertices (zero-length segments)', () => {
    const dup: LngLat[] = [
      metersToCoord(ORIGIN, 0, 0),
      metersToCoord(ORIGIN, 100, 0),
      metersToCoord(ORIGIN, 100, 0),
      metersToCoord(ORIGIN, 200, 0),
    ];
    const dupCum = cumulativeDistances(dup);
    const p = pointAt(dup, dupCum, dupCum[1]); // exactly at the duplicate
    expect(Number.isFinite(p[0])).toBe(true);
    expect(haversineM(p, dup[1])).toBeLessThan(0.5);
  });
});

describe('segmentIndexAt', () => {
  it('finds the bracketing segment', () => {
    const cum = [0, 100, 250, 400];
    expect(segmentIndexAt(cum, -5)).toBe(0);
    expect(segmentIndexAt(cum, 0)).toBe(0);
    expect(segmentIndexAt(cum, 99)).toBe(0);
    expect(segmentIndexAt(cum, 100)).toBe(1);
    expect(segmentIndexAt(cum, 399)).toBe(2);
    expect(segmentIndexAt(cum, 400)).toBe(2);
    expect(segmentIndexAt(cum, 999)).toBe(2);
  });
});

describe('bearingBetween / bearingAt', () => {
  it('east line has bearing ~90', () => {
    const a = metersToCoord(ORIGIN, 0, 0);
    const b = metersToCoord(ORIGIN, 500, 0);
    expect(angularDiff(bearingBetween(a, b), 90)).toBeLessThan(0.5);
  });

  it('north line has bearing ~0', () => {
    const coords: LngLat[] = [metersToCoord(ORIGIN, 0, 0), metersToCoord(ORIGIN, 0, 500)];
    const cum = cumulativeDistances(coords);
    expect(angularDiff(bearingAt(coords, cum, 250), 0)).toBeLessThan(0.5);
  });

  it('is stable at the ends (clamped ±2 m window)', () => {
    const coords: LngLat[] = [metersToCoord(ORIGIN, 0, 0), metersToCoord(ORIGIN, 300, 0)];
    const cum = cumulativeDistances(coords);
    expect(angularDiff(bearingAt(coords, cum, 0), 90)).toBeLessThan(1);
    expect(angularDiff(bearingAt(coords, cum, cum[1]), 90)).toBeLessThan(1);
  });

  it('averages across an L-corner and differs on each leg', () => {
    const coords: LngLat[] = [
      metersToCoord(ORIGIN, 0, 0),
      metersToCoord(ORIGIN, 100, 0),
      metersToCoord(ORIGIN, 100, 100),
    ];
    const cum = cumulativeDistances(coords);
    const before = bearingAt(coords, cum, 50); // east leg
    const after = bearingAt(coords, cum, 150); // north leg
    expect(angularDiff(before, 90)).toBeLessThan(1);
    expect(angularDiff(after, 0)).toBeLessThan(1);
    expect(angularDiff(before, after)).toBeGreaterThan(85);
  });

  it('handles duplicate vertices without NaN', () => {
    const coords: LngLat[] = [
      metersToCoord(ORIGIN, 0, 0),
      metersToCoord(ORIGIN, 0, 0),
      metersToCoord(ORIGIN, 200, 0),
    ];
    const cum = cumulativeDistances(coords);
    const b = bearingAt(coords, cum, 0);
    expect(Number.isFinite(b)).toBe(true);
    expect(angularDiff(b, 90)).toBeLessThan(1);
  });
});

describe('destinationPoint', () => {
  it('moves the requested distance toward the bearing', () => {
    const start = metersToCoord(ORIGIN, 0, 0);
    const dest = destinationPoint(start, 90, 100);
    expect(haversineM(start, dest)).toBeCloseTo(100, 0);
    expect(angularDiff(bearingBetween(start, dest), 90)).toBeLessThan(1);
  });
});

describe('curvatureProfile', () => {
  it('is ~0 on a straight line', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [200, 0],
        [400, 0],
        [600, 0],
      ],
      [],
    );
    const kappa = curvatureProfile(geo.coordinates, geo.cumDistM);
    for (const k of kappa) expect(k).toBeLessThan(0.002);
  });

  it('spikes at a sharp 90° corner (~π/2 over a 20 m window)', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [500, 500],
      ],
      [],
    );
    const kappa = curvatureProfile(geo.coordinates, geo.cumDistM);
    expect(kappa[1]).toBeGreaterThan(0.05); // ≈ 0.0785 rad/m
    expect(kappa[0]).toBeLessThan(0.002);
    expect(kappa[2]).toBeLessThan(0.002);
  });

  it('handles duplicate points and zero-length segments', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [100, 0],
        [100, 0],
        [100, 100],
      ],
      [],
    );
    const kappa = curvatureProfile(geo.coordinates, geo.cumDistM);
    for (const k of kappa) expect(Number.isFinite(k)).toBe(true);
    // The corner is still detected despite the duplicate vertex.
    expect(Math.max(...kappa)).toBeGreaterThan(0.05);
  });

  it('returns zeros for degenerate shapes', () => {
    const p = metersToCoord(ORIGIN, 0, 0);
    const coords: LngLat[] = [p, p, p];
    expect(curvatureProfile(coords, cumulativeDistances(coords))).toEqual([0, 0, 0]);
  });
});

describe('projectPointToPolyline', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );

  it('projects a point beside the line onto the nearest along-distance', () => {
    const p = metersToCoord(ORIGIN, 300, 10); // 10 m north of the 300 m mark
    const proj = projectPointToPolyline(p, geo.coordinates, geo.cumDistM);
    expect(proj.distM).toBeCloseTo(300, -1);
    expect(proj.offsetM).toBeCloseTo(10, 0);
  });

  it('clamps to the segment ends', () => {
    const p = metersToCoord(ORIGIN, -50, 0);
    const proj = projectPointToPolyline(p, geo.coordinates, geo.cumDistM);
    expect(proj.distM).toBe(0);
    expect(proj.offsetM).toBeCloseTo(50, 0);
  });

  it('picks the closer leg of an L-shape', () => {
    const l = makeGeometry(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      [],
    );
    const p = metersToCoord(ORIGIN, 95, 60); // 5 m west of the north leg
    const proj = projectPointToPolyline(p, l.coordinates, l.cumDistM);
    expect(proj.distM).toBeCloseTo(160, -1);
    expect(proj.offsetM).toBeCloseTo(5, 0);
  });
});