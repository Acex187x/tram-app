/// <reference types="jest" />

// Band-2 badge declutter: overlapping face badges are pushed APART (never
// hidden) by a screen-space separation solve in buildFrame, with leader lines
// from a displaced badge back to its true marker. Pinned (selected/followed/
// favorite) badges are immovable obstacles and are never emitted/displaced.
// The tram MARKER (points FC) always stays at the true position.

import {
  BAND_BADGES_TO_MODELS,
  BAND_DOTS_TO_BADGES,
  BAND_FADE,
} from '@/components/map/mapStyle';
import { bearingAt, haversineM, pointAt } from '@/lib/geo/polyline';
import {
  BADGE_LEADER_MIN_PX,
  BADGE_MAX_DISPLACE_PX,
  BADGE_MAX_ZOOM,
  BADGE_MIN_ZOOM,
  BADGE_PITCH_Y_SCALE,
  badgeBoxPx,
  badgeIconSize,
  buildFrame,
  declutterBadges,
  FACE_GAP_PX,
  FACE_MAX_ICON_SIZE,
  FACE_MIN_RATIO,
  MARKER_OBSTACLE_HALF_PX,
  metersPerStylePx,
  type BadgeCandidate,
  type BadgeDisplacementMemory,
  type BuildFrameOptions,
} from '@/lib/render/featureBuilder';
import type { RouteGeometry, TramPublicState, Viewport } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec3, metersToCoord, ORIGIN } from './helpers';

const M_PER_DEG_LAT = 111_320;
const DEG2RAD = Math.PI / 180;

function makeState(
  key: string,
  geo: RouteGeometry,
  simDistM: number,
  overrides: Partial<TramPublicState> = {},
): TramPublicState {
  const snapshot = overrides.snapshot ?? makeSnapshot({ key, shapeDistM: simDistM });
  return {
    key,
    snapshot,
    model: makeSpec3(),
    simDistM,
    simSpeedKmh: 20,
    position: pointAt(geo.coordinates, geo.cumDistM, simDistM),
    bearing: bearingAt(geo.coordinates, geo.cumDistM, simDistM),
    phase: 'cruise',
    observedPosition: pointAt(geo.coordinates, geo.cumDistM, simDistM),
    observedBearing: bearingAt(geo.coordinates, geo.cumDistM, simDistM),
    deviationM: 0,
    projectedObservedDistM: simDistM,
    nextStopName: null,
    nextStopEtaS: null,
    hasGeometry: true,
    ...overrides,
  };
}

/** Viewport whose bbox spans the given local-meter rectangle around ORIGIN. */
function viewportM(x0: number, y0: number, x1: number, y1: number, zoom: number): Viewport {
  const sw = metersToCoord(ORIGIN, x0, y0);
  const ne = metersToCoord(ORIGIN, x1, y1);
  return { bbox: [sw[0], sw[1], ne[0], ne[1]], zoom };
}

function opts(geo: RouteGeometry, extra: Partial<BuildFrameOptions> = {}): BuildFrameOptions {
  return {
    selectedKey: null,
    favoriteKeys: new Set<string>(),
    coupledPairFn: () => false,
    getGeometry: () => geo,
    nowMs: 12_345,
    ...extra,
  };
}

const ZOOM = 13.8; // mid badge band
const WIDE = viewportM(-2000, -2000, 2000, 2000, ZOOM);

/** East 1 km track. */
const geo = makeGeometry(
  [
    [0, 0],
    [1000, 0],
  ],
  [],
);

type Pt = [number, number];

function badgePoints(frame: ReturnType<typeof buildFrame>) {
  return (frame.badges?.features ?? []).filter((f) => f.geometry.type === 'Point');
}
function leaders(frame: ReturnType<typeof buildFrame>) {
  return (frame.badges?.features ?? []).filter((f) => f.geometry.type === 'LineString');
}

/**
 * Project lng/lat to the solver's screen-space px (y-down, pitched-camera
 * foreshortening on the y axis) — same math as the solver.
 */
function toPx(p: Pt, zoom: number): Pt {
  const mpp = metersPerStylePx(ORIGIN[1], zoom);
  return [
    (p[0] * M_PER_DEG_LAT * Math.cos(ORIGIN[1] * DEG2RAD)) / mpp,
    ((-p[1] * M_PER_DEG_LAT) / mpp) * BADGE_PITCH_Y_SCALE,
  ];
}

