// "About this tram" — the Apple Maps grouped-inset spec block for the tram
// card (the "Good to Know" / spec-sheet region of a place detail, IMG_0078).
// A tappable model illustration ("View in 3D" → full-screen viewer), a grouped
// inset list of the fleet-model spec sheet (manufacturer, years, size, top
// speed), the low-floor + per-vehicle amenity badges sourced from the live
// snapshot, and the model's fun fact as an italic footer.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import { ModelPreviewButton } from '@/components/model/ModelPreviewButton';
import { tramModelImageSource } from '@/components/tram/TramModelImage';
import { InsetGroup, InsetRow, RowSeparator } from '@/components/ui/Inset';
import { appleScheme, Tram } from '@/constants/theme';
import type { TramModelSpec, TramSnapshot } from '@/lib/types';

export interface AboutTramCardProps {
  model: TramModelSpec;
  snapshot: TramSnapshot;
}

interface AmenityChipProps {
  icon: SFSymbol;
  label: string;
  /** true = present, false = absent, null = unknown (rendered muted). */
  active: boolean | null;
}

function AmenityChip({ icon, label, active }: AmenityChipProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const fill = c.fillTertiary;
  const on = active === true;
  return (
    <View style={[styles.chip, { backgroundColor: fill, opacity: on ? 1 : 0.4 }]}>
      <SymbolView name={icon} size={13} weight="semibold" tintColor={on ? c.text : c.secondary} />
      <Text style={[styles.chipText, { color: on ? c.text : c.secondary }]} allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}

export function AboutTramCard({ model, snapshot }: AboutTramCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const sectionsLabel =
    model.sections.length === 1 ? 'single body' : `${model.sections.length} sections`;

  return (
    <View style={styles.wrap}>
      {tramModelImageSource(model.id) != null && (
        <ModelPreviewButton modelId={model.id} height={112} style={styles.illustration} />
      )}

      <InsetGroup>
        <InsetRow title="Manufacturer" value={model.manufacturer} />
        <RowSeparator />
        <InsetRow title="Built" value={model.yearsBuilt} />
        <RowSeparator />
        <InsetRow
          title="Size"
          value={`${model.totalLengthM} m × ${model.widthM} m · ${sectionsLabel}`}
        />
        <RowSeparator />
        <InsetRow title="Top speed" value={`${model.maxSpeedKmh} km/h`} />
      </InsetGroup>

      <View style={styles.badgesRow}>
        <View
          style={[
            styles.chip,
            {
              backgroundColor: model.lowFloor
                ? scheme === 'dark'
                  ? 'rgba(48,209,88,0.24)'
                  : 'rgba(46,139,87,0.16)'
                : c.fillTertiary,
            },
          ]}
        >
          <SymbolView
            name={model.lowFloor ? 'arrow.down.to.line' : 'stairs'}
            size={13}
            weight="semibold"
            tintColor={model.lowFloor ? Tram.onTime : c.secondary}
          />
          <Text
            style={[styles.chipText, { color: model.lowFloor ? Tram.onTime : c.secondary }]}
            allowFontScaling={false}
          >
            {model.lowFloor ? 'Low floor' : 'High floor'}
          </Text>
        </View>
        <AmenityChip icon="snowflake" label="AC" active={snapshot.airConditioned} />
        <AmenityChip icon="powerplug.fill" label="USB" active={snapshot.usbChargers} />
        <AmenityChip icon="figure.roll" label="Access" active={snapshot.wheelchairAccessible} />
      </View>

      <Text style={[styles.funFact, { color: c.secondary }]}>{model.funFact}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  illustration: {
    alignSelf: 'center',
    maxWidth: '100%',
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 4,
  },
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: { fontSize: 12, fontWeight: '600' },
  funFact: {
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 18,
    paddingHorizontal: 4,
  },
});
