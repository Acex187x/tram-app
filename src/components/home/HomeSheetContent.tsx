// The native home sheet's pinned header + scrollable body (IMG_0072–74).
//
// HomeSheetHeader — the fresh Apple-Maps peek bar: a translucent rounded field
// (search glyph · "Search" · microphone) next to a circular account/settings
// button. Visible at the peek detent; the field (and the mic) push the existing
// /search sheet — data flow unchanged.
//
// HomeSheetContent — OUR identity as a native grouped-inset list (Favorites,
// Plan a trip, Browse the fleet, Recorded rides) plus the user's recent planned
// routes. Deliberately NOT an Apple "Places circles / Guides" clone. Lives
// inside the sheet, so it follows the system scheme (chrome follows the map).
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { HomeRecents } from '@/components/home/HomeRecents';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { InsetGroup, InsetRow, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { appleScheme, Apple, Radii, Tram } from '@/constants/theme';
import { useFavoritesStore } from '@/stores/favorites';
import { usePlannerStore } from '@/stores/planner';

// ── Pinned header: search field + settings avatar ───────────────────────────

export function HomeSheetHeader({ chromeScheme }: { chromeScheme?: 'light' | 'dark' }) {
  // The peek search bar sits on the SAME visual band as the map chrome (status
  // tile + control column), floating just over the basemap — so its glass must
  // follow the MAP light preset the caller passes (day → light glass, night →
  // dark glass), exactly like StatusTile / CircleControl. Falling back to the
  // system scheme only if no map scheme is supplied. Using the system scheme made
  // the bar a lone dark slab beside light chrome over a daytime map.
  const systemScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const scheme = chromeScheme ?? systemScheme;
  const c = appleScheme(scheme);

  return (
    <View style={styles.header}>
      {/* Fresh iOS 26 Apple-Maps peek bar (IMG_0072): a translucent Liquid-Glass
          PILL — search glyph · centered "Search" placeholder · voice mic — beside
          a Liquid-Glass account/settings circle of the SAME height. The glass is
          a real GlassView (expo-glass-effect) so the pill reads as a light,
          floating capsule over the sheet instead of the old dark opaque slab;
          it degrades to blur, then a solid fill (GlassPanel). Tapping anywhere in
          the pill (or the mic) opens our existing /search sheet — data unchanged. */}
      <GlassPanel
        variant="regular"
        interactive
        appearance={scheme}
        style={styles.searchField}
      >
        <Pressable
          accessibilityRole="search"
          accessibilityLabel="Search lines, trams and stops"
          onPress={() => router.push('/search')}
          style={({ pressed }) => [styles.searchPress, { opacity: pressed ? 0.6 : 1 }]}
        >
          <SymbolView name="magnifyingglass" size={17} weight="semibold" tintColor={c.secondary} />
          <Text
            style={[styles.searchPlaceholder, { color: c.secondary }]}
            numberOfLines={1}
            allowFontScaling={false}
          >
            Search
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search by voice"
            hitSlop={8}
            onPress={() => router.push('/search')}
            style={({ pressed }) => [styles.micButton, { opacity: pressed ? 0.5 : 1 }]}
          >
            <SymbolView name="mic.fill" size={17} weight="medium" tintColor={c.secondary} />
          </Pressable>
        </Pressable>
      </GlassPanel>
      <GlassPanel variant="regular" interactive appearance={scheme} style={styles.avatar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.avatarPress, { opacity: pressed ? 0.6 : 1 }]}
        >
          <SymbolView name="gearshape.fill" size={19} tintColor={c.text} />
        </Pressable>
      </GlassPanel>
    </View>
  );
}

// ── Body ────────────────────────────────────────────────────────────────────

