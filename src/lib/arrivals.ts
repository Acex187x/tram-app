// Live arrivals board + itinerary timing — pure helpers over the runtime's
// public tram states and the loaded route geometries. No React, no IO:
// everything takes (states, geometries, nowMs) so it is unit-testable and can
// be recomputed every ~1 Hz UI tick.
//
// Stations are keyed by normalizeName(stop name) — the same grouping the
// planner network uses, so /stop/[key] params interoperate with planner stops.

import { normalizeName } from '@/lib/planner/network';
import type {
  PlannerItinerary,
  PlannerLeg,
  RouteGeometry,
  TramModelSpec,
  TramPublicState,
  TramSnapshot,
} from '@/lib/types';

/** Max arrivals returned for a station board. */
export const MAX_ARRIVALS = 12;

/**
 * FALLBACK slack (m) for deciding a stop is still ahead of a tram, used ONLY
 * when the feed gives no stop-sequence cursor (see stopCursorSequence).
 *
 * This was 2 m, on the stated grounds that it "matches the engine's 2 m dwell
 * tolerance" — a tolerance that does not exist (the engine's is
 * DWELL_NEAR_STOP_M = 30, physics/adapter.ts). The number it gates,
 * `simDistM`, is a PREDICTION whose published error the lab measures at
 * meanAbs ≈ 123 m / p90 ≈ 197 m, and which runs AHEAD of the tram's true
 * position in ~55 % of samples. A 2 m tolerance on a ±200 m quantity silently
 * deleted trams standing at the platform. 30 m at least matches the engine.
 */
const STOP_SLACK_M = 30;

/**
 * The lowest stop `sequence` a tram may still be counted as arriving at, taken
 * from the OPERATOR's own cursor rather than from our physics.
 *
 * Golemio reports `last_stop.sequence` / `next_stop.sequence` on every fix, and
 * they index the exact same numbering as `RouteGeometry.stops[].sequence`
 * (verified against the live fleet: 35/35 stopId agreement on both fields).
 * That cursor is ground truth for "which stops has this vehicle not served
 * yet", so it — not a noisy predicted distance — is what decides whether a
 * station is still ahead.
 *
 * `at_stop` means the vehicle is standing AT `last_stop`, which must still
 * count as an arrival (it is the "now" row on the board), hence the −1 there.
 * Returns null when the feed omits both fields; callers then fall back to the
 * distance gate.
 */
export function stopCursorSequence(
  snapshot: Pick<
    TramSnapshot,
    'statePosition' | 'lastStopSequence' | 'nextStopSequence'
  >,
): number | null {
  const last = snapshot.lastStopSequence;
  const next = snapshot.nextStopSequence;
  if (snapshot.statePosition === 'at_stop' && typeof last === 'number') return last;
  if (typeof next === 'number') return next;
  if (typeof last === 'number') return last + 1;
  return null;
}

// ── Station lookup ────────────────────────────────────────────────────────────

export interface StationInfo {
  /** Normalized station key (normalizeName of the stop name). */
  key: string;
  /** Display name (first-seen spelling). */
  name: string;
  /** Representative coordinate (first platform seen). */
  coordinates: [number, number];
  /** Lines serving this station, sorted numerically. */
  lines: string[];
}

/**
 * Group every stop named like `key` across the loaded geometries into one
 * station: display name, representative coordinates and the set of lines
 * serving it. Returns null when no loaded geometry mentions the station.
 */
export function stationStops(key: string, geometries: RouteGeometry[]): StationInfo | null {
  let name: string | null = null;
  let coordinates: [number, number] | null = null;
  const lines = new Set<string>();

  for (const geo of geometries) {
    for (const stop of geo.stops) {
      if (normalizeName(stop.name) !== key) continue;
      if (name === null) {
        name = stop.name;
        coordinates = stop.coordinates;
      }
      lines.add(geo.line);
    }
  }

  if (name === null || coordinates === null) return null;
  return { key, name, coordinates, lines: sortLines(lines) };
}

