// Tram public states → GeoJSON render frame:
//  - points FC: ALL trams (circle/badge layers + hit testing)
//  - sections FC: articulated body sections, only for trams inside the viewport
//    (+300 m margin) at zoom >= 14.8 — drives the ModelLayer. While a tram
//    STANDS AT A PLATFORM (dwell phase + v≈0 + rendered head near a stop — see
//    doorsOpen) its sections render their doors-open GLB variants
//    (TramSection.openModelKey, when authored); doors stay closed in motion
//    and between stops.
//  - badges FC (band 2 only): face badges placed by a VARIABLE-ANCHOR solve —
//    each badge hugs its marker on one of a few fixed slots around it
//    (above/below/beside/diagonal + stacked rows), choosing the nearest free
//    side instead of being displaced far away on a leader line (leaders are
//    gone). Every feature sits AT its marker; the chosen slot ships as
//    data-driven icon/text offsets (`off`/`toff` props, pure screen units) so
//    the plate stays glued to its arrow at any camera pitch. Selected/
//    followed/favorite badges are immovable obstacles (they stay put on the
//    default slot; neighbours pick other sides) and are NOT emitted here — the
//    map draws them from the points FC on the pinned layer. Runs only on
//    points-push frames inside the badge zoom band, over viewport-culled trams
//    (payload ∝ visible).
//  - fixOverlay FC: for the followed/selected tram only — the raw last AVL fix
//    as a Point plus a connector LineString to the rendered position.
//
// Culling is ALWAYS per whole tram (by head position, margin far larger than
// any tram + coupled trailer ≈ 46 m): a tram whose head is near the viewport
// edge renders ALL of its sections — individual sections are never dropped, so
// bodies can't be visually cut in half at the screen edge.
//
// Every rendered position (points AND sections) is offset TRACK_OFFSET_M to the
// perpendicular-RIGHT of its bearing — Prague runs right-hand traffic, so this
// visually separates opposite directions sharing adjacent tracks.
//
// Feature ids are stable per tram key / section index (coupled trailer gets a
// distinct `#c<i>` suffix) so Mapbox can diff frames.

import type {
  EngineFrame,
  PointFeatureProps,
  RouteGeometry,
  SectionFeatureProps,
  TramModelSpec,
  TramPublicState,
  Viewport,
} from '@/lib/types';
import { bearingAt, destinationPoint, pointAt, segmentIndexAt } from '../geo/polyline';

/** Sections render only at/above this zoom (mode 3+). */
export const SECTION_MIN_ZOOM = 14.8;
/** Extra margin around the viewport bbox for whole-tram section culling, m. */
export const CULL_MARGIN_M = 300;

// ── Face-badge geometry (band 2) ─────────────────────────────────────────────
// Single source of truth for the badge anatomy: TramLayers builds its symbol
// styles from these, and the declutter solve below uses the SAME numbers to
// model each badge's screen box. The zoom band edges mirror
// src/components/map/mapStyle.ts (BAND_DOTS_TO_BADGES 13.2 / BAND_FADE 0.3 /
// BAND_BADGES_TO_MODELS 14.8) — pinned in sync by the declutter test, same
// precedent as SECTION_MIN_ZOOM above.

/** Face sprite natural size, pt (192 px PNG @ scale 3). */
export const FACE_NATURAL_PT = 64;
/**
 * iconSize at the top of the badge band (face renders 32 pt tall). This IS
 * the size users called "normal" — a 2026-07-19 experiment at 0.72 (~46 pt)
 * made every icon on the map feel bloated and was reverted the same day.
 */
export const FACE_MAX_ICON_SIZE = 0.5;
/** iconSize ramps down to this fraction of max at band entry. */
export const FACE_MIN_RATIO = 0.78;
/**
 * Gap between the marker point and the face bottom (iconOffset units ×
 * iconSize). Sized so the floating plate NEVER touches its own heading
 * teardrop: gap × min iconSize (32 × 0.39 ≈ 12.5 pt) clears the teardrop's
 * rotation reach plus the solve's pad (MARKER_OBSTACLE_HALF_PX 10 +
 * BADGE_PAD_PX 2 = 12) — the plate hugs its arrow, slot 0 of the anchor
 * solve reproduces exactly this geometry.
 */
export const FACE_GAP_PX = 32;
/** Line-number text size at the top of the band (lockstep with iconSize). */
export const FACE_TEXT_MAX_SIZE = 15;
/**
 * Default line-number text offset, em (lockstep with textSize so the number
 * stays seated across the band's size ramp): left-anchored 3 pt right of the
 * face edge, vertically centered on the face. Shared by the badge symbol
 * styles in TramLayers AND the anchor solve's data-driven text offsets.
 */
export const FACE_TEXT_OFFSET_X_EM =
  ((FACE_NATURAL_PT * FACE_MAX_ICON_SIZE) / 2 + 3) / FACE_TEXT_MAX_SIZE;
