// Engine states → GeoJSON render frame:
//  - points FC: ALL trams (circle/badge layers + hit testing)
//  - sections FC: articulated body sections, only for trams inside the viewport
//    (+300 m margin) at zoom >= 14.8 — drives the ModelLayer. While a tram
//    dwells at a stop its sections render their doors-open GLB variants
//    (TramSection.openModelKey, when authored).
//  - badges FC (band 2 only): DECLUTTERED face-badge anchors + leader lines.
//    Overlapping badges are pushed apart (never hidden) by a small screen-space
//    separation solve over the visible trams; a displaced badge gets a thin
//    leader LineString back to its true marker. Selected/followed/favorite
//    badges are immovable obstacles (they stay put; neighbours move around
//    them) and are NOT emitted here — the map draws them from the points FC on
//    the pinned layer. Runs only on points-push frames inside the badge zoom
//    band, over viewport-culled trams (payload ∝ visible).
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
/** iconSize at the top of the badge band (face renders 32 pt tall). */
export const FACE_MAX_ICON_SIZE = 0.5;
/** iconSize ramps down to this fraction of max at band entry. */
export const FACE_MIN_RATIO = 0.78;
/**
 * Gap between the marker point and the face bottom (iconOffset units ×
 * iconSize). Sized so the floating plate NEVER touches its own heading
 * teardrop: gap × min iconSize (32 × 0.39 ≈ 12.5 pt) clears the teardrop's
 * rotation reach (24 pt sprite × 0.6 → ≤ ~10 pt from the anchor) — see
 * MARKER_OBSTACLE_HALF_PX below.
 */
export const FACE_GAP_PX = 32;
/** Line-number text size at the top of the band (lockstep with iconSize). */
export const FACE_TEXT_MAX_SIZE = 15;

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
/** A badge never moves further than this from its marker, px (extreme pileups). */
export const BADGE_MAX_DISPLACE_PX = 100;
/** Displacements below this snap back to zero (no leader, no visual noise). */
export const BADGE_SNAP_PX = 1;
/** A leader line is drawn once the badge moved at least this far, px. */
export const BADGE_LEADER_MIN_PX = 6;
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
/**
 * Gauss-Seidel sweeps. Worst realistic case (several co-located trams at a
 * terminal, plates cascading over marker obstacles) settles well within this;
 * cost is O(n² · iters) over the handful of visible band-2 trams per points
 * push — microseconds.
 */
const BADGE_SOLVER_ITERS = 16;
/** Approx digit advance as a fraction of textSize (DIN Pro Bold digits). */
const BADGE_TEXT_CHAR_EM = 0.6;
/** Second unit of a coupled T3 pair trails this far behind the first, meters. */
export const COUPLED_OFFSET_M = 14.5;
/** Right-hand-traffic offset: every tram is shifted this far right of its bearing. */
export const TRACK_OFFSET_M = 1.35;

const M_PER_DEG_LAT = 111_320;
const DEG2RAD = Math.PI / 180;

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
   * Badge-declutter displacement memory (see BadgeDisplacementMemory): pass a
   * persistent per-source Map so badge arrangements stay stable from push to
   * push. Omitted (tests / one-shot builds) → each solve is cold and pure.
   */
  badgeMemory?: BadgeDisplacementMemory;
  /**
   * 'smooth' (default): render at the simulated/interpolated position.
   * 'live': render at the engine's projected observation — the last AVL fix
   * dead-reckoned forward to now (TramPublicState.projectedObservedDistM),
   * falling back to the raw fix (observedPosition / raw shape distance) when
   * no projection exists. Advances smoothly between polls and jumps (forward
   * or back) whenever a new fix arrives — accepted live-mode UX.
   */
  positionMode?: 'smooth' | 'live';
  /** Frame timestamp; defaults to Date.now(). */
  nowMs?: number;
}

type PointFeature = GeoJSON.Feature<GeoJSON.Point, PointFeatureProps>;
type SectionFeature = GeoJSON.Feature<GeoJSON.Point, SectionFeatureProps>;

