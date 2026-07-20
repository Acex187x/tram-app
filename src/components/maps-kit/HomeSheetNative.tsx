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
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NativeDetent } from '@/components/maps-kit/sheetDetent';

export interface HomeSheetNativeProps {
  /** Peek-detent height in px — the smallest resting height (search bar only). */
  peekPx: number;
  /** Pinned search + account header, always visible at the peek detent. */
  header: ReactNode;
  /** Scrollable body, revealed as the sheet is dragged up. */
  children: ReactNode;
  /**
   * Fired when the sheet settles on a new detent (peek / medium / large) — the
   * only position signal the native sheet exposes. Drives the map chrome that
   * rides with the sheet.
   */
  onDetentChange?: (detent: NativeDetent) => void;
}

export function HomeSheetNative({ peekPx, header, children, onDetentChange }: HomeSheetNativeProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const insets = useSafeAreaInsets();
  // The home surface must ALWAYS be present — peek is its resting state, not a
  // "closed" state. Two mechanisms guarantee it never vanishes for good (the old
  // bug: it disappeared and only an app restart brought it back):
  //   1. `interactiveDismissDisabled(true)` (below) stops the user swiping it
  //      away past its peek detent.
  //   2. Presenting a router formSheet over it (settings / search / a tram
  //      sheet) dismisses this native `.sheet` — a UIKit modal can't stack on
  //      one. So we REMOUNT (bump `presentKey`) every time the map screen
  //      regains focus, i.e. right after that formSheet closes, which re-presents
  //      the sheet at peek. The first focus is skipped so the initial mount isn't
  //      double-presented.
  // `isPresented` stays a literal `true`; driving it from state that
  // `onIsPresentedChange` can flip to `false` made the sheet fail to present at
  // all (verified on-device).
  const [presentKey, setPresentKey] = useState(0);
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setPresentKey((k) => k + 1);
      // The remounted sheet re-presents at peek; snap the map chrome back to the
      // peek offset too (a detent change to peek isn't emitted for the fresh
      // mount, so the chrome would otherwise stay stuck at its last shift).
      onDetentChange?.({ height: peekPx });
    }, [onDetentChange, peekPx]),
  );
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
      // Discrete detent-change callback (the only position signal the native
      // sheet exposes) — the map chrome springs to match on each change.
      onSelectionChange: onDetentChange,
    }),
    presentationDragIndicator('visible'),
    // The live map MUST stay pannable/tappable behind the sheet at every resting
    // detent (Apple Maps). `enabledUpThrough` a `height` detent proved unreliable
    // on-device — SwiftUI kept the modal scrim up at the peek/medium detents, so
    // the whole map was untappable. Unconditional `.enabled` keeps background
    // interaction on at all detents; the sheet can never be swiped away
    // (interactiveDismissDisabled) so there is no "modal" state to protect.
    presentationBackgroundInteraction('enabled'),
    interactiveDismissDisabled(true),
    presentationBackground(sheetBg),
  ];

  return (
    // CRITICAL: the Host must NOT cover the map. A full-screen (`absoluteFill`)
    // SwiftUI hosting view swallows every touch in the sheet's backdrop area —
    // `pointerEvents="box-none"` is not honored through to the ExpoUI hosting
    // view, so the whole map became untappable. The `.sheet` is presented
    // modally and sizes itself from its detents, independent of this Host's own
    // frame, so a zero-height bottom anchor presents the exact same sheet while
    // leaving the entire map above it free for pan / zoom / tram taps.
    <Host style={styles.hostAnchor} pointerEvents="box-none">
      <BottomSheet key={presentKey} isPresented onIsPresentedChange={noop} fitToContents={false}>
        <Group modifiers={modifiers}>
          <RNHostView>
            <View style={styles.root}>
              {header}
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={[
                  styles.scrollContent,
                  // Just clear the home indicator — the old `+28` left a tall dead
                  // strip below the last row that looked like the content was cut
                  // off before the sheet's bottom edge (fix #5). Content now scrolls
                  // right down to the inset, Apple-Maps style.
                  { paddingBottom: insets.bottom + 8 },
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
  // Zero-height bottom anchor: enough to host the SwiftUI `.sheet` trigger
  // without the hosting view covering (and eating touches over) the map.
  hostAnchor: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 0 },
  // Clears the native drag indicator that overlays the very top of the sheet.
  root: { flex: 1, paddingTop: 10 },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 2 },
});
