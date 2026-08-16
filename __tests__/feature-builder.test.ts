/// <reference types="jest" />

import { bearingAt, destinationPoint, haversineM, pointAt, type LngLat } from '@/lib/geo/polyline';
import {
  buildFrame,
  COUPLED_OFFSET_M,
  TRACK_OFFSET_M,
  type BuildFrameOptions,
} from '@/lib/render/featureBuilder';
import type { RouteGeometry, TramPublicState, Viewport } from '@/lib/types';
import { angularDiff, makeGeometry, makeSnapshot, makeSpec1, makeSpec3, metersToCoord, ORIGIN } from './helpers';

function makeState(
  key: string,
  geo: RouteGeometry | null,
  simDistM: number,
  overrides: Partial<TramPublicState> = {},
): TramPublicState {
  // Observed fields mirror the engine: the merged snapshot's shapeDistM placed
  // on the shape (defaults to simDistM → zero deviation), raw coords otherwise.
  const snapshot = overrides.snapshot ?? makeSnapshot({ key, shapeDistM: simDistM });
  const obsDistM = geo ? Math.min(Math.max(snapshot.shapeDistM, 0), geo.totalM) : 0;
  const base: TramPublicState = {
    key,
    snapshot,
    model: makeSpec3(),
    simDistM,
    simSpeedKmh: 20,
    position: geo ? pointAt(geo.coordinates, geo.cumDistM, simDistM) : [ORIGIN[0], ORIGIN[1]],
    bearing: geo ? bearingAt(geo.coordinates, geo.cumDistM, simDistM) : 45,
    phase: geo ? 'cruise' : 'unknown',
    observedPosition: geo
      ? pointAt(geo.coordinates, geo.cumDistM, obsDistM)
      : [snapshot.coordinates[0], snapshot.coordinates[1]],
    observedBearing: geo ? bearingAt(geo.coordinates, geo.cumDistM, obsDistM) : (snapshot.bearing ?? 0),
    deviationM: geo ? Math.abs(simDistM - obsDistM) : null,
    // Default «fixed» curve position = the raw fix distance (as just after a
    // re-anchor); tests override it to exercise the smooth↔fixed comparison.
    fixedDistM: geo ? obsDistM : null,
    pastHorizon: false,
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

/** Expected rendered position: track position shifted right of bearing. */
function rightOf(p: LngLat, bearing: number): LngLat {
  return destinationPoint(p, (bearing + 90) % 360, TRACK_OFFSET_M);
}

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

  it('marks the FOLLOWED tram selected:1 (badge pinning must survive follow outliving selection)', () => {
    // The map's badge declutter pins selected:1 trams out of the collision
    // pass; a followed tram must never be hidden even when the sheet's
    // selection was cleared.
    const states = [makeState('9201', geo, 300), makeState('8123', geo, 500)];
    const frame = buildFrame(states, WIDE, {
      ...opts(geo),
      selectedKey: null,
      followedKey: '8123',
    });
    const followed = frame.points.features.find((f) => f.id === '8123')!;
    expect(followed.properties.selected).toBe(1);
    const other = frame.points.features.find((f) => f.id === '9201')!;
    expect(other.properties.selected).toBe(0);
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

    // Positions match the polyline at the expected center distances (shifted
    // right of the local bearing by the track offset).
    const headPos = head.geometry.coordinates as [number, number];
    expect(
      haversineM(headPos, rightOf(metersToCoord(ORIGIN, 100, 10), head.properties.bearing)),
    ).toBeLessThan(1);
    const tailPos = tail.geometry.coordinates as [number, number];
    expect(
      haversineM(tailPos, rightOf(metersToCoord(ORIGIN, 89, 0), tail.properties.bearing)),
    ).toBeLessThan(1);
  });

  it('extrapolates rear sections behind the shape start, keeping physical spacing', () => {
    // Head 5 m into the shape → section centers at s = 0, −10.5, −21. Negative
    // centers extrapolate straight back along the first segment bearing (east)
    // instead of piling up at vertex zero.
    const frame = buildFrame([makeState('9201', geo, 5)], WIDE, opts(geo));
    expect(frame.sections.features).toHaveLength(3);
    const pos = frame.sections.features.map((f) => f.geometry.coordinates as [number, number]);
    // Track runs east (bearing 90) → rendered positions sit TRACK_OFFSET_M south.
    expect(haversineM(pos[0], rightOf(metersToCoord(ORIGIN, 0, 0), 90))).toBeLessThan(1);
    expect(haversineM(pos[1], rightOf(metersToCoord(ORIGIN, -10.5, 0), 90))).toBeLessThan(1);
    expect(haversineM(pos[2], rightOf(metersToCoord(ORIGIN, -21, 0), 90))).toBeLessThan(1);
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

describe('trams without geometry (render as a bare dot, no 3D body)', () => {
  // A tram whose shape hasn't loaded yet (trip just changed / geometry
  // streaming in) MUST NOT render an articulated 3D body: placing sections
  // along the unreliable raw AVL bearing stood the tram at an angle off the
  // drawn network (sometimes inside buildings). It renders as ONLY a point at
  // its raw GPS position — no sections, no perpendicular track offset — with
  // geometryless:1 so the map draws a plain un-oriented dot.
  it('emits NO sections — only a single point at the RAW position (no track offset)', () => {
    const rawPos = metersToCoord(ORIGIN, 50, 50);
    const state = makeState('8123', null, 0, {
      model: makeSpec1(),
      position: rawPos,
      bearing: 45,
    });
    const frame = buildFrame([state], WIDE, opts(null));

    // No 3D sections at all.
    expect(frame.sections.features).toHaveLength(0);

    // Exactly one point, at the raw position with NO perpendicular offset.
    expect(frame.points.features).toHaveLength(1);
    const p = frame.points.features[0];
    expect(p.id).toBe('8123');
    expect(p.properties.geometryless).toBe(1);
    expect(haversineM(p.geometry.coordinates as [number, number], rawPos)).toBeLessThan(1e-6);
    // …and pointedly NOT offset to the right of the bearing (the old bug).
    expect(
      haversineM(p.geometry.coordinates as [number, number], rightOf(rawPos, 45)),
    ).toBeGreaterThan(TRACK_OFFSET_M - 0.2);
  });

  it('emits no sections for a multi-section (articulated) geometry-less tram', () => {
    // Regression guard: articulated trams without geometry must not fall back
    // to a straight-line body along the raw bearing.
    const state = makeState('9201', null, 0, {
      position: metersToCoord(ORIGIN, 0, 0),
      bearing: 0,
    });
    const frame = buildFrame([state], WIDE, opts(null));
    expect(frame.sections.features).toHaveLength(0);
    expect(frame.points.features).toHaveLength(1);
    expect(frame.points.features[0].properties.geometryless).toBe(1);
  });

  it('emits no sections even when coupled', () => {
    const state = makeState('8123', null, 0, {
      model: makeSpec1(),
      position: metersToCoord(ORIGIN, 50, 50),
      bearing: 90,
    });
    const frame = buildFrame([state], WIDE, opts(null, { coupledPairFn: () => true }));
    expect(frame.sections.features).toHaveLength(0);
  });

  it('marks trams WITH geometry as geometryless:0', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [0, 0.02],
      ],
      [
        { atM: 0, arrivalMs: 0 },
        { atM: 2000, arrivalMs: 600_000, isTerminal: true },
      ],
    );
    const state = makeState('7700', geo, 300);
    const frame = buildFrame([state], WIDE, opts(geo));
    expect(frame.points.features[0].properties.geometryless).toBe(0);
    // …and it DOES draw a body (contrast with the geometry-less cases above).
    expect(frame.sections.features.length).toBeGreaterThan(0);
  });
});

describe('right-hand traffic offset', () => {
  // Track heading due north → "right" is due east.
  const geo = makeGeometry(
    [
      [0, -500],
      [0, 500],
    ],
    [],
  );

  it('shifts points and every section TRACK_OFFSET_M east of a northbound track', () => {
    const state = makeState('9201', geo, 540); // head at local y = +40
    const frame = buildFrame([state], WIDE, opts(geo));

    const point = frame.points.features[0].geometry.coordinates as [number, number];
    expect(haversineM(point, rightOf(state.position, state.bearing))).toBeLessThan(0.05);
    // Eastward (positive lng) shift of ~1.35 m from the on-track position.
    expect(point[0]).toBeGreaterThan(state.position[0]);
    expect(haversineM(point, state.position)).toBeCloseTo(TRACK_OFFSET_M, 1);

    for (const f of frame.sections.features) {
      const p = f.geometry.coordinates as [number, number];
      // Each section sits TRACK_OFFSET_M east of the track (the lng of the
      // vertical line at local x=0); shifting it back west lands on the track.
      expect(p[0]).toBeGreaterThan(geo.coordinates[0][0]);
      const backOnTrack = destinationPoint(p, 270, TRACK_OFFSET_M);
      expect(Math.abs(backOnTrack[0] - geo.coordinates[0][0])).toBeLessThan(1e-7);
    }
  });

  it('opposite directions separate by ~2× the offset', () => {
    const north = makeState('9201', geo, 500); // heading north at y=0
    const southGeo = makeGeometry(
      [
        [0, 500],
        [0, -500],
      ],
      [],
    );
    const south = makeState('9301', southGeo, 500, {
      position: pointAt(southGeo.coordinates, southGeo.cumDistM, 500),
      bearing: bearingAt(southGeo.coordinates, southGeo.cumDistM, 500),
    });
    const a = buildFrame([north], WIDE, opts(geo)).points.features[0];
    const b = buildFrame([south], WIDE, opts(southGeo)).points.features[0];
    const d = haversineM(
      a.geometry.coordinates as [number, number],
      b.geometry.coordinates as [number, number],
    );
    expect(d).toBeCloseTo(2 * TRACK_OFFSET_M, 1);
  });
});

describe('planner route-only mode (lineFilter)', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );

  it('hides trams whose line is not in the filter, points AND sections', () => {
    const on = makeState('9201', geo, 300); // line '9'
    const off = makeState('8123', geo, 400, {
      snapshot: makeSnapshot({ key: '8123', line: '22', routeId: 'L22' }),
    });
    const frame = buildFrame([on, off], WIDE, opts(geo, { lineFilter: new Set(['9']) }));
    expect(frame.points.features.map((f) => f.id)).toEqual(['9201']);
    expect(frame.sections.features.every((f) => f.properties.key === '9201')).toBe(true);
    expect(frame.sections.features.length).toBeGreaterThan(0);
  });

  it('renders everything when the filter is null/undefined', () => {
    const a = makeState('9201', geo, 300);
    const b = makeState('8123', geo, 400, {
      snapshot: makeSnapshot({ key: '8123', line: '22' }),
    });
    const frame = buildFrame([a, b], WIDE, opts(geo, { lineFilter: null }));
    expect(frame.points.features).toHaveLength(2);
  });
});

