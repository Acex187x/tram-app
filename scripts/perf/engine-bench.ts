/**
 * engine-bench.ts — pure-TS engine CPU micro-benchmark (no simulator).
 *
 * Complements scripts/perf/simulator-benchmark.sh: that one measures the whole
 * app process in the iOS Simulator (the shipping perf gate); this one isolates
 * the ENGINE layer so engine rewrites can be compared across worktrees in
 * seconds. It exercises the hot paths the perf invariants govern
 * (docs/performance.md): 30 Hz tick with substeps, 5 s ingest with reseeds,
 * queue/cross/junction constraint passes, coarse-vs-full projection cadence,
 * and a 1 Hz getStatesInBounds read.
 *
 *     npx tsx scripts/perf/engine-bench.ts
 *
 * To compare engines: `git worktree add /tmp/tram-old <commit>`, symlink
 * node_modules into it, copy this script, run in both, compare "ms/sim-s"
 * (median of the reported passes; first pass includes JIT warm-up).
 *
 * Synthetic world: 30 parallel shapes × 5 trams = 150 trams, stops every
 * 450 m, fixes advance per tram every ~45 s at ~7 m/s, poll ingest every 5 s,
 * tick every 33 ms for 60 simulated seconds.
 */
/* eslint-disable @typescript-eslint/no-require-imports, import/first */

(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

import type { RouteGeometry, RouteStop, TramSnapshot } from '@/lib/types';

const { TramEngine } = require('@/lib/engine/engine') as typeof import('@/lib/engine/engine');

const SHAPES = 30;
const TRAMS_PER_SHAPE = 5;
const SHAPE_LEN_M = 9000;
const STOP_EVERY_M = 450;
const POINT_EVERY_M = 50;
const SIM_SECONDS = 60;
const TICK_MS = 33;
const POLL_MS = 5000;
const FIX_INTERVAL_MS = 45000;
const SPEED_MS = 7;
const T0 = 1_753_500_000_000; // fixed epoch → deterministic TOD/daytime

const M_PER_DEG_LAT = 111_320;

function makeGeometry(shapeIdx: number): RouteGeometry {
  const lat0 = 50.02 + shapeIdx * 0.004; // parallel lines, outside CENTER_BBOX
  const lng0 = 14.3;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const n = Math.floor(SHAPE_LEN_M / POINT_EVERY_M) + 1;
  const coordinates: [number, number][] = [];
  const cumDistM: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = i * POINT_EVERY_M;
    // Gentle sine wiggle so curvature/curve caps are non-trivial.
    const latWiggle = Math.sin(d / 400) * 0.0002;
    coordinates.push([lng0 + d / (M_PER_DEG_LAT * cosLat), lat0 + latWiggle]);
    cumDistM.push(d);
  }
  const stops: RouteStop[] = [];
  for (let s = STOP_EVERY_M, seq = 1; s < SHAPE_LEN_M; s += STOP_EVERY_M, seq++) {
    stops.push({
      stopId: `bench-${shapeIdx}-${seq}`,
      name: `stop ${seq}`,
      sequence: seq,
      coordinates: coordinates[Math.floor(s / POINT_EVERY_M)],
      distM: s,
      arrivalMs: T0 + (s / SPEED_MS) * 1000,
      departureMs: T0 + (s / SPEED_MS) * 1000 + 20_000,
      dwellSeconds: 0,
      isTerminal: false,
    });
  }
  return {
    shapeId: `bench-shape-${shapeIdx}`,
    tripId: `bench-trip-${shapeIdx}`,
    routeId: `L${shapeIdx}`,
    line: String(shapeIdx),
    headsign: 'bench',
    coordinates,
    cumDistM,
    totalM: SHAPE_LEN_M,
    stops,
  };
}

