// MotionLog singleton — wires the pure core (core.ts) to the real expo
// filesystem + location seams and the live tram runtime, and exposes a React
// hook for the UI.
//
// Passive daily logging is driven by the FEED: LocalGolemioFeed
// (src/lib/feed/localGolemioFeed.ts) hands each batch's CalibrationRecords to
// getMotionLog().onCalibration(...). The feed owns WHEN records are produced;
// this module owns HOW/WHERE they are stored (buffering, flush, disk caps,
// export UX — all unchanged).
import { useSyncExternalStore } from 'react';

import { getRuntime } from '@/hooks/tramData';
import { useSettingsStore } from '@/stores/settings';

import { MotionLog } from './core';
import { createExpoFS } from './fs';
import { createExpoLocationWatcher } from './location';

export type {
  MotionFileInfo,
  MotionStats,
  RideInfo,
  RideStopResult,
  LocationSample,
  LocationWatcher,
  LocationWatchMode,
  MotionLogFS,
} from './core';
export { MotionLog } from './core';
export { parseRideFile, type ParsedRide } from './rideFile';

let instance: MotionLog | null = null;

// NOTE: passive poll logging is driven by the feed calling
// getMotionLog().onCalibration(...) once per snapshot batch — do NOT also
// self-attach to the runtime here, or every batch gets logged twice.

/** App-wide MotionLog singleton (created lazily). */
export function getMotionLog(): MotionLog {
  if (!instance) {
    const log = new MotionLog({
      fs: createExpoFS(),
      location: createExpoLocationWatcher(),
      now: () => Date.now(),
      stateProvider: (key) => getRuntime().engine.getState(key, Date.now()),
      geometry: (key) => getRuntime().engine.getGeometry(key),
      positionMode: () => useSettingsStore.getState().positionMode,
    });
    instance = log;
    // Crash recovery: close ride files a previous process death left open
    // (they keep every point written before the death, marked 'ride-orphaned').
    try {
      log.recoverOrphanRides();
    } catch {
      // never block startup
    }
    // rideBackground wiring: while a ride is recording, backgrounding must not
    // fully pause the runtime (see TramRuntime.onAppState); a ride stopping
    // while backgrounded must complete the pause. Registered here (not in
    // tramData) so the runtime module never imports motionlog.
    const rt = getRuntime();
    rt.setRideActivity(() => log.isRiding());
    log.subscribe(() => rt.notifyRideActivity());
  }
  return instance;
}

/** Subscribe a component to MotionLog changes (ride points, files). */
export function useMotionLog(): MotionLog {
  const log = getMotionLog();
  useSyncExternalStore(
    (cb) => log.subscribe(cb),
    () => log.getVersion(),
  );
  return log;
}
