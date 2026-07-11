// /planner — journey planner form sheet floating over the live map.
// Pick two stops (or a recent pair / your nearest stop), plan over the tram
// network graph built from loaded geometries, then hand the chosen itinerary to
// the map via usePlannerStore. Google-Maps-style: recent searches, nearest-stop
// fill, live departure/arrival wall times with a 1 Hz 'in N min' countdown.
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { ItineraryCard } from '@/components/planner/ItineraryCard';
import { RecentRoutes } from '@/components/planner/RecentRoutes';
import { StopSearchCard } from '@/components/planner/StopSearchCard';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import {
  computeItineraryTiming,
  formatCountdown,
  nearestStation,
  type ItineraryTiming,
} from '@/lib/arrivals';
import { formatPragueClock } from '@/lib/format/pragueTime';
import { buildNetwork, normalizeName } from '@/lib/planner/network';
import { planItineraries, searchStops } from '@/lib/planner/planner';
import type { PlannerItinerary } from '@/lib/types';
import { usePlannerStore } from '@/stores/planner';

type PlanError =
  | { type: 'same' }
  | { type: 'unknown'; field: 'from' | 'to'; name: string };

interface RankedResult {
  itinerary: PlannerItinerary;
  timing: ItineraryTiming;
}

export default function PlannerScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
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

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [results, setResults] = useState<PlannerItinerary[] | null>(null);
  const [error, setError] = useState<PlanError | null>(null);
  const [locating, setLocating] = useState(false);
  // Wall-clock second tick — refreshes the 'in N min' countdowns while the sheet
  // is open (independent of the ~1 Hz states cadence).
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loading = geometries.length === 0;

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Station index for suggestion badges + input validation. Rebuilt only when
  // the geometry set changes (~1 Hz re-render at most while shapes stream in).
  const network = useMemo(() => buildNetwork(geometries), [geometries]);

  const search = useCallback(
    (query: string) => searchStops(query, geometries, 8),
    [geometries],
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
          'Allow location access in Settings to fill the nearest stop automatically.',
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
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

  const handlePick = useCallback(
    (it: PlannerItinerary) => {
      Keyboard.dismiss();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setItinerary(it);
      router.back(); // map draws the route + fits bounds
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

  // Live wall-clock timing per result, then sort by EARLIEST ARRIVAL (live
  // arrival first; schedule-only itineraries fall back to fewest transfers /
  // stops). Recomputed each 1 Hz tick so times + countdowns stay current.
  const ranked = useMemo<RankedResult[]>(() => {
    if (!results) return [];
    const withTiming = results.map((it) => ({
      itinerary: it,
      timing: computeItineraryTiming(it.legs, states, geometries, nowMs),
    }));
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
  }, [results, states, geometries, nowMs]);

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
    <GlassPanel style={styles.root}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.scrollBottom}
      >
        <SheetContent style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: palette.text }]}>Journey Planner</Text>
          <Pressable
            onPress={handleClose}
            hitSlop={8}
            accessibilityLabel="Close"
            style={({ pressed }) => [
              styles.closeButton,
              { backgroundColor: palette.backgroundElement, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <SymbolView name="xmark" size={13} weight="semibold" tintColor={palette.textSecondary} />
          </Pressable>
        </View>

        {itinerary && (
          <View
            style={[
              styles.banner,
              { backgroundColor: scheme === 'dark' ? 'rgba(224,165,38,0.18)' : 'rgba(224,165,38,0.20)' },
            ]}
          >
            <SymbolView name="map.fill" size={17} tintColor={Tram.gold} />
            <View style={styles.bannerBody}>
              <Text numberOfLines={1} style={[styles.bannerText, { color: palette.text }]}>
                {bannerLabel}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.bannerTimes, { color: palette.textSecondary }]}
                allowFontScaling={false}
              >
                {bannerTimes ?? 'Awaiting a live tram for departure times'}
              </Text>
            </View>
            <Pressable
              onPress={handleClearItinerary}
              style={({ pressed }) => [styles.bannerClear, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.bannerClearText}>Clear route</Text>
            </Pressable>
          </View>
        )}

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
        />

        <Pressable
          onPress={handlePlan}
          disabled={!canPlan}
          accessibilityRole="button"
          accessibilityLabel="Plan route"
          style={({ pressed }) => [
            styles.planButton,
            { opacity: !canPlan ? 0.4 : pressed ? 0.75 : 1 },
          ]}
        >
          <SymbolView
            name="arrow.triangle.turn.up.right.diamond.fill"
            size={17}
            tintColor={Tram.cream}
          />
          <Text style={styles.planButtonText}>
            {results && results.length > 0 ? 'Update route' : 'Plan'}
          </Text>
        </Pressable>

        {showRecents && (
          <RecentRoutes
            recents={recents}
            onPick={handlePickRecent}
            onRemove={removeRecent}
          />
        )}

        {loading ? (
          <View style={styles.stateBlock}>
            <ActivityIndicator />
            <Text style={[styles.stateBody, { color: palette.textSecondary }]}>
              Loading tram network — more routes appear as trams report in
            </Text>
          </View>
        ) : error ? (
          <View style={styles.stateBlock}>
            <SymbolView name="exclamationmark.circle" size={30} tintColor={Tram.late} />
            <Text style={[styles.stateTitle, { color: palette.text }]}>
              {error.type === 'same' ? 'Same stop twice' : 'Stop not found'}
            </Text>
            <Text style={[styles.stateBody, { color: palette.textSecondary }]}>
              {error.type === 'same'
                ? 'The start and destination are the same stop — pick two different stops.'
                : `Couldn't find “${error.name}” on the tram network. Pick a stop from the suggestions.`}
            </Text>
          </View>
        ) : results === null ? (
          recents.length === 0 ? (
            <Text style={[styles.hint, { color: palette.textSecondary }]}>
              Plan a journey across {network.stations.size} stops on{' '}
              {network.sequencesByLine.size} tram lines
            </Text>
          ) : null
        ) : results.length === 0 ? (
          <View style={styles.stateBlock}>
            <SymbolView name="tram.fill" size={34} tintColor={palette.textSecondary} />
            <Text style={[styles.stateTitle, { color: palette.text }]}>No route found</Text>
            <Text style={[styles.stateBody, { color: palette.textSecondary }]}>
              No tram path connects these stops yet. More routes appear as trams report in —
              try again shortly, or pick nearby stops.
            </Text>
          </View>
        ) : (
          <View style={styles.results}>
            <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
              Routes · earliest arrival first
            </Text>
            {ranked.map(({ itinerary: it, timing }, i) => (
              <ItineraryCard
                key={`${i}-${it.legs.map((l) => l.line).join('-')}-${it.legs[0]?.fromStopId}`}
                itinerary={it}
                timing={timing}
                nowMs={nowMs}
                onPress={() => handlePick(it)}
              />
            ))}
          </View>
        )}
        </SheetContent>
      </ScrollView>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  root: {
    borderRadius: 24,
    flex: 1,
  },
  scrollBottom: {
    paddingBottom: Spacing.five,
  },
  content: {
    gap: Spacing.three,
    padding: Spacing.three,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingTop: Spacing.one,
  },
  title: {
    flex: 1,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  closeButton: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  banner: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 14,
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  bannerBody: {
    flex: 1,
    gap: 1,
  },
  bannerText: {
    fontSize: 14,
    fontWeight: '600',
  },
  bannerTimes: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  bannerClear: {
    backgroundColor: Tram.pidRed,
    borderCurve: 'continuous',
    borderRadius: 12,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 5,
  },
  bannerClearText: {
    color: Tram.cream,
    fontSize: 13,
    fontWeight: '600',
  },
  planButton: {
    alignItems: 'center',
    backgroundColor: Tram.pidRed,
    borderCurve: 'continuous',
    borderRadius: 14,
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'center',
    minHeight: 50,
  },
  planButtonText: {
    color: Tram.cream,
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
    fontSize: 14,
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
    gap: Spacing.two + 2,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginLeft: Spacing.one,
    textTransform: 'uppercase',
  },
});
