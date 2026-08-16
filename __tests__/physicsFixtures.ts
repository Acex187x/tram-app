// Shared fixtures for the physics v3 suites.
//
// Includes the v1→v2 COMPAT SHIM. The predictor service's v1 endpoint published
// a single `points` series per vehicle; v2 publishes two (`opinion` + `smooth`)
// plus the clock/continuity metadata. While the v2 endpoint is being built in
// parallel, mapping a v1 body here lets the client be smoke-tested against a
// real-world payload shape — and it lives ONLY in tests. Shipping this shim
// would defeat the protocol: a v1 payload has no server clock and no
// continuity guarantee, so the client would be silently guessing both.

import type { RouteGeometry, RouteStop, TramSnapshot } from '@/lib/types';
import { cumulativeDistances } from '@/lib/geo/polyline';

export const T0 = Date.UTC(2026, 7, 16, 10, 0, 0);

/** One (t, s) keyframe as it appears on the wire. */
export interface WireKnot {
  t: number;
  s: number;
}

/** Build a wire track: `n` knots, `stepMs` apart, advancing at `speedMs`. */
export function wireTrack(
  startMs: number,
  startS: number,
  speedMs: number,
  n: number,
  stepMs = 10_000,
): WireKnot[] {
  const out: WireKnot[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: startMs + i * stepMs, s: startS + (speedMs * i * stepMs) / 1000 });
  }
  return out;
}

export interface WireVehicleOpts {
  key?: string;
  tripId?: string;
  line?: string;
  anchorMs?: number;
  emittedAtMs?: number;
  discontinuity?: boolean;
  opinion?: WireKnot[];
  smooth?: WireKnot[];
}

/** One vehicle entry of a v2 bundle. */
export function wireVehicle(opts: WireVehicleOpts = {}) {
  const emittedAtMs = opts.emittedAtMs ?? T0;
  return {
    key: opts.key ?? '9201',
    tripId: opts.tripId ?? 'trip-test',
    line: opts.line ?? '9',
    anchorMs: opts.anchorMs ?? emittedAtMs - 8_000,
    emittedAtMs,
    discontinuity: opts.discontinuity ?? false,
    opinion: opts.opinion ?? wireTrack(emittedAtMs, 1_000, 10, 13),
    smooth: opts.smooth ?? wireTrack(emittedAtMs, 990, 10, 13),
  };
}

export interface WireBundleOpts {
  serverNowMs?: number;
  atMs?: number;
  horizonS?: number;
  vehicles?: ReturnType<typeof wireVehicle>[];
}

/** A complete `GET /api/trajectories/v2` body. */
export function wireBundle(opts: WireBundleOpts = {}) {
  const serverNowMs = opts.serverNowMs ?? T0;
  return {
    protocolVersion: 2,
    serverNowMs,
    atMs: opts.atMs ?? serverNowMs,
    horizonS: opts.horizonS ?? 120,
    vehicles: opts.vehicles ?? [wireVehicle()],
  };
}

// ── v1 compat shim (TESTS ONLY — never ship this) ───────────────────────────

/** The v1 wire shape: one keyframe series per vehicle, no clock, no metadata. */
export interface V1Body {
  vehicles: { key: string; tripId: string; points: WireKnot[] }[];
}

/**
 * Map a v1 body onto the v2 contract for integration smoke tests.
 *
 * The two fabrications are the reason this must never ship:
 *   • `serverNowMs` — v1 has no server clock, so we invent one from the local
 *     clock, which is exactly the error the protocol's clock sync removes.
 *   • `smooth` — v1 published a single opinion series with no continuity
 *     guarantee, so both tracks are the same curve. A client fed this cannot
 *     tell smooth from fixed, and `deviationM` is identically zero.
 */
export function v1ToV2(body: V1Body, nowMs: number) {
  return {
    protocolVersion: 2,
    serverNowMs: nowMs,
    atMs: nowMs,
    horizonS: 120,
    vehicles: body.vehicles.map((v) => ({
      key: v.key,
      tripId: v.tripId,
      line: '',
      anchorMs: v.points[0]?.t ?? nowMs,
      emittedAtMs: v.points[0]?.t ?? nowMs,
      discontinuity: false,
      opinion: v.points,
      smooth: v.points,
    })),
  };
}

// ── geometry / snapshot fixtures ────────────────────────────────────────────

/** Straight 5 km east-west track from ORIGIN with optional stops. */
export function straightGeometry(stops: Partial<RouteStop>[] = []): RouteGeometry {
  const coordinates: [number, number][] = [
    [14.4, 50.08],
    [14.47, 50.08],
  ];
  const cumDistM = cumulativeDistances(coordinates);
  return {
    shapeId: 'shape-test',
    tripId: 'trip-test',
    routeId: 'L9',
    line: '9',
    headsign: 'Test',
    coordinates,
    cumDistM,
    totalM: cumDistM[cumDistM.length - 1],
    stops: stops.map((s, i) => ({
      stopId: s.stopId ?? `stop-${i}`,
      name: s.name ?? `Stop ${i}`,
      sequence: i + 1,
      coordinates: s.coordinates ?? [14.4, 50.08],
      distM: s.distM ?? 0,
      arrivalMs: s.arrivalMs ?? 0,
      departureMs: s.departureMs ?? 0,
      dwellSeconds: s.dwellSeconds ?? 20,
      isTerminal: s.isTerminal ?? false,
    })),
  };
}

export function snapshot(over: Partial<TramSnapshot> = {}): TramSnapshot {
  return {
    key: '9201',
    registrationNumber: 9201,
    tripId: 'trip-test',
    routeId: 'L9',
    line: '9',
    headsign: 'Test',
    shapeDistM: 1_000,
    observedAtMs: T0 - 8_000,
    coordinates: [14.4, 50.08],
    bearing: 90,
    delaySeconds: 0,
    statePosition: 'on_track',
    lastStopId: null,
    lastStopSequence: null,
    nextStopId: null,
    nextStopSequence: null,
    nextStopArrivalMs: null,
    wheelchairAccessible: true,
    airConditioned: null,
    usbChargers: null,
    isCanceled: false,
    ...over,
  };
}