function sortLines(lines: Iterable<string>): string[] {
  return [...lines].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/**
 * Nearest station to a coordinate over the loaded geometries. Stations are
 * grouped by normalized name (all platforms of a name share one station, using
 * the first-seen platform coordinate as the representative). Great-circle
 * distance; returns null when no geometry is loaded.
 */
export function nearestStation(
  coords: [number, number],
  geometries: RouteGeometry[],
): StationInfo | null {
  // Group platforms into stations once, tracking a representative coordinate
  // and the serving lines, exactly like stationStops does for a single key.
  const byKey = new Map<
    string,
    { name: string; coordinates: [number, number]; lines: Set<string> }
  >();
  for (const geo of geometries) {
    for (const stop of geo.stops) {
      const key = normalizeName(stop.name);
      let station = byKey.get(key);
      if (!station) {
        station = { name: stop.name, coordinates: stop.coordinates, lines: new Set() };
        byKey.set(key, station);
      }
      station.lines.add(geo.line);
    }
  }

  let bestKey: string | null = null;
  let bestDist = Infinity;
  for (const [key, station] of byKey) {
    const d = haversineM(coords, station.coordinates);
    if (d < bestDist) {
      bestDist = d;
      bestKey = key;
    }
  }
  if (bestKey === null) return null;
  const best = byKey.get(bestKey)!;
  return { key: bestKey, name: best.name, coordinates: best.coordinates, lines: sortLines(best.lines) };
}

/** Great-circle distance in meters between two [lng, lat] points. */
export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8; // mean Earth radius (matches polyline.ts)
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Walking (planner access / egress) ────────────────────────────────────────
//
// Straight-line distances are optimistic: streets zig-zag, crossings wait.
// A detour factor over the great-circle distance at a steady pedestrian pace
// is the standard planner approximation.

/** Average pedestrian speed, meters per second. */
export const WALK_SPEED_MPS = 1.35;
/** Street-network detour factor over the great-circle distance. */
export const WALK_DETOUR_FACTOR = 1.3;
/** Safety buffer subtracted on top of the walk when computing leave-by. */
export const LEAVE_BUFFER_MS = 60_000;

/** Estimated walking seconds to cover `distM` great-circle meters. */
export function walkSecondsForMeters(distM: number): number {
  if (!Number.isFinite(distM) || distM <= 0) return 0;
  return (distM * WALK_DETOUR_FACTOR) / WALK_SPEED_MPS;
}

/** Estimated walking seconds between two [lng, lat] points. */
export function walkSecondsBetween(a: [number, number], b: [number, number]): number {
  return walkSecondsForMeters(haversineM(a, b));
}

/**
 * When to leave for a departure: departure minus the walk minus a 1-minute
 * buffer. May be in the past (render as "leave now").
 */
export function computeLeaveByMs(departureMs: number, walkS: number): number {
  return departureMs - Math.round(walkS * 1000) - LEAVE_BUFFER_MS;
}

/**
 * Walking seconds from the user's location to an itinerary's boarding point
 * (the first leg's first shape coordinate — the actual platform, not the
 * station's representative coordinate). Null when the leg has no shape yet.
 */
export function itineraryAccessWalkS(
  userCoords: [number, number],
  itinerary: PlannerItinerary,
): number | null {
  const boarding = itinerary.legs[0]?.coordinates[0];
  if (!boarding) return null;
  return walkSecondsBetween(userCoords, boarding);
}

/**
 * Walking seconds from an itinerary's alighting point (last leg's last shape
 * coordinate) to a final destination that is NOT the stop itself. Null when
 * the leg has no shape yet.
 */
export function itineraryEgressWalkS(
  destCoords: [number, number],
  itinerary: PlannerItinerary,
): number | null {
  const coords = itinerary.legs[itinerary.legs.length - 1]?.coordinates;
  const alighting = coords && coords.length > 0 ? coords[coords.length - 1] : undefined;
  if (!alighting) return null;
  return walkSecondsBetween(alighting, destCoords);
}

// ── Arrivals board ───────────────────────────────────────────────────────────

export interface StopArrival {
  /** Entity key of the tram (registration number string / trip-id fallback). */
  tramKey: string;
  line: string;
  headsign: string;
  /** Seconds until the tram reaches this station (schedule + delay − now, ≥ 0). */
  etaS: number;
  /**
   * Position-based ETA (s): remaining SCHEDULED run time from the tram's live
   * simulated position to the platform (see positionEtaS). Unlike `etaS` it
   * cannot go stale with the feed delay and never clamps to 0 while the tram
   * is still physically short of the stop. Falls back to `etaS` when the trip
   * has no usable stop list. The spotter ranks by this; the board keeps `etaS`.
   */
  liveEtaS: number;
  model: TramModelSpec;
  airConditioned: boolean | null;
  regNumber: number | null;
}

/**
 * Upcoming arrivals at a station: every live tram whose remaining stops (per
 * its own trip geometry, after its simulated distance) include a stop of this
 * station. ETA = that stop's scheduled arrival shifted by the tram's live
 * delay, relative to `nowMs`, floored at 0. Sorted soonest-first, capped at
 * MAX_ARRIVALS.
 */
export function computeArrivals(
  key: string,
  states: TramPublicState[],
  geometries: RouteGeometry[],
  nowMs: number,
): StopArrival[] {
  const byTrip = geometriesByTrip(geometries);
  const out: StopArrival[] = [];

  for (const state of states) {
    if (state.snapshot.isCanceled) continue;
    const geo = byTrip.get(state.snapshot.tripId);
    if (!geo) continue;

    const stop = nextStationStop(
      geo,
      key,
      state.simDistM,
      stopCursorSequence(state.snapshot),
    );
    if (!stop) continue;

    const arrivalMs = stop.arrivalMs + state.snapshot.delaySeconds * 1000;
    const etaS = Math.max(0, Math.floor((arrivalMs - nowMs) / 1000));
    out.push({
      tramKey: state.key,
      line: state.snapshot.line,
      headsign: state.snapshot.headsign,
      etaS,
      liveEtaS: positionEtaS(geo, stop.distM, stop.arrivalMs, state.simDistM) ?? etaS,
      model: state.model,
      airConditioned: state.snapshot.airConditioned,
      regNumber: state.snapshot.registrationNumber,
    });
  }

  out.sort((a, b) => a.etaS - b.etaS || a.tramKey.localeCompare(b.tramKey));
  return out.slice(0, MAX_ARRIVALS);
}

function geometriesByTrip(geometries: RouteGeometry[]): Map<string, RouteGeometry> {
  const m = new Map<string, RouteGeometry>();
  for (const g of geometries) m.set(g.tripId, g);
  return m;
}

/**
 * First stop of station `key` still ahead of a tram. Exported for the spotter
 * (src/lib/spotter.ts), which anchors its departed-detector on the matched
 * platform's shape distance.
 *
 * `minSequence` is the operator's stop cursor (stopCursorSequence). When it is
 * available it is the ONLY gate: it is exact, monotonic, and — unlike the
 * predicted `simDistM` — cannot hide a tram that is standing at the platform.
 * Without it we fall back to the distance gate.
 */
export function nextStationStop(
  geo: RouteGeometry,
  key: string,
  simDistM: number,
  minSequence: number | null = null,
) {
  for (const stop of geo.stops) {
    if (minSequence !== null) {
      if (stop.sequence < minSequence) continue;
    } else if (stop.distM < simDistM - STOP_SLACK_M) continue;
    if (normalizeName(stop.name) === key) return stop;
  }
  return null;
}

/**
 * Position-based ETA in whole seconds to a platform ahead: the remaining
 * SCHEDULED run time from the tram's live simulated shape distance to the
 * platform (scheduled clock at the platform minus the interpolated scheduled
 * clock at `simDistM`, including scheduled dwells at intermediate stops).
 *
 * The feed delay is deliberately NOT used: it is already baked into where the
 * tram physically is, and the raw `delaySeconds` lags (per-fix / per-stop
 * updates), which lets the schedule ETA clamp to 0 while the tram is still
 * hundreds of meters short of the stop. A tram at/past the platform (within
 * the board's STOP_SLACK_M) reads 0. Returns null only when the trip has no
 * stop list to interpolate against.
 */
export function positionEtaS(
  geo: RouteGeometry,
  stopDistM: number,
  stopArrivalMs: number,
  simDistM: number,
): number | null {
  if (simDistM >= stopDistM - STOP_SLACK_M) return 0;
  const nowSchedMs = scheduleTimeAtDistMs(geo, simDistM);
  if (nowSchedMs === null) return null;
  return Math.max(0, Math.round((stopArrivalMs - nowSchedMs) / 1000));
}

/**
 * Interpolated scheduled clock (ms epoch) for a shape distance along a trip:
 * piecewise-linear between each stop's departure and the next stop's arrival.
 * Clamped to the first stop's departure / last stop's arrival outside the
 * stop span. Null when the trip has no stops.
 */
function scheduleTimeAtDistMs(geo: RouteGeometry, distM: number): number | null {
  const stops = geo.stops;
  if (stops.length === 0) return null;
  if (distM <= stops[0].distM) return stops[0].departureMs;
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (distM > b.distM) continue;
    const span = b.distM - a.distM;
    const f = span > 0 ? (distM - a.distM) / span : 1;
    return a.departureMs + f * (b.arrivalMs - a.departureMs);
  }
  return stops[stops.length - 1].arrivalMs;
}