describe('rendered anchor is whatever the state says (mode-agnostic)', () => {
  // Physics v3: the render mode is resolved UPSTREAM, in the physics adapter —
  // it decides which published curve `simDistM`/`position`/`bearing` describe.
  // The feature builder has no mode branch left at all, which is the point:
  // switching smooth↔fixed changes the numbers arriving here, never the code
  // path taken, so the two modes cannot drift apart in rendering.
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );

  it('anchors the point AND all sections at simDistM, ignoring the raw fix', () => {
    // Fix says 250 m; the curve says 300 m. The curve wins — always.
    const state = makeState('9201', geo, 300, {
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 250 }),
    });
    const frame = buildFrame([state], WIDE, opts(geo));
    const point = frame.points.features[0].geometry.coordinates as [number, number];
    expect(haversineM(point, rightOf(metersToCoord(ORIGIN, 300, 0), 90))).toBeLessThan(0.5);
    // Head section center at simDistM − 5 (10 m sections).
    const head = frame.sections.features[0];
    expect(
      haversineM(
        head.geometry.coordinates as [number, number],
        rightOf(metersToCoord(ORIGIN, 295, 0), 90),
      ),
    ).toBeLessThan(1);
  });

  it('culls sections by the RENDERED position, not the raw fix', () => {
    // Rendered at 300 m; the fix is 5 km away. The viewport that CONTAINS the
    // render keeps the body; one that contains neither (well beyond the 300 m
    // cull margin) drops it.
    const state = makeState('9201', geo, 300, {
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 5_000 }),
    });
    const inView = buildFrame([state], viewportM(-100, -100, 500, 100, 15.0), opts(geo));
    expect(inView.sections.features.length).toBeGreaterThan(0);
    const outOfView = buildFrame([state], viewportM(-2_000, -100, -600, 100, 15.0), opts(geo));
    expect(outOfView.sections.features).toHaveLength(0);
  });

  it('marks a frozen (past-horizon) tram stale on points AND sections', () => {
    const frozen = makeState('9201', geo, 300, { pastHorizon: true });
    const frame = buildFrame([frozen], WIDE, opts(geo));
    expect(frame.points.features[0].properties.stale).toBe(1);
    for (const s of frame.sections.features) expect(s.properties.stale).toBe(1);
  });

  it('a live tram is not stale', () => {
    const frame = buildFrame([makeState('9201', geo, 300)], WIDE, opts(geo));
    expect(frame.points.features[0].properties.stale).toBe(0);
    for (const s of frame.sections.features) expect(s.properties.stale).toBe(0);
  });
});

