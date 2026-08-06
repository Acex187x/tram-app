// Tram Spotter's compact map-console header. The collapsed sheet identifies the
// product and its primary action instead of imitating a generic Maps search bar.
// Every color follows the system appearance; basemap lighting is independent.
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { SEARCH_H } from '@/components/maps-kit/mapSheetLayout';
import { appleScheme, Radii, TextScale, Tram } from '@/constants/theme';
import { SETTINGS_D, SHEET_H_PAD } from '@/components/home/homeMetrics';

export function HomeSearchRow() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const fieldBg = scheme === 'dark' ? 'rgba(118,118,128,0.28)' : 'rgba(118,118,128,0.16)';

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search lines, trams and stops"
        accessibilityHint="Opens search"
        onPress={() => router.push('/search')}
        style={({ pressed }) => [
          styles.field,
          { backgroundColor: fieldBg, opacity: pressed ? 0.65 : 1 },
        ]}
      >
        <View style={styles.brandMark}>
          <SymbolView name="tram.fill" size={16} weight="semibold" tintColor="#FFFFFF" />
        </View>
        <View style={styles.brandCopy}>
          <Text style={[styles.brandTitle, { color: c.text }]} numberOfLines={1}>
            Tram Spotter
          </Text>
          <Text
            style={[styles.brandAction, { color: c.secondary }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.compact}
          >
            Search fleet & stops
          </Text>
        </View>
        <SymbolView name="magnifyingglass" size={16} weight="semibold" tintColor={c.text} />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        style={({ pressed }) => [
          styles.settings,
          { backgroundColor: fieldBg, opacity: pressed ? 0.65 : 1 },
        ]}
      >
        <SymbolView name="gearshape.fill" size={18} tintColor={c.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: SHEET_H_PAD,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: SEARCH_H,
    paddingHorizontal: 7,
    paddingRight: 12,
    borderCurve: 'continuous',
    borderRadius: Radii.field,
  },
  brandMark: {
    alignItems: 'center',
    backgroundColor: Tram.pidRed,
    borderCurve: 'continuous',
    borderRadius: 9,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  brandCopy: { flex: 1, gap: 0 },
  brandTitle: { fontSize: 13, fontWeight: '700', letterSpacing: -0.1 },
  brandAction: { fontSize: 11.5, fontWeight: '500' },
  settings: {
    width: SETTINGS_D,
    height: SETTINGS_D,
    borderCurve: 'continuous',
    borderRadius: Radii.field,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
