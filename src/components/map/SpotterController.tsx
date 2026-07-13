// Spotter-mode controller — invisible, mounted once on the map screen.
// While a stop is being spotted it drives the EXISTING follow camera through
// selection.setFollowTramKey: acquire the tram arriving FIRST at the spotted
// stop, hold it (hysteresis lives in src/lib/spotter.ts) until it departs or
// vanishes, then switch to the next arrival — endlessly, until the user takes
// over or ✕'s the chip.
//
// PERF (docs/performance.md invariants): strictly 1 Hz — the engine component
// subscribes via the shared useAllTramStates/useLoadedGeometries hooks and
// steps once per UI version bump; no timers of its own. Zero cost while
// spotting is inactive: SpotterController renders null, so nothing below it
// mounts or subscribes.

import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';

import { getRuntime, useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { stepSpotter, type SpotterTracking } from '@/lib/spotter';
import { useSelectionStore } from '@/stores/selection';
import { useSpotterStore, type SpotterStation } from '@/stores/spotter';

/** Zoom for the initial fly-in and the waiting-at-the-stop camera. */
const STOP_ZOOM = 16.5;
/** Let the fly-to-the-stop (1.3 s) land before the follow camera grabs a target. */
const ACQUIRE_DELAY_MS = 1_600;

export function SpotterController() {
  const station = useSpotterStore((s) => s.station);
  if (!station) return null;
  // Keyed by station so switching the spotted stop resets all tracking refs.
  return <SpotterEngine key={station.key} station={station} />;
}

function SpotterEngine({ station }: { station: SpotterStation }) {
  // Shared 1 Hz subscriptions (perf invariant #1) — live only while spotting.
  const states = useAllTramStates();
  const geometries = useLoadedGeometries();
  const followTramKey = useSelectionStore((s) => s.followTramKey);

  const trackingRef = useRef<SpotterTracking | null>(null);
  /** The follow key THIS controller last set (null = we expect no follow). */
  const expectedFollowRef = useRef<string | null>(null);
  const mountedAtMsRef = useRef(Date.now());
  const firstReconcileRef = useRef(true);

  // ── User-takeover reconciliation ────────────────────────────────────────
  // The spotter owns followTramKey while active; any change it didn't make is
  // either the tram leaving the engine (spotter business — move on) or the
  // user taking control (follow-banner ✕, tapping another tram, locate, an
  // external fly-to) — which must NOT leave an orphaned spotter behind.
  useEffect(() => {
    if (firstReconcileRef.current) {
      // Mount-time value can still be a pre-spotting follow; the stop fly-in
      // requested at start consumes it (requestFlyTo cancels follow) — that
      // is not a user takeover.
      firstReconcileRef.current = false;
      return;
    }
    if (followTramKey === expectedFollowRef.current) return; // our own write
    if (followTramKey !== null) {
      // The user tapped/followed a DIFFERENT tram — they took control.
      useSpotterStore.getState().stop();
      return;
    }
    const expected = expectedFollowRef.current;
    if (expected !== null && getRuntime().engine.getState(expected) == null) {
      // TramLayers ended the follow because the tram left the engine — drop
      // the target and let the next 1 Hz step acquire the following arrival.
      trackingRef.current = null;
      expectedFollowRef.current = null;
      useSpotterStore.getState().setTarget(null);
      return;
    }
    // Follow cleared while the tram still exists: follow-banner ✕ / locate /
    // an external fly-to — the user took over, spotting ends with it.
    useSpotterStore.getState().stop();
  }, [followTramKey]);

  // ── 1 Hz spotting step (states identity changes once per UI bump) ────────
  useEffect(() => {
    // A same-render takeover above may already have stopped the session.
    if (useSpotterStore.getState().station?.key !== station.key) return;
    const nowMs = Date.now();
    // Let the fly-to-the-stop land before grabbing the follow camera.
    if (trackingRef.current === null && nowMs - mountedAtMsRef.current < ACQUIRE_DELAY_MS) return;

    const result = stepSpotter(trackingRef.current, station.key, states, geometries, nowMs);
    trackingRef.current = result.tracking;

    if (result.event === 'acquired' || result.event === 'switched') {
      const key = result.tracking!.targetKey;
      expectedFollowRef.current = key;
      useSelectionStore.getState().setFollowTramKey(key);
      const st = getRuntime().engine.getState(key);
      if (st) getRuntime().prioritizeTrip(st.snapshot.tripId);
      // Soft tick so the window-side spotter notices the hand-off.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    } else if (result.event === 'lost') {
      // Nobody inbound: release the follow and park the camera on the stop
      // until the next tram shows up in the data.
      expectedFollowRef.current = null;
      const selection = useSelectionStore.getState();
      selection.setFollowTramKey(null);
      selection.requestFlyTo({ coordinates: station.coordinates, zoom: STOP_ZOOM });
    }
    useSpotterStore.getState().setTarget(result.target);
  }, [states, geometries, station]);

  return null;
}