// ── Itinerary timing (planner) ───────────────────────────────────────────────

export interface LegTram {
  key: string;
  regNumber: number | null;
  model: TramModelSpec;
  airConditioned: boolean | null;
}

export interface LegTiming {
  /** The specific next live tram serving this leg, or null (schedule-only). */
  tram: LegTram | null;
  /** Wall-clock departure from the leg's from-stop (ms epoch), if live. */
  departureMs: number | null;
  /** Wall-clock arrival at the leg's to-stop (ms epoch), if live. */
  arrivalMs: number | null;
  /** Scheduled ride duration in seconds (available even without a live tram). */
  travelS: number | null;
}

export interface ItineraryTiming {
  legs: LegTiming[];
  /** Departure of the first leg / arrival of the last, when live. */
  departureMs: number | null;
  arrivalMs: number | null;
}

export interface ItineraryTimingOpts {
  /**
   * Realistic catchability floor for the FIRST leg's departure — typically
   * `nowMs + access-walk seconds × 1000`. Trams leaving the boarding stop
   * before the user can physically reach it are skipped.
   */
  earliestDepartureMs?: number;
}

/**
 * Live wall-clock timing for a planned itinerary. For each leg, find the next
 * real tram on the leg's line that will still call at the from-stop (after the
 * previous leg's arrival, for transfers); departure = its delay-shifted
 * schedule time at the from-stop, arrival = departure + scheduled travel time
 * between the two stops along that tram's own geometry. When no live tram is
 * found the leg falls back to schedule-only (travelS from any matching line
 * sequence) and the chain of wall times stops.
 */
