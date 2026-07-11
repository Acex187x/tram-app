// Shared fixtures for engine/geo/render tests: build geometries from local-meter
// coordinates, snapshots and model specs without touching golemio/fleet modules.

import type { RouteGeometry, RouteStop, TramModelSpec, TramSnapshot } from '@/lib/types';
import { cumulativeDistances, type LngLat } from '@/lib/geo/polyline';

/** Test origin, safely OUTSIDE the Prague center slow zone (east of it). */
export const ORIGIN: LngLat = [14.6, 50.05];
/** An origin INSIDE the center slow zone. */
export const CENTER_ORIGIN: LngLat = [14.42, 50.08];

// Must match polyline.ts haversine scale (earth radius 6371008.8 m) so that
// nominal meters in fixtures equal measured meters along generated shapes.
const M_PER_DEG_LAT = (Math.PI / 180) * 6371008.8;

/** Convert local meters (x east, y north) around an origin to [lng, lat]. */
export function metersToCoord(origin: LngLat, x: number, y: number): LngLat {
  const cosLat = Math.cos((origin[1] * Math.PI) / 180);
  return [origin[0] + x / (M_PER_DEG_LAT * cosLat), origin[1] + y / M_PER_DEG_LAT];
}

export interface StopSpec {
  /** Nominal distance along the shape, meters. */
  atM: number;
  name?: string;
  /** Scheduled arrival, ms epoch. */
  arrivalMs: number;
  /** Scheduled departure, ms epoch (defaults to arrival). */
  departureMs?: number;
  dwellSeconds?: number;
  isTerminal?: boolean;
}

/** Build a RouteGeometry from local-meter vertices + stop specs. */
export function makeGeometry(
  pointsM: [number, number][],
  stops: StopSpec[],
  origin: LngLat = ORIGIN,
): RouteGeometry {
  const coordinates = pointsM.map(([x, y]) => metersToCoord(origin, x, y));
  const cumDistM = cumulativeDistances(coordinates);
  const totalM = cumDistM[cumDistM.length - 1];
  const routeStops: RouteStop[] = stops.map((s, i) => {
    const distM = Math.min(s.atM, totalM);
    return {
      stopId: `stop-${i}`,
      name: s.name ?? `Stop ${i}`,
      sequence: i + 1,
      coordinates: coordinates[0],
      distM,
      arrivalMs: s.arrivalMs,
      departureMs: s.departureMs ?? s.arrivalMs,
      dwellSeconds: s.dwellSeconds ?? 0,
      isTerminal: s.isTerminal ?? i === stops.length - 1,
    };
  });
  return {
    shapeId: 'shape-test',
    tripId: 'trip-test',
    routeId: 'L9',
    line: '9',
    headsign: 'Testville',
    coordinates,
    cumDistM,
    totalM,
    stops: routeStops,
  };
}

export function makeSnapshot(partial: Partial<TramSnapshot> = {}): TramSnapshot {
  return {
    key: '9201',
    registrationNumber: 9201,
    tripId: 'trip-test',
    routeId: 'L9',
    line: '9',
    headsign: 'Testville',
    shapeDistM: 0,
    observedAtMs: 0,
    coordinates: [ORIGIN[0], ORIGIN[1]],
    bearing: 90,
    delaySeconds: 0,
    statePosition: 'on_track',
    lastStopId: null,
    lastStopSequence: null,
    nextStopId: null,
    nextStopSequence: null,
    nextStopArrivalMs: null,
    wheelchairAccessible: true,
    airConditioned: true,
    usbChargers: null,
    isCanceled: false,
    ...partial,
  };
}

/** Three-section articulated spec (15T-like), ~10 m per section. */
export function makeSpec3(): TramModelSpec {
  return {
    id: '15t',
    name: 'Škoda 15T ForCity Alfa',
    manufacturer: 'Škoda',
    yearsBuilt: '2010–2019',
    sections: [
      { modelKey: '15t-a', lengthM: 10 },
      { modelKey: '15t-b', lengthM: 10 },
      { modelKey: '15t-c', lengthM: 10 },
    ],
    jointGapM: 0.5,
    totalLengthM: 31.4,
    widthM: 2.46,
    heightM: 3.6,
    maxSpeedKmh: 60,
    lowFloor: true,
    runsCoupled: false,
    funFact: 'test',
  };
}

/** Single-section rigid spec (T3-like). */
export function makeSpec1(): TramModelSpec {
  return {
    id: 't3rp',
    name: 'T3R.P',
    manufacturer: 'ČKD',
    yearsBuilt: '1962–1999',
    sections: [{ modelKey: 't3rp', lengthM: 14.1 }],
    jointGapM: 0,
    totalLengthM: 14.1,
    widthM: 2.5,
    heightM: 3.1,
    maxSpeedKmh: 60,
    lowFloor: false,
    runsCoupled: true,
    funFact: 'test',
  };
}

/** Shortest angular difference in degrees (0..180). */
export function angularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
