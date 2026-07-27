// Search sheet — /search. Apple-Maps expanded search: a pinned rounded search
// field with a blue Cancel button, and live sections as you type — lines (badge
// grid), trams (reg-number match), stops (diacritics-insensitive, opening the
// live arrivals board) — rendered as iOS grouped inset cards with leading
// colored circle icons. While the query is EMPTY the sheet is a fleet browser
// instead: every live tram, filterable by model and line, client-side paginated
// (src/components/search/FleetBrowser.tsx). Filter state lives here so it
// survives typing and clearing the query (sheet-lifetime only).
//
// Surface: <SheetSurface scrollable={false}/>, the SAME scaffold every other
// route sheet uses — grabber pill, background, header slot, readable column cap.
// `scrollable={false}` is the mode for a body that is its own scroll container:
// this screen's idle body is FleetBrowser's FlatList, and SheetSurface renders
// bare children so that list stays a DIRECT subview of the screen (which is what
// react-native-screens needs to wire the drag-to-expand gesture). This screen
// used to hand-roll a plain root View + SheetBackground, and drifted: a 20 pt
// header inset against everyone else's grabber band, no shared pill, no column
// cap. That drift is the "/search looks like a different component" report.
import { Host } from '@expo/ui';
import { ContentUnavailableView } from '@expo/ui/swift-ui';
import * as Haptics from 'expo-haptics';
import { Link, useRouter, type Href } from 'expo-router';
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

