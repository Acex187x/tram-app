// Search sheet — /search. Glass search field + live sections as you type:
// lines (badge grid), trams (reg-number match), stops (diacritics-insensitive).
// Keeps the last 6 searches in a module-level in-memory list (not persisted).
import * as Haptics from 'expo-haptics';
import { useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Fonts, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { normalizeName } from '@/lib/planner/network';
import { searchStops } from '@/lib/planner/planner';
import { useSelectionStore } from '@/stores/selection';
import type { TramPublicState } from '@/lib/types';

// ── Recent searches (in-memory only; survives sheet close, not app restart) ──

type Recent =
  | { type: 'line'; id: string }
  | { type: 'tram'; key: string; line: string }
  | { type: 'stop'; name: string; coordinates: [number, number] };

let RECENTS: Recent[] = [];

function recentId(r: Recent): string {
  switch (r.type) {
    case 'line':
      return `line:${r.id}`;
    case 'tram':
      return `tram:${r.key}`;
    case 'stop':
      return `stop:${normalizeName(r.name)}`;
  }
}

function addRecent(r: Recent): void {
  RECENTS = [r, ...RECENTS.filter((x) => recentId(x) !== recentId(r))].slice(0, 6);
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function SearchSheet() {
  const router = useRouter();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const c = Colors[dark ? 'dark' : 'light'];

  const requestFlyTo = useSelectionStore((s) => s.requestFlyTo);
  const [query, setQuery] = useState('');
  const q = query.trim();

  const states = useAllTramStates();
  const geometries = useLoadedGeometries();

  // Every line we know about — live trams plus loaded geometries.
  const allLines = useMemo(() => {
    const set = new Set<string>();
    for (const s of states) set.add(s.snapshot.line);
    for (const g of geometries) set.add(g.line);
    return [...set].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  }, [states, geometries]);

  // Station name → representative coordinates, for stop fly-to.
  const stopCoords = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const g of geometries) {
      for (const s of g.stops) {
        const key = normalizeName(s.name);
        if (!m.has(key)) m.set(key, s.coordinates);
      }
    }
    return m;
  }, [geometries]);

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
    void Haptics.selectionAsync();
    addRecent({ type: 'line', id });
    router.push(`/line/${id}` as Href);
  };

  const openTram = (state: TramPublicState): void => {
    void Haptics.selectionAsync();
    addRecent({ type: 'tram', key: state.key, line: state.snapshot.line });
    router.push(`/tram/${state.key}` as Href);
  };

  const openStop = (name: string, coordinates?: [number, number]): void => {
    const coords = coordinates ?? stopCoords.get(normalizeName(name));
    if (!coords) return;
    void Haptics.selectionAsync();
    addRecent({ type: 'stop', name, coordinates: coords });
    requestFlyTo({ coordinates: coords, zoom: 16.5 });
    router.back();
  };

  const openRecent = (r: Recent): void => {
    switch (r.type) {
      case 'line':
        openLine(r.id);
        break;
      case 'tram': {
        const live = states.find((s) => s.key === r.key);
        if (live) openTram(live);
        else {
          void Haptics.selectionAsync();
          addRecent(r);
          router.push(`/tram/${r.key}` as Href);
        }
        break;
      }
      case 'stop':
        openStop(r.name, r.coordinates);
        break;
    }
  };

  const hasResults = lineMatches.length > 0 || tramMatches.length > 0 || stopMatches.length > 0;

  return (
    <GlassPanel style={styles.root}>
      <View style={styles.fieldWrap}>
        <GlassPanel variant="clear" style={styles.field}>
          <SymbolView name="magnifyingglass" size={17} tintColor={c.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="Lines, tram numbers, stops"
            placeholderTextColor={c.textSecondary}
            style={[styles.input, { color: c.text }]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="Search"
          />
        </GlassPanel>
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

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {q.length === 0 ? (
          <RecentsSection dark={dark} onOpen={openRecent} />
        ) : hasResults ? (
          <>
            {lineMatches.length > 0 && (
              <View style={styles.section}>
                <SectionHeader label="Lines" color={c.textSecondary as string} />
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
              </View>
            )}

            {tramMatches.length > 0 && (
              <View style={styles.section}>
                <SectionHeader label={tramSectionLabel} color={c.textSecondary as string} />
                {tramMatches.map((s) => (
                  <ResultRow
                    key={s.key}
                    onPress={() => openTram(s)}
                    dark={dark}
                    leading={<LineBadge line={s.snapshot.line} size="sm" />}
                    title={s.key}
                    titleTabular
                    subtitle={s.model.name}
                    textColor={c.text as string}
                    secondaryColor={c.textSecondary as string}
                  />
                ))}
              </View>
            )}

            {stopMatches.length > 0 && (
              <View style={styles.section}>
                <SectionHeader label="Stops" color={c.textSecondary as string} />
                {stopMatches.map((name) => (
                  <ResultRow
                    key={name}
                    onPress={() => openStop(name)}
                    dark={dark}
                    leading={
                      <View style={styles.stopIcon}>
                        <SymbolView name="tram.fill" size={13} tintColor={Tram.cream} />
                      </View>
                    }
                    title={name}
                    textColor={c.text as string}
                    secondaryColor={c.textSecondary as string}
                  />
                ))}
              </View>
            )}
          </>
        ) : (
          <View style={styles.empty}>
            <SymbolView
              name="magnifyingglass"
              size={30}
              tintColor={c.textSecondary}
              style={styles.emptyIcon}
            />
            <Text style={[styles.emptyTitle, { color: c.text }]}>
              No matches for “{q}”
            </Text>
            <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
              Try a line number, a tram registration number, or a stop name. Stops appear as
              routes load.
            </Text>
          </View>
        )}
      </ScrollView>
    </GlassPanel>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <Text style={[styles.sectionHeader, { color }]} allowFontScaling={false}>
      {label.toUpperCase()}
    </Text>
  );
}

function ResultRow({
  onPress,
  leading,
  title,
  subtitle,
  titleTabular,
  textColor,
  secondaryColor,
  dark,
}: {
  onPress: () => void;
  leading: React.ReactNode;
  title: string;
  subtitle?: string;
  titleTabular?: boolean;
  textColor: string;
  secondaryColor: string;
  dark: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.resultRow,
        pressed && { backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' },
      ]}
    >
      {leading}
      <View style={styles.resultBody}>
        <Text
          numberOfLines={1}
          style={[
            styles.resultTitle,
            { color: textColor },
            titleTabular && styles.tabular,
          ]}
        >
          {title}
        </Text>
        {subtitle != null && (
          <Text numberOfLines={1} style={[styles.resultSubtitle, { color: secondaryColor }]}>
            {subtitle}
          </Text>
        )}
      </View>
      <SymbolView name="chevron.right" size={11} tintColor={secondaryColor} />
    </Pressable>
  );
}