function expandBbox(
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
): SectionFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: offsetRight(position, bearing) },
    properties: { key, modelKey, bearing },
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
 * shape, head anchored at sHead (sim distance in smooth mode, the projected
 * observation in live mode).
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
    out.push(
      sectionFeature(`${state.key}#${i}`, state.key, modelKey, placed.position, placed.bearing),
    );
    if (coupled) {
      const trailed = placeAt(coordinates, cumDistM, centerDist - COUPLED_OFFSET_M);
      out.push(
        sectionFeature(
          `${state.key}#c${i}`,
          state.key,
          modelKey,
          trailed.position,
          trailed.bearing,
        ),
      );
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

// ── Badge declutter (band 2): push overlapping badges apart, never hide ─────

/**
 * Frame-to-frame displacement memory (tram key → last solved offset, px).
 * Owned by the CALLER (a ref on the map layer, one per points source) and
 * passed back in on every push: the solver SEEDS from it, so a stack keeps
 * its arrangement as trams crawl instead of re-deriving (and visibly
 * re-shuffling) from scratch on every push, and writes the new offsets back.
 * Each push the seed is pulled toward home by BADGE_HOME_PULL first — badges
 * whose crowd dissolved glide back to their marker over a few pushes, while
 * still-colliding ones are pushed right back out BEFORE output, so the
 * equilibrium output is exactly stable (no breathing).
 */
export type BadgeDisplacementMemory = Map<string, { dx: number; dy: number }>;
const BADGE_HOME_PULL = 0.75;

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
 * The declutter solve: deterministic pairwise separation in screen space.
 *
 * Each candidate's badge box starts glued to its marker; overlapping pairs are
 * pushed apart along the axis of least overlap (Gauss-Seidel, a few sweeps —
 * n is the handful of visible band-2 trams, so O(n²) is trivial at the points
 * cadence). Pinned badges have infinite mass. EVERY tram's heading-teardrop
 * marker is additionally an immovable obstacle box (MARKER_OBSTACLE_HALF_PX),
 * so no plate ever covers any direction arrow. Ties (identical positions,
 * e.g. a depot) break by input order after a key sort, so the result is
 * stable frame to frame. Displacement is capped; leftovers may still overlap
 * at extreme pileups — accepted, everything stays visible.
 *
 * Returns badge Point features at the DISPLACED anchors plus leader
 * LineStrings (marker → displaced anchor) for badges that moved; pinned
 * candidates emit nothing (see BadgeCandidate.pinned).
 */
export function declutterBadges(
  cands: BadgeCandidate[],
  zoom: number,
  midLatDeg: number,
  memory?: BadgeDisplacementMemory,
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  if (cands.length === 0) {
    memory?.clear();
    return features;
  }
  const sorted = [...cands].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const mpp = metersPerStylePx(midLatDeg, zoom);
  const mPerDegLng = M_PER_DEG_LAT * Math.max(Math.cos(midLatDeg * DEG2RAD), 0.01);
  const n = sorted.length;
  // Marker anchors projected to style px (y-down), box metrics, displacement.
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const hw = new Float64Array(n);
  const hh = new Float64Array(n);
  const cx = new Float64Array(n); // current box center = anchor + offset + displacement
  const cy = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = sorted[i];
    ax[i] = (c.pos[0] * mPerDegLng) / mpp;
    // Screen-space estimate: north–south ground distances foreshorten under
    // the app's pitched camera while billboard badges keep their height.
    ay[i] = ((-c.pos[1] * M_PER_DEG_LAT) / mpp) * BADGE_PITCH_Y_SCALE;
    const box = badgeBoxPx(c.line, zoom);
    hw[i] = box.halfW;
    hh[i] = box.halfH;
    // Seed from the previous push's solution (pulled slightly toward home) so
    // arrangements stay put frame to frame instead of re-deriving cold.
    const prev = c.pinned ? undefined : memory?.get(c.key);
    if (prev) {
      dx[i] = prev.dx * BADGE_HOME_PULL;
      dy[i] = prev.dy * BADGE_HOME_PULL;
    }
    cx[i] = ax[i] + box.centerOffX + dx[i];
    cy[i] = ay[i] + box.centerOffY + dy[i];
  }

  for (let iter = 0; iter < BADGE_SOLVER_ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const pinnedI = sorted[i].pinned;
        const pinnedJ = sorted[j].pinned;
        if (pinnedI && pinnedJ) continue;
        const sepX = cx[j] - cx[i];
        const sepY = cy[j] - cy[i];
        const overX = hw[i] + hw[j] + BADGE_PAD_PX - Math.abs(sepX);
        const overY = hh[i] + hh[j] + BADGE_PAD_PX - Math.abs(sepY);
        if (overX <= 0 || overY <= 0) continue;
        // Separate along the axis needing the smaller push. Exact ties (badges
        // at the same point) resolve vertically by sort order — deterministic.
        if (overX < overY) {
          const sign = sepX > 0 ? 1 : sepX < 0 ? -1 : 1;
          if (pinnedI) {
            cx[j] += sign * overX;
            dx[j] += sign * overX;
          } else if (pinnedJ) {
            cx[i] -= sign * overX;
            dx[i] -= sign * overX;
          } else {
            const half = overX / 2;
            cx[i] -= sign * half;
            dx[i] -= sign * half;
            cx[j] += sign * half;
            dx[j] += sign * half;
          }
        } else {
          const sign = sepY > 0 ? 1 : sepY < 0 ? -1 : 1;
          if (pinnedI) {
            cy[j] += sign * overY;
            dy[j] += sign * overY;
          } else if (pinnedJ) {
            cy[i] -= sign * overY;
            dy[i] -= sign * overY;
          } else {
            const half = overY / 2;
            cy[i] -= sign * half;
            dy[i] -= sign * half;
            cy[j] += sign * half;
            dy[j] += sign * half;
          }
        }
        moved = true;
      }
    }
    // Marker obstacles: no plate may cover ANY tram's direction arrow. The
    // obstacle is static (it IS the tram's position) — the badge takes the
    // whole push. Pinned plates stay put by definition (their geometry
    // already clears their own marker; a neighbour's marker under a pinned
    // plate is resolved by that neighbour's badge moving, not this one).
    for (let i = 0; i < n; i++) {
      if (sorted[i].pinned) continue;
      for (let j = 0; j < n; j++) {
        const sepX = cx[i] - ax[j];
        const sepY = cy[i] - ay[j];
        const overX = hw[i] + MARKER_OBSTACLE_HALF_PX + BADGE_PAD_PX - Math.abs(sepX);
        const overY = hh[i] + MARKER_OBSTACLE_HALF_PX + BADGE_PAD_PX - Math.abs(sepY);
        if (overX <= 0 || overY <= 0) continue;
        if (overX < overY) {
          const sign = sepX > 0 ? 1 : sepX < 0 ? -1 : 1;
          cx[i] += sign * overX;
          dx[i] += sign * overX;
        } else {
          // Vertical tie (plate pushed straight onto a marker): resolve UP —
          // above the arrow is the plate's natural home.
          const sign = sepY > 0 ? 1 : -1;
          cy[i] += sign * overY;
          dy[i] += sign * overY;
        }
        moved = true;
      }
    }
    // Cap runaway displacement (extreme pileups) each sweep.
    for (let i = 0; i < n; i++) {
      const mag = Math.hypot(dx[i], dy[i]);
      if (mag > BADGE_MAX_DISPLACE_PX) {
        const k = BADGE_MAX_DISPLACE_PX / mag;
        cx[i] -= dx[i] * (1 - k);
        cy[i] -= dy[i] * (1 - k);
        dx[i] *= k;
        dy[i] *= k;
      }
    }
    if (!moved) break;
  }

  memory?.clear();
  for (let i = 0; i < n; i++) {
    const c = sorted[i];
    if (c.pinned) continue; // drawn by the points-source pinned layer
    let mag = Math.hypot(dx[i], dy[i]);
    if (mag < BADGE_SNAP_PX) {
      dx[i] = 0;
      dy[i] = 0;
      mag = 0;
    }
    if (mag > 0) memory?.set(c.key, { dx: dx[i], dy: dy[i] });
    const anchor: [number, number] =
      mag === 0
        ? c.pos
        : [
            c.pos[0] + (dx[i] * mpp) / mPerDegLng,
            // Screen-y displacement back to latitude: undo the pitch scale.
            c.pos[1] - (dy[i] * mpp) / (M_PER_DEG_LAT * BADGE_PITCH_Y_SCALE),
          ];
    features.push({
      type: 'Feature',
      id: `${c.key}#b`,
      geometry: { type: 'Point', coordinates: anchor },
      properties: { key: c.key, line: c.line, modelId: c.modelId, displaced: mag > 0 ? 1 : 0 },
    });
    if (mag >= BADGE_LEADER_MIN_PX) {
      features.push({
        type: 'Feature',
        id: `${c.key}#l`,
        geometry: { type: 'LineString', coordinates: [c.pos, anchor] },
        properties: { key: c.key, line: c.line, kind: 'leader' },
      });
    }
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
  const live = opts.positionMode === 'live';
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
    // Geometry is needed for sections, for live-mode anchoring at the
    // projected observation, and for the fix-overlay connector slice.
    const geometry =
      state.hasGeometry && (sectionsEnabled || live || isOverlayTarget)
        ? opts.getGeometry(state.key)
        : undefined;

    // Rendered anchor: simulated position in smooth mode; in live mode the
    // engine's projected observation (dead-reckoned fix), falling back to the
    // raw fix distance / observed position when no projection exists.
    let sHead = state.simDistM;
    let anchor = state.position;
    let bearing = state.bearing;
    if (live) {
      if (geometry) {
        sHead = Math.min(
          Math.max(state.projectedObservedDistM ?? state.snapshot.shapeDistM, 0),
          geometry.totalM,
        );
        anchor = pointAt(geometry.coordinates, geometry.cumDistM, sHead);
        bearing = bearingAt(geometry.coordinates, geometry.cumDistM, sHead);
      } else {
        anchor = state.observedPosition;
        bearing = state.observedBearing;
      }
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
        });
      }
    }

    // Raw-fix overlay for the followed/selected tram — independent of the
    // section zoom band and viewport cull.
    if (isOverlayTarget) {
      fixOverlay = buildFixOverlay(state, geometry, sHead, anchor);
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
    // implies a live sim whose shape getGeometry() returns.
    if (!geometry) continue;
    const spec = opts.getSpec?.(state.key) ?? state.model;
    const coupled = opts.coupledPairFn(state.key);
    // Doors open while dwelling at a stop (sections band only — this loop):
    // sections with an authored openModelKey render it, closing on departure.
    const dwelling = state.phase === 'dwell';
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
    atMs: opts.nowMs ?? Date.now(),
  };
}
