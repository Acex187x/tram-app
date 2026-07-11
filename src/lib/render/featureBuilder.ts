// Engine states → GeoJSON render frame:
//  - points FC: ALL trams (circle/badge layers + hit testing)
//  - sections FC: articulated body sections, only for trams inside the viewport
//    (+300 m margin) at zoom >= 14.8 — drives the ModelLayer.
// Feature ids are stable per tram key / section index so Mapbox can diff frames.

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
/** Extra margin around the viewport bbox for section culling, meters. */
export const CULL_MARGIN_M = 300;
/** Second unit of a coupled T3 pair trails this far behind the first, meters. */
export const COUPLED_OFFSET_M = 14.5;

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
    geometry: { type: 'Point', coordinates: position },
    properties: { key, modelKey, bearing },
  };
}

/** Sections for a tram with known geometry: each body section placed along the shape. */
function sectionsAlongShape(
  state: TramPublicState,
  spec: TramModelSpec,
  geometry: RouteGeometry,
  coupled: boolean,
): SectionFeature[] {
  const { coordinates, cumDistM } = geometry;
  const sHead = state.simDistM;
  const out: SectionFeature[] = [];
  let precedingLengths = 0;
  for (let i = 0; i < spec.sections.length; i++) {
    const section = spec.sections[i];
    const centerDist = Math.max(
      0,
      sHead - (precedingLengths + i * spec.jointGapM) - section.lengthM / 2,
    );
    out.push(
      sectionFeature(
        `${state.key}#${i}`,
        state.key,
        section.modelKey,
        pointAt(coordinates, cumDistM, centerDist),
        bearingAt(coordinates, cumDistM, centerDist),
      ),
    );
    if (coupled) {
      const trailDist = Math.max(0, centerDist - COUPLED_OFFSET_M);
      out.push(
        sectionFeature(
          `${state.key}#c${i}`,
          state.key,
          section.modelKey,
          pointAt(coordinates, cumDistM, trailDist),
          bearingAt(coordinates, cumDistM, trailDist),
        ),
      );
    }
    precedingLengths += section.lengthM;
  }
  return out;
}

/** Fallback for trams without geometry: single section at the raw API position. */
function sectionsAtRawPosition(
  state: TramPublicState,
  spec: TramModelSpec,
  coupled: boolean,
): SectionFeature[] {
  const modelKey = spec.sections.length > 0 ? spec.sections[0].modelKey : spec.id;
  const out: SectionFeature[] = [
    sectionFeature(`${state.key}#0`, state.key, modelKey, state.position, state.bearing),
  ];
  if (coupled) {
    out.push(
      sectionFeature(
        `${state.key}#c0`,
        state.key,
        modelKey,
        destinationPoint(state.position, (state.bearing + 180) % 360, COUPLED_OFFSET_M),
        state.bearing,
      ),
    );
  }
  return out;
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

  for (const state of states) {
    points.push({
      type: 'Feature',
      id: state.key,
      geometry: { type: 'Point', coordinates: state.position },
      properties: {
        key: state.key,
        line: state.snapshot.line,
        bearing: state.bearing,
        modelId: state.model.id,
        selected: state.key === opts.selectedKey ? 1 : 0,
        favorite: opts.favoriteKeys.has(state.key) ? 1 : 0,
      },
    });

    if (!sectionsEnabled || !inBbox(state.position, cullBbox)) continue;

    const spec = opts.getSpec?.(state.key) ?? state.model;
    const geometry = state.hasGeometry ? opts.getGeometry(state.key) : undefined;
    const coupled = opts.coupledPairFn(state.key);
    if (geometry) {
      sections.push(...sectionsAlongShape(state, spec, geometry, coupled));
    } else {
      sections.push(...sectionsAtRawPosition(state, spec, coupled));
    }
  }

  return {
    points: { type: 'FeatureCollection', features: points },
    sections: { type: 'FeatureCollection', features: sections },
    atMs: opts.nowMs ?? Date.now(),
  };
}