export const FACE_TEXT_OFFSET_Y_EM =
  -(FACE_GAP_PX * FACE_MAX_ICON_SIZE + (FACE_NATURAL_PT * FACE_MAX_ICON_SIZE) / 2) /
  FACE_TEXT_MAX_SIZE;

/** Badge band edges for the declutter pass (band 2 incl. crossfade skirts). */
export const BADGE_MIN_ZOOM = 12.9; // BAND_DOTS_TO_BADGES - BAND_FADE
export const BADGE_MAX_ZOOM = 15.2; // BAND_BADGES_TO_MODELS + BAND_FADE + 0.1
/**
 * Viewport margin for badge candidates, m. Wider than the section margin —
 * at z13.2 (~9.6 m/px) 600 m is ~60 px, enough that a pan at the mid-zoom 1 s
 * points cadence doesn't reveal un-decluttered edges.
 */
export const BADGE_CULL_MARGIN_M = 600;
/** Extra breathing room between badge boxes, px. */
export const BADGE_PAD_PX = 2;
/**
 * Half-size of the immovable obstacle box centered on EVERY tram's heading
 * teardrop marker (24 pt sprite × iconSize 0.6 rotates within ~±10 pt of its
 * anchor). Badges are solved against these too, so a plate can never cover
 * any tram's direction arrow — neither its own nor a neighbour's.
 */
export const MARKER_OBSTACLE_HALF_PX = 10;
/**
 * The map is normally PITCHED (default 45°, 3D toggle 55°), which compresses
 * north–south ground distances on screen by ≈ cos(pitch) while the billboard
 * badges keep their full screen height. The solve models screen space, so
 * anchor y-coordinates are scaled by this factor (cos 55° — the app's
 * steepest preset). At lower pitch the modeled overlap is conservative and
 * stacks just get a little extra air; without it, plates solved in map-plane
 * px visibly overlapped again once foreshortened. (Viewport carries no pitch
 * — a fixed conservative factor keeps this pure and cheap.)
 */
export const BADGE_PITCH_Y_SCALE = Math.cos((55 * Math.PI) / 180);
/** Approx digit advance as a fraction of textSize (DIN Pro Bold digits). */
const BADGE_TEXT_CHAR_EM = 0.6;
/** Second unit of a coupled T3 pair trails this far behind the first, meters. */
export const COUPLED_OFFSET_M = 14.5;
/** Right-hand-traffic offset: every tram is shifted this far right of its bearing. */
export const TRACK_OFFSET_M = 1.35;

const M_PER_DEG_LAT = 111_320;
const DEG2RAD = Math.PI / 180;

// ── Doors (sections band) ────────────────────────────────────────────────────
/**
 * Doors render open only while the tram is STANDING AT A PLATFORM. Phase
 * 'dwell' alone is not trusted: the RENDERED head must also be within
 * DOOR_NEAR_STOP_M of a stop and the tram standing (the old phase-only
 * condition opened doors between stops). All three signals are stable for
 * whole seconds, so the doors can't flicker.
 */
export const DOOR_NEAR_STOP_M = 25;
/** Doors render open only at/below this sim speed (standing), km/h. */
export const DOOR_MAX_SPEED_KMH = 1;

/** True when a stop's along-shape distM lies within tolM of sHead. */
export function nearStopWithin(
  stops: RouteGeometry['stops'],
  sHead: number,
  tolM: number,
): boolean {
  // stops are ordered along the trip (distM monotonic) — binary search.
  let lo = 0;
  let hi = stops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid].distM < sHead) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < stops.length ? stops[lo].distM - sHead : Number.POSITIVE_INFINITY;
  const before = lo > 0 ? sHead - stops[lo - 1].distM : Number.POSITIVE_INFINITY;
  return Math.min(after, before) <= tolM;
}

/** Doors-open decision for the rendered head position (see DOOR_NEAR_STOP_M). */
export function doorsOpen(state: TramPublicState, geometry: RouteGeometry, sHead: number): boolean {
  return (
    state.phase === 'dwell' &&
    state.simSpeedKmh <= DOOR_MAX_SPEED_KMH &&
    nearStopWithin(geometry.stops, sHead, DOOR_NEAR_STOP_M)
  );
}

// ── Render safety ────────────────────────────────────────────────────────────
// One non-finite coordinate (NaN stringifies to null) makes the NATIVE side
// reject the ENTIRE FeatureCollection push ("updateShape: data isn't in the
// correct format") — the whole layer then freezes at its last good frame.
// Observed live as the far-zoom arrows standing still / vanishing while the
// sections source kept moving. Every rendered position is guarded; a broken
// tram degrades (raw fix, then dropped for the frame), never the fleet.

const isFinitePos = (p: [number, number]): boolean =>
  Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Dev-only: report each tram whose state produced non-finite render coords once. */
