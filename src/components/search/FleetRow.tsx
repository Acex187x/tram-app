// One fleet-browser row. Memoized: all display props are primitives
// (FleetRowData) and the press callback is key-based + stable, so the 1 Hz
// states refresh re-renders a row only when a value it shows actually changed
// (in practice the ticking updated-age). Kept deliberately cheap — plain Views,
// no glass — because up to a page of these re-renders every second.
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AcSnowflake, TramModelImage, tramModelImageSource } from '@/components/tram/TramModelImage';
import { DelayPill } from '@/components/ui/DelayPill';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Fonts, Spacing } from '@/constants/theme';

import type { FleetRowData } from './fleetFilter';

export interface FleetRowProps extends FleetRowData {
  dark: boolean;
  onPress: (tramKey: string) => void;
}

function FleetRowInner(props: FleetRowProps) {
  const c = Colors[props.dark ? 'dark' : 'light'];
  // Defensive: MODEL_IMAGES may miss an entry — the line badge takes the
  // illustration's slot so the row never renders an empty hole.
  const hasFace = tramModelImageSource(props.modelId) != null;

  return (
    <Pressable
      onPress={() => props.onPress(props.tramKey)}
      accessibilityRole="button"
      accessibilityLabel={`Tram ${props.tramKey}, line ${props.line}, ${props.modelShort}, ${props.status}`}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: props.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' },
      ]}
    >
      <View style={styles.leading}>
        {hasFace ? (
          <TramModelImage modelId={props.modelId} height={34} />
        ) : (
          <LineBadge line={props.line} size="md" />
        )}
      </View>

      <View style={styles.idCol}>
        {hasFace && <LineBadge line={props.line} size="sm" />}
        <Text
          numberOfLines={1}
          allowFontScaling={false}
          style={[styles.reg, { color: c.textSecondary }]}
        >
          {props.reg}
        </Text>
      </View>

      <View style={styles.body}>
        <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>
          {props.modelShort}
          {props.headsign ? ` · ${props.headsign}` : ''}
        </Text>
        <Text numberOfLines={1} style={[styles.status, { color: c.textSecondary }]}>
          {props.status}
        </Text>
      </View>

      <View style={styles.trailing}>
        <Text allowFontScaling={false} style={[styles.speed, { color: c.text }]}>
          {props.speedText ?? '—'}
        </Text>
        <DelayPill delaySeconds={props.delaySeconds} style={styles.delay} />
        <View style={styles.metaRow}>
          <AcSnowflake airConditioned={props.airConditioned} size={10} />
          <Text allowFontScaling={false} style={[styles.age, { color: c.textSecondary }]}>
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
    gap: Spacing.two + 2,
    minHeight: 68,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  leading: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  idCol: {
    width: 52,
    alignItems: 'flex-start',
    gap: 2,
  },
  reg: {
    fontSize: 11,
    fontFamily: Fonts?.rounded,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600' },
  status: { fontSize: 12.5 },
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
