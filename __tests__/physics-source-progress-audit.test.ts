import { ResilientTrajectorySource } from '@/lib/physics/resilientSource';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import type { TrajectorySink } from '@/lib/physics/convexSource';
import { T0, wireVehicle } from './physicsFixtures';

const meta = (seq: number) => ({ atMs: Date.now(), serverNowMs: Date.now(),
  publishedAtMs: Date.now(), lastSeq: seq, horizonS: 120, generator: 'audit' });
const setup = () => {
  const store = new TrajectoryStore(); const sinks: TrajectorySink[] = [];
  const source = new ResilientTrajectorySource(store, { url: 'http://private', fallbackUrl: 'https://public',
    createSource: sink => { sinks.push(sink); return { start() {}, stop() {} }; } });
  source.start(); return { source, sinks, store };
};
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(T0); });
afterEach(() => jest.useRealTimers());

test('an advancing advertised cursor cannot hide a silently stalled diff stream indefinitely', () => {
  const c = setup();
  c.sinks[0].seedConvex([wireVehicle()], meta(1), Date.now());
  for (let seq = 2; seq <= 32; seq++) {
    c.sinks[0].noteConvexMeta(meta(seq), Date.now());
    jest.advanceTimersByTime(1000);
  }
  expect(c.sinks.length).toBeGreaterThan(1);
  c.source.stop();
});

test('a recovery probe with persistent advertised/applied cursor lag is not promoted', () => {
  const c = setup();
  jest.advanceTimersByTime(15000);
  c.sinks[1].seedConvex([wireVehicle({ key: 'public-current' })], meta(50), Date.now());
  jest.advanceTimersByTime(120000);
  c.sinks[2].seedConvex([wireVehicle({ key: 'private-old' })], meta(1), Date.now());
  for (let seq = 2; seq <= 12; seq++) {
    c.sinks[2].noteConvexMeta(meta(seq), Date.now());
    jest.advanceTimersByTime(1000);
  }
  expect(c.store.health().source?.active).toBe('fallback');
  expect(c.store.getVehicle('public-current')).toBeDefined();
  c.source.stop();
});

test('a replacement endpoint heartbeat cannot freshen retained curves before its seed arrives', () => {
  const c = setup();
  c.sinks[0].seedConvex([wireVehicle()], meta(1), Date.now());
  jest.advanceTimersByTime(15000);
  const retained = c.store.bundle!.atMs;
  c.sinks[1].noteConvexMeta(meta(900), Date.now());
  expect(c.store.health().source?.active).toBe('primary');
  expect(c.store.health().source?.connecting).toBe('fallback');
  expect(c.store.bundle!.atMs).toBe(retained);
  c.source.stop();
});

test('a lower-head backend epoch cannot freshen retained rows while its reseed is pending', () => {
  const c = setup();
  c.sinks[0].seedConvex([wireVehicle()], meta(900), Date.now());
  const retained = c.store.bundle!.atMs;
  jest.advanceTimersByTime(1000);
  // ConvexSource starts an asynchronous reseed before forwarding this reset
  // heartbeat; the replacement rows may still be unavailable for many seconds.
  c.sinks[0].noteConvexMeta(meta(1), Date.now());
  expect(c.store.health().lastSeq).toBe(900);
  expect(c.store.bundle!.atMs).toBe(retained);
  c.source.stop();
});