const invalidWarned = new Set<string>();
function warnInvalidOnce(key: string, anchor: [number, number], bearing: number): void {
   
  if (typeof __DEV__ === 'undefined' || !__DEV__ || invalidWarned.has(key)) return;
  invalidWarned.add(key);
  console.warn(
    `[render] tram ${key} produced a non-finite render position ` +
      `(anchor=[${anchor[0]}, ${anchor[1]}], bearing=${bearing}) — falling back to the raw fix`,
  );
}

export interface BuildFrameOptions {
  selectedKey: string | null;
  /**
   * Followed tram key: the fix overlay (raw last fix point + connector line to
   * the rendered position) is emitted for this tram, falling back to
   * selectedKey when unset. The overlay is empty when neither is set. A
   * followed tram also gets `selected: 1` on its point — the map's badge
   * layers pin selected trams out of the collision/declutter pass, and a
   * follow target must NEVER be hidden by it (nor lose its halo when follow
   * outlives the selection).
   */
  followedKey?: string | null;
  favoriteKeys: ReadonlySet<string>;
  /** True when this tram runs as a coupled two-car set → render a second unit. */
  coupledPairFn: (key: string) => boolean;
  /** Geometry driving a tram's sim (undefined for trams without geometry). */
  getGeometry: (key: string) => RouteGeometry | undefined;
  /** Model spec override; defaults to state.model. */
  getSpec?: (key: string) => TramModelSpec | undefined;
  /**
   * Planner route-only mode: when set, ONLY trams whose line is in this set are
   * rendered (points and sections); everything else is hidden entirely.
   */
  lineFilter?: ReadonlySet<string> | null;
  /**
   * Skip building the points FC (it is pushed at a lower cadence than the
   * sections FC — the caller only needs points on some frames).
   */
  skipPoints?: boolean;
  /**
   * Badge anchor-slot memory (see BadgeAnchorMemory): pass a persistent
   * per-source Map so badge arrangements stay stable from push to push.
   * Omitted (tests / one-shot builds) → each solve is cold and pure.
   */
  badgeMemory?: BadgeAnchorMemory;
  /** Frame timestamp; defaults to Date.now(). */
  nowMs?: number;
}

type PointFeature = GeoJSON.Feature<GeoJSON.Point, PointFeatureProps>;
type SectionFeature = GeoJSON.Feature<GeoJSON.Point, SectionFeatureProps>;

export function expandBbox(
  bbox: [number, number, number, number],
  marginM: number,
): [number, number, number, number] {
  const [w, s, e, n] = bbox;
  const dLat = marginM / M_PER_DEG_LAT;
  const midLat = (s + n) / 2;
  const dLng = marginM / (M_PER_DEG_LAT * Math.max(Math.cos(midLat * DEG2RAD), 0.01));
  return [w - dLng, s - dLat, e + dLng, n + dLat];
}

function inBbox(p: [number, number], bbox: [number, number, number, number]): boolean {
  return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
}

/** Shift a position TRACK_OFFSET_M perpendicular-right of the given bearing. */
function offsetRight(p: [number, number], bearing: number): [number, number] {
  // Cheap local trig with cos(lat) correction (same math as destinationPoint,
  // inlined to avoid the modulo/normalization overhead per feature per frame).
  const theta = (bearing + 90) * DEG2RAD;
  const dNorth = Math.cos(theta) * TRACK_OFFSET_M;
  const dEast = Math.sin(theta) * TRACK_OFFSET_M;
  const latRad = p[1] * DEG2RAD;
  return [
    p[0] + dEast / (M_PER_DEG_LAT * Math.max(Math.cos(latRad), 1e-6)),
    p[1] + dNorth / M_PER_DEG_LAT,
  ];
}

function sectionFeature(
  id: string,
  key: string,
  modelKey: string,
  position: [number, number],
  bearing: number,
  stale: boolean,
): SectionFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: offsetRight(position, bearing) },
    properties: { key, modelKey, bearing, stale: stale ? 1 : 0 },
  };
}

/**
 * Position + bearing at a SIGNED distance along the shape. Negative distances
 * extrapolate straight back from the shape origin along the first segment's
 * bearing so rear sections/coupled cars keep their physical spacing near the
 * start of a trip instead of piling up at vertex zero.
 */
function placeAt(
  coordinates: [number, number][],
  cumDistM: number[],
  d: number,
): { position: [number, number]; bearing: number } {
  if (d >= 0 || coordinates.length === 0) {
    return {
      position: pointAt(coordinates, cumDistM, d),
      bearing: bearingAt(coordinates, cumDistM, d),
    };
  }
  const bearing = bearingAt(coordinates, cumDistM, 0);
  return {
    position: destinationPoint(coordinates[0], (bearing + 180) % 360, -d),
    bearing,
  };
}

