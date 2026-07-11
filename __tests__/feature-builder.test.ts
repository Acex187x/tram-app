/// <reference types="jest" />

import { bearingAt, haversineM, pointAt } from '@/lib/geo/polyline';
import { buildFrame, COUPLED_OFFSET_M, type BuildFrameOptions } from '@/lib/render/featureBuilder';
import type { RouteGeometry, TramPublicState, Viewport } from '@/lib/types';
import { angularDiff, makeGeometry, makeSnapshot, makeSpec1, makeSpec3, metersToCoord, ORIGIN } from './helpers';

function makeState(
  key: string,
  geo: RouteGeometry | null,
  simDistM: number,
  overrides: Partial<TramPublicState> = {},
): TramPublicState {
  const base: TramPublicState = {
    key,
    snapshot: makeSnapshot({ key }),
    model: makeSpec3(),
    simDistM,
    simSpeedKmh: 20,
    position: geo ? pointAt(geo.coordinates, geo.cumDistM, simDistM) : [ORIGIN[0], ORIGIN[1]],
    bearing: geo ? bearingAt(geo.coordinates, geo.cumDistM, simDistM) : 45,
    phase: geo ? 'cruise' : 'unknown',
    nextStopName: null,
    nextStopEtaS: null,
    hasGeometry: geo !== null,
  };
  return { ...base, ...overrides };
}

/** Viewport whose bbox spans the given local-meter rectangle around ORIGIN. */
function viewportM(x0: number, y0: number, x1: number, y1: number, zoom: number): Viewport {
  const sw = metersToCoord(ORIGIN, x0, y0);
  const ne = metersToCoord(ORIGIN, x1, y1);
  return { bbox: [sw[0], sw[1], ne[0], ne[1]], zoom };
}

function opts(geo: RouteGeometry | null, extra: Partial<BuildFrameOptions> = {}): BuildFrameOptions {
  return {
    selectedKey: null,
    favoriteKeys: new Set<string>(),
    coupledPairFn: () => false,
    getGeometry: () => geo ?? undefined,
    nowMs: 12_345,
    ...extra,
  };
}

const WIDE = viewportM(-2000, -2000, 2000, 2000, 16);

describe('points collection', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );

  it('includes ALL trams regardless of zoom and viewport, with correct props', () => {
    const states = [
      makeState('9201', geo, 300),
      makeState('8123', null, 0),
    ];
    const frame = buildFrame(states, viewportM(5000, 5000, 6000, 6000, 12), {
      ...opts(geo),
      selectedKey: '9201',
      favoriteKeys: new Set(['8123']),
    });
    expect(frame.points.features).toHaveLength(2);
    expect(frame.atMs).toBe(12_345);
    const p1 = frame.points.features.find((f) => f.id === '9201')!;
    expect(p1.properties.selected).toBe(1);
    expect(p1.properties.favorite).toBe(0);
    expect(p1.properties.line).toBe('9');
    expect(p1.properties.modelId).toBe('15t');
    const p2 = frame.points.features.find((f) => f.id === '8123')!;
    expect(p2.properties.selected).toBe(0);
    expect(p2.properties.favorite).toBe(1);
  });
});

describe('section placement on an L-shaped track', () => {
  // East 100 m then north 100 m; 3-section tram with head 15 m past the corner.
  const geo = makeGeometry(
    [
      [0, 0],
      [100, 0],
      [100, 100],
    ],
    [],
  );
  const state = makeState('9201', geo, 115);

  it('bends: per-section positions/bearings differ across the corner', () => {
    const frame = buildFrame([state], WIDE, opts(geo));
    expect(frame.sections.features).toHaveLength(3);
    const [head, mid, tail] = frame.sections.features;
    expect(head.id).toBe('9201#0');
    expect(mid.id).toBe('9201#1');
    expect(tail.id).toBe('9201#2');
    expect(head.properties.modelKey).toBe('15t-a');
    expect(tail.properties.modelKey).toBe('15t-c');

    // Head section (center s=110) is on the north leg → bearing ~0.
    expect(angularDiff(head.properties.bearing, 0)).toBeLessThan(6);
    // Tail section (center s=89) is on the east leg → bearing ~90.
    expect(angularDiff(tail.properties.bearing, 90)).toBeLessThan(6);
    expect(angularDiff(head.properties.bearing, tail.properties.bearing)).toBeGreaterThan(80);

    // Positions match the polyline at the expected center distances.
    const headPos = head.geometry.coordinates as [number, number];
    expect(haversineM(headPos, metersToCoord(ORIGIN, 100, 10))).toBeLessThan(2);
    const tailPos = tail.geometry.coordinates as [number, number];
    expect(haversineM(tailPos, metersToCoord(ORIGIN, 89, 0))).toBeLessThan(2);
  });

  it('extrapolates rear sections behind the shape start, keeping physical spacing', () => {
    // Head 5 m into the shape → section centers at s = 0, −10.5, −21. Negative
    // centers extrapolate straight back along the first segment bearing (east)
    // instead of piling up at vertex zero.
    const frame = buildFrame([makeState('9201', geo, 5)], WIDE, opts(geo));
    expect(frame.sections.features).toHaveLength(3);
    const pos = frame.sections.features.map((f) => f.geometry.coordinates as [number, number]);
    expect(haversineM(pos[0], metersToCoord(ORIGIN, 0, 0))).toBeLessThan(1);
    expect(haversineM(pos[1], metersToCoord(ORIGIN, -10.5, 0))).toBeLessThan(1);
    expect(haversineM(pos[2], metersToCoord(ORIGIN, -21, 0))).toBeLessThan(1);
    // Spacing between consecutive centers = section length + joint gap.
    expect(haversineM(pos[0], pos[1])).toBeCloseTo(10.5, 1);
    expect(haversineM(pos[1], pos[2])).toBeCloseTo(10.5, 1);
    // All sections keep the first-segment bearing (east).
    for (const f of frame.sections.features) {
      expect(angularDiff(f.properties.bearing, 90)).toBeLessThan(6);
    }
  });

  it('keeps the coupled trailer 14.5 m behind even at the shape start', () => {
    const state = makeState('8123', geo, 5, { model: makeSpec1() });
    const frame = buildFrame([state], WIDE, opts(geo, { coupledPairFn: () => true }));
    expect(frame.sections.features).toHaveLength(2);
    const [lead, trail] = frame.sections.features;
    const d = haversineM(
      lead.geometry.coordinates as [number, number],
      trail.geometry.coordinates as [number, number],
    );
    expect(d).toBeCloseTo(COUPLED_OFFSET_M, 1);
    expect(angularDiff(lead.properties.bearing, trail.properties.bearing)).toBeLessThan(1);
  });

  it('emits stable feature ids across frames', () => {
    const a = buildFrame([state], WIDE, opts(geo));
    const b = buildFrame([state], WIDE, opts(geo));
    expect(a.sections.features.map((f) => f.id)).toEqual(b.sections.features.map((f) => f.id));
    expect(a.points.features.map((f) => f.id)).toEqual(b.points.features.map((f) => f.id));
  });
});