/** Assert a badge box (at its displaced anchor) clears a marker's obstacle box. */
function expectClearsMarker(badgeAnchor: Pt, line: string, marker: Pt) {
  const a = toPx(badgeAnchor, ZOOM);
  const m = toPx(marker, ZOOM);
  const box = badgeBoxPx(line, ZOOM);
  const dx = Math.abs(a[0] + box.centerOffX - m[0]);
  const dy = Math.abs(a[1] + box.centerOffY - m[1]);
  const clearX = dx >= box.halfW + MARKER_OBSTACLE_HALF_PX - 0.5;
  const clearY = dy >= box.halfH + MARKER_OBSTACLE_HALF_PX - 0.5;
  expect(clearX || clearY).toBe(true);
}

/** Assert two badge boxes (anchored at displaced anchors) do not overlap. */
function expectBoxesDisjoint(aAnchor: Pt, aLine: string, bAnchor: Pt, bLine: string) {
  const a = toPx(aAnchor, ZOOM);
  const b = toPx(bAnchor, ZOOM);
  const boxA = badgeBoxPx(aLine, ZOOM);
  const boxB = badgeBoxPx(bLine, ZOOM);
  const dx = Math.abs(a[0] + boxA.centerOffX - (b[0] + boxB.centerOffX));
  const dy = Math.abs(a[1] + boxA.centerOffY - (b[1] + boxB.centerOffY));
  const clearX = dx >= boxA.halfW + boxB.halfW - 0.5;
  const clearY = dy >= boxA.halfH + boxB.halfH - 0.5;
  expect(clearX || clearY).toBe(true);
}

describe('badge band gating', () => {
  it('band constants stay in sync with mapStyle zoom bands', () => {
    expect(BADGE_MIN_ZOOM).toBeCloseTo(BAND_DOTS_TO_BADGES - BAND_FADE, 5);
    expect(BADGE_MAX_ZOOM).toBeCloseTo(BAND_BADGES_TO_MODELS + BAND_FADE + 0.1, 5);
  });

  it('emits an empty badges FC outside the badge zoom band', () => {
    for (const zoom of [12.0, 12.8, 15.3, 16.5]) {
      const frame = buildFrame(
        [makeState('9201', geo, 100), makeState('9301', geo, 110)],
        viewportM(-2000, -2000, 2000, 2000, zoom),
        opts(geo),
      );
      expect(frame.badges?.features ?? []).toHaveLength(0);
    }
  });

  it('emits an empty badges FC on skipPoints (sections-only) frames', () => {
    const frame = buildFrame(
      [makeState('9201', geo, 100), makeState('9301', geo, 110)],
      WIDE,
      opts(geo, { skipPoints: true }),
    );
    expect(frame.badges?.features ?? []).toHaveLength(0);
  });

  it('culls badge candidates to the viewport (payload ∝ visible)', () => {
    // Tram ~5 km east of a small viewport — its point ships (whole fleet) but
    // no badge feature does.
    const inView = makeState('9201', geo, 100);
    const farGeo = makeGeometry(
      [
        [5000, 0],
        [6000, 0],
      ],
      [],
    );
    const outOfView = makeState('9301', farGeo, 100, {
      snapshot: makeSnapshot({ key: '9301', shapeDistM: 100 }),
    });
    const frame = buildFrame(
      [inView, outOfView],
      viewportM(-500, -500, 500, 500, ZOOM),
      opts(geo, { getGeometry: (k) => (k === '9301' ? farGeo : geo) }),
    );
    expect(frame.points.features).toHaveLength(2);
    expect(badgePoints(frame).map((f) => f.properties?.key)).toEqual(['9201']);
  });

  it('geometry-less trams (loading roundel) are not badge candidates', () => {
    const raw = {
      ...makeState('8123', geo, 100),
      hasGeometry: false,
    };
    const frame = buildFrame([raw], WIDE, { ...opts(geo), getGeometry: () => undefined });
    expect(badgePoints(frame)).toHaveLength(0);
  });
});