/**
 * GLB key for a section: while the tram dwells at a stop the doors-open
 * variant renders (when authored); undefined openModelKey → normal key, and
 * the doors close again (normal key) as the tram departs.
 */
function sectionModelKey(section: TramModelSpec['sections'][number], dwelling: boolean): string {
  return dwelling && section.openModelKey !== undefined ? section.openModelKey : section.modelKey;
}

/**
 * Sections for a tram with known geometry: each body section placed along the
 * shape, head anchored at sHead — the rendered along-shape distance, whichever
 * curve produced it (the render mode is resolved upstream, in the adapter).
 */
function sectionsAlongShape(
  state: TramPublicState,
  spec: TramModelSpec,
  geometry: RouteGeometry,
  sHead: number,
  coupled: boolean,
  dwelling: boolean,
  out: SectionFeature[],
): void {
  const { coordinates, cumDistM } = geometry;
  let precedingLengths = 0;
  for (let i = 0; i < spec.sections.length; i++) {
    const section = spec.sections[i];
    const modelKey = sectionModelKey(section, dwelling);
    const centerDist = sHead - (precedingLengths + i * spec.jointGapM) - section.lengthM / 2;
    const placed = placeAt(coordinates, cumDistM, centerDist);
    // Render safety: a poisoned shape vertex must not sink the sections push.
    if (isFinitePos(placed.position) && Number.isFinite(placed.bearing)) {
      out.push(
        sectionFeature(
          `${state.key}#${i}`,
          state.key,
          modelKey,
          placed.position,
          placed.bearing,
          state.pastHorizon,
        ),
      );
    }
    if (coupled) {
      const trailed = placeAt(coordinates, cumDistM, centerDist - COUPLED_OFFSET_M);
      if (isFinitePos(trailed.position) && Number.isFinite(trailed.bearing)) {
        out.push(
          sectionFeature(
            `${state.key}#c${i}`,
            state.key,
            modelKey,
            trailed.position,
            trailed.bearing,
            state.pastHorizon,
          ),
        );
      }
    }
    precedingLengths += section.lengthM;
  }
}

/**
 * Polyline slice between two along-shape distances (either order), inclusive
 * of interpolated endpoints. Used for the fix-overlay connector line.
 */
function sliceShape(
  coordinates: [number, number][],
  cumDistM: number[],
  dA: number,
  dB: number,
): [number, number][] {
  const total = cumDistM.length > 0 ? cumDistM[cumDistM.length - 1] : 0;
  const a = Math.min(Math.max(Math.min(dA, dB), 0), total);
  const b = Math.min(Math.max(Math.max(dA, dB), 0), total);
  const out: [number, number][] = [pointAt(coordinates, cumDistM, a)];
  if (coordinates.length > 1) {
    for (let i = segmentIndexAt(cumDistM, a) + 1; i < coordinates.length && cumDistM[i] < b; i++) {
      if (cumDistM[i] > a) out.push(coordinates[i]);
    }
  }
  out.push(pointAt(coordinates, cumDistM, b));
  if (dA > dB) out.reverse();
  return out;
}

/**
 * Fix overlay for the selected/followed tram: the RAW last fix as a Point +
 * a connector LineString from it to the rendered position — sliced along the
 * shape when geometry is known, a straight line otherwise.
 */
function buildFixOverlay(
  state: TramPublicState,
  geometry: RouteGeometry | undefined,
  renderedDist: number,
  renderedAnchor: [number, number],
): GeoJSON.FeatureCollection {
  let line: [number, number][];
  if (geometry) {
    const obsDist = Math.min(Math.max(state.snapshot.shapeDistM, 0), geometry.totalM);
    line = sliceShape(geometry.coordinates, geometry.cumDistM, obsDist, renderedDist);
  } else {
    line = [state.observedPosition, renderedAnchor];
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: `${state.key}#fix`,
        geometry: { type: 'Point', coordinates: state.observedPosition },
        properties: { key: state.key, kind: 'fix', bearing: state.observedBearing },
      },
      {
        type: 'Feature',
        id: `${state.key}#fix-connector`,
        geometry: { type: 'LineString', coordinates: line },
        properties: { key: state.key, kind: 'connector' },
      },
    ],
  };
}

// ── Badge layout (band 2): variable-anchor placement hugging the marker ─────

/**
 * Frame-to-frame anchor memory (tram key → last chosen anchor slot). Owned by
 * the CALLER (a ref on the map layer, one per points source) and passed back
 * in on every push. Placement always prefers the nearest free slot, so a lone
 * badge always sits home (slot 0, above its arrow); the memory adds
 * HYSTERESIS on the way back — a slot CLOSER than the previous choice is
 * taken only when it is free with BADGE_HOME_HYST_PX of extra air, so a pair
 * of trams crawling apart can't flicker a plate between two sides at the
 * exact overlap threshold, while dissolved crowds still re-settle to the
 * default look within one push of having room.
 */
