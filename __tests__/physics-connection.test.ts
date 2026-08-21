/// <reference types="jest" />
//
// Connection honesty (physics-v3-protocol §"Connection honesty"). The rule the
// old client broke: staleness is a property of the DATA, not of the last fetch
// call. A server that keeps answering 200 OK with a twenty-minute-old bundle is
// offline, and the UI has to say so.
//
// Covers the pure state machine and the TrajectoryStore that feeds it.

import {
  connectionState,
  DEGRADED_AFTER_S,
  OFFLINE_AFTER_FAILURES,
  OFFLINE_AFTER_S,
  OFFLINE_BANNER_TEXT,
} from '@/lib/physics/connection';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import {
  ConvexTrajectorySource,
  TRAJ_BATCHES_QUERY,
  type ConvexTrajectoryClient,
  type TrajectoryBatchesResult,
  type TrajectorySeedResult,
} from '@/lib/physics/convexSource';
import { T0, wireBundle, wireVehicle } from './physicsFixtures';

describe('connectionState', () => {
  const at = (bundleAgeS: number | null, consecutiveFailures = 0) =>
    connectionState({ bundleAgeS, consecutiveFailures });

  it('live while the bundle is fresher than 15 s', () => {
    expect(at(0)).toBe('live');
    expect(at(14.9)).toBe('live');
  });

  it('degraded from 15 s to 45 s — trams keep following their curves', () => {
    expect(at(DEGRADED_AFTER_S)).toBe('degraded');
    expect(at(30)).toBe('degraded');
    expect(at(OFFLINE_AFTER_S)).toBe('degraded');
  });

  it('offline past 45 s', () => {
    expect(at(OFFLINE_AFTER_S + 0.1)).toBe('offline');
    expect(at(3_600)).toBe('offline');
  });

  it('offline once fetches are consistently failing, even with a young bundle', () => {
    expect(at(2, OFFLINE_AFTER_FAILURES - 1)).toBe('live');
    expect(at(2, OFFLINE_AFTER_FAILURES)).toBe('offline');
  });

  it('cold start with a fetch in flight reads degraded, not a false "live"', () => {
    // "Connecting…" is the honest middle: we are not live (no data at all),
    // but flashing the offline banner on every launch would cry wolf.
    expect(at(null, 0)).toBe('degraded');
  });

  it('cold start whose first fetch FAILED is offline', () => {
    expect(at(null, 1)).toBe('offline');
  });

  it('a negative age (clock jitter) still reads live', () => {
    expect(at(-0.4)).toBe('live');
  });

  it('the banner copy is the protocol string', () => {
    expect(OFFLINE_BANNER_TEXT).toBe('Нет связи с сервером — данные устарели');
  });
});

describe('TrajectoryStore staleness + health', () => {
  it('reports no bundle before anything is decoded', () => {
    const s = new TrajectoryStore();
    expect(s.bundle).toBeNull();
    expect(s.bundleAgeS(T0)).toBeNull();
    expect(s.connection(T0)).toBe('degraded');
    expect(s.health(T0).vehicleCount).toBe(0);
  });

  it('ages the bundle on the SERVER-corrected clock', () => {
    const s = new TrajectoryStore();
    // Device clock is 30 s behind the server; the bundle is fresh.
    s.ingest(wireBundle({ serverNowMs: T0, atMs: T0 }), T0 - 30_000);
    expect(s.clock.offsetMs).toBe(30_000);
    // Without the correction this would read as 30 s stale (degraded).
    expect(s.bundleAgeS(T0 - 30_000)).toBeCloseTo(0, 6);
    expect(s.connection(T0 - 30_000)).toBe('live');
  });

  it('a bundle that stops arriving ages into degraded then offline on the clock alone', () => {
    const s = new TrajectoryStore();
    s.ingest(wireBundle({ serverNowMs: T0, atMs: T0 }), T0);
    expect(s.connection(T0)).toBe('live');
    expect(s.connection(T0 + 20_000)).toBe('degraded');
    expect(s.connection(T0 + 60_000)).toBe('offline');
  });

  it('a 200 OK carrying an OLD bundle is stale immediately — no lying', () => {
    const s = new TrajectoryStore();
    // Server answers promptly, but the bundle it built is 20 minutes old.
    s.ingest(wireBundle({ serverNowMs: T0, atMs: T0 - 20 * 60_000 }), T0);
    expect(s.health(T0).lastError).toBeNull(); // the fetch was a success…
    expect(s.connection(T0)).toBe('offline'); // …and we are still offline.
  });

  it('a malformed payload counts as a failure and keeps the previous bundle', () => {
    const s = new TrajectoryStore();
    s.ingest(wireBundle({ serverNowMs: T0, atMs: T0 }), T0);
    expect(s.ingest({ nonsense: true }, T0 + 5_000)).toBe(false);
    expect(s.bundle!.atMs).toBe(T0); // previous bundle still rendering
    expect(s.health(T0).consecutiveFailures).toBe(1);
    expect(s.health(T0).lastError).toBe('malformed bundle');
  });

  it('a success clears the failure counter', () => {
    const s = new TrajectoryStore();
    s.ingest({ bad: 1 }, T0);
    s.ingest({ bad: 1 }, T0);
    expect(s.health(T0).consecutiveFailures).toBe(2);
    s.ingest(wireBundle({ serverNowMs: T0 }), T0);
    expect(s.health(T0).consecutiveFailures).toBe(0);
    expect(s.health(T0).lastError).toBeNull();
  });

  it('counts a server-flagged discontinuity once per NEW emission', () => {
    const s = new TrajectoryStore();
    const flagged = (emittedAtMs: number) =>
      wireBundle({
        serverNowMs: emittedAtMs,
        vehicles: [wireVehicle({ emittedAtMs, discontinuity: true })],
      });

    s.ingest(flagged(T0), T0);
    expect(s.health(T0).discontinuities).toBe(1);
    // Same emission re-published (the server hasn't recomputed yet) → no
    // double count.
    s.ingest(flagged(T0), T0 + 5_000);
    expect(s.health(T0).discontinuities).toBe(1);
    // A genuinely new flagged emission counts.
    s.ingest(flagged(T0 + 10_000), T0 + 10_000);
    expect(s.health(T0).discontinuities).toBe(2);
  });

  it('notifies subscribers on each decoded bundle, and not on a failure', () => {
    const s = new TrajectoryStore();
    let notified = 0;
    const off = s.subscribe(() => {
      notified += 1;
    });
    s.ingest(wireBundle({ serverNowMs: T0 }), T0);
    expect(notified).toBe(1);
    s.ingest({ junk: true }, T0);
    expect(notified).toBe(1);
    off();
    s.ingest(wireBundle({ serverNowMs: T0 }), T0);
    expect(notified).toBe(1);
  });

  it('getVehicle reads out of the newest bundle', () => {
    const s = new TrajectoryStore();
    s.ingest(wireBundle({ vehicles: [wireVehicle({ key: '9201' })] }), T0);
    expect(s.getVehicle('9201')).toBeDefined();
    expect(s.getVehicle('nope')).toBeUndefined();
  });
});

