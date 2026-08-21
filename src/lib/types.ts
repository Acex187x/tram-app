// Shared contracts for Tram Spotter. Single source of truth — every module
// (golemio client, physics, renderer, UI) imports from here. Keep pure types.

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

/**
 * Per-tram public state for UI (detail sheet, lists) and rendering.
 *
 * Physics v3: every field below is a PURE function of (snapshot, the server's
 * published curves, trip geometry, the server-corrected instant) — see
 * `src/lib/physics/adapter.ts`. Nothing here is integrated, remembered or
 * controller-derived, so two devices produce identical values for the same
 * bundle at the same wall-clock instant.
 */
export interface TramPublicState {
  key: string;
  snapshot: TramSnapshot;
  model: TramModelSpec;
  /** Rendered distance along shape in the ACTIVE render mode, m. */
  simDistM: number;
  /**
   * Rendered speed, km/h — the central finite difference of the rendered curve
   * over ±0.5 s. It is what the tram is drawn moving at, not a modelled pace.
   */
  simSpeedKmh: number;
  position: [number, number];
  bearing: number;
  phase: 'cruise' | 'dwell' | 'terminal' | 'unknown';
  /** Last REAL reported position (raw AVL fix), on-shape when geometry known. */
  observedPosition: [number, number];
  /** Bearing at the observed position (shape tangent; falls back to AVL bearing). */
  observedBearing: number;
  /**
   * |smooth − fixed| at this instant, meters — the distance between the
   * continuity curve and the model's raw opinion. THE comparison metric of the
   * two render modes. Null when the vehicle has no server trajectory.
   */
  deviationM: number | null;
  /**
   * The opinion («fixed» mode) curve's distance along shape, m — the partner
   * of `simDistM` for the smooth↔fixed comparison. Null without a trajectory.
   *
   * RAW: the served curve, with no client-side fix-forward correction applied
   * (unlike `simDistM`, which is what gets drawn). It is written as `projDist`
   * into every calibration/ride record and scored against the next fix as the
   * MODEL's error, so it has to stay the model's own answer.
   */
  fixedDistM: number | null;
  /**
   * True when the rendered position is FROZEN rather than animating: the
   * instant is past the curve's last keyframe, or the vehicle has no
   * trajectory at all and is standing on its last raw fix. The map dims these
   * trams — the client never animates beyond the data it was given.
   */
  pastHorizon: boolean;
  /** Next stop name + eta if geometry known (eta null past the horizon). */
  nextStopName: string | null;
  nextStopEtaS: number | null;
  hasGeometry: boolean;
}

/**
 * Additive, on-demand devtools view of ONE tram's physics inputs
 * (TramFleet.getDiagnostics — debug overlay only, 10 Hz, never the map frame
 * path). Diagnostics only; nothing here feeds rendering.
 *
 * Physics v3 replaced the old SimDebugInfo's ~30 controller internals (regimes,
 * pace bias, braking envelopes, stuck/yield holds) with the four things a
 * trajectory client can actually be wrong about: WHICH curve it is drawing,
 * HOW FAR APART the two curves are, HOW MUCH horizon is left, and HOW STALE
 * everything is. Distances are along-shape meters; speeds km/h.
 */
export interface PhysicsDebugInfo {
  /** False when the server published no usable curves for this tram. */
  hasTrajectory: boolean;
  hasGeometry: boolean;
  /** Curve being rendered right now. */
  mode: 'smooth' | 'fixed';

  // — the promotion pipeline (2026-08-21): WHAT is driving this marker —
  /**
   * The data actually moving the marker at this instant:
   *   'curve-ml'     server curve rendering ml-gbdt keyframes
   *   'curve-naive'  server curve rendering the learned-walker substitute
   *                  (ML outage + the old curve was provably overrun)
   *   'client-naive' NO curve — dead-reckoning from the last fix at the
   *                  observed pace (≤ NAIVE_HORIZON_S, dimmed)
   *   'raw-fix'      NO curve and no usable pace — frozen on the fix
   */
  renderSource: 'curve-ml' | 'curve-naive' | 'client-naive' | 'raw-fix';
  /** shapeDistM of the fix the served curve was predicted FROM (null = unsent). */
  anchorFixS: number | null;
  /**
   * fixAtMs − anchorMs, s: how many seconds of newer fixes the served curve
   * has NOT seen. THE freshness-race number — the fix-forward shim exists to
   * cover exactly this window, and it should collapse to ~0 within one
   * publish cycle (~2–4 s). Null without both stamps.
   */
  anchorLagS: number | null;
  /** Observed fix-over-fix pace, m/s (the client-naive fallback's speed). */
  observedPaceMs: number;

