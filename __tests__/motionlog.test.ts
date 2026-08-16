// Unit tests for the MotionLog core: the daily-log ring buffer + throttled
// flush, on-disk cap eviction, and GPS ride recording. All I/O, time, timers
// and location are faked so the buffering/flush/eviction logic is exercised in
// isolation with no native modules.
import {
  FLUSH_AT_LINES,
  FLUSH_MS,
  LOG_DIR,
  MAX_PENDING,
  MotionLog,
  RIDE_DIR,
  RIDE_MAX_MS,
  RIDE_SCHEMA,
  dayStamp,
  logPartRel,
  type LocationSample,
  type LocationWatcher,
  type MotionFileInfo,
  type MotionLogDeps,
  type MotionLogFS,
} from '@/lib/motionlog/core';
import { parseRideFile } from '@/lib/motionlog/rideFile';
import type { RouteGeometry, TramPublicState } from '@/lib/types';

// ── in-memory fake filesystem ────────────────────────────────────────────────

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
      const dir = slash >= 0 ? relPath.slice(0, slash) : '';
      if (dir !== relDir) continue;
      out.push({
        relPath,
        name: relPath.slice(slash + 1),
        uri: this.uri(relPath),
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

// ── fake location watcher ────────────────────────────────────────────────────

class FakeLocation implements LocationWatcher {
  emit: ((s: LocationSample) => void) | null = null;
  started = 0;
  stopped = 0;
  denied = false;

  async start(onSample: (s: LocationSample) => void): Promise<() => void> {
    if (this.denied) throw new Error('denied');
    this.started += 1;
    this.emit = onSample;
    return () => {
      this.stopped += 1;
      this.emit = null;
    };
  }

  push(partial: Partial<LocationSample> = {}): void {
    this.emit?.({ t: 0, lat: 50.08, lng: 14.42, speed: 5, accuracy: 4, ...partial });
  }
}

// ── fake tram state ──────────────────────────────────────────────────────────

function makeState(key: string, over: Partial<TramPublicState> = {}): TramPublicState {
  return {
    key,
    snapshot: {
      line: '9',
      shapeDistM: 1234,
      tripId: 't',
      registrationNumber: 9201,
      observedAtMs: 999_500,
      statePosition: 'at_stop',
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
    fixedDistM: 1250,
    pastHorizon: false,
    nextStopName: 'Anděl',
    nextStopEtaS: 40,
    hasGeometry: true,
    ...over,
  } as unknown as TramPublicState;
}

// ── harness ──────────────────────────────────────────────────────────────────

interface Timer {
  fn: () => void;
  at: number;
}

function makeLog(over: Partial<MotionLogDeps> = {}) {
  let now = 1_000_000;
  const timers: Timer[] = [];
  const fs = new FakeFS(() => now);
  const location = new FakeLocation();
  const stateMap = new Map<string, TramPublicState>();
  const geomMap = new Map<string, RouteGeometry>();

  const deps: MotionLogDeps = {
    fs,
    location,
    now: () => now,
    stateProvider: (key) => stateMap.get(key),
    geometry: (key) => geomMap.get(key),
    setTimeout: ((fn: () => void, ms: number) => {
      const t: Timer = { fn, at: now + ms };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    }) as MotionLogDeps['setTimeout'],
    clearTimeout: ((h: unknown) => {
      const i = timers.indexOf(h as Timer);
      if (i >= 0) timers.splice(i, 1);
    }) as MotionLogDeps['clearTimeout'],
    ...over,
  };

  const log = new MotionLog(deps);
  return {
    log,
    fs,
    location,
    stateMap,
    geomMap,
    advance(ms: number) {
      now += ms;
      for (const t of [...timers]) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
    setNow(v: number) {
      now = v;
    },
    now: () => now,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('MotionLog daily logging', () => {
  it('buffers only trams with geometry and does not flush immediately', () => {
    const h = makeLog();
    h.log.onPoll(
      [makeState('a'), makeState('b', { hasGeometry: false }), makeState('c')],
      h.now(),
    );
    // Two geometry-bearing trams buffered, nothing written yet.
    expect(h.log.stats().pending).toBe(2);
    expect(h.fs.files.size).toBe(0);
  });

  it('flushes after FLUSH_MS elapses and writes JSONL to the daily file', () => {
    const h = makeLog();
    const t0 = h.now();
    h.log.onPoll([makeState('a')], t0);
    expect(h.fs.files.size).toBe(0);

    h.setNow(t0 + FLUSH_MS + 1);
    h.log.onPoll([makeState('a')], h.now());

    const rel = `${LOG_DIR}/${dayStamp(h.now())}.jsonl`;
    const lines = h.fs.lines(rel);
    expect(lines).toHaveLength(2);
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ key: 'a', model: '15t', line: '9', obsDist: 1234, simDist: 1200 });
    // R7 (schema v2): raw AVL context for dwell/feed-speed analysis.
    expect(rec).toMatchObject({ obsAt: 999_500, statePos: 'at_stop', delayS: 42, nextSeq: 7 });
    // New keys are appended AFTER the historic ones — old lines stay a prefix.
    const keys = Object.keys(rec);
    expect(keys.slice(-4)).toEqual(['obsAt', 'statePos', 'delayS', 'nextSeq']);
    expect(keys.indexOf('mode')).toBe(keys.length - 5);
  });

  it('force-flushes once the buffer reaches FLUSH_AT_LINES', () => {
    const h = makeLog();
    const states = Array.from({ length: FLUSH_AT_LINES }, (_, i) => makeState(`k${i}`));
    h.log.onPoll(states, h.now());
    expect(h.log.stats().pending).toBe(0);
    expect(h.fs.files.size).toBe(1);
  });

  it('caps memory at MAX_PENDING and retains data across write failures', () => {
    const h = makeLog();
    h.fs.failAppends = true;
    const batch = Array.from({ length: FLUSH_AT_LINES }, (_, i) => makeState(`k${i}`));

    // Each poll force-flushes (>= FLUSH_AT_LINES) but the write fails, so lines
    // are re-buffered. Pump until well past the cap.
    for (let i = 0; i < Math.ceil((MAX_PENDING / FLUSH_AT_LINES) + 2); i++) {
      h.log.onPoll(batch, h.now());
    }
    expect(h.log.stats().pending).toBe(MAX_PENDING);
    expect(h.fs.files.size).toBe(0);

    // FS recovers → the retained buffer drains on the next flush.
    h.fs.failAppends = false;
    h.log.flush(h.now());
    expect(h.log.stats().pending).toBe(0);
    const rel = `${LOG_DIR}/${dayStamp(h.now())}.jsonl`;
    expect(h.fs.lines(rel)).toHaveLength(MAX_PENDING);
  });

  it('evicts the oldest files first when the directory exceeds its cap', () => {
    // Cap = one ~300-byte old file + one flushed record line (~220 B since the
    // R7 schema-v2 fields) — so eviction must drop exactly the two oldest files.
    const h = makeLog({ dirCapBytes: 600 });
    // Three ~300-byte log files at increasing timestamps.
    for (let i = 0; i < 3; i++) {
      h.fs.append(`${LOG_DIR}/day${i}.jsonl`, 'x'.repeat(300));
      h.advance(1_000);
    }
    expect(h.fs.files.size).toBe(3);
    // A flush triggers eviction down to <= cap (keeps only the newest old file).
    h.log.onPoll([makeState('a')], h.now());
    h.log.flush(h.now());
    const remaining = [...h.fs.files.keys()].filter((k) => k.startsWith(`${LOG_DIR}/day`));
    expect(remaining).toEqual([`${LOG_DIR}/day2.jsonl`]);
    // R9: today's active daily log is untouched by the eviction.
    expect(h.fs.files.has(`${LOG_DIR}/${dayStamp(h.now())}.jsonl`)).toBe(true);
  });
});

describe('MotionLog R9 — active daily log survives the disk cap', () => {
  it('never evicts today’s active daily log even when it alone exceeds the cap', () => {
    // Cap far below a single record line (~220 B): the active daily log is
    // protected, so it may overflow the shared cap instead of being deleted.
    const h = makeLog({ dirCapBytes: 100 });
    const rel = `${LOG_DIR}/${dayStamp(h.now())}.jsonl`;

    h.log.onPoll([makeState('a')], h.now());
    h.log.flush(h.now());
    expect(h.fs.files.has(rel)).toBe(true);

    // Repeated over-cap flushes keep appending — no data holes.
    h.log.onPoll([makeState('a')], h.now());
    h.log.flush(h.now());
    expect(h.fs.lines(rel)).toHaveLength(2);
  });

  it('evicts old files to make room but keeps today’s log when over cap', () => {
    const h = makeLog({ dirCapBytes: 100 });
    h.fs.append(`${LOG_DIR}/old.jsonl`, 'x'.repeat(50));
    h.advance(1_000);

    h.log.onPoll([makeState('a')], h.now());
    h.log.flush(h.now());

    expect(h.fs.files.has(`${LOG_DIR}/old.jsonl`)).toBe(false);
    expect(h.fs.files.has(`${LOG_DIR}/${dayStamp(h.now())}.jsonl`)).toBe(true);
  });

  it('rotates the active log at the soft ceiling and exports every part', async () => {
    // Ceiling of 10 B: every flushed record (~220 B) fills the active part, so
    // each flush retires its part and the next one opens '<date>.N.jsonl'.
    const h = makeLog({ activeLogRotateBytes: 10 });
    const day = dayStamp(h.now());

    for (let i = 0; i < 3; i++) {
      h.log.onPoll([makeState(`k${i}`)], h.now());
      h.log.flush(h.now());
      h.advance(1_000);
    }

    const parts = [logPartRel(day, 0), logPartRel(day, 1), logPartRel(day, 2)];
    expect(parts).toEqual([
      `${LOG_DIR}/${day}.jsonl`,
      `${LOG_DIR}/${day}.1.jsonl`,
      `${LOG_DIR}/${day}.2.jsonl`,
    ]);
    for (const rel of parts) expect(h.fs.lines(rel)).toHaveLength(1);

    // listLogFiles + exportAll see the rotated parts, not just the base file.
    expect(h.log.listLogFiles().map((f) => f.relPath).sort()).toEqual([...parts].sort());
    const uris = await h.log.exportAll();
    for (const rel of parts) expect(uris).toContain(`file:///fake/${rel}`);
  });

  it('rotated archive parts become evictable while the active part is kept', () => {
    // Cap fits one ~220 B record; ceiling 10 B forces rotation on every flush.
    const h = makeLog({ dirCapBytes: 300, activeLogRotateBytes: 10 });
    const day = dayStamp(h.now());

    h.log.onPoll([makeState('a')], h.now());
    h.log.flush(h.now()); // writes part 0 (under cap), then retires it
    h.advance(1_000);
    h.log.onPoll([makeState('b')], h.now());
    h.log.flush(h.now()); // writes part 1 → over cap → part 0 (archive) evicted

    expect(h.fs.files.has(logPartRel(day, 0))).toBe(false);
    expect(h.fs.lines(logPartRel(day, 1))).toHaveLength(1);
  });

  it('resumes at the highest existing part after a restart', () => {
    const h = makeLog({ activeLogRotateBytes: 10 });
    const day = dayStamp(h.now());
    // A previous run left a full base part behind.
    h.fs.append(logPartRel(day, 0), 'x'.repeat(20));

    h.log.onPoll([makeState('a')], h.now());
    h.log.flush(h.now());

    // The full part is not appended to — writing resumed on part 1.
    expect(h.fs.files.get(logPartRel(day, 0))!.content).toBe('x'.repeat(20));
    expect(h.fs.lines(logPartRel(day, 1))).toHaveLength(1);

    // A part still under the ceiling IS resumed (no gratuitous rotation).
    const h2 = makeLog({ activeLogRotateBytes: 1_000_000 });
    h2.fs.append(logPartRel(day, 1), 'y'.repeat(20) + '\n');
    h2.log.onPoll([makeState('a')], h2.now());
    h2.log.flush(h2.now());
    expect(h2.fs.lines(logPartRel(day, 1))).toHaveLength(2);
    expect(h2.fs.files.has(logPartRel(day, 2))).toBe(false);
  });
});

describe('MotionLog ride recording', () => {
  it('records GPS+sim samples to a ride file and returns the saved file on stop', async () => {
    const h = makeLog({ positionMode: () => 'live' });
    h.stateMap.set('9201', makeState('9201'));

    const ok = await h.log.startRide('9201');
    expect(ok).toBe(true);
    expect(h.log.isRiding()).toBe(true);
    expect(h.location.started).toBe(1);

    h.location.push({ lat: 50.081, lng: 14.421, speed: 6.2, accuracy: 3 });
    h.location.push({ lat: 50.082, lng: 14.422, speed: 7.1, accuracy: 3 });

    const info = h.log.rideInfo();
    expect(info?.points).toBe(2);
    expect(info?.lastPointMs).toBe(h.now());

    const saved = await h.log.stopRide();
    expect(saved?.uri).toMatch(/^file:\/\/\/fake\/rides\/.*-9201\.jsonl$/);
    expect(saved?.points).toBe(2);
    expect(saved?.bytes).toBeGreaterThan(0);
    expect(h.log.isRiding()).toBe(false);
    expect(h.location.stopped).toBe(1);

    const rel = info!.relPath;
    const lines = h.fs.lines(rel);
    // v3: header + 2 points + footer.
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0])).toEqual({
      type: 'ride-start',
      tramKey: '9201',
      model: '15t',
      line: '9',
      t: info!.startedMs,
      schema: RIDE_SCHEMA,
      tripId: 't',
    });
    expect(JSON.parse(lines[3])).toMatchObject({ type: 'ride-end', points: 2 });
    const rec = JSON.parse(lines[1]);
    expect(rec).toMatchObject({ gpsLat: 50.081, gpsSpeed: 6.2, model: '15t', line: '9', simDist: 1200 });
    // Ride schema v2: raw AVL context + the (now always null) bias column +
    // the active render mode. paceBias died with the client engine — pace is
    // learned server-side — but the COLUMN stays so old JSONL parsers keep
    // seeing a strict prefix.
    expect(rec).toMatchObject({
      obsAt: 999_500,
      statePos: 'at_stop',
      delayS: 42,
      nextSeq: 7,
      bias: null,
      posMode: 'live',
    });
    // v3 fields are null without geometry.
    expect(rec.gpsDist).toBeNull();
    expect(rec.gpsOffM).toBeNull();
    expect(rec.lagM).toBeNull();
    // New keys are appended AFTER the historic ones — old lines stay a prefix.
    const keys = Object.keys(rec);
    expect(keys.slice(-16)).toEqual([
      'obsAt', 'statePos', 'delayS', 'nextSeq', 'bias', 'posMode',
      'gpsDist', 'gpsOffM', 'lagM',
      'tripId', 'fLat', 'fLng', 'rej', 'fDist', 'fOffM', 'fLagM',
    ]);
    expect(keys.indexOf('phase')).toBe(keys.length - 17);
  });

  it('records nulls for sim fields when no state is available', async () => {
    const h = makeLog();
    await h.log.startRide('unknown');
    h.location.push({ lat: 50.09, lng: 14.4 });
    const rel = h.log.rideInfo()!.relPath;
    await h.log.stopRide();
    const rec = JSON.parse(h.fs.lines(rel)[1]); // line 0 is the header
    expect(rec.simDist).toBeNull();
    expect(rec.model).toBeNull();
    expect(rec.gpsLat).toBe(50.09);
    // v2 fields are null without a state; posMode is null without the seam.
    expect(rec.obsAt).toBeNull();
    expect(rec.statePos).toBeNull();
    expect(rec.delayS).toBeNull();
    expect(rec.nextSeq).toBeNull();
    expect(rec.bias).toBeNull();
    expect(rec.posMode).toBeNull();
  });

  it('allows only one ride at a time', async () => {
    const h = makeLog();
    expect(await h.log.startRide('a')).toBe(true);
    expect(await h.log.startRide('b')).toBe(false);
    expect(h.log.rideInfo()?.key).toBe('a');
    expect(h.location.started).toBe(1);
  });

  it('returns false, stays idle and leaves no phantom file when permission is denied', async () => {
    const h = makeLog();
    h.location.denied = true;
    expect(await h.log.startRide('a')).toBe(false);
    expect(h.log.isRiding()).toBe(false);
    // The eagerly-created header-only file is cleaned up — nothing was recorded.
    expect(h.fs.list(RIDE_DIR)).toHaveLength(0);
  });

  it('auto-stops the ride after RIDE_MAX_MS', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    expect(h.log.isRiding()).toBe(true);
    h.advance(RIDE_MAX_MS + 1);
    expect(h.log.isRiding()).toBe(false);
    expect(h.location.stopped).toBe(1);
  });

  it('enforces the deadline in the location callback even when the JS timer never fires (suspension)', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;
    h.location.push();
    expect(h.log.rideInfo()!.points).toBe(1);

    // Simulate iOS suspension: the wall clock jumps past the deadline but the
    // fake timer queue is never run (setNow moves time WITHOUT firing timers).
    h.setNow(h.now() + RIDE_MAX_MS + 1);
    h.location.push(); // first delivery after resume

    // The overdue sample is dropped and the ride stops cleanly with a footer.
    expect(h.log.isRiding()).toBe(false);
    expect(h.location.stopped).toBe(1);
    const lines = h.fs.lines(rel);
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ type: 'ride-end', points: 1 });
  });

  it('a ride started after a deadline-stop gets a fresh deadline', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    h.setNow(h.now() + RIDE_MAX_MS + 1);
    h.location.push(); // deadline-stops ride #1
    expect(h.log.isRiding()).toBe(false);

    expect(await h.log.startRide('b')).toBe(true);
    h.location.push(); // well within ride #2's own deadline
    expect(h.log.isRiding()).toBe(true);
    expect(h.log.rideInfo()!.points).toBe(1);
    await h.log.stopRide();
  });

  it('never evicts the active ride file even over the cap', async () => {
    const h = makeLog({ dirCapBytes: 10 });
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;
    // 30 samples triggers the periodic enforceDirCap; file far exceeds 10 bytes.
    for (let i = 0; i < 30; i++) h.location.push();
    expect(h.fs.files.has(rel)).toBe(true);
    await h.log.stopRide();
  });
});

