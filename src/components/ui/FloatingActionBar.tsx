// The floating bottom pill bar (+ / star / like / …) from Apple place cards
// (IMG_0077/78), pinned bottom-center inside a detail sheet. On the tram sheet:
// star favorite / record.circle ride / camera photos / ellipsis menu. An active
// item tints (e.g. red while a ride is recording).
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { appleScheme } from '@/constants/theme';

export interface BarItem {
  key: string;
  symbol: SFSymbol;
  /** Accessibility label. */
  label: string;
  onPress: () => void;
  active?: boolean;
  /** Tint applied when active — defaults to the primary text color. */
  tint?: string;
}

export interface FloatingActionBarProps {
  /** 3–5 items. */
  items: BarItem[];
  style?: StyleProp<ViewStyle>;
}

export function FloatingActionBar({ items, style }: FloatingActionBarProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <View pointerEvents="box-none" style={[styles.wrap, style]}>
      <GlassPanel variant="regular" interactive style={styles.bar}>
        {items.map((it) => {
          const color = it.active ? (it.tint ?? c.text) : c.text;
          return (
            <Pressable
              key={it.key}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              accessibilityState={{ selected: !!it.active }}
              hitSlop={6}
              onPress={it.onPress}
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <SymbolView
                name={it.symbol}
                size={22}
                weight={it.active ? 'semibold' : 'regular'}
                tintColor={color}
              />
            </Pressable>
          );
        })}
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
  },
  item: {
    width: 52,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.55 },
});
