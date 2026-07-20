// One fleet-browser row, Apple-Maps inset-row grammar: a leading line badge,
// a reg + model title over the live status line, and right-aligned live glyphs
// (speed, delay pill, AC + fix age). Memoized: all display props are primitives
// (FleetRowData) and the press callback is key-based + stable, so the 1 Hz
// states refresh re-renders a row only when a value it shows actually changed
// (in practice the ticking updated-age). Kept deliberately cheap — plain Views,
// no glass — because up to a page of these re-renders every second.
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AcSnowflake } from '@/components/tram/TramModelImage';
import { DelayPill } from '@/components/ui/DelayPill';
import { LineBadge } from '@/components/ui/LineBadge';
import { appleScheme, Fonts } from '@/constants/theme';

import type { FleetRowData } from './fleetFilter';

export interface FleetRowProps extends FleetRowData {
  dark: boolean;
  onPress: (tramKey: string) => void;
}

function FleetRowInner(props: FleetRowProps) {
  const c = appleScheme(props.dark ? 'dark' : 'light');

  return (
    <Pressable
      onPress={() => props.onPress(props.tramKey)}
      accessibilityRole="button"
      accessibilityLabel={`Tram ${props.tramKey}, line ${props.line}, ${props.modelShort}, ${props.status}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <LineBadge line={props.line} size="md" />

      <View style={styles.body}>
        <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>
          <Text style={styles.reg}>{props.reg}</Text>
          <Text style={{ color: c.secondary }}>{`  ${props.modelShort}`}</Text>
        </Text>
        <Text numberOfLines={1} style={[styles.status, { color: c.secondary }]}>
          {props.headsign ? `${props.headsign} · ${props.status}` : props.status}
        </Text>
      </View>

      <View style={styles.trailing}>
        <Text allowFontScaling={false} style={[styles.speed, { color: c.text }]}>
          {props.speedText ?? '—'}
        </Text>
        <DelayPill delaySeconds={props.delaySeconds} style={styles.delay} />
        <View style={styles.metaRow}>
          <AcSnowflake airConditioned={props.airConditioned} size={10} />
          <Text allowFontScaling={false} style={[styles.age, { color: c.secondary }]}>
            {props.ageText}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export const FleetRow = memo(FleetRowInner);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowPressed: { opacity: 0.55 },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  reg: { fontFamily: Fonts?.rounded, fontVariant: ['tabular-nums'] },
  status: { fontSize: 13 },
  trailing: {
    alignItems: 'flex-end',
    gap: 3,
  },
  speed: {
    fontSize: 12.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  delay: { paddingHorizontal: 7, paddingVertical: 1 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  age: {
    fontSize: 10.5,
    fontVariant: ['tabular-nums'],
  },
});
