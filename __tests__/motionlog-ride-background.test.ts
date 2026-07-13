/// <reference types="jest" />
//
// TramRuntime rideBackground mode — the SANCTIONED exception to perf
// invariant #3 (docs/performance.md): backgrounding the app with a GPS ride
// recording active must NOT fully pause the runtime (the ride log would
// correlate against a frozen sim), but the exception is gated strictly on an
// active recording:
//   • background + riding      → rideBackground (slow feed poll, 1 Hz tick,
//                                 zero render pushes / UI notifications)
//   • background + NOT riding  → full pause (invariant #3 intact, verbatim)
//   • ride stops in background → immediate full pause
//   • foreground               → full resume
import { RIDE_BG_POLL_MS, TramRuntime } from '@/hooks/tramData';
import type { CalibrationRecord, FeedPriority, FeedStatus, TramFeed } from '@/lib/feed/types';
import type { RouteGeometry, TramSnapshot } from '@/lib/types';

class FakeFeed implements TramFeed {
  startCalls: (number | undefined)[] = [];
  stopCalls = 0;
  running = false;

  subscribeSnapshots(_cb: (snapshots: TramSnapshot[], atMs: number) => void): () => void {
    return () => {};
  }
  getGeometry(_tripId: string): RouteGeometry | undefined {
    return undefined;
  }
  requestGeometry(_tripIds: string[], _priority: FeedPriority): void {}
  promoteGeometry(_tripId: string): void {}
  reportCalibration(_records: CalibrationRecord[]): void {}
  status(): FeedStatus {
    return { lastBatchAtMs: 0, lastError: null } as FeedStatus;
  }
  start(pollMs?: number): void {
    this.startCalls.push(pollMs);
    this.running = true;
  }
  stop(): void {
    this.stopCalls += 1;
    this.running = false;
  }
}

/** Access the runtime's private lifecycle for direct transition testing. */
interface RuntimePrivate {
  refCount: number;
  runMode: 'paused' | 'active' | 'rideBackground';
  tickTimer: unknown;
  uiNotifyTimer: unknown;
  resume(): void;
  onAppState(status: string): void;
}

