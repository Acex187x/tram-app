// /planner — Tram Spotter's route-and-vehicle matcher. Pick two stops (or a
// recent pair / your nearest stop), plan over the loaded tram graph, then show
// the exact live vehicle assigned to every leg before handing the route to the
// map via usePlannerStore.
//
// Surface: <SheetSurface/>, the shared route-sheet scaffold. The root used to be
// a GlassPanel with its own hand-coded borderRadius: 24 — glass-on-glass over
// the system formSheet's Liquid Glass, AND a second, silently diverging copy of
// the sheet corner radius. Both now come from one place (sheetLook.SHEET_RADIUS,
// applied by the sheet() factory in _layout). The scroll body is the surface's
// own ScrollView, which also puts it back at the top level of the screen where
// rn-screens can find it and wire drag-to-expand.
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { GuidanceStepper } from '@/components/planner/GuidanceStepper';
import { ItineraryCard, RouteVehicleRoster } from '@/components/planner/ItineraryCard';
import { RecentRoutes } from '@/components/planner/RecentRoutes';
import { StopSearchCard } from '@/components/planner/StopSearchCard';
import { SheetHeader } from '@/components/ui/SheetHeader';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { appleScheme, Radii, Spacing, TextScale, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import {
  computeItineraryTiming,
  computeLeaveByMs,
  formatCountdown,
  itineraryAccessWalkS,
  nearestStation,
  type ItineraryTiming,
} from '@/lib/arrivals';
import { formatPragueClock } from '@/lib/format/pragueTime';
import { buildNetwork, normalizeName } from '@/lib/planner/network';
import { planItineraries } from '@/lib/planner/planner';
import type { PlannerItinerary } from '@/lib/types';
import { usePlannerStore } from '@/stores/planner';

type PlanError =
  | { type: 'same' }
  | { type: 'unknown'; field: 'from' | 'to'; name: string };

interface RankedResult {
  itinerary: PlannerItinerary;
  timing: ItineraryTiming;
  /** Walking seconds from the user's location to the boarding stop (null unknown). */
  walkS: number | null;
  /** Leave-by wall clock (departure − walk − buffer), when live + walk known. */
  leaveByMs: number | null;
}

export default function PlannerScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const geometries = useLoadedGeometries();
  // Live tram states (~1 Hz) drive the wall-clock departure/arrival times on
  // the itinerary cards + active banner.
  const states = useAllTramStates();
  const itinerary = usePlannerStore((s) => s.itinerary);
  const setItinerary = usePlannerStore((s) => s.setItinerary);
  const recents = usePlannerStore((s) => s.recents);
  const addRecent = usePlannerStore((s) => s.addRecent);
  const removeRecent = usePlannerStore((s) => s.removeRecent);
  const prefill = usePlannerStore((s) => s.prefill);
  const clearPrefill = usePlannerStore((s) => s.clearPrefill);
  const guidance = usePlannerStore((s) => s.guidance);
  const guidanceProgress = usePlannerStore((s) => s.guidanceProgress);
  const startGuidance = usePlannerStore((s) => s.startGuidance);
  const stopGuidance = usePlannerStore((s) => s.stopGuidance);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [results, setResults] = useState<PlannerItinerary[] | null>(null);
  const [error, setError] = useState<PlanError | null>(null);
  const [locating, setLocating] = useState(false);
  // Device location, when available — drives the nearest-stop From autofill
  // and the walk-time math on results. Null = permission denied / unknown.
  const [userCoords, setUserCoords] = useState<[number, number] | null>(null);
  // Wall-clock second tick — refreshes the 'in N min' countdowns while the sheet
  // is open (independent of the ~1 Hz states cadence).
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Focus To (keyboard up) on a plain open — not when a prefill handoff is
  // about to auto-plan, and not when reopened over an active route/guidance.
  const [autoFocusTo] = useState(() => {
    const s = usePlannerStore.getState();
    return s.prefill == null && s.itinerary == null;
  });

  const loading = geometries.length === 0;

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // On open: silently read the device location. Graceful throughout — denied
  // permission or a location error just leaves From empty and walk math off
  // (no alerts on this path; the manual locate button keeps its alerts).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!cancelled) setUserCoords([pos.coords.longitude, pos.coords.latitude]);
      } catch {
        // graceful: no location → no autofill, no walk times
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Autofill From with the nearest stop once location + geometry are both in —
  // one-shot, and only when the user hasn't typed/prefilled anything yet.
  const autoFilledRef = useRef(false);
  useEffect(() => {
    if (autoFilledRef.current || !userCoords || loading) return;
    if (usePlannerStore.getState().prefill) return; // "Route here" handoff wins
    const station = nearestStation(userCoords, geometries);
    if (!station) {
      autoFilledRef.current = true;
      return;
    }
    // Deferred a tick: no synchronous setState in an effect body.
    const t = setTimeout(() => {
      autoFilledRef.current = true;
      setFrom((prev) => (prev.trim().length > 0 ? prev : station.name));
    }, 0);
    return () => clearTimeout(t);
  }, [userCoords, loading, geometries]);

  // Station index for suggestion badges + input validation. Keyed on the NUMBER
  // of loaded geometries, not the array: `useLoadedGeometries()` hands back a
  // fresh array on every call, so a `[geometries]` dep rebuilt the whole graph
  // on every render (including each 1 Hz clock tick) and on every keystroke.
  // The cache only ever gains trips — an already-loaded tripId short-circuits
  // before the write — so its size is a faithful version of the geometry set.
  const geometryCount = geometries.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const network = useMemo(() => buildNetwork(geometries), [geometryCount]);

  // Suggestions scan the MEMOIZED graph. `searchStops(query, geometries)` calls
  // buildNetwork internally, i.e. rebuilds the whole network per keystroke.
  const search = useCallback(
    (query: string): string[] => {
      const q = normalizeName(query);
      if (q.length === 0) return [];
      const prefix: string[] = [];
      const substring: string[] = [];
      for (const node of network.stations.values()) {
        const idx = node.key.indexOf(q);
        if (idx === 0) prefix.push(node.name);
        else if (idx > 0) substring.push(node.name);
      }
      prefix.sort((a, b) => a.localeCompare(b));
      substring.sort((a, b) => a.localeCompare(b));
      return [...prefix, ...substring].slice(0, 8);
    },
    [network],
  );

  const linesFor = useCallback(
    (name: string): string[] => {
      const node = network.stations.get(normalizeName(name));
      if (!node) return [];
      return [...node.lines].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    },
    [network],
  );

  const invalidate = useCallback(() => {
    setResults(null);
    setError(null);
  }, []);

  const handleChangeFrom = useCallback(
    (text: string) => {
      setFrom(text);
      invalidate();
    },
    [invalidate],
  );

  const handleChangeTo = useCallback(
    (text: string) => {
      setTo(text);
      invalidate();
    },
    [invalidate],
  );

  const handleSwap = useCallback(() => {
    setFrom(to);
    setTo(from);
    invalidate();
  }, [from, to, invalidate]);

  // Core planning routine, driven by explicit values so button press, keyboard
  // submit, recent-pick and prefill auto-plan all share one path. BFS runs ONLY
  // here (never during render).
  const runPlan = useCallback(
    (fromVal: string, toVal: string): boolean => {
      Keyboard.dismiss();
      const fromKey = normalizeName(fromVal);
      const toKey = normalizeName(toVal);
      if (!network.stations.has(fromKey)) {
        setResults(null);
        setError({ type: 'unknown', field: 'from', name: fromVal.trim() });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return false;
      }
      if (!network.stations.has(toKey)) {
        setResults(null);
        setError({ type: 'unknown', field: 'to', name: toVal.trim() });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return false;
      }
      if (fromKey === toKey) {
        setResults(null);
        setError({ type: 'same' });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return false;
      }

      const found = planItineraries(fromVal, toVal, geometries);
      setError(null);
      setResults(found);
      if (found.length > 0) addRecent(fromVal, toVal);
      void Haptics.notificationAsync(
        found.length > 0
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      return found.length > 0;
    },
    [network, geometries, addRecent],
  );

  const canPlan = !loading && from.trim().length > 0 && to.trim().length > 0;

  const handlePlan = useCallback(() => {
    if (!canPlan) return;
    runPlan(from, to);
  }, [canPlan, from, to, runPlan]);

  const handlePickRecent = useCallback(
    (recentFrom: string, recentTo: string) => {
      setFrom(recentFrom);
      setTo(recentTo);
      runPlan(recentFrom, recentTo);
    },
    [runPlan],
  );

  // Nearest stop → From field, via device location. Permission denial + errors
  // surface as a friendly alert; never throws into render.
  const handleLocate = useCallback(async () => {
    if (loading) return;
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location off',
          'Allow location access to fill the nearest stop automatically.',
          [
            { text: 'Not Now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setUserCoords([pos.coords.longitude, pos.coords.latitude]);
      const station = nearestStation([pos.coords.longitude, pos.coords.latitude], geometries);
      if (!station) {
        Alert.alert('No nearby stop', 'No tram stop is loaded near you yet — try again shortly.');
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setFrom(station.name);
      invalidate();
    } catch {
      Alert.alert('Location unavailable', "Couldn't read your location. Please try again.");
    } finally {
      setLocating(false);
    }
  }, [loading, geometries, invalidate]);

  // One-shot prefill handoff from the stop sheet's "Route here": fill both
  // fields, plan immediately once geometry is ready, then clear the handoff.
  const [autoPlanPending, setAutoPlanPending] = useState(false);
  /* eslint-disable react-hooks/set-state-in-effect -- this IS the sanctioned
     external-system sync: the handoff is written into the planner store by a
     DIFFERENT screen ("Route here" on the stop sheet), and consuming it must
     also clear that store — neither can happen during render. Both effects are
     self-terminating one-shots (clearPrefill / autoPlanPending → false), so
     there is no render cascade, just two extra renders per handoff. */
  useEffect(() => {
    if (!prefill) return;
    setFrom(prefill.from);
    setTo(prefill.to);
    setAutoPlanPending(true);
    clearPrefill();
  }, [prefill, clearPrefill]);

  useEffect(() => {
    if (!autoPlanPending || loading) return;
    setAutoPlanPending(false);
    runPlan(from, to);
    // from/to were just set from the prefill; runPlan reads them explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlanPending, loading]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handlePick = useCallback(
    (it: PlannerItinerary) => {
      Keyboard.dismiss();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setItinerary(it);
      // Always land on the MAP so the drawn route + PlannerChip are visible.
      // router.back() would return to whatever sheet opened the planner (e.g.
      // the stop sheet in the "Route here" flow), hiding the route behind a
      // stale list. dismissAll pops every sheet back to the map.
      router.dismissAll();
    },
    [setItinerary],
  );

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    router.back();
  }, []);

  const handleClearItinerary = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setItinerary(null);
  }, [setItinerary]);

  // Start journey guidance: make the itinerary the active route, record the
  // access-walk time and hand over to the map (guidance banner + stepper).
  const handleStart = useCallback(
    (it: PlannerItinerary, walkS: number | null) => {
      Keyboard.dismiss();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      startGuidance(it, walkS ?? 0);
      // Land on the map (not a stale underlying sheet) so the guidance banner +
      // route take over — same rationale as handlePick.
      router.dismissAll();
    },
    [startGuidance],
  );

  const handleEndGuidance = useCallback(() => {
    stopGuidance();
  }, [stopGuidance]);

  /** Access-walk seconds for the ACTIVE itinerary (banner Start button). */
  const activeWalkS = useMemo(
    () => (itinerary && userCoords ? itineraryAccessWalkS(userCoords, itinerary) : null),
    [itinerary, userCoords],
  );

  // Live wall-clock timing per result, then sort by EARLIEST ARRIVAL (live
  // arrival first; schedule-only itineraries fall back to fewest transfers /
  // stops). Recomputed each 1 Hz tick so times + countdowns stay current.
  // With a known user location the timing also accounts for the WALK to the
  // boarding stop: trams leaving before the user can reach the stop are
  // skipped, and each result carries a leave-by wall time.
  const ranked = useMemo<RankedResult[]>(() => {
    if (!results) return [];
    const withTiming = results.map((it) => {
      const walkS = userCoords ? itineraryAccessWalkS(userCoords, it) : null;
      const timing = computeItineraryTiming(
        it.legs,
        states,
        geometries,
        nowMs,
        walkS != null ? { earliestDepartureMs: nowMs + walkS * 1_000 } : undefined,
      );
      const leaveByMs =
        walkS != null && timing.departureMs != null
          ? computeLeaveByMs(timing.departureMs, walkS)
          : null;
      return { itinerary: it, timing, walkS, leaveByMs };
    });
    withTiming.sort((a, b) => {
      const aa = a.timing.arrivalMs;
      const bb = b.timing.arrivalMs;
      if (aa != null && bb != null) return aa - bb;
      if (aa != null) return -1;
      if (bb != null) return 1;
      return (
        a.itinerary.transferCount - b.itinerary.transferCount ||
        a.itinerary.totalStops - b.itinerary.totalStops
      );
    });
    return withTiming;
  }, [results, states, geometries, nowMs, userCoords]);

  const activeTiming = useMemo(
    () =>
      itinerary ? computeItineraryTiming(itinerary.legs, states, geometries, nowMs) : null,
    [itinerary, states, geometries, nowMs],
  );

  const activeLegs = itinerary?.legs ?? [];
  const bannerLabel =
    activeLegs.length > 0
      ? `${activeLegs[0].fromStopName} → ${activeLegs[activeLegs.length - 1].toStopName}`
      : '';
  const bannerLive = activeTiming?.departureMs != null && activeTiming?.arrivalMs != null;
  const bannerTimes = bannerLive
    ? `${formatPragueClock(activeTiming!.departureMs!)} → ${formatPragueClock(
        activeTiming!.arrivalMs!,
      )} · ${formatCountdown(activeTiming!.departureMs! - nowMs)}`
    : null;

  const showRecents = !loading && error === null && results === null && recents.length > 0;

  return (
    <SheetSurface
      header={<SheetHeader title="Find your tram" onClose={handleClose} />}
      contentContainerStyle={styles.scrollContent}
      scrollProps={SCROLL_PROPS}
    >
          {itinerary && (
            <View style={[styles.activeCard, { backgroundColor: c.fillTertiary }]}>
              <View style={styles.activeHead}>
                <View style={[styles.activeIcon, { backgroundColor: c.blue }]}>
                  <SymbolView name="map.fill" size={17} weight="semibold" tintColor="#FFFFFF" />
                </View>
                <View style={styles.activeBody}>
                  <Text numberOfLines={1} style={[styles.activeLabel, { color: c.text }]}>
                    {bannerLabel}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[styles.activeTimes, { color: c.secondary }]}
                    maxFontSizeMultiplier={TextScale.content}
                  >
                    {bannerTimes ?? 'Awaiting a live tram for departure times'}
                  </Text>
                </View>
              </View>
              <RouteVehicleRoster itinerary={itinerary} timing={activeTiming} nowMs={nowMs} />
              <View style={styles.activeActions}>
                {!guidance && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Start journey guidance"
                    onPress={() => handleStart(itinerary, activeWalkS)}
                    style={({ pressed }) => [
                      styles.activeStart,
                      { backgroundColor: c.blue, opacity: pressed ? 0.8 : 1 },
                    ]}
                  >
                    <SymbolView name="location.north.line.fill" size={13} weight="semibold" tintColor="#FFFFFF" />
                    <Text style={styles.activeStartText}>Start</Text>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear route"
                  onPress={handleClearItinerary}
                  style={({ pressed }) => [
                    styles.activeClear,
                    { backgroundColor: c.fillSecondary, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Text style={[styles.activeClearText, { color: c.red }]}>Clear route</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Active guidance: the sheet becomes the full stepper; planning UI
              stays out of the way until guidance ends. */}
          {guidance && guidanceProgress ? (
            <GuidanceStepper
              session={guidance}
              progress={guidanceProgress}
              states={states}
              geometries={geometries}
              nowMs={nowMs}
              onEnd={handleEndGuidance}
            />
          ) : (
            <>
              <StopSearchCard
                from={from}
                to={to}
                onChangeFrom={handleChangeFrom}
                onChangeTo={handleChangeTo}
                onSwap={handleSwap}
                search={search}
                linesFor={linesFor}
                onSubmit={handlePlan}
                onLocate={() => void handleLocate()}
                locating={locating}
                autoFocusTo={autoFocusTo}
              />

              <Pressable
                onPress={handlePlan}
                disabled={!canPlan}
                accessibilityRole="button"
                accessibilityLabel="Match trams for this route"
                accessibilityState={{ disabled: !canPlan }}
                style={({ pressed }) => [
                  styles.planButton,
                  { backgroundColor: c.blue, opacity: !canPlan ? 0.4 : pressed ? 0.82 : 1 },
                ]}
              >
                <SymbolView name="tram.fill" size={17} weight="semibold" tintColor="#FFFFFF" />
                <Text style={styles.planButtonText}>
                  {results && results.length > 0 ? 'Rematch Trams' : 'Match Trams'}
                </Text>
              </Pressable>

              {showRecents && (
                <RecentRoutes recents={recents} onPick={handlePickRecent} onRemove={removeRecent} />
              )}

              {loading ? (
                <View style={styles.stateBlock}>
                  <ActivityIndicator />
                  <Text style={[styles.stateBody, { color: c.secondary }]}>
                    Loading tram network — more routes appear as trams report in
                  </Text>
                </View>
              ) : error ? (
                <View style={styles.stateBlock}>
                  <SymbolView name="exclamationmark.circle" size={30} tintColor={Tram.late} />
                  <Text style={[styles.stateTitle, { color: c.text }]}>
                    {error.type === 'same' ? 'Same stop twice' : 'Stop not found'}
                  </Text>
                  <Text style={[styles.stateBody, { color: c.secondary }]}>
                    {error.type === 'same'
                      ? 'The start and destination are the same stop — pick two different stops.'
                      : `Couldn't find “${error.name}” on the tram network. Pick a stop from the suggestions.`}
                  </Text>
                </View>
              ) : results === null ? (
                recents.length === 0 ? (
                  <Text style={[styles.hint, { color: c.secondary }]}>
                    Plan a journey across {network.stations.size} stops on{' '}
                    {network.sequencesByLine.size} tram lines
                  </Text>
                ) : null
              ) : results.length === 0 ? (
                <View style={styles.stateBlock}>
                  <SymbolView name="tram.fill" size={34} tintColor={c.secondary} />
                  <Text style={[styles.stateTitle, { color: c.text }]}>No route found</Text>
                  <Text style={[styles.stateBody, { color: c.secondary }]}>
                    No tram path connects these stops yet. More routes appear as trams report in —
                    try again shortly, or pick nearby stops.
                  </Text>
                </View>
              ) : (
                <View style={styles.results}>
                  <Text style={[styles.sectionLabel, { color: c.secondary }]}>
                    YOUR TRAMS · EARLIEST ARRIVAL FIRST
                  </Text>
                  {ranked.map(({ itinerary: it, timing, walkS, leaveByMs }, i) => (
                    <ItineraryCard
                      key={`${i}-${it.legs.map((l) => l.line).join('-')}-${it.legs[0]?.fromStopId}`}
                      itinerary={it}
                      timing={timing}
                      nowMs={nowMs}
                      walkS={walkS}
                      leaveByMs={leaveByMs}
                      onPress={() => handlePick(it)}
                      onStart={() => handleStart(it, walkS)}
                    />
                  ))}
                </View>
              )}
            </>
          )}
    </SheetSurface>
  );
}

/** The planner's inputs are text fields, so the keyboard should go away on a
 *  DRAG rather than track the finger interactively. */
const SCROLL_PROPS = {
  keyboardDismissMode: 'on-drag',
  showsVerticalScrollIndicator: false,
} as const;

const styles = StyleSheet.create({
  scrollContent: {
    gap: Spacing.three,
    paddingBottom: Spacing.six,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.one,
  },
  activeCard: {
    borderCurve: 'continuous',
    borderRadius: Radii.card,
    gap: Spacing.two + 2,
    padding: Spacing.three,
  },
  activeHead: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two + 2,
  },
  activeIcon: {
    alignItems: 'center',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  activeBody: {
    flex: 1,
    gap: 2,
  },
  activeLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  activeTimes: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  activeActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  activeStart: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: Radii.field,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: 9,
  },
  activeStartText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  activeClear: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: Radii.field,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: 9,
  },
  activeClearText: {
    fontSize: 15,
    fontWeight: '600',
  },
  planButton: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: Radii.field,
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'center',
    minHeight: 52,
  },
  planButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
  stateBlock: {
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
  },
  stateTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  stateBody: {
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  hint: {
    fontSize: 13,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    textAlign: 'center',
  },
  results: {
    gap: Spacing.three,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.4,
    marginLeft: Spacing.three,
  },
});
