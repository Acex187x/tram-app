// Engine states → GeoJSON render frame:
//  - points FC: ALL trams (circle/badge layers + hit testing)
//  - sections FC: articulated body sections, only for trams inside the viewport
//    (+300 m margin) at zoom >= 14.8 — drives the ModelLayer.
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
import { bearingAt, destinationPoint, pointAt } from '../geo/polyline';

/** Sections render only at/above this zoom (mode 3+). */
export const SECTION_MIN_ZOOM = 14.8;
/** Extra margin around the viewport bbox for whole-tram section culling, m. */
export const CULL_MARGIN_M = 300;
/** Second unit of a coupled T3 pair trails this far behind the first, meters. */
export const COUPLED_OFFSET_M = 14.5;
/** Right-hand-traffic offset: every tram is shifted this far right of its bearing. */
export const TRACK_OFFSET_M = 1.35;

const M_PER_DEG_LAT = 111_320;
const DEG2RAD = Math.PI / 180;

export interface BuildFrameOptions {
  selectedKey: string | null;
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
   * 'smooth' (default): render at the simulated/interpolated position.
   * 'live': render exactly at the last reported AVL fix (observedPosition /
   * observedBearing, sections anchored at the observed shape distance) — no
   * simulated motion between polls, positions jump on each data update.
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
 * Sections for a tram with known geometry: each body section placed along the
 * shape, head anchored at sHead (sim distance in smooth mode, the observed
 * fix's shape distance in live mode).
 */
function sectionsAlongShape(
  state: TramPublicState,
  spec: TramModelSpec,
  geometry: RouteGeometry,
  sHead: number,
  coupled: boolean,
  out: SectionFeature[],
): void {
  const { coordinates, cumDistM } = geometry;
  let precedingLengths = 0;
  for (let i = 0; i < spec.sections.length; i++) {
    const section = spec.sections[i];
    const centerDist = sHead - (precedingLengths + i * spec.jointGapM) - section.lengthM / 2;
    const placed = placeAt(coordinates, cumDistM, centerDist);
    out.push(
      sectionFeature(`${state.key}#${i}`, state.key, section.modelKey, placed.position, placed.bearing),
    );
    if (coupled) {
      const trailed = placeAt(coordinates, cumDistM, centerDist - COUPLED_OFFSET_M);
      out.push(
        sectionFeature(
          `${state.key}#c${i}`,
          state.key,
          section.modelKey,
          trailed.position,
          trailed.bearing,
        ),
      );
    }
    precedingLengths += section.lengthM;
  }
}

/**
 * Fallback for trams without geometry: ALL sections rendered in a straight
 * line trailing behind the given anchor position along its bearing. (Rendering
 * only the head section here was the "tram cut off — only the front piece
 * visible" bug for multi-section trams whose shape hadn't loaded yet.)
 */
function sectionsAtRawPosition(
  state: TramPublicState,
  spec: TramModelSpec,
  anchor: [number, number],
  bearing: number,
  coupled: boolean,
  out: SectionFeature[],
): void {
  const back = (bearing + 180) % 360;
  const headHalf = spec.sections.length > 0 ? spec.sections[0].lengthM / 2 : 0;
  let precedingLengths = 0;
  for (let i = 0; i < spec.sections.length; i++) {
    const section = spec.sections[i];
    // Distance of this section's center behind the FIRST section's center, so
    // section 0 stays exactly at the raw API position.
    const behindM = precedingLengths + i * spec.jointGapM + section.lengthM / 2 - headHalf;
    const position = behindM > 0 ? destinationPoint(anchor, back, behindM) : anchor;
    out.push(
      sectionFeature(`${state.key}#${i}`, state.key, section.modelKey, position, bearing),
    );
    if (coupled) {
      out.push(
        sectionFeature(
          `${state.key}#c${i}`,
          state.key,
          section.modelKey,
          destinationPoint(anchor, back, behindM + COUPLED_OFFSET_M),
          bearing,
        ),
      );
    }
    precedingLengths += section.lengthM;
  }
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

  for (const state of states) {
    // Planner route-only mode: trams off the itinerary's lines vanish entirely.
    if (lineFilter && !lineFilter.has(state.snapshot.line)) continue;

    // Live mode anchors everything at the last reported AVL fix instead of the
    // simulated position — honest raw data, jumping on each poll.
    const anchor = live ? state.observedPosition : state.position;
    const bearing = live ? state.observedBearing : state.bearing;

    if (!opts.skipPoints) {
      points.push({
        type: 'Feature',
        id: state.key,
        geometry: {
          type: 'Point',
          coordinates: offsetRight(anchor, bearing),
        },
        properties: {
          key: state.key,
          line: state.snapshot.line,
          bearing,
          modelId: state.model.id,
          selected: state.key === opts.selectedKey ? 1 : 0,
          favorite: opts.favoriteKeys.has(state.key) ? 1 : 0,
        },
      });
    }

    // Whole-tram cull by head position; the margin covers the longest possible
    // body + coupled trailer, so a partially-visible tram keeps all sections.
    if (!sectionsEnabled || !inBbox(anchor, cullBbox)) continue;

    const spec = opts.getSpec?.(state.key) ?? state.model;
    const geometry = state.hasGeometry ? opts.getGeometry(state.key) : undefined;
    const coupled = opts.coupledPairFn(state.key);
    if (geometry) {
      // Head anchor along the shape: sim distance, or in live mode the raw
      // fix's shape distance clamped to the geometry (same as the engine's
      // observedPosition — kept on the track).
      const sHead = live
        ? Math.min(Math.max(state.snapshot.shapeDistM, 0), geometry.totalM)
        : state.simDistM;
      sectionsAlongShape(state, spec, geometry, sHead, coupled, sections);
    } else {
      sectionsAtRawPosition(state, spec, anchor, bearing, coupled, sections);
    }
  }

  return {
    points: { type: 'FeatureCollection', features: points },
    sections: { type: 'FeatureCollection', features: sections },
    atMs: opts.nowMs ?? Date.now(),
  };
}
