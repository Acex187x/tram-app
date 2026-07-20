// The big green rounded-square GO button on Directions result cards (IMG_0080).
// Selects the itinerary (the consumer wires the existing store/close/fit handoff).
import { StyleSheet, Text, Pressable } from 'react-native';

import { Apple, Fonts } from '@/constants/theme';

export interface GoButtonProps {
  onPress: () => void;
  /** Defaults to 'GO'. */
  label?: string;
  disabled?: boolean;
  /** Square side length. */
  size?: number;
}

export function GoButton({ onPress, label = 'GO', disabled, size = 88 }: GoButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
          backgroundColor: Apple.goGreen,
          opacity: disabled ? 0.4 : pressed ? 0.82 : 1,
        },
      ]}
    >
      <Text style={[styles.label, { fontSize: Math.round(size * 0.26) }]} allowFontScaling={false}>
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
