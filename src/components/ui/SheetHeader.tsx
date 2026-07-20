// Apple-Maps sheet header (IMG_0075/76/80/81): a large bold title (+ optional
// secondary subtitle) on the left, a circular translucent X on the right. An
// optional leading share circle centers the title (place-card style, IMG_0077).
// The `compact` variant is the minimized place bar shown at the smallest
// tram-sheet detent (IMG_0079): [share] · title+subtitle · [X], one line.
//
// Supersedes src/components/favorites/SheetHeader.tsx (now a re-export shim).
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

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
  /** One-line minimized place-bar variant (IMG_0079). */
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
          <Text style={[styles.compactTitle, { color: c.text }]} numberOfLines={1}>
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
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  compactRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  side: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  titleCol: { flex: 1, gap: 2 },
  titleColCentered: { alignItems: 'center' },
  compactTitleCol: { flex: 1, alignItems: 'center', gap: 1 },
  compactTitle: { fontSize: 17, fontWeight: '600' },
  subtitle: { marginTop: 1 },
  textCenter: { textAlign: 'center' },
});