export function computeItineraryTiming(
  legs: PlannerLeg[],
  states: TramPublicState[],
  geometries: RouteGeometry[],
  nowMs: number,
  opts?: ItineraryTimingOpts,
): ItineraryTiming {
  const byTrip = geometriesByTrip(geometries);
  const out: LegTiming[] = [];
  let earliestMs: number | null = Math.max(nowMs, opts?.earliestDepartureMs ?? nowMs);

  for (const leg of legs) {
    const fromKey = normalizeName(leg.fromStopName);
    const toKey = normalizeName(leg.toStopName);
    const travelS = scheduleTravelS(leg.line, fromKey, toKey, geometries);

    let best: { tram: LegTram; departureMs: number; arrivalMs: number } | null = null;
    if (earliestMs !== null) {
      for (const state of states) {
        if (state.snapshot.line !== leg.line || state.snapshot.isCanceled) continue;
        const geo = byTrip.get(state.snapshot.tripId);
        if (!geo) continue;

        const ride = rideWindow(
          geo,
          fromKey,
          toKey,
          state.simDistM,
          stopCursorSequence(state.snapshot),
        );
        if (!ride) continue;

        const delayMs = state.snapshot.delaySeconds * 1000;
        // A tram can't leave in the past: floor its departure at "now".
        const departureMs = Math.max(ride.departureMs + delayMs, nowMs);
        if (departureMs < earliestMs) continue; // gone before we get there
        const arrivalMs = departureMs + ride.travelMs;
        if (best && departureMs >= best.departureMs) continue;
        best = {
          departureMs,
          arrivalMs,
          tram: {
            key: state.key,
            regNumber: state.snapshot.registrationNumber,
            model: state.model,
            airConditioned: state.snapshot.airConditioned,
          },
        };
      }
    }

    if (best) {
      out.push({ tram: best.tram, departureMs: best.departureMs, arrivalMs: best.arrivalMs, travelS });
      earliestMs = best.arrivalMs;
    } else {
      out.push({ tram: null, departureMs: null, arrivalMs: null, travelS });
      earliestMs = null; // can't chain wall times past an unknown wait
    }
  }

  return {
    legs: out,
    departureMs: out.length > 0 ? out[0].departureMs : null,
    arrivalMs: out.length > 0 ? out[out.length - 1].arrivalMs : null,
  };
}

