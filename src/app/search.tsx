// Search sheet — /search. Apple-Maps expanded search: a pinned rounded search
// field with a blue Cancel button, and live sections as you type — lines (badge
// grid), trams (reg-number match), stops (diacritics-insensitive, opening the
// live arrivals board) — rendered as iOS grouped inset cards with leading
// colored circle icons. While the query is EMPTY the sheet is a fleet browser
// instead: every live tram, filterable by model and line, client-side paginated
// (src/components/search/FleetBrowser.tsx). Filter state lives here so it
// survives typing and clearing the query (sheet-lifetime only).
import * as Haptics from 'expo-haptics';
import { useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Fragment, useMemo, useState } from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import { FleetBrowser } from '@/components/search/FleetBrowser';
import { EMPTY_FLEET_FILTERS, type FleetFilters } from '@/components/search/fleetFilter';
import { AcSnowflake } from '@/components/tram/TramModelImage';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { InsetGroup, InsetRow, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { appleScheme, Apple, Radii, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { normalizeName } from '@/lib/planner/network';
import { searchStops } from '@/lib/planner/planner';
import { useSelectionStore } from '@/stores/selection';
import type { TramPublicState } from '@/lib/types';

/** Leading-icon inset for result-row separators: 16 pad + 30 badge + 12 gap. */
const ROW_SEPARATOR_INSET = 58;

// ── Screen ───────────────────────────────────────────────────────────────────

export default function SearchSheet() {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const [query, setQuery] = useState('');
  const q = query.trim();

  // Fleet-browser filters: kept while the sheet is open (component state), so
  // typing a query and clearing it returns to the browser with filters intact.
  const [filters, setFilters] = useState<FleetFilters>(EMPTY_FLEET_FILTERS);

  const states = useAllTramStates();
  const geometries = useLoadedGeometries();
  const setSelectedTramKey = useSelectionStore((s) => s.setSelectedTramKey);

  // Every line we know about — live trams plus loaded geometries.
  const allLines = useMemo(() => {
    const set = new Set<string>();
    for (const s of states) set.add(s.snapshot.line);
    for (const g of geometries) set.add(g.line);
    return [...set].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  }, [states, geometries]);

  const lineMatches = useMemo(() => {
    if (!/^\d{1,2}$/.test(q)) return [];
    return allLines.filter((l) => l === q || l.startsWith(q)).slice(0, 12);
  }, [q, allLines]);

  // A 1–2 digit query that names a line the network actually runs. In that case
  // the TRAMS section should list trams operating ON that line, not registration
  // substring coincidences from other lines (e.g. '22' must not surface 9224/9322).
  const lineTramQuery = useMemo(
    () => (/^\d{1,2}$/.test(q) && allLines.includes(q) ? q : null),
    [q, allLines],
  );

  const tramMatches = useMemo(() => {
    // Line query → trams currently on that line, sorted by registration.
    if (lineTramQuery != null) {
      return states
        .filter((s) => s.snapshot.line === lineTramQuery)
        .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
        .slice(0, 20);
    }
    // Otherwise, registration matching for 2+ digit queries: prefix beats substring.
    if (!/^\d{2,}$/.test(q)) return [];
    return states
      .filter((s) => s.key.includes(q))
      .sort((a, b) => {
        const aw = a.key.startsWith(q) ? 0 : 1;
        const bw = b.key.startsWith(q) ? 0 : 1;
        return aw - bw || a.key.localeCompare(b.key, undefined, { numeric: true });
      })
      .slice(0, 10);
  }, [q, states, lineTramQuery]);

  const tramSectionLabel = lineTramQuery != null ? `Trams on line ${lineTramQuery}` : 'Trams';

  const stopMatches = useMemo(() => {
    if (q.length < 2) return [];
    return searchStops(q, geometries, 10);
  }, [q, geometries]);

  const openLine = (id: string): void => {
    Keyboard.dismiss();
    void Haptics.selectionAsync();
    router.push(`/line/${id}` as Href);
  };

  const openTram = (state: TramPublicState): void => {
    Keyboard.dismiss();
    void Haptics.selectionAsync();
    setSelectedTramKey(state.key);
    router.push(`/tram/${encodeURIComponent(state.key)}` as Href);
  };

  // Stop result → the live arrivals board sheet (which has its own
  // "Show on map" action); matches come from loaded geometries.
  const openStop = (name: string): void => {
    Keyboard.dismiss();
    const key = normalizeName(name);
    void Haptics.selectionAsync();
    router.push(`/stop/${encodeURIComponent(key)}` as Href);
  };

  const closeSheet = (): void => {
    Keyboard.dismiss();
    router.back();
  };

  const hasResults = lineMatches.length > 0 || tramMatches.length > 0 || stopMatches.length > 0;

  return (
    <GlassPanel style={styles.root}>
      <SheetContent>
        <View style={styles.fieldWrap}>
          <View style={[styles.field, { backgroundColor: c.fillSecondary }]}>
            <SymbolView name="magnifyingglass" size={17} weight="semibold" tintColor={c.secondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoFocus
              placeholder="Lines, tram numbers, stops"
              placeholderTextColor={c.secondary}
              style={[styles.input, { color: c.text }]}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              clearButtonMode="while-editing"
              accessibilityLabel="Search"
            />
          </View>
          <Pressable
            onPress={closeSheet}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text style={[styles.cancel, { color: Apple.blue }]} allowFontScaling={false}>
              Cancel
            </Text>
          </Pressable>
        </View>
      </SheetContent>

      {q.length === 0 ? (
        // Empty query → the fleet browser (all live trams, filters, pagination).
        <FleetBrowser
          states={states}
          geometries={geometries}
          filters={filters}
          onChangeFilters={setFilters}
          onOpenTram={openTram}
        />
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.scrollBottom}
          showsVerticalScrollIndicator={false}
        >
          <SheetContent style={styles.listContent}>
            {hasResults ? (
              <>
                {lineMatches.length > 0 && (
                  <View>
                    <SectionLabel>Lines</SectionLabel>
                    <InsetGroup style={styles.linesCard}>
                      <View style={styles.lineGrid}>
                        {lineMatches.map((l) => (
                          <Pressable
                            key={l}
                            onPress={() => openLine(l)}
                            accessibilityRole="button"
                            accessibilityLabel={`Line ${l}`}
                            style={({ pressed }) => pressed && styles.pressed}
                          >
                            <LineBadge line={l} size="lg" />
                          </Pressable>
                        ))}
                      </View>
                    </InsetGroup>
                  </View>
                )}

                {tramMatches.length > 0 && (
                  <View>
                    <SectionLabel>{tramSectionLabel}</SectionLabel>
                    <InsetGroup>
                      {tramMatches.map((s, i) => (
                        <Fragment key={s.key}>
                          {i > 0 && <RowSeparator inset={ROW_SEPARATOR_INSET} />}
                          <InsetRow
                            onPress={() => openTram(s)}
                            iconNode={<LineBadge line={s.snapshot.line} size="md" />}
                            title={s.key}
                            subtitle={s.model.name}
                            trailing={<AcSnowflake airConditioned={s.snapshot.airConditioned} />}
                            chevron
                          />
                        </Fragment>
                      ))}
                    </InsetGroup>
                  </View>
                )}

                {stopMatches.length > 0 && (
                  <View>
                    <SectionLabel>Stops</SectionLabel>
                    <InsetGroup>
                      {stopMatches.map((name, i) => (
                        <Fragment key={name}>
                          {i > 0 && <RowSeparator inset={ROW_SEPARATOR_INSET} />}
                          <InsetRow
                            onPress={() => openStop(name)}
                            icon="tram.fill"
                            iconTint={Tram.pidRed}
                            title={name}
                            chevron
                          />
                        </Fragment>
                      ))}
                    </InsetGroup>
                  </View>
                )}
              </>
            ) : (
              <View style={styles.empty}>
                <SymbolView
                  name="magnifyingglass"
                  size={30}
                  tintColor={c.secondary}
                  style={styles.emptyIcon}
                />
                <Text style={[styles.emptyTitle, { color: c.text }]}>No matches for “{q}”</Text>
                <Text style={[styles.emptyBody, { color: c.secondary }]}>
                  Try a line number, a tram registration number, or a stop name. Stops appear as
                  routes load.
                </Text>
              </View>
            )}
          </SheetContent>
        </ScrollView>
      )}
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fieldWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.two,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Radii.field,
    borderCurve: 'continuous',
    paddingHorizontal: Spacing.two + 4,
    paddingVertical: 9,
  },
  input: {
    flex: 1,
    fontSize: 17,
    padding: 0,
  },
  cancel: { fontSize: 17, fontWeight: '400' },
  scrollBottom: {
    paddingBottom: Spacing.six,
  },
  listContent: {
    padding: Spacing.three,
    gap: Spacing.four,
  },
  linesCard: {
    padding: Spacing.three,
  },
  lineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two + 2,
  },
  pressed: { opacity: 0.55 },
  empty: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  emptyIcon: { marginBottom: Spacing.one },
  emptyTitle: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  emptyBody: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
});
