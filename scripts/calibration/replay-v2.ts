/**
 * replay-v2.ts — TS replay runner: drives the REAL TramEngine over a ride
 * recording's AVL fix sequence and scores it against the rider's filtered GPS
 * ground truth (fDist). This is the engine-v2 validation-gate runner
 * (docs/decisions/engine-v2.md §3); unlike docs/calibration/ride_replay.py it
 * contains NO physics of its own — only the engine-independent ride
 * reconstruction (ported once from ride_replay.py's Ride class) plus scoring.
 *
 * RUN MECHANISM (the one supported way): standalone via tsx.
 *
 *     npm run replay:v2                    # default 3 rides, writes baseline JSON
 *     npx tsx scripts/calibration/replay-v2.ts [ride.jsonl ...] [--out=path] [--dry] [--engine=label]
 *
 * --engine labels the JSON's `engine` field (default: the pre-v2 label, kept
 * so re-running the committed pre-v2 baseline stays byte-reproducible; pass
 * --engine='v2 (predictor + smoother)' when scoring the v2 engine).
 *
 * tsx compiles this file (and the engine it requires) as CJS with tsconfig
 * `paths` resolution, which is exactly what the engine's lazy
 * `require('@/lib/fleet/modelSpecs')` needs. A jest wrapper was considered and
 * rejected: jest-expo's module registry adds nothing here and slows the loop.
 *
 * IMPORTANT: `__DEV__` must exist before any engine module loads (speedProfile
 * reads it at module scope). `import` statements hoist above statements in
 * CJS output, so all ENGINE VALUES are loaded via `require` AFTER the global
 * is set; only type-only imports (erased at compile time) use `import type`.
 *
 * What it does per ride:
 *   1. Parse the v3/v4 ride JSONL (meta lines carry `type`; points are bare).
 *   2. Rebuild the static world exactly like ride_replay.py:
 *      - shape from the rider's FILTERED track (fOffM < 30 gate, 8 m resample),
 *        expressed in the ride's native along-shape coordinate (cumDistM =
 *        fDist values — obsDist/fDist/simDist all share this axis);
 *      - stop table from `at_stop` fix clusters keyed by nextSeq (median
 *        obsDist), with arrival/departure EPOCHS taken from the cluster's
 *        min/max obsAt (dwellSeconds 0 → engine default dwell applies);
 *      - genuinely-new fix sequence from obsAt advances, with the wall time
 *        the app first SAW each fix (`seen`).
 *   3. Drive the real engine: `ingest` the synthesized TramSnapshot at each
 *      fix's `seen` time, re-ingest the current snapshot every 5 s (the
 *      production poll cadence — also keeps lastSeenMs fresh so the 90 s
 *      stale-entry sweep never fires mid-gap), `tick` every 250 ms, cadence
 *      'full' (projSim advances every substep).
 *   4. Sample BOTH tracks per second: simDistM (main/smoother, smooth mode)
 *      and projectedObservedDistM (projection/predictor, live mode).
 *   5. Score per second against fDist (fOffM < 30): err = s − fDist
 *      (+ = engine ahead of the real tram). Report mean|e| / p50 / p90 /
 *      signed mean / %ahead per ride, point-weighted aggregate, contiguous-
 *      half split, and the at-fix probe (err vs each genuinely-new fix's
 *      obsDist, sampled at the last tick BEFORE that fix is ingested).
 *
 * Known harness deviations from ride_replay.py (documented, deliberate):
 *   - The real engine applies the daytime centre zone cap by wall clock;
 *     ride_replay.py defaulted daytime=False for every ride (incl. the two
 *     17:28/18:22 CEST ones).
 *   - snapshot.delaySeconds is forced to 0: the reconstructed "schedule" IS
 *     the observed timing, so shifting it by the feed's delayS would
 *     double-count the delay.
 *   - The engine treats the last stop of a geometry as a terminal
 *     (isTerminalStop fallback); the reconstructed shape ends where the rider
 *     alighted, so the final platform behaves as a terminal latch.
 *   - Exact score parity with the Python harness is NOT expected (different
 *     geometry details, real engine vs 1D port); only same-runner comparisons
 *     (pre-v2 baseline vs v2) are meaningful.
 */