describe('doors open only while STANDING AT A PLATFORM (openModelKey)', () => {
  // A stop at 300 m — the dwell position of the tests below.
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [
      { atM: 300, arrivalMs: 0 },
      { atM: 1000, arrivalMs: 0, isTerminal: true },
    ],
  );
  /** 3-section spec with doors-open variants authored for sections 0 and 2. */
  function specWithDoors() {
    const spec = makeSpec3();
    spec.sections[0] = { ...spec.sections[0], openModelKey: '15t-a-open' };
    spec.sections[2] = { ...spec.sections[2], openModelKey: '15t-c-open' };
    return spec;
  }
  /** Standing at the 300 m stop, dwelling — the doors-open condition. */
  const atStop = { model: specWithDoors(), phase: 'dwell' as const, simSpeedKmh: 0 };

  it('a tram dwelling at the platform emits open keys where authored, normal keys otherwise', () => {
    const state = makeState('9201', geo, 300, atStop);
    const frame = buildFrame([state], WIDE, opts(geo));
    expect(frame.sections.features.map((f) => f.properties.modelKey)).toEqual([
      '15t-a-open',
      '15t-b', // no openModelKey authored → defensively falls back to normal
      '15t-c-open',
    ]);
  });

  it('doors close (normal keys) outside the dwell phase', () => {
    for (const phase of ['cruise', 'terminal', 'unknown'] as const) {
      const state = makeState('9201', geo, 300, {
        model: specWithDoors(),
        phase,
        simSpeedKmh: 0,
      });
      const frame = buildFrame([state], WIDE, opts(geo));
      expect(frame.sections.features.map((f) => f.properties.modelKey)).toEqual([
        '15t-a',
        '15t-b',
        '15t-c',
      ]);
    }
  });

  it('doors stay CLOSED between stops even if the phase claims dwell', () => {
    // Rendered head 150 m from the nearest stop: a dwell phase mid-segment
    // (engine glitch / live-mode divergence) must not open doors on the move.
    const state = makeState('9201', geo, 450, { ...atStop });
    const frame = buildFrame([state], WIDE, opts(geo));
    expect(frame.sections.features.map((f) => f.properties.modelKey)).toEqual([
      '15t-a',
      '15t-b',
      '15t-c',
    ]);
  });

  it('doors stay CLOSED while moving, even in the dwell phase at a stop', () => {
    const state = makeState('9201', geo, 300, { ...atStop, simSpeedKmh: 15 });
    const frame = buildFrame([state], WIDE, opts(geo));
    expect(frame.sections.features.map((f) => f.properties.modelKey)).toEqual([
      '15t-a',
      '15t-b',
      '15t-c',
    ]);
  });

  it('doors follow the RENDERED head wherever the curve puts it', () => {
    // The phase says dwell, but the RENDERED head is still 120 m short of the
    // 300 m stop → doors must stay closed. (Physics v3 has one head, so this
    // guards the near-stop gate rather than a live/smooth layer mismatch.)
    const enRoute = makeState('9201', geo, 180, {
      ...atStop,
      fixedDistM: 180,
      pastHorizon: false,
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 180 }),
    });
    const closed = buildFrame([enRoute], WIDE, opts(geo));
    expect(closed.sections.features.map((f) => f.properties.modelKey)).toEqual([
      '15t-a',
      '15t-b',
      '15t-c',
    ]);
    // The rendered head reaches the platform → doors open.
    const arrived = makeState('9201', geo, 300, {
      ...atStop,
      fixedDistM: 300,
      pastHorizon: false,
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 300 }),
    });
    const open = buildFrame([arrived], WIDE, opts(geo));
    expect(open.sections.features.map((f) => f.properties.modelKey)).toEqual([
      '15t-a-open',
      '15t-b',
      '15t-c-open',
    ]);
  });

  it('the coupled trailer opens its doors too', () => {
    const spec = makeSpec1();
    spec.sections[0] = { ...spec.sections[0], openModelKey: 't3rp-open' };
    const state = makeState('8123', geo, 300, {
      model: spec,
      phase: 'dwell',
      simSpeedKmh: 0,
    });
    const frame = buildFrame([state], WIDE, opts(geo, { coupledPairFn: () => true }));
    expect(frame.sections.features.map((f) => f.properties.modelKey)).toEqual([
      't3rp-open',
      't3rp-open',
    ]);
  });

  it('a dwelling geometry-less tram still draws NO body (doors moot — only a dot)', () => {
    const state = makeState('9201', null, 0, {
      model: specWithDoors(),
      phase: 'dwell',
      position: metersToCoord(ORIGIN, 0, 0),
      bearing: 0,
    });
    const frame = buildFrame([state], WIDE, opts(null));
    // No sections at all → no doors to open; the tram is a bare dot until its
    // shape loads.
    expect(frame.sections.features).toHaveLength(0);
    expect(frame.points.features[0].properties.geometryless).toBe(1);
  });
});

