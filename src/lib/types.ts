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
  /** Doors-open GLB variant key (rendered while dwelling), when authored. */
  openModelKey?: string;
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
  /** Last REAL reported position (raw AVL fix), on-shape when geometry known. */
  observedPosition: [number, number];
  /** Bearing at the observed position (shape tangent; falls back to AVL bearing). */
  observedBearing: number;
  /** Distance between simulated and observed positions, meters (null w/o geometry). */
  deviationM: number | null;
  /**
   * Last observation dead-reckoned forward to `now` by the physics engine
   * (anchored strictly to the fix — jumps when a new fix arrives). Along-shape
   * meters; null without geometry. Drives 'live' position mode rendering.
   */
  projectedObservedDistM: number | null;
  /** Next stop name + eta if geometry known. */
  nextStopName: string | null;
  nextStopEtaS: number | null;
  hasGeometry: boolean;
  /**
   * Learned per-tram pace multiplier (recency-weighted EWMA of real vs
   * profile-expected inter-fix speed; 1 = profile pace). Undefined without a
   * sim (no geometry). Optional/additive — telemetry + diagnostics only.
   */
  paceBias?: number;
}

export interface PointFeatureProps {
  key: string;
  line: string;
  bearing: number;
  modelId: TramModelId;
  selected: 0 | 1;
  favorite: 0 | 1;
  /**
   * 1 when the tram has no loaded shape yet (trip just changed / geometry
   * streaming in). Such a tram renders as a plain un-oriented dot at its raw
   * GPS position — no 3D body, no bearing-rotated teardrop, no track offset —
   * a brief transient until the shape loads. The dot layer keys off this so the
   * tram stays visible (and tappable) even in the 3D zoom band.
   */
  geometryless: 0 | 1;
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
  /**
   * Band-2 badge declutter (additive, optional): DISPLACED face-badge anchor
   * Points (props: key/line/modelId/displaced) plus leader LineStrings from a
   * displaced badge back to its true marker. Empty outside the badge zoom
   * band / on skipPoints frames. Pinned (selected/followed/favorite) badges
   * are absent — the map draws them from the points FC, never displaced.
   */
  badges?: GeoJSON.FeatureCollection;
  /**
   * Last-real-fix visualization for the SELECTED/followed tram: the raw fix
   * point + a connector line to the rendered position (empty when none).
   */
  fixOverlay: GeoJSON.FeatureCollection;
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
