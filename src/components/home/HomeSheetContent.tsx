// The home sheet's scrollable body — FOUR categories, in the order a tram
// spotter actually needs them:
//
//   1. NEAREST STOP (the hero, no caption — it is the top card and its own
//      header row names it, exactly as Apple Maps treats its top card)
//   2. FAVORITES — starred trams with live status, starred lines as badges
//   3. TRIPS — recent routes AND the planner, one card (they are one intent)
//   4. EXPLORE — the fleet browser, plus recorded rides in debug mode only
//
// It is deliberately NOT an Apple "Places circles / Guides" clone: the content
// is ours (PID line badges, live tram status, the Prague network) and the only
// thing borrowed is the grouped-inset idiom every iOS user already reads.
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
import { StyleSheet, useColorScheme, View } from 'react-native';

import { HomeFavorites } from '@/components/home/HomeFavorites';
import { SHEET_H_PAD } from '@/components/home/homeMetrics';
import { NearestStopCard, NearestStopPlaceholder } from '@/components/home/NearestStopCard';
import { RecentRouteRows } from '@/components/home/HomeRecents';
import { InsetGroup, InsetRow, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { appleScheme, Tram } from '@/constants/theme';
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
      {/* ── 1. NEAREST STOP ─────────────────────────────────────────────── */}
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

      {/* ── 3. TRIPS — recents and the planner are ONE intent, one card ─── */}
      <View>
        <SectionLabel>Trips</SectionLabel>
        <InsetGroup>
          <RecentRouteRows limit={3} />
          {hasRecents && <RowSeparator inset={ROW_INSET} />}
          {/* A modest last row, not a big button: planning is what you do when
              none of the routes above is the one you want. */}
          <InsetRow
            icon="arrow.triangle.swap"
            iconTint={c.blue}
            title="Plan a trip"
            subtitle="Route between two stops"
            chevron
            onPress={() => router.push('/planner')}
          />
        </InsetGroup>
      </View>

      {/* ── 4. EXPLORE ──────────────────────────────────────────────────── */}
      <View>
        <SectionLabel>Explore</SectionLabel>
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
});