  // — the fix-forward shim state (the τ machinery) —
  /**
   * Which branch of the shim is active on the RENDERED track:
   *   'off'   no fix newer than the curve's anchor — curve rendered as served
   *   'ahead' newer fix exists but the curve is at/past it — left alone
   *   'wind'  finite τ: curve wound forward τ seconds onto the fix
   *   'walk'  τ = ∞: fix is past the whole curve; smooth walks toward it at
   *           the bounded rate (fixed jumps). THE branch of the
   *           «телепортируется за новый фикс и стоит» bug class.
   */
  shimBranch: 'off' | 'ahead' | 'wind' | 'walk';
  /** τ in seconds ('wind' branch); null when off/ahead; Infinity when 'walk'. */
  tauS: number | null;
  /** fixS − curve(fixAt), m, signed: how far the newest fix is ahead of the
   *  served curve at the fix instant (the raw gap the shim is closing). */
  fixVsCurveM: number | null;
  /** 'walk' branch only: meters still left to walk to reach the fix. */
  walkRemainingM: number | null;
  /**
   * The last TELEPORT of this tram's rendered marker (fleet.ts jump watch):
   * a frame-over-frame displacement no plausible motion explains. Signed
   * meters (negative = the marker flew BACKWARD) and how long ago. Null until
   * one happens. THE metric of the «телепортируется и стоит» bug class.
   */
  lastJumpM: number | null;
  lastJumpAgoS: number | null;
  /** Rendered distance in the active mode, m. */
  simDistM: number;
  /** Continuity-curve distance, m (null without a trajectory). */
  smoothDistM: number | null;
  /** Opinion-curve distance, m (null without a trajectory). */
  fixedDistM: number | null;
  /** smooth − fixed, SIGNED m (positive = smooth ahead). Null w/o both curves. */
  deltaM: number | null;
  /**
   * Meters the fix-forward shim is currently adding to the active curve
   * (src/lib/physics/fixForward.ts) — i.e. how far the SERVED curve is behind
   * the newest AVL fix the phone holds, after mode-dependent rate limiting.
   * 0 in the steady state; a persistently large value is the bundle trailing
   * the fix stream, which is the thing to report. Null without a trajectory.
   */
  fixForwardM: number | null;
  /** Rendered speed in the active mode, km/h. */
  simSpeedKmh: number;
  /** Smooth-curve speed, km/h — comparison partner (null w/o a smooth curve). */
  smoothSpeedKmh: number | null;
  phase: 'cruise' | 'dwell' | 'terminal' | 'unknown';
  /** True while the rendered position is frozen (past horizon / no curves). */
  pastHorizon: boolean;
  /** Seconds of curve left before the freeze (negative = already frozen). */
  horizonLeftS: number | null;
  /** Age of the AVL fix the curves were anchored to, s. */
  anchorAgeS: number | null;
  /** Age of this trajectory emission (the server's blend anchor), s. */
  emissionAgeS: number | null;
  /** Server flagged THIS emission as a sanctioned break in continuity. */
  discontinuity: boolean;
  /** Raw AVL fix distance along shape, m. */
  obsDistM: number;
  /** ms epoch of that fix. */
  obsAtMs: number;
  /** Age of the raw AVL fix, s (server-corrected clock). */
  fixAgeS: number;
  nextStopName: string | null;
  nextStopEtaS: number | null;
  /** Feed-reported schedule delay, seconds (+ late). */
  delaySeconds: number;
  /** Feed state string (on_track / at_stop / …). */
  statePosition: string;

  // — bundle-level context (same for every tram; carried here so the overlay
  //   reads one object) —
  /** Age of the newest trajectory bundle, s (null when none decoded). */
  bundleAgeS: number | null;
  /** Highest trajectory diff-stream seq folded (Convex transport; 0 = none). */
  feedSeq: number;
  /** What produced the newest bundle per its own field ('drive-v3', …). */
  serverGen: string | null;
  /** Smoothed server−device clock offset, ms. */
  clockOffsetMs: number;
  /** Connection verdict from bundle age + fetch health. */
  connection: 'live' | 'degraded' | 'offline';
  /** Cumulative server-flagged discontinuities observed this session. */
  discontinuitiesTotal: number;
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
  /**
   * 1 when this tram's rendered position is FROZEN (`TramPublicState`
   * .pastHorizon): the server's curve ran out, or none was published for it.
   * The map layers multiply their opacity by a dim factor on this flag — the
   * connection-honesty rule made visible per tram, so a frozen tram never
   * passes for a live one even while the rest of the fleet keeps moving.
   */
  stale: 0 | 1;
}

export interface SectionFeatureProps {
  key: string; // parent tram key
  modelKey: string; // GLB registry key, e.g. '15t-b'
  bearing: number;
  /** Frozen (past horizon) — the ModelLayer dims the whole body. See PointFeatureProps.stale. */
  stale: 0 | 1;
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
