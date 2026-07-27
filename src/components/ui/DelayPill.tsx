// Delay indicator: green ≤60s, amber ≤180s, red beyond; shows early state too.
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { TextScale, Tram, Type } from '@/constants/theme';

export function delayColor(delaySeconds: number): string {
  if (delaySeconds <= 60) return Tram.onTime;
  if (delaySeconds <= 180) return Tram.late;
  return Tram.veryLate;
}

/**
 * Pill FILL, not the same as `delayColor`. The pill carries white text, so it
 * needs the darker variants to clear 4.5:1 — `delayColor` stays as it is for
 * its dot/glyph/coloured-text consumers, which were tuned for glance legibility
 * against the sheet and the map.
 */
function delayFill(delaySeconds: number): string {
  if (delaySeconds <= 60) return Tram.onTimeFill;
  if (delaySeconds <= 180) return Tram.lateFill;
  return Tram.veryLateFill;
}

export function delayLabel(delaySeconds: number): string {
  if (delaySeconds < -30) return `${Math.round(-delaySeconds / 60)} min early`;
  if (delaySeconds <= 60) return 'on time';
  return `+${Math.round(delaySeconds / 60)} min`;
}

export function delayA11yLabel(delaySeconds: number): string {
  if (delaySeconds < -30) return `${Math.round(-delaySeconds / 60)} minutes early`;
  if (delaySeconds <= 60) return 'on time';
  return `${Math.round(delaySeconds / 60)} minutes late`;
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
      accessible
      accessibilityRole="text"
      accessibilityLabel={delayA11yLabel(delaySeconds)}
      style={[
        styles.pill,
        size === 'md' && styles.pillMd,
        { backgroundColor: delayFill(delaySeconds) },
        style,
      ]}
    >
      <Text
        style={[styles.text, size === 'md' && styles.textMd]}
        maxFontSizeMultiplier={TextScale.chrome}
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
    minHeight: 30,
    paddingVertical: 0,
    paddingHorizontal: 11,
    justifyContent: 'center',
  },
  text: {
    ...Type.caption1,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  textMd: {
    fontSize: Type.footnote.fontSize,
  },
});
