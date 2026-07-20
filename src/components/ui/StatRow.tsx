// The Hours / Rating / Accepts / Distance stat quad from Apple place cards
// (IMG_0077): a small grey caption over a value, cells equal width. The tram
// sheet renders Updated / Phase / Next stop / Delay with it, tinting a value
// green when the datum is live/fresh.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import { appleScheme } from '@/constants/theme';

export interface Stat {
  key: string;
  /** Grey caption, e.g. 'Updated'. */
  caption: string;
  /** Value, e.g. '4 s ago'. */
  value: string;
  /** Value color — green when live/fresh. */
  valueTint?: string;
  symbol?: SFSymbol;
}

export function StatTile({ stat }: { stat: Stat }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <View style={styles.tile}>
      <Text style={[styles.caption, { color: c.secondary }]} numberOfLines={1} allowFontScaling={false}>
        {stat.caption}
      </Text>
      <View style={styles.valueRow}>
        {stat.symbol != null && (
          <SymbolView name={stat.symbol} size={13} weight="semibold" tintColor={stat.valueTint ?? c.text} />
        )}
        <Text
          style={[styles.value, { color: stat.valueTint ?? c.text }]}
          numberOfLines={1}
          allowFontScaling={false}
        >
          {stat.value}
        </Text>
      </View>
    </View>
  );
}

export function StatRow({ stats }: { stats: Stat[] }) {
  return (
    <View style={styles.row}>
      {stats.map((s) => (
        <StatTile key={s.key} stat={s} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  tile: { flex: 1, alignItems: 'center', gap: 3, paddingHorizontal: 4 },
  caption: { fontSize: 13, fontWeight: '400' },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  value: { fontSize: 17, fontWeight: '600' },
});