describe('declutter displacement (badges adapt, never hide)', () => {
  it('an isolated badge stays exactly at its marker, no leader', () => {
    const frame = buildFrame([makeState('9201', geo, 300)], WIDE, opts(geo));
    const badges = badgePoints(frame);
    expect(badges).toHaveLength(1);
    expect(badges[0].properties?.displaced).toBe(0);
    const marker = frame.points.features[0].geometry.coordinates as Pt;
    expect(
      haversineM((badges[0].geometry as GeoJSON.Point).coordinates as Pt, marker),
    ).toBeLessThan(1e-6);
    expect(leaders(frame)).toHaveLength(0);
  });

  it('two overlapping trams: BOTH badges emitted, boxes separated, markers untouched', () => {
    // 10 m apart at z13.8 ≈ 3 px — total badge overlap before the solve.
    const a = makeState('9201', geo, 300);
    const b = makeState('9301', geo, 310, {
      snapshot: makeSnapshot({ key: '9301', shapeDistM: 310 }),
    });
    const frame = buildFrame([a, b], WIDE, opts(geo));

    const badges = badgePoints(frame);
    expect(badges.map((f) => f.properties?.key).sort()).toEqual(['9201', '9301']);
    expect(badges.every((f) => f.properties?.displaced === 1)).toBe(true);

    const [bA, bB] = badges;
    expectBoxesDisjoint(
      (bA.geometry as GeoJSON.Point).coordinates as Pt,
      bA.properties?.line as string,
      (bB.geometry as GeoJSON.Point).coordinates as Pt,
      bB.properties?.line as string,
    );

    // Markers stay at the true rendered positions: identical to a frame built
    // for each tram alone (declutter moves ONLY badge anchors).
    const soloA = buildFrame([a], WIDE, opts(geo)).points.features[0].geometry.coordinates;
    const soloB = buildFrame([b], WIDE, opts(geo)).points.features[0].geometry.coordinates;
    expect(frame.points.features.find((f) => f.id === '9201')!.geometry.coordinates).toEqual(
      soloA,
    );
    expect(frame.points.features.find((f) => f.id === '9301')!.geometry.coordinates).toEqual(
      soloB,
    );
  });

  it('a displaced badge gets a leader line from its marker to the displaced anchor', () => {
    const a = makeState('9201', geo, 300);
    const b = makeState('9301', geo, 310, {
      snapshot: makeSnapshot({ key: '9301', shapeDistM: 310 }),
    });
    const frame = buildFrame([a, b], WIDE, opts(geo));
    const lead = leaders(frame);
    expect(lead.length).toBeGreaterThan(0);
    for (const l of lead) {
      const line = (l.geometry as GeoJSON.LineString).coordinates as Pt[];
      expect(line).toHaveLength(2);
      const key = l.properties?.key as string;
      const marker = frame.points.features.find((f) => f.id === key)!.geometry
        .coordinates as Pt;
      const badge = badgePoints(frame).find((f) => f.properties?.key === key)!;
      expect(haversineM(line[0], marker)).toBeLessThan(1e-6);
      expect(haversineM(line[1], (badge.geometry as GeoJSON.Point).coordinates as Pt)).toBeLessThan(
        1e-6,
      );
      // Leaders only appear for real displacements.
      const mpp = metersPerStylePx(ORIGIN[1], ZOOM);
      expect(haversineM(line[0], line[1]) / mpp).toBeGreaterThanOrEqual(
        BADGE_LEADER_MIN_PX - 0.5,
      );
    }
  });

  it('pinned (selected/followed/favorite) badges are absent from the FC and never move; neighbours move around them', () => {
    const sel = makeState('9201', geo, 300);
    const other = makeState('9301', geo, 306, {
      snapshot: makeSnapshot({ key: '9301', shapeDistM: 306 }),
    });
    const frame = buildFrame([sel, other], WIDE, opts(geo, { selectedKey: '9201' }));

    const badges = badgePoints(frame);
    // The selected tram renders from the points FC on the pinned layer — no
    // badge feature here.
    expect(badges.map((f) => f.properties?.key)).toEqual(['9301']);
    // Its neighbour took the WHOLE displacement (the pinned badge is an
    // immovable obstacle) — separated from the pinned badge at the marker.
    expect(badges[0].properties?.displaced).toBe(1);
    const selMarker = frame.points.features.find((f) => f.id === '9201')!.geometry
      .coordinates as Pt;
    expectBoxesDisjoint(
      selMarker,
      '9',
      (badges[0].geometry as GeoJSON.Point).coordinates as Pt,
      badges[0].properties?.line as string,
    );
    // followedKey pins the same way.
    const followed = buildFrame([sel, other], WIDE, opts(geo, { followedKey: '9201' }));
    expect(badgePoints(followed).map((f) => f.properties?.key)).toEqual(['9301']);
    // favorite pins too.
    const fav = buildFrame([sel, other], WIDE, opts(geo, { favoriteKeys: new Set(['9201']) }));
    expect(badgePoints(fav).map((f) => f.properties?.key)).toEqual(['9301']);
  });

  it('a pileup separates into disjoint boxes, capped displacement, deterministic', () => {
    // Five trams within 20 m — a stop cluster.
    const states = [0, 5, 10, 15, 20].map((d, i) =>
      makeState(`92${i}1`, geo, 300 + d, {
        snapshot: makeSnapshot({ key: `92${i}1`, shapeDistM: 300 + d }),
      }),
    );
    const frame = buildFrame(states, WIDE, opts(geo));
    const badges = badgePoints(frame);
    expect(badges).toHaveLength(5); // nobody hidden

    // Pairwise disjoint.
    for (let i = 0; i < badges.length; i++) {
      for (let j = i + 1; j < badges.length; j++) {
        expectBoxesDisjoint(
          (badges[i].geometry as GeoJSON.Point).coordinates as Pt,
          badges[i].properties?.line as string,
          (badges[j].geometry as GeoJSON.Point).coordinates as Pt,
          badges[j].properties?.line as string,
        );
      }
    }
    // Displacement never exceeds the cap (readability tether) — measured in
    // the solver's screen space, where the cap is defined.
    for (const b of badges) {
      const marker = frame.points.features.find((f) => f.id === b.properties?.key)!.geometry
        .coordinates as Pt;
      const m = toPx(marker, ZOOM);
      const a = toPx((b.geometry as GeoJSON.Point).coordinates as Pt, ZOOM);
      expect(Math.hypot(a[0] - m[0], a[1] - m[1])).toBeLessThanOrEqual(
        BADGE_MAX_DISPLACE_PX + 1,
      );
    }
    // Deterministic: identical input → identical output (stable frame to frame).
    const again = buildFrame(states, WIDE, opts(geo));
    expect(again.badges).toEqual(frame.badges);
  });

  it('no plate ever covers ANY direction arrow (marker obstacle boxes)', () => {
    // Dense cluster: 6 trams within 25 m. Every solved badge box must clear
    // every tram's heading-teardrop obstacle — its own AND every neighbour's.
    const states = [0, 5, 10, 15, 20, 25].map((d, i) =>
      makeState(`93${i}1`, geo, 500 + d, {
        snapshot: makeSnapshot({ key: `93${i}1`, shapeDistM: 500 + d }),
      }),
    );
    const frame = buildFrame(states, WIDE, opts(geo));
    const badges = badgePoints(frame);
    expect(badges).toHaveLength(6);
    const markers = frame.points.features.map((f) => f.geometry.coordinates as Pt);
    for (const b of badges) {
      for (const m of markers) {
        expectClearsMarker(
          (b.geometry as GeoJSON.Point).coordinates as Pt,
          b.properties?.line as string,
          m,
        );
      }
    }
  });

  it('badgeMemory keeps arrangements stable push to push (no re-shuffling)', () => {
    // Two overlapping trams crawling forward: with a shared memory the second
    // push must keep each badge on the SAME side with only a small delta —
    // arrangements never re-derive cold and visibly jump.
    const memory: BadgeDisplacementMemory = new Map();
    const mk = (d: number) => [
      makeState('9201', geo, 300 + d, {
        snapshot: makeSnapshot({ key: '9201', shapeDistM: 300 + d }),
      }),
      makeState('9301', geo, 308 + d, {
        snapshot: makeSnapshot({ key: '9301', shapeDistM: 308 + d }),
      }),
    ];
    const first = buildFrame(mk(0), WIDE, opts(geo, { badgeMemory: memory }));
    const second = buildFrame(mk(2), WIDE, opts(geo, { badgeMemory: memory }));
    const mpp = metersPerStylePx(ORIGIN[1], ZOOM);
    for (const key of ['9201', '9301']) {
      const a = badgePoints(first).find((f) => f.properties?.key === key)!;
      const b = badgePoints(second).find((f) => f.properties?.key === key)!;
      const pa = toPx((a.geometry as GeoJSON.Point).coordinates as Pt, ZOOM);
      const pb = toPx((b.geometry as GeoJSON.Point).coordinates as Pt, ZOOM);
      // The badge tracked its tram (2 m ≈ under a px) — no jump.
      const movedPx = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      expect(movedPx).toBeLessThan(2 / mpp + 3);
    }
  });

  it('a badge glides home over a few pushes once its crowd disappears', () => {
    const memory: BadgeDisplacementMemory = new Map();
    const pair = [
      makeState('9201', geo, 300),
      makeState('9301', geo, 308, {
        snapshot: makeSnapshot({ key: '9301', shapeDistM: 308 }),
      }),
    ];
    buildFrame(pair, WIDE, opts(geo, { badgeMemory: memory }));
    expect(memory.size).toBeGreaterThan(0);

    // Crowd gone: repeated pushes decay the displacement smoothly to zero.
    const solo = [makeState('9201', geo, 300)];
    let last = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 20; i++) {
      const frame = buildFrame(solo, WIDE, opts(geo, { badgeMemory: memory }));
      const b = badgePoints(frame)[0];
      const marker = frame.points.features[0].geometry.coordinates as Pt;
      const dist = haversineM((b.geometry as GeoJSON.Point).coordinates as Pt, marker);
      expect(dist).toBeLessThanOrEqual(last + 1e-9); // monotonically home
      last = dist;
    }
    expect(last).toBe(0); // snapped exactly onto the marker
    expect(memory.get('9201')).toBeUndefined();
  });

  it('the base plate gap clears its own arrow even at band entry (smallest iconSize)', () => {
    // Geometry guarantee, no solve needed: gap × min iconSize must exceed the
    // marker obstacle half-size, so an undisturbed plate never touches its
    // own teardrop.
    expect(FACE_GAP_PX * badgeIconSize(BADGE_MIN_ZOOM)).toBeGreaterThan(
      MARKER_OBSTACLE_HALF_PX,
    );
  });

  it('exactly co-located badges (depot case) still separate deterministically', () => {
    const cands: BadgeCandidate[] = ['a', 'b', 'c'].map((k) => ({
      key: k,
      line: '9',
      modelId: '15t',
      pos: [ORIGIN[0], ORIGIN[1]],
      pinned: false,
    }));
    const feats = declutterBadges(cands, ZOOM, ORIGIN[1]);
    const pts = feats.filter((f) => f.geometry.type === 'Point');
    expect(pts).toHaveLength(3);
    const anchors = pts.map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        expectBoxesDisjoint(anchors[i], '9', anchors[j], '9');
      }
    }
    expect(declutterBadges(cands, ZOOM, ORIGIN[1])).toEqual(feats);
  });
});

