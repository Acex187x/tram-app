// NEAREST STOP — the data half of the home sheet's hero card.
//
// THREE RULES, and they are the whole design:
//
//  1. ONE-SHOT LOCATION, NEVER A WATCHER. A watcher on the map screen would be
//     a second GPS consumer alongside the location puck for a card that shows a
//     stop name — `getCurrentPositionAsync` at BALANCED accuracy (±100 m) is
//     plenty to pick the nearest tram stop and costs a fraction of the High fix
//     the Locate button takes.
//  2. NEVER AUTO-PROMPT. An iOS permission dialog that appears because the user
//     dragged a sheet upward is hostile. On mount we only READ the permission;
//     the system dialog is only ever raised by a deliberate tap on the card's
//     own "Enable" row (`request()`).
//  3. THE FIX IS MODULE-CACHED, 120 s TTL. The card is MOUNT-GATED on the
//     settled detent (see HomeSheetContent's `live` prop) so nothing polls at
//     peek; the cache is what makes that gate free — re-expanding the sheet
//     re-renders the same station instantly instead of re-locating.
//
// Everything downstream recomputes on the SHARED 1 Hz tick (useNowMs /
// useAllTramStates), never on a timer of its own — docs/performance.md #1.

import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { useNowMs } from '@/hooks/uiClock';
import {
  computeArrivals,
  haversineM,
  nearestStation,
  walkSecondsForMeters,
  type StationInfo,
  type StopArrival,
} from '@/lib/arrivals';

/** How many arrivals the hero card shows. The full board lives on /stop/[key]. */
export const NEARBY_ARRIVALS = 4;

/** A location fix is reusable for this long before we ask the provider again. */
const FIX_TTL_MS = 120_000;

/**
 * Last fix + last resolved station name, at MODULE scope so they outlive the
 * card's mount/unmount cycle (the peek gate unmounts it on every collapse).
 * The name is what the peek-time placeholder renders, so the sheet's height
 * does not jolt as the gate flips.
 */
let cachedFix: { coords: [number, number]; atMs: number } | null = null;
let cachedStationName: string | null = null;

/** Station name from an earlier fix this session, for the placeholder row. */
export function lastKnownStopName(): string | null {
  return cachedStationName;
}

export type NearbyStatus =
  /** Permission never asked — offer the enable row. */
  | 'undetermined'
  /** Refused, and iOS will not ask again — send them to Settings. */
  | 'denied'
  /** Granted, one-shot fix in flight. */
  | 'locating'
  /** The fix failed (airplane mode, provider off) — offer a retry. */
  | 'error'
  /** Fix in hand, but no route geometry has streamed in yet. */
  | 'no-network'
  /** Fix + geometries, but nothing matched (user is not in Prague). */
  | 'no-stop'
  | 'ready';

export interface NearbyStop {
  status: NearbyStatus;
  station: StationInfo | null;
  /** Great-circle meters to the station's representative platform. */
  walkM: number | null;
  /** Estimated walking seconds (detour factor applied — see arrivals.ts). */
  walkS: number | null;
  /** Soonest arrivals at that station, ≤ NEARBY_ARRIVALS, recomputed at 1 Hz. */
  arrivals: StopArrival[];
  /** Ask for permission (if needed) and take a FRESH fix. Tap-driven only. */
  request: () => void;
}

/** Internal phase — the part of the status that location alone decides. */
type Phase = 'undetermined' | 'denied' | 'locating' | 'error' | 'fixed';

export function useNearbyStop(): NearbyStop {
  const [phase, setPhase] = useState<Phase>('locating');
  const [coords, setCoords] = useState<[number, number] | null>(null);
  // The sheet can be collapsed (and this hook unmounted) while a fix is in
  // flight — never set state from a resolution the user has already left.
  const mounted = useRef(true);

  const locate = useCallback(async () => {
    setPhase('locating');
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const next: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      cachedFix = { coords: next, atMs: Date.now() };
      if (!mounted.current) return;
      setCoords(next);
      setPhase('fixed');
    } catch {
      // Never an Alert and never a haptic: a location failure on the map screen
      // must stay a quiet row in a card, not an interruption.
      if (mounted.current) setPhase('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      // A warm fix short-circuits everything, including the permission read —
      // this is the path a sheet re-expansion takes.
      if (cachedFix != null && Date.now() - cachedFix.atMs < FIX_TTL_MS) {
        setCoords(cachedFix.coords);
        setPhase('fixed');
        return;
      }
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!mounted.current) return;
        if (!perm.granted) {
          setPhase(perm.canAskAgain ? 'undetermined' : 'denied');
          return;
        }
        await locate();
      } catch {
        if (mounted.current) setPhase('error');
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [locate]);

  const request = useCallback(() => {
    void (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!mounted.current) return;
        if (!perm.granted) {
          setPhase(perm.canAskAgain ? 'undetermined' : 'denied');
          return;
        }
        // An explicit tap is the ONE manual-refresh path: drop the cached fix so
        // "try again" genuinely re-asks the provider.
        cachedFix = null;
        await locate();
      } catch {
        if (mounted.current) setPhase('error');
      }
    })();
  }, [locate]);

  const geometries = useLoadedGeometries();
  const states = useAllTramStates();
  const nowMs = useNowMs();

  // NEAREST STATION — memoized on the geometry COUNT, not the array identity.
  // `useLoadedGeometries` hands back a fresh array on every 1 Hz tick, and this
  // scan is O(all stops of all trips) plus a haversine per station; keying it on
  // identity would re-run the whole thing every second for a set that only ever
  // changes when a new shape lands. The cache behind it only grows within a
  // session (shapeCache.memCache is never evicted), so the count is a sound
  // proxy for "the station set changed".
  const geoCount = geometries.length;
  const station = useMemo(
    () => (coords == null ? null : nearestStation(coords, geometries)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coords, geoCount],
  );

  // Remember the name for the peek placeholder. In an effect, not in render:
  // writing a module variable during render makes the component impure (React
  // Compiler is on).
  useEffect(() => {
    if (station != null) cachedStationName = station.name;
  }, [station]);

  const walkM = useMemo(
    () => (coords == null || station == null ? null : haversineM(coords, station.coordinates)),
    [coords, station],
  );
  const walkS = walkM == null ? null : walkSecondsForMeters(walkM);

  // Same 1 Hz cadence (and the same cost) as the stop sheet's own board, and it
  // only runs while the home sheet is settled open with no tram card over it.
  const arrivals = useMemo(
    () =>
      station == null
        ? []
        : computeArrivals(station.key, states, geometries, nowMs).slice(0, NEARBY_ARRIVALS),
    [station, states, geometries, nowMs],
  );

  const status: NearbyStatus =
    phase !== 'fixed'
      ? phase
      : geoCount === 0
        ? 'no-network'
        : station == null
          ? 'no-stop'
          : 'ready';

  return { status, station, walkM, walkS, arrivals, request };
}

/** '240 m' / '1.4 km' — rounded to 10 m, because the fix is ±100 m anyway. */
export function formatMeters(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Walking minutes, floored at 1 — "0 min walk" reads as a glitch. */
export function walkMinutes(walkS: number): number {
  return Math.max(1, Math.round(walkS / 60));
}
