// Raw Golemio wire types for the endpoints the data layer consumes.
// Transcribed from the live production API (verified 2026-07-11 with curl).
// These describe the JSON exactly as it arrives — normalization into the app's
// domain types (TramSnapshot, RouteGeometry, …) happens in vehicles.ts / gtfs.ts.

// ── /v2/vehiclepositions ─────────────────────────────────────────────────────

export interface VpFeatureCollection {
  type: 'FeatureCollection';
  features: VpFeature[];
}

export interface VpFeature {
  type: 'Feature';
  geometry: VpPointGeometry;
  properties: VpProperties;
}

export interface VpPointGeometry {
  type: 'Point';
  /** [lng, lat] */
  coordinates: [number, number];
}

export interface VpProperties {
  last_position: VpLastPosition;
  trip: VpTrip;
}

export interface VpLastPosition {
  bearing: number | null;
  delay: VpDelay | null;
  is_canceled: boolean | null;
  last_stop: VpStopRef | null;
  next_stop: VpStopRef | null;
  /** ISO 8601 with offset, e.g. "2026-07-11T13:29:31+02:00" — the AVL fix time. */
  origin_timestamp: string | null;
  /** STRING in KILOMETERS on this endpoint (e.g. "5.871"). */
  shape_dist_traveled: string | null;
  /** Always null in practice — DPP does not populate live speed. */
  speed: number | null;
  state_position: string;
  tracking: boolean;
}

export interface VpDelay {
  /** Seconds; negative = early. */
  actual: number | null;
  last_stop_arrival: number | null;
  last_stop_departure: number | null;
}

export interface VpStopRef {
  /** ISO 8601 with offset (scheduled). */
  arrival_time: string | null;
  departure_time: string | null;
  /** GTFS stop_id, e.g. "U893Z1P". */
  id: string;
  /** 1-based position in the trip's stop sequence. */
  sequence: number;
}

export interface VpTrip {
  agency_name: { real: string | null; scheduled: string | null };
  cis: { line_id: number | null; trip_number: number | null };
  gtfs: VpGtfs;
  origin_route_name: string | null;
  sequence_id: number | null;
  start_timestamp: string | null;
  /** DPP fleet ("evidenční") number; null for non-DPP vehicles. */
  vehicle_registration_number: number | null;
  vehicle_type: VpVehicleType | null;
  wheelchair_accessible: boolean | null;
  air_conditioned: boolean | null;
  usb_chargers: boolean | null;
}

export interface VpGtfs {
  route_id: string; // "L1"
  route_short_name: string; // "1"
  /** Extended GTFS route type; 0 === tram. */
  route_type: number;
  trip_headsign: string;
  trip_id: string; // "1_14863_260627"
  trip_short_name: string | null;
}

export interface VpVehicleType {
  description_cs: string | null;
  description_en: string | null;
  id: number | null;
}

// ── /v2/gtfs/routes ──────────────────────────────────────────────────────────

export interface GtfsRoute {
  agency_id: string;
  is_night: boolean;
  route_color: string | null;
  route_desc: string | null;
  route_id: string; // "L1"
  route_long_name: string | null;
  route_short_name: string; // "1"
  route_text_color: string | null;
  route_type: number; // 0 === tram
  route_url: string | null;
  is_regional: boolean;
  is_substitute_transport: boolean;
}

// ── /v2/gtfs/trips/{id}?includeShapes&includeStopTimes&includeStops ───────────

export interface GtfsTripDetail {
  route_id: string; // "L17"
  service_id: string;
  shape_id: string; // "L17V13"
  trip_headsign: string;
  trip_id: string;
  direction_id: number | null;
  wheelchair_accessible: number | null;
  bikes_allowed: number | null;
  /** Present when includeShapes=true. GeoJSON Point features. */
  shapes?: GtfsShapePoint[];
  /** Present when includeStopTimes=true. Each carries a nested `stop` when
   *  includeStops=true. */
  stop_times?: GtfsStopTime[];
}

export interface GtfsShapePoint {
  type: 'Feature';
  geometry: VpPointGeometry;
  properties: {
    /** NUMERIC kilometers on this endpoint. */
    shape_dist_traveled: number;
    shape_id: string;
    shape_pt_sequence: number;
  };
}

export interface GtfsStopTime {
  /** GTFS clock "HH:MM:SS"; hours may exceed 24 for after-midnight service. */
  arrival_time: string;
  departure_time: string;
  drop_off_type: string;
  pickup_type: string;
  /** NUMERIC kilometers; may be null on some feeds. */
  shape_dist_traveled: number | null;
  stop_headsign: string | null;
  stop_id: string;
  stop_sequence: number;
  trip_id: string;
  computed_dwell_time_seconds: number | null;
  headsign_icons: string | null;
  stop_icons: string | null;
  /** Present when includeStops=true. */
  stop?: GtfsStopFeature;
}

export interface GtfsStopFeature {
  type: 'Feature';
  geometry: VpPointGeometry;
  properties: {
    location_type: number;
    parent_station: string | null;
    platform_code: string | null;
    stop_id: string;
    stop_name: string;
    wheelchair_boarding: number | null;
    zone_id: string | null;
    level_id: string | null;
  };
}