function RecentsSection({ dark, onOpen }: { dark: boolean; onOpen: (r: Recent) => void }) {
  const c = Colors[dark ? 'dark' : 'light'];
  // Local snapshot; the parent re-renders ~1 Hz via useAllTramStates, and a
  // manual clear updates it immediately through this state.
  const [, setVersion] = useState(0);
  const recents = RECENTS;

  if (recents.length === 0) {
    return (
      <View style={styles.empty}>
        <SymbolView
          name="tram.fill"
          size={30}
          tintColor={c.textSecondary}
          style={styles.emptyIcon}
        />
        <Text style={[styles.emptyTitle, { color: c.text }]}>Find anything on the network</Text>
        <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
          Search a line number like 22, a tram registration like 9265, or a stop like Malostranská.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.recentHeaderRow}>
        <SectionHeader label="Recent" color={c.textSecondary as string} />
        <Pressable
          onPress={() => {
            RECENTS = [];
            setVersion((v) => v + 1);
          }}
          hitSlop={8}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={[styles.clearText, { color: c.textSecondary }]}>Clear</Text>
        </Pressable>
      </View>
      {recents.map((r) => (
        <ResultRow
          key={recentId(r)}
          onPress={() => onOpen(r)}
          dark={dark}
          leading={
            r.type === 'line' ? (
              <LineBadge line={r.id} size="sm" />
            ) : r.type === 'tram' ? (
              <View style={styles.stopIcon}>
                <SymbolView name="tram.fill" size={13} tintColor={Tram.cream} />
              </View>
            ) : (
              <View style={[styles.stopIcon, { backgroundColor: Tram.night }]}>
                <SymbolView name="mappin.and.ellipse" size={13} tintColor="#FFFFFF" />
              </View>
            )
          }
          title={r.type === 'line' ? `Line ${r.id}` : r.type === 'tram' ? `Tram ${r.key}` : r.name}
          subtitle={r.type === 'tram' ? `Line ${r.line}` : undefined}
          titleTabular={r.type === 'tram'}
          textColor={c.text as string}
          secondaryColor={c.textSecondary as string}
        />
      ))}
    </View>
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
    borderRadius: 14,
    paddingHorizontal: Spacing.two + 4,
    paddingVertical: 10,
  },
  input: {
    flex: 1,
    fontSize: 17,
    padding: 0,
  },
  listContent: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.six,
    gap: Spacing.four,
  },
  section: { gap: Spacing.one },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: Spacing.one,
  },
  lineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.one,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 4,
    minHeight: 48,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: Spacing.two,
  },
  resultBody: { flex: 1, gap: 1 },
  resultTitle: { fontSize: 16, fontWeight: '600' },
  tabular: { fontFamily: Fonts?.rounded, fontVariant: ['tabular-nums'] },
  resultSubtitle: { fontSize: 13 },
  stopIcon: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderCurve: 'continuous',
    backgroundColor: Tram.pidRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  clearText: { fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.55 },
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
