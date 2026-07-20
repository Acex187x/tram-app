// iOS grouped-inset list kit (IMG_0075/76): rounded 22 pt glass cards, leading
// colored icon circles with a white glyph, right-aligned values, chevrons,
// blue-checkmark rows, uppercase section labels, and hairline separators.
//
// Supersedes src/components/favorites/InsetGroup.tsx (now a re-export shim):
// InsetGroup / SectionLabel / RowSeparator / InlineHint are ported verbatim so
// existing consumers keep identical behavior, and InsetRow is added.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { appleScheme, Apple, Colors, Radii } from '@/constants/theme';

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
        backgroundColor: Apple.separator[scheme],
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

export interface InsetRowProps {
  /** SF Symbol drawn as a white glyph on a colored circle (see `iconTint`). */
  icon?: SFSymbol;
  /** Fill color of the leading icon circle. Defaults to a neutral grey. */
  iconTint?: string;
  /** Custom leading node (e.g. a <LineBadge/>) instead of the symbol circle. */
  iconNode?: ReactNode;
  title: string;
  subtitle?: string;
  /** Right-aligned grey value, e.g. 'Driving', '09:00–21:00'. */
  value?: string;
  valueTint?: string;
  chevron?: boolean;
  onPress?: () => void;
  /** Trailing node — a Switch, ellipsis button, ETA countdown, etc. */
  trailing?: ReactNode;
  /** Renders the title in red. */
  destructive?: boolean;
  /** Blue-checkmark selected row (IMG_0076 Preferences). */
  checked?: boolean;
}

/** ICON_CIRCLE — leading colored circle diameter (Apple settings/reports rows). */
const ICON_CIRCLE = 29;

export function InsetRow({
  icon,
  iconTint,
  iconNode,
  title,
  subtitle,
  value,
  valueTint,
  chevron,
  onPress,
  trailing,
  destructive,
  checked,
}: InsetRowProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const titleColor = destructive ? Apple.red : c.text;

  const body = (
    <>
      {iconNode != null ? (
        <View style={styles.leading}>{iconNode}</View>
      ) : icon != null ? (
        <View
          style={[
            styles.iconCircle,
            { backgroundColor: iconTint ?? (scheme === 'dark' ? '#48484A' : '#8E8E93') },
          ]}
        >
          <SymbolView name={icon} size={16} weight="semibold" tintColor="#FFFFFF" />
        </View>
      ) : null}
      <View style={styles.rowTextCol}>
        <Text style={[styles.rowTitle, { color: titleColor }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle != null && (
          <Text style={[styles.rowSubtitle, { color: c.secondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {value != null && (
        <Text style={[styles.rowValue, { color: valueTint ?? c.secondary }]} numberOfLines={1}>
          {value}
        </Text>
      )}
      {trailing}
      {checked && <SymbolView name="checkmark" size={16} weight="semibold" tintColor={Apple.blue} />}
      {chevron && (
        <SymbolView name="chevron.right" size={13} weight="semibold" tintColor={c.secondary} />
      )}
    </>
  );

  if (onPress == null) {
    return <View style={styles.row}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
    borderRadius: Radii.group,
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

  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  rowPressed: { opacity: 0.55 },
  leading: { alignItems: 'center', justifyContent: 'center' },
  iconCircle: {
    width: ICON_CIRCLE,
    height: ICON_CIRCLE,
    borderRadius: ICON_CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTextCol: { flex: 1, gap: 1 },
  rowTitle: { fontSize: 17, fontWeight: '400' },
  rowSubtitle: { fontSize: 13, fontWeight: '400' },
  rowValue: { fontSize: 16, fontWeight: '400', flexShrink: 0 },
});
