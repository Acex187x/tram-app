/** Replay public Convex wire captures through the shipping client, including
 * its presentation guard. No alternative physics implementation lives here.
 * Usage: tsx --tsconfig lab/tsconfig.runtime.json bench/src/replay-wire.ts wire.jsonl geometry.json [fps] [seconds] [startAtMs] [warmupSeconds]
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
const readText = (path: string) => {
  const data = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(data) : data).toString('utf8');
};
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { servedToRouteGeometry } from '@/lib/golemio/gtfs';
import type { RouteGeometry, TramModelSpec, TramSnapshot } from '@/lib/types';

const [wirePath, geometryPath, fpsArg = '30', secondsArg = '3600', startAtArg, warmupArg = '0'] =
  process.argv.slice(2);
if (!wirePath || !geometryPath) throw new Error('Expected wire.jsonl and geometry.json');
const fps = Number(fpsArg);
const maxSeconds = Number(secondsArg);
const warmupSeconds = Number(warmupArg);
if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0)
  throw new Error('warmupSeconds must be finite and nonnegative');
const rows = readText(wirePath)
  .split('\n')
  .flatMap((line) => {
    if (!line) return [];
    try {
      const r = JSON.parse(line);
      return r.value ? [r] : [];
    } catch {
      return [];
    }
  })
  .sort((a, b) => a.receivedAtMs - b.receivedAtMs);
if (!rows.length) throw new Error('No complete rows');
const pack = JSON.parse(readText(geometryPath));
const shapes = new Map<string, RouteGeometry>(
  pack.shapes.map((s: any) => [s.shapeId, servedToRouteGeometry(s, rows[0].receivedAtMs)]),
);
const geometries = new Map<string, RouteGeometry>();
for (const [tripId, shapeId] of Object.entries(pack.trips)) {
  const shape = shapes.get(String(shapeId));
  if (shape) geometries.set(tripId, { ...shape, tripId });
}
const store = new TrajectoryStore();
const fleet = new TramFleet({
  trajectories: store,
  resolveModel: () => ({ id: '15t' }) as TramModelSpec,
});
const fixes = new Map<string, TramSnapshot>();
let index = 0;
let curveCursor = -1;
let frames = 0,
  samples = 0,
  visibleSamples = 0,
  backward = 0,
  speedOver25 = 0,
  guardedHolds = 0;
let maxBackwardM = 0,
  maxForwardM = 0,
  holdSeconds = 0,
  sanctionedJumps = 0;
const speeds: number[] = [],
  steps: number[] = [],
  frameCosts: number[] = [];
const positiveSteps: number[] = [],
  brakingSteps: number[] = [];
const positiveOutliers: unknown[] = [];
const holdReasons: Record<string, number> = {};
let launchesOver1 = 0,
  positiveStepsOver1 = 0;
const prev = new Map<
  string,
  { s: number; t: number; v?: number; trip: string; emission: number; target: number }
>();
type Metrics = {
  gaps: number[];
  stopOvershoot: number[];
  holdEpisodes: number[];
  avlError: number[];
  seconds: number;
  ahead10S: number;
  ahead30S: number;
  accelerationHigh: number;
  brakingHigh: number;
};
const metrics = new Map<string, Metrics>();
function group(state: string) {
  let g = metrics.get(state);
  if (!g) {
    g = {
      gaps: [],
      stopOvershoot: [],
      holdEpisodes: [],
      avlError: [],
      seconds: 0,
      ahead10S: 0,
      ahead30S: 0,
      accelerationHigh: 0,
      brakingHigh: 0,
    };
    metrics.set(state, g);
  }
  return g;
}
const history = new Map<
  string,
  { trip: string; points: { t: number; s: number }[]; start: number }
>();
const scoredFix = new Map<string, number>();
const observations: {
  key: string;
  tripId: string;
  state: string;
  observedAtMs: number;
  errorM: number;
}[] = [];
const holds = new Map<
  string,
  {
    state: string;
    start: number;
    end: number;
    position: number;
    target: number;
    fix: number;
    fixAt: number;
  }
>();
const longHolds: unknown[] = [];
function finishHold(key: string) {
  const h = holds.get(key);
  if (h) {
    group(h.state).holdEpisodes.push((h.end - h.start) / 1000);
    if (h.end - h.start > 30000) longHolds.push({ key, ...h, durationS: (h.end - h.start) / 1000 });
    holds.delete(key);
  }
}
function scoreFix(f: TramSnapshot) {
  if ((scoredFix.get(f.key) ?? 0) >= f.observedAtMs) return;
  scoredFix.set(f.key, f.observedAtMs);
  if (f.observedAtMs < minAt) return;
  const h = history.get(f.key);
  if (!h || h.trip !== f.tripId) return;
  // Evaluate what was ALREADY displayed at observation time, not a prediction
  // revised after learning this fix. Skip missing historical brackets.
  let lo = h.start,
    hi = h.points.length - 1;
  if (lo >= hi || f.observedAtMs < h.points[lo].t || f.observedAtMs > h.points[hi].t) return;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (h.points[m].t <= f.observedAtMs) lo = m;
    else hi = m;
  }
  const a = h.points[lo],
    b = h.points[hi];
  const errorM = a.s + ((b.s - a.s) * (f.observedAtMs - a.t)) / (b.t - a.t) - f.shapeDistM;
  group(f.statePosition).avlError.push(errorM);
  observations.push({
    key: f.key,
    tripId: f.tripId,
    state: f.statePosition,
    observedAtMs: f.observedAtMs,
    errorM,
  });
}
function recordHistory(key: string, trip: string, distanceM: number, frameAt: number) {
  let h = history.get(key);
  if (!h || h.trip !== trip) {
    h = { trip, points: [], start: 0 };
    history.set(key, h);
  }
  h.points.push({ t: frameAt, s: distanceM });
  while (h.start < h.points.length && h.points[h.start].t < frameAt - 90000) h.start++;
  if (h.start > 3000) {
    h.points = h.points.slice(h.start);
    h.start = 0;
  }
}
const minAt = startAtArg === undefined ? rows[0].receivedAtMs : Number(startAtArg);
const maxAt = Math.min(rows.at(-1).receivedAtMs, minAt + maxSeconds * 1000);
let latestFixAt = 0;
for (let frameAt = minAt - warmupSeconds * 1000; frameAt <= maxAt; frameAt += 1000 / fps) {
  while (index < rows.length && rows[index].receivedAtMs <= frameAt) {
    const r = rows[index++],
      v = r.value;
    if (r.path === 'stream:fullFleet') {
      fixes.clear();
      for (const s of v.vehicles) {
        scoreFix(s);
        fixes.set(s.key, s);
      }
      latestFixAt = r.receivedAtMs;
      fleet.ingest([...fixes.values()], (trip) => geometries.get(trip));
    } else if (r.path === 'stream:batchesSince') {
      for (const batch of v.batches) {
        for (const s of batch.changed) {
          scoreFix(s);
          fixes.set(s.key, s);
        }
        for (const key of batch.removed ?? []) fixes.delete(key);
      }
      latestFixAt = r.receivedAtMs;
      fleet.ingest([...fixes.values()], (trip) => geometries.get(trip));
    } else if (r.path === 'trajectories:fullSet') {
      store.seedConvex(v.vehicles, v.meta, r.receivedAtMs);
      curveCursor = v.seq;
    } else if (r.path === 'trajectories:batchesSince') {
      for (const batch of v.batches)
        if (batch.seq > curveCursor) {
          store.foldConvex(batch, v.serverNowMs, r.receivedAtMs);
          curveCursor = batch.seq;
        }
    } else if (r.path === 'trajectories:meta') store.noteConvexMeta(v, r.receivedAtMs);
    else if (r.path === 'clock:now' && typeof r.sentAtMs === 'number')
      store.noteConvexClock(v.serverNowMs, r.sentAtMs, r.receivedAtMs);
  }
  const start = performance.now();
  const states = fleet.getStates(frameAt, 'smooth', true);
  // Prime the actual renderer guard using every captured revision before the
  // measurement window. Warmup does not contribute frames, holds or AVL scores.
  if (frameAt < minAt) {
    for (const s of states)
      if (s.hasGeometry) recordHistory(s.key, s.snapshot.tripId, s.simDistM, frameAt);
    continue;
  }
  frameCosts.push(performance.now() - start);
  frames++;
  for (const s of states) {
    samples++;
    if (!s.hasGeometry) continue;
    visibleSamples++;
    const vehicle = store.getVehicle(s.key);
    const emission = vehicle?.emittedAtMs ?? 0;
    const p = prev.get(s.key);
    if (
      p &&
      p.trip === s.snapshot.tripId &&
      frameAt - p.t < 1500 / fps &&
      !(vehicle?.discontinuity && emission !== p.emission)
    ) {
      const ds = s.simDistM - p.s,
        dt = (frameAt - p.t) / 1000,
        v = ds / dt;
      if (ds < -0.01) {
        backward++;
        maxBackwardM = Math.min(maxBackwardM, ds);
      }
      maxForwardM = Math.max(maxForwardM, ds);
      if (v > 25.1) speedOver25++;
      speeds.push(v);
      const g = group(s.snapshot.statePosition);
      if (p.v !== undefined) {
        steps.push(Math.abs(v - p.v));
        positiveSteps.push(Math.max(0, v - p.v));
        brakingSteps.push(Math.max(0, p.v - v));
        if (v - p.v > 1) {
          positiveStepsOver1++;
          if (positiveOutliers.length < 30)
            positiveOutliers.push({
              key: s.key,
              frameAt,
              dt,
              ds,
              v,
              previous: p,
              reportedSpeed: s.simSpeedKmh,
              target: (s as any).renderTargetDistM,
              discontinuity: vehicle?.discontinuity,
              emission,
            });
        }
        if (p.v < 0.1 && v > 1) launchesOver1++;
        const a = (v - p.v) / dt;
        if (a > 1.301) g.accelerationHigh++;
        if (a < -1.401) g.brakingHigh++;
      }
      g.seconds += dt;
      const gap = ((s as any).renderTargetDistM ?? s.simDistM) - s.simDistM;
      g.gaps.push(gap);
      if (gap < -10) g.ahead10S += dt;
      if (gap < -30) g.ahead30S += dt;
      if (s.snapshot.statePosition === 'at_stop' && frameAt - s.snapshot.observedAtMs < 45000)
        g.stopOvershoot.push(Math.max(0, s.simDistM - s.snapshot.shapeDistM));
      if ((s as any).renderGuardActive && v < 0.1) {
        let h = holds.get(s.key);
        if (h && h.state !== s.snapshot.statePosition) {
          finishHold(s.key);
          h = undefined;
        }
        if (!h) {
          h = {
            state: s.snapshot.statePosition,
            start: p.t,
            end: frameAt,
            position: s.simDistM,
            target: (s as any).renderTargetDistM,
            fix: s.snapshot.shapeDistM,
            fixAt: s.snapshot.observedAtMs,
          };
          holds.set(s.key, h);
        } else h.end = frameAt;
      } else finishHold(s.key);
      // New client metadata; zero on old code, never compare as if the old
      // client had reported its own hidden guard holds correctly.
      if ((s as any).renderGuardActive && v < 0.1) {
        guardedHolds++;
        holdSeconds += dt;
        const rawSpeed = (((s as any).renderTargetDistM ?? s.simDistM) - p.target) / dt;
        const fixAgeS = (frameAt - s.snapshot.observedAtMs) / 1000;
        const reason =
          fixAgeS > 45
            ? 'old-avl-over45s'
            : s.pastHorizon
              ? 'past-effective-horizon'
              : rawSpeed < -0.1
                ? 'target-revised-backward'
                : rawSpeed <= 0.1
                  ? 'flat-target'
                  : gap < -0.5
                    ? 'moving-target-behind-rendered-floor'
                    : 'low-speed-catchup';
        const label = `${s.snapshot.statePosition}/${reason}`;
        holdReasons[label] = (holdReasons[label] ?? 0) + dt;
      }
      prev.set(s.key, {
        s: s.simDistM,
        t: frameAt,
        v,
        trip: s.snapshot.tripId,
        emission,
        target: (s as any).renderTargetDistM ?? s.simDistM,
      });
    } else {
      finishHold(s.key);
      if (p && p.trip === s.snapshot.tripId && vehicle?.discontinuity) sanctionedJumps++;
      prev.set(s.key, {
        s: s.simDistM,
        t: frameAt,
        v: undefined,
        trip: s.snapshot.tripId,
        emission,
        target: (s as any).renderTargetDistM ?? s.simDistM,
      });
    }
    recordHistory(s.key, s.snapshot.tripId, s.simDistM, frameAt);
  }
}
for (const key of holds.keys()) finishHold(key);
const quantiles = (values: number[]) => {
  values.sort((a, b) => a - b);
  return Object.fromEntries(
    [0.5, 0.9, 0.99, 1].map((q) => [
      String(q),
      values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0,
    ]),
  );
};
console.log(
  JSON.stringify(
    {
      wirePath,
      fps,
      warmupSeconds,
      durationS: (maxAt - minAt) / 1000,
      frames,
      samples,
      visibleSamples,
      lastFixAgeS: (maxAt - latestFixAt) / 1000,
      sanctionedJumps,
      backward,
      speedOver25,
      maxBackwardM,
      maxForwardM,
      guardedHolds,
      holdSeconds,
      observations,
      longHolds,
      guardHeldSecondsByReason: holdReasons,
      byReportedFixState: Object.fromEntries(
        [...metrics].map(([state, g]) => [
          state,
          {
            vehicleSeconds: g.seconds,
            aheadTarget10Seconds: g.ahead10S,
            aheadTarget30Seconds: g.ahead30S,
            targetMinusDisplayM: quantiles(g.gaps),
            aheadOfRecentReportedStopFixM: quantiles(g.stopOvershoot),
            guardHoldEpisodes: g.holdEpisodes.length,
            guardHoldDurationS: quantiles(g.holdEpisodes),
            accelerationOver1_3: g.accelerationHigh,
            brakingOver1_4: g.brakingHigh,
            historicalAvlCount: g.avlError.length,
            historicalAvlBiasM: g.avlError.reduce((a, b) => a + b, 0) / (g.avlError.length || 1),
            historicalAvlMaeM:
              g.avlError.reduce((a, b) => a + Math.abs(b), 0) / (g.avlError.length || 1),
            historicalAvlAbsErrorM: quantiles(g.avlError.map(Math.abs)),
          },
        ]),
      ),
      positiveOutliers,
      positiveSpeedStepMs: quantiles(positiveSteps),
      brakingSpeedStepMs: quantiles(brakingSteps),
      launchesOver1,
      positiveStepsOver1,
      actualSpeedMs: quantiles(speeds),
      speedStepMs: quantiles(steps),
      fullFleetFrameCpuMs: quantiles(frameCosts),
      clockOffsetMs: store.clock.offsetMs,
      clockSynced: store.clock.synced,
      caveat:
        'Sampled captured inputs, known geometry-pack trips only. No rider ground truth; source timestamps and delivery timing preserved. CPU is Node on host, not Hermes/native rendering.',
    },
    null,
    2,
  ),
);
