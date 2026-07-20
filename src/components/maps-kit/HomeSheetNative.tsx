// The persistent home surface as a REAL native iOS sheet (@expo/ui → SwiftUI
// `.sheet` with `presentationDetents`). This is what buys the two things a
// hand-rolled reanimated sheet cannot: corner radii that match the device's
// physical screen rounding, and a genuinely native grabber / drag / detent
// feel. Our own RN content (search header + grouped-list body) is hosted inside
// the SwiftUI sheet via `RNHostView`.
//
// Why the SwiftUI layer (not the universal @expo/ui `BottomSheet`): a permanent
// map surface needs three presentation modifiers the universal wrapper doesn't
// expose —
//   • presentationBackgroundInteraction → the live map stays pannable behind
//     the sheet at the peek/medium detents (Apple Maps behaviour),
//   • interactiveDismissDisabled       → the sheet can never be swiped away
//     (peek is its resting state, not "closed"),
//   • presentationDetents({height})    → an exact peek height matched to the
//     map chrome that rides just above it.
//
// PERF: a native sheet drags entirely on the OS side — zero React/JS per frame,
// which satisfies docs/performance.md invariant #1 for free (no worklet needed).
import { BottomSheet, Group, Host, RNHostView } from '@expo/ui/swift-ui';
import {
  frame,
  interactiveDismissDisabled,
  presentationBackground,
  presentationBackgroundInteraction,
  presentationDetents,
  presentationDragIndicator,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface HomeSheetNativeProps {
  /** Peek-detent height in px — the smallest resting height (search bar only). */
  peekPx: number;
  /** Pinned search + account header, always visible at the peek detent. */
  header: ReactNode;
  /** Scrollable body, revealed as the sheet is dragged up. */
  children: ReactNode;
}

export function HomeSheetNative({ peekPx, header, children }: HomeSheetNativeProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const insets = useSafeAreaInsets();
  // iOS system grouped-list background: our clear-glass inset cards are designed
  // to sit on exactly this, so the sheet reads like a native Settings surface.
  const sheetBg = scheme === 'dark' ? '#1C1C1E' : '#F2F2F7';

  const modifiers: ModifierConfig[] = [
    // Fill the sheet's content area so the hosted RN ScrollView gets a bounded
    // height (and therefore scrolls) at every detent.
    frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' }),
    // Rest at the peek height on launch (search bar over the map), then let the
    // user drag up to medium / large. Passing `selection` only seeds the initial
    // detent — the sheet still drags freely between all three.
    presentationDetents([{ height: peekPx }, { fraction: 0.5 }, 'large'], {
      selection: { height: peekPx },
    }),
    presentationDragIndicator('visible'),
    presentationBackgroundInteraction({ type: 'enabledUpThrough', detent: { fraction: 0.5 } }),
    interactiveDismissDisabled(true),
    presentationBackground(sheetBg),
  ];

  return (
    <Host style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <BottomSheet isPresented onIsPresentedChange={noop} fitToContents={false}>
        <Group modifiers={modifiers}>
          <RNHostView>
            <View style={styles.root}>
              {header}
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={[
                  styles.scrollContent,
                  // Scroll all the way into the home-indicator safe area, like
                  // Apple Maps — the content is never boxed above the inset.
                  { paddingBottom: insets.bottom + 28 },
                ]}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {children}
              </ScrollView>
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}

function noop() {}

const styles = StyleSheet.create({
  // Clears the native drag indicator that overlays the very top of the sheet.
  root: { flex: 1, paddingTop: 10 },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 2 },
});
