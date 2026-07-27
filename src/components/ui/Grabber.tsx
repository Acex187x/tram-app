// THE grabber pill. One component, one set of numbers (`sheetLook.GRABBER`),
// used by BOTH sheet families:
//
//  • the OWNED Reanimated sheets (`MapSheet`, and the tram card built on it),
//  • every native `formSheet` route, through `SheetSurface`.
//
// The native grabber is switched OFF app-wide (`sheetGrabberVisible: false` in
// the `sheet()` factory in src/app/_layout.tsx) and this one is drawn instead.
// That is not cosmetic pedantry: UIKit's own pill measures 35.3 × 5.0 pt and
// paints an opaque ~(112,111,125) fill, while ours is Apple *Maps*' 50 × 5 at
// separator weight. Two different pills on two sheet families is exactly the
// "this looks like a different component" report — and there is no way to make
// UIKit's match, so it goes away.
//
// GEOMETRY. The pill is drawn OVER the card's top edge (absolutely positioned),
// taking NO layout space, sitting `GRABBER.topGap` below the edge. The row is
// full-width so the pill is centred by ordinary flex rules — `alignSelf` on an
// absolutely positioned child is not a reliable way to centre it.
//
// ACCESSIBILITY. A native sheet is already resizable by VoiceOver through
// UIKit's own sheet affordances, so this component is decorative there. The
// owned sheets DO need the pill to carry the adjustable role and its actions (a
// pan is unreachable to VoiceOver / Switch Control), so `MapSheet` wraps <Pill/>
// in its own accessible row rather than using <Grabber/>'s.
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { GRABBER } from '@/components/maps-kit/sheetLook';

/** The bare pill, with no positioning of its own — for callers that supply
 *  their own (accessible) row. */
export function GrabberPill() {
  return <View style={styles.pill} />;
}

export interface GrabberProps {
  /** Extra positioning, e.g. a different `top` on a sheet with its own inset. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Pill + its absolutely positioned, decorative row. Drop it in as a DIRECT
 * child of a native sheet screen: `position: 'absolute'` keeps it out of yoga
 * layout, so it neither shifts the header nor confuses react-native-screens'
 * scroll-view discovery (which looks for an RCTScrollView among the content
 * wrapper's subviews).
 */
export function Grabber({ style }: GrabberProps) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.row, style]}
    >
      <GrabberPill />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    top: GRABBER.topGap,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  pill: {
    width: GRABBER.w,
    height: GRABBER.h,
    borderRadius: GRABBER.h / 2,
    backgroundColor: GRABBER.color,
  },
});
