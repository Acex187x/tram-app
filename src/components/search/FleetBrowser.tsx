// Fleet browser — the search sheet's idle (empty-query) state: every live
// tram, filterable by model and by line, client-side paginated.
//
// Perf contract: the parent re-renders at the 1 Hz useAllTramStates cadence.
// Rows are memoized FleetRow components fed primitive FleetRowData, the press
// callback is ref-stable, and only PAGE_SIZE-stepped slices are handed to the
// FlatList (windowSize kept small) so a full-fleet list never renders 400 rows.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { SymbolView } from 'expo-symbols';

import { LineBadge } from '@/components/ui/LineBadge';
import { SHEET_CONTENT_MAX_WIDTH } from '@/components/ui/SheetContent';
import { Colors, Spacing, Tram } from '@/constants/theme';
import type { RouteGeometry, TramModelId, TramPublicState } from '@/lib/types';

import { FleetRow } from './FleetRow';
import {
  filterFleet,
  fleetRowData,
  hasActiveFilters,
  lineFacets,
  liveFleet,
  modelFacets,
  MODEL_SHORT_NAMES,
  toggleFilterValue,
  type FleetFilters,
} from './fleetFilter';

const PAGE_SIZE = 30;

/** Now-ms ticking every second — drives the rows' updated-age labels (same
 * pattern as the tram sheet's useNowTick). */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export interface FleetBrowserProps {
  states: TramPublicState[];
  geometries: RouteGeometry[];
  /** Owned by the search sheet so filters survive typing + clearing the query. */
  filters: FleetFilters;
  onChangeFilters: (filters: FleetFilters) => void;
  onOpenTram: (state: TramPublicState) => void;
}