function makeRuntime(riding: () => boolean) {
  const feed = new FakeFeed();
  const rt = new TramRuntime(feed);
  const p = rt as unknown as RuntimePrivate;
  p.refCount = 1; // as if retained by a mounted screen
  rt.setRideActivity(riding);
  return { rt, p, feed };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('TramRuntime rideBackground transitions', () => {
  it('backgrounding WITHOUT a ride pauses fully (invariant #3 verbatim)', () => {
    jest.useFakeTimers();
    const { rt, p, feed } = makeRuntime(() => false);
    p.resume();
    expect(p.runMode).toBe('active');
    expect(feed.running).toBe(true);

    p.onAppState('background');
    expect(p.runMode).toBe('paused');
    expect(feed.running).toBe(false);
    expect(p.tickTimer).toBeNull();
    expect(p.uiNotifyTimer).toBeNull();

    // Absolutely nothing ticks afterwards.
    const frames: number[] = [];
    rt.subscribeFrame((t) => frames.push(t));
    jest.advanceTimersByTime(5_000);
    expect(frames).toHaveLength(0);
  });

  it('backgrounding WITH a ride enters rideBackground: slow feed poll, tick alive, no frame pushes', () => {
    jest.useFakeTimers();
    const { rt, p, feed } = makeRuntime(() => true);
    p.resume();
    expect(feed.startCalls).toEqual([undefined]); // full-rate foreground start

    const frames: number[] = [];
    rt.subscribeFrame((t) => frames.push(t));

    p.onAppState('background');
    expect(p.runMode).toBe('rideBackground');
    // Feed restarted on the slow ride-background cadence, engine tick alive.
    expect(feed.running).toBe(true);
    expect(feed.startCalls).toEqual([undefined, RIDE_BG_POLL_MS]);
    expect(p.tickTimer).not.toBeNull();
    // The UI notifier is off and render pushes NEVER fire in rideBackground.
    expect(p.uiNotifyTimer).toBeNull();
    jest.advanceTimersByTime(5_000);
    expect(frames).toHaveLength(0);
  });

  it('a ride stopping while backgrounded completes the full pause', () => {
    jest.useFakeTimers();
    let riding = true;
    const { rt, p, feed } = makeRuntime(() => riding);
    p.resume();
    p.onAppState('background');
    expect(p.runMode).toBe('rideBackground');

    // stopRide (user action or the 90 min auto-stop) → motionlog notifies.
    riding = false;
    rt.notifyRideActivity();
    expect(p.runMode).toBe('paused');
    expect(feed.running).toBe(false);
    expect(p.tickTimer).toBeNull();
  });

  it('notifyRideActivity while still riding does NOT pause rideBackground', () => {
    jest.useFakeTimers();
    const { rt, p } = makeRuntime(() => true);
    p.resume();
    p.onAppState('background');
    rt.notifyRideActivity(); // fired on every ride point append
    expect(p.runMode).toBe('rideBackground');
  });

  it('foregrounding from rideBackground restores the full-rate runtime', () => {
    jest.useFakeTimers();
    const { rt, p, feed } = makeRuntime(() => true);
    p.resume();
    p.onAppState('background');
    p.onAppState('active');
    expect(p.runMode).toBe('active');
    expect(feed.startCalls).toEqual([undefined, RIDE_BG_POLL_MS, undefined]);
    expect(p.uiNotifyTimer).not.toBeNull();

    // Frame pushes flow again at the foreground cadence.
    const frames: number[] = [];
    rt.subscribeFrame((t) => frames.push(t));
    jest.advanceTimersByTime(1_000);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('inactive (e.g. the permission dialog during startRide) keeps a live recording alive', () => {
    jest.useFakeTimers();
    const { p, feed } = makeRuntime(() => true);
    p.resume();
    p.onAppState('inactive');
    expect(p.runMode).toBe('rideBackground');
    expect(feed.running).toBe(true);
  });
});

describe('engine tick clock across mode transitions (audit P0)', () => {
  it('every transition resets the engine clock — a suspension gap is never integrated', () => {
    jest.useFakeTimers();
    let riding = true;
    const { rt, p } = makeRuntime(() => riding);
    const resets = jest.spyOn(rt.engine, 'resetClock');

    p.resume();
    expect(resets).toHaveBeenCalledTimes(0); // cold start: nothing to reset yet

    p.onAppState('background'); // active → rideBackground (halt + slow timers)
    expect(resets).toHaveBeenCalledTimes(1);

    p.onAppState('active'); // rideBackground → active
    expect(resets).toHaveBeenCalledTimes(2);

    p.onAppState('background'); // → rideBackground again…
    riding = false;
    rt.notifyRideActivity(); // …ride stops in background → full pause
    expect(resets).toHaveBeenCalledTimes(4);
    // After the pause the first tick of the NEXT mode anchors instead of
    // integrating the suspension gap (engine-substep.test.ts covers the
    // engine-side semantics of resetClock).
  });

  it('rideBackground ticks the engine at 1 Hz with real timestamps (substep integration input)', () => {
    jest.useFakeTimers();
    const { rt, p } = makeRuntime(() => true);
    p.resume();
    p.onAppState('background');
    const ticks = jest.spyOn(rt.engine, 'tick');
    jest.advanceTimersByTime(5_000);
    // One engine tick per RIDE_BG_TICK_MS: the engine now substeps each 1 s
    // interval internally (4 × 250 ms), so this cadence advances the sim at
    // true wall-clock rate — the old dt clamp made it 4× slow (the P0 bug).
    expect(ticks).toHaveBeenCalledTimes(5);
  });
});