export function HomeSheetContent() {
  const favCount = useFavoritesStore((s) => s.favoriteTrams.length + s.favoriteLines.length);
  const hasRecents = usePlannerStore((s) => s.recents.length > 0);

  // OUR identity (not an Apple "Places / Guides" clone): the app's own
  // destinations as a native grouped-inset list — Favorites, trip planner, the
  // fleet browser, recorded rides — followed by the user's recent planned
  // routes. Same routes the map dock always used; the home sheet just gathers
  // them behind one native surface.
  return (
    <View style={styles.body}>
      <InsetGroup>
        <InsetRow
          icon="star.fill"
          iconTint={Tram.gold}
          title="Favorites"
          subtitle={favCount > 0 ? `${favCount} saved` : 'Star a tram or line on the map'}
          chevron
          onPress={() => router.push('/favorites')}
        />
        <RowSeparator inset={ROW_INSET} />
        <InsetRow
          icon="arrow.triangle.swap"
          iconTint={Apple.blue}
          title="Plan a trip"
          subtitle="Route between two stops"
          chevron
          onPress={() => router.push('/planner')}
        />
        <RowSeparator inset={ROW_INSET} />
        <InsetRow
          icon="tram.fill"
          iconTint={Tram.pidRed}
          title="Browse the fleet"
          subtitle="Every live tram, by line or model"
          chevron
          onPress={() => router.push('/search')}
        />
        <RowSeparator inset={ROW_INSET} />
        <InsetRow
          icon="record.circle"
          iconTint={Apple.red}
          title="Recorded rides"
          subtitle="Your captured journeys"
          chevron
          onPress={() => router.push('/rides')}
        />
      </InsetGroup>

      {hasRecents && (
        <View style={styles.recentsSection}>
          <SectionLabel>Recent routes</SectionLabel>
          <HomeRecents />
        </View>
      )}
    </View>
  );
}

/** Leading icon circle (29) + row padding (16) + gap (12): the row-text inset. */
const ROW_INSET = 16 + 29 + 12;

/**
 * Height of the search pill AND the account avatar circle beside it — one shared
 * value keeps them the exact same height (Apple Maps). Trimmed to a compact,
 * un-bulky capsule matching the fresh Apple-Maps peek bar (IMG_0072). Also the
 * basis of the peek-detent height in index.tsx, so keep them in sync if changed.
 */
const SEARCH_H = 44;

/**
 * Max width of the sheet's inner column (header search row + grouped body),
 * centered inside the sheet. On a compact iPhone the sheet is narrower than this,
 * so it has no effect (width:100% wins) and the layout is edge-to-edge as before.
 * On a regular-width iPad, @expo/ui's native `.sheet` presents as a WIDE centered
 * card (there is no presentationCompactAdaptation / sizing hook in the package),
 * so without a cap the search field stretched the full card width and read as a
 * broken, half-empty bar. Capping + centering makes the content an intentional
 * column that looks assembled at both widths. (Apple Maps' iPad panel is a
 * similarly narrow docked column.)
 */
const CONTENT_MAX_WIDTH = 500;

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
    // Center the search row and cap it so it never stretches across a wide
    // (iPad) sheet card — see CONTENT_MAX_WIDTH. No-op on compact iPhone widths.
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  // iOS 26 "Liquid Glass" Apple-Maps search bar: a full-height translucent PILL
  // (GlassView) — NOT a boxy rounded rect nor the old dark opaque slab. The glass
  // is the container; a Pressable fills it and holds the centered glyph +
  // placeholder with the voice mic pinned to the trailing edge.
  searchField: {
    flex: 1,
    height: SEARCH_H,
    borderRadius: Radii.circle,
    borderCurve: 'continuous',
  },
  // Fills the glass pill; centers the glyph + "Search" group (Apple's collapsed
  // peek bar), leaving the mic free-floating on the trailing edge (absolute).
  searchPress: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
  },
  searchPlaceholder: { fontSize: 17, fontWeight: '400' },
  micButton: {
    position: 'absolute',
    right: 6,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: SEARCH_H,
    height: SEARCH_H,
    borderRadius: SEARCH_H / 2,
    borderCurve: 'continuous',
  },
  avatarPress: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  body: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    // Match the header: one centered, width-capped column so the grouped list
    // aligns with the search field on a wide iPad sheet. No-op on iPhone.
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  recentsSection: { marginTop: 22 },
});
