// FAVORITES, LIVE — the home sheet's second section. Starred trams as rich rows
// that say what the car is doing RIGHT NOW ("At Karlovo náměstí", "Next Lehovec
// · 2 min", "Not in service"), and starred lines as a row of PID badges.
//
// Deliberately NOT a reuse of src/components/favorites/FavoriteTramRow: that row
// is a MANAGEMENT surface — it carries an unstar star and a VoiceOver unstar
// action, which is right on /favorites and wrong here, where a mis-tap would
// silently drop a favorite from a card the user is only glancing at. Both rows
// stay; they serve different screens.
//
// PERF: one `useTramState` per row at the shared 1 Hz cadence, and ONE
// `useLoadedGeometries` read for the whole list (lifted here and handed down —
// N rows must not each enumerate the shape cache). The section is mounted only
// while the sheet is settled past peek, so at rest it holds no subscriptions at
// all (see HomeSheetContent's `live` gate).
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { DelayPill } from '@/components/ui/DelayPill';
import { InsetGroup, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { appleScheme, TabularNums, TextScale } from '@/constants/theme';
import { getRuntime, useLoadedGeometries, useTramState } from '@/hooks/tramData';
import type { RouteGeometry } from '@/lib/types';
import { tramStatusLine } from '@/lib/tramStatus';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';

/** How many starred trams the home card shows before "See all" takes over. */
const MAX_ROWS = 3;
/** Badge (30) + row padding (16) + gap (12) — separators aligned with the text. */
const ROW_TEXT_INSET = 58;

export function HomeFavorites() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const trams = useFavoritesStore((s) => s.favoriteTrams);
  const lines = useFavoritesStore((s) => s.favoriteLines);
  // ONE read for the whole list — see the file header.
  const geometries = useLoadedGeometries();

  const openLine = (line: string): void => {
    void Haptics.selectionAsync();
    useSelectionStore.getState().setSelectedLineId(line);
    router.push(`/line/${line}`);
  };

  return (
    <View>
      <SectionLabel
        trailing={
          <Pressable
            onPress={() => router.push('/favorites')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="See all favorites"
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text
              style={[styles.seeAll, { color: c.blue }]}
              maxFontSizeMultiplier={TextScale.compact}
            >
              See all
            </Text>
          </Pressable>
        }
      >
        Favorites
      </SectionLabel>

      {trams.length > 0 && (
        <InsetGroup>
          {trams.slice(0, MAX_ROWS).map((key, i) => (
            <Fragment key={key}>
              {i > 0 && <RowSeparator inset={ROW_TEXT_INSET} />}
              <FavoriteTramCardRow regKey={key} geometries={geometries} />
            </Fragment>
          ))}
        </InsetGroup>
      )}

      {lines.length > 0 && (
        <View style={[styles.chips, trams.length > 0 && styles.chipsSpaced]}>
          {lines.map((line) => (
            <Pressable
              key={line}
              onPress={() => openLine(line)}
              // 30 pt badge + 6 pt slop on each side ⇒ a 42 pt target inside a
              // row whose own height gives it the last 2 pt.
              hitSlop={7}
              accessibilityRole="button"
              accessibilityLabel={`Line ${line}, show line details`}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <LineBadge line={line} size="md" />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function FavoriteTramCardRow({
  regKey,
  geometries,
}: {
  regKey: string;
  geometries: RouteGeometry[];
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const state = useTramState(regKey);
  const status = tramStatusLine(state, geometries);

  // No `dismissAll` here (unlike the favorites SHEET's row): we are already on
  // the map screen, so presenting the card is the whole interaction.
  const open = (): void => {
    if (!state) return;
    void Haptics.selectionAsync();
    getRuntime().prioritizeTrip(state.snapshot.tripId);
    useSelectionStore.getState().openTram(regKey);
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      // An out-of-service car is not `disabled`: that would strip the row from
      // the VoiceOver order entirely. `open` no-ops without a live state.
      accessibilityState={{ disabled: state == null }}
      accessibilityLabel={`Tram ${regKey}${
        state ? `, line ${state.snapshot.line} to ${state.snapshot.headsign}` : ''
      }, ${status}`}
      style={({ pressed }) => [
        styles.row,
        pressed && state != null && { backgroundColor: c.fillHighlight },
      ]}
    >
      <View style={styles.leading}>
        {state ? (
          <LineBadge line={state.snapshot.line} size="md" />
        ) : (
          <View style={[styles.idleBadge, { backgroundColor: c.fillTertiary }]}>
            <SymbolView name="tram.fill" size={15} tintColor={c.secondary} />
          </View>
        )}
      </View>

      <View style={[styles.body, state == null && styles.dimmed]}>
        <View style={styles.titleRow}>
          <Text
            style={[styles.title, { color: c.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.content}
          >
            {state ? state.snapshot.headsign : `Tram #${regKey}`}
          </Text>
          {/* The car number rides ALONGSIDE the headsign while the tram is out
              there (the headsign says where it is going, the number says which
              car it is). Off shift the number IS the title, so repeating it
              here would print it twice — as would repeating the status line,
              which already reads "Not in service". */}
          {state != null && (
            <Text
              style={[styles.reg, { color: c.secondary }]}
              maxFontSizeMultiplier={TextScale.compact}
            >
              #{regKey}
            </Text>
          )}
        </View>
        <Text
          style={[styles.status, { color: c.secondary }]}
          numberOfLines={1}
          maxFontSizeMultiplier={TextScale.content}
        >
          {status}
        </Text>
      </View>

      {state ? <DelayPill delaySeconds={state.snapshot.delaySeconds} /> : null}
      {state ? (
        <SymbolView
          name="chevron.right"
          size={13}
          weight="semibold"
          tintColor={c.secondary}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
    </Pressable>
  );
}

const BADGE = 30;

const styles = StyleSheet.create({
  seeAll: { fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.55 },
  chips: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  chipsSpaced: { marginTop: 10 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  leading: { alignItems: 'center', width: BADGE },
  idleBadge: {
    alignItems: 'center',
    borderRadius: 8,
    height: BADGE,
    justifyContent: 'center',
    width: BADGE,
  },
  body: { flex: 1, gap: 2 },
  dimmed: { opacity: 0.55 },
  titleRow: { alignItems: 'baseline', flexDirection: 'row', gap: 7 },
  // The headsign is the SHRINKING element; the car number is the identity the
  // user starred and must never be the thing that truncates.
  title: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
  reg: { ...TabularNums, flexShrink: 0, fontSize: 13 },
  status: { fontSize: 13 },
});