/* eslint-disable @typescript-eslint/no-require-imports, import/first */

(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

import type { RouteGeometry, RouteStop, TramSnapshot } from '@/lib/types';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { execSync } = require('child_process') as typeof import('child_process');
const { TramEngine } = require('@/lib/engine/engine') as typeof import('@/lib/engine/engine');
const { getModelSpec, regNumberToModelId } =
  require('@/lib/fleet/registry') as typeof import('@/lib/fleet/registry');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_RIDES = [
  '20260720-193029-9097.jsonl',
  '20260728-172812-9507.jsonl',
  '20260728-182204-9506.jsonl',
];
const DEFAULT_OUT = path.join(REPO_ROOT, 'docs', 'calibration', 'baselines', 'pre-v2.json');

const OFF_GATE_M = 30; // fOffM gate on ground truth AND on shape samples
const RESAMPLE_M = 8; // shape resample step (ride_replay.py parity)
const TICK_MS = 250; // engine tick cadence during replay
const POLL_MS = 5000; // production feed poll cadence (re-ingest same snapshot)

// ── ride parsing & static reconstruction (port of ride_replay.py Ride) ───────

interface RidePoint {
  t: number;
  obsDist: number | null;
  obsAt: number | null;
  statePos: string | null;
  delayS: number | null;
  nextSeq: number | null;
  tripId: string | null;
  fDist: number | null;
  fOffM: number | null;
  fLat: number | null;
  fLng: number | null;
  simDist: number | null;
}

interface Fix {
  at: number; // obsAt, unix ms
  dist: number; // obsDist, m along shape
  statePos: string | null;
  delayS: number | null;
  nextSeq: number | null;
  seen: number; // wall t of the point that first carried this fix
}

interface RideHeader {
  tramKey?: string;
  model?: string;
  line?: string;
  tripId?: string;
  schema?: string;
}

function pct(sortedAbs: number[], p: number): number {
  if (sortedAbs.length === 0) return NaN;
  const k = ((sortedAbs.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sortedAbs.length - 1);
  return sortedAbs[f] + (sortedAbs[c] - sortedAbs[f]) * (k - f);
}

class Ride {
  readonly path: string;
  readonly file: string;
  header: RideHeader = {};
  points: RidePoint[] = [];
  shapeDists: number[] = [];
  shapeCoords: [number, number][] = []; // [lng, lat]
  sMin = 0;
  sMax = 0;
  stops: RouteStop[] = [];
  fixes: Fix[] = [];

  constructor(filePath: string) {
    this.path = filePath;
    this.file = path.basename(filePath);
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(trimmed);
      } catch {
        continue; // torn final line after a crash
      }
      if (typeof r.type === 'string') {
        if (r.type === 'ride-start') this.header = r as RideHeader;
        continue; // meta line (ride-end / ride-orphaned / motion / unknown)
      }
      if (r.gpsLat == null) continue;
      this.points.push({
        t: r.t as number,
        obsDist: (r.obsDist as number | null) ?? null,
        obsAt: (r.obsAt as number | null) ?? null,
        statePos: (r.statePos as string | null) ?? null,
        delayS: (r.delayS as number | null) ?? null,
        nextSeq: (r.nextSeq as number | null) ?? null,
        tripId: (r.tripId as string | null) ?? null,
        fDist: (r.fDist as number | null) ?? null,
        fOffM: (r.fOffM as number | null) ?? null,
        fLat: (r.fLat as number | null) ?? null,
        fLng: (r.fLng as number | null) ?? null,
        simDist: (r.simDist as number | null) ?? null,
      });
    }
    if (this.points.length === 0) throw new Error(`${filePath}: no points`);
    this.buildShape();
    this.buildStops();
    this.buildFixes();
  }

  /** Shape from the rider's own filtered track: fOffM-gated, 8 m resample. */
  private buildShape(): void {
    const samp: [number, number, number][] = []; // [fDist, fLat, fLng]
    for (const p of this.points) {
      if (p.fDist !== null && p.fOffM !== null && p.fOffM < OFF_GATE_M && p.fLat !== null && p.fLng !== null) {
        samp.push([p.fDist, p.fLat, p.fLng]);
      }
    }
    samp.sort((a, b) => a[0] - b[0]);
    for (const [d, la, ln] of samp) {
      if (this.shapeDists.length === 0 || d - this.shapeDists[this.shapeDists.length - 1] >= RESAMPLE_M) {
        this.shapeDists.push(d);
        this.shapeCoords.push([ln, la]);
      }
    }
    if (this.shapeDists.length < 2) throw new Error(`${this.path}: degenerate shape`);
    this.sMin = this.shapeDists[0];
    this.sMax = this.shapeDists[this.shapeDists.length - 1];
  }

  /** [lng, lat] at along-shape s (nearest-behind vertex, ride_replay parity). */
  coordAt(s: number): [number, number] {
    const d = this.shapeDists;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid] <= s) lo = mid;
      else hi = mid;
    }
    return this.shapeCoords[lo];
  }

  /**
   * Stop table from at_stop fix clusters keyed by nextSeq: distM = median
   * obsDist of the cluster; arrival/departure EPOCHS = min/max obsAt of the
   * cluster (the observed timing IS the schedule anchor here); dwellSeconds 0
   * so the engine applies its default dwell.
   */
  private buildStops(): void {
    const clusters = new Map<number, { dists: number[]; ats: number[] }>();
    for (const p of this.points) {
      if (p.statePos === 'at_stop' && p.obsDist !== null && p.nextSeq !== null) {
        let c = clusters.get(p.nextSeq);
        if (!c) {
          c = { dists: [], ats: [] };
          clusters.set(p.nextSeq, c);
        }
        c.dists.push(p.obsDist);
        if (p.obsAt !== null) c.ats.push(p.obsAt);
      }
    }
    const raw: { distM: number; seq: number; arrivalMs: number; departureMs: number }[] = [];
    for (const [seq, c] of clusters) {
      c.dists.sort((a, b) => a - b);
      const distM = c.dists[Math.floor(c.dists.length / 2)]; // upper-median, py parity
      const arrivalMs = c.ats.length > 0 ? Math.min(...c.ats) : 0;
      const departureMs = c.ats.length > 0 ? Math.max(...c.ats) : arrivalMs;
      raw.push({ distM, seq, arrivalMs, departureMs });
    }
    raw.sort((a, b) => a.distM - b.distM);
    this.stops = raw.map((s) => ({
      stopId: `ride-seq-${s.seq}`,
      name: `stop ${s.seq}`,
      sequence: s.seq,
      coordinates: this.coordAt(s.distM),
      distM: s.distM,
      arrivalMs: s.arrivalMs,
      departureMs: s.departureMs,
      dwellSeconds: 0,
      isTerminal: false,
    }));
  }

  /** Genuinely-new AVL fixes: obsAt advanced vs the previous point. */
  private buildFixes(): void {
    let lastAt: number | null = null;
    for (const p of this.points) {
      if (p.obsAt === null || p.obsDist === null) continue;
      if (lastAt === null || p.obsAt > lastAt) {
        this.fixes.push({
          at: p.obsAt,
          dist: p.obsDist,
          statePos: p.statePos,
          delayS: p.delayS,
          nextSeq: p.nextSeq,
          seen: p.t,
        });
        lastAt = p.obsAt;
      }
    }
  }

  /** fOffM-gated ground truth samples: [t, fDist]. */
  truth(): [number, number][] {
    const out: [number, number][] = [];
    for (const p of this.points) {
      if (p.fOffM !== null && p.fOffM < OFF_GATE_M && p.fDist !== null) out.push([p.t, p.fDist]);
    }
    return out;
  }

  tramKey(): string {
    return this.header.tramKey ?? 'unknown';
  }

  tripId(): string {
    return this.header.tripId ?? this.points.find((p) => p.tripId !== null)?.tripId ?? 'ride-trip';
  }

  toGeometry(): RouteGeometry {
    return {
      shapeId: `ride-shape:${this.file}`,
      tripId: this.tripId(),
      routeId: `L${this.header.line ?? '?'}`,
      line: this.header.line ?? '?',
      headsign: '',
      coordinates: this.shapeCoords,
      // Native ride coordinate: cumDistM = fDist values, so obsDist/fDist and
      // the engine's sM all live on the same axis (no re-zeroing).
      cumDistM: this.shapeDists,
      totalM: this.sMax,
      stops: this.stops,
    };
  }
}

