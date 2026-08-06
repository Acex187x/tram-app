// System-themed segmented control:
//  - `md` label row  = line-direction headsigns / Smooth-Live choice / icon packs.
//    This is the REAL UISegmentedControl (@expo/ui `segmented-control`), so the
//    selection pill slides, the labels take Dynamic Type, the drag-across-segments
//    gesture works and VoiceOver announces the segmented traits.
//  - `lg` symbol row stays hand-rolled because the native control cannot disable
//    individual segments. `appearance` may pin an already system-derived scheme;
//    otherwise the component reads the system theme directly.
// Named export (identical binding to the default one) — the default import
// shadows it and trips import/no-named-as-default.
import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { appleScheme, TextScale, Type } from '@/constants/theme';

export interface PillSegment {
  key: string;
  label?: string;
  /** VoiceOver label — required for symbol-only segments, whose `key` is a developer identifier. */
  a11yLabel?: string;
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

  // The native control renders labels only and disables as a whole, so fall back
  // to the hand-rolled capsule whenever a segment needs a symbol or its own
  // disabled state.
  const nativeCapable =
    !lg && segments.every((s) => s.label != null && s.symbol == null && s.disabled !== true);
  if (nativeCapable) {
    const selectedIndex = segments.findIndex((s) => s.key === selectedKey);
    return (
      <SegmentedControl
        values={segments.map((s) => s.label as string)}
        selectedIndex={selectedIndex < 0 ? undefined : selectedIndex}
        appearance={scheme}
        onChange={(e) => {
          const seg = segments[e.nativeEvent.selectedSegmentIndex];
          if (seg != null) onChange(seg.key);
        }}
      />
    );
  }

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
            accessibilityLabel={seg.a11yLabel ?? seg.label ?? seg.key}
            // A permanently disabled segment is decorative flavor, not a control
            // a VoiceOver user can reach — keep it visible but out of the tree.
            accessibilityElementsHidden={seg.disabled === true}
            importantForAccessibility={seg.disabled === true ? 'no-hide-descendants' : 'auto'}
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
                maxFontSizeMultiplier={TextScale.compact}
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
    // Subtle lift keeps the selected value distinct from the track.
    boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
  },
  label: { ...Type.subhead },
});
