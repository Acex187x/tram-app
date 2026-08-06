// Shared system-themed sheet header: title and optional subtitle, an optional
// leading action, trailing actions and one consistent close control. The
// compact variant keeps the same information in a single row.
//
// Supersedes src/components/favorites/SheetHeader.tsx (now a re-export shim).
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import { HEADER_PAD_TOP } from '@/components/maps-kit/mapSheetLayout';
import { SHEET_H_PAD } from '@/components/maps-kit/sheetLook';
import { CloseCircle } from '@/components/ui/CloseCircle';
import { appleScheme, Type } from '@/constants/theme';

export interface SheetHeaderProps {
  title: string;
  subtitle?: string;
  /** Defaults to `router.back()`. */
  onClose?: () => void;
  /** Leading control, e.g. a share CloseCircle (`symbol="square.and.arrow.up"`). */
  leading?: ReactNode;
  /** Rendered just before the trailing X (e.g. an extra circular button). */
  trailing?: ReactNode;
  /** One-line minimized header variant. */
  compact?: boolean;
}

export function SheetHeader({
  title,
  subtitle,
  onClose,
  leading,
  trailing,
  compact,
}: SheetHeaderProps) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const close = onClose ?? (() => router.back());

  if (compact) {
    return (
      <View style={styles.compactRow}>
        <View style={styles.side}>{leading}</View>
        <View style={styles.compactTitleCol}>
          <Text
            accessibilityRole="header"
            style={[styles.compactTitle, { color: c.text }]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {subtitle != null && (
            <Text
              style={[Type.footnote, styles.subtitle, { color: c.secondary }]}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          )}
        </View>
        <View style={styles.side}>
          {trailing}
          <CloseCircle onPress={close} />
        </View>
      </View>
    );
  }

  const centered = leading != null;
  return (
    <View style={styles.row}>
      {leading != null && <View style={styles.side}>{leading}</View>}
      <View style={[styles.titleCol, centered && styles.titleColCentered]}>
        <Text
          accessibilityRole="header"
          style={[Type.largeTitle, { color: c.text }, centered && styles.textCenter]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle != null && (
          <Text
            style={[Type.subhead, styles.subtitle, { color: c.secondary }, centered && styles.textCenter]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>
      <View style={styles.side}>
        {trailing}
        <CloseCircle onPress={close} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingBottom: 8,
    // Neither of these is a free number. SHEET_H_PAD is THE sheet content edge,
    // so the title starts exactly where the body's cards and section labels do;
    // HEADER_PAD_TOP is the grabber band (gap + pill + clearance), the same
    // padding the OWNED sheets put above their header row. Hard-coding 20 here
    // is what made a route sheet's title sit lower than the tram card's while
    // both drew the same pill in the same place — and, once the body settled on
    // 16, what left the title 4 pt outboard of the list under it.
    paddingHorizontal: SHEET_H_PAD,
    paddingTop: HEADER_PAD_TOP,
  },
  compactRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    // Was 16 while `row` above was 20 — the same component disagreeing with
    // itself across its two variants. Both are the one edge now.
    paddingHorizontal: SHEET_H_PAD,
    paddingTop: HEADER_PAD_TOP,
    paddingBottom: 12,
  },
  side: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  titleCol: { flex: 1, gap: 2 },
  titleColCentered: { alignItems: 'center' },
  compactTitleCol: { flex: 1, alignItems: 'center', gap: 1 },
  compactTitle: { fontSize: 17, fontWeight: '600' },
  subtitle: { marginTop: 1 },
  textCenter: { textAlign: 'center' },
});
