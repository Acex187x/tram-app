// Line sheet — /line/[id]. Floats over the live map as a formSheet.
// Shows the line header (badge, live tram count), a direction picker built
// from the two most common trip headsigns, and a stop timeline with live tram
// positions inserted between the stops each tram is currently between.
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { DelayPill } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { isNightLine, LineBadge } from '@/components/ui/LineBadge';
import { Colors, Fonts, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { useSelectionStore } from '@/stores/selection';
import type { RouteGeometry, RouteStop, TramPublicState } from '@/lib/types';

const RAIL_W = 40;

type LineRow =
  | { kind: 'stop'; stop: RouteStop }
  | { kind: 'tram'; state: TramPublicState };

/** 'Tatra T3R.P' → 'T3R.P', 'Škoda 15T ForCity Alfa' → '15T ForCity Alfa'. */
function shortModelName(name: string): string {
  return name.replace(/^(Tatra|Škoda|ČKD)\s+/u, '');
}

export default function LineSheet() {
  const params = useLocalSearchParams<{ id?: string }>();
  const lineId = typeof params.id === 'string' ? params.id : '';
  const router = useRouter();
  const scheme = useColorScheme();
  const c = Colors[scheme === 'dark' ? 'dark' : 'light'];

  const setSelectedLineId = useSelectionStore((s) => s.setSelectedLineId);
  const requestFlyTo = useSelectionStore((s) => s.requestFlyTo);

  // Highlight this line on the map while the sheet is open.
  useEffect(() => {
    setSelectedLineId(lineId);
    return () => setSelectedLineId(null);
  }, [lineId, setSelectedLineId]);

  const allStates = useAllTramStates();
  const geometries = useLoadedGeometries();

  const lineStates = useMemo(
    () => allStates.filter((s) => s.snapshot.line === lineId && !s.snapshot.isCanceled),
    [allStates, lineId],
  );
  const lineGeometries = useMemo(
    () => geometries.filter((g) => g.line === lineId),
    [geometries, lineId],
  );

  // The two most common trip headsigns act as the line's directions.
  const headsigns = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of lineGeometries) {
      if (!g.headsign) continue;
      counts.set(g.headsign, (counts.get(g.headsign) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([h]) => h);
  }, [lineGeometries]);

  // Track the chosen direction by its headsign STRING, not by index: when new
  // geometry streams in the headsign ordering (by frequency) can shift, and an
  // index would silently flip the user's choice. Fall back to the top headsign
  // when the selected one is no longer present.
  const [selectedHeadsign, setSelectedHeadsign] = useState<string | null>(null);
  const headsign =
    selectedHeadsign && headsigns.includes(selectedHeadsign)
      ? selectedHeadsign
      : headsigns[0];

  // Longest geometry for the chosen headsign = the fullest stop list.
  const geometry = useMemo<RouteGeometry | null>(() => {
    let best: RouteGeometry | null = null;
    for (const g of lineGeometries) {
      if (g.headsign !== headsign) continue;
      if (!best || g.totalM > best.totalM) best = g;
    }
    return best;
  }, [lineGeometries, headsign]);

  // tripId → shapeId for every loaded geometry, so we can tell whether a tram's
  // simDistM is measured against the SAME shape we're displaying.
  const tripShapeId = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of geometries) m.set(g.tripId, g.shapeId);
    return m;
  }, [geometries]);

  // Interleave stops and the live trams heading this direction, ordered by
  // distance along the shape (state.simDistM vs each stop's distM). Only trams
  // driven by the SAME shape can be placed — distance-along-shape is meaningless
  // across shape variants/diversions. Same-direction trams on other shapes are
  // reported as a footer count instead of being mis-placed.
  const { rows, offShapeCount } = useMemo<{ rows: LineRow[]; offShapeCount: number }>(() => {
    if (!geometry || geometry.stops.length === 0) return { rows: [], offShapeCount: 0 };
    const directionStates = lineStates.filter((s) => s.snapshot.headsign === headsign);
    const trams = directionStates
      .filter((s) => s.hasGeometry && tripShapeId.get(s.snapshot.tripId) === geometry.shapeId)
      .sort((a, b) => a.simDistM - b.simDistM);
    const stops = geometry.stops;
    const out: LineRow[] = [];
    let t = 0;
    for (const stop of stops) {
      while (t < trams.length && trams[t].simDistM < stop.distM) {
        out.push({ kind: 'tram', state: trams[t] });
        t += 1;
      }
      out.push({ kind: 'stop', stop });
    }
    while (t < trams.length) {
      out.push({ kind: 'tram', state: trams[t] });
      t += 1;
    }
    return { rows: out, offShapeCount: directionStates.length - trams.length };
  }, [geometry, lineStates, headsign, tripShapeId]);

  const onStopPress = (stop: RouteStop): void => {
    void Haptics.selectionAsync();
    requestFlyTo({ coordinates: stop.coordinates, zoom: 16 });
    router.back();
  };

  const onTramPress = (state: TramPublicState): void => {
    void Haptics.selectionAsync();
    // Encode: keys can fall back to trip ids with URL-hostile characters.
    router.push(`/tram/${encodeURIComponent(state.key)}` as Href);
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <LineBadge line={lineId} size="lg" />
        <View style={styles.titleText}>
          <Text style={[styles.title, { color: c.text }]} allowFontScaling={false}>
            Line {lineId}
          </Text>
          <View style={styles.subtitleRow}>
            <View style={styles.liveDot} />
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {lineStates.length === 1 ? '1 tram active' : `${lineStates.length} trams active`}
            </Text>
            {isNightLine(lineId) && (
              <View style={styles.nightPill}>
                <SymbolView name="moon.fill" size={9} tintColor="#FFFFFF" />
                <Text style={styles.nightPillText} allowFontScaling={false}>
                  NIGHT
                </Text>
              </View>
            )}
          </View>
        </View>
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

      {headsigns.length > 1 && (
        <View style={[styles.segmented, { backgroundColor: c.backgroundElement }]}>
          {headsigns.map((h) => {
            const selected = h === headsign;
            return (
              <Pressable
                key={h}
                onPress={() => {
                  if (h !== headsign) {
                    void Haptics.selectionAsync();
                    setSelectedHeadsign(h);
                  }
                }}
                style={[
                  styles.segment,
                  selected && {
                    backgroundColor: scheme === 'dark' ? '#48484A' : '#FFFFFF',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
                  },
                ]}
              >
                <SymbolView
                  name="arrow.right"
                  size={11}
                  tintColor={selected ? Tram.pidRed : (c.textSecondary as string)}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.segmentText,
                    { color: selected ? c.text : c.textSecondary },
                    selected && styles.segmentTextSelected,
                  ]}
                >
                  {h}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );

  const footer =
    offShapeCount > 0 ? (
      <View style={styles.footerNote}>
        <SymbolView name="arrow.triangle.branch" size={12} tintColor={c.textSecondary} />
        <Text style={[styles.footerNoteText, { color: c.textSecondary }]}>
          {offShapeCount === 1
            ? '1 more tram this direction on a different route variant'
            : `${offShapeCount} more trams this direction on different route variants`}
        </Text>
      </View>
    ) : null;

  const empty = (
    <View style={styles.empty}>
      <ActivityIndicator color={Tram.pidRed} />
      <Text style={[styles.emptyTitle, { color: c.text }]}>Loading route…</Text>
      <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
        Stops appear as soon as this line&apos;s geometry streams in.
      </Text>
    </View>
  );

  return (
    <GlassPanel style={styles.root}>
      <FlatList
        data={rows}
        keyExtractor={(row) =>
          row.kind === 'stop'
            ? `stop-${row.stop.stopId}-${row.stop.sequence}`
            : `tram-${row.state.key}`
        }
        renderItem={({ item, index }) =>
          item.kind === 'stop' ? (
            <StopRow
              stop={item.stop}
              isFirst={index === 0}
              isLast={index === rows.length - 1}
              textColor={c.text as string}
              secondaryColor={c.textSecondary as string}
              onPress={() => onStopPress(item.stop)}
            />
          ) : (
            <TramRow
              state={item.state}
              isFirst={index === 0}
              isLast={index === rows.length - 1}
              scheme={scheme === 'dark' ? 'dark' : 'light'}
              onPress={() => onTramPress(item.state)}
            />
          )
        }
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={rows.length > 0 ? footer : null}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </GlassPanel>
  );
}

// ── Timeline rows ─────────────────────────────────────────────────────────────

interface RailProps {
  isFirst: boolean;
  isLast: boolean;
}

/** The continuous PID-red line down the left edge, with an optional gap-free marker slot. */
function Rail({ isFirst, isLast, children }: RailProps & { children?: React.ReactNode }) {
  return (
    <View style={styles.rail}>
      <View
        style={[
          styles.railLine,
          isFirst && styles.railLineFirst,
          isLast && styles.railLineLast,
        ]}
      />
      {children}
    </View>
  );
}

function StopRow({
  stop,
  isFirst,
  isLast,
  textColor,
  secondaryColor,
  onPress,
}: RailProps & {
  stop: RouteStop;
  textColor: string;
  secondaryColor: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Fly to ${stop.name}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Rail isFirst={isFirst} isLast={isLast}>
        <View style={[styles.stopDot, stop.isTerminal && styles.terminalDot]} />
      </Rail>
      <View style={styles.stopBody}>
        <Text
          numberOfLines={1}
          style={[
            styles.stopName,
            { color: textColor },
            stop.isTerminal && styles.terminalName,
          ]}
        >
          {stop.name}
        </Text>
        {stop.isTerminal && (
          <Text style={[styles.terminusLabel, { color: secondaryColor }]}>Terminus</Text>
        )}
      </View>
      <SymbolView name="location" size={14} tintColor={secondaryColor} style={styles.stopGo} />
    </Pressable>
  );
}

function TramRow({
  state,
  isFirst,
  isLast,
  scheme,
  onPress,
}: RailProps & {
  state: TramPublicState;
  scheme: 'light' | 'dark';
  onPress: () => void;
}) {
  const c = Colors[scheme];
  return (
    <View style={styles.row}>
      <Rail isFirst={isFirst} isLast={isLast}>
        <View style={styles.tramMarker}>
          <SymbolView name="tram.fill" size={11} tintColor={Tram.cream} />
        </View>
      </Rail>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Tram ${state.key}, ${shortModelName(state.model.name)}`}
        style={({ pressed }) => [
          styles.tramChip,
          { backgroundColor: scheme === 'dark' ? 'rgba(122,6,3,0.32)' : 'rgba(122,6,3,0.08)' },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.tramReg, { color: c.text }]} allowFontScaling={false}>
          {state.key}
        </Text>
        <Text numberOfLines={1} style={[styles.tramModel, { color: c.textSecondary }]}>
          {shortModelName(state.model.name)}
        </Text>
        <DelayPill delaySeconds={state.snapshot.delaySeconds} />
        <SymbolView name="chevron.right" size={11} tintColor={c.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  listContent: {
    paddingBottom: Spacing.six,
  },
  header: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.two,
    gap: Spacing.three,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  titleText: { flex: 1, gap: Spacing.half },
  title: {
    fontSize: 26,
    fontWeight: '700',
    fontFamily: Fonts?.rounded,
    letterSpacing: -0.4,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: Tram.onTime,
  },
  subtitle: { fontSize: 14, fontWeight: '500' },
  nightPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: Tram.night,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  nightPillText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 12,
    borderCurve: 'continuous',
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 9,
    borderCurve: 'continuous',
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  segmentText: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
  segmentTextSelected: { fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingRight: Spacing.three,
  },
  rail: {
    width: RAIL_W,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  railLine: {
    position: 'absolute',
    left: (RAIL_W - 3) / 2,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: Tram.pidRed,
  },
  railLineFirst: { top: '50%' },
  railLineLast: { bottom: '50%' },
  stopDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: Tram.cream,
    borderWidth: 2.5,
    borderColor: Tram.pidRed,
  },
  terminalDot: {
    width: 15,
    height: 15,
    borderRadius: 8,
    borderWidth: 4,
  },
  stopBody: { flex: 1, paddingVertical: 10, gap: 1 },
  stopName: { fontSize: 15, fontWeight: '500' },
  terminalName: { fontSize: 16, fontWeight: '700' },
  terminusLabel: { fontSize: 12 },
  stopGo: { opacity: 0.55 },
  tramMarker: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderCurve: 'continuous',
    backgroundColor: Tram.pidRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tramChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 7,
    marginVertical: 4,
  },
  tramReg: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: Fonts?.rounded,
    fontVariant: ['tabular-nums'],
  },
  tramModel: { fontSize: 13, flex: 1 },
  pressed: { opacity: 0.55 },
  empty: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.six,
    paddingHorizontal: Spacing.four,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptyBody: { fontSize: 13, textAlign: 'center' },
  footerNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
  footerNoteText: { fontSize: 12, flexShrink: 1, textAlign: 'center' },
});