import { HEADER_PAD_TOP } from '@/components/maps-kit/mapSheetLayout';
import { FleetBrowser } from '@/components/search/FleetBrowser';
import { EMPTY_FLEET_FILTERS, type FleetFilters } from '@/components/search/fleetFilter';
import { AcSnowflake, acTint } from '@/components/tram/TramModelImage';
import { InsetGroup, InsetRow, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { appleScheme, Radii, Spacing, TextScale, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { normalizeName } from '@/lib/planner/network';
import { searchStops } from '@/lib/planner/planner';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';
import type { TramPublicState } from '@/lib/types';

/**
 * Frame the no-match SwiftUI view lays out in. Deliberately NOT `matchContents`
 * on the Host: that asks SwiftUI for its ideal size, and ContentUnavailableView's
 * ideal width is wider than the sheet, so it overflows in every direction — it
 * only ever looked contained because the screen's old root GlassView clipped it.
 * A definite RN frame lets SwiftUI wrap the copy inside the sheet instead.
 */
const EMPTY_STATE_H = 240;

/** Leading-icon inset for result-row separators: 16 pad + 30 badge + 12 gap. */
const ROW_SEPARATOR_INSET = 58;

// Cancel is a bare label in the field row, so the 44 pt minimum target comes
// from hit slop rather than a taller frame (~20 pt of text + 12 pt each side).
const CANCEL_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const;

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
  const presentTram = useSelectionStore((s) => s.openTram);
  const favoriteTrams = useFavoritesStore((s) => s.favoriteTrams);
  const toggleTram = useFavoritesStore((s) => s.toggleTram);

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

  /**
   * Everything a tram row does apart from getting back to the map. The tram card
   * is an owned sheet on the MAP screen now, so "opening" a tram is a store
   * write; the navigation half is only about dismissing this sheet.
   */
  const prepareTram = (state: TramPublicState): void => {
    Keyboard.dismiss();
    void Haptics.selectionAsync();
    presentTram(state.key);
  };

  const openTram = (state: TramPublicState): void => {
    prepareTram(state);
    router.dismissAll();
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
  // Two of the three matchers decline to run on a 1-char query (stops need 2+,
  // registrations need 2+ digits), so "no matches" would otherwise fire on the
  // first letter of every stop name — before anything has actually been searched.
  const searched = q.length >= 2 || /^\d$/.test(q);

  const field = (
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
          maxFontSizeMultiplier={TextScale.compact}
        />
      </View>
      <Pressable
        onPress={closeSheet}
        hitSlop={CANCEL_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Text style={[styles.cancel, { color: c.blue }]} maxFontSizeMultiplier={TextScale.compact}>
          Cancel
        </Text>
      </Pressable>
    </View>
  );

  return (
    <SheetSurface scrollable={false} header={field}>
      {/* One STABLE body view around the two branches. The branches are two
          different scroll containers (FleetBrowser's FlatList / the results
          ScrollView) and this screen swaps them as you type — but
          react-native-screens sizes a sheet's scroll view exactly once, from the
          content wrapper's own layout pass (RNSScreenContentWrapper
          `triggerDelegateUpdate`). A scroll view mounted LATER is never
          corrected, and Fabric leaves it at (0, 0): typing a query made the
          results render from the sheet's top edge, over the search field.
          Inside this wrapper both branches are laid out by ordinary flexbox, so
          the swap is safe. The cost — rn-screens can no longer wire
          `prefersScrollingExpandsWhenScrolledToEdge` — is nil here: /search has
          a single detent, so there is no larger detent to expand to. */}
      <View style={styles.body}>
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
            // flex:1, exactly like FleetBrowser's list. As a DIRECT child of the
            // sheet screen (no flex container above it) an unstyled ScrollView
            // lays out at full screen height from y=0 and the results paint OVER
            // the pinned search field — verified on device.
            style={styles.scroll}
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets
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
                            {/* Link owns the navigation so the row gets the
                              native long-press menu; the row's own onPress
                              presents the card (keyboard, haptic, store write).
                              /tram/[key] is a SHIM that renders nothing — it
                              writes the same store field and dismisses back to
                              the map, so pressing the row and following the
                              Link land in exactly the same place. No
                              Link.Preview: there is no longer a screen to
                              preview, and the live subscriptions belong to the
                              map's own sheet. */}
                            <Link
                              href={`/tram/${encodeURIComponent(s.key)}` as Href}
                              asChild
                              onPress={() => prepareTram(s)}
                            >
                              <Link.Trigger>
                                <InsetRow
                                  iconNode={<LineBadge line={s.snapshot.line} size="md" />}
                                  title={s.key}
                                  label={`Tram ${s.key}, line ${s.snapshot.line}, ${s.model.name}${
                                    s.snapshot.airConditioned ? ', air conditioned' : ''
                                  }`}
                                  subtitle={s.model.name}
                                  trailing={
                                    <AcSnowflake
                                      airConditioned={s.snapshot.airConditioned}
                                      tint={acTint(scheme)}
                                      decorative
                                    />
                                  }
                                  chevron
                                />
                              </Link.Trigger>
                              <Link.Menu>
                                <Link.MenuAction
                                  icon={favoriteTrams.includes(s.key) ? 'star.slash' : 'star'}
                                  onPress={() => toggleTram(s.key)}
                                >
                                  {favoriteTrams.includes(s.key) ? 'Unfavorite' : 'Favorite'}
                                </Link.MenuAction>
                                <Link.MenuAction
                                  icon="tram.fill"
                                  onPress={() => openLine(s.snapshot.line)}
                                >
                                  {`Show line ${s.snapshot.line}`}
                                </Link.MenuAction>
                              </Link.Menu>
                            </Link>
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
              ) : searched ? (
                <Host style={styles.empty}>
                  <ContentUnavailableView
                    systemImage="magnifyingglass"
                    title={`No matches for “${q}”`}
                    description="Try a line number, a tram registration number, or a stop name. Stops appear as routes load."
                  />
                </Host>
              ) : null}
            </SheetContent>
          </ScrollView>
        )}
      </View>
    </SheetSurface>
  );
}

const styles = StyleSheet.create({
  // overflow:hidden so a keyboard content inset cannot let the body paint
  // outside its own frame and ride up over the pinned field.
  body: { flex: 1, overflow: 'hidden' },
  scroll: { flex: 1 },
  fieldWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingHorizontal: Spacing.three,
    // The grabber band, not a hand-picked inset: HEADER_PAD_TOP is gap + pill +
    // clearance, the same padding SheetHeader and the owned sheets put above
    // their header row. At the old Spacing.four (24) this field sat 9 pt lower
    // than every other sheet's title under an identically placed pill.
    paddingTop: HEADER_PAD_TOP,
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
  empty: { minHeight: EMPTY_STATE_H, paddingVertical: Spacing.five },
});
