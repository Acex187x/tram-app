// MotionLog singleton — wires the pure core (core.ts) to the real expo
// filesystem + location seams and the live tram runtime, and exposes a React
// hook for the UI.
//
// Passive daily logging is driven by the FEED: LocalGolemioFeed
// (src/lib/feed/localGolemioFeed.ts) hands each batch's CalibrationRecords to
// getMotionLog().onCalibration(...). The feed owns WHEN records are produced;
// this module owns HOW/WHERE they are stored (buffering, flush, disk caps,
// export UX — all unchanged).
import { useEffect, useSyncExternalStore } from 'react';

import { getRuntime } from '@/hooks/tramData';
import { useSettingsStore } from '@/stores/settings';

import { MotionLog } from './core';
import { createExpoFS } from './fs';
import { createExpoLocationWatcher, createForegroundLocationWatcher } from './location';
import { OnlineLocator } from './onlinePosition';
import { createExpoDeviceMotionWatcher } from './sensors';

export type {
  MotionFileInfo,
  MotionSample,
  MotionStats,
  MotionWatcher,
  RideInfo,
  RideStopResult,
  LocationSample,
  LocationWatcher,
  LocationWatchMode,
  MotionLogFS,
} from './core';
export { MotionLog } from './core';
export { parseRideFile, type ParsedRide } from './rideFile';
export {
  GpsFilter,
  GPS_FILTER_DEFAULTS,
  type GpsFilterInput,
  type GpsFilterOptions,
  type GpsFilterOutput,
  type GpsFilterStats,
  type GpsRejectReason,
} from './gpsFilter';
export {
  OnlineLocator,
  projectOnlineFix,
  type OnlineFix,
  type OnlineProjection,
} from './onlinePosition';

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
      motion: createExpoDeviceMotionWatcher(),
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

let onlineLocator: OnlineLocator | null = null;

/**
 * App-wide OnlineLocator singleton (created lazily) — the debug overlay's live
 * on-line GPS source. Foreground-only watch, separate from ride recording.
 */
export function getOnlineLocator(): OnlineLocator {
  if (!onlineLocator) {
    onlineLocator = new OnlineLocator({
      location: createForegroundLocationWatcher(),
      now: () => Date.now(),
    });
  }
  return onlineLocator;
}

/**
 * Keep the OnlineLocator watching while the calling component (the debug
 * overlay) is mounted, and re-render it on each fix. Nothing watches while no
 * component holds it — zero cost when the debug overlay is unmounted.
 */
export function useOnlineLocator(): OnlineLocator {
  const locator = getOnlineLocator();
  useEffect(() => {
    locator.retain();
    return () => locator.release();
  }, [locator]);
  useSyncExternalStore(
    (cb) => locator.subscribe(cb),
    () => locator.getVersion(),
  );
  return locator;
}
