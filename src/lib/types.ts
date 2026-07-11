// Shared contracts for Tram Spotter. Single source of truth — every module
// (golemio client, engine, renderer, UI) imports from here. Keep pure types.

/** Tram model families in active Prague service (+ historic fallback). */
export type TramModelId = 't3' | 't3rp' | 't3rplf' | 'kt8d5' | '14t' | '15t' | '52t';

/** One articulated body section of a physical tram model. */
export interface TramSection {
  /** GLB model key registered with Mapbox <Models>, e.g. '15t-a'. */
  modelKey: string;
  /** Section body length in meters (along track). */
  lengthM: number;
}

export interface TramModelSpec {
  id: TramModelId;
  /** Human name, e.g. 'Škoda 15T ForCity Alfa'. */
  name: string;
  manufacturer: string;
  yearsBuilt: string;
  /** Ordered head → tail. Rigid cars have exactly one section. */
  sections: TramSection[];
  /** Gap between consecutive section centers beyond their body lengths (m). */
  jointGapM: number;
  totalLengthM: number;
  widthM: number;
  heightM: number;
  maxSpeedKmh: number;
  lowFloor: boolean;
  /** Whether this type commonly runs as a coupled two-car set on day lines. */
  runsCoupled: boolean;
  funFact: string;
}

// ── Golemio-derived runtime data ─────────────────────────────────────────────

/** Normalized live observation of one tram from /v2/vehiclepositions. */
export interface TramSnapshot {
  /** Stable entity key: registration number as string, fallback trip id. */
  key: string;
  registrationNumber: number | null;
  tripId: string;
  routeId: string; // 'L9'
  /** Line number as displayed, e.g. '9', '17', '91'. */
  line: string;
  headsign: string;
  /** Distance along shape in METERS (API km string → m). */
  shapeDistM: number;
  /** Unix ms of the observation (origin_timestamp). */
  observedAtMs: number;
  coordinates: [number, number]; // [lng, lat] raw API point
  bearing: number | null;
  delaySeconds: number;
  statePosition: string; // 'on_track' | 'at_stop' | ...
  lastStopId: string | null;
  lastStopSequence: number | null;
  nextStopId: string | null;
  nextStopSequence: number | null;
  nextStopArrivalMs: number | null;
  wheelchairAccessible: boolean;
  airConditioned: boolean | null;
  usbChargers: boolean | null;
  isCanceled: boolean;
}

/** A stop projected onto a route shape. */
export interface RouteStop {
  stopId: string;
  name: string;
  sequence: number;
  coordinates: [number, number];
  /** Distance along shape, meters. */
  distM: number;
  /** Scheduled times as ms since epoch for the trip's service day. */
  arrivalMs: number;
  departureMs: number;
  /** Golemio computed_dwell_time_seconds (0 if absent). */
  dwellSeconds: number;
  isTerminal: boolean;
}

/** Geometry + timetable for one trip, built from GTFS trip detail. */
export interface RouteGeometry {
  shapeId: string;
  tripId: string;
  routeId: string;
  line: string;
  headsign: string;
  /** Shape polyline [lng, lat][] */
  coordinates: [number, number][];
  /** Cumulative distance in meters per vertex (same length as coordinates). */
  cumDistM: number[];
  /** Total length, meters. */
  totalM: number;
  stops: RouteStop[];
}

// ── Engine output (render frame) ─────────────────────────────────────────────

export type ZoomMode = 1 | 2 | 3 | 4;

/** Per-tram public state for UI (detail sheet, lists). */
export interface TramPublicState {
  key: string;
  snapshot: TramSnapshot;
  model: TramModelSpec;
  /** Simulated distance along shape, m. */
  simDistM: number;
  /** Simulated speed, km/h. */
  simSpeedKmh: number;
  position: [number, number];
  bearing: number;
  phase: 'cruise' | 'dwell' | 'terminal' | 'unknown';
  /** Next stop name + eta if geometry known. */
  nextStopName: string | null;
  nextStopEtaS: number | null;
  hasGeometry: boolean;
}

export interface PointFeatureProps {
  key: string;
  line: string;
  bearing: number;
  modelId: TramModelId;
  selected: 0 | 1;
  favorite: 0 | 1;
}

export interface SectionFeatureProps {
  key: string; // parent tram key
  modelKey: string; // GLB registry key, e.g. '15t-b'
  bearing: number;
}

export interface EngineFrame {
  /** One feature per tram — drives circle/badge layers + hit testing. */
  points: GeoJSON.FeatureCollection<GeoJSON.Point, PointFeatureProps>;
  /** One feature per visible tram section — drives the ModelLayer. */
  sections: GeoJSON.FeatureCollection<GeoJSON.Point, SectionFeatureProps>;
  /** ms timestamp of the frame. */
  atMs: number;
}

export interface Viewport {
  /** [west, south, east, north] with margin already applied. */
  bbox: [number, number, number, number];
  zoom: number;
}

// ── Planner ──────────────────────────────────────────────────────────────────

export interface PlannerLeg {
  line: string;
  fromStopId: string;
  fromStopName: string;
  toStopId: string;
  toStopName: string;
  stopCount: number;
  /** Polyline slice for drawing, [lng,lat][] (may be empty if shape unknown). */
  coordinates: [number, number][];
}

export interface PlannerItinerary {
  legs: PlannerLeg[];
  transferCount: number;
  totalStops: number;
}