export type BadgeAnchorMemory = Map<string, number>;

/** Extra clearance required to move to a CLOSER slot than last push's. */
export const BADGE_HOME_HYST_PX = 6;

/**
 * Anchor slots around the marker, ordered nearest-first: above (default),
 * below, right, left, the four diagonals, then second/third stacked rows
 * above/below for pileups (co-located trams fan into a tidy vertical stack —
 * side slots can't help there because the wide plates overlap laterally). The
 * badge is never sent far away on a leader line — if every slot is occupied
 * it takes the least-overlapping one and accepts the overlap (everything
 * stays visible, everything stays AT its tram).
 */
export const BADGE_ANCHOR_SLOTS = 12;

/** One tram's badge in the declutter solve. */
export interface BadgeCandidate {
  key: string;
  line: string;
  modelId: TramModelSpec['id'];
  /** Rendered marker position (lng, lat) — the badge's true anchor. */
  pos: [number, number];
  /**
   * Pinned badges (selected/followed/favorite) NEVER move: they participate as
   * immovable obstacles, and no badge/leader feature is emitted for them (the
   * map draws them from the points FC on the always-visible pinned layer).
   */
  pinned: boolean;
  /** Rendered position is frozen (past horizon) — the badge dims with its tram. */
  stale: boolean;
}

/** Style-px per meter conversion for Mapbox's 512-px tiles at a latitude/zoom. */
export function metersPerStylePx(latDeg: number, zoom: number): number {
  return (40_075_016.686 * Math.cos(latDeg * DEG2RAD)) / 2 ** (zoom + 9);
}

/** iconSize the badge style resolves to at a zoom (clamped band interpolation). */
export function badgeIconSize(zoom: number): number {
  const t = Math.min(Math.max((zoom - 13.2) / (14.8 - 13.2), 0), 1);
  return FACE_MAX_ICON_SIZE * (FACE_MIN_RATIO + (1 - FACE_MIN_RATIO) * t);
}

/**
 * Screen box of one badge (face sprite + line number) relative to its marker
 * anchor, style px, y-down. The box floats FACE_GAP_PX×s above the anchor and
 * extends right to cover the seated line number — mirroring the symbol style
 * in TramLayers exactly (same constants).
 */
export function badgeBoxPx(
  line: string,
  zoom: number,
): { halfW: number; halfH: number; centerOffX: number; centerOffY: number } {
  const s = badgeIconSize(zoom);
  const face = FACE_NATURAL_PT * s;
  const gap = FACE_GAP_PX * s;
  const textSize = (FACE_TEXT_MAX_SIZE / FACE_MAX_ICON_SIZE) * s;
  const textW = 6 * s + BADGE_TEXT_CHAR_EM * textSize * Math.min(line.length, 3);
  return {
    halfW: (face + textW) / 2,
    halfH: face / 2,
    centerOffX: textW / 2,
    centerOffY: -(gap + face / 2),
  };
}

/**
 * Box center of an anchor slot relative to the marker, style px (y-down).
 * Slot 0 reproduces the layer style's default geometry exactly (plate floats
 * FACE_GAP_PX×s above the arrow, face centered on it): its center IS
 * badgeBoxPx's (centerOffX, centerOffY). All other slots keep the same
 * clearances — vertical slots reuse the slot-0 air gap, side slots clear the
 * marker obstacle box plus pad — so a chosen slot is always arrow-safe by
 * construction.
 */
export function badgeAnchorCenterPx(
  box: { halfW: number; halfH: number; centerOffX: number; centerOffY: number },
  zoom: number,
  slot: number,
): { x: number; y: number } {
  const gapY = FACE_GAP_PX * badgeIconSize(zoom);
  const vy = gapY + box.halfH; // vertical ring distance (slot-0 geometry)
  const sx = box.halfW + MARKER_OBSTACLE_HALF_PX + BADGE_PAD_PX; // side ring
  switch (slot) {
    case 0:
      return { x: box.centerOffX, y: -vy }; // above (default home)
    case 1:
      return { x: box.centerOffX, y: vy }; // below
    case 2:
      return { x: sx, y: 0 }; // right
    case 3:
      return { x: -sx, y: 0 }; // left
    case 4:
      return { x: sx, y: -vy }; // top-right
    case 5:
      return { x: -sx, y: -vy }; // top-left
    case 6:
      return { x: sx, y: vy }; // bottom-right
    case 7:
      return { x: -sx, y: vy }; // bottom-left
    case 8:
      return { x: box.centerOffX, y: -(vy + 2 * box.halfH + BADGE_PAD_PX) }; // row 2 above
    case 9:
      return { x: box.centerOffX, y: vy + 2 * box.halfH + BADGE_PAD_PX }; // row 2 below
    case 10:
      return { x: box.centerOffX, y: -(vy + 2 * (2 * box.halfH + BADGE_PAD_PX)) }; // row 3 above
    default:
      return { x: box.centerOffX, y: vy + 2 * (2 * box.halfH + BADGE_PAD_PX) }; // row 3 below
  }
}

