// Ride schema v4 tests: (1) data-completeness contract — every point carries
// the full calibration context (time, line/trip/model, sim state, raw AVL fix,
// raw GPS, filtered GPS + its shape projection); (2) high-rate motion (IMU)
// batches are crash-safe — bounded buffering, one {type:'motion'} line per
// ≤1 s, tail drained before the footer, orphan-tolerant parsing; (3) the GPS
// outlier filter is wired in: raw fixes stay verbatim, outliers are flagged
// (`rej`) and counted, filtered projections populate fDist/fLagM.
import {
  MOTION_FLUSH_AT,
  MOTION_FLUSH_MS,
  MOTION_MAX_PENDING,
  MotionLog,
  RIDE_SCHEMA,
  motionRecord,
  type LocationSample,
  type LocationWatcher,
  type MotionFileInfo,
  type MotionLogDeps,
  type MotionLogFS,
  type MotionSample,
  type MotionWatcher,
} from '@/lib/motionlog/core';
import { parseRideFile } from '@/lib/motionlog/rideFile';
import type { RouteGeometry, TramPublicState } from '@/lib/types';

// ── fakes (same shape as motionlog.test.ts) ──────────────────────────────────

interface FakeFile {
  content: string;
  modifiedMs: number;
}

class FakeFS implements MotionLogFS {
  files = new Map<string, FakeFile>();
  failAppends = false;
  clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  append(relPath: string, text: string): void {
    if (this.failAppends) throw new Error('disk full');
    const existing = this.files.get(relPath);
    this.files.set(relPath, {
      content: (existing?.content ?? '') + text,
      modifiedMs: this.clock(),
    });
  }

  list(relDir: string): MotionFileInfo[] {
    const out: MotionFileInfo[] = [];
    for (const [relPath, file] of this.files) {
      const slash = relPath.lastIndexOf('/');
      if ((slash >= 0 ? relPath.slice(0, slash) : '') !== relDir) continue;
      out.push({
        relPath,
        name: relPath.slice(slash + 1),
        uri: `file:///fake/${relPath}`,
        size: file.content.length,
        modifiedMs: file.modifiedMs,
      });
    }
    return out;
  }

  read(relPath: string): string {
    return this.files.get(relPath)?.content ?? '';
  }

  remove(relPath: string): void {
    this.files.delete(relPath);
  }

  uri(relPath: string): string {
    return `file:///fake/${relPath}`;
  }

  lines(relPath: string): string[] {
    const c = this.files.get(relPath)?.content ?? '';
    return c ? c.trimEnd().split('\n') : [];
  }
}

class FakeLocation implements LocationWatcher {
  emit: ((s: LocationSample) => void) | null = null;

  async start(onSample: (s: LocationSample) => void): Promise<() => void> {
    this.emit = onSample;
    return () => {
      this.emit = null;
    };
  }

  push(partial: Partial<LocationSample> = {}): void {
    this.emit?.({ t: 0, lat: 50.08, lng: 14.42, speed: 5, accuracy: 4, ...partial });
  }
}

class FakeMotion implements MotionWatcher {
  emit: ((s: MotionSample) => void) | null = null;
  started = 0;
  stopped = 0;
  fail = false;

  async start(onSample: (s: MotionSample) => void): Promise<() => void> {
    if (this.fail) throw new Error('sensor unavailable');
    this.started += 1;
    this.emit = onSample;
    return () => {
      this.stopped += 1;
      this.emit = null;
    };
  }

  push(t: number, over: Partial<MotionSample> = {}): void {
    this.emit?.({
      t,
      ax: 0.101,
      ay: -0.052,
      az: 0.003,
      ra: 1.5,
      rb: -0.25,
      rg: 0.1,
      oa: 0.5,
      ob: 0.01,
      og: -1.2,
      ...over,
    });
  }
}

function makeState(key: string, over: Partial<TramPublicState> = {}): TramPublicState {
  return {
    key,
    snapshot: {
      line: '9',
      shapeDistM: 1234,
      tripId: 'trip-991',
      registrationNumber: 9201,
      observedAtMs: 999_500,
      statePosition: 'on_track',
      delaySeconds: 42,
      nextStopSequence: 7,
    },
    model: { id: '15t' },
    simDistM: 1200,
    simSpeedKmh: 25,
    position: [14.42, 50.08],
    bearing: 90,
    phase: 'cruise',
    observedPosition: [14.42, 50.08],
    observedBearing: 90,
    deviationM: 34,
    projectedObservedDistM: 1250,
    nextStopName: 'Anděl',
    nextStopEtaS: 40,
    hasGeometry: true,
    paceBias: 1.072,
    ...over,
  } as unknown as TramPublicState;
}

