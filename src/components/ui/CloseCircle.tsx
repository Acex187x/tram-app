// The 30 pt circular translucent grey button used across the Apple-Maps re-skin:
// the header X (IMG_0075/76/80/81), the share circle (IMG_0077), the compact
// place-bar controls (IMG_0079). One consistent squircle-glyph button — pass a
// different `symbol` for share (square.and.arrow.up) or ellipsis.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, useColorScheme } from 'react-native';

import { appleScheme } from '@/constants/theme';

export interface CloseCircleProps {
  onPress: () => void;
  /** Accessibility label. */
  label?: string;
  /** SF Symbol drawn inside the circle. */
  symbol?: SFSymbol;
  /** Circle diameter. */
  size?: number;
}

export function CloseCircle({
  onPress,
  label = 'Close',
  symbol = 'xmark',
  size = 30,
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