function main(): void {
  const geometries = new Map<string, RouteGeometry>();
  for (let i = 0; i < SHAPES; i++) {
    const g = makeGeometry(i);
    geometries.set(g.tripId, g);
  }
  const resolveGeometry = (tripId: string) => geometries.get(tripId);

  interface Vehicle {
    key: string;
    tripId: string;
    line: string;
    baseM: number;
    lastFixAt: number;
  }
  const fleet: Vehicle[] = [];
  for (let s = 0; s < SHAPES; s++) {
    for (let k = 0; k < TRAMS_PER_SHAPE; k++) {
      fleet.push({
        key: `${s}-${k}`,
        tripId: `bench-trip-${s}`,
        line: String(s),
        baseM: 200 + k * 700, // spaced along the shape → queues form when they close up
        lastFixAt: T0 - ((s * TRAMS_PER_SHAPE + k) % 9) * 5000, // staggered fix phases
      });
    }
  }

  const snapshotOf = (v: Vehicle, nowMs: number): TramSnapshot => {
    const dist = Math.min(SHAPE_LEN_M - 1, v.baseM + ((v.lastFixAt - T0 + 60_000) / 1000) * SPEED_MS);
    const g = geometries.get(v.tripId)!;
    const i = Math.max(0, Math.min(g.coordinates.length - 1, Math.floor(dist / POINT_EVERY_M)));
    return {
      key: v.key,
      registrationNumber: 9000,
      tripId: v.tripId,
      routeId: `L${v.line}`,
      line: v.line,
      headsign: 'bench',
      shapeDistM: dist,
      observedAtMs: v.lastFixAt,
      coordinates: g.coordinates[i],
      bearing: null,
      delaySeconds: 0,
      statePosition: 'on_track',
      lastStopId: null,
      lastStopSequence: null,
      nextStopId: null,
      nextStopSequence: null,
      nextStopArrivalMs: null,
      wheelchairAccessible: false,
      airConditioned: null,
      usbChargers: null,
      isCanceled: false,
    };
  };

  const model = {
    id: 'bench',
    displayName: 'bench',
    totalLengthM: 14.1,
    runsCoupled: false,
    sections: [{ modelKey: 'bench', lengthM: 14.1 }],
    gapM: 0,
  };

  const bbox: [number, number, number, number] = [14.3, 50.0, 14.42, 50.09];

  for (const cadence of ['coarse', 'full'] as const) {
    for (let pass = 1; pass <= 3; pass++) {
      const engine = new TramEngine({ resolveModel: () => model as never });
      engine.setProjectionCadence(cadence);
      engine.ingest(fleet.map((v) => snapshotOf(v, T0)), resolveGeometry, T0);
      engine.tick(T0);

      const start = process.hrtime.bigint();
      let lastPoll = T0;
      let lastRead = T0;
      for (let t = T0 + TICK_MS; t <= T0 + SIM_SECONDS * 1000; t += TICK_MS) {
        if (t - lastPoll >= POLL_MS) {
          for (const v of fleet) {
            if (t - v.lastFixAt >= FIX_INTERVAL_MS) v.lastFixAt = t;
          }
          engine.ingest(fleet.map((v) => snapshotOf(v, t)), resolveGeometry, t);
          lastPoll = t;
        }
        engine.tick(t);
        if (t - lastRead >= 1000) {
          // Older engines predate getStatesInBounds — fall back to getStates.
          const anyEngine = engine as unknown as {
            getStatesInBounds?: (n: number, b: [number, number, number, number]) => unknown;
            getStates: (n: number) => unknown;
          };
          if (anyEngine.getStatesInBounds) anyEngine.getStatesInBounds(t, bbox);
          else anyEngine.getStates(t);
          lastRead = t;
        }
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        `${cadence.padEnd(6)} pass ${pass}: ${elapsedMs.toFixed(1)} ms total, ` +
          `${(elapsedMs / SIM_SECONDS).toFixed(2)} ms/sim-s (${fleet.length} trams)`,
      );
      // reset fix phases for the next pass
      fleet.forEach((v, i) => (v.lastFixAt = T0 - (i % 9) * 5000));
    }
  }
}

main();
