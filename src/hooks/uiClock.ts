// ONE shared 1 Hz clock for every live counter in the app. It rides the
// runtime's existing UI notification (bumpUi, 1 Hz) instead of owning a
// setInterval, which buys two things: every counter flips on the SAME tick
// (independently-phased intervals made the freshness age and an ETA disagree by
// up to a second), and the clock inherits the runtime lifecycle, so nothing
// ticks while the app is backgrounded (perf invariant B.3). The snapshot is
// cached per uiVersion because useSyncExternalStore requires a stable read.
import { useState, useSyncExternalStore } from 'react';

import { getRuntime } from '@/hooks/tramData';

let clockUiVersion = -1;
let clockNowMs = 0;

function readNowMs(): number {
  const v = getRuntime().getUiVersion();
  if (v !== clockUiVersion) {
    clockUiVersion = v;
    clockNowMs = Date.now();
  }
  return clockNowMs;
}

/** Now-ms on the shared 1 Hz tick — e.g. the "updated Ns ago" freshness value. */
export function useNowMs(): number {
  return useSyncExternalStore(getRuntime().subscribeUi, readNowMs);
}

/**
 * Live ETA countdown. Anchors on every fresh runtime value (~1 Hz) and counts
 * down off the shared clock, so it never freezes between polls. The anchor lives
 * in state and is adjusted during render when the prop changes (the documented
 * React pattern) rather than in a ref: mutating a ref or calling Date.now()
 * during render makes the component impure and opts it out of React Compiler
 * memoization.
 */
export function useEtaCountdown(etaS: number | null): number | null {
  const nowMs = useNowMs();
  const [anchor, setAnchor] = useState<{ etaS: number; atMs: number } | null>(() =>
    etaS == null ? null : { etaS, atMs: nowMs },
  );
  const [prevEtaS, setPrevEtaS] = useState(etaS);
  if (etaS !== prevEtaS) {
    setPrevEtaS(etaS);
    setAnchor(etaS == null ? null : { etaS, atMs: nowMs });
  }

  if (anchor == null) return null;
  return Math.max(0, Math.round(anchor.etaS - (nowMs - anchor.atMs) / 1000));
}
