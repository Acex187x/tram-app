// Delay indicator: green ≤60s, amber ≤180s, red beyond; shows early state too.
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Tram } from '@/constants/theme';

export function delayColor(delaySeconds: number): string {
  if (delaySeconds <= 60) return Tram.onTime;
  if (delaySeconds <= 180) return Tram.late;
  return Tram.veryLate;
}

export function delayLabel(delaySeconds: number): string {
  if (delaySeconds < -30) return `${Math.round(-delaySeconds / 60)} min early`;
  if (delaySeconds <= 60) return 'on time';
  return `+${Math.round(delaySeconds / 60)} min`;
}

export interface DelayPillProps {
  delaySeconds: number;
  /**
   * 'sm' (default) — compact inline pill for lists/sheets.
   * 'md' — 30 pt control-row pill matching the map chip element height
   * (line badge md / follow button / chip close).
   */
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
}

export function DelayPill({ delaySeconds, size = 'sm', style }: DelayPillProps) {
  return (
    <View
      style={[
        styles.pill,
        size === 'md' && styles.pillMd,
        { backgroundColor: delayColor(delaySeconds) },
        style,
      ]}
    >
      <Text
        style={[styles.text, size === 'md' && styles.textMd]}
        allowFontScaling={false}
      >
        {delayLabel(delaySeconds)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  pillMd: {
    alignSelf: 'center',
    height: 30,
    paddingVertical: 0,
    paddingHorizontal: 11,
    justifyContent: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  textMd: {
    fontSize: 13,
  },
});
