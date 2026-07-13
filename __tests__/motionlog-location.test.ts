/// <reference types="jest" />
//
// createExpoLocationWatcher hardening (2026-07 review): the watcher must check
// the ACTUAL permission scope (not just the coarse status), and must report
// mode 'background' only after the native task has verifiably started —
// otherwise it falls back to the foreground-only watch and says so honestly.

import { createExpoLocationWatcher, RIDE_LOCATION_TASK } from '@/lib/motionlog/location';
import * as Location from 'expo-location';

jest.mock('expo-location', () => ({
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { AutomotiveNavigation: 2 },
  requestForegroundPermissionsAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
}));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
}));

const perms = Location.requestForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.requestForegroundPermissionsAsync
>;
const hasStarted = Location.hasStartedLocationUpdatesAsync as jest.MockedFunction<
  typeof Location.hasStartedLocationUpdatesAsync
>;
const startUpdates = Location.startLocationUpdatesAsync as jest.MockedFunction<
  typeof Location.startLocationUpdatesAsync
>;
const stopUpdates = Location.stopLocationUpdatesAsync as jest.MockedFunction<
  typeof Location.stopLocationUpdatesAsync
>;
const watchPosition = Location.watchPositionAsync as jest.MockedFunction<
  typeof Location.watchPositionAsync
>;

function grant(scope: 'whenInUse' | 'always' | 'none') {
  perms.mockResolvedValue({
    status: 'granted',
    ios: { scope },
  } as unknown as Awaited<ReturnType<typeof Location.requestForegroundPermissionsAsync>>);
}

beforeEach(() => {
  jest.clearAllMocks();
  stopUpdates.mockResolvedValue(undefined);
  startUpdates.mockResolvedValue(undefined);
  watchPosition.mockResolvedValue({ remove: jest.fn() } as unknown as Awaited<
    ReturnType<typeof Location.watchPositionAsync>
  >);
});

describe('createExpoLocationWatcher', () => {
  it('rejects when permission is denied', async () => {
    perms.mockResolvedValue({ status: 'denied' } as unknown as Awaited<
      ReturnType<typeof Location.requestForegroundPermissionsAsync>
    >);
    const w = createExpoLocationWatcher();
    await expect(w.start(() => {})).rejects.toThrow('permission denied');
    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('rejects when the granted status carries an unusable scope (none)', async () => {
    grant('none');
    const w = createExpoLocationWatcher();
    await expect(w.start(() => {})).rejects.toThrow('scope');
    expect(startUpdates).not.toHaveBeenCalled();
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it("reports 'background' only after the native task verifiably started", async () => {
    grant('whenInUse'); // Allow Once / While Using both arrive as this scope
    // First call: stale-registration check (false). Second: post-start verify (true).
    hasStarted.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const w = createExpoLocationWatcher();
    expect(w.mode?.()).toBeNull();

    const stop = await w.start(() => {});
    expect(startUpdates).toHaveBeenCalledWith(RIDE_LOCATION_TASK, expect.any(Object));
    expect(w.mode?.()).toBe('background');

    stop();
    expect(w.mode?.()).toBeNull();
    expect(stopUpdates).toHaveBeenCalledWith(RIDE_LOCATION_TASK);
  });

  it('falls back to the honest foreground watch when the native task never starts', async () => {
    grant('whenInUse');
    // startLocationUpdatesAsync resolves but the OS never armed the task.
    hasStarted.mockResolvedValue(false);
    const w = createExpoLocationWatcher();

    const stop = await w.start(() => {});
    expect(watchPosition).toHaveBeenCalled();
    expect(w.mode?.()).toBe('foreground');
    // Best-effort cleanup of the half-started task before falling back.
    expect(stopUpdates).toHaveBeenCalledWith(RIDE_LOCATION_TASK);
    stop();
    expect(w.mode?.()).toBeNull();
  });

  it('falls back to the foreground watch when starting the task throws', async () => {
    grant('always');
    hasStarted.mockResolvedValue(false);
    startUpdates.mockRejectedValue(new Error('background mode missing'));
    const w = createExpoLocationWatcher();

    await w.start(() => {});
    expect(watchPosition).toHaveBeenCalled();
    expect(w.mode?.()).toBe('foreground');
  });
});
