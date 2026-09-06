import { ResilientTrajectorySource } from '@/lib/physics/resilientSource';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import type { TrajectorySink } from '@/lib/physics/convexSource';
import { T0, wireVehicle } from './physicsFixtures';

const meta = (seq = 1, atMs = Date.now()) => ({
  atMs, serverNowMs: atMs, publishedAtMs: atMs, lastSeq: seq,
  horizonS: 120, generator: 'test',
});
function setup(fallbackUrl: string | undefined = 'https://public') {
  const store = new TrajectoryStore();
  const endpoints: { sink: TrajectorySink; url: string; started: number; stopped: number }[] = [];
  const source = new ResilientTrajectorySource(store, {
    url: 'http://private', fallbackUrl,
    createSource: (sink, options) => {
      const endpoint = { sink, url: options.url, started: 0, stopped: 0 };
      endpoints.push(endpoint);
      return { start: () => { endpoint.started++; }, stop: () => { endpoint.stopped++; } };
    },
  });
  source.start();
  const seed = (index: number, seq = 1, key = '9201') => {
    endpoints[index].sink.seedConvex([wireVehicle({ key })], meta(seq), Date.now());
  };
  return { store, endpoints, source, seed };
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(T0); });
afterEach(() => jest.useRealTimers());

it('private cold timeout uses public seed, ignores closed endpoint callbacks, resets independent cursors', () => {
  const c = setup();
  jest.advanceTimersByTime(15000);
  expect(c.endpoints.map(e => e.url)).toEqual(['http://private', 'https://public']);
  expect(c.endpoints[0].stopped).toBe(1);
  c.seed(1, 2, 'public');
  expect(c.store.health().source?.active).toBe('fallback');
  expect(c.store.health().lastSeq).toBe(2);
  c.seed(0, 10000, 'private-late');
  c.endpoints[0].sink.noteConvexFailure('late failure');
  expect(c.store.getVehicle('public')).toBeDefined();
  expect(c.store.getVehicle('private-late')).toBeUndefined();
  expect(c.store.health().lastError).toBeNull();
  c.source.stop();
});

it('metadata alone cannot hide a seed that never resolves', () => {
  const c = setup();
  for (let i = 0; i < 15; i++) {
    c.endpoints[0].sink.noteConvexMeta(meta(i), Date.now());
    jest.advanceTimersByTime(1000);
  }
  expect(c.endpoints).toHaveLength(2);
  c.source.stop();
});

it('quiet fleet publisher progress stays primary, cached heartbeat cannot keep it alive', () => {
  const c = setup();
  c.seed(0, 900);
  for (let i = 0; i < 60; i++) {
    c.endpoints[0].sink.noteConvexMeta(meta(900), Date.now());
    jest.advanceTimersByTime(1000);
  }
  expect(c.endpoints).toHaveLength(1);
  const cached = meta(900);
  for (let i = 0; i < 20; i++) {
    c.endpoints[0].sink.noteConvexMeta(cached, Date.now());
    jest.advanceTimersByTime(1000);
  }
  expect(c.endpoints).toHaveLength(2);
  c.seed(1, 1);
  c.endpoints[1].sink.foldConvex({ seq: 2, atMs: Date.now(), changed: [wireVehicle({ key: 'new' })] }, Date.now(), Date.now());
  expect(c.store.getVehicle('new')).toBeDefined();
  c.source.stop();
});

it('a live heartbeat with persistently broken vehicle subscription triggers fallback', () => {
  const c = setup(); c.seed(0);
  c.endpoints[0].sink.noteConvexFailure('batch query terminated');
  for (let i = 0; i < 15; i++) {
    c.endpoints[0].sink.noteConvexMeta(meta(i), Date.now());
    jest.advanceTimersByTime(1000);
  }
  expect(c.endpoints).toHaveLength(2);
  expect(c.store.health().source?.reason).toMatch(/persistently|rows lagged/);
  c.source.stop();
});

it('brief metadata lead is allowed when its vehicle batch catches up', () => {
  const c = setup(); c.seed(0);
  for (let seq = 2; seq <= 8; seq++) {
    c.endpoints[0].sink.noteConvexMeta(meta(seq), Date.now());
    jest.advanceTimersByTime(2000);
    c.endpoints[0].sink.foldConvex({ seq, atMs: Date.now(), changed: [] }, Date.now(), Date.now());
    jest.advanceTimersByTime(2000);
  }
  expect(c.endpoints).toHaveLength(1);
  expect(c.store.health().lastSeq).toBe(8);
  c.source.stop();
});

it('recovery probes are bounded and background closes both sockets/timers', () => {
  const c = setup();
  jest.advanceTimersByTime(135000);
  expect(c.endpoints).toHaveLength(3);
  expect(c.store.health().source?.probing).toBe(true);
  jest.advanceTimersByTime(20000);
  expect(c.endpoints[2].stopped).toBe(1);
  expect(c.store.health().source?.probing).toBe(false);
  jest.advanceTimersByTime(100000);
  expect(c.endpoints).toHaveLength(4);
  c.source.stop();
  expect(c.endpoints[1].stopped).toBe(1);
  expect(c.endpoints[3].stopped).toBe(1);
  jest.advanceTimersByTime(600000);
  expect(c.endpoints).toHaveLength(4);
});

