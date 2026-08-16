/// <reference types="jest" />
//
// RemoteFeed: the TramFeed implementation over the Convex backend, driven by a
// fake Convex client (no WebSocket). Locks the parts of the contract a diffing
// push feed can get wrong:
//   • seed from fullFleet, then fold diffs and emit the MERGED FULL ARRAY —
//     a diff-only emit would silently shrink the fleet in TramRuntime,
//   • a seq gap (the retention window outran our cursor) forces a re-seed,
//   • stop() means no callback ever again (generation guard + close),
//   • FeedStatus mapping, including SERVER poller health mirrored to clients,
//   • geometry/calibration delegation is identical to LocalGolemioFeed
//     (phase 1: geometry still comes from Golemio client-side).

import {
  BATCHES_SINCE_QUERY,
  FULL_FLEET_QUERY,
  RemoteFeed,
  RESEED_INTERVAL_MS,
  RESUBSCRIBE_AFTER_BATCHES,
  SERVER_POLL_MS,
  SERVER_STALE_MS,
  type BatchesSinceResult,
  type ConvexStreamClient,
  type FullFleetResult,
  type PollerHealth,
} from '@/lib/feed/remoteFeed';
import type { CalibrationRecord } from '@/lib/feed/types';
import { promoteTag } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import type { TramSnapshot } from '@/lib/types';
import { makeSnapshot } from './helpers';

jest.mock('@/lib/golemio/shapeCache', () => ({
  getLoaded: jest.fn(),
  requestPrefetch: jest.fn(),
  subscribeLoaded: jest.fn(() => () => {}),
  has: jest.fn(() => false),
  isProvisional: jest.fn(() => false),
}));
jest.mock('@/lib/golemio/client', () => ({
  promoteTag: jest.fn(() => false),
}));

const promoteTagMock = promoteTag as jest.MockedFunction<typeof promoteTag>;
const hasMock = shapeCache.has as jest.MockedFunction<typeof shapeCache.has>;
const provisionalMock = shapeCache.isProvisional as jest.MockedFunction<
  typeof shapeCache.isProvisional
>;

const T0 = 1_000_000_000_000;
const URL = 'https://tram-spotter-test.convex.cloud';

/** Drain pending microtasks under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function tram(key: string, over: Partial<TramSnapshot> = {}): TramSnapshot {
  return makeSnapshot({
    key,
    registrationNumber: Number(key),
    tripId: `trip-${key}`,
    observedAtMs: T0,
    ...over,
  });
}

interface FakeSubscription {
  args: { sinceSeq: number };
  callback: (result: BatchesSinceResult) => unknown;
  onError?: (e: Error) => unknown;
  live: boolean;
}

/**
 * Stand-in for `ConvexClient` (convex/browser): resolves fullFleet from a
 * scripted queue and lets the test push subscription updates by hand.
 */
class FakeConvexClient implements ConvexStreamClient {
  fullFleetCalls = 0;
  subscriptions: FakeSubscription[] = [];
  closed = 0;
  webSocketConnected = true;
  /** Scripted fullFleet results; the last one repeats. */
  fleetResults: FullFleetResult[] = [];
  /** When set, fullFleet rejects with this instead of resolving. */
  fleetError: Error | null = null;
  /** Resolver for the pending fullFleet promise (deferred mode). */
  private pendingSeed: ((result: FullFleetResult) => void) | null = null;
  deferSeed = false;

  query<Q extends { _args: unknown; _returnType: unknown }>(
    query: Q,
    _args: Q['_args'],
  ): Promise<Awaited<Q['_returnType']>> {
    expect(query).toBe(FULL_FLEET_QUERY);
    this.fullFleetCalls += 1;
    if (this.fleetError) return Promise.reject(this.fleetError) as never;
    if (this.deferSeed) {
      return new Promise<FullFleetResult>((resolve) => {
        this.pendingSeed = resolve;
      }) as never;
    }
    const next =
      this.fleetResults.length > 1 ? this.fleetResults.shift()! : this.fleetResults[0];
    return Promise.resolve(next) as never;
  }

