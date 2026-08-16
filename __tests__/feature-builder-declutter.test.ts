/// <reference types="jest" />

// Band-2 badge layout: overlapping face badges pick DIFFERENT ANCHOR SLOTS
// around their own marker (above/below/beside/diagonals + stacked rows for
// pileups) — never hidden, never displaced far away, and NO leader lines.
// Every badge feature sits AT its marker; the chosen slot ships as data-driven
// screen offsets (`off` icon units / `toff` text em), so the plate stays glued
// to its arrow at any camera pitch. Pinned (selected/followed/favorite) badges
// hold the default above-slot as immovable obstacles and are never emitted.
// The tram MARKER (points FC) always stays at the true position.

import {
  BAND_BADGES_TO_MODELS,
  BAND_DOTS_TO_BADGES,
  BAND_FADE,
} from '@/components/map/mapStyle';
import { bearingAt, haversineM, pointAt } from '@/lib/geo/polyline';
import {
  BADGE_ANCHOR_SLOTS,
  BADGE_MAX_ZOOM,
  BADGE_MIN_ZOOM,
  BADGE_PAD_PX,
  BADGE_PITCH_Y_SCALE,
  badgeAnchorCenterPx,
  badgeBoxPx,
  badgeIconSize,
  buildFrame,
  declutterBadges,
  FACE_GAP_PX,
  FACE_MAX_ICON_SIZE,
  FACE_MIN_RATIO,
  MARKER_OBSTACLE_HALF_PX,
  metersPerStylePx,
  type BadgeAnchorMemory,
  type BadgeCandidate,
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
    fixedDistM: simDistM,
    pastHorizon: false,
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
type BadgeFeature = GeoJSON.Feature<GeoJSON.Point>;

const DEFAULT_OFF: Pt = [0, -FACE_GAP_PX];

function badgePoints(frame: ReturnType<typeof buildFrame>): BadgeFeature[] {
  return (frame.badges?.features ?? []).filter(
    (f) => f.geometry.type === 'Point',
  ) as BadgeFeature[];
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

/**
 * Rendered plate BOX center in solver screen px, reconstructed exactly the way
 * the symbol style renders it: icon bottom-center at marker + off×iconSize,
 * box center shifted by the seated line number (centerOffX) and half the face.
 */
function plateCenterPx(f: BadgeFeature): Pt {
  const m = toPx(f.geometry.coordinates as Pt, ZOOM);
  const s = badgeIconSize(ZOOM);
  const off = (f.properties?.off ?? DEFAULT_OFF) as Pt;
  const box = badgeBoxPx(f.properties?.line as string, ZOOM);
  return [m[0] + off[0] * s + box.centerOffX, m[1] + off[1] * s - box.halfH];
}

/** Assert a badge's plate box clears a marker's obstacle box. */
function expectClearsMarker(badge: BadgeFeature, marker: Pt) {
  const c = plateCenterPx(badge);
  const m = toPx(marker, ZOOM);
  const box = badgeBoxPx(badge.properties?.line as string, ZOOM);
  const dx = Math.abs(c[0] - m[0]);
  const dy = Math.abs(c[1] - m[1]);
  const clearX = dx >= box.halfW + MARKER_OBSTACLE_HALF_PX - 0.5;
  const clearY = dy >= box.halfH + MARKER_OBSTACLE_HALF_PX - 0.5;
  expect(clearX || clearY).toBe(true);
}

/** Assert two badges' plate boxes do not overlap. */
function expectBoxesDisjoint(a: BadgeFeature, b: BadgeFeature) {
  const ca = plateCenterPx(a);
  const cb = plateCenterPx(b);
  const boxA = badgeBoxPx(a.properties?.line as string, ZOOM);
  const boxB = badgeBoxPx(b.properties?.line as string, ZOOM);
  const dx = Math.abs(ca[0] - cb[0]);
  const dy = Math.abs(ca[1] - cb[1]);
  const clearX = dx >= boxA.halfW + boxB.halfW - 0.5;
  const clearY = dy >= boxA.halfH + boxB.halfH - 0.5;
  expect(clearX || clearY).toBe(true);
}

/**
 * Max distance a plate box center may sit from its own marker: the farthest
 * slot (third stacked row) plus rounding air. Keeps the "badge hugs its tram"
 * promise pinned — no badge is ever sent away on a long tether.
 */
function maxPlateDistPx(line: string): number {
  const box = badgeBoxPx(line, ZOOM);
  const gapY = FACE_GAP_PX * badgeIconSize(ZOOM);
  const row3 = gapY + 5 * box.halfH + 2 * BADGE_PAD_PX; // plate |y| of slots 10/11
  const sx = box.halfW + MARKER_OBSTACLE_HALF_PX + BADGE_PAD_PX;
  return Math.hypot(sx + Math.abs(box.centerOffX), row3) + 1;
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

describe('variable-anchor badge layout (hug the marker, never hide)', () => {
  it('every badge feature sits EXACTLY at its marker (slots ship as screen offsets)', () => {
    // The old solve displaced feature geometry in world coordinates, baking a
    // fixed cos-55° pitch estimate into lng/lat — at other camera pitches the
    // plate visibly detached from its arrow. Geometry now never moves.
    const states = [0, 4, 8, 12].map((d, i) =>
      makeState(`92${i}1`, geo, 300 + d, {
        snapshot: makeSnapshot({ key: `92${i}1`, shapeDistM: 300 + d }),
      }),
    );
    const frame = buildFrame(states, WIDE, opts(geo));
    for (const b of badgePoints(frame)) {
      const marker = frame.points.features.find((f) => f.id === b.properties?.key)!.geometry
        .coordinates as Pt;
      expect(haversineM(b.geometry.coordinates as Pt, marker)).toBeLessThan(1e-6);
      expect(Array.isArray(b.properties?.off)).toBe(true);
      expect(Array.isArray(b.properties?.toff)).toBe(true);
    }
  });

  it('an isolated badge takes the default slot (default offsets, displaced 0)', () => {
    const frame = buildFrame([makeState('9201', geo, 300)], WIDE, opts(geo));
    const badges = badgePoints(frame);
    expect(badges).toHaveLength(1);
    expect(badges[0].properties?.displaced).toBe(0);
    expect(badges[0].properties?.off).toEqual(DEFAULT_OFF);
  });

  it('never emits leader LineStrings (badges hug their marker instead)', () => {
    // A crowd dense enough that the old system would have drawn leaders.
    const states = [0, 4, 8, 12, 16].map((d, i) =>
      makeState(`92${i}1`, geo, 300 + d, {
        snapshot: makeSnapshot({ key: `92${i}1`, shapeDistM: 300 + d }),
      }),
    );
    const frame = buildFrame(states, WIDE, opts(geo));
    expect(
      (frame.badges?.features ?? []).filter((f) => f.geometry.type !== 'Point'),
    ).toHaveLength(0);
  });

  it('two overlapping trams: BOTH badges emitted on different sides, boxes separated', () => {
    // 10 m apart at z13.8 ≈ 3 px — total badge overlap on the default slot.
    const a = makeState('9201', geo, 300);
    const b = makeState('9301', geo, 310, {
      snapshot: makeSnapshot({ key: '9301', shapeDistM: 310 }),
    });
    const frame = buildFrame([a, b], WIDE, opts(geo));

    const badges = badgePoints(frame);
    expect(badges.map((f) => f.properties?.key).sort()).toEqual(['9201', '9301']);
    // The first (key order) keeps the default slot; the second moved aside.
    const byKey = new Map(badges.map((f) => [f.properties?.key as string, f]));
    expect(byKey.get('9201')!.properties?.displaced).toBe(0);
    expect(byKey.get('9301')!.properties?.displaced).toBe(1);
    expectBoxesDisjoint(badges[0], badges[1]);
  });

  it('every plate stays within the anchor ring of its own marker', () => {
    // Even in a pileup no badge is sent away on a long tether — the farthest
    // legal slot is the third stacked row.
    const states = [0, 4, 8, 12, 16, 20].map((d, i) =>
      makeState(`92${i}1`, geo, 300 + d, {
        snapshot: makeSnapshot({ key: `92${i}1`, shapeDistM: 300 + d }),
      }),
    );
    const frame = buildFrame(states, WIDE, opts(geo));
    const badges = badgePoints(frame);
    expect(badges).toHaveLength(6); // nobody hidden
    for (const b of badges) {
      const marker = frame.points.features.find((f) => f.id === b.properties?.key)!.geometry
        .coordinates as Pt;
      const m = toPx(marker, ZOOM);
      const c = plateCenterPx(b);
      expect(Math.hypot(c[0] - m[0], c[1] - m[1])).toBeLessThanOrEqual(
        maxPlateDistPx(b.properties?.line as string),
      );
    }
  });

  it('pinned (selected/followed/favorite) badges are absent from the FC and never move; neighbours pick other sides', () => {
    const sel = makeState('9201', geo, 300);
    const other = makeState('9301', geo, 306, {
      snapshot: makeSnapshot({ key: '9301', shapeDistM: 306 }),
    });
    const frame = buildFrame([sel, other], WIDE, opts(geo, { selectedKey: '9201' }));

    const badges = badgePoints(frame);
    // The selected tram renders from the points FC on the pinned layer — no
    // badge feature here.
    expect(badges.map((f) => f.properties?.key)).toEqual(['9301']);
    // Its neighbour moved to a side slot (the pinned badge owns the default
    // slot as an immovable obstacle) — separated from the pinned plate.
    expect(badges[0].properties?.displaced).toBe(1);
    const selMarker = frame.points.features.find((f) => f.id === '9201')!.geometry
      .coordinates as Pt;
    // The pinned plate renders at the default slot on its marker.
    const pinnedPlate: BadgeFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: selMarker },
      properties: { line: '9', off: DEFAULT_OFF },
    };
    expectBoxesDisjoint(pinnedPlate, badges[0]);
    // followedKey pins the same way.
    const followed = buildFrame([sel, other], WIDE, opts(geo, { followedKey: '9201' }));
    expect(badgePoints(followed).map((f) => f.properties?.key)).toEqual(['9301']);
    // favorite pins too.
    const fav = buildFrame([sel, other], WIDE, opts(geo, { favoriteKeys: new Set(['9201']) }));
    expect(badgePoints(fav).map((f) => f.properties?.key)).toEqual(['9301']);
  });

  it('a pileup separates into disjoint boxes, deterministic', () => {
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
        expectBoxesDisjoint(badges[i], badges[j]);
      }
    }
    // Deterministic: identical input → identical output (stable frame to frame).
    const again = buildFrame(states, WIDE, opts(geo));
    expect(again.badges).toEqual(frame.badges);
  });

  it('no plate ever covers ANY direction arrow (marker obstacle boxes)', () => {
    // Dense cluster: 6 trams within 25 m. Every solved plate box must clear
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
        expectClearsMarker(b, m);
      }
    }
  });

  it('badgeMemory keeps each badge on its side push to push (no jumps)', () => {
    // Two overlapping trams crawling forward: with a shared memory the second
    // push must keep each badge on the SAME anchor slot — identical offsets,
    // so plates track their trams smoothly.
    const memory: BadgeAnchorMemory = new Map();
    const mk = (d: number) => [
      makeState('9201', geo, 300 + d, {
        snapshot: makeSnapshot({ key: '9201', shapeDistM: 300 + d }),
      }),
      makeState('9301', geo, 308 + d, {
        snapshot: makeSnapshot({ key: '9301', shapeDistM: 308 + d }),
      }),
    ];
    const first = buildFrame(mk(0), WIDE, opts(geo, { badgeMemory: memory }));
    const slots = new Map(memory);
    const second = buildFrame(mk(2), WIDE, opts(geo, { badgeMemory: memory }));
    expect(new Map(memory)).toEqual(slots); // same sides kept
    for (const key of ['9201', '9301']) {
      const a = badgePoints(first).find((f) => f.properties?.key === key)!;
      const b = badgePoints(second).find((f) => f.properties?.key === key)!;
      expect(b.properties?.off).toEqual(a.properties?.off);
      expect(b.properties?.toff).toEqual(a.properties?.toff);
    }
  });

  it('a badge returns HOME (default slot) once its crowd disappears — never stranded aside', () => {
    const memory: BadgeAnchorMemory = new Map();
    const pair = [
      makeState('9201', geo, 300),
      makeState('9301', geo, 308, {
        snapshot: makeSnapshot({ key: '9301', shapeDistM: 308 }),
      }),
    ];
    buildFrame(pair, WIDE, opts(geo, { badgeMemory: memory }));
    expect(memory.size).toBe(2);

    // Crowd gone: the survivor snaps back onto the default slot (return-home
    // hysteresis only delays the move while space is marginal, it never parks
    // a lone plate on a side slot forever).
    const solo = [
      makeState('9301', geo, 308, {
        snapshot: makeSnapshot({ key: '9301', shapeDistM: 308 }),
      }),
    ];
    const frame = buildFrame(solo, WIDE, opts(geo, { badgeMemory: memory }));
    const b = badgePoints(frame)[0];
    expect(b.properties?.displaced).toBe(0);
    expect(b.properties?.off).toEqual(DEFAULT_OFF);
    expect(memory.get('9301')).toBe(0);
    expect(memory.has('9201')).toBe(false); // departed trams are forgotten
  });

  it('any remembered side slot re-homes for a lone badge (no sticky parking)', () => {
    for (const slot of [1, 3, 8, 11]) {
      const memory: BadgeAnchorMemory = new Map();
      memory.set('9201', slot); // pretend last push parked it there
      const frame = buildFrame(
        [makeState('9201', geo, 300)],
        WIDE,
        opts(geo, { badgeMemory: memory }),
      );
      const b = badgePoints(frame)[0];
      expect(b.properties?.displaced).toBe(0); // re-evaluated → default slot
      expect(memory.get('9201')).toBe(0);
    }
  });

  it('the base plate gap clears its own arrow even at band entry (smallest iconSize)', () => {
    // Geometry guarantee, no solve needed: gap × min iconSize must exceed the
    // marker obstacle half-size + pad, so an undisturbed plate never touches
    // its own teardrop.
    expect(FACE_GAP_PX * badgeIconSize(BADGE_MIN_ZOOM)).toBeGreaterThan(
      MARKER_OBSTACLE_HALF_PX + BADGE_PAD_PX,
    );
  });

  it('every anchor slot clears the marker obstacle box by construction', () => {
    const box = badgeBoxPx('22', ZOOM);
    for (let slot = 0; slot < BADGE_ANCHOR_SLOTS; slot++) {
      const c = badgeAnchorCenterPx(box, ZOOM, slot);
      const clearX = Math.abs(c.x) >= box.halfW + MARKER_OBSTACLE_HALF_PX + BADGE_PAD_PX - 1e-6;
      const clearY = Math.abs(c.y) >= box.halfH + MARKER_OBSTACLE_HALF_PX + BADGE_PAD_PX - 1e-6;
      expect(clearX || clearY).toBe(true);
    }
  });

  it('exactly co-located badges (depot case) still separate deterministically', () => {
    const cands: BadgeCandidate[] = ['a', 'b', 'c'].map((k) => ({
      key: k,
      line: '9',
      modelId: '15t',
      pos: [ORIGIN[0], ORIGIN[1]],
      pinned: false, stale: false,
    }));
    const feats = declutterBadges(cands, ZOOM, ORIGIN[1]) as BadgeFeature[];
    expect(feats).toHaveLength(3);
    for (let i = 0; i < feats.length; i++) {
      for (let j = i + 1; j < feats.length; j++) {
        expectBoxesDisjoint(feats[i], feats[j]);
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

  it('point props payload stays minimal (badges ship on their own FC)', () => {
    // Every prop here is either an identity the layers key off or a style
    // discriminator. `stale` is the one physics-v3 addition — a single int per
    // feature that lets the layers dim a FROZEN tram (connection honesty). No
    // positions, no speeds, nothing derivable at render time.
    const frame = buildFrame([makeState('9201', geo, 300)], WIDE, opts(geo));
    expect(Object.keys(frame.points.features[0].properties).sort()).toEqual(
      ['bearing', 'favorite', 'geometryless', 'key', 'line', 'modelId', 'selected', 'stale'].sort(),
    );
  });
});
