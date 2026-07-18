// Compact "About this tram" row at the bottom of the tram sheet — a second,
// discoverable door to the model reference screen (/model-info/[id]) beyond
// the header capsule's About segment. Carries the per-VEHICLE amenity flags
// (AC / USB / wheelchair access from the live snapshot) as trailing mini-icons,
// since the per-model reference screen cannot know them.
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { TramFace } from '@/components/tram/TramFace';
import { AC_TINT } from '@/components/tram/TramModelImage';
import { Colors } from '@/constants/theme';
import type { TramModelSpec, TramSnapshot } from '@/lib/types';

export interface AboutTramRowProps {
  model: TramModelSpec;
  snapshot: TramSnapshot;
  onPress: () => void;
}

export function AboutTramRow({ model, snapshot, onPress }: AboutTramRowProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const cardFill = scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.55)';

  const amenities: string[] = [];
  if (snapshot.airConditioned === true) amenities.push('air conditioned');
  if (snapshot.usbChargers === true) amenities.push('USB chargers');
  if (snapshot.wheelchairAccessible) amenities.push('wheelchair accessible');

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: cardFill },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`About this tram, ${model.name}${
        amenities.length > 0 ? `, ${amenities.join(', ')}` : ''
      }`}
    >
      <TramFace modelId={model.id} size={28} />
      <View style={styles.textCol}>
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          About this tram
        </Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={1}>
          {model.name} · specs & history
        </Text>
      </View>
      <View style={styles.amenities}>
        {snapshot.airConditioned === true && (
          <SymbolView name="snowflake" size={12} tintColor={AC_TINT} />
        )}
        {snapshot.usbChargers === true && (
          <SymbolView name="powerplug.fill" size={12} tintColor={c.textSecondary} />
        )}
        {snapshot.wheelchairAccessible && (
          <SymbolView name="figure.roll" size={12} tintColor={c.textSecondary} />
        )}
      </View>
      <SymbolView name="chevron.right" size={13} tintColor={c.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pressed: { opacity: 0.7 },
  textCol: { flex: 1, gap: 1 },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 12 },
  amenities: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
});
