// One fleet-browser row, Apple-Maps inset-row grammar: a leading line badge,
// a reg + model title over the live status line, and right-aligned live glyphs
// (delay pill, AC + fix age). Memoized: all display props are primitives
// (FleetRowData) and the press callback is key-based + stable, so the 1 Hz
// states refresh re-renders a row only when a value it shows actually changed
// (in practice the ticking updated-age). Kept deliberately cheap — plain Views,
// no glass — because up to a page of these re-renders every second.
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AcSnowflake, acTint } from '@/components/tram/TramModelImage';
import { DelayPill } from '@/components/ui/DelayPill';
import { LineBadge } from '@/components/ui/LineBadge';
import { appleScheme, Fonts, TabularNums, TextScale, Type } from '@/constants/theme';

import type { FleetRowData } from './fleetFilter';

export interface FleetRowProps extends FleetRowData {
  dark: boolean;
  onPress: (tramKey: string) => void;
}

function FleetRowInner(props: FleetRowProps) {
  const scheme = props.dark ? 'dark' : 'light';
  const c = appleScheme(scheme);

  return (
    <Pressable
      onPress={() => props.onPress(props.tramKey)}
      accessibilityRole="button"
      accessibilityLabel={`Tram ${props.tramKey}, line ${props.line}, ${props.modelShort}, ${props.status}${
        props.airConditioned ? ', air conditioned' : ''
      }`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fillHighlight }]}
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
        <DelayPill delaySeconds={props.delaySeconds} style={styles.delay} />
        <View style={styles.metaRow}>
          <AcSnowflake airConditioned={props.airConditioned} size={10} tint={acTint(scheme)} decorative />
          <Text
            maxFontSizeMultiplier={TextScale.compact}
            style={[styles.age, { color: c.secondary }]}
          >
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
  body: { flex: 1, gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  reg: { fontFamily: Fonts?.rounded, ...TabularNums },
  status: { fontSize: 13 },
  trailing: {
    alignItems: 'flex-end',
    gap: 3,
  },
  delay: { paddingHorizontal: 7, paddingVertical: 1 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  age: {
    ...Type.caption1,
    ...TabularNums,
  },
});
