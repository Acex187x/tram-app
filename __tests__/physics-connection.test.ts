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

describe('TrajectoryStore fetch lifecycle (perf invariant #3)', () => {
  const url = 'https://example.invalid/api/trajectories/v2';
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => wireBundle({ serverNowMs: Date.now() }),
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches immediately on start and then on the poll interval', async () => {
    const s = new TrajectoryStore(url);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    s.stop();
  });

  it('start() is idempotent', async () => {
    const s = new TrajectoryStore(url);
    s.start(5_000);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('stop() halts polling completely — nothing ticks in background', async () => {
    const s = new TrajectoryStore(url);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    s.stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.health(Date.now()).pollIntervalMs).toBe(0);
  });

  it('a response landing after stop() cannot mutate the store (generation guard)', async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const s = new TrajectoryStore(url);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    s.stop();
    // The in-flight fetch now resolves, far too late to be trusted.
    release({ ok: true, json: async () => wireBundle({ serverNowMs: T0 }) });
    await jest.advanceTimersByTimeAsync(0);
    expect(s.bundle).toBeNull();
    expect(s.clock.synced).toBe(false);
  });

  it('a failing fetch is recorded, never thrown, and keeps the last bundle', async () => {
    const s = new TrajectoryStore(url);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(s.bundle).not.toBeNull();

    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(s.health(Date.now()).consecutiveFailures).toBe(2);
    expect(s.health(Date.now()).lastError).toContain('503');
    expect(s.bundle).not.toBeNull(); // stale data still renders, visibly stale
    s.stop();
  });

  it('keeps the decoded bundle across stop/start — a stateless client needs no resync', async () => {
    const s = new TrajectoryStore(url);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    const before = s.bundle;
    s.stop();
    expect(s.bundle).toBe(before);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    s.stop();
  });
});