/** Straight ~1.43 km west→east shape at lat 50 with exact cumDistM. */
function straightGeometry(): RouteGeometry {
  return {
    shapeId: 's',
    tripId: 'trip-991',
    routeId: 'r',
    line: '9',
    headsign: 'h',
    coordinates: [
      [14.4, 50.0],
      [14.41, 50.0],
      [14.42, 50.0],
    ],
    cumDistM: [0, 715, 1430],
    totalM: 1430,
    stops: [],
  } as unknown as RouteGeometry;
}

function makeLog(over: Partial<MotionLogDeps> = {}) {
  let now = 1_000_000;
  const fs = new FakeFS(() => now);
  const location = new FakeLocation();
  const motion = new FakeMotion();
  const stateMap = new Map<string, TramPublicState>();
  const geomMap = new Map<string, RouteGeometry>();

  const deps: MotionLogDeps = {
    fs,
    location,
    motion,
    now: () => now,
    stateProvider: (key) => stateMap.get(key),
    geometry: (key) => geomMap.get(key),
    positionMode: () => 'smooth',
    setTimeout: (() => 0 as unknown as ReturnType<typeof setTimeout>) as MotionLogDeps['setTimeout'],
    clearTimeout: (() => {}) as MotionLogDeps['clearTimeout'],
    ...over,
  };

  const log = new MotionLog(deps);
  return {
    log,
    fs,
    location,
    motion,
    stateMap,
    geomMap,
    setNow(v: number) {
      now = v;
    },
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

// ── (1) schema v4 completeness ───────────────────────────────────────────────

describe('ride schema v4 — completeness contract', () => {
  it('every point carries the FULL calibration context (the item-3 checklist)', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201'));
    h.geomMap.set('9201', straightGeometry());
    await h.log.startRide('9201');
    h.location.push({ t: h.now(), lat: 50.0, lng: 14.41, speed: 6.2, accuracy: 5 });
    const rel = h.log.rideInfo()!.relPath;
    await h.log.stopRide();

    const header = JSON.parse(h.fs.lines(rel)[0]);
    // Show-line context in the header: which tram, which trip, which schema.
    expect(header).toMatchObject({
      type: 'ride-start',
      tramKey: '9201',
      model: '15t',
      line: '9',
      schema: RIDE_SCHEMA,
      tripId: 'trip-991',
    });
    expect(RIDE_SCHEMA).toBe('v4');

    const rec = JSON.parse(h.fs.lines(rel)[1]);
    // Time: sample time + when the server's AVL fix was observed.
    expect(rec.t).toBe(h.now());
    expect(rec.obsAt).toBe(999_500);
    // Line / trip / model context per point (trip can change mid-ride).
    expect(rec.line).toBe('9');
    expect(rec.tripId).toBe('trip-991');
    expect(rec.model).toBe('15t');
    // Where the SIMULATION is: distance along shape, rendered pos, phase.
    expect(rec.simDist).toBe(1200);
    expect(rec.simLat).toBe(50.08);
    expect(rec.simLng).toBe(14.42);
    expect(rec.simKmh).toBe(25);
    expect(rec.phase).toBe('cruise');
    // The server's last raw AVL datum + projection & deviation of it.
    expect(rec.obsDist).toBe(1234);
    expect(rec.projDist).toBe(1250);
    expect(rec.devM).toBe(34);
    expect(rec.statePos).toBe('on_track');
    expect(rec.delayS).toBe(42);
    expect(rec.nextSeq).toBe(7);
    // Exact raw GPS: coordinates + accuracy + speed, verbatim.
    expect(rec.gpsLat).toBe(50.0);
    expect(rec.gpsLng).toBe(14.41);
    expect(rec.gpsAcc).toBe(5);
    expect(rec.gpsSpeed).toBe(6.2);
    // Where WE are: filtered position + BOTH projections onto the shape.
    expect(rec.fLat).toBeCloseTo(50.0, 6);
    expect(rec.fLng).toBeCloseTo(14.41, 6);
    expect(rec.rej).toBeNull();
    expect(rec.gpsDist).toBeCloseTo(715, 0);
    expect(rec.gpsOffM).toBeCloseTo(0, 0);
    expect(rec.lagM).toBeCloseTo(1200 - 715, 0);
    expect(rec.fDist).toBeCloseTo(715, 0);
    expect(rec.fOffM).toBeCloseTo(0, 0);
    expect(rec.fLagM).toBeCloseTo(1200 - 715, 0);
    // Rendering-judgment context.
    expect(rec.posMode).toBe('smooth');
    expect(rec.bias).toBe(1.07);
  });

  it('v3 lines remain a strict prefix of v4 lines (old parsers unaffected)', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201'));
    await h.log.startRide('9201');
    h.location.push({ t: h.now() });
    const rel = h.log.rideInfo()!.relPath;
    await h.log.stopRide();

    const keys = Object.keys(JSON.parse(h.fs.lines(rel)[1]));
    const v3Tail = ['bias', 'posMode', 'gpsDist', 'gpsOffM', 'lagM'];
    const v4Appended = ['tripId', 'fLat', 'fLng', 'rej', 'fDist', 'fOffM', 'fLagM'];
    expect(keys.slice(-12)).toEqual([...v3Tail, ...v4Appended]);
  });

  it('outlier fixes are written raw, flagged with rej, and counted', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201'));
    h.geomMap.set('9201', straightGeometry());
    await h.log.startRide('9201');

    h.location.push({ t: 1_000_000, lat: 50.0, lng: 14.41, accuracy: 5 });
    // Teleport ~1.1 km north one second later — physically impossible.
    h.location.push({ t: 1_001_000, lat: 50.01, lng: 14.41, accuracy: 5 });
    // Garbage accuracy.
    h.location.push({ t: 1_002_000, lat: 50.0, lng: 14.411, accuracy: 90 });

    const rel = h.log.rideInfo()!.relPath;
    const info = h.log.rideInfo()!;
    expect(info.gpsRejects).toBe(2);
    const saved = await h.log.stopRide();
    expect(saved!.gpsRejects).toBe(2);

    const [, ok, jump, acc] = h.fs.lines(rel).map((l) => JSON.parse(l));
    expect(ok.rej).toBeNull();
    // Raw values are preserved verbatim even for rejects…
    expect(jump.gpsLat).toBe(50.01);
    expect(jump.rej).toBe('jump');
    expect(acc.gpsAcc).toBe(90);
    expect(acc.rej).toBe('acc');
    // …while the filtered position ignores the teleport (coasts on the shape).
    expect(jump.fLat).toBeCloseTo(50.0, 2);
    expect(Math.abs(jump.fDist - ok.fDist)).toBeLessThan(50);
    // Parser surfaces the reject count.
    const parsed = parseRideFile(h.fs.read(rel));
    expect(parsed.rejectedPoints).toBe(2);
    expect(parsed.meanFLagM).not.toBeNull();
  });
});

