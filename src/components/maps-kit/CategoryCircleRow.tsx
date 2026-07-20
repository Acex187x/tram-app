// The 'Places' row of big colored circular category buttons from the Apple Maps
// home sheet (IMG_0072/73): a white SF-symbol on a 60 pt colored circle, a bold
// label, and an optional (blue "Add" / grey "Nearby") sublabel underneath. The
// home sheet uses it for Favorites / Plan Route / Fleet / Rides.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { appleScheme } from '@/constants/theme';

export interface CategoryItem {
  key: string;
  symbol: SFSymbol;
  label: string;
  sublabel?: string;
  sublabelTint?: string;
  /** Circle fill color. */
  tint: string;
  onPress: () => void;
}

/** Circle diameter. */
const CIRCLE = 60;

export function CategoryCircleRow({ items }: { items: CategoryItem[] }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <View style={styles.row}>
      {items.map((it) => (
        <Pressable
          key={it.key}
          accessibilityRole="button"
          accessibilityLabel={it.sublabel ? `${it.label}, ${it.sublabel}` : it.label}
          onPress={it.onPress}
          style={({ pressed }) => [styles.item, { opacity: pressed ? 0.65 : 1 }]}
        >
          <View style={[styles.circle, { backgroundColor: it.tint }]}>
            <SymbolView name={it.symbol} size={28} weight="semibold" tintColor="#FFFFFF" />
          </View>
          <Text style={[styles.label, { color: c.text }]} numberOfLines={1} allowFontScaling={false}>
            {it.label}
          </Text>
          {it.sublabel != null && (
            <Text
              style={[styles.sublabel, { color: it.sublabelTint ?? c.secondary }]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {it.sublabel}
            </Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  item: { flex: 1, alignItems: 'center', gap: 6 },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 13, fontWeight: '600', maxWidth: '100%' },
  sublabel: { fontSize: 13, fontWeight: '400', marginTop: -2 },
});
