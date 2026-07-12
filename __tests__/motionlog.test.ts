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
  dayStamp,
  logPartRel,
  type LocationSample,
  type LocationWatcher,
  type MotionFileInfo,
  type MotionLogDeps,
  type MotionLogFS,
} from '@/lib/motionlog/core';
import type { TramPublicState } from '@/lib/types';

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
    projectedObservedDistM: 1250,
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

  const deps: MotionLogDeps = {
    fs,
    location,
    now: () => now,
    stateProvider: (key) => stateMap.get(key),
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
  it('records GPS+sim samples to a ride file and returns its uri on stop', async () => {
    const h = makeLog();
    h.stateMap.set('9201', makeState('9201'));

    const ok = await h.log.startRide('9201');
    expect(ok).toBe(true);
    expect(h.log.isRiding()).toBe(true);
    expect(h.location.started).toBe(1);

    h.location.push({ lat: 50.081, lng: 14.421, speed: 6.2, accuracy: 3 });
    h.location.push({ lat: 50.082, lng: 14.422, speed: 7.1, accuracy: 3 });

    const info = h.log.rideInfo();
    expect(info?.points).toBe(2);

    const uri = await h.log.stopRide();
    expect(uri).toMatch(/^file:\/\/\/fake\/rides\/.*-9201\.jsonl$/);
    expect(h.log.isRiding()).toBe(false);
    expect(h.location.stopped).toBe(1);

    const rel = info!.relPath;
    const lines = h.fs.lines(rel);
    expect(lines).toHaveLength(2);
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ gpsLat: 50.081, gpsSpeed: 6.2, model: '15t', line: '9', simDist: 1200 });
  });

  it('records nulls for sim fields when no state is available', async () => {
    const h = makeLog();
    await h.log.startRide('unknown');
    h.location.push({ lat: 50.09, lng: 14.4 });
    const rel = h.log.rideInfo()!.relPath;
    await h.log.stopRide();
    const rec = JSON.parse(h.fs.lines(rel)[0]);
    expect(rec.simDist).toBeNull();
    expect(rec.model).toBeNull();
    expect(rec.gpsLat).toBe(50.09);
  });

  it('allows only one ride at a time', async () => {
    const h = makeLog();
    expect(await h.log.startRide('a')).toBe(true);
    expect(await h.log.startRide('b')).toBe(false);
    expect(h.log.rideInfo()?.key).toBe('a');
    expect(h.location.started).toBe(1);
  });

  it('returns false and stays idle when permission is denied', async () => {
    const h = makeLog();
    h.location.denied = true;
    expect(await h.log.startRide('a')).toBe(false);
    expect(h.log.isRiding()).toBe(false);
  });

  it('auto-stops the ride after RIDE_MAX_MS', async () => {
    const h = makeLog();
    await h.log.startRide('a');
    expect(h.log.isRiding()).toBe(true);
    h.advance(RIDE_MAX_MS + 1);
    expect(h.log.isRiding()).toBe(false);
    expect(h.location.stopped).toBe(1);
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