describe('MotionLog ride crash-safety (v3)', () => {
  it('creates the ride file with a ride-start header IMMEDIATELY on startRide', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201'));
    await h.log.startRide('9201');
    // No GPS fix yet — the file must already exist and be valid JSONL.
    const rel = h.log.rideInfo()!.relPath;
    const lines = h.fs.lines(rel);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'ride-start', tramKey: '9201', schema: RIDE_SCHEMA });
    await h.log.stopRide();
  });

  it('appends every GPS point to disk synchronously (no buffering window)', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    const rel = h.log.rideInfo()!.relPath;
    for (let i = 1; i <= 5; i++) {
      h.location.push();
      // Header + i points, on disk after EVERY sample — a crash loses nothing.
      expect(h.fs.lines(rel)).toHaveLength(1 + i);
    }
    await h.log.stopRide();
  });

  it('THE LOSS BUG: a completed (stopped) ride survives disk-cap eviction even when the active daily log alone exceeds the cap', async () => {
    // Regression for the real-world loss: the active daily-log part may legally
    // exceed the shared cap (R9 rotation ceiling > cap). enforceDirCap then
    // could never get under the cap and deleted EVERY unprotected file — and
    // stopRide un-protected the ride before flushing, so the file the user had
    // just saved was evicted milliseconds later.
    const h = makeLog({ dirCapBytes: 300 });
    await h.log.startRide('a');
    h.location.push();
    const rel = h.log.rideInfo()!.relPath;
    const saved = await h.log.stopRide(); // flush + cap enforcement run inside
    expect(saved).not.toBeNull();

    // Grow the protected active daily log far past the cap, flushing repeatedly.
    for (let i = 0; i < 5; i++) {
      h.advance(1_000);
      h.log.onPoll([makeState('x')], h.now());
      h.log.flush(h.now());
    }
    const logRel = `${LOG_DIR}/${dayStamp(h.now())}.jsonl`;
    expect(h.fs.files.get(logRel)!.content.length).toBeGreaterThan(300);

    // The completed ride is still there, byte-for-byte.
    expect(h.fs.files.has(rel)).toBe(true);
    expect(h.log.listRideFiles().map((f) => f.relPath)).toContain(rel);
  });

  it('writes a ride-end footer on stop and recoverOrphanRides leaves closed files alone', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    h.location.push();
    const rel = h.log.rideInfo()!.relPath;
    await h.log.stopRide();
    const before = h.fs.files.get(rel)!.content;
    expect(JSON.parse(h.fs.lines(rel).at(-1)!)).toMatchObject({ type: 'ride-end', points: 1 });

    expect(h.log.recoverOrphanRides()).toBe(0);
    expect(h.fs.files.get(rel)!.content).toBe(before); // untouched
  });

  it('closes unfooted ride files with a ride-orphaned footer at startup', () => {
    const h = makeLog();
    // A previous process died mid-ride: header + one point, no footer.
    const rel = `${RIDE_DIR}/20260713-101500-9251.jsonl`;
    h.fs.append(rel, '{"type":"ride-start","tramKey":"9251","model":null,"line":null,"t":1,"schema":"v3"}\n');
    h.fs.append(rel, '{"t":2,"gpsLat":50.08,"gpsLng":14.42}\n');
    // Another died so hard the tail line is half-written.
    const relTorn = `${RIDE_DIR}/20260713-090000-8123.jsonl`;
    h.fs.append(relTorn, '{"t":2,"gpsLat":50.08,"gpsLng":14.42}\n{"t":3,"gps');

    expect(h.log.recoverOrphanRides()).toBe(2);
    expect(JSON.parse(h.fs.lines(rel).at(-1)!)).toMatchObject({ type: 'ride-orphaned' });
    // The orphaned file still parses as a valid ride with its data intact.
    const parsed = parseRideFile(h.fs.read(rel));
    expect(parsed.orphaned).toBe(true);
    expect(parsed.points).toBe(1);
    expect(parsed.gpsTrack).toEqual([[14.42, 50.08]]);

    // Recovery is idempotent.
    expect(h.log.recoverOrphanRides()).toBe(0);
  });

  it('does not orphan-close the ACTIVE ride file', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    h.location.push();
    expect(h.log.recoverOrphanRides()).toBe(0);
    expect(h.log.isRiding()).toBe(true);
    await h.log.stopRide();
  });
});