// ── engine drive ─────────────────────────────────────────────────────────────

interface TrackSample {
  sim: number;
  proj: number | null;
}

interface AtFixSample {
  sim: number | null;
  proj: number | null;
  fixDist: number;
}

function synthSnapshot(ride: Ride, fix: Fix): TramSnapshot {
  const reg = parseInt(ride.tramKey(), 10);
  return {
    key: ride.tramKey(),
    registrationNumber: Number.isFinite(reg) ? reg : null,
    tripId: ride.tripId(),
    routeId: `L${ride.header.line ?? '?'}`,
    line: ride.header.line ?? '?',
    headsign: '',
    shapeDistM: fix.dist,
    observedAtMs: fix.at,
    coordinates: ride.coordAt(fix.dist),
    bearing: null,
    // 0, NOT fix.delayS: the reconstructed schedule anchor is built from
    // OBSERVED stop times, so the feed delay is already baked into it.
    delaySeconds: 0,
    statePosition: fix.statePos ?? 'on_track',
    lastStopId: null,
    lastStopSequence: null,
    nextStopId: null,
    nextStopSequence: fix.nextSeq,
    nextStopArrivalMs: null,
    wheelchairAccessible: false,
    airConditioned: null,
    usbChargers: null,
    isCanceled: false,
  };
}

