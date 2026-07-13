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
  LocationSample,
  LocationWatcher,
  MotionLogFS,
} from './core';
export { MotionLog } from './core';

let instance: MotionLog | null = null;

// NOTE: passive poll logging is driven by the feed calling
// getMotionLog().onCalibration(...) once per snapshot batch — do NOT also
// self-attach to the runtime here, or every batch gets logged twice.

/** App-wide MotionLog singleton (created lazily). */
export function getMotionLog(): MotionLog {
  if (!instance) {
    instance = new MotionLog({
      fs: createExpoFS(),
      location: createExpoLocationWatcher(),
      now: () => Date.now(),
      stateProvider: (key) => getRuntime().engine.getState(key, Date.now()),
      positionMode: () => useSettingsStore.getState().positionMode,
    });
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