describe('viewport culling', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );
  const state = makeState('9201', geo, 100); // tram at ~(100, 0) meters

  it('emits no sections below zoom 14.8', () => {
    const frame = buildFrame([state], viewportM(-2000, -2000, 2000, 2000, 14.7), opts(geo));
    expect(frame.sections.features).toHaveLength(0);
    expect(frame.points.features).toHaveLength(1);
  });

  it('emits sections at/above zoom 14.8', () => {
    const frame = buildFrame([state], viewportM(-2000, -2000, 2000, 2000, 14.8), opts(geo));
    expect(frame.sections.features.length).toBeGreaterThan(0);
  });

  it('culls trams outside the bbox + 300 m margin (points remain)', () => {
    // East edge 500 m west of the tram → outside even with the 300 m margin.
    const far = buildFrame([state], viewportM(-1000, -1000, -400, 1000, 16), opts(geo));
    expect(far.sections.features).toHaveLength(0);
    expect(far.points.features).toHaveLength(1);
  });

  it('keeps trams within 300 m outside the bbox (margin)', () => {
    // East edge 200 m west of the tram → inside thanks to the margin.
    const near = buildFrame([state], viewportM(-1000, -1000, -100, 1000, 16), opts(geo));
    expect(near.sections.features.length).toBeGreaterThan(0);
  });
});

describe('coupled T3 pairs', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [200, 0],
    ],
    [],
  );

  it('duplicates the single section 14.5 m behind along the shape', () => {
    const state = makeState('8123', geo, 100, { model: makeSpec1() });
    const frame = buildFrame([state], WIDE, opts(geo, { coupledPairFn: (k) => k === '8123' }));
    expect(frame.sections.features).toHaveLength(2);
    const [lead, trail] = frame.sections.features;
    expect(lead.id).toBe('8123#0');
    expect(trail.id).toBe('8123#c0');
    expect(trail.properties.modelKey).toBe(lead.properties.modelKey); // suffix unchanged
    const d = haversineM(
      lead.geometry.coordinates as [number, number],
      trail.geometry.coordinates as [number, number],
    );
    expect(d).toBeCloseTo(COUPLED_OFFSET_M, 0);
    expect(angularDiff(lead.properties.bearing, trail.properties.bearing)).toBeLessThan(1);
  });
});

describe('trams without geometry', () => {
  it('renders a single section at the raw position with the snapshot bearing', () => {
    const state = makeState('8123', null, 0, {
      model: makeSpec1(),
      position: metersToCoord(ORIGIN, 50, 50),
      bearing: 45,
    });
    const frame = buildFrame([state], WIDE, opts(null));
    expect(frame.sections.features).toHaveLength(1);
    const f = frame.sections.features[0];
    expect(f.id).toBe('8123#0');
    expect(f.properties.modelKey).toBe('t3rp');
    expect(f.properties.bearing).toBe(45);
    expect(haversineM(f.geometry.coordinates as [number, number], metersToCoord(ORIGIN, 50, 50))).toBeLessThan(0.5);
  });

  it('places the coupled trailer behind along the raw bearing', () => {
    const state = makeState('8123', null, 0, {
      model: makeSpec1(),
      position: metersToCoord(ORIGIN, 50, 50),
      bearing: 90,
    });
    const frame = buildFrame([state], WIDE, opts(null, { coupledPairFn: () => true }));
    expect(frame.sections.features).toHaveLength(2);
    const trail = frame.sections.features[1];
    const d = haversineM(
      frame.sections.features[0].geometry.coordinates as [number, number],
      trail.geometry.coordinates as [number, number],
    );
    expect(d).toBeCloseTo(COUPLED_OFFSET_M, 0);
    // Trailer is west of the lead (bearing 90 → behind = 270).
    expect((trail.geometry.coordinates as [number, number])[0]).toBeLessThan(
      (frame.sections.features[0].geometry.coordinates as [number, number])[0],
    );
  });
});