export function FleetBrowser({
  states,
  geometries,
  filters,
  onChangeFilters,
  onOpenTram,
}: FleetBrowserProps) {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const c = Colors[dark ? 'dark' : 'light'];
  // iPad: the sheet's glass is full-width; cap + center the list content
  // (same pattern as the line sheet's FlatList).
  const { width } = useWindowDimensions();
  const wide = width > SHEET_CONTENT_MAX_WIDTH;

  const live = useMemo(() => liveFleet(states), [states]);
  const models = useMemo(() => modelFacets(live), [live]);
  const lines = useMemo(() => lineFacets(live), [live]);
  const filtered = useMemo(() => filterFleet(states, filters), [states, filters]);

  // tripId → ordered stops, for naming the stop a dwelling tram stands at.
  const stopsByTrip = useMemo(() => {
    const m = new Map<string, RouteGeometry['stops']>();
    for (const g of geometries) if (!m.has(g.tripId)) m.set(g.tripId, g.stops);
    return m;
  }, [geometries]);

  // ── Client-side pagination: render 30, +30 per onEndReached ──
  // The page count is KEYED by the active filter combination — changing
  // filters implicitly resets to the first page (no effect, no extra render).
  const filterKey = `${filters.models.join(',')}|${filters.lines.join(',')}`;
  const [page, setPage] = useState({ key: filterKey, count: PAGE_SIZE });
  const visibleCount = page.key === filterKey ? page.count : PAGE_SIZE;

  const data = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const loadMore = (): void => {
    if (visibleCount >= filtered.length) return;
    setPage({ key: filterKey, count: Math.min(visibleCount + PAGE_SIZE, filtered.length) });
  };

  // Ref-stable press path so FleetRow's memo props never churn on parent
  // renders. Refs are written post-render (effect), read only in the handler.
  const filteredRef = useRef(filtered);
  const onOpenTramRef = useRef(onOpenTram);
  useEffect(() => {
    filteredRef.current = filtered;
    onOpenTramRef.current = onOpenTram;
  });
  const onPressRow = useCallback((tramKey: string) => {
    const state = filteredRef.current.find((s) => s.key === tramKey);
    if (state) onOpenTramRef.current(state);
  }, []);

  const nowMs = useNowTick();
  const renderItem = useCallback(
    ({ item }: { item: TramPublicState }) => (
      <FleetRow
        {...fleetRowData(item, stopsByTrip.get(item.snapshot.tripId), nowMs)}
        dark={dark}
        onPress={onPressRow}
      />
    ),
    [stopsByTrip, nowMs, dark, onPressRow],
  );

  const filtersActive = hasActiveFilters(filters);
  const headerText = filtersActive
    ? `${filtered.length} of ${live.length} trams live`
    : `${live.length} trams live`;

  const toggleModel = (id: TramModelId): void =>
    onChangeFilters({ ...filters, models: toggleFilterValue(filters.models, id) });
  const toggleLine = (line: string): void =>
    onChangeFilters({ ...filters, lines: toggleFilterValue(filters.lines, line) });

  const header = (
    <View style={styles.header}>
      <Text style={[styles.headerTitle, { color: c.text }]} accessibilityRole="header">
        {headerText}
      </Text>

      {/* Model chips: All + one per model in live data. Wraps gracefully. */}
      <View style={styles.modelChips}>
        <FilterChip
          label="All"
          selected={filters.models.length === 0}
          dark={dark}
          onPress={() => onChangeFilters({ ...filters, models: [] })}
        />
        {models.map((m) => (
          <FilterChip
            key={m.id}
            label={MODEL_SHORT_NAMES[m.id]}
            count={m.count}
            selected={filters.models.includes(m.id)}
            dark={dark}
            onPress={() => toggleModel(m.id)}
          />
        ))}
      </View>

      {/* Line chips: horizontal LineBadge row, numerically sorted. */}
      {lines.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.lineChips}
        >
          <FilterChip
            label="All"
            selected={filters.lines.length === 0}
            dark={dark}
            onPress={() => onChangeFilters({ ...filters, lines: [] })}
          />
          {lines.map((line) => {
            const selected = filters.lines.includes(line);
            const anySelected = filters.lines.length > 0;
            return (
              <Pressable
                key={line}
                onPress={() => toggleLine(line)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Filter line ${line}`}
                style={({ pressed }) => [
                  styles.lineChip,
                  selected && styles.lineChipSelected,
                  pressed && styles.pressed,
                ]}
              >
                <LineBadge
                  line={line}
                  size="md"
                  style={anySelected && !selected ? styles.lineDimmed : undefined}
                />
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );

  const empty = (
    <View style={styles.empty}>
      <SymbolView
        name="line.3.horizontal.decrease.circle"
        size={30}
        tintColor={c.textSecondary}
        style={styles.emptyIcon}
      />
      <Text style={[styles.emptyTitle, { color: c.text }]}>
        {live.length === 0 ? 'No trams reporting yet' : 'No trams match these filters'}
      </Text>
      <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
        {live.length === 0
          ? 'Live positions appear a few seconds after the first poll.'
          : 'Loosen the model or line filters to see more of the fleet.'}
      </Text>
    </View>
  );

  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      onEndReached={loadMore}
      onEndReachedThreshold={0.6}
      initialNumToRender={12}
      maxToRenderPerBatch={PAGE_SIZE}
      windowSize={7}
      removeClippedSubviews
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      style={styles.list}
      contentContainerStyle={[
        styles.listContent,
        wide && { alignSelf: 'center' as const, width: SHEET_CONTENT_MAX_WIDTH },
      ]}
    />
  );
}

const keyExtractor = (s: TramPublicState): string => s.key;

// ── Filter chip (models + the line row's "All") ──────────────────────────────

function FilterChip({
  label,
  count,
  selected,
  dark,
  onPress,
}: {
  label: string;
  count?: number;
  selected: boolean;
  dark: boolean;
  onPress: () => void;
}) {
  const c = Colors[dark ? 'dark' : 'light'];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={count != null ? `${label}, ${count} trams` : label}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected
            ? Tram.pidRed
            : dark
              ? 'rgba(255,255,255,0.08)'
              : 'rgba(0,0,0,0.05)',
        },
        pressed && styles.pressed,
      ]}
    >
      <Text
        allowFontScaling={false}
        style={[styles.chipLabel, { color: selected ? Tram.cream : c.text }]}
      >
        {label}
      </Text>
      {count != null && (
        <Text
          allowFontScaling={false}
          style={[
            styles.chipCount,
            { color: selected ? 'rgba(245,235,216,0.75)' : c.textSecondary },
          ]}
        >
          {count}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.six,
  },
  header: {
    gap: Spacing.two + 2,
    paddingTop: Spacing.one,
    paddingBottom: Spacing.two,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  modelChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two - 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: Spacing.two + 4,
    paddingVertical: 6,
  },
  chipLabel: { fontSize: 13, fontWeight: '600' },
  chipCount: { fontSize: 11.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  lineChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two - 2,
    paddingVertical: 2,
  },
  lineChip: {
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: 2,
    borderColor: 'transparent',
    padding: 2,
  },
  lineChipSelected: { borderColor: Tram.gold },
  lineDimmed: { opacity: 0.45 },
  pressed: { opacity: 0.6 },
  empty: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  emptyIcon: { marginBottom: Spacing.one },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptyBody: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
});
