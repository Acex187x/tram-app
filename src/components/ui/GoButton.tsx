// The big green rounded-square GO button on Directions result cards (IMG_0080).
// Selects the itinerary (the consumer wires the existing store/close/fit handoff).
import { StyleSheet, Text, Pressable, useColorScheme } from 'react-native';

import { appleScheme, Fonts, TextScale } from '@/constants/theme';

export interface GoButtonProps {
  onPress: () => void;
  /** Defaults to 'GO'. */
  label?: string;
  /** VoiceOver label — defaults to `label`; pass the destination for context. */
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Square side length. */
  size?: number;
}

export function GoButton({
  onPress,
  label = 'GO',
  accessibilityLabel,
  disabled,
  size = 88,
}: GoButtonProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
          backgroundColor: c.goGreen,
          opacity: disabled ? 0.4 : pressed ? 0.82 : 1,
        },
      ]}
    >
      <Text
        style={[styles.label, { fontSize: Math.round(size * 0.26) }]}
        numberOfLines={1}
        maxFontSizeMultiplier={TextScale.chrome}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  label: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontFamily: Fonts?.rounded,
    letterSpacing: 0.5,
  },
});