/**
 * The variable-anchor badge solve: every badge is glued to its own marker on
 * one of BADGE_ANCHOR_SLOTS fixed slots around it — the layout question is
 * only WHICH SIDE, never "how far away".
 *
 * Greedy, deterministic: pinned badges (immovable, drawn by the map from the
 * points FC) claim their default slot first, then candidates in key order
 * take the nearest slot whose box collides with nothing placed so far —
 * placed plates AND every tram's heading-teardrop obstacle box
 * (MARKER_OBSTACLE_HALF_PX), so no plate ever covers any direction arrow.
 * The anchor memory adds return-home hysteresis (see BadgeAnchorMemory): a
 * slot closer than last push's needs BADGE_HOME_HYST_PX of extra air, so
 * arrangements are stable push to push and plates glide home the moment a
 * dissolved crowd leaves room — never parked on a side slot forever.
 * If every slot is taken (extreme pileup) the least-overlapping slot wins and
 * the residual overlap is accepted — everything stays visible, at its tram.
 *
 * Returns badge Point features AT their markers, with the chosen slot encoded
 * as data-driven screen offsets (`off` icon units / `toff` text em); pinned
 * candidates emit nothing (see BadgeCandidate.pinned). No leader lines — a
 * badge is never far enough from its marker to need one.
 */
export function declutterBadges(
  cands: BadgeCandidate[],
  zoom: number,
  midLatDeg: number,
  memory?: BadgeAnchorMemory,
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  if (cands.length === 0) {
    memory?.clear();
    return features;
  }
  // Pinned first (they claim their default slot as obstacles), then key order
  // — deterministic, so identical input gives identical output every push.
  const sorted = [...cands].sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  const mpp = metersPerStylePx(midLatDeg, zoom);
  const mPerDegLng = M_PER_DEG_LAT * Math.max(Math.cos(midLatDeg * DEG2RAD), 0.01);
  const n = sorted.length;
  // Marker anchors projected to style px (y-down, pitched-camera y scale).
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  // Obstacle boxes accumulated as plates are placed: seeded with every tram's
  // marker box, grown by each placed plate. Small n — plain arrays are fine.
  const obCx: number[] = [];
  const obCy: number[] = [];
  const obHw: number[] = [];
  const obHh: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = sorted[i];
    ax[i] = (c.pos[0] * mPerDegLng) / mpp;
    // Screen-space estimate: north–south ground distances foreshorten under
    // the app's pitched camera while billboard badges keep their height.
    ay[i] = ((-c.pos[1] * M_PER_DEG_LAT) / mpp) * BADGE_PITCH_Y_SCALE;
    obCx.push(ax[i]);
    obCy.push(ay[i]);
    obHw.push(MARKER_OBSTACLE_HALF_PX);
    obHh.push(MARKER_OBSTACLE_HALF_PX);
  }

  /**
   * Total overlap area of a box against everything placed so far (0 = free).
   * platePad applies to PLATE obstacles only (indices ≥ n — placed after the
   * marker seeds): the return-home hysteresis must not test against marker
   * boxes, whose clearance is fixed by slot geometry (slot 0 clears its own
   * marker by construction but with less air than the hysteresis margin).
   */
  const overlapAt = (cx: number, cy: number, hw: number, hh: number, platePad: number): number => {
    let total = 0;
    for (let k = 0; k < obCx.length; k++) {
      const pad = k < n ? BADGE_PAD_PX : platePad;
      const ox = hw + obHw[k] + pad - Math.abs(cx - obCx[k]);
      if (ox <= 0) continue;
      const oy = hh + obHh[k] + pad - Math.abs(cy - obCy[k]);
      if (oy <= 0) continue;
      total += ox * oy;
    }
    return total;
  };

  /** New slot choices, written back to the memory at the end of the solve
   *  (reads above happen against the PREVIOUS push's map). */
  const nextMemory: [string, number][] = [];
  for (let i = 0; i < n; i++) {
    const c = sorted[i];
    const box = badgeBoxPx(c.line, zoom);
    if (c.pinned) {
      // Drawn by the points-source pinned layer at the default slot; occupy
      // its box so neighbours pick other sides.
      const p = badgeAnchorCenterPx(box, zoom, 0);
      obCx.push(ax[i] + p.x);
      obCy.push(ay[i] + p.y);
      obHw.push(box.halfW);
      obHh.push(box.halfH);
      continue;
    }
    // Nearest free slot wins, with return-home hysteresis: moving to a slot
    // CLOSER than last push's requires extra clearance (BADGE_HOME_HYST_PX),
    // so plates can't flicker between sides at the exact overlap threshold —
    // but a lone badge always ends up back on the default slot above its
    // arrow within one push of having room.
    const prevSlot = memory?.get(c.key);
    let pick = -1;
    let best = 0;
    let bestOverlap = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < BADGE_ANCHOR_SLOTS; slot++) {
      const p = badgeAnchorCenterPx(box, zoom, slot);
      const pad =
        prevSlot !== undefined && slot < prevSlot
          ? BADGE_PAD_PX + BADGE_HOME_HYST_PX
          : BADGE_PAD_PX;
      const over = overlapAt(ax[i] + p.x, ay[i] + p.y, box.halfW, box.halfH, pad);
      if (over === 0) {
        pick = slot;
        break;
      }
      if (over < bestOverlap) {
        bestOverlap = over;
        best = slot;
      }
    }
    if (pick < 0) pick = best; // pileup: least overlap, accepted
    const center = badgeAnchorCenterPx(box, zoom, pick);
    obCx.push(ax[i] + center.x);
    obCy.push(ay[i] + center.y);
    obHw.push(box.halfW);
    obHh.push(box.halfH);
    nextMemory.push([c.key, pick]);

    // Feature geometry stays AT THE MARKER; the slot is expressed as
    // data-driven icon/text offsets in PURE SCREEN px (`off` in icon-offset
    // units ×iconSize, `toff` in text em). Converting the slot displacement
    // into world lng/lat (the old approach) baked the cos-55° pitch estimate
    // into the geometry — at any other camera pitch the plate visibly
    // detached from its arrow (2D was worst, ×1.74). Screen offsets are
    // pixel-exact at every pitch: the plate is glued to its marker.
    const s = badgeIconSize(zoom);
    const dxPx = center.x - box.centerOffX;
    const dyPx = center.y - box.centerOffY;
    const textSize = (FACE_TEXT_MAX_SIZE / FACE_MAX_ICON_SIZE) * s;
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    features.push({
      type: 'Feature',
      id: `${c.key}#b`,
      geometry: { type: 'Point', coordinates: c.pos },
      properties: {
        key: c.key,
        line: c.line,
        modelId: c.modelId,
        displaced: pick === 0 ? 0 : 1,
        // Carried so the bulk badge layer dims a frozen tram exactly like the
        // points layers do — a stale plate must not look livelier than its dot.
        stale: c.stale ? 1 : 0,
        off: [r2(dxPx / s), r2(-FACE_GAP_PX + dyPx / s)],
        toff: [
          r2(FACE_TEXT_OFFSET_X_EM + dxPx / textSize),
          r2(FACE_TEXT_OFFSET_Y_EM + dyPx / textSize),
        ],
      },
    });
  }
  if (memory) {
    memory.clear();
    for (const [key, slot] of nextMemory) memory.set(key, slot);
  }
  return features;
}

