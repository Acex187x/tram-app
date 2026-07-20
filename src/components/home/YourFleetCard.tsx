// The "Your Fleet" guides-style card on the home sheet (IMG_0073 "Your Guides"
// Favorites card): a big rounded artwork tile with a gold star and a live count
// of favorited trams + lines, opening /favorites. Lives inside the home sheet,
// so it follows the system scheme.
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { appleScheme, Radii, Tram } from '@/constants/theme';
import { useFavoritesStore } from '@/stores/favorites';

export function YourFleetCard() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const trams = useFavoritesStore((s) => s.favoriteTrams.length);
  const lines = useFavoritesStore((s) => s.favoriteLines.length);

  const total = trams + lines;
  const subtitle =
    total === 0
      ? 'No favorites yet'
      : [
          trams > 0 ? `${trams} ${trams === 1 ? 'tram' : 'trams'}` : null,
          lines > 0 ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  const artBg = scheme === 'dark' ? '#2A2A2C' : '#E7E7EC';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Your Fleet, ${subtitle}`}
      onPress={() => router.push('/favorites')}
      style={({ pressed }) => [styles.card, { opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={[styles.art, { backgroundColor: artBg }]}>
        <SymbolView name="star.fill" size={64} tintColor={Tram.gold} />
      </View>
      <View style={styles.meta}>
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1} allowFontScaling={false}>
          Your Fleet
        </Text>
        <Text style={[styles.subtitle, { color: c.secondary }]} numberOfLines={1} allowFontScaling={false}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: 180 },
  art: {
    height: 150,
    borderRadius: Radii.card,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: { marginTop: 8, paddingHorizontal: 2 },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 14, fontWeight: '400', marginTop: 1 },
});