describe('MotionLog ride ground truth (v3 gpsDist/lagM)', () => {
  /** Straight ~1.43 km west→east shape at lat 50 with exact cumDistM. */
  function straightGeometry(): RouteGeometry {
    const coords: [number, number][] = [
      [14.4, 50.0],
      [14.41, 50.0],
      [14.42, 50.0],
    ];
    // Matching cumulative distances (values only need to be consistent —
    // projectPointToPolyline interpolates between them).
    return {
      shapeId: 's',
      tripId: 't',
      routeId: 'r',
      line: '9',
      headsign: 'h',
      coordinates: coords,
      cumDistM: [0, 715, 1430],
      totalM: 1430,
      stops: [],
    } as unknown as RouteGeometry;
  }

  it('projects the GPS fix onto the shape and derives lagM = simDist − gpsDist', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201', { simDistM: 1200 } as Partial<TramPublicState>));
    h.geomMap.set('9201', straightGeometry());
    await h.log.startRide('9201');

    // Rider exactly at the middle vertex → gpsDist = 715, offset 0.
    h.location.push({ lat: 50.0, lng: 14.41 });
    // Rider abeam the first vertex, ~111 m north of the line → gpsDist 0.
    h.location.push({ lat: 50.001, lng: 14.4 });

    const rel = h.log.rideInfo()!.relPath;
    await h.log.stopRide();
    const lines = h.fs.lines(rel);

    const mid = JSON.parse(lines[1]);
    expect(mid.gpsDist).toBeCloseTo(715, 0);
    expect(mid.gpsOffM).toBeCloseTo(0, 0);
    // Sim at 1200 m, real tram (rider) at 715 m → sim runs 485 m AHEAD.
    expect(mid.lagM).toBeCloseTo(1200 - 715, 0);

    const off = JSON.parse(lines[2]);
    expect(off.gpsDist).toBeCloseTo(0, 0);
    expect(off.gpsOffM).toBeCloseTo(111.3, 0);
    expect(off.lagM).toBeCloseTo(1200, 0);
  });

  it('leaves the v3 fields null without geometry and parses meanLagM per file', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201'));
    h.geomMap.set('9201', straightGeometry());
    await h.log.startRide('9201');
    h.location.push({ lat: 50.0, lng: 14.41 });
    h.geomMap.delete('9201'); // geometry lost mid-ride (trip change etc.)
    h.location.push({ lat: 50.0, lng: 14.41 });
    const rel = h.log.rideInfo()!.relPath;
    await h.log.stopRide();

    const withGeom = JSON.parse(h.fs.lines(rel)[1]);
    const withoutGeom = JSON.parse(h.fs.lines(rel)[2]);
    expect(withGeom.lagM).toBeCloseTo(1200 - 715, 0);
    expect(withoutGeom.gpsDist).toBeNull();
    expect(withoutGeom.lagM).toBeNull();

    const parsed = parseRideFile(h.fs.read(rel));
    expect(parsed.points).toBe(2);
    expect(parsed.meanLagM).toBeCloseTo(1200 - 715, 0); // only non-null lags averaged
    expect(parsed.closed).toBe(true);
    expect(parsed.orphaned).toBe(false);
    expect(parsed.line).toBe('9');
  });
});

