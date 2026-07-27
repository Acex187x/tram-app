// Fleet browser — the search sheet's idle (empty-query) state: every live
// tram, filterable by model and by line, client-side paginated. Restyled to
// Apple Maps' long-list grammar: a count caption, Apple pill filter toggles
// (models) + a line-badge toggle row, and inset rows split by hairline
// separators.
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
import { Host } from '@expo/ui';
import { ContentUnavailableView } from '@expo/ui/swift-ui';

import { RowSeparator } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SHEET_CONTENT_MAX_WIDTH } from '@/components/ui/SheetContent';
import { appleScheme, Radii, TabularNums, TextScale, Type } from '@/constants/theme';
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

/** Leading-icon inset for fleet-row separators: 16 pad + 30 badge + 12 gap. */
const ROW_SEPARATOR_INSET = 58;

// The chips must keep their Apple-pill visual height (a 44 pt pill would no
// longer read as a filter next to the 30 pt line badges), so the 44 pt minimum
// target is reached with hit slop instead: 28 + 8·2 and 38 + 3·2.
const CHIP_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 } as const;
const LINE_CHIP_HIT_SLOP = { top: 3, bottom: 3, left: 3, right: 3 } as const;

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
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const dark = scheme === 'dark';
  const c = appleScheme(scheme);
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

  const separator = useCallback(
    () => <RowSeparator inset={ROW_SEPARATOR_INSET} />,
    [],
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
      <Text style={[styles.headerTitle, { color: c.secondary }]} accessibilityRole="header">
        {headerText}
      </Text>

      {/* Model chips: All + one per model in live data. Wraps gracefully. */}
      <View style={styles.modelChips}>
        <FilterChip
          label="All"
          selected={filters.models.length === 0}
          scheme={scheme}
          onPress={() => onChangeFilters({ ...filters, models: [] })}
        />
        {models.map((m) => (
          <FilterChip
            key={m.id}
            label={MODEL_SHORT_NAMES[m.id]}
            count={m.count}
            selected={filters.models.includes(m.id)}
            scheme={scheme}
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
            scheme={scheme}
            onPress={() => onChangeFilters({ ...filters, lines: [] })}
          />
          {lines.map((line) => {
            const selected = filters.lines.includes(line);
            const anySelected = filters.lines.length > 0;
            return (
              <Pressable
                key={line}
                onPress={() => toggleLine(line)}
                hitSlop={LINE_CHIP_HIT_SLOP}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Filter line ${line}`}
                style={({ pressed }) => [
                  styles.lineChip,
                  selected && { borderColor: c.blue },
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

  // NOT `matchContents`: that asks SwiftUI for ContentUnavailableView's ideal
  // size, which is wider than the sheet — it then overflows instead of wrapping.
  // A definite RN frame keeps the copy inside the column.
  const empty = (
    <Host style={styles.empty}>
      <ContentUnavailableView
        systemImage="line.3.horizontal.decrease.circle"
        title={live.length === 0 ? 'No trams reporting yet' : 'No trams match these filters'}
        description={
          live.length === 0
            ? 'Live positions appear a few seconds after the first poll.'
            : 'Loosen the model or line filters to see more of the fleet.'
        }
      />
    </Host>
  );

  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ItemSeparatorComponent={separator}
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
      automaticallyAdjustKeyboardInsets
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

// ── Filter chip (models + each line row's "All") ─────────────────────────────

function FilterChip({
  label,
  count,
  selected,
  scheme,
  onPress,
}: {
  label: string;
  count?: number;
  selected: boolean;
  scheme: 'light' | 'dark';
  onPress: () => void;
}) {
  const c = appleScheme(scheme);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={CHIP_HIT_SLOP}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={count != null ? `${label}, ${count} trams` : label}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: selected ? c.blue : c.fillTertiary },
        pressed && styles.pressed,
      ]}
    >
      <Text
        maxFontSizeMultiplier={TextScale.compact}
        style={[styles.chipLabel, { color: selected ? '#FFFFFF' : c.text }]}
      >
        {label}
      </Text>
      {count != null && (
        <Text
          maxFontSizeMultiplier={TextScale.compact}
          style={[
            styles.chipCount,
            { color: selected ? 'rgba(255,255,255,0.75)' : c.secondary },
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
    paddingHorizontal: 16,
    paddingBottom: 64,
  },
  header: {
    gap: 10,
    paddingTop: 4,
    paddingBottom: 8,
  },
  // Matches `SectionLabel` (Inset.tsx) — including its left edge. The stray
  // `marginLeft: 2` this used to carry put it 2 pt inboard of the search field
  // and the filter chips it sits between, which is exactly the kind of one-off
  // nudge the sheet grid exists to prevent (measured 18.67 against their 16.00).
  headerTitle: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  modelChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: Radii.circle,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipLabel: { fontSize: 13, fontWeight: '600' },
  chipCount: { ...Type.caption1, fontWeight: '600', ...TabularNums },
  lineChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
    paddingRight: 8,
  },
  lineChip: {
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: 2,
    borderColor: 'transparent',
    padding: 2,
  },
  lineDimmed: { opacity: 0.45 },
  pressed: { opacity: 0.6 },
  empty: { minHeight: 240, paddingVertical: 32 },
});
