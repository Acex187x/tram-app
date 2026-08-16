/// <reference types="jest" />
//
// TramRuntime rideBackground mode — the SANCTIONED exception to perf
// invariant #3 (docs/performance.md): backgrounding the app with a GPS ride
// recording active must NOT fully pause the runtime (the ride log would
// correlate against a frozen sim), but the exception is gated strictly on an
// active recording:
//   • background + riding      → rideBackground (both data sources poll at the
//                                 slow cadence; zero frame timer, zero render
//                                 pushes, zero UI notifications)
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
  frameTimer: unknown;
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
    expect(p.frameTimer).toBeNull();
    expect(p.uiNotifyTimer).toBeNull();

    // Absolutely nothing ticks afterwards.
    const frames: number[] = [];
    rt.subscribeFrame((t) => frames.push(t));
    jest.advanceTimersByTime(5_000);
    expect(frames).toHaveLength(0);
  });

  it('backgrounding WITH a ride enters rideBackground: slow feed poll, no frame pushes', () => {
    jest.useFakeTimers();
    const { rt, p, feed } = makeRuntime(() => true);
    p.resume();
    expect(feed.startCalls).toEqual([undefined]); // full-rate foreground start

    const frames: number[] = [];
    rt.subscribeFrame((t) => frames.push(t));

    p.onAppState('background');
    expect(p.runMode).toBe('rideBackground');
    // Feed restarted on the slow ride-background cadence. There is NO frame
    // timer any more: the ride recorder reads state on demand, and a stateless
    // evaluator is correct whenever it is asked (strictly less work than the
    // old 1 Hz engine tick this mode used to need).
    expect(feed.running).toBe(true);
    expect(feed.startCalls).toEqual([undefined, RIDE_BG_POLL_MS]);
    expect(p.frameTimer).toBeNull();
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
    expect(p.frameTimer).toBeNull();
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

// Physics v3 deleted the whole "engine clock across transitions" problem: the
// evaluator is stateless, so a suspension leaves nothing to reconcile — there
// is no clock to reset and no seek to perform. What must still hold is that
// both data sources follow the mode, and that rideBackground runs NO frame
// timer at all (a strictly smaller budget than the old 1 Hz tick).
describe('data sources follow the run mode', () => {
  it('rideBackground polls the feed AND trajectories at the slow cadence', () => {
    jest.useFakeTimers();
    const { rt, p, feed } = makeRuntime(() => true);
    const trajStart = jest.spyOn(rt.trajectories, 'start');
    const trajStop = jest.spyOn(rt.trajectories, 'stop');

    p.resume();
    expect(feed.startCalls).toEqual([undefined]);
    expect(trajStart).toHaveBeenLastCalledWith();

    p.onAppState('background');
    expect(p.runMode).toBe('rideBackground');
    expect(trajStop).toHaveBeenCalled();
    expect(trajStart).toHaveBeenLastCalledWith(RIDE_BG_POLL_MS);
    expect(feed.startCalls).toEqual([undefined, RIDE_BG_POLL_MS]);
  });

  it('rideBackground runs no frame timer — nothing renders while backgrounded', () => {
    jest.useFakeTimers();
    const { rt, p } = makeRuntime(() => true);
    let frames = 0;
    rt.subscribeFrame(() => {
      frames += 1;
    });

    p.resume();
    jest.advanceTimersByTime(1_000);
    expect(frames).toBeGreaterThan(0);

    const beforeBg = frames;
    p.onAppState('background');
    expect(p.frameTimer).toBeNull();
    jest.advanceTimersByTime(10_000);
    expect(frames).toBe(beforeBg);
  });

  it('a full pause stops trajectories too (invariant #3: no polling in background)', () => {
    jest.useFakeTimers();
    const { rt, p } = makeRuntime(() => false);
    const trajStop = jest.spyOn(rt.trajectories, 'stop');
    p.resume();
    p.onAppState('background');
    expect(p.runMode).toBe('paused');
    expect(trajStop).toHaveBeenCalled();
  });
});
