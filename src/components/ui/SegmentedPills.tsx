// Apple's dark capsule segmented control with a lighter selected pill:
//  - `lg` symbol row = the Directions transport-mode selector (IMG_0080)
//  - `md` label row  = line-direction headsigns / Smooth-Live choice
// Follows the map light preset when `appearance` is passed (it floats over the
// map in Directions), else the system scheme inside a sheet.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { appleScheme } from '@/constants/theme';

export interface PillSegment {
  key: string;
  label?: string;
  symbol?: SFSymbol;
  disabled?: boolean;
}

export interface SegmentedPillsProps {
  segments: PillSegment[];
  selectedKey: string;
  onChange: (key: string) => void;
  appearance?: 'light' | 'dark';
  /** `lg` = 56 pt Directions-mode row; `md` (default) = 34 pt label row. */
  size?: 'md' | 'lg';
}

export function SegmentedPills({
  segments,
  selectedKey,
  onChange,
  appearance,
  size = 'md',
}: SegmentedPillsProps) {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const scheme = appearance ?? system;
  const c = appleScheme(scheme);
  const lg = size === 'lg';
  const height = lg ? 56 : 34;
  const trackRadius = height / 2;
  const pillRadius = (height - 6) / 2;
  const selectedBg = scheme === 'dark' ? '#68686E' : '#FFFFFF';

  return (
    <View
      style={[
        styles.track,
        { height, borderRadius: trackRadius, backgroundColor: c.fillTertiary },
      ]}
    >
      {segments.map((seg) => {
        const selected = seg.key === selectedKey;
        const fg = seg.disabled
          ? scheme === 'dark'
            ? 'rgba(235,235,245,0.28)'
            : 'rgba(60,60,67,0.28)'
          : selected
            ? scheme === 'dark'
              ? '#FFFFFF'
              : '#000000'
            : c.secondary;
        return (
          <Pressable
            key={seg.key}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: seg.disabled }}
            accessibilityLabel={seg.label ?? seg.key}
            disabled={seg.disabled}
            onPress={() => onChange(seg.key)}
            style={[
              styles.segment,
              { borderRadius: pillRadius },
              selected && [styles.selected, { backgroundColor: selectedBg }],
            ]}
          >
            {seg.symbol != null && (
              <SymbolView
                name={seg.symbol}
                size={lg ? 22 : 15}
                weight={selected ? 'semibold' : 'regular'}
                tintColor={fg}
              />
            )}
            {seg.label != null && (
              <Text
                style={[styles.label, { color: fg, fontWeight: selected ? '600' : '400' }]}
                numberOfLines={1}
                allowFontScaling={false}
              >
                {seg.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    alignItems: 'stretch',
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  selected: {
    // Subtle lift on the selected pill (Apple's segmented shadow).
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  label: { fontSize: 15 },
});