describe('MotionLog export + stats + clear', () => {
  it('exportAll returns ride uris then log uris, newest first, after flushing', async () => {
    const h = makeLog();
    // A pending log line + a completed ride.
    h.log.onPoll([makeState('a')], h.now());
    await h.log.startRide('a');
    h.location.push();
    await h.log.stopRide();

    const uris = await h.log.exportAll();
    expect(h.log.stats().pending).toBe(0); // exportAll flushed
    expect(uris.some((u) => u.includes('/rides/'))).toBe(true);
    expect(uris.some((u) => u.includes(`/${LOG_DIR}/`))).toBe(true);
    expect(uris[0]).toContain('/rides/'); // rides listed first
  });

  it('reports byte sizes and counts, and clearAll removes everything', async () => {
    const h = makeLog();
    h.log.onPoll([makeState('a')], h.now());
    h.log.flush(h.now());
    await h.log.startRide('a');
    h.location.push();
    await h.log.stopRide();

    let s = h.log.stats();
    expect(s.logCount).toBe(1);
    expect(s.rideCount).toBe(1);
    expect(s.totalBytes).toBe(s.logBytes + s.rideBytes);
    expect(s.totalBytes).toBeGreaterThan(0);

    h.log.clearAll();
    s = h.log.stats();
    expect(s.totalBytes).toBe(0);
    expect(s.logCount).toBe(0);
    expect(s.rideCount).toBe(0);
    expect(h.fs.files.size).toBe(0);
  });

  it('notifies subscribers on ride sample and bumps the version', async () => {
    const h = makeLog();
    let hits = 0;
    const unsub = h.log.subscribe(() => (hits += 1));
    const v0 = h.log.getVersion();
    await h.log.startRide('a'); // notify on claim
    h.location.push(); // notify on sample
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(h.log.getVersion()).toBeGreaterThan(v0);
    unsub();
  });
});
