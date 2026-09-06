import {
  ConvexTrajectorySource,
  TRAJ_BATCHES_QUERY,
  TRAJ_CLOCK_QUERY,
  TRAJ_META_QUERY,
  type ConvexTrajectoryClient,
  type TrajectoryBatchesResult,
  type TrajectoryMetaWire,
} from '@/lib/physics/convexSource';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { T0, wireVehicle } from './physicsFixtures';

function setup() {
  const store = new TrajectoryStore();
  const meta = (seq: number, t = T0): TrajectoryMetaWire => ({
    atMs: t,
    horizonS: 120,
    generator: 'test',
    lastSeq: seq,
    publishedAtMs: t,
    serverNowMs: t,
  });
  const state = {
    seedSeq: 40,
    seedQueries: 0,
    clockQueries: 0,
    batches: [] as ((b: TrajectoryBatchesResult) => unknown)[],
    meta: null as ((m: TrajectoryMetaWire) => unknown) | null,
    nonces: [] as string[],
    batchError: null as ((e: Error) => unknown) | null,
  };
  const client: ConvexTrajectoryClient = {
    query: (async (q: unknown, args: any) => {
      if (q === TRAJ_CLOCK_QUERY) {
        state.clockQueries++;
        state.nonces.push(args.nonce);
        return { serverNowMs: Date.now() };
      }
      state.seedQueries++;
      return {
        seq: state.seedSeq,
        vehicles: [wireVehicle()],
        meta: meta(state.seedSeq, Date.now()),
      };
    }) as ConvexTrajectoryClient['query'],
    onUpdate: (q, _args, callback, error) => {
      if (q === TRAJ_BATCHES_QUERY) {
        state.batches.push(callback as any);
        state.batchError = error ?? null;
      }
      if (q === TRAJ_META_QUERY) state.meta = callback as any;
      return () => undefined;
    },
    close: async () => undefined,
  };
  const source = new ConvexTrajectorySource(store, {
    url: 'https://invalid',
    createClient: () => client,
  });
  return { store, source, state, meta };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});
afterEach(() => jest.useRealTimers());

it('uses fresh nonces at start/minute/resume and stops clock work with the runtime', async () => {
  const { source, state, store } = setup();
  source.start();
  await flush();
  expect(store.clock.synced).toBe(true);
  expect(state.clockQueries).toBe(1);
  jest.advanceTimersByTime(60000);
  await flush();
  expect(state.clockQueries).toBe(2);
  expect(state.nonces[0]).not.toBe(state.nonces[1]);
  source.stop();
  jest.advanceTimersByTime(120000);
  await flush();
  expect(state.clockQueries).toBe(2);
  source.start();
  await flush();
  expect(state.clockQueries).toBe(3);
  source.stop();
});

it('a genuine backend cursor reset reseeds instead of filtering every future update forever', async () => {
  const { source, state, meta } = setup();
  source.start();
  await flush();
  state.seedSeq = 2;
  state.meta!(meta(2, T0 + 1000));
  await flush();
  expect(state.seedQueries).toBe(2);
  source.stop();
});

it('an older cached initial heartbeat cannot reset a newer seed', async () => {
  const { source, state, meta } = setup();
  source.start();
  await flush();
  state.meta!(meta(2, T0 - 1000));
  await flush();
  expect(state.seedQueries).toBe(1);
  source.stop();
});

it('callbacks queued by a replaced cursor cannot mutate or restart the new subscription', async () => {
  const { source, state, store } = setup();
  source.start();
  await flush();
  const old = state.batches[0];
  old({
    batches: Array.from({ length: 8 }, (_, i) => ({
      seq: 41 + i,
      atMs: T0 + i,
      changed: [],
    })),
    oldestSeq: 1,
    latestSeq: 48,
    serverNowMs: T0,
  });
  expect(state.batches).toHaveLength(2);
  old({
    batches: [{ seq: 100, atMs: T0, changed: [wireVehicle({ key: 'wrong' })] }],
    oldestSeq: 99,
    latestSeq: 100,
    serverNowMs: T0,
  });
  expect(state.seedQueries).toBe(1);
  expect(store.getVehicle('wrong')).toBeUndefined();
  source.stop();
});

it('a terminated batch subscription retries and recovers, with no retry after stop', async () => {
  const { source, state, store } = setup();
  source.start();
  await flush();
  state.batchError!(new Error('temporary query failure'));
  expect(store.health(T0).consecutiveFailures).toBe(1);
  jest.advanceTimersByTime(1999);
  await flush();
  expect(state.seedQueries).toBe(1);
  jest.advanceTimersByTime(1);
  await flush();
  expect(state.seedQueries).toBe(2);
  expect(store.health(T0).consecutiveFailures).toBe(0);
  state.batchError!(new Error('another failure'));
  source.stop();
  jest.advanceTimersByTime(60000);
  await flush();
  expect(state.seedQueries).toBe(2);
});

function pendingSeed() {
  const store = new TrajectoryStore();
  const resolveSeeds: ((value: any) => void)[] = [];
  let subscriptions = 0;
  const client: ConvexTrajectoryClient = {
    query: ((query: unknown) =>
      query === TRAJ_CLOCK_QUERY
        ? Promise.resolve({ serverNowMs: Date.now() })
        : new Promise((resolve) => resolveSeeds.push(resolve))) as ConvexTrajectoryClient['query'],
    onUpdate: () => {
      subscriptions++;
      return () => {};
    },
    close: async () => {},
  };
  const source = new ConvexTrajectorySource(store, {
    url: 'http://private-unreachable',
    createClient: () => client,
  });
  const result = () => ({
    seq: 1,
    vehicles: [wireVehicle()],
    meta: {
      atMs: Date.now(),
      serverNowMs: Date.now(),
      publishedAtMs: Date.now(),
      lastSeq: 1,
      horizonS: 120,
      generator: 'test',
    },
  });
  return { store, source, resolveSeeds, result, subscriptions: () => subscriptions };
}

it('a hanging cold seed becomes offline once, keeps one request, and accepts late success', async () => {
  const c = pendingSeed();
  c.source.start();
  await flush();
  expect(c.store.connection()).toBe('degraded');
  jest.advanceTimersByTime(15000);
  expect(c.store.connection()).toBe('offline');
  expect(c.store.health().consecutiveFailures).toBe(1);
  jest.advanceTimersByTime(120000);
  await flush();
  expect(c.resolveSeeds).toHaveLength(1);
  expect(c.store.health().consecutiveFailures).toBe(1);
  c.resolveSeeds[0](c.result());
  await flush();
  expect(c.store.connection()).toBe('live');
  expect(c.store.getVehicle('9201')).toBeDefined();
  c.source.stop();
});

it('background cleanup cancels the cold-seed watchdog and ignores its late completion after resume', async () => {
  const c = pendingSeed();
  c.source.start();
  jest.advanceTimersByTime(5000);
  c.source.stop();
  jest.advanceTimersByTime(60000);
  expect(c.store.health().consecutiveFailures).toBe(0);
  c.source.start();
  c.resolveSeeds[0](c.result());
  await flush();
  expect(c.store.getVehicle('9201')).toBeUndefined();
  expect(c.subscriptions()).toBe(2); // metadata only, once per foreground
  c.resolveSeeds[1](c.result());
  await flush();
  expect(c.subscriptions()).toBe(3); // current seed owns the batch subscription
  c.source.stop();
  jest.advanceTimersByTime(120000);
  expect(c.store.health().consecutiveFailures).toBe(0);
});
