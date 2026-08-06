// Shared translucent circle-glyph control for close, share and overflow actions.
// One exported size keeps route sheets, the tram card and previews consistent.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, useColorScheme } from 'react-native';

import { appleScheme } from '@/constants/theme';

/** Shared circle diameter with a comfortable touch target via hitSlop. */
export const CLOSE_CIRCLE_D = 39;

export interface CloseCircleProps {
  onPress: () => void;
  /** Accessibility label. */
  label?: string;
  /** SF Symbol drawn inside the circle. */
  symbol?: SFSymbol;
  /** Circle diameter. Defaults to the shared 39 pt size. */
  size?: number;
}

export function CloseCircle({
  onPress,
  label = 'Close',
  symbol = 'xmark',
  size = CLOSE_CIRCLE_D,
}: CloseCircleProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.fillTertiary,
          opacity: pressed ? 0.55 : 1,
        },
      ]}
    >
      <SymbolView
        name={symbol}
        size={Math.round(size * 0.42)}
        weight="semibold"
        tintColor={c.secondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
});

// Re-export the glyph type so screen code can annotate `symbol` props.
export type { SFSymbol };
