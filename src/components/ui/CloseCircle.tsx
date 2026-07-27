// The circular translucent grey button used across the Apple-Maps re-skin: the
// header X (IMG_0075/76/80/81), the share circle (IMG_0077), the compact
// place-bar controls (IMG_0079). One consistent circle-glyph button — pass a
// different `symbol` for share (square.and.arrow.up) or ellipsis.
//
// SIZE IS MEASURED, NOT CHOSEN. Apple's place-card close/share circles measure
// 39.3 pt across, sitting 13.7 in from the card's top and trailing edges (the
// same ~14 pt content inset the rest of the card uses). Ours was 30 — a
// deliberate deviation on the grounds that "the app already has one
// close-circle language"; the user asked for Apple's number instead, so 39 is
// now THE size for every sheet's ✕ (route sheets via SheetHeader, the tram card,
// /line, the icon preview) and there is one constant to change if it ever moves.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, useColorScheme } from 'react-native';

import { appleScheme } from '@/constants/theme';

/** Apple's measured 39.3, rounded to a whole point. */
export const CLOSE_CIRCLE_D = 39;

export interface CloseCircleProps {
  onPress: () => void;
  /** Accessibility label. */
  label?: string;
  /** SF Symbol drawn inside the circle. */
  symbol?: SFSymbol;
  /** Circle diameter. Defaults to Apple's measured 39. */
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
