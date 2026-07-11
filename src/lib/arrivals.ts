// Live arrivals board + itinerary timing — pure helpers over the runtime's
// public tram states and the loaded route geometries. No React, no IO:
// everything takes (states, geometries, nowMs) so it is unit-testable and can
// be recomputed every ~1 Hz UI tick.
//
// Stations are keyed by normalizeName(stop name) — the same grouping the
// planner network uses, so /stop/[key] params interoperate with planner stops.

import { normalizeName } from '@/lib/planner/network';
import type {
  PlannerLeg,
  RouteGeometry,
  TramModelSpec,
  TramPublicState,
} from '@/lib/types';

/** Max arrivals returned for a station board. */
export const MAX_ARRIVALS = 12;

/** A tram is considered still "approaching" a stop within this slack (m) —
 *  matches the engine's 2 m dwell tolerance so a tram dwelling AT the stop
 *  still shows on the board as "now". */
const STOP_SLACK_M = 2;

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

// ── Arrivals board ───────────────────────────────────────────────────────────

export interface StopArrival {
  /** Entity key of the tram (registration number string / trip-id fallback). */
  tramKey: string;
  line: string;
  headsign: string;
  /** Seconds until the tram reaches this station (schedule + delay − now, ≥ 0). */
  etaS: number;
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

    const stop = nextStationStop(geo, key, state.simDistM);
    if (!stop) continue;

    const arrivalMs = stop.arrivalMs + state.snapshot.delaySeconds * 1000;
    out.push({
      tramKey: state.key,
      line: state.snapshot.line,
      headsign: state.snapshot.headsign,
      etaS: Math.max(0, Math.floor((arrivalMs - nowMs) / 1000)),
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

/** First stop of station `key` still ahead of a tram at `simDistM`. */
function nextStationStop(geo: RouteGeometry, key: string, simDistM: number) {
  for (const stop of geo.stops) {
    if (stop.distM < simDistM - STOP_SLACK_M) continue;
    if (normalizeName(stop.name) === key) return stop;
  }
  return null;
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
): ItineraryTiming {
  const byTrip = geometriesByTrip(geometries);
  const out: LegTiming[] = [];
  let earliestMs: number | null = nowMs;

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

        const ride = rideWindow(geo, fromKey, toKey, state.simDistM);
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
): { departureMs: number; travelMs: number } | null {
  let fromIdx = -1;
  for (let i = 0; i < geo.stops.length; i++) {
    const stop = geo.stops[i];
    if (fromIdx < 0) {
      if (stop.distM < simDistM - STOP_SLACK_M) continue;
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