describe('fixOverlay (raw last fix + connector)', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );
  // Sim at 300, raw fix back at 250.
  const state = makeState('9201', geo, 300, {
    snapshot: makeSnapshot({ key: '9201', shapeDistM: 250 }),
  });

  it('is empty without a selected or followed tram', () => {
    const frame = buildFrame([state], WIDE, opts(geo));
    expect(frame.fixOverlay.features).toHaveLength(0);
  });

  it('emits the raw fix point + shape-sliced connector for the selected tram (smooth)', () => {
    const frame = buildFrame([state], WIDE, opts(geo, { selectedKey: '9201' }));
    expect(frame.fixOverlay.features).toHaveLength(2);
    const [fix, connector] = frame.fixOverlay.features;

    // Point at the RAW fix position — on the track, NOT offset.
    expect(fix.geometry.type).toBe('Point');
    const fixPos = (fix.geometry as GeoJSON.Point).coordinates as [number, number];
    expect(haversineM(fixPos, metersToCoord(ORIGIN, 250, 0))).toBeLessThan(0.5);
    expect(fix.properties?.key).toBe('9201');

    // Connector runs along the shape from the fix to the rendered (sim) dist.
    expect(connector.geometry.type).toBe('LineString');
    const line = (connector.geometry as GeoJSON.LineString).coordinates as [number, number][];
    expect(line.length).toBeGreaterThanOrEqual(2);
    expect(haversineM(line[0] as [number, number], metersToCoord(ORIGIN, 250, 0))).toBeLessThan(0.5);
    expect(
      haversineM(line[line.length - 1] as [number, number], metersToCoord(ORIGIN, 300, 0)),
    ).toBeLessThan(0.5);
  });

  it('includes intermediate shape vertices between fix and rendered position', () => {
    // L-shaped track: fix before the corner, sim after it → the connector must
    // bend through the corner vertex instead of cutting across.
    const bent = makeGeometry(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      [],
    );
    const s = makeState('9201', bent, 150, {
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 50 }),
    });
    const frame = buildFrame([s], WIDE, opts(bent, { selectedKey: '9201' }));
    const line = (frame.fixOverlay.features[1].geometry as GeoJSON.LineString)
      .coordinates as [number, number][];
    expect(line).toHaveLength(3);
    expect(haversineM(line[1] as [number, number], metersToCoord(ORIGIN, 100, 0))).toBeLessThan(0.5);
  });

  it('connects the raw fix to the RENDERED position even when the render is BEHIND the fix', () => {
    // A curve holding at a stop while the AVL fix has already run ahead: the
    // connector must still run fix → rendered head, now backwards along the
    // shape. Physics v3 makes this ordinary rather than exceptional.
    const behind = makeState('9201', geo, 200, {
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 250 }),
    });
    const frame = buildFrame([behind], WIDE, opts(geo, { selectedKey: '9201' }));
    const line = (frame.fixOverlay.features[1].geometry as GeoJSON.LineString)
      .coordinates as [number, number][];
    expect(haversineM(line[0] as [number, number], metersToCoord(ORIGIN, 250, 0))).toBeLessThan(0.5);
    expect(
      haversineM(line[line.length - 1] as [number, number], metersToCoord(ORIGIN, 200, 0)),
    ).toBeLessThan(0.5);
  });

  it('followedKey wins over selectedKey', () => {
    const other = makeState('8123', geo, 600, {
      snapshot: makeSnapshot({ key: '8123', shapeDistM: 580 }),
    });
    const frame = buildFrame(
      [state, other],
      WIDE,
      opts(geo, { selectedKey: '9201', followedKey: '8123' }),
    );
    expect(frame.fixOverlay.features.map((f) => f.properties?.key)).toEqual(['8123', '8123']);
  });

  it('emits even below the sections zoom band and outside the viewport', () => {
    const frame = buildFrame([state], viewportM(5000, 5000, 6000, 6000, 12), {
      ...opts(geo),
      selectedKey: '9201',
    });
    expect(frame.sections.features).toHaveLength(0);
    expect(frame.fixOverlay.features).toHaveLength(2);
  });

  it('falls back to a straight connector without geometry', () => {
    const raw = makeState('9201', null, 0, {
      snapshot: makeSnapshot({
        key: '9201',
        coordinates: metersToCoord(ORIGIN, 100, 0),
        bearing: 90,
      }),
      position: metersToCoord(ORIGIN, 50, 50),
      bearing: 45,
    });
    const frame = buildFrame([raw], WIDE, opts(null, { selectedKey: '9201' }));
    expect(frame.fixOverlay.features).toHaveLength(2);
    const line = (frame.fixOverlay.features[1].geometry as GeoJSON.LineString)
      .coordinates as [number, number][];
    expect(line).toHaveLength(2);
    expect(haversineM(line[0] as [number, number], metersToCoord(ORIGIN, 100, 0))).toBeLessThan(0.5);
    expect(haversineM(line[1] as [number, number], metersToCoord(ORIGIN, 50, 50))).toBeLessThan(0.5);
  });
});

