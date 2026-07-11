// /planner — journey planner form sheet floating over the live map.
// Pick two stops, plan over the tram network graph built from loaded
// geometries, then hand the chosen itinerary to the map via usePlannerStore.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { ItineraryCard } from '@/components/planner/ItineraryCard';
import { StopSearchCard } from '@/components/planner/StopSearchCard';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { computeItineraryTiming } from '@/lib/arrivals';
import { formatPragueClock } from '@/lib/format/pragueTime';
import { buildNetwork, normalizeName } from '@/lib/planner/network';
import { planItineraries, searchStops } from '@/lib/planner/planner';
import type { PlannerItinerary } from '@/lib/types';
import { usePlannerStore } from '@/stores/planner';

type PlanError =
  | { type: 'same' }
  | { type: 'unknown'; field: 'from' | 'to'; name: string };

export default function PlannerScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const geometries = useLoadedGeometries();
  // Live tram states (~1 Hz) drive the wall-clock departure/arrival times on
  // the itinerary cards + active banner.
  const states = useAllTramStates();
  const itinerary = usePlannerStore((s) => s.itinerary);
  const setItinerary = usePlannerStore((s) => s.setItinerary);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [results, setResults] = useState<PlannerItinerary[] | null>(null);
  const [error, setError] = useState<PlanError | null>(null);

  const loading = geometries.length === 0;

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

  const canPlan = !loading && from.trim().length > 0 && to.trim().length > 0;

  // BFS runs ONLY here (button press / keyboard submit), never during render.
  const handlePlan = useCallback(() => {
    if (!canPlan) return;
    Keyboard.dismiss();

    const fromKey = normalizeName(from);
    const toKey = normalizeName(to);
    if (!network.stations.has(fromKey)) {
      setResults(null);
      setError({ type: 'unknown', field: 'from', name: from.trim() });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    if (!network.stations.has(toKey)) {
      setResults(null);
      setError({ type: 'unknown', field: 'to', name: to.trim() });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    if (fromKey === toKey) {
      setResults(null);
      setError({ type: 'same' });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    const found = planItineraries(from, to, geometries);
    setError(null);
    setResults(found);
    Haptics.notificationAsync(
      found.length > 0
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning,
    );
  }, [canPlan, from, to, network, geometries]);

  const handlePick = useCallback(
    (it: PlannerItinerary) => {
      Keyboard.dismiss();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setItinerary(null);
  }, [setItinerary]);

  // Live wall-clock timing per result card + for the active-route banner.
  // Recomputed each ~1 Hz states tick so the times stay current.
  const resultTimings = useMemo(
    () =>
      results?.map((it) => computeItineraryTiming(it.legs, states, geometries, Date.now())) ??
      [],
    [results, states, geometries],
  );
  const activeTiming = useMemo(
    () =>
      itinerary ? computeItineraryTiming(itinerary.legs, states, geometries, Date.now()) : null,
    [itinerary, states, geometries],
  );

  const activeLegs = itinerary?.legs ?? [];
  const bannerLabel =
    activeLegs.length > 0
      ? `${activeLegs[0].fromStopName} → ${activeLegs[activeLegs.length - 1].toStopName}`
      : '';
  const bannerTimes =
    activeTiming?.departureMs != null && activeTiming?.arrivalMs != null
      ? `${formatPragueClock(activeTiming.departureMs)} → ${formatPragueClock(activeTiming.arrivalMs)}`
      : null;

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
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            Plan a journey across {network.stations.size} stops on{' '}
            {network.sequencesByLine.size} tram lines
          </Text>
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
            <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>Routes</Text>
            {results.map((it, i) => (
              <ItineraryCard
                key={`${i}-${it.legs.map((l) => l.line).join('-')}`}
                itinerary={it}
                timing={resultTimings[i]}
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