/**
 * The tram's remaining ride from station `fromKey` to station `toKey` on its
 * own geometry: schedule departure at from + scheduled travel, or null when
 * the tram has already passed the from-stop (or never calls at either).
 */
function rideWindow(
  geo: RouteGeometry,
  fromKey: string,
  toKey: string,
  simDistM: number,
  minSequence: number | null = null,
): { departureMs: number; travelMs: number } | null {
  let fromIdx = -1;
  for (let i = 0; i < geo.stops.length; i++) {
    const stop = geo.stops[i];
    if (fromIdx < 0) {
      if (
        minSequence !== null
          ? stop.sequence < minSequence
          : stop.distM < simDistM - STOP_SLACK_M
      ) continue;
      if (normalizeName(stop.name) === fromKey) fromIdx = i;
    } else if (normalizeName(stop.name) === toKey) {
      const from = geo.stops[fromIdx];
      return {
        departureMs: from.departureMs,
        travelMs: Math.max(0, stop.arrivalMs - from.departureMs),
      };
    }
  }
  return null;
}

/**
 * Scheduled travel seconds between two stations along a line, from any loaded
 * sequence of that line that visits from → to in order (minimum across
 * variants). Null when no loaded geometry connects them.
 */
export function scheduleTravelS(
  line: string,
  fromKey: string,
  toKey: string,
  geometries: RouteGeometry[],
): number | null {
  let best: number | null = null;
  for (const geo of geometries) {
    if (geo.line !== line) continue;
    let from: RouteGeometry['stops'][number] | null = null;
    for (const stop of geo.stops) {
      const k = normalizeName(stop.name);
      if (from === null) {
        if (k === fromKey) from = stop;
      } else if (k === toKey) {
        const s = Math.max(0, Math.round((stop.arrivalMs - from.departureMs) / 1000));
        if (best === null || s < best) best = s;
        break;
      }
    }
  }
  return best;
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** '2 min' / 'now' formatting for a big arrivals-board ETA. */
export function formatEtaMinutes(etaS: number): string {
  if (etaS < 45) return 'now';
  return `${Math.max(1, Math.round(etaS / 60))} min`;
}

/**
 * Relative departure countdown for an itinerary — 'in N min' / 'now'. Takes the
 * signed millisecond gap (departureMs − nowMs); already-departed or imminent
 * (< 30 s) reads 'now'. Recompute at 1 Hz against a live `nowMs`.
 */
export function formatCountdown(deltaMs: number): string {
  if (deltaMs < 30_000) return 'now';
  return `in ${Math.max(1, Math.round(deltaMs / 60_000))} min`;
}