describe('skipPoints (low-cadence points push)', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );

  it('omits point features but still builds sections', () => {
    const frame = buildFrame([makeState('9201', geo, 300)], WIDE, opts(geo, { skipPoints: true }));
    expect(frame.points.features).toHaveLength(0);
    expect(frame.sections.features.length).toBeGreaterThan(0);
  });
});
describe('all bands share ONE rendered anchor (dots = badges = sections)', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );

  /** Head position implied by the head section's center (center + halfLength). */
  function headFromSections(frame: ReturnType<typeof buildFrame>, key: string): LngLat {
    const head = frame.sections.features.find((f) => f.id === `${key}#0`)!;
    const pos = head.geometry.coordinates as LngLat;
    const bearing = head.properties.bearing as number;
    // Section center sits halfLength behind the head along the bearing.
    return destinationPoint(pos, bearing, 5); // makeSpec3 sections are 10 m
  }

  it('smooth mode: the point marker, badge candidate and section head all derive from the sim position', () => {
    // z15.0 is inside BOTH the sections band (>=14.8) and the badge skirt
    // (<=15.2) — every band renders, so their anchors are directly comparable.
    const vp = viewportM(-2000, -2000, 2000, 2000, 15.0);
    const frame = buildFrame([makeState('9201', geo, 300)], vp, opts(geo));
    const marker = frame.points.features[0].geometry.coordinates as LngLat;
    const badge = frame.badges!.features[0].geometry as GeoJSON.Point;
    // Lone badge: exactly on the marker.
    expect(haversineM(badge.coordinates as LngLat, marker)).toBeLessThan(1e-6);
    // Section head reconstructs to the SAME rendered anchor (± section math).
    expect(haversineM(headFromSections(frame, '9201'), marker)).toBeLessThan(1);
  });

  it('every band anchors to the SAME rendered position, wherever it is', () => {
    const vp = viewportM(-2000, -2000, 2000, 2000, 15.0);
    // The curve puts the tram at 500 m while its last raw fix says 300 m —
    // dots, badges and 3D sections must all follow the CURVE, together.
    const state = makeState('9201', geo, 500, {
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 300 }),
    });
    const frame = buildFrame([state], vp, opts(geo));
    const marker = frame.points.features[0].geometry.coordinates as LngLat;
    const projected = rightOf(metersToCoord(ORIGIN, 500, 0), 90);
    expect(haversineM(marker, projected)).toBeLessThan(0.5);
    // Badge glued to the same marker.
    const badge = frame.badges!.features[0].geometry as GeoJSON.Point;
    expect(haversineM(badge.coordinates as LngLat, marker)).toBeLessThan(1e-6);
    // Section head at the same projected anchor.
    expect(haversineM(headFromSections(frame, '9201'), marker)).toBeLessThan(1);
  });
});