it('recovery requires sustained advancing publications and atomically folds probe updates/removals', () => {
  const c = setup();
  jest.advanceTimersByTime(15000); c.seed(1, 500, 'old-public');
  jest.advanceTimersByTime(120000); c.seed(2, 2, 'removed');
  expect(c.store.getVehicle('removed')).toBeUndefined();
  jest.advanceTimersByTime(5000);
  c.endpoints[2].sink.foldConvex({ seq: 3, atMs: Date.now(), changed: [wireVehicle({ key: 'recovered' })], removed: ['removed'] }, Date.now(), Date.now());
  // Meta may lead the staged batch cursor; it must not skip unreceived batch4.
  c.endpoints[2].sink.noteConvexMeta(meta(4), Date.now());
  jest.advanceTimersByTime(1000);
  expect(c.store.health().source?.active).toBe('fallback');
  c.endpoints[2].sink.foldConvex({ seq: 4, atMs: Date.now(), changed: [wireVehicle({ key: 'next' })] }, Date.now(), Date.now());
  jest.advanceTimersByTime(1000);
  expect(c.store.health().source?.active).toBe('primary');
  expect(c.endpoints[1].stopped).toBe(1);
  expect(c.store.getVehicle('recovered')).toBeDefined();
  expect(c.store.getVehicle('removed')).toBeUndefined();
  expect(c.store.getVehicle('old-public')).toBeUndefined();
  expect(c.store.health().lastSeq).toBe(4);
  expect(c.store.getVehicle('next')).toBeDefined();
  c.source.stop();
});

it('a one-off recovered seed followed by cached replies is not promoted', () => {
  const c = setup(); jest.advanceTimersByTime(135000); c.seed(2);
  const cached = meta();
  for (let i = 0; i < 20; i++) {
    c.endpoints[2].sink.noteConvexMeta(cached, Date.now());
    jest.advanceTimersByTime(1000);
  }
  expect(c.store.health().source?.active).toBe('fallback');
  expect(c.endpoints[2].stopped).toBe(1);
  c.source.stop();
});

it('production URL alone never creates failover/probe timers', () => {
  const c = setup('http://private');
  jest.advanceTimersByTime(600000);
  expect(c.endpoints).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
  c.source.stop();
});

it('clock confidence belongs to a source epoch but render time never jumps on replacement', () => {
  const c = setup();
  c.endpoints[0].sink.noteConvexClock(T0 + 8000, T0, T0);
  c.seed(0);
  jest.advanceTimersByTime(15000);
  const before = c.store.nowMs();
  c.seed(1);
  expect(c.store.nowMs()).toBe(before);
  expect(c.store.clock.synced).toBe(false);
  c.endpoints[1].sink.noteConvexClock(Date.now() + 8500, Date.now(), Date.now());
  expect(c.store.nowMs()).toBe(before);
  expect(c.store.clock.synced).toBe(true);
  expect(c.store.nowMs(Date.now() + 1000) - before).toBeCloseTo(1050);
  c.source.stop();
});

it('retained curves keep their real source label while a replacement seed is pending', () => {
  const c = setup(); c.seed(0);
  jest.advanceTimersByTime(15000);
  expect(c.store.getVehicle('9201')).toBeDefined();
  expect(c.store.health().source?.active).toBe('primary');
  expect(c.store.health().source?.connecting).toBe('fallback');
  c.seed(1);
  expect(c.store.health().source?.active).toBe('fallback');
  expect(c.store.health().source?.connecting).toBeNull();
  c.source.stop(); c.source.start();
  expect(c.store.health().source?.active).toBe('fallback');
  expect(c.store.health().source?.connecting).toBe('primary');
  c.source.stop();
});

it('probe staging rejects malformed and older vehicle revisions before promotion', () => {
  const c = setup(); jest.advanceTimersByTime(135000); c.seed(2, 1);
  c.endpoints[2].sink.foldConvex({ seq: 2, atMs: Date.now(), changed: [
    wireVehicle({ key: 'winner', emittedAtMs: T0 + 5000 }),
  ] }, Date.now(), Date.now());
  jest.advanceTimersByTime(5000);
  c.endpoints[2].sink.foldConvex({ seq: 3, atMs: Date.now(), changed: [
    wireVehicle({ key: 'winner', emittedAtMs: T0 }), { key: 'malformed' },
  ] }, Date.now(), Date.now());
  jest.advanceTimersByTime(1000);
  expect(c.store.getVehicle('winner')?.emittedAtMs).toBe(T0 + 5000);
  expect(c.store.getVehicle('malformed')).toBeUndefined();
  c.source.stop();
});
