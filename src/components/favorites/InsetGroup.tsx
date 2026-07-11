// iOS grouped-inset building blocks used by the favorites + settings sheets:
// a rounded glass group card, an uppercase section label, a hairline row
// separator, and a muted inline hint row (per-section empty state).
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Colors } from '@/constants/theme';

export function InsetGroup({
  children,
  style,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <GlassPanel variant="clear" style={[styles.group, style]}>
      {children}
    </GlassPanel>
  );
}

export function SectionLabel({ children }: { children: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <Text style={[styles.sectionLabel, { color: Colors[scheme].textSecondary }]}>
      {children.toUpperCase()}
    </Text>
  );
}

export function RowSeparator({ inset = 16 }: { inset?: number }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <View
      style={{
        backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)',
        height: StyleSheet.hairlineWidth,
        marginLeft: inset,
      }}
    />
  );
}

export function InlineHint({ icon, text }: { icon: SFSymbol; text: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  return (
    <View style={styles.hintRow}>
      <SymbolView name={icon} size={18} tintColor={palette.textSecondary} />
      <Text style={[styles.hintText, { color: palette.textSecondary }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
    borderRadius: 22,
    overflow: 'hidden',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 16,
  },
  hintRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  hintText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 19,
  },
});
