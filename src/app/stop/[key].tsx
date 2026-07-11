// Stop sheet — /stop/[key], where key = normalized station key
// (normalizeName of the stop name, same grouping as the planner network).
// Live arrivals board over the runtime states + loaded geometries, refreshed
// ~1 Hz by the tramData hooks; tap an arrival → that tram's sheet.
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { AcSnowflake } from '@/components/tram/TramModelImage';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Fonts, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { computeArrivals, formatEtaMinutes, stationStops, type StopArrival } from '@/lib/arrivals';
import { useSelectionStore } from '@/stores/selection';

/** 'Tatra T3R.P' → 'T3R.P', 'Škoda 15T ForCity Alfa' → '15T ForCity Alfa'. */
function shortModelName(name: string): string {
  return name.replace(/^(Tatra|Škoda|ČKD)\s+/u, '');
}

export default function StopSheet() {
  const params = useLocalSearchParams<{ key?: string }>();
  const stationKey = typeof params.key === 'string' ? params.key : '';
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];

  const states = useAllTramStates();
  const geometries = useLoadedGeometries();
  const requestFlyTo = useSelectionStore((s) => s.requestFlyTo);

  const station = useMemo(
    () => stationStops(stationKey, geometries),
    [stationKey, geometries],
  );
  // Recomputed on every ~1 Hz runtime tick (states identity changes), so the
  // ETAs count down without a dedicated timer.
  const arrivals = useMemo(
    () => computeArrivals(stationKey, states, geometries, Date.now()),
    [stationKey, states, geometries],
  );

  const loading = geometries.length === 0;

  const onShowOnMap = (): void => {
    if (!station) return;
    void Haptics.selectionAsync();
    requestFlyTo({ coordinates: station.coordinates, zoom: 16.5 });
    router.back();
  };

  const onOpenTram = (arrival: StopArrival): void => {
    void Haptics.selectionAsync();
    router.push(('/tram/' + encodeURIComponent(arrival.tramKey)) as Href);
  };

  return (
    <GlassPanel style={styles.root}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <SheetContent style={styles.content}>
          {/* Header */}
          <View style={styles.headerRow}>
            <View style={styles.stopIcon}>
              <SymbolView name="tram.fill" size={17} tintColor={Tram.cream} />
            </View>
            <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
              {station?.name ?? 'Stop'}
            </Text>
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              accessibilityLabel="Close"
              style={({ pressed }) => pressed && styles.pressed}
            >
              <SymbolView
                name="xmark.circle.fill"
                size={28}
                type="hierarchical"
                tintColor={c.textSecondary}
              />
            </Pressable>
          </View>

          {station && station.lines.length > 0 && (
            <View style={styles.linesRow}>
              {station.lines.map((line) => (
                <Pressable
                  key={line}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push(('/line/' + line) as Href);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Line ${line}`}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <LineBadge line={line} size="sm" />
                </Pressable>
              ))}
              <Pressable
                onPress={onShowOnMap}
                accessibilityRole="button"
                accessibilityLabel="Show stop on map"
                style={({ pressed }) => [
                  styles.mapButton,
                  { backgroundColor: c.backgroundElement },
                  pressed && styles.pressed,
                ]}
              >
                <SymbolView name="map.fill" size={12} tintColor={Tram.pidRed} />
                <Text style={[styles.mapButtonText, { color: c.text }]} allowFontScaling={false}>
                  Show on map
                </Text>
              </Pressable>
            </View>
          )}

          {/* Arrivals */}
          {loading ? (
            <View style={styles.stateBlock}>
              <ActivityIndicator color={Tram.pidRed} />
              <Text style={[styles.stateBody, { color: c.textSecondary }]}>
                Loading the tram network — arrivals appear as routes stream in.
              </Text>
            </View>
          ) : !station ? (
            <View style={styles.stateBlock}>
              <SymbolView name="mappin.slash" size={32} tintColor={c.textSecondary} />
              <Text style={[styles.stateTitle, { color: c.text }]}>Stop not found</Text>
              <Text style={[styles.stateBody, { color: c.textSecondary }]}>
                No loaded route serves this stop yet. It appears as soon as a tram
                on a serving line reports in.
              </Text>
            </View>
          ) : arrivals.length === 0 ? (
            <View style={styles.stateBlock}>
              <SymbolView name="moon.zzz.fill" size={32} tintColor={c.textSecondary} />
              <Text style={[styles.stateTitle, { color: c.text }]}>No trams approaching</Text>
              <Text style={[styles.stateBody, { color: c.textSecondary }]}>
                No live tram is currently heading for this stop. Check back in a
                moment.
              </Text>
            </View>
          ) : (
            <View style={styles.board}>
              <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>
                UPCOMING ARRIVALS
              </Text>
              {arrivals.map((a) => (
                <ArrivalRow key={a.tramKey} arrival={a} scheme={scheme} onPress={() => onOpenTram(a)} />
              ))}
            </View>
          )}
        </SheetContent>
      </ScrollView>
    </GlassPanel>
  );
}

function ArrivalRow({
  arrival,
  scheme,
  onPress,
}: {
  arrival: StopArrival;
  scheme: 'light' | 'dark';
  onPress: () => void;
}) {
  const c = Colors[scheme];
  const etaLabel = formatEtaMinutes(arrival.etaS);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Line ${arrival.line} to ${arrival.headsign}, ${
        etaLabel === 'now' ? 'arriving now' : `in ${etaLabel}`
      }`}
      style={({ pressed }) => [
        styles.arrivalRow,
        pressed && {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
        },
      ]}
    >
      <LineBadge line={arrival.line} size="md" />
      <View style={styles.arrivalBody}>
        <Text numberOfLines={1} style={[styles.headsign, { color: c.text }]}>
          {arrival.headsign}
        </Text>
        <View style={styles.modelRow}>
          <Text numberOfLines={1} style={[styles.modelName, { color: c.textSecondary }]}>
            {shortModelName(arrival.model.name)}
            {arrival.regNumber != null && ` · #${arrival.regNumber}`}
          </Text>
          <AcSnowflake airConditioned={arrival.airConditioned} />
        </View>
      </View>
      <Text
        style={[
          styles.eta,
          { color: scheme === 'dark' ? Tram.liveryRed : Tram.pidRed },
          etaLabel === 'now' && styles.etaNow,
        ]}
        allowFontScaling={false}
      >
        {etaLabel}
      </Text>
      <SymbolView name="chevron.right" size={11} tintColor={c.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: {
    paddingBottom: Spacing.six,
  },
  content: {
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.four,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two + 4,
  },
  stopIcon: {
    alignItems: 'center',
    backgroundColor: Tram.pidRed,
    borderCurve: 'continuous',
    borderRadius: 10,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  title: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  linesRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  mapButton: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 5,
    marginLeft: 'auto',
    paddingHorizontal: Spacing.two + 4,
    paddingVertical: 6,
  },
  mapButtonText: { fontSize: 12, fontWeight: '600' },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.7,
    marginBottom: Spacing.one,
  },
  board: { gap: 2 },
  arrivalRow: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 12,
    flexDirection: 'row',
    gap: Spacing.two + 4,
    minHeight: 56,
    paddingHorizontal: Spacing.two,
    paddingVertical: 6,
  },
  arrivalBody: { flex: 1, gap: 2 },
  headsign: { fontSize: 16, fontWeight: '600' },
  modelRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  modelName: { flexShrink: 1, fontSize: 13 },
  eta: {
    fontFamily: Fonts?.rounded,
    fontSize: 20,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  etaNow: { fontSize: 17 },
  stateBlock: {
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
  },
  stateTitle: { fontSize: 17, fontWeight: '600' },
  stateBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  pressed: { opacity: 0.55 },
});