describe('render safety: non-finite positions never poison a push', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [],
  );

  function expectAllFinite(frame: ReturnType<typeof buildFrame>) {
    const fcs = [frame.points, frame.sections, frame.badges!, frame.fixOverlay];
    for (const fc of fcs) {
      for (const f of fc.features) {
        const coords =
          f.geometry.type === 'Point'
            ? [(f.geometry as GeoJSON.Point).coordinates]
            : ((f.geometry as GeoJSON.LineString).coordinates as [number, number][]);
        for (const c of coords) {
          expect(Number.isFinite(c[0])).toBe(true);
          expect(Number.isFinite(c[1])).toBe(true);
        }
      }
    }
  }

  it('a NaN sim position falls back to the raw fix; the healthy fleet is untouched', () => {
    // One NaN coordinate stringifies to null and makes the NATIVE updateShape
    // reject the WHOLE FeatureCollection — the far-zoom "frozen arrow" bug.
    const vp = viewportM(-2000, -2000, 2000, 2000, 15.0);
    const broken = makeState('6666', geo, 300, {
      position: [Number.NaN, Number.NaN],
      bearing: Number.NaN,
      snapshot: makeSnapshot({ key: '6666', shapeDistM: 300 }),
    });
    const healthy = makeState('9201', geo, 500, {
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 500 }),
    });
    const frame = buildFrame([broken, healthy], vp, opts(geo, { selectedKey: '6666' }));
    // The broken tram degrades to its (finite) raw fix instead of vanishing…
    const brokenPt = frame.points.features.find((f) => f.id === '6666')!;
    // (rendered with the usual right-hand track offset off its observed bearing)
    expect(haversineM(brokenPt.geometry.coordinates as LngLat, metersToCoord(ORIGIN, 300, 0))).toBeLessThan(
      2,
    );
    // …draws no 3D body this frame (its along-shape head is untrusted)…
    expect(frame.sections.features.some((f) => f.properties.key === '6666')).toBe(false);
    // …and the healthy tram still renders fully.
    expect(frame.points.features.some((f) => f.id === '9201')).toBe(true);
    expect(frame.sections.features.some((f) => f.properties.key === '9201')).toBe(true);
    expectAllFinite(frame);
  });

  it('a tram broken beyond saving (raw fix NaN too) is dropped, not pushed', () => {
    const vp = viewportM(-2000, -2000, 2000, 2000, 15.0);
    const broken = makeState('6666', geo, 300, {
      position: [Number.NaN, Number.NaN],
      bearing: Number.NaN,
      observedPosition: [Number.NaN, Number.NaN],
      snapshot: makeSnapshot({ key: '6666', shapeDistM: 300 }),
    });
    const healthy = makeState('9201', geo, 500, {
      snapshot: makeSnapshot({ key: '9201', shapeDistM: 500 }),
    });
    const frame = buildFrame([broken, healthy], vp, opts(geo));
    expect(frame.points.features.map((f) => f.id)).toEqual(['9201']);
    expectAllFinite(frame);
  });
});