describe('badge metrics', () => {
  it('iconSize ramps across the band exactly like the layer style', () => {
    expect(badgeIconSize(13.2)).toBeCloseTo(FACE_MAX_ICON_SIZE * FACE_MIN_RATIO, 6);
    expect(badgeIconSize(14.8)).toBeCloseTo(FACE_MAX_ICON_SIZE, 6);
    expect(badgeIconSize(12.0)).toBeCloseTo(FACE_MAX_ICON_SIZE * FACE_MIN_RATIO, 6); // clamped
    expect(badgeIconSize(16.0)).toBeCloseTo(FACE_MAX_ICON_SIZE, 6); // clamped
  });

  it('wider line numbers widen the badge box rightward', () => {
    const short = badgeBoxPx('9', 14.0);
    const long = badgeBoxPx('22', 14.0);
    expect(long.halfW).toBeGreaterThan(short.halfW);
    expect(long.centerOffX).toBeGreaterThan(short.centerOffX);
    expect(long.halfH).toBeCloseTo(short.halfH, 6);
  });

  it('point props payload did NOT grow (badges ship on their own FC)', () => {
    const frame = buildFrame([makeState('9201', geo, 300)], WIDE, opts(geo));
    expect(Object.keys(frame.points.features[0].properties).sort()).toEqual(
      ['bearing', 'favorite', 'geometryless', 'key', 'line', 'modelId', 'selected'].sort(),
    );
  });
});