describe('ConvexTrajectorySource lifecycle (perf invariant #3)', () => {
  const seedResult = (seq: number): TrajectorySeedResult => ({
    vehicles: [wireVehicle({ key: '9201' })],
    meta: {
      atMs: T0,
      horizonS: 120,
      generator: 'drive-v3',
      lastSeq: seq,
      publishedAtMs: T0,
      serverNowMs: T0 + 300,
    },
    seq,
  });

  /** A fake ConvexClient: one pending seed query + capture of subscriptions. */
  function makeFake(seed: TrajectorySeedResult) {
    const state = {
      queries: 0,
      closes: 0,
      unsubs: 0,
      batchCb: null as ((r: TrajectoryBatchesResult) => unknown) | null,
      resolveSeed: null as ((v: TrajectorySeedResult) => void) | null,
    };
    const client: ConvexTrajectoryClient = {
      query: (() => {
        state.queries += 1;
        return new Promise<TrajectorySeedResult>((resolve) => {
          state.resolveSeed = resolve;
        });
      }) as ConvexTrajectoryClient['query'],
      onUpdate: (q, _args, cb) => {
        if (q === TRAJ_BATCHES_QUERY) state.batchCb = cb as typeof state.batchCb;
        return () => {
          state.unsubs += 1;
        };
      },
      close: async () => {
        state.closes += 1;
      },
    };
    void seed;
    return { client, state };
  }

  it('seeds the store, then folds pushed batches at the advanced cursor', async () => {
    const store = new TrajectoryStore();
    const { client, state } = makeFake(seedResult(41));
    const src = new ConvexTrajectorySource(store, {
      url: 'https://example.invalid',
      createClient: () => client,
    });
    src.start();
    expect(state.queries).toBe(1);
    state.resolveSeed!(seedResult(41));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.bundle?.vehicles.size).toBe(1);
    expect(store.health(T0).lastSeq).toBe(41);
    expect(state.batchCb).not.toBeNull();

    state.batchCb!({
      batches: [
        { seq: 42, atMs: T0 + 2_000, changed: [wireVehicle({ key: '9202' })], removed: undefined },
      ],
      oldestSeq: 40,
      latestSeq: 42,
      serverNowMs: T0 + 2_300,
    });
    expect(store.bundle?.vehicles.size).toBe(2);
    expect(store.health(T0).lastSeq).toBe(42);
    src.stop();
  });

  it('a seq gap beyond retention reseeds from scratch', async () => {
    const store = new TrajectoryStore();
    const { client, state } = makeFake(seedResult(10));
    const src = new ConvexTrajectorySource(store, {
      url: 'https://example.invalid',
      createClient: () => client,
    });
    src.start();
    state.resolveSeed!(seedResult(10));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.queries).toBe(1);
    // Batches jumped to 50 while the oldest surviving row is 40: rows 11–39
    // are swept — the cursor cannot be resumed.
    state.batchCb!({
      batches: [{ seq: 50, atMs: T0 + 9_000, changed: [], removed: undefined }],
      oldestSeq: 40,
      latestSeq: 50,
      serverNowMs: T0 + 9_000,
    });
    expect(state.queries).toBe(2); // the reseed
    src.stop();
  });

  it('stop() closes the client and a late seed cannot mutate the store', async () => {
    const store = new TrajectoryStore();
    const { client, state } = makeFake(seedResult(7));
    const src = new ConvexTrajectorySource(store, {
      url: 'https://example.invalid',
      createClient: () => client,
    });
    src.start();
    src.stop();
    expect(state.closes).toBe(1);
    state.resolveSeed!(seedResult(7));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.bundle).toBeNull(); // generation guard held
    expect(store.clock.synced).toBe(false);
  });

  it('a store without the convex opt-in starts inert — nothing ticks, ever', () => {
    jest.useFakeTimers();
    const store = new TrajectoryStore();
    store.start();
    jest.advanceTimersByTime(60_000);
    expect(store.bundle).toBeNull();
    expect(store.health(Date.now()).consecutiveFailures).toBe(0);
    store.stop();
    jest.useRealTimers();
  });
});