/** Build one render frame from engine states. */
export function buildFrame(
  states: TramPublicState[],
  viewport: Viewport,
  opts: BuildFrameOptions,
): EngineFrame {
  const points: PointFeature[] = [];
  const sections: SectionFeature[] = [];
  const sectionsEnabled = viewport.zoom >= SECTION_MIN_ZOOM;
  const cullBbox = sectionsEnabled ? expandBbox(viewport.bbox, CULL_MARGIN_M) : viewport.bbox;
  const lineFilter = opts.lineFilter ?? null;
  const nowMs = opts.nowMs ?? Date.now();
  const overlayKey = opts.followedKey ?? opts.selectedKey;
  let fixOverlay: GeoJSON.FeatureCollection | null = null;
  // Badge declutter runs only on points-push frames inside the badge band,
  // over viewport-culled trams (payload ∝ visible; zero cost outside band 2).
  const badgesEnabled =
    !opts.skipPoints && viewport.zoom >= BADGE_MIN_ZOOM && viewport.zoom <= BADGE_MAX_ZOOM;
  const badgeCands: BadgeCandidate[] = [];
  const badgeBbox = badgesEnabled ? expandBbox(viewport.bbox, BADGE_CULL_MARGIN_M) : null;

  for (const state of states) {
    // Planner route-only mode: trams off the itinerary's lines vanish entirely.
    if (lineFilter && !lineFilter.has(state.snapshot.line)) continue;

    const isOverlayTarget = overlayKey !== null && state.key === overlayKey;
    // Geometry is needed for the 3D sections and for the fix-overlay connector
    // slice. It is NOT needed to place the head any more: physics v3 resolves
    // the rendered position in the adapter (curves → pointAt/bearingAt on this
    // same geometry), so this module is mode-agnostic — switching smooth↔fixed
    // changes the numbers arriving here, never the code path taken.
    const geometry =
      state.hasGeometry && (sectionsEnabled || isOverlayTarget)
        ? opts.getGeometry(state.key)
        : undefined;

    let sHead = state.simDistM;
    let anchor = state.position;
    let bearing = state.bearing;

    // Render safety: never let a non-finite position/bearing reach a push —
    // it would poison the whole ShapeSource (see the guard block above).
    if (!isFinitePos(anchor) || !Number.isFinite(bearing)) {
      warnInvalidOnce(state.key, anchor, bearing);
      anchor = state.observedPosition;
      bearing = Number.isFinite(state.observedBearing) ? state.observedBearing : 0;
      sHead = Number.NaN; // no trustworthy along-shape head → no 3D body this frame
      if (!isFinitePos(anchor)) continue; // beyond saving — drop for this frame
    }

    // A tram without a loaded shape renders as a plain dot at its RAW GPS
    // position: no perpendicular track offset (there is no reliable bearing to
    // offset by) and no 3D body below. Offsetting/rotating a geometry-less tram
    // is what stood it at an angle beside the network while its shape loaded.
    const geometryless = !state.hasGeometry;
    if (!opts.skipPoints) {
      const rendered = geometryless ? anchor : offsetRight(anchor, bearing);
      // The followed tram counts as selected: badge layers pin selected trams
      // out of the declutter pass (they must never be hidden or displaced),
      // and the gold halo keeps marking a follow that outlives the selection.
      const selected =
        state.key === opts.selectedKey ||
        (opts.followedKey != null && state.key === opts.followedKey)
          ? 1
          : 0;
      const favorite = opts.favoriteKeys.has(state.key) ? 1 : 0;
      points.push({
        type: 'Feature',
        id: state.key,
        geometry: { type: 'Point', coordinates: rendered },
        properties: {
          key: state.key,
          line: state.snapshot.line,
          bearing,
          modelId: state.model.id,
          selected,
          favorite,
          geometryless: geometryless ? 1 : 0,
          // Connection honesty, per tram: a tram whose curve ran out (or which
          // never got one) is FROZEN on screen, so the layers dim it. The rest
          // of the fleet keeps moving — the difference has to be visible.
          stale: state.pastHorizon ? 1 : 0,
        },
      });
      // Badge declutter candidate: visible band-2 badges only. Pinned
      // (selected/followed/favorite) trams join as immovable obstacles.
      if (badgesEnabled && !geometryless && badgeBbox && inBbox(rendered, badgeBbox)) {
        badgeCands.push({
          key: state.key,
          line: state.snapshot.line,
          modelId: state.model.id,
          pos: rendered,
          pinned: selected === 1 || favorite === 1,
          stale: state.pastHorizon,
        });
      }
    }

    // Raw-fix overlay for the followed/selected tram — independent of the
    // section zoom band and viewport cull. Skipped when the raw fix itself is
    // broken (render safety: never push non-finite coordinates).
    if (isOverlayTarget && isFinitePos(state.observedPosition)) {
      fixOverlay = buildFixOverlay(
        state,
        Number.isFinite(sHead) ? geometry : undefined,
        sHead,
        anchor,
      );
    }

    // A geometry-less tram draws NO 3D sections — only the dot above. Rendering
    // a full articulated body along the raw AVL bearing (which is unreliable at
    // v≈0) placed it at an angle off the drawn line, sometimes inside buildings.
    // Better a small dot until the shape streams in (Fix 2 shortens that wait).
    if (geometryless) continue;

    // Whole-tram cull by head position; the margin covers the longest possible
    // body + coupled trailer, so a partially-visible tram keeps all sections.
    if (!sectionsEnabled || !inBbox(anchor, cullBbox)) continue;

    // geometry is defined here: geometryless was skipped above, and hasGeometry
    // implies a live sim whose shape getGeometry() returns. A NaN sHead means
    // the along-shape head was unusable this frame (render safety above).
    if (!geometry || !Number.isFinite(sHead)) continue;
    const spec = opts.getSpec?.(state.key) ?? state.model;
    const coupled = opts.coupledPairFn(state.key);
    // Doors open ONLY while standing at a platform (dwell phase AND v≈0 AND
    // the rendered head near a stop — see doorsOpen): sections with an
    // authored openModelKey render it, closing on departure. The near-stop
    // check keys off the RENDERED head, so live mode (projected observation)
    // can't show open doors mid-segment while the smooth sim dwells.
    const dwelling = doorsOpen(state, geometry, sHead);
    sectionsAlongShape(state, spec, geometry, sHead, coupled, dwelling, sections);
  }

  const midLat = (viewport.bbox[1] + viewport.bbox[3]) / 2;
  return {
    points: { type: 'FeatureCollection', features: points },
    sections: { type: 'FeatureCollection', features: sections },
    badges: {
      type: 'FeatureCollection',
      features: badgesEnabled
        ? declutterBadges(badgeCands, viewport.zoom, midLat, opts.badgeMemory)
        : [],
    },
    fixOverlay: fixOverlay ?? { type: 'FeatureCollection', features: [] },
    atMs: nowMs,
  };
}
