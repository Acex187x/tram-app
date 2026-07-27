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
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { appleScheme, Apple, Colors, Radii } from '@/constants/theme';

/**
 * A grouped-inset card. Deliberately a STANDARD translucent fill, not Liquid
 * Glass: these cards live on surfaces that are themselves glass (the home sheet,
 * every form sheet), and HIG is explicit that Liquid Glass belongs to the
 * floating functional layer, not the content layer — stacking glass on glass
 * both muddies the hierarchy and rendered as a heavy opaque-white slab that
 * fought the sheet it sat on. A plain fill lets the sheet's own material (and
 * the map through it) read behind the rows.
 */
export function InsetGroup({
  children,
  style,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const fill = scheme === 'dark' ? 'rgba(118,118,128,0.24)' : 'rgba(255,255,255,0.55)';
  return <View style={[styles.group, { backgroundColor: fill }, style]}>{children}</View>;
}

/**
 * An uppercase section caption sitting on the sheet's content edge.
 *
 * `trailing` is an OPTIONAL right-hand slot on the same baseline — the tram
 * card hangs its trip delay pill and the position-freshness chip there, so a
 * section's live metadata rides its own heading instead of eating a dedicated
 * stats row above the content. Without it the component renders EXACTLY as it
 * always did (one Text, `accessibilityRole="header"`, marginBottom 8), which is
 * what keeps every existing screen byte-identical.
 *
 * The trailing node is deliberately OUTSIDE the header Text, so VoiceOver reads
 * the heading and the metadata as two elements rather than concatenating a
 * ticking value into a heading (which would re-announce on every 1 Hz tick).
 */
export function SectionLabel({ children, trailing }: { children: string; trailing?: ReactNode }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const color = Colors[scheme].textSecondary;

  if (trailing == null) {
    return (
      <Text accessibilityRole="header" style={[styles.sectionLabel, { color }]}>
        {children.toUpperCase()}
      </Text>
    );
  }
  return (
    <View style={styles.sectionRow}>
      {/* The LABEL is the shrinking element: the trailing meta is fixed-width
          data and must never wrap or truncate. */}
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[styles.sectionLabelText, styles.sectionLabelShrink, { color }]}
      >
        {children.toUpperCase()}
      </Text>
      <View style={styles.sectionSpacer} />
      {trailing}
    </View>
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
  /**
   * VoiceOver label for the whole row. A pressable row is ONE accessibility
   * element, so `trailing`/`iconNode` content is unreachable — pass the full
   * sentence here when the row carries data the title/subtitle/value can't.
   * Defaults to `title, subtitle, value`.
   */
  label?: string;
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
  /**
   * VoiceOver custom actions for interactive `trailing` content (an ellipsis
   * menu, etc.). The row is one accessibility element, so a nested Pressable is
   * unreachable by VoiceOver — expose its action through the rotor here.
   */
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
}

/** ICON_CIRCLE — leading colored circle diameter (Apple settings/reports rows). */
const ICON_CIRCLE = 29;

export function InsetRow({
  icon,
  iconTint,
  iconNode,
  title,
  label,
  subtitle,
  value,
  valueTint,
  chevron,
  onPress,
  trailing,
  destructive,
  checked,
  accessibilityActions,
  onAccessibilityAction,
}: InsetRowProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const titleColor = destructive ? c.red : c.text;

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
      {checked && <SymbolView name="checkmark" size={16} weight="semibold" tintColor={c.blue} />}
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
      accessibilityLabel={label ?? [title, subtitle, value].filter(Boolean).join(', ')}
      accessibilityState={{ selected: checked === true }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fillHighlight }]}
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
  // The label's OWN typography and left edge, shared by both paths so the
  // trailing-slot variant cannot drift from the plain one.
  sectionLabelText: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.6,
    marginLeft: 0,
  },
  // `minWidth: 0` is load-bearing, not decoration. A flex item's automatic
  // minimum size is its MIN-CONTENT width (the longest word), so without this
  // the heading stops shrinking at "UPCOMING" and the overflow lands on the
  // trailing meta instead — measured at Dynamic Type XXXL, where the delay pill
  // clipped to "5 min ea" and the freshness chip to "4 r". The data must never
  // be the thing that truncates; the heading must.
  sectionLabelShrink: { flexShrink: 1, minWidth: 0 },
  sectionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  sectionSpacer: { flex: 1 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.6,
    marginBottom: 8,
    // NO extra indent. The label sits on the sheet's content edge, which is the
    // same edge as the InsetGroup card (or the bare list) it labels and as the
    // sheet header's title above it — one left edge for every top-level element.
    //
    // It used to carry marginLeft 16, which put it 16 pt inboard of the card it
    // captions and left it aligned with nothing on the tram card: measured
    // there at card + 37 against the timeline's rows at card + 22 and the
    // header at card + 14. UIKit's insetGrouped tables DO indent their section
    // headers that way (iOS 26 Settings: card 20.00, "Vision" 36.67), but the
    // reference for these sheets is Apple Maps' place card, where the headings
    // sit essentially ON the rail they caption — "About" at 20.67 and "Ratings
    // & Guides" at 21.33 against a photo/button rail at 16.00.
    marginLeft: 0,
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
    fontSize: 15,
    lineHeight: 20,
  },

  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
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