// ── (2) motion batches — crash-safe high-rate recording ──────────────────────

describe('ride schema v4 — motion (IMU) batches', () => {
  it('buffers samples and appends ONE motion line per MOTION_FLUSH_AT samples', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201'));
    await h.log.startRide('9201');
    const rel = h.log.rideInfo()!.relPath;
    expect(h.motion.started).toBe(1);

    // One shy of the batch size: nothing on disk yet (header only).
    for (let i = 0; i < MOTION_FLUSH_AT - 1; i++) h.motion.push(h.now() + i * 40);
    expect(h.fs.lines(rel)).toHaveLength(1);

    h.motion.push(h.now() + (MOTION_FLUSH_AT - 1) * 40);
    const lines = h.fs.lines(rel);
    expect(lines).toHaveLength(2);
    const batch = JSON.parse(lines[1]);
    expect(batch.type).toBe('motion');
    expect(batch.n).toBe(MOTION_FLUSH_AT);
    expect(batch.s).toHaveLength(MOTION_FLUSH_AT);
    // Compact per-sample arrays: [dt, ax, ay, az, ra, rb, rg, oa, ob, og].
    expect(batch.s[0]).toEqual([0, 0.101, -0.052, 0.003, 1.5, -0.25, 0.1, 0.5, 0.01, -1.2]);
    expect(batch.s[1][0]).toBe(40); // dt relative to t0
    expect(batch.t0).toBe(h.now());
    expect(h.log.rideInfo()!.motionSamples).toBe(MOTION_FLUSH_AT);
    await h.log.stopRide();
  });

  it('time-based flush: a slow sample stream still lands within MOTION_FLUSH_MS', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;

    h.motion.push(h.now());
    expect(h.fs.lines(rel)).toHaveLength(1); // buffered
    h.advance(MOTION_FLUSH_MS + 1);
    h.motion.push(h.now());
    expect(h.fs.lines(rel)).toHaveLength(2); // flushed by the time check
    expect(JSON.parse(h.fs.lines(rel)[1]).n).toBe(2);
    await h.log.stopRide();
  });

  it('a GPS callback drains an overdue motion buffer (background backstop)', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;

    h.motion.push(h.now()); // buffered, under both thresholds
    h.advance(MOTION_FLUSH_MS + 1);
    h.location.push({ t: h.now() }); // no further motion samples arrive
    const lines = h.fs.lines(rel);
    // header + GPS point + flushed motion batch
    expect(lines.some((l) => JSON.parse(l).type === 'motion')).toBe(true);
    await h.log.stopRide();
  });

  it('stopRide drains the tail batch BEFORE the footer and reports totals', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;
    for (let i = 0; i < 7; i++) h.motion.push(h.now() + i * 40); // < flush size

    const saved = await h.log.stopRide();
    expect(h.motion.stopped).toBe(1);
    expect(saved!.motionSamples).toBe(7);
    const lines = h.fs.lines(rel).map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    const secondLast = lines[lines.length - 2];
    expect(secondLast.type).toBe('motion');
    expect(secondLast.n).toBe(7);
    expect(last).toMatchObject({ type: 'ride-end', motionSamples: 7 });
  });

  it('append failures retain samples (bounded) and recover on the next flush', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;

    h.fs.failAppends = true;
    for (let i = 0; i < MOTION_MAX_PENDING + 100; i++) h.motion.push(h.now() + i);
    expect(h.fs.lines(rel)).toHaveLength(1); // nothing landed, nothing thrown

    h.fs.failAppends = false;
    for (let i = 0; i < MOTION_FLUSH_AT; i++) h.motion.push(h.now() + 100_000 + i);
    const batches = h.fs
      .lines(rel)
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === 'motion');
    const total = batches.reduce((n, b) => n + b.n, 0);
    // The retained buffer was capped at MOTION_MAX_PENDING, then drained.
    expect(total).toBeGreaterThanOrEqual(MOTION_MAX_PENDING);
    expect(total).toBeLessThanOrEqual(MOTION_MAX_PENDING + MOTION_FLUSH_AT);
    await h.log.stopRide();
  });

  it('a sensor-start failure degrades to a GPS-only ride, never a failed one', async () => {
    const h = makeLog();
    h.motion.fail = true;
    expect(await h.log.startRide('a')).toBe(true);
    expect(h.log.rideMotionActive()).toBe(false);
    h.location.push({ t: h.now() });
    expect(h.log.rideInfo()!.points).toBe(1);
    const saved = await h.log.stopRide();
    expect(saved!.motionSamples).toBe(0);
  });

  it('an orphaned (crashed) ride keeps its flushed motion batches and parses', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;
    h.location.push({ t: h.now() });
    for (let i = 0; i < MOTION_FLUSH_AT; i++) h.motion.push(h.now() + i * 40); // flushed batch
    h.motion.push(h.now() + 99_999); // still buffered — lost on crash (≤1 s worth)

    // Simulate process death: no stopRide, new MotionLog instance recovers.
    const h2 = makeLog();
    for (const [k, v] of h.fs.files) h2.fs.files.set(k, v);
    expect(h2.log.recoverOrphanRides()).toBe(1);
    const parsed = parseRideFile(h2.fs.read(rel));
    expect(parsed.orphaned).toBe(true);
    expect(parsed.points).toBe(1);
    expect(parsed.motionSamples).toBe(MOTION_FLUSH_AT);
  });

  it('motionRecord tolerates null channels (devices without a gyro)', () => {
    const rec = JSON.parse(
      motionRecord([
        { t: 5, ax: null, ay: null, az: null, ra: null, rb: null, rg: null, oa: null, ob: null, og: null },
      ]),
    );
    expect(rec.s[0]).toEqual([0, null, null, null, null, null, null, null, null, null]);
  });
});
