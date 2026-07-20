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
import { InsetGroup, InsetRow, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { appleScheme, Apple, Radii, Tram } from '@/constants/theme';
import { useFavoritesStore } from '@/stores/favorites';
import { usePlannerStore } from '@/stores/planner';

// ── Pinned header: search field + settings avatar ───────────────────────────

export function HomeSheetHeader() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const avatarBg = scheme === 'dark' ? Apple.fillTertiary.dark : Apple.fillTertiary.light;
  const fieldBg = scheme === 'dark' ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)';

  return (
    <View style={styles.header}>
      {/* Fresh Apple-Maps peek bar (IMG_0072/0074): search glyph · placeholder ·
          microphone inside one translucent rounded field, with a circular
          account/settings button alongside. Tapping anywhere in the field (or
          the mic) opens our existing /search sheet — data flow unchanged. */}
      <Pressable
        accessibilityRole="search"
        accessibilityLabel="Search lines, trams and stops"
        onPress={() => router.push('/search')}
        style={({ pressed }) => [
          styles.searchField,
          { backgroundColor: fieldBg, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <SymbolView name="magnifyingglass" size={18} weight="semibold" tintColor={c.secondary} />
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        style={({ pressed }) => [styles.avatar, { backgroundColor: avatarBg, opacity: pressed ? 0.7 : 1 }]}
      >
        <SymbolView name="gearshape.fill" size={19} tintColor={c.text} />
      </Pressable>
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

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
  },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 46,
    borderRadius: Radii.field,
    borderCurve: 'continuous',
    paddingLeft: 12,
    paddingRight: 6,
  },
  searchPlaceholder: { fontSize: 17, flex: 1 },
  micButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },

  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  recentsSection: { marginTop: 22 },
});
