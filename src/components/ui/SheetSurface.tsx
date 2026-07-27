// THE scaffold for every native `formSheet` route. One component, so that the
// list sheets (/favorites, /rides, /settings, /stop, /line), the search sheet
// and the icon preview cannot each grow their own idea of what a sheet is —
// which is exactly how /search ended up reading as a different component.
//
// It pairs with the `sheet()` factory in src/app/_layout.tsx: the factory owns
// what UIKit draws (corner radius, detents, native grabber OFF), this owns what
// React draws (grabber pill, background, header/body/footer slots, the readable
// column cap). Both read their numbers from `@/components/maps-kit/sheetLook`,
// the same module the OWNED sheets (MapSheet, the tram card) read.
//
// The header wrapper, the body and the footer are DIRECT children of the screen
// — there is deliberately NO container view (and no GlassView) around them, and
// the body must stay at subview index 0 or 1. Three reasons:
//  1. On iOS 26 the transparent formSheet (`contentStyle: transparent` in
//     _layout's sheet() factory) already renders Liquid Glass; painting our own
//     full-bleed GlassView over it is glass-on-glass, which the system resolves
//     by downgrading the inner effect to a flat vibrant fill.
//  2. react-native-screens only finds the sheet's scroll view among the content
//     wrapper's DIRECT subviews, and only lays it out correctly in the
//     [header, ScrollView] shape (hence `collapsable={false}` on the header).
//     That discovery is what wires UISheetPresentationController's
//     prefersScrollingExpandsWhenScrolledToEdge — drag the body up on a
//     half-open sheet and the sheet rises to the next detent before the content
//     scrolls. Burying the ScrollView silently kills that gesture.
//  3. rn-screens SIZES that scroll view itself, and only when it sits at subview
//     index 0 or 1. Push it to index 2 (e.g. by adding one more sibling ahead of
//     it) and it is left at Fabric's (0, 0) with no height correction — it then
//     paints from the sheet's top edge, over the pinned header. This is why the
//     grabber lives inside the header wrapper rather than beside it.
//
// That is also why `scrollable={false}` renders `children` BARE rather than in a
// wrapper: it is the mode for a sheet whose body is its own list (the fleet
// browser's FlatList, a keyboard-aware ScrollView), and wrapping it would bury
// the very view rn-screens is looking for. Such a body owes the sheet its own
// column cap — `SHEET_CONTENT_MAX_WIDTH` — since there is no wrapper to apply it.
//
// Sheets follow the system color scheme (they're app UI, not map chrome).
import { BlurView } from 'expo-blur';
import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ScrollView,
  StyleSheet,
  useColorScheme,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { SHEET_H_PAD } from '@/components/maps-kit/sheetLook';
import { Grabber } from '@/components/ui/Grabber';
import { SHEET_CONTENT_MAX_WIDTH } from '@/components/ui/SheetContent';

/** Whether the system paints Liquid Glass behind a transparent formSheet (iOS 26+). */
const SYSTEM_SHEET_GLASS = isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

/**
 * Sheet background as an EARLIER SIBLING of the scroll, never a container: on
 * iOS 26 the system formSheet already renders the glass, so we draw nothing; on
 * older iOS (or under Reduce Transparency) a plain BlurView/View absoluteFill
 * composites correctly from behind — only a real GlassView has to wrap.
 *
 * Still exported for the one sheet that cannot use <SheetSurface/> at all
 * (a screen owning its whole layout); everything else gets it from the surface.
 */
export function SheetBackground() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => mounted && setReduceTransparency(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduceTransparency,
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  if (SYSTEM_SHEET_GLASS && !reduceTransparency) return null;
  if (!reduceTransparency) {
    return (
      <BlurView
        intensity={60}
        tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        style={StyleSheet.absoluteFill}
      />
    );
  }
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: scheme === 'dark' ? 'rgba(28,28,30,0.94)' : 'rgba(248,248,250,0.96)' },
      ]}
    />
  );
}

export interface SheetSurfaceProps {
  children: ReactNode;
  /** Pinned above the scroll body (e.g. a SheetHeader). */
  header?: ReactNode;
  /** Pinned below the scroll body (e.g. a footer action bar). */
  footer?: ReactNode;
  /**
   * Default true — wrap children in the surface's own scroll view. Pass false
   * when the body IS a scroll container (FlatList, keyboard-aware ScrollView):
   * children are then rendered bare, as direct children of the screen.
   */
  scrollable?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Extra props for the built-in ScrollView (keyboard behaviour, insets…). */
  scrollProps?: ScrollViewProps;
}

export function SheetSurface({
  children,
  header,
  footer,
  scrollable = true,
  contentContainerStyle,
  scrollProps,
}: SheetSurfaceProps) {
  return (
    <>
      <SheetBackground />
      {/* ALWAYS rendered, even with no header, and the grabber lives INSIDE it.
          `collapsable={false}` keeps it a real subview at index 0, which puts
          the body at index 1 — and index 0-or-1 is exactly what react-native-
          screens requires to size a sheet's scroll view
          (RNSScreenContentWrapper.mm `coerceChildScrollViewComponentSizeToSize`:
          index 0 → full size, index 1 → full size minus subview 0's height and
          moved down by it, anything else → NOT SIZED AT ALL). Fabric places
          these children at (0, 0), so an unsized scroll view paints from the
          sheet's top edge, straight over the pinned header. That is exactly
          what happened when the grabber was its own sibling ahead of the header
          and pushed the body to index 2 — the /search results list rendered
          UNDER the search field. Verified on device, before and after.
          With no header the wrapper is zero-height (the grabber is absolutely
          positioned), so the body still gets the whole sheet. */}
      <View collapsable={false} style={styles.column}>
        <Grabber />
        {header}
      </View>
      {scrollable ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, styles.column, contentContainerStyle]}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          {...scrollProps}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
      {footer}
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  // SHEET_H_PAD, not a local 20: this is THE sheet content edge, and it has to
  // be the same number the owned sheets use or a route sheet presented over the
  // home sheet shows two different left edges at once (it did — 20 against 14).
  // The route screens that render their own list (`scrollable={false}`) already
  // padded themselves 16, so this also settles a split inside the native family.
  scrollContent: { paddingHorizontal: SHEET_H_PAD, paddingBottom: 32, gap: 18 },
  /** iPad/wide-window readable column cap, applied per slot now that there is no wrapper. */
  column: { alignSelf: 'center', maxWidth: SHEET_CONTENT_MAX_WIDTH, width: '100%' },
});
