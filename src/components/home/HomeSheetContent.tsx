// The home sheet starts with Tram Spotter's core promise: choose a journey and
// see the exact physical cars to board. Nearby service, favorites, recent stop
// pairs and fleet tools follow in that order.
//
// THE LIVE GATE (`live`) — the load-bearing perf decision on this surface.
// Sections 1 and 2 subscribe to the 1 Hz runtime (`useAllTramStates`,
// `useTramState`, `useNowMs`) and section 1 additionally runs `computeArrivals`,
// which is O(states × stops). None of that may happen while the sheet is resting
// at peek over a hot basemap. `live` gates by MOUNTING, not by a conditional
// hook: at peek those components DO NOT EXIST, so they hold zero subscriptions —
// which is the only version of this that is actually verifiable. The map screen
// derives the flag (see src/app/index.tsx) and the fix behind section 1 is
// module-cached, so re-expanding is instant rather than a re-locate.
//
// The pinned header above this body is ALWAYS `HomeSearchRow` — the tram card
// owns its own collapsed bar, so the home sheet's identity never changes.
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { HomeFavorites } from '@/components/home/HomeFavorites';
import { SHEET_H_PAD } from '@/components/home/homeMetrics';
import { NearestStopCard, NearestStopPlaceholder } from '@/components/home/NearestStopCard';
import { RecentRouteRows } from '@/components/home/HomeRecents';
import { InsetGroup, InsetRow, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { appleScheme, Radii, TextScale, Tram } from '@/constants/theme';
import { useFavoritesStore } from '@/stores/favorites';
import { usePlannerStore } from '@/stores/planner';
import { useSettingsStore } from '@/stores/settings';

export interface HomeSheetContentProps {
  /**
   * True only while the sheet is settled/dragged past peek AND no tram card is
   * covering it. Gates the live sections by MOUNT — see the file header.
   */
  live?: boolean;
}

export function HomeSheetContent({ live = false }: HomeSheetContentProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const favTrams = useFavoritesStore((s) => s.favoriteTrams.length);
  const favLines = useFavoritesStore((s) => s.favoriteLines.length);
  const hasRecents = usePlannerStore((s) => s.recents.length > 0);
  // A plain store read, not a live-data subscription — it stays OUTSIDE the gate
  // so the debug row's presence never depends on the detent.
  const debugMode = useSettingsStore((s) => s.debugMode);

  const favCount = favTrams + favLines;

  return (
    <View style={styles.body}>
      {/* Product identity: the app starts with the journey and promises the
          exact physical tram, rather than presenting a generic Maps menu. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Plan a tram trip and see which vehicles to board"
        onPress={() => router.push('/planner')}
        style={({ pressed }) => [
          styles.tripHero,
          { backgroundColor: c.fillTertiary, opacity: pressed ? 0.72 : 1 },
        ]}
      >
        <View style={styles.tripHeroTop}>
          <View style={styles.tripMark}>
            <SymbolView name="tram.fill" size={20} weight="semibold" tintColor="#FFFFFF" />
          </View>
          <View style={styles.tripHeroCopy}>
            <Text style={[styles.tripEyebrow, { color: c.secondary }]}>TRAM ROUTE</Text>
            <Text style={[styles.tripTitle, { color: c.text }]}>Where are you going?</Text>
          </View>
          <SymbolView name="arrow.up.right" size={17} weight="semibold" tintColor={c.blue} />
        </View>
        <Text style={[styles.tripPromise, { color: c.secondary }]} maxFontSizeMultiplier={TextScale.content}>
          Get a route with the exact tram models and car numbers you should board.
        </Text>
      </Pressable>

      {/* ── NEAREST STOP ───────────────────────────────────────────────── */}
      {live ? <NearestStopCard /> : <NearestStopPlaceholder />}

      {/* ── 2. FAVORITES ────────────────────────────────────────────────── */}
      {favCount === 0 ? (
        <InsetGroup>
          <InsetRow
            icon="star.fill"
            iconTint={Tram.gold}
            title="Favorites"
            subtitle="Star a tram or line on the map"
            chevron
            onPress={() => router.push('/favorites')}
          />
        </InsetGroup>
      ) : live ? (
        <HomeFavorites />
      ) : (
        // The peek stand-in: the same destination as one static row, so the
        // section keeps a place in the layout without a single live hook.
        <InsetGroup>
          <InsetRow
            icon="star.fill"
            iconTint={Tram.gold}
            title="Favorites"
            subtitle={`${favCount} saved`}
            chevron
            onPress={() => router.push('/favorites')}
          />
        </InsetGroup>
      )}

      {/* Recent trips are shortcuts, not a second planner entry. */}
      {hasRecents && (
        <View>
          <SectionLabel>Recent routes</SectionLabel>
          <InsetGroup>
            <RecentRouteRows limit={3} />
          </InsetGroup>
        </View>
      )}

      {/* Fleet utilities live together under a product-specific label. */}
      <View>
        <SectionLabel>Tram desk</SectionLabel>
        <InsetGroup>
          <InsetRow
            icon="tram.fill"
            iconTint={Tram.pidRed}
            title="Browse the fleet"
            subtitle="Every live tram, by line or model"
            chevron
            onPress={() => router.push('/search')}
          />
          {debugMode && (
            <>
              <RowSeparator inset={ROW_INSET} />
              <InsetRow
                icon="record.circle"
                iconTint={c.red}
                title="Recorded rides"
                subtitle="Your captured journeys"
                chevron
                onPress={() => router.push('/rides')}
              />
            </>
          )}
        </InsetGroup>
      </View>
    </View>
  );
}

/** Leading icon circle (29) + row padding (16) + gap (12): the row-text inset. */
const ROW_INSET = 16 + 29 + 12;

const styles = StyleSheet.create({
  body: {
    // ONE content edge for every top-level element in the sheet — the section
    // labels, the cards and the search field above them all start here.
    paddingHorizontal: SHEET_H_PAD,
    paddingTop: 8,
    paddingBottom: 8,
    // The section rhythm, shared with the tram card.
    gap: 22,
  },
  tripHero: {
    borderCurve: 'continuous',
    borderRadius: Radii.group,
    gap: 10,
    padding: 16,
  },
  tripHeroTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  tripMark: {
    alignItems: 'center',
    backgroundColor: Tram.pidRed,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  tripHeroCopy: { flex: 1, gap: 1 },
  tripEyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  tripTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.2 },
  tripPromise: { fontSize: 14, lineHeight: 19, paddingLeft: 48 },
});