  /** Resolve a deferred fullFleet (to test late completion after stop()). */
  resolveSeed(result: FullFleetResult): void {
    this.pendingSeed?.(result);
    this.pendingSeed = null;
  }

  onUpdate<Q extends { _args: unknown; _returnType: unknown }>(
    query: Q,
    args: Q['_args'],
    callback: (result: Q['_returnType']) => unknown,
    onError?: (e: Error) => unknown,
  ): () => void {
    expect(query).toBe(BATCHES_SINCE_QUERY);
    const sub: FakeSubscription = {
      args: args as { sinceSeq: number },
      callback: callback as (result: BatchesSinceResult) => unknown,
      onError,
      live: true,
    };
    this.subscriptions.push(sub);
    return () => {
      sub.live = false;
    };
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  connectionState(): { isWebSocketConnected: boolean } {
    return { isWebSocketConnected: this.webSocketConnected };
  }

  get activeSubscription(): FakeSubscription | undefined {
    return this.subscriptions.filter((s) => s.live).pop();
  }

  /** Server push: deliver a diff window to every live subscription. */
  push(result: Partial<BatchesSinceResult> & Pick<BatchesSinceResult, 'batches'>): void {
    const full: BatchesSinceResult = {
      oldestSeq: result.batches[0]?.seq ?? 0,
      latestSeq: result.batches[result.batches.length - 1]?.seq ?? 0,
      ...result,
    };
    this.subscriptions.filter((s) => s.live).forEach((s) => s.callback(full));
  }
}

function fleetResult(
  seq: number,
  vehicles: TramSnapshot[],
  poller?: PollerHealth | null,
): FullFleetResult {
  return { seq, atMs: T0, vehicles, poller };
}

function setup(options?: { poller?: PollerHealth | null; vehicles?: TramSnapshot[]; seq?: number }) {
  const client = new FakeConvexClient();
  client.fleetResults = [
    fleetResult(options?.seq ?? 10, options?.vehicles ?? [tram('9201')], options?.poller),
  ];
  const feed = new RemoteFeed({
    url: URL,
    createClient: () => client,
    calibrationSink: jest.fn(),
    passiveLoggingEnabled: () => true,
  });
  const batches: { snapshots: TramSnapshot[]; atMs: number }[] = [];
  feed.subscribeSnapshots((snapshots, atMs) => batches.push({ snapshots, atMs }));
  return { client, feed, batches };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  jest.clearAllMocks();
  hasMock.mockReturnValue(false);
  promoteTagMock.mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('RemoteFeed seeding + merged-full-array delivery', () => {
  it('start() seeds from fullFleet, emits the whole fleet, then subscribes at that seq', async () => {
    const { client, feed, batches } = setup({ vehicles: [tram('9201'), tram('9202')], seq: 10 });

    feed.start();
    expect(client.fullFleetCalls).toBe(1);
    expect(client.subscriptions).toHaveLength(0); // not before the seed lands
    await flush();

    expect(batches).toHaveLength(1);
    expect(batches[0].atMs).toBe(T0);
    expect(batches[0].snapshots.map((s) => s.key)).toEqual(['9201', '9202']);
    expect(client.activeSubscription?.args).toEqual({ sinceSeq: 10 });
    feed.stop();
  });

  it('a diff batch emits the MERGED full array, not the changed rows', async () => {
    const { client, feed, batches } = setup({
      vehicles: [tram('9201', { shapeDistM: 100 }), tram('9202', { shapeDistM: 200 })],
      seq: 10,
    });
    feed.start();
    await flush();

    // Only 9202 moved, and a brand-new tram appeared.
    client.push({
      batches: [
        {
          seq: 11,
          atMs: T0 + 2_000,
          changed: [
            tram('9202', { shapeDistM: 260, observedAtMs: T0 + 2_000 }),
            tram('9303', { shapeDistM: 40, observedAtMs: T0 + 2_000 }),
          ],
        },
      ],
    });

    expect(batches).toHaveLength(2);
    const merged = batches[1].snapshots;
    // The untouched tram is STILL in the array (a diff-only emit would drop it).
    expect(merged.map((s) => s.key).sort()).toEqual(['9201', '9202', '9303']);
    expect(merged.find((s) => s.key === '9201')!.shapeDistM).toBe(100);
    expect(merged.find((s) => s.key === '9202')!.shapeDistM).toBe(260);
    // Delivery stamp is the wall clock, never the fix time.
    expect(batches[1].atMs).toBe(T0);
    feed.stop();
  });

  it('folds several batches in one push and honors `removed` keys', async () => {
    const { client, feed, batches } = setup({
      vehicles: [tram('9201'), tram('9202')],
      seq: 10,
    });
    feed.start();
    await flush();

    client.push({
      batches: [
        { seq: 11, atMs: T0 + 2_000, changed: [tram('9303')] },
        { seq: 12, atMs: T0 + 4_000, changed: [], removed: ['9201'] },
      ],
    });

    expect(batches).toHaveLength(2); // one delivery per push, not per row
    expect(batches[1].snapshots.map((s) => s.key).sort()).toEqual(['9202', '9303']);
    feed.stop();
  });

  it('ignores rows at or below the cursor (a re-subscription overlap is idempotent)', async () => {
    const { client, feed, batches } = setup({ vehicles: [tram('9201')], seq: 10 });
    feed.start();
    await flush();

    client.push({ batches: [{ seq: 11, atMs: T0, changed: [tram('9202')] }] });
    expect(batches).toHaveLength(2);

    // The same window arrives again (re-run of the growing query): no re-emit.
    client.push({ batches: [{ seq: 11, atMs: T0, changed: [tram('9202')] }] });
    expect(batches).toHaveLength(2);
    feed.stop();
  });

  it('a subscriber throw surfaces as a feed error instead of escaping into Convex', async () => {
    const { client, feed } = setup();
    feed.subscribeSnapshots(() => {
      throw new Error('ingest exploded');
    });
    feed.start();
    await flush();
    expect(feed.status().lastError).toBe('ingest exploded');
    expect(() => client.push({ batches: [{ seq: 11, atMs: T0, changed: [tram('9202')] }] })).not.toThrow();
    feed.stop();
  });
});

describe('RemoteFeed seq-gap resync', () => {
  it('a gap between the cursor and the oldest retained row re-seeds from fullFleet', async () => {
    const { client, feed, batches } = setup({ vehicles: [tram('9201')], seq: 10 });
    // The re-seed returns a different fleet — proof the map was rebuilt.
    client.fleetResults = [
      fleetResult(10, [tram('9201')]),
      fleetResult(41, [tram('9500'), tram('9501')]),
    ];
    feed.start();
    await flush();
    expect(client.fullFleetCalls).toBe(1);

    // Retention outran us: we are at seq 10, the window starts at 40.
    client.push({
      batches: [{ seq: 40, atMs: T0 + 60_000, changed: [tram('9400')] }],
      oldestSeq: 40,
      latestSeq: 40,
    });
    // The gapped window is NOT folded — a re-seed is issued instead.
    expect(client.fullFleetCalls).toBe(2);
    expect(batches).toHaveLength(1);
    await flush();

    expect(batches).toHaveLength(2);
    expect(batches[1].snapshots.map((s) => s.key)).toEqual(['9500', '9501']);
    // …and the stream is re-subscribed at the fresh cursor.
    expect(client.activeSubscription?.args).toEqual({ sinceSeq: 41 });
    expect(client.subscriptions.filter((s) => s.live)).toHaveLength(1);
    feed.stop();
  });

  it('an empty window whose retention floor passed the cursor also re-seeds', async () => {
    const { client, feed } = setup({ seq: 10 });
    client.fleetResults = [fleetResult(10, [tram('9201')]), fleetResult(80, [tram('9202')])];
    feed.start();
    await flush();

    client.push({ batches: [], oldestSeq: 30, latestSeq: 60 });
    expect(client.fullFleetCalls).toBe(2);
    feed.stop();
  });

  it('a contiguous window (oldest === cursor + 1) folds without re-seeding', async () => {
    const { client, feed, batches } = setup({ seq: 10 });
    feed.start();
    await flush();

    client.push({ batches: [{ seq: 11, atMs: T0, changed: [tram('9202')] }], oldestSeq: 11 });
    expect(client.fullFleetCalls).toBe(1);
    expect(batches).toHaveLength(2);
    feed.stop();
  });

  it('re-subscribes at the fresh cursor once the diff window grows', async () => {
    const { client, feed } = setup({ seq: 10 });
    feed.start();
    await flush();

    // The growing query keeps re-delivering everything after sinceSeq; at
    // RESUBSCRIBE_AFTER_BATCHES rows the window is trimmed by re-subscribing.
    const window: BatchesSinceResult['batches'] = [];
    for (let i = 1; i <= RESUBSCRIBE_AFTER_BATCHES; i++) {
      window.push({ seq: 10 + i, atMs: T0, changed: [tram(`93${i.toString().padStart(2, '0')}`)] });
      client.push({ batches: window.slice() });
    }

    expect(client.fullFleetCalls).toBe(1); // a trim is NOT a re-seed
    expect(client.subscriptions.filter((s) => s.live)).toHaveLength(1);
    expect(client.activeSubscription?.args).toEqual({ sinceSeq: 10 + RESUBSCRIBE_AFTER_BATCHES });
    feed.stop();
  });

  it('re-seeds periodically so a drifted fleet map cannot persist', async () => {
    const { client, feed, batches } = setup({ seq: 10 });
    client.fleetResults = [fleetResult(10, [tram('9201')]), fleetResult(60, [tram('9202')])];
    feed.start();
    await flush();

    client.push({ batches: [{ seq: 11, atMs: T0, changed: [tram('9201')] }] });
    expect(client.fullFleetCalls).toBe(1);

    jest.setSystemTime(T0 + RESEED_INTERVAL_MS);
    client.push({ batches: [{ seq: 12, atMs: T0, changed: [tram('9201')] }] });
    expect(client.fullFleetCalls).toBe(2);
    await flush();
    expect(batches[batches.length - 1].snapshots.map((s) => s.key)).toEqual(['9202']);
    feed.stop();
  });

  it('a failed seed backs off and retries', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // jitter ×1.0
    const { client, feed } = setup();
    client.fleetError = new Error('convex down');
    feed.start();
    await flush();
    expect(feed.status()).toMatchObject({
      lastError: 'convex down',
      consecutiveFailures: 1,
      lastBatchAtMs: 0,
    });

    client.fleetError = null;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(client.fullFleetCalls).toBe(2);
    expect(feed.status()).toMatchObject({ lastError: null, consecutiveFailures: 0 });
    feed.stop();
    (Math.random as jest.Mock).mockRestore?.();
  });
});

describe('RemoteFeed lifecycle: no callbacks after stop()', () => {
  it('stop() unsubscribes, closes the client, and a late push reaches nobody', async () => {
    const { client, feed, batches } = setup();
    feed.start();
    await flush();
    expect(batches).toHaveLength(1);

    feed.stop();
    expect(client.closed).toBe(1);
    expect(client.subscriptions.every((s) => !s.live)).toBe(true);

    // Even a rogue callback on a torn-down subscription emits nothing.
    client.subscriptions.forEach((s) =>
      s.callback({
        batches: [{ seq: 11, atMs: T0, changed: [tram('9999')] }],
        oldestSeq: 11,
        latestSeq: 11,
      }),
    );
    expect(batches).toHaveLength(1);
  });

  it('a fullFleet result landing after stop() neither emits nor mutates status', async () => {
    const { client, feed, batches } = setup();
    client.deferSeed = true;
    feed.start();
    expect(feed.status().inFlight).toBe(true);

    feed.stop();
    client.resolveSeed(fleetResult(10, [tram('9201')]));
    await flush();

    expect(batches).toHaveLength(0);
    expect(client.subscriptions).toHaveLength(0); // no subscription after teardown
    expect(feed.status()).toMatchObject({
      lastBatchAtMs: 0,
      lastError: null,
      nextFetchAtMs: 0,
      inFlight: false,
      pollIntervalMs: 0,
    });
  });

  it('a seed REJECTION after stop() is swallowed (no stale error, no retry storm)', async () => {
    const { client, feed } = setup();
    client.fleetError = new Error('aborted');
    feed.start();
    feed.stop();
    await flush();
    expect(feed.status().lastError).toBeNull();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(client.fullFleetCalls).toBe(1);
  });

  it('start() is idempotent; a restart is a fresh session with a fresh client', async () => {
    const clients: FakeConvexClient[] = [];
    const feed = new RemoteFeed({
      url: URL,
      createClient: () => {
        const c = new FakeConvexClient();
        c.fleetResults = [fleetResult(10, [tram('9201')])];
        clients.push(c);
        return c;
      },
      calibrationSink: jest.fn(),
      passiveLoggingEnabled: () => true,
    });

    feed.start();
    feed.start(); // no second client, no second seed
    await flush();
    expect(clients).toHaveLength(1);
    expect(clients[0].fullFleetCalls).toBe(1);

    feed.stop();
    feed.start();
    await flush();
    expect(clients).toHaveLength(2);
    expect(clients[1].fullFleetCalls).toBe(1);
    feed.stop();
  });

  it('a slower requested cadence coalesces pushes into one trailing delivery', async () => {
    const { client, feed, batches } = setup();
    feed.start(10_000); // rideBackground cadence
    await flush();
    expect(batches).toHaveLength(1);

    // Three server pushes inside the throttle window → one trailing delivery,
    // carrying the fully folded fleet (folding itself is never delayed).
    client.push({ batches: [{ seq: 11, atMs: T0, changed: [tram('9202')] }] });
    client.push({ batches: [{ seq: 12, atMs: T0, changed: [tram('9303')] }] });
    expect(batches).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(batches).toHaveLength(2);
    expect(batches[1].snapshots.map((s) => s.key).sort()).toEqual(['9201', '9202', '9303']);
    feed.stop();
  });
});

describe('RemoteFeed status mapping', () => {
  it('reports zeros before start() and after stop()', async () => {
    const { feed } = setup();
    expect(feed.status()).toEqual({
      lastBatchAtMs: 0,
      lastError: null,
      lastFetchAtMs: 0,
      nextFetchAtMs: 0,
      inFlight: false,
      pollIntervalMs: 0,
      authFailed: false,
      consecutiveFailures: 0,
      rejectedTotal: 0,
      rejectedByReason: {},
    });

    feed.start();
    await flush();
    feed.stop();
    expect(feed.status()).toMatchObject({ nextFetchAtMs: 0, pollIntervalMs: 0, inFlight: false });
  });

  it('maps a healthy stream: server cadence, batch/fetch stamps, no error', async () => {
    const { feed } = setup({
      poller: { lastPollAtMs: T0 - 1_000, pollIntervalMs: 2_000, rejectedTotal: 0 },
    });
    feed.start();
    await flush();

    expect(feed.status()).toEqual({
      lastBatchAtMs: T0,
      lastError: null,
      lastFetchAtMs: T0,
      nextFetchAtMs: T0 + 2_000,
      inFlight: false,
      pollIntervalMs: 2_000,
      authFailed: false,
      consecutiveFailures: 0,
      rejectedTotal: 0,
      rejectedByReason: {},
    });
    feed.stop();
  });

  it('falls back to SERVER_POLL_MS when the poller reports no cadence', async () => {
    const { feed } = setup();
    feed.start();
    await flush();
    expect(feed.status().pollIntervalMs).toBe(SERVER_POLL_MS);
    feed.stop();
  });

  it('a requested cadence overrides the server cadence in the status ring', async () => {
    const { feed } = setup({ poller: { lastPollAtMs: T0, pollIntervalMs: 2_000 } });
    feed.start(10_000);
    await flush();
    expect(feed.status()).toMatchObject({
      pollIntervalMs: 10_000,
      nextFetchAtMs: T0 + 10_000,
    });
    feed.stop();
  });

  it('mirrors SERVER poller health: auth failure, rejections, degraded upstream', async () => {
    const { client, feed } = setup({
      poller: {
        lastPollAtMs: T0 - 1_000,
        authFailed: true,
        consecutiveFailures: 3,
        rejectedTotal: 7,
        rejectedByReason: { 'bad-distance': 5, 'missing-timestamp': 2 },
      },
    });
    feed.start();
    await flush();

    expect(feed.status()).toMatchObject({
      authFailed: true,
      consecutiveFailures: 3,
      rejectedTotal: 7,
      rejectedByReason: { 'bad-distance': 5, 'missing-timestamp': 2 },
      // A client-side success does not hide an upstream outage.
      lastError: 'server: Golemio auth failed',
    });

    // A poller error message wins over the derived one…
    client.push({
      batches: [{ seq: 11, atMs: T0, changed: [tram('9202')] }],
      poller: { lastPollAtMs: T0, lastError: 'golemio 503' },
    });
    expect(feed.status()).toMatchObject({ lastError: 'server: golemio 503', authFailed: false });

    // …and a stale heartbeat alone reads as a degraded feed.
    client.push({
      batches: [{ seq: 12, atMs: T0, changed: [tram('9202')] }],
      poller: { lastPollAtMs: T0 - SERVER_STALE_MS - 1 },
    });
    expect(feed.status().lastError).toBe('server: feed stale');
    feed.stop();
  });

  it('a folded batch counts as server heartbeat — no false "feed stale" between re-seeds', async () => {
    // The real `batchesSince` deliberately carries NO poller health (it would
    // wake every subscriber on each 2 s heartbeat write). The health snapshot
    // from the seed must therefore be refreshed by the batches themselves, or
    // every client would read "server: feed stale" two minutes after seeding.
    const { client, feed } = setup({
      poller: { lastPollAtMs: T0, pollIntervalMs: 2_000, lastError: 'golemio 503' },
    });
    feed.start();
    await flush();

    const later = T0 + SERVER_STALE_MS + 30_000;
    jest.setSystemTime(later);
    // A batch ingested at `later` proves the server just polled SUCCESSFULLY.
    client.push({ batches: [{ seq: 11, atMs: later, changed: [tram('9202')] }] });
    expect(feed.status().lastError).toBeNull();

    // …but once batches STOP arriving, the frozen heartbeat reads as degraded.
    jest.setSystemTime(later + SERVER_STALE_MS + 1_000);
    expect(feed.status().lastError).toBe('server: feed stale');
    feed.stop();
  });

  it('status() returns a fresh object each call (the chrome reads it live)', async () => {
    const { feed } = setup();
    feed.start();
    await flush();
    const a = feed.status();
    const b = feed.status();
    expect(a).not.toBe(b);
    expect(a.rejectedByReason).not.toBe(b.rejectedByReason);
    feed.stop();
  });

  it('inFlight tracks the seed query and a reconnecting WebSocket', async () => {
    const { client, feed } = setup();
    client.deferSeed = true;
    feed.start();
    expect(feed.status().inFlight).toBe(true); // one-shot seed outstanding

    client.resolveSeed(fleetResult(10, [tram('9201')]));
    await flush();
    expect(feed.status().inFlight).toBe(false);

    client.webSocketConnected = false;
    expect(feed.status().inFlight).toBe(true); // WS reconnecting
    feed.stop();
  });
});

describe('RemoteFeed geometry + calibration delegation (phase 1: Golemio client-side)', () => {
  it('getGeometry / subscribeGeometry read the shape cache', () => {
    const { feed } = setup();
    feed.getGeometry('trip-1');
    expect(shapeCache.getLoaded).toHaveBeenCalledWith('trip-1');

    const cb = jest.fn();
    feed.subscribeGeometry(cb);
    expect(shapeCache.subscribeLoaded).toHaveBeenCalledWith(cb);
  });

  it('requestGeometry forwards the batch + priority bound to the session signal', () => {
    const { feed } = setup();
    feed.start();
    feed.requestGeometry(['a', 'b'], 2);
    expect(shapeCache.requestPrefetch).toHaveBeenCalledWith(['a', 'b'], 2, expect.any(AbortSignal));
    const signal = (shapeCache.requestPrefetch as jest.Mock).mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    feed.stop(); // backgrounding must free the scheduler queue
    expect(signal.aborted).toBe(true);
  });

  it('promoteGeometry: no-op when cached; promoteTag first; urgent prefetch as fallback', () => {
    const { feed } = setup();

    hasMock.mockReturnValueOnce(true);
    feed.promoteGeometry('cached-trip');
    expect(promoteTagMock).not.toHaveBeenCalled();
    expect(shapeCache.requestPrefetch).not.toHaveBeenCalled();

    promoteTagMock.mockReturnValueOnce(true);
    feed.promoteGeometry('queued-trip');
    expect(promoteTagMock).toHaveBeenCalledWith('queued-trip', 0);
    expect(shapeCache.requestPrefetch).not.toHaveBeenCalled();

    feed.promoteGeometry('cold-trip');
    expect(shapeCache.requestPrefetch).toHaveBeenCalledWith(['cold-trip'], 0, undefined);
  });

  it('promoteGeometry: a tapped PACK-SEEDED tram still jumps to the urgent lane', () => {
    // A provisional trip is resident (has() === true) yet its authoritative
    // timetable has not landed, so the tram sheet's stop timeline is still
    // withheld. Treating it as "cached" would leave a tapped tram waiting out
    // the background refinement queue — the one case priority 0 exists for.
    const { feed } = setup();
    hasMock.mockReturnValueOnce(true);
    provisionalMock.mockReturnValueOnce(true);

    feed.promoteGeometry('seeded-trip');

    expect(promoteTagMock).toHaveBeenCalledWith('seeded-trip', 0);
    expect(shapeCache.requestPrefetch).toHaveBeenCalledWith(['seeded-trip'], 0, undefined);
  });

  it('reportCalibration honors the passive-logging gate and swallows sink errors', () => {
    const sink = jest.fn();
    let enabled = true;
    const feed = new RemoteFeed({
      url: URL,
      createClient: () => new FakeConvexClient(),
      calibrationSink: sink,
      passiveLoggingEnabled: () => enabled,
    });
    const records: CalibrationRecord[] = [];

    feed.reportCalibration(records);
    expect(sink).toHaveBeenCalledTimes(1);

    enabled = false;
    feed.reportCalibration(records);
    expect(sink).toHaveBeenCalledTimes(1); // gate held: neither buffered nor written

    enabled = true;
    sink.mockImplementation(() => {
      throw new Error('storage full');
    });
    expect(() => feed.reportCalibration(records)).not.toThrow();
  });

  it('a throwing gate is swallowed (never into the ingest path)', () => {
    const sink = jest.fn();
    const feed = new RemoteFeed({
      url: URL,
      createClient: () => new FakeConvexClient(),
      calibrationSink: sink,
      passiveLoggingEnabled: () => {
        throw new Error('store exploded');
      },
    });
    expect(() => feed.reportCalibration([])).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });
});
