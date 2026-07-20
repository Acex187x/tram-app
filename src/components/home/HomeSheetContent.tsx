// The home bottom sheet's pinned header + scrollable body (IMG_0072–74).
//
// HomeSheetHeader — the pinned search field ("Search lines, trams, stops",
// magnifyingglass) + a 40 pt circular settings avatar (our gear stands in for
// Apple's account bubble). Visible at every detent; tapping the field pushes
// the existing /search sheet (data flow unchanged).
//
// HomeSheetContent — revealed at medium/large: a "Places" row of big colored
// category circles (Favorites / Plan / Fleet / Rides), the "Recents" planner
// routes, and the "Your Fleet" favorites card. Lives inside the sheet, so it
// follows the system scheme (chrome over the map follows the map preset).
import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { CategoryCircleRow, type CategoryItem } from '@/components/maps-kit/CategoryCircleRow';
import { HomeRecents } from '@/components/home/HomeRecents';
import { YourFleetCard } from '@/components/home/YourFleetCard';
import { appleScheme, Apple, Radii, Tram, Type } from '@/constants/theme';
import { useFavoritesStore } from '@/stores/favorites';

// ── Pinned header: search field + settings avatar ───────────────────────────

export function HomeSheetHeader() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const avatarBg = scheme === 'dark' ? Apple.fillTertiary.dark : Apple.fillTertiary.light;

  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="search"
        accessibilityLabel="Search lines, trams and stops"
        onPress={() => router.push('/search')}
        style={({ pressed }) => [
          styles.searchField,
          { backgroundColor: Apple.fillSecondary, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <SymbolView name="magnifyingglass" size={17} weight="medium" tintColor={c.secondary} />
        <Text
          style={[styles.searchPlaceholder, { color: c.secondary }]}
          numberOfLines={1}
          allowFontScaling={false}
        >
          Search lines, trams, stops
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        style={({ pressed }) => [styles.avatar, { backgroundColor: avatarBg, opacity: pressed ? 0.7 : 1 }]}
      >
        <SymbolView name="gearshape.fill" size={20} tintColor={c.text} />
      </Pressable>
    </View>
  );
}

// ── Section header ("Places >", "Recents >") ────────────────────────────────

function SectionHeader({ title, onPress }: { title: string; onPress?: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'header'}
      disabled={onPress == null}
      onPress={onPress}
      style={styles.sectionHeader}
    >
      <Text style={[Type.largeTitle, styles.sectionTitle, { color: c.text }]} allowFontScaling={false}>
        {title}
      </Text>
      {onPress != null && (
        <SymbolView name="chevron.right" size={16} weight="bold" tintColor={c.secondary} />
      )}
    </Pressable>
  );
}

// ── Body ────────────────────────────────────────────────────────────────────

export function HomeSheetContent() {
  const favCount = useFavoritesStore((s) => s.favoriteTrams.length + s.favoriteLines.length);

  const places: CategoryItem[] = [
    {
      key: 'favorites',
      symbol: 'star.fill' as SFSymbol,
      label: 'Favorites',
      sublabel: favCount > 0 ? `${favCount} saved` : undefined,
      tint: Tram.gold,
      onPress: () => router.push('/favorites'),
    },
    {
      key: 'plan',
      symbol: 'arrow.triangle.swap' as SFSymbol,
      label: 'Plan',
      tint: Apple.blue,
      onPress: () => router.push('/planner'),
    },
    {
      key: 'fleet',
      symbol: 'tram.fill' as SFSymbol,
      label: 'Fleet',
      tint: Tram.pidRed,
      onPress: () => router.push('/search'),
    },
    {
      key: 'rides',
      symbol: 'record.circle' as SFSymbol,
      label: 'Rides',
      tint: Apple.red,
      onPress: () => router.push('/rides'),
    },
  ];

  return (
    <View style={styles.body}>
      <SectionHeader title="Places" />
      <CategoryCircleRow items={places} />

      <SectionHeader title="Recents" />
      <HomeRecents />

      <SectionHeader title="Your Fleet" onPress={() => router.push('/favorites')} />
      <YourFleetCard />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    borderRadius: Radii.field,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
  },
  searchPlaceholder: { fontSize: 17, flexShrink: 1 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },

  body: { paddingHorizontal: 16, gap: 12, paddingBottom: 8 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 12,
  },
  sectionTitle: { flexShrink: 1 },
});
