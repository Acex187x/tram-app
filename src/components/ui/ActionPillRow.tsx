// The equal-width action-pill row from Apple place cards (IMG_0077): the
// prominent filled blue "walk time" pill next to translucent Call / Website
// pills. Reused as Follow / Show Line / 3D Model on the tram sheet and
// Route Here / Spot / Show on Map on the stop sheet. Icon over label.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { appleScheme, Radii, TextScale } from '@/constants/theme';

export interface PillAction {
  key: string;
  symbol: SFSymbol;
  label: string;
  onPress: () => void;
  /** Filled tint pill (like the blue walk-time pill). */
  prominent?: boolean;
  /** Accent color — defaults to the scheme's system blue. */
  tint?: string;
  disabled?: boolean;
}

export interface ActionPillRowProps {
  actions: PillAction[];
  appearance?: 'light' | 'dark';
}

export function ActionPillRow({ actions, appearance }: ActionPillRowProps) {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const scheme = appearance ?? system;
  const c = appleScheme(scheme);

  return (
    <View style={styles.row}>
      {actions.map((a) => {
        const tint = a.tint ?? c.blue;
        const fg = a.prominent ? '#FFFFFF' : tint;
        const bg = a.prominent ? tint : c.fillTertiary;
        return (
          <Pressable
            key={a.key}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            accessibilityState={{ disabled: !!a.disabled }}
            disabled={a.disabled}
            onPress={a.onPress}
            style={({ pressed }) => [
              styles.pill,
              { backgroundColor: bg, opacity: a.disabled ? 0.4 : pressed ? 0.7 : 1 },
            ]}
          >
            <SymbolView name={a.symbol} size={20} weight="semibold" tintColor={fg} />
            <Text
              style={[styles.label, { color: fg }]}
              numberOfLines={1}
              maxFontSizeMultiplier={TextScale.compact}
            >
              {a.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  pill: {
    flex: 1,
    minHeight: 58,
    borderRadius: Radii.field,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  label: { fontSize: 15, fontWeight: '600' },
});
