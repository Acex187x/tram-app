/// <reference types="jest" />
//
// TramRuntime over the TramFeed boundary: a FakeFeed drives the runtime the
// way LocalGolemioFeed (or a future RemoteFeed) would — snapshot batches are
// PUSHED in, geometry resolves through feed.getGeometry, missing geometries
// are warmed via feed.requestGeometry (+ the 2.5 s re-ingest nudge),
// calibration records flow back out through feed.reportCalibration, and the
// status chip reads feed.status(). No fetch/poll plumbing in the runtime.

import { TramRuntime } from '@/hooks/tramData';
import type {
  CalibrationRecord,
  FeedPriority,
  FeedStatus,
  TramFeed,
} from '@/lib/feed/types';
import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import { makeGeometry, makeSnapshot } from './helpers';

// Settings store stub: no zustand-persist / file-system side effects.
jest.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({ positionMode: 'smooth' }),
    subscribe: () => () => {},
  },
}));

const T0 = 1_000_000_000_000;

type SnapshotCb = (snapshots: TramSnapshot[], atMs: number) => void;

class FakeFeed implements TramFeed {
  started = 0;
  stopped = 0;
  listeners = new Set<SnapshotCb>();
  geometries = new Map<string, RouteGeometry>();
  requested: { tripIds: string[]; priority: FeedPriority }[] = [];
  promoted: string[] = [];
  calibrationBatches: CalibrationRecord[][] = [];
  lastBatchAtMs = 0;
  lastError: string | null = null;

  subscribeSnapshots(cb: SnapshotCb): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getGeometry(tripId: string): RouteGeometry | undefined {
    return this.geometries.get(tripId);
  }

  requestGeometry(tripIds: string[], priority: FeedPriority): void {
    this.requested.push({ tripIds, priority });
  }

  promoteGeometry(tripId: string): void {
    this.promoted.push(tripId);
  }

  reportCalibration(records: CalibrationRecord[]): void {
    this.calibrationBatches.push(records);
  }

  status(): FeedStatus {
    return { lastBatchAtMs: this.lastBatchAtMs, lastError: this.lastError };
  }

  start(): void {
    this.started += 1;
  }

  stop(): void {
    this.stopped += 1;
  }

  /** Test driver: emit one snapshot batch as the real feed would. */
  push(snapshots: TramSnapshot[], atMs: number): void {
    this.lastBatchAtMs = atMs;
    this.listeners.forEach((l) => l(snapshots, atMs));
  }
}

function makeGeo(): RouteGeometry {
  return makeGeometry(
    [
      [0, 0],
      [2000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - 100_000 },
      { atM: 500, arrivalMs: T0 + 50_000, departureMs: T0 + 70_000, dwellSeconds: 20 },
      { atM: 2000, arrivalMs: T0 + 260_000, isTerminal: true },
    ],
  );
}

describe('TramRuntime driven by an injected TramFeed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setup() {
    const feed = new FakeFeed();
    const rt = new TramRuntime(feed);
    rt.retain();
    return { feed, rt };
  }

  it('retain() subscribes + starts the feed; release() stops + unsubscribes', () => {
    const { feed, rt } = setup();
    expect(feed.started).toBe(1);
    expect(feed.listeners.size).toBe(1);

    rt.release();
    expect(feed.stopped).toBe(1);
    expect(feed.listeners.size).toBe(0);
  });

  it('a pushed batch is ingested and geometry resolves through the feed', () => {
    const { feed, rt } = setup();
    feed.geometries.set('trip-test', makeGeo());

    feed.push([makeSnapshot({ shapeDistM: 300, observedAtMs: T0 })], T0);

    const state = rt.engine.getState('9201', T0);
    expect(state).toBeDefined();
    expect(state!.hasGeometry).toBe(true);
    expect(state!.model.id).toBe('15t'); // resolved via the real fleet registry
    // Sim anchored near the observation (trail-biased, so at/behind the fix).
    expect(state!.simDistM).toBeGreaterThan(0);
    expect(state!.simDistM).toBeLessThanOrEqual(300);
    rt.release();
  });

  it('missing geometry → background requestGeometry, then the 2.5 s nudge adopts it', () => {
    const { feed, rt } = setup();

    feed.push([makeSnapshot({ shapeDistM: 300, observedAtMs: T0 })], T0);
    expect(feed.requested).toEqual([{ tripIds: ['trip-test'], priority: 2 }]);
    expect(rt.engine.getState('9201', T0)!.hasGeometry).toBe(false);

    // Geometry "arrives" in the cache; the nudge re-ingests without a new push.
    feed.geometries.set('trip-test', makeGeo());
    jest.advanceTimersByTime(2_500);
    expect(rt.engine.getState('9201', Date.now())!.hasGeometry).toBe(true);
    rt.release();
  });

  it('does not request geometry it already has', () => {
    const { feed, rt } = setup();
    feed.geometries.set('trip-test', makeGeo());
    feed.push([makeSnapshot({ shapeDistM: 300, observedAtMs: T0 })], T0);
    expect(feed.requested).toHaveLength(0);
    rt.release();
  });

  it('reports one calibration batch per push, records shaped from engine states', () => {
    const { feed, rt } = setup();
    feed.geometries.set('trip-test', makeGeo());
    feed.push([makeSnapshot({ shapeDistM: 300, observedAtMs: T0 })], T0);

    expect(feed.calibrationBatches).toHaveLength(1);
    const [batch] = feed.calibrationBatches;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      t: T0,
      key: '9201',
      model: '15t',
      line: '9',
      obsDist: 300,
    });
    expect(batch[0].mode).toBeDefined();
    rt.release();
  });

  it('reports an empty batch when no tram has geometry (keeps the flush clock ticking)', () => {
    const { feed, rt } = setup();
    feed.push([makeSnapshot({ shapeDistM: 300, observedAtMs: T0 })], T0);
    expect(feed.calibrationBatches).toEqual([[]]);
    rt.release();
  });

  it('prioritizeTrip forwards to feed.promoteGeometry (and guards null)', () => {
    const { feed, rt } = setup();
    rt.prioritizeTrip('trip-test');
    rt.prioritizeTrip(null);
    rt.prioritizeTrip(undefined);
    expect(feed.promoted).toEqual(['trip-test']);
    rt.release();
  });

  it('status chip fields read feed.status()', () => {
    const { feed, rt } = setup();
    expect(rt.lastPollAtMs).toBe(0);
    expect(rt.lastError).toBeNull();

    feed.push([], T0);
    expect(rt.lastPollAtMs).toBe(T0);

    feed.lastError = 'network down';
    expect(rt.lastError).toBe('network down');
    rt.release();
  });

  it('after release() a push reaches no listener (no zombie ingest)', () => {
    const { feed, rt } = setup();
    rt.release();
    feed.push([makeSnapshot({ shapeDistM: 300, observedAtMs: T0 })], T0);
    expect(rt.engine.getState('9201', T0)).toBeUndefined();
  });
});