/**
 * Drive the real engine over the ride timeline. Returns per-second samples of
 * both tracks plus the at-fix probe (state at the last tick BEFORE each
 * genuinely-new fix was ingested; first fix skipped — no prior state).
 */
function driveEngine(ride: Ride): { bySec: Map<number, TrackSample>; atFix: AtFixSample[] } {
  const engine = new TramEngine({
    resolveModel: (s: TramSnapshot) => getModelSpec(regNumberToModelId(s.registrationNumber)),
  });
  engine.setProjectionCadence('full');
  const geometry = ride.toGeometry();
  const resolveGeometry = (tripId: string): RouteGeometry | undefined =>
    tripId === geometry.tripId ? geometry : undefined;
  const key = ride.tramKey();

  const bySec = new Map<number, TrackSample>();
  const atFix: AtFixSample[] = [];
  const t0 = ride.points[0].t;
  const tEnd = ride.points[ride.points.length - 1].t;
  let fi = 0;
  let curSnap: TramSnapshot | null = null;
  let lastIngestMs = -Infinity;

  for (let t = t0; t <= tEnd; t += TICK_MS) {
    // Genuinely-new fixes that the app has seen by now.
    while (fi < ride.fixes.length && ride.fixes[fi].seen <= t) {
      const fx = ride.fixes[fi];
      if (fi > 0) {
        // At-fix probe: engine position as of the previous tick vs the fresh fix.
        const st = engine.getState(key); // defaults to lastTickMs
        atFix.push({
          sim: st ? st.simDistM : null,
          proj: st ? st.projectedObservedDistM : null,
          fixDist: fx.dist,
        });
      }
      curSnap = synthSnapshot(ride, fx);
      engine.ingest([curSnap], resolveGeometry, fx.seen);
      lastIngestMs = fx.seen;
      fi++;
    }
    // Production poll cadence: re-ingest the unchanged snapshot every 5 s
    // (idempotent — projSim re-seed is gated on fix identity; refreshes
    // lastSeenMs so the 90 s stale sweep never fires inside a long fix gap).
    if (curSnap && t - lastIngestMs >= POLL_MS) {
      engine.ingest([curSnap], resolveGeometry, t);
      lastIngestMs = t;
    }
    engine.tick(t);
    const st = engine.getState(key, t);
    if (st) {
      // Last tick inside each wall second wins (ride_replay.py dict parity).
      bySec.set(Math.floor(t / 1000), { sim: st.simDistM, proj: st.projectedObservedDistM });
    }
  }
  return { bySec, atFix };
}

