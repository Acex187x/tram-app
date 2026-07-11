// "About this tram" card: fleet-model spec sheet (manufacturer, years, size,
// top speed), low-floor + amenity badges sourced from the live snapshot, and
// the model's fun fact as an italic footer. iOS grouped-list styling.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import { TramModelImage, tramModelImageSource } from '@/components/tram/TramModelImage';
import { Colors, Tram } from '@/constants/theme';
import type { TramModelSpec, TramSnapshot } from '@/lib/types';

export interface AboutTramCardProps {
  model: TramModelSpec;
  snapshot: TramSnapshot;
}

interface SpecRowProps {
  icon: SFSymbol;
  label: string;
  value: string;
  isLast?: boolean;
}

function SpecRow({ icon, label, value, isLast }: SpecRowProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const separator = scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
  return (
    <View style={[styles.specRow, !isLast && { borderBottomColor: separator, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <SymbolView name={icon} size={16} tintColor={c.textSecondary} style={styles.specIcon} />
      <Text style={[styles.specLabel, { color: c.textSecondary }]}>{label}</Text>
      <Text style={[styles.specValue, { color: c.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

interface AmenityChipProps {
  icon: SFSymbol;
  label: string;
  /** true = present, false = absent, null = unknown (rendered muted). */
  active: boolean | null;
}

function AmenityChip({ icon, label, active }: AmenityChipProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const fill = scheme === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.05)';
  const on = active === true;
  return (
    <View style={[styles.chip, { backgroundColor: fill, opacity: on ? 1 : 0.35 }]}>
      <SymbolView name={icon} size={13} tintColor={on ? c.text : c.textSecondary} />
      <Text style={[styles.chipText, { color: on ? c.text : c.textSecondary }]} allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}

export function AboutTramCard({ model, snapshot }: AboutTramCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const cardFill = scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.55)';
  const separator = scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';

  const sectionsLabel =
    model.sections.length === 1 ? 'single body' : `${model.sections.length} sections`;

  return (
    <View style={[styles.card, { backgroundColor: cardFill }]}>
      {tramModelImageSource(model.id) != null && (
        <View style={[styles.illustrationWrap, { borderBottomColor: separator }]}>
          <TramModelImage modelId={model.id} height={110} style={styles.illustration} />
        </View>
      )}
      <SpecRow icon="building.2" label="Manufacturer" value={model.manufacturer} />
      <SpecRow icon="calendar" label="Built" value={model.yearsBuilt} />
      <SpecRow
        icon="ruler"
        label="Size"
        value={`${model.totalLengthM} m × ${model.widthM} m · ${sectionsLabel}`}
      />
      <SpecRow icon="speedometer" label="Top speed" value={`${model.maxSpeedKmh} km/h`} isLast />

      <View style={[styles.badgesRow, { borderTopColor: separator }]}>
        <View
          style={[
            styles.chip,
            {
              backgroundColor: model.lowFloor
                ? scheme === 'dark'
                  ? 'rgba(46,139,87,0.28)'
                  : 'rgba(46,139,87,0.16)'
                : scheme === 'dark'
                  ? 'rgba(255,255,255,0.09)'
                  : 'rgba(0,0,0,0.05)',
            },
          ]}
        >
          <SymbolView
            name={model.lowFloor ? 'arrow.down.to.line' : 'stairs'}
            size={13}
            tintColor={model.lowFloor ? Tram.onTime : c.textSecondary}
          />
          <Text
            style={[styles.chipText, { color: model.lowFloor ? Tram.onTime : c.textSecondary }]}
            allowFontScaling={false}
          >
            {model.lowFloor ? 'Low floor' : 'High floor'}
          </Text>
        </View>
        <AmenityChip icon="snowflake" label="AC" active={snapshot.airConditioned} />
        <AmenityChip icon="powerplug.fill" label="USB" active={snapshot.usbChargers} />
        <AmenityChip icon="figure.roll" label="Access" active={snapshot.wheelchairAccessible} />
      </View>

      <View style={[styles.funFactRow, { borderTopColor: separator }]}>
        <Text style={[styles.funFact, { color: c.textSecondary }]}>{model.funFact}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: 16,
    paddingHorizontal: 14,
  },
  illustrationWrap: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
  },
  illustration: {
    maxWidth: '100%',
  },
  specRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: 42,
    paddingVertical: 8,
  },
  specIcon: { width: 20 },
  specLabel: { fontSize: 14 },
  specValue: { flex: 1, fontSize: 14, fontWeight: '500', textAlign: 'right' },
  badgesRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 12,
  },
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  chipText: { fontSize: 12, fontWeight: '600' },
  funFactRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
  },
  funFact: {
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 18,
  },
});
