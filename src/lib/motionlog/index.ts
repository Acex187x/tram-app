// MotionLog singleton — wires the pure core (core.ts) to the real expo
// filesystem + location seams and the live tram runtime, and exposes a React
// hook for the UI.
//
// Passive daily logging is driven by piggy-backing on the runtime's 1 Hz UI
// notifications: on each notification we detect a fresh poll (lastPollAtMs
// advancing) and hand the current tram states to core.onPoll. This keeps the
// runtime file (hooks/tramData.ts) untouched — if that runtime is later wired
// to call getMotionLog().onPoll(...) directly, the self-attach here no-ops the
// duplicate (same poll timestamp is only logged once).
import { useSyncExternalStore } from 'react';

import { getRuntime } from '@/hooks/tramData';

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

// NOTE: passive poll logging is driven by hooks/tramData.ts calling
// getMotionLog().onPoll(...) directly after each ingest — do NOT also
// self-attach to the runtime here, or every poll gets logged twice.

/** App-wide MotionLog singleton (created lazily). */
export function getMotionLog(): MotionLog {
  if (!instance) {
    instance = new MotionLog({
      fs: createExpoFS(),
      location: createExpoLocationWatcher(),
      now: () => Date.now(),
      stateProvider: (key) => getRuntime().engine.getState(key, Date.now()),
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
