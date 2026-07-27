// PID line number badge — red square with rounded corners (dark blue for night lines 91–99).
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Fonts, TextScale, Tram } from '@/constants/theme';

const SIZES = { sm: 22, md: 30, lg: 42 } as const;

export function isNightLine(line: string): boolean {
  const n = Number(line);
  return n >= 90 && n <= 99;
}

export interface LineBadgeProps {
  line: string;
  size?: keyof typeof SIZES;
  style?: StyleProp<ViewStyle>;
}

export function LineBadge({ line, size = 'md', style }: LineBadgeProps) {
  const s = SIZES[size];
  return (
    <View
      style={[
        styles.badge,
        {
          minWidth: s,
          height: s,
          borderRadius: s * 0.28,
          backgroundColor: isNightLine(line) ? Tram.night : Tram.pidRed,
        },
        style,
      ]}
    >
      <Text style={[styles.text, { fontSize: s * 0.55 }]} maxFontSizeMultiplier={TextScale.badge}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  text: {
    color: '#FFFFFF',
    fontFamily: Fonts?.rounded,
    fontWeight: '700',
  },
});
