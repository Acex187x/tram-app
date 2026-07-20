// Standard formSheet-route scaffold for the Apple-Maps re-skin. The sheet IS
// the glass: a root GlassPanel fills the transparent formSheet container (see
// _layout's `contentStyle: transparent`), a SheetContent column caps width on
// iPad, and pinned header/footer slots bracket a keyboard-safe scroll body.
// Sheets follow the system color scheme (they're app UI, not map chrome).
import type { ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { SheetContent } from '@/components/ui/SheetContent';

export interface SheetSurfaceProps {
  children: ReactNode;
  /** Pinned above the scroll body (e.g. a SheetHeader). */
  header?: ReactNode;
  /** Pinned below the scroll body (e.g. a footer action bar). */
  footer?: ReactNode;
  /** Default true — wrap children in a scroll view. */
  scrollable?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export function SheetSurface({
  children,
  header,
  footer,
  scrollable = true,
  contentContainerStyle,
}: SheetSurfaceProps) {
  return (
    <GlassPanel style={styles.root}>
      <SheetContent style={styles.column}>
        {header}
        {scrollable ? (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.scroll, styles.scrollContent, contentContainerStyle]}>{children}</View>
        )}
        {footer}
      </SheetContent>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, borderRadius: 0 },
  column: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 32, gap: 18 },
});