// ── scoring ──────────────────────────────────────────────────────────────────

interface Metrics {
  n: number;
  meanAbs: number;
  p50Abs: number;
  p90Abs: number;
  signedMean: number;
  pctAhead: number;
}

function metrics(errs: number[]): Metrics | null {
  if (errs.length === 0) return null;
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    n: errs.length,
    meanAbs: r(abs.reduce((a, b) => a + b, 0) / abs.length),
    p50Abs: r(pct(abs, 50)),
    p90Abs: r(pct(abs, 90)),
    signedMean: r(errs.reduce((a, b) => a + b, 0) / errs.length),
    pctAhead: r((100 * errs.filter((x) => x > 0).length) / errs.length),
  };
}

interface RideScore {
  meta: {
    file: string;
    line: string | undefined;
    model: string | undefined;
    tramKey: string;
    tripId: string;
    points: number;
    truthPoints: number;
    stops: number;
    fixes: number;
    spanM: [number, number];
  };
  sim: Metrics | null;
  proj: Metrics | null;
  halves: {
    sim: { first: Metrics | null; second: Metrics | null };
  };
  simErrs: number[];
  projErrs: number[];
  atFixSimErrs: number[];
  atFixProjErrs: number[];
}

function scoreRide(ride: Ride): RideScore {
  const { bySec, atFix } = driveEngine(ride);
  const simErrs: number[] = [];
  const projErrs: number[] = [];
  for (const [t, fDist] of ride.truth()) {
    const s = bySec.get(Math.floor(t / 1000));
    if (!s) continue;
    simErrs.push(s.sim - fDist);
    if (s.proj !== null) projErrs.push(s.proj - fDist);
  }
  const half = Math.floor(simErrs.length / 2);
  const atFixSimErrs = atFix.filter((a) => a.sim !== null).map((a) => (a.sim as number) - a.fixDist);
  const atFixProjErrs = atFix
    .filter((a) => a.proj !== null)
    .map((a) => (a.proj as number) - a.fixDist);
  return {
    meta: {
      file: ride.file,
      line: ride.header.line,
      model: ride.header.model,
      tramKey: ride.tramKey(),
      tripId: ride.tripId(),
      points: ride.points.length,
      truthPoints: ride.truth().length,
      stops: ride.stops.length,
      fixes: ride.fixes.length,
      spanM: [Math.round(ride.sMin), Math.round(ride.sMax)],
    },
    sim: metrics(simErrs),
    proj: metrics(projErrs),
    halves: {
      sim: { first: metrics(simErrs.slice(0, half)), second: metrics(simErrs.slice(half)) },
    },
    simErrs,
    projErrs,
    atFixSimErrs,
    atFixProjErrs,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

function fmtRow(name: string, m: Metrics | null): string {
  if (!m) return `${name.padEnd(34)}        (no samples)`;
  return (
    name.padEnd(34) +
    `${m.meanAbs.toFixed(1).padStart(8)} ${m.p50Abs.toFixed(1).padStart(7)} ` +
    `${m.p90Abs.toFixed(1).padStart(7)} ${m.signedMean >= 0 ? '+' : ''}${m.signedMean.toFixed(1).padStart(6)} ` +
    `${m.pctAhead.toFixed(1).padStart(6)}% ${String(m.n).padStart(6)}`
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const outArg = argv.find((a) => a.startsWith('--out='));
  const outPath = outArg ? path.resolve(outArg.slice(6)) : DEFAULT_OUT;
  const engineArg = argv.find((a) => a.startsWith('--engine='));
  const engineLabel = engineArg
    ? engineArg.slice(9)
    : 'pre-v2 (dual-controller: main sim + projSim)';
  const rideArgs = argv.filter((a) => !a.startsWith('--'));
  const ridePaths = (rideArgs.length > 0 ? rideArgs : DEFAULT_RIDES).map((p) =>
    path.isAbsolute(p) ? p : path.join(REPO_ROOT, p),
  );

  const scores: RideScore[] = [];
  for (const p of ridePaths) {
    const ride = new Ride(p);
    const s = scoreRide(ride);
    const m = s.meta;
    console.log(
      `ride ${m.file}: line ${m.line} model ${m.model} key ${m.tramKey} ` +
        `points ${m.points} truth ${m.truthPoints} stops ${m.stops} fixes ${m.fixes} ` +
        `span ${m.spanM[0]}-${m.spanM[1]} m`,
    );
    scores.push(s);
  }

  const aggSim = scores.flatMap((s) => s.simErrs);
  const aggProj = scores.flatMap((s) => s.projErrs);
  const aggAtFixSim = scores.flatMap((s) => s.atFixSimErrs);
  const aggAtFixProj = scores.flatMap((s) => s.atFixProjErrs);
  const aggHalfFirst = scores.flatMap((s) => s.simErrs.slice(0, Math.floor(s.simErrs.length / 2)));
  const aggHalfSecond = scores.flatMap((s) => s.simErrs.slice(Math.floor(s.simErrs.length / 2)));

  console.log(
    `\n${'track'.padEnd(34)}${'mean|e|'.padStart(8)} ${'p50|e|'.padStart(7)} ` +
      `${'p90|e|'.padStart(7)} ${'signed'.padStart(7)} ${'%ahead'.padStart(7)} ${'n'.padStart(6)}`,
  );
  for (const s of scores) {
    console.log(fmtRow(`${s.meta.file} sim`, s.sim));
    console.log(fmtRow(`${s.meta.file} proj`, s.proj));
  }
  console.log(fmtRow('AGGREGATE sim (smooth mode)', metrics(aggSim)));
  console.log(fmtRow('AGGREGATE proj (live mode)', metrics(aggProj)));
  console.log(fmtRow('AGGREGATE sim first halves', metrics(aggHalfFirst)));
  console.log(fmtRow('AGGREGATE sim second halves', metrics(aggHalfSecond)));
  console.log(fmtRow('AT-FIX sim', metrics(aggAtFixSim)));
  console.log(fmtRow('AT-FIX proj', metrics(aggAtFixProj)));

  let engineGitDescribe = 'unknown';
  try {
    engineGitDescribe = execSync('git describe --always --dirty', { cwd: REPO_ROOT })
      .toString()
      .trim();
  } catch {
    /* keep 'unknown' */
  }

  const baseline = {
    generatedAt: new Date().toISOString(),
    engineGitDescribe,
    engine: engineLabel,
    runner: {
      script: 'scripts/calibration/replay-v2.ts',
      tickMs: TICK_MS,
      pollMs: POLL_MS,
      projectionCadence: 'full',
      offGateM: OFF_GATE_M,
      resampleM: RESAMPLE_M,
      delaySecondsForcedZero: true,
    },
    perRide: Object.fromEntries(
      scores.map((s) => [
        s.meta.file,
        { meta: s.meta, sim: s.sim, proj: s.proj, halves: s.halves },
      ]),
    ),
    aggregate: {
      sim: metrics(aggSim),
      proj: metrics(aggProj),
      halves: { sim: { first: metrics(aggHalfFirst), second: metrics(aggHalfSecond) } },
    },
    atFix: {
      perRide: Object.fromEntries(
        scores.map((s) => [
          s.meta.file,
          { sim: metrics(s.atFixSimErrs), proj: metrics(s.atFixProjErrs) },
        ]),
      ),
      aggregate: { sim: metrics(aggAtFixSim), proj: metrics(aggAtFixProj) },
    },
  };

  if (dry) {
    console.log('\n--dry: baseline JSON not written');
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nwrote ${outPath}`);
}

main();
