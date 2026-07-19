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

  geometryListeners = new Set<() => void>();

  subscribeGeometry(cb: () => void): () => void {
    this.geometryListeners.add(cb);
    return () => this.geometryListeners.delete(cb);
  }

  /** Test driver: a geometry "lands" in the cache and the feed announces it. */
  loadGeometry(tripId: string, geometry: RouteGeometry): void {
    this.geometries.set(tripId, geometry);
    this.geometryListeners.forEach((l) => l());
  }

  reportCalibration(records: CalibrationRecord[]): void {
    this.calibrationBatches.push(records);
  }

  status(): FeedStatus {
    return {
      lastBatchAtMs: this.lastBatchAtMs,
      lastError: this.lastError,
      lastFetchAtMs: this.lastBatchAtMs,
      nextFetchAtMs: 0,
      inFlight: false,
      pollIntervalMs: 0,
    };
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
    expect(feed.geometryListeners.size).toBe(1);

    rt.release();
    expect(feed.stopped).toBe(1);
    expect(feed.listeners.size).toBe(0);
    expect(feed.geometryListeners.size).toBe(0);
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

  it('a trip change with no loaded shape requests the new geometry at RAISED priority', () => {
    const { feed, rt } = setup();
    // First poll establishes the tram on trip-test (has geometry, no request).
    feed.geometries.set('trip-test', makeGeo());
    feed.push([makeSnapshot({ tripId: 'trip-test', shapeDistM: 300, observedAtMs: T0 })], T0);
    expect(feed.requested).toHaveLength(0);

    // Endpoint turn: same tram, NEW trip whose shape isn't loaded yet. It now
    // renders geometry-less (a bare dot) — so its shape is fetched at priority 1
    // (raised), not the background 2, to return it to the drawn line fast.
    feed.push(
      [makeSnapshot({ tripId: 'trip-next', shapeDistM: 0, observedAtMs: T0 + 5_000 })],
      T0 + 5_000,
    );
    expect(feed.requested).toContainEqual({ tripIds: ['trip-next'], priority: 1 });
    // …and it is NOT also re-queued behind the background lane.
    expect(feed.requested).not.toContainEqual({ tripIds: ['trip-next'], priority: 2 });
    rt.release();
  });

  it('a VISIBLE tram without geometry warms at RAISED priority; off-screen at background', () => {
    const { feed, rt } = setup();
    // Map registers the live viewport (ORIGIN [14.6, 50.05] is inside it).
    rt.setViewportProvider(() => ({ bbox: [14.5, 50.0, 14.7, 50.1], zoom: 14 }));

    feed.push(
      [
        makeSnapshot({ key: '9201', registrationNumber: 9201, tripId: 'trip-vis' }),
        makeSnapshot({
          key: '9202',
          registrationNumber: 9202,
          tripId: 'trip-far',
          coordinates: [15.6, 49.5], // far outside the viewport (+ margin)
        }),
      ],
      T0,
    );

    expect(feed.requested).toContainEqual({ tripIds: ['trip-vis'], priority: 1 });
    expect(feed.requested).toContainEqual({ tripIds: ['trip-far'], priority: 2 });
    // The visible trip is NOT also queued behind the background lane.
    expect(feed.requested).not.toContainEqual({ tripIds: ['trip-vis'], priority: 2 });
    rt.release();
  });

  it('without a viewport provider every missing geometry warms at background (pre-map behavior)', () => {
    const { feed, rt } = setup();
    feed.push([makeSnapshot({ tripId: 'trip-test' })], T0);
    expect(feed.requested).toEqual([{ tripIds: ['trip-test'], priority: 2 }]);
    rt.release();
  });

  it('a cold-start burst warms VISIBLE trams nearest the viewport center first', () => {
    const { feed, rt } = setup();
    // Viewport center is [14.6, 50.05].
    rt.setViewportProvider(() => ({ bbox: [14.5, 50.0, 14.7, 50.1], zoom: 13.8 }));

    // Whole-fleet cold start: everything in one batch, nothing cached. The
    // visible lane must be enqueued nearest-to-center first — within one
    // scheduler priority the queue drains in insertion order, so this decides
    // which loading dots materialize first.
    feed.push(
      [
        makeSnapshot({
          key: '9301',
          registrationNumber: 9301,
          tripId: 'trip-edge',
          coordinates: [14.68, 50.09],
        }),
        makeSnapshot({
          key: '9302',
          registrationNumber: 9302,
          tripId: 'trip-center',
          coordinates: [14.601, 50.051],
        }),
        makeSnapshot({
          key: '9303',
          registrationNumber: 9303,
          tripId: 'trip-mid',
          coordinates: [14.55, 50.02],
        }),
        makeSnapshot({
          key: '9304',
          registrationNumber: 9304,
          tripId: 'trip-off',
          coordinates: [15.6, 49.5], // far outside the viewport (+ margin)
        }),
      ],
      T0,
    );

    expect(feed.requested).toEqual([
      { tripIds: ['trip-center', 'trip-mid', 'trip-edge'], priority: 1 },
      { tripIds: ['trip-off'], priority: 2 },
    ]);
    rt.release();
  });

  it('falls back to the LAST known viewport when the provider gaps (unregistered/null)', () => {
    const { feed, rt } = setup();
    rt.setViewportProvider(() => ({ bbox: [14.5, 50.0, 14.7, 50.1], zoom: 14 }));

    // Poll 1 records the viewport (ORIGIN [14.6, 50.05] is inside it).
    feed.push([makeSnapshot({ tripId: 'trip-a' })], T0);
    expect(feed.requested).toContainEqual({ tripIds: ['trip-a'], priority: 1 });

    // The map layer remounts between polls: provider gone for one poll. The
    // on-screen tram must NOT silently drop to the background lane — the last
    // known bbox still classifies it as visible.
    rt.setViewportProvider(null);
    feed.push([makeSnapshot({ tripId: 'trip-a' })], T0 + 5_000);
    expect(feed.requested[feed.requested.length - 1]).toEqual({
      tripIds: ['trip-a'],
      priority: 1,
    });
    rt.release();
  });

  it('re-asserts the visibility split EVERY poll — a tram left behind by the camera drops to background', () => {
    const { feed, rt } = setup();
    let bbox: [number, number, number, number] = [14.5, 50.0, 14.7, 50.1];
    rt.setViewportProvider(() => ({ bbox, zoom: 14 }));

    // Poll 1: the tram (at ORIGIN) is on screen → raised priority.
    feed.push([makeSnapshot({ tripId: 'trip-a' })], T0);
    expect(feed.requested).toContainEqual({ tripIds: ['trip-a'], priority: 1 });

    // The camera flies elsewhere; the still-missing trip is re-requested at
    // BACKGROUND — the feed (shapeCache → demoteTag) uses this to demote its
    // queued waiter so on-screen trams overtake it.
    bbox = [14.0, 49.6, 14.2, 49.8];
    feed.push([makeSnapshot({ tripId: 'trip-a' })], T0 + 5_000);
    expect(feed.requested[feed.requested.length - 1]).toEqual({
      tripIds: ['trip-a'],
      priority: 2,
    });
    rt.release();
  });

  it('a VISIBLE trip whose fetch failed is re-requested on EVERY poll until it lands, then comes alive', () => {
    // The runtime is the retry driver for the cache layer's failure backoff:
    // as long as a snapshot's geometry stays unresolved, each poll re-requests
    // it (shapeCache decides whether the re-request actually hits the network).
    const { feed, rt } = setup();
    rt.setViewportProvider(() => ({ bbox: [14.5, 50.0, 14.7, 50.1], zoom: 14 }));

    for (let poll = 0; poll < 3; poll++) {
      feed.push([makeSnapshot({ tripId: 'trip-test', observedAtMs: T0 + poll * 5_000 })], T0 + poll * 5_000);
    }
    const forTrip = feed.requested.filter((r) => r.tripIds.includes('trip-test'));
    expect(forTrip).toHaveLength(3); // one re-request per poll, none dropped
    expect(forTrip.every((r) => r.priority === 1)).toBe(true); // visible lane
    expect(rt.engine.getState('9201', Date.now())!.hasGeometry).toBe(false);

    // The retry finally succeeds → the debounced adopt revives the tram, no tap.
    feed.loadGeometry('trip-test', makeGeo());
    jest.advanceTimersByTime(400);
    expect(rt.engine.getState('9201', Date.now())!.hasGeometry).toBe(true);
    rt.release();
  });

  it('a geometry landing (feed event) re-ingests within the debounce — the sim appears with NO tap', () => {
    const { feed, rt } = setup();
    feed.push([makeSnapshot({ shapeDistM: 300, observedAtMs: T0 })], T0);
    expect(rt.engine.getState('9201', T0)!.hasGeometry).toBe(false);

    // The shape streams into the cache and the feed announces it. Well before
    // the 2.5 s nudge, and with NO prioritizeTrip (no tap), the debounced
    // geometry-adopt ingest brings the sim up — the dot comes alive by itself.
    feed.loadGeometry('trip-test', makeGeo());
    jest.advanceTimersByTime(400);
    expect(rt.engine.getState('9201', Date.now())!.hasGeometry).toBe(true);
    expect(feed.promoted).toEqual([]); // no tap was needed
    rt.release();
  });

  it('a burst of geometry events coalesces into one debounced ingest', () => {
    const { feed, rt } = setup();
    const ingestSpy = jest.spyOn(rt.engine, 'ingest');
    feed.push([makeSnapshot({ tripId: 'trip-test' })], T0);
    const ingestsAfterPush = ingestSpy.mock.calls.length;

    // Four geometries land back-to-back (a scheduler window draining).
    feed.loadGeometry('trip-test', makeGeo());
    feed.geometryListeners.forEach((l) => l());
    feed.geometryListeners.forEach((l) => l());
    feed.geometryListeners.forEach((l) => l());
    jest.advanceTimersByTime(400);
    expect(ingestSpy.mock.calls.length).toBe(ingestsAfterPush + 1);
    rt.release();
  });

  it('a brand-new tram (no prior trip) still warms at background priority', () => {
    const { feed, rt } = setup();
    // No geometry loaded, first time this key is seen → background warm (2),
    // NOT the raised trip-change lane (there is no previous trip to change FROM).
    feed.push([makeSnapshot({ tripId: 'trip-test', shapeDistM: 0, observedAtMs: T0 })], T0);
    expect(feed.requested).toEqual([{ tripIds: ['trip-test'], priority: 2 }]);
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
      // R7 (schema v2): raw AVL context flows from snapshot into the record.
      obsAt: T0,
      statePos: 'on_track',
      delayS: 0,
      nextSeq: null,
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
