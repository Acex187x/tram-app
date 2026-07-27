// THE HOME SURFACE — an owned, gesture-driven Liquid Glass sheet floating over
// the live map (Apple Maps' idiom). Replaces the former `HomeSheetNative`
// (@expo/ui → SwiftUI `.sheet`), which was the single root cause of four
// separate defects:
//
//   1. `presentationBackground` only takes a solid COLOR, so the surface could
//      never be Liquid Glass — it was an opaque slab that hid the map.
//   2. A native sheet exposes only its RESTING detent, never a continuous drag
//      position, so the map chrome could only spring to a new offset AFTER the
//      drag settled — it visibly chased the sheet instead of riding with it.
//   3. A UIKit modal cannot stack on a SwiftUI `.sheet`: presenting any router
//      formSheet (settings / tram / search) DISMISSED the home sheet first, then
//      presented. That is why Settings felt slow (search bar slides away, THEN
//      the panel appears) and why the tram sheet's dismissal left a hole before
//      the search bar respawned.
//   4. On a regular-width iPad a native sheet presents as a wide centered card,
//      which read as broken.
//
// Being an ordinary view in the map screen fixes all four: we own the material,
// we own the drag position, nothing is modal (so router sheets present straight
// over it, instantly), and we can dock it as a side column on iPad.
//
// PERF CONTRACT (docs/performance.md invariant #1): the drag position lives
// entirely on the UI thread in `heightSV`. The sheet transform, the body's
// scroll-enabled flip and the parent's chrome ride are all worklet-driven with
// ZERO React per frame. The only React commit is `onSettle`, fired once when a
// drag lands on a detent.
//
// GEOMETRY — three stages, matching Apple Maps (see `cardShapeFor`, and
// `sheetLook.ts` for the one source of the numbers). At rest the sheet is a
// FREE-FLOATING capsule sitting a uniform 22 pt off the bottom and sides; the
// first 80 px of drag DETACH it into a card that still floats ~5 pt clear on all
// three free sides (Apple's half detent — it never welds itself to the screen
// bottom); and the LAST leg alone takes it EDGE TO EDGE and flush, dims the
// world, and crossfades its surface from Liquid Glass to a solid page fill.
// A card that merely slid down could never show that bottom gap, so the card BOX has to
// change height for real. To keep that cheap, the card's content (header +
// ScrollView) is absolutely positioned at a FIXED height and anchored to the
// card's top: only the card box is re-laid-out per frame, never the list inside
// it. The float lift is a transform, and the bottom corner radius is a paint-only
// prop — so `height` is the single animated layout property.
//
// TWO SHEETS, ONE COMPONENT. This file is not "the home sheet" any more: the
// TRAM CARD is the same component with a different header, body and middle
// detent (see `TramSheet`). That is the whole point of the current design — the
// tram card's smallest detent IS the collapsed bar, so the bar and the card have
// to be one surface built by one piece of math. Nothing is re-parented and
// nothing swaps on the way down; only the card box's height changes.
//
// HAND-OFF (`hidden`) — the sheet is translucent, so anything presented over it
// shows its header STRAIGHT THROUGH the glass. `hidden` slides the whole card
// off the bottom instead of unmounting it, so the header keeps its identity and
// the return trip is a morph. It is one state → shared-value write per
// transition; every frame after that is a worklet.
//
// That slide is TRANSLATION ONLY — never a fade. The card's backing is a native
// UIVisualEffectView, whose effect UIKit leaves undefined at any alpha below 1;
// animating one down and back up is the documented way to lose the material for
// good. See `cardStyle`.
//
// (An earlier pass had `expandLocked` / `onExpandAttempt`, which pinned the home
// sheet at peek and turned an upward drag into a `router.push` of the tram
// formSheet. That existed only to fake "the bar expands into the card" across
// two different surfaces. The user rejected the header-swap approach outright,
// and with the tram card owning its own detents there is nothing left to fake.)
import {
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, useColorScheme, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  scrollTo,
  useAnimatedProps,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { GrabberPill } from '@/components/ui/Grabber';
import { ACTION_PILL } from '@/components/maps-kit/sheetLook';
import {
  DOCK_INSET,
  DOCK_RADIUS,
  DOCK_WIDTH,
  cardShapeFor,
  DOCK_TOP_EXTRA,
  FLOAT_FADE,
  GRABBER_TOP_GAP,
  HEADER_PAD_BOTTOM,
  HEADER_PAD_TOP,
  isDocked as isDockedFor,
  peekCardHeight,
  rubberBand,
  scrimMaxFor,
  SEARCH_H,
  sheetSolidFor,
  SHEET_RADIUS,
  SHEET_SIDE_INSET,
  snapHeights,
  snapIndexFor,
} from '@/components/maps-kit/mapSheetLayout';

/** Native-feeling settle spring — close to UISheetPresentationController's.
 *  Slightly overdamped (critical damping at stiffness 420 / mass 1 is ~41), so
 *  nothing here ever bounces — which matters for the hide/reveal slide, where an
 *  overshoot would read as the bar bobbing rather than morphing. */
const SPRING = { damping: 42, stiffness: 420, mass: 1 } as const;

/**
 * The glass surface, as an ANIMATED component — because its corner radii have to
 * be driven per frame by the same worklet that shapes the card (see `glassStyle`).
 *
 * Created once at module scope: `createAnimatedComponent` inside a render would
 * mint a new component type every commit and remount the native
 * UIVisualEffectView — i.e. destroy and rebuild the material — on every re-render.
 */
const AnimatedGlassPanel = Animated.createAnimatedComponent(GlassPanel);

/**
 * Extra travel past the window bottom while hidden, so the card's glass edge
 * (and the shadow the material casts) is fully clear of the screen.
 *
 * The hide is TRANSLATION ONLY — see `cardStyle`. This margin is what makes
 * that sufficient: the card is pushed until its TOP edge is `HIDE_CLEARANCE`
 * below the window bottom, at whatever detent it happened to be resting on.
 */
const HIDE_CLEARANCE = 60;
/**
 * Delay before the sheet slides BACK UP. A dismissing router formSheet animates
 * downward over ~0.3 s; starting at 0 would race it, and the bar would surface
 * THROUGH the translucent tram card — the exact "card visible behind the glass"
 * artifact this whole path exists to remove. Waiting a beat lets the tram card
 * clear the peek band first, so the two motions read as ONE object: the tram
 * card slides down, the follow bar rises into the space it vacates.
 */
const REVEAL_DELAY_MS = 120;

/**
 * How far the floating overlay (the tram card's action pill) slides DOWN to
 * leave: its own height plus the gap it is anchored at, so its top edge lands on
 * the card's bottom edge and the card's `overflow: hidden` clips it entirely.
 *
 * The overlay leaves by sliding for the same reason the card hides by sliding —
 * its backing is glass, and animated alpha destroys the material (see
 * `overlayStyle`). The 4 pt of slop is only insurance against a caller whose
 * overlay is a couple of points taller than the measured pill.
 */
const OVERLAY_TUCK = ACTION_PILL.fromCardBottom + ACTION_PILL.h + 4;

/** The grabber IS the resize control for assistive tech — a drag is not reachable
 *  by VoiceOver / Switch Control / Voice Control, and without these the sheet's
 *  whole body (Favorites, Plan a trip, the fleet, rides) has no other entry. */
// Labels are required: under Fabric a custom action with no `label` speaks its
// raw name ('increment'/'decrement'/'activate') in the VoiceOver rotor.
const GRABBER_ACTIONS = [
  { name: 'increment' as const, label: 'Expand sheet' },
  { name: 'decrement' as const, label: 'Collapse sheet' },
  { name: 'activate' as const, label: 'Toggle home sheet' },
];

function detentLabel(index: number, count: number): string {
  if (index <= 0) return 'Collapsed';
  if (index >= count - 1) return 'Expanded';
  return 'Half expanded';
}

export interface MapSheetHandle {
  /** Animate to a snap index (0 = peek). Clamped. */
  snapTo(index: number): void;
  /** Collapse to the peek detent. */
  collapse(): void;
}

export interface MapSheetProps {
  /** Pinned header — visible at every detent (search row / follow card). */
  header: ReactNode;
  /** Scrollable body, revealed as the sheet is dragged up. */
  children: ReactNode;
  /**
   * Live sheet height in px, written on the UI thread EVERY FRAME of the drag.
   * The map screen passes the same shared value to the chrome so the controls
   * ride with the sheet continuously.
   */
  heightSV: SharedValue<number>;
  /** Fires once per settle with the resting snap index — the only React commit. */
  onSettle?: (index: number) => void;
  /** Forced light/dark appearance for the glass. Omit to follow the system. */
  appearance?: 'light' | 'dark';
  /**
   * INITIAL estimate of the pinned header's height (pt), used only for the very
   * first frame — the sheet then MEASURES the header and re-derives its peek
   * detent from the real value. Measuring matters because the header swaps
   * between the search row and the taller follow mini-card: a hand-maintained
   * constant that drifted from the real layout left the first grouped row
   * peeking out below the collapsed bar.
   */
  headerHeight?: number;
  /**
   * Fired when the snap table changes (header swap, rotation, iPad resize). The
   * map screen forwards it to the chrome so the two always agree on where the
   * sheet's edges are. Not a per-frame path — this fires on layout only.
   */
  onSnapsChange?: (snaps: number[]) => void;
  /**
   * Slide the whole sheet down off the screen WITHOUT unmounting it (a pure
   * translation — the glass never changes alpha, see `cardStyle`).
   * Used while a router formSheet is presented over the map: the home sheet
   * is a translucent Liquid Glass card, so a sheet on top of it showed the home
   * header — the follow mini-card — straight through its own glass. Hiding is a
   * transform, not an unmount, so the header keeps its identity/state and the
   * return trip is a morph rather than a re-mount.
   *
   * The state → shared-value write happens ONCE per transition in an effect;
   * every frame after that is a worklet (invariant #1 holds).
   */
  hidden?: boolean;
  /**
   * Middle detent as a fraction of the window height. The home sheet takes the
   * default half; the tram card takes CARD_DETENT (0.42) — see `snapHeights`.
   */
  mediumFraction?: number;
  /**
   * Detent to spring to once the sheet has measured its header. The home sheet
   * rests at peek (0, the default); the tram card OPENS at its card detent (1),
   * so a tram tap raises the card instead of dropping a bar at the bottom.
   * Applied exactly once per mount, after the first real header measurement, so
   * the spring starts from the correct peek height rather than the estimate.
   */
  initialSnapIndex?: number;
  /**
   * A floating control cluster (Apple's place-card action pill) drawn OVER the
   * scrolling body and hanging off the CARD's bottom edge, so it rides the
   * card's float lift for free. It fades out as the card collapses to its bar,
   * where the header is the only thing that may be visible.
   */
  overlay?: ReactNode;
  /** VoiceOver name of the resize control (e.g. 'Home sheet' / 'Tram card'). */
  label?: string;
}

export const MapSheet = forwardRef<MapSheetHandle, MapSheetProps>(function MapSheet(
  {
    header,
    children,
    heightSV,
    onSettle,
    appearance,
    headerHeight = SEARCH_H,
    onSnapsChange,
    hidden = false,
    mediumFraction,
    initialSnapIndex = 0,
    overlay,
    label = 'Home sheet',
  },
  ref,
) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const env = useMemo(
    () => ({ windowWidth, windowHeight, insetTop: insets.top, insetBottom: insets.bottom }),
    [windowWidth, windowHeight, insets.top, insets.bottom],
  );
  const docked = isDockedFor(env);
  // A DOCKED column is never hidden: on iPad/landscape a router formSheet is a
  // centered card that does not sit over the column, so there is nothing behind
  // anything — and sliding the column away would just delete the home surface.
  const offstage = hidden && !docked;
  // Padding the header wrapper adds around the header itself — subtracted from
  // the onLayout height so `measuredHeaderH` stays the ROW's height.
  const headerPadTotal = HEADER_PAD_TOP + HEADER_PAD_BOTTOM + (docked ? DOCK_TOP_EXTRA : 0);
  // Measured height of the pinned header. Seeded from the caller's estimate so
  // the first frame is right, then corrected by onLayout — see `headerHeight`.
  const [measuredHeaderH, setMeasuredHeaderH] = useState(headerHeight);
  // A header swap (search row ⇄ follow card) changes the estimate; adopt it
  // immediately rather than showing the previous header's height until layout.
  const lastEstimate = useRef(headerHeight);
  if (lastEstimate.current !== headerHeight) {
    lastEstimate.current = headerHeight;
    setMeasuredHeaderH(headerHeight);
  }
  const snaps = useMemo(
    () => snapHeights(env, measuredHeaderH, mediumFraction),
    [env, measuredHeaderH, mediumFraction],
  );
  const maxSnap = snaps[snaps.length - 1];

  useEffect(() => {
    onSnapsChange?.(snaps);
  }, [snaps, onSnapsChange]);

  const snapsSV = useSharedValue(snaps);
  const startH = useSharedValue(0);
  const dragging = useSharedValue(false);
  // 0 = fully on screen, 1 = parked below the window bottom. One state → SV
  // write per transition (the effect below); the card's transform reads it every
  // frame on the UI thread.
  const hideSV = useSharedValue(offstage ? 1 : 0);
  // `translationY` at the instant the sheet took the gesture over from the list.
  const dragBase = useSharedValue(0);
  const scrollOffset = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // The body ScrollView's own recognizer, as a real RNGH gesture. Relating the
  // pan to an `useAnimatedRef` does NOT work — RNGH cannot resolve it to a
  // handler tag, so no simultaneous relation was ever established and the native
  // scroll won every touch that began in the body. That is why the sheet could
  // be opened by dragging the header but never closed by dragging the list.
  const nativeScroll = useMemo(() => Gesture.Native(), []);

  // Seed the height at peek on the very first render (before paint) so the sheet
  // never flashes at full height. The parent owns heightSV and initialises it to
  // 0, which is our "not laid out yet" sentinel.
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    if (heightSV.value <= 0) heightSV.value = snaps[0];
  }

  // THE RESTING DETENT, as an INDEX rather than a height. Written once per
  // settle (see `settle` below), and seeded from `initialSnapIndex` so a sheet
  // that opens on its card detent is "resting at 1" from the very first frame.
  //
  // Everything that moves the snap TABLE — the header being measured for real,
  // a header that grows with Dynamic Type, rotation, an iPad resize — then
  // springs the sheet to `snaps[restingIndex]`. Tracking the index instead of
  // the height is what makes both of those work with one rule:
  //   • the tram card RISES from its seeded peek to its card detent on mount,
  //     with no separate "open" animation to keep in sync, and
  //   • a sheet resting at peek FOLLOWS a header height change instead of being
  //     merely clamped (clamping only ever raises the height, so a header that
  //     got shorter left the sheet parked at the old, too-tall peek and the
  //     first body row peeked out under the search bar).
  const restingIndex = useRef(initialSnapIndex);
  useEffect(() => {
    snapsSV.value = snaps;
    const target = snaps[Math.max(0, Math.min(snaps.length - 1, restingIndex.current))];
    if (Math.abs(target - heightSV.value) > 0.5) {
      heightSV.value = withSpring(target, SPRING);
    }
  }, [snaps, snapsSV, heightSV]);

  // Hide / reveal. Down immediately (the presenting sheet is already covering
  // that band, so there is nothing to wait for); up only after the dismissing
  // sheet has had a beat to clear — see REVEAL_DELAY_MS.
  useEffect(() => {
    hideSV.value = offstage
      ? withSpring(1, SPRING)
      : withDelay(REVEAL_DELAY_MS, withSpring(0, SPRING));
  }, [offstage, hideSV]);

  // The resting detent index. Written ONCE PER SETTLE (never per frame) and read
  // by the grabber's accessibility value and the floating overlay's hit-testing
  // — invariant #1 is untouched.
  const [snapIndex, setSnapIndex] = useState(initialSnapIndex);
  const settle = useCallback(
    (index: number) => {
      restingIndex.current = index;
      setSnapIndex(index);
      onSettle?.(index);
    },
    [onSettle],
  );

  const snapTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(snaps.length - 1, index));
      heightSV.value = withSpring(snaps[clamped], SPRING);
      settle(clamped);
    },
    [snaps, heightSV, settle],
  );

  useImperativeHandle(ref, () => ({ snapTo, collapse: () => snapTo(0) }), [snapTo]);

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollOffset.value = e.contentOffset.y;
  });

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // A docked column is a fixed side panel — it has a single snap and its
        // animated style is not even applied. Leaving the pan live only killed
        // the list's native overscroll bounce and cancelled its scroll for the
        // rest of the touch.
        // A hidden sheet is parked off screen — nothing under the presented
        // formSheet may still be grabbing touches.
        .enabled(!docked && !offstage)
        // The body ScrollView and this pan must be allowed to run at the same
        // time: which one actually moves is decided per frame in onUpdate.
        .simultaneousWithExternalGesture(nativeScroll)
        .onStart(() => {
          startH.value = heightSV.value;
          dragging.value = false;
          dragBase.value = 0;
        })
        .onUpdate((e) => {
          const table = snapsSV.value;
          const max = table[table.length - 1];
          const atMax = startH.value >= max - 0.5;
          // Fully open AND the user is scrolling content (rather than pulling
          // down from the very top) → the ScrollView owns this gesture.
          if (atMax && !(scrollOffset.value <= 0 && e.translationY > 0)) return;
          // `translationY` accumulates from the GESTURE start, not from the
          // instant the sheet takes over. A gesture that begins with the list
          // already scrolled spends its first N px scrolling to the top, so
          // without re-basing here the sheet would drop by that whole offset in
          // one frame.
          if (!dragging.value) {
            dragging.value = true;
            dragBase.value = e.translationY;
          }
          const raw = startH.value - (e.translationY - dragBase.value);
          const next = rubberBand(raw, table);
          heightSV.value = next;
          // Below the largest detent the body must not scroll underneath the
          // drag — pin it at the top (Apple: the sheet expands FIRST; content
          // scrolls only once it is fully open).
          if (next < max - 0.5) scrollTo(scrollRef, 0, 0, false);
        })
        .onEnd((e) => {
          if (!dragging.value) return;
          dragging.value = false;
          const table = snapsSV.value;
          const index = snapIndexFor(heightSV.value, e.velocityY, table);
          heightSV.value = withSpring(table[index], { ...SPRING, velocity: -e.velocityY });
          runOnJS(settle)(index);
        }),
    [
      docked,
      offstage,
      nativeScroll,
      scrollRef,
      startH,
      dragging,
      dragBase,
      scrollOffset,
      heightSV,
      snapsSV,
      settle,
    ],
  );

  // The card box: its height IS the drag, lifted off the screen bottom by the
  // float gap so the collapsed state reads as a floating CAPSULE (radius = half
  // the card's height — measured off Apple Maps) that detaches into an inset
  // panel and only reaches the device edges at the largest detent.
  // `height` is the only animated layout prop (see the file header); the lift is
  // a transform and the radii are paint-only.
  const peekCardH = peekCardHeight(measuredHeaderH);
  const cardStyle = useAnimatedStyle(() => {
    const table = snapsSV.value;
    const { lift, topRadius, bottomRadius, sideInset } = cardShapeFor(
      heightSV.value,
      table,
      peekCardH,
    );
    // HIDE TRAVEL — pure translation, and NO opacity anywhere on this view.
    //
    // The card is bottom-anchored in a window-tall root, so its top edge sits at
    // `windowHeight - heightSV` (the lift cancels: the box is shortened by the
    // lift and shifted up by it). Pushing it down by exactly `heightSV` puts
    // that top edge on the window bottom; the clearance carries the glass edge
    // and its shadow the rest of the way out. Deriving the travel from the LIVE
    // height rather than from the peek detent is what lets the fade go: a sheet
    // hidden from the medium/full detent is genuinely off screen now, where the
    // old fixed peek-sized travel left most of it on screen and relied on the
    // opacity to make it invisible.
    const h = hideSV.value;
    const travel = heightSV.value + HIDE_CLEARANCE;
    return {
      height: Math.max(0, heightSV.value - lift),
      transform: [{ translateY: -lift + travel * h }],
      // NO `opacity` HERE — deliberately, and it must stay that way. This view's
      // only child is the GlassPanel's native UIVisualEffectView (a UIGlassEffect
      // one on iOS 26), and UIKit is explicit that the effect is undefined once
      // the view's own alpha — or ANY ancestor's — drops below 1. An animated
      // round trip through fractional alpha is the documented way to lose the
      // material permanently, which is exactly the reported "home sheet comes
      // back with no backing, rows floating on the bare map" after a tram card is
      // opened and closed. (The previous code floored the fade at 0.01 to dodge
      // the `alpha == 0` case; 0.01 is still < 1, so it dodged nothing.) The card
      // is fully off screen while hidden, so a fade adds no information anyway.

      // The gutter: ~5 pt of float with map showing through it for the whole
      // middle of the drag, closing to 0 only over the LAST leg, where the card
      // goes edge to edge and flush and the display's own corner mask takes over
      // the bottom rounding (bottomRadius reaches DEVICE_CORNER_RADIUS, so the
      // two are concentric). A layout prop, but the card is already re-laid-out
      // every frame for its height and the content inside is absolutely
      // positioned at a fixed size — the extra cost is a rounding error.
      left: sideInset,
      right: sideInset,
      borderTopLeftRadius: topRadius,
      borderTopRightRadius: topRadius,
      borderBottomLeftRadius: bottomRadius,
      borderBottomRightRadius: bottomRadius,
    };
  }, [peekCardH]);

  // THE GLASS'S OWN SHAPE — the same radii the card clips at, on the same frame.
  //
  // Not a cosmetic duplicate: the sheet's visible silhouette is the INTERSECTION
  // of the card's clip and the glass's own rounded rect, and on a shared box the
  // BIGGER radius is the tighter shape (a 62 pt arc cuts further into the corner
  // than a 38 pt one). The glass used to carry a fixed DEVICE_CORNER_RADIUS on
  // the reasoning that "≥ the card's radius means the card's clip always wins" —
  // which is exactly backwards. It was masked at the two ends of the drag (at the
  // bar CALayer clamps 62 to h/2, which IS the card's capsule; at full the opaque
  // solid overlay covers the glass and is clipped by the card alone), so what it
  // actually broke was the middle: at the floating medium detent the card asked
  // for 38 top / 52.5 bottom and the screen showed 62 on all four corners —
  // ~24 pt off Apple's top corners, measured.
  //
  // Matching radii instead of relying on the clip also keeps the glass's specular
  // RIM on the visible arc. Clipping a square glass to a rounded card leaves the
  // corners rimless, which is the "flat/straight ends" the collapsed bar showed
  // when the glass was left at 0.
  const glassStyle = useAnimatedStyle(() => {
    const { topRadius, bottomRadius } = cardShapeFor(heightSV.value, snapsSV.value, peekCardH);
    return {
      borderTopLeftRadius: topRadius,
      borderTopRightRadius: topRadius,
      borderBottomLeftRadius: bottomRadius,
      borderBottomRightRadius: bottomRadius,
    };
  }, [peekCardH]);

  // The world-dimming scrim behind the card. Apple dims NOTHING until the sheet
  // leaves the medium detent, then fades a black veil in over the last leg — it
  // is the only thing that makes "full screen" read as a different mode rather
  // than just a taller sheet. Opacity is the same worklet as the card shape, so
  // it is exact at every frame of the drag with zero React per frame.
  //
  // Its PEAK is appearance-dependent because UIKit's own dimming view is: a
  // native route sheet at full veils the map with black at α 0.50 in dark and
  // 0.20 in light (measured, see `sheetLook.ts`). One middle value for both —
  // the old flat 0.28 — made the map darken visibly harder behind a route sheet
  // than behind this one. `appearance` is a prop when the caller forces one
  // (nobody does today); otherwise the sheet is app UI and follows the system.
  const systemScheme = useColorScheme();
  const scheme = appearance ?? (systemScheme === 'dark' ? 'dark' : 'light');
  const scrimMax = scrimMaxFor(scheme);
  const scrimStyle = useAnimatedStyle(
    () => ({
      // …and it goes with the card: a hidden sheet must not leave its dim behind.
      opacity:
        cardShapeFor(heightSV.value, snapsSV.value, peekCardH, scrimMax).scrim *
        (1 - hideSV.value),
    }),
    [peekCardH, scrimMax],
  );
  // THE SURFACE CROSSFADE. Apple's fully-open card is not glass — it is a flat,
  // opaque gray page (sampled off the reference shot; see `sheetLook.ts`). This
  // is that fill, as an OPAQUE OVERLAY ABOVE the glass whose own alpha rides the
  // last leg of the drag: 0 up to the medium detent, 1 at the largest.
  //
  // Above the glass, never the glass itself. Animating a UIVisualEffectView's
  // opacity is undefined behaviour in UIKit and loses the material for good —
  // the same hazard `cardStyle` refuses, in the one place where "make the glass
  // go away" is literally the requirement. Here the glass keeps alpha 1 and is
  // simply covered.
  const solidColor = sheetSolidFor(scheme);
  const solidStyle = useAnimatedStyle(
    () => ({ opacity: cardShapeFor(heightSV.value, snapsSV.value, peekCardH).solid }),
    [peekCardH],
  );
  // The floating action pill. It hangs off the CARD's bottom edge (Apple's own
  // anchoring — measured at 27–28.7 pt above it at both open detents), so the
  // card's float lift carries it for free, and it leaves over exactly the leg on
  // which the card DETACHES. That timing matters: by the time the card is short
  // enough to clip the pill, the pill is already gone, so the bar detent shows
  // the header and nothing else.
  //
  // IT LEAVES BY SLIDING, NEVER BY FADING — the same rule as `cardStyle`, for the
  // same reason, and this view is where it was still being broken. The only
  // overlay any caller passes is the tram card's action pill, whose backing is a
  // GlassPanel (a native UIVisualEffectView / UIGlassEffect view). UIKit leaves
  // the effect undefined once the view's own alpha OR ANY ANCESTOR'S drops below
  // 1, and expo-glass-effect stops rendering glass outright at 0 — and this
  // wrapper IS an ancestor. The old `opacity: k` round-tripped it 1 → 0 → 1 on
  // every bar↔card drag, i.e. exactly the documented way to lose the material.
  //
  // Sliding costs nothing in fidelity because the card CLIPS (`styles.card`
  // overflow: hidden): pushing the pill down by its own height plus its
  // anchoring gap puts its top edge on the card's bottom edge, so it is gone by
  // the same frame the alpha used to reach 0 — and the motion is what already
  // made it read as dropping away with the card rather than blinking out.
  const overlayStyle = useAnimatedStyle(() => {
    const table = snapsSV.value;
    const peek = table.length > 0 ? table[0] : 0;
    const t = (heightSV.value - peek) / FLOAT_FADE;
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    return {
      // NO `opacity` HERE — see above. (It also used to be multiplied by
      // `1 - hideSV`, a second alpha animation over the same glass for no gain:
      // the pill is a child of the card, so the hide translation already carries
      // it off screen with everything else.)
      transform: [{ translateY: (1 - k) * OVERLAY_TUCK }],
    };
  });
  // Hit-testing is a React prop, so it is gated on the SETTLED detent — one
  // write per settle, never per frame. At the bar the pill is invisible and
  // inert, and the map keeps every touch it would otherwise have lost.
  const overlayActive = !offstage && snapIndex > 0;

  // …but WHETHER it takes touches cannot be a worklet (pointerEvents is a React
  // prop), so it is gated on the settled detent — written once per settle by
  // `settle`, never per frame. Below the largest detent the scrim is invisible
  // AND inert, so the map keeps every touch it has today.
  const scrimActive = !offstage && snaps.length > 1 && snapIndex >= snaps.length - 1;
  // Tapping the dimmed world collapses to the detent below full screen (medium
  // where there is one) — the standard iOS "dismiss by tapping the dimmed area",
  // scaled to a sheet whose peek is its resting state rather than "closed".
  const scrimTarget = snaps.length > 2 ? 1 : 0;

  // The body only becomes scrollable once the sheet is (near) fully open — below
  // that, a drag anywhere in the sheet must move the SHEET. Applied as an
  // animated prop so the flip stays on the UI thread (no React state per
  // detent, and no stale-state window mid-drag).
  // A docked column never resizes, so its list is an ordinary scroll view.
  const scrollProps = useAnimatedProps(
    () => ({ scrollEnabled: docked || heightSV.value >= maxSnap - 0.5 }),
    [maxSnap, docked],
  );

  // End-of-scroll clearance only: the body still runs to the sheet's bottom edge
  // at rest (no dead strip), but the LAST row can be scrolled clear of the home
  // indicator, which at the large detent sits over the card's bottom edge.
  const scrollContentStyle = useMemo(
    () => [styles.scrollContent, { paddingBottom: insets.bottom }],
    [insets.bottom],
  );

  return (
    // box-none so the map keeps every touch outside the sheet itself. On a phone
    // the container spans the WHOLE window (it has to, for the scrim), but it is
    // inert: the only full-bleed child is the scrim, which is `pointerEvents:
    // none` at every detent below the largest one.
    <View
      pointerEvents="box-none"
      style={[
        styles.root,
        docked
          ? { top: insets.top + DOCK_INSET, bottom: DOCK_INSET, width: DOCK_WIDTH, left: DOCK_INSET }
          : styles.rootPhone,
      ]}
    >
      {!docked && (
        <Animated.View
          pointerEvents={scrimActive ? 'auto' : 'none'}
          // pointerEvents is invisible to UIAccessibility, so the inert scrim
          // would still be a focusable "Collapse sheet" button behind the map.
          accessibilityElementsHidden={!scrimActive}
          importantForAccessibility={scrimActive ? 'yes' : 'no-hide-descendants'}
          style={[styles.scrim, scrimStyle]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="Collapse sheet"
            onPress={() => snapTo(scrimTarget)}
          />
        </Animated.View>
      )}

      <Animated.View
        // Parked off screen: inert to touch AND to VoiceOver. `pointerEvents`
        // alone is invisible to UIAccessibility, so without the two a11y props
        // the hidden search field / follow bar would still be focusable behind
        // the presented sheet.
        pointerEvents={offstage ? 'none' : 'auto'}
        accessibilityElementsHidden={offstage}
        importantForAccessibility={offstage ? 'no-hide-descendants' : 'auto'}
        style={[styles.card, docked ? styles.cardDocked : null, docked ? null : cardStyle]}
      >
        {/* Liquid Glass surface. A sibling behind the content (not a wrapper) so
            the body ScrollView stays a plain, cheap subtree. */}
        {/* Its radii TRACK THE CARD's, frame by frame — see `glassStyle`. The
            glass is the visible surface at every detent below full, and on a
            shared box the larger radius is the tighter shape, so a glass rounder
            than the card owns the silhouette outright. A docked column never
            morphs, so it just takes the column's own static radius. */}
        <AnimatedGlassPanel
          variant="regular"
          appearance={appearance}
          style={[styles.glass, docked ? styles.glassDocked : glassStyle]}
        />

        {/* …and the SOLID page fill that covers it at the largest detent. Above
            the glass in z-order, inert to touch, clipped by the card like
            everything else in here. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.solid, { backgroundColor: solidColor }, solidStyle]}
        />

        {/* Content block: FIXED height, anchored to the card's top. The card box
            resizes with the drag; this subtree never does, so the grouped list
            is laid out once instead of on every frame. Overflow is clipped by
            the card, which is what crops the body at the smaller detents. */}
        {/* The pan wraps the WHOLE content — header AND body. Attaching it to the
            header alone meant the sheet could be opened but never closed by
            dragging the list: a downward drag in the body simply rubber-banded
            the ScrollView. `onUpdate` decides per frame which one moves, so
            content still scrolls normally once the sheet is fully open. */}
        <GestureDetector gesture={pan}>
          <View style={[styles.content, docked ? { bottom: 0 } : { height: maxSnap }]}>
            <View
              style={[
                styles.headerWrap,
                docked ? styles.headerWrapDocked : null,
                // Floor at the caller's estimate: even if the row mismeasures to
                // zero (the observed mount race — see styles.headerWrap), the
                // column still reserves the header band, so the body can never
                // start at the card's top. Costs nothing when layout is healthy:
                // the natural height is within a couple of points of this.
                { minHeight: headerPadTotal + headerHeight },
              ]}
              onLayout={(e) => {
                const h = Math.round(e.nativeEvent.layout.height) - headerPadTotal;
                if (h > 0 && Math.abs(h - measuredHeaderH) > 0.5) setMeasuredHeaderH(h);
              }}
            >
              {/* Drawn OVER the card's top edge in a full-width row, so it takes
                  no layout space and is centred by ordinary flex rules. It is
                  also the sheet's only RESIZE control for assistive tech: a pan
                  is unreachable to VoiceOver / Switch Control / Voice Control,
                  so the row carries the adjustable role and its actions.
                  `pointerEvents="none"` stays — it only clears
                  `userInteractionEnabled`, which UIAccessibility ignores, so the
                  row is still focusable and still actionable while the pan (and
                  the search field GRABBER_TO_FIELD below it) keep every touch. */}
              {!docked && (
                <View
                  pointerEvents="none"
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={label}
                  accessibilityValue={{ text: detentLabel(snapIndex, snaps.length) }}
                  accessibilityHint="Adjust to reveal or hide the details"
                  accessibilityActions={GRABBER_ACTIONS}
                  onAccessibilityAction={(e) => {
                    const action = e.nativeEvent.actionName;
                    if (action === 'increment') snapTo(snapIndex + 1);
                    else if (action === 'decrement') snapTo(snapIndex - 1);
                    else snapTo(snapIndex >= snaps.length - 1 ? 0 : snapIndex + 1);
                  }}
                  style={styles.grabberRow}
                >
                  {/* The ONE pill — src/components/ui/Grabber.tsx. The same
                      component the native route sheets draw, so the two sheet
                      families cannot disagree about its size or tint. */}
                  <GrabberPill />
                </View>
              )}
              {header}
            </View>

            <GestureDetector gesture={nativeScroll}>
              <Animated.ScrollView
                ref={scrollRef}
                style={styles.scroll}
                // Only the home-indicator inset, as END-of-scroll clearance. The
                // old `insets.bottom + 8` was padding on a body that mostly does
                // not scroll, so it read as a tall dead strip; this one is
                // invisible until the last row actually reaches the bottom edge.
                contentContainerStyle={scrollContentStyle}
                onScroll={onScroll}
                scrollEventThrottle={16}
                animatedProps={scrollProps}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {children}
              </Animated.ScrollView>
            </GestureDetector>
          </View>
        </GestureDetector>

        {/* OUTSIDE the pan's GestureDetector and after it in z-order: the pill
            floats over the scrolling body, and its buttons must win the touch
            rather than starting a sheet drag. */}
        {overlay != null && (
          <Animated.View
            pointerEvents={overlayActive ? 'box-none' : 'none'}
            accessibilityElementsHidden={!overlayActive}
            importantForAccessibility={overlayActive ? 'auto' : 'no-hide-descendants'}
            style={[styles.overlay, overlayStyle]}
          >
            {overlay}
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  // Full-window on a phone so the scrim can dim everything — the map, the
  // chrome, the status bar band. box-none + an inert scrim keeps it pass-through
  // at every detent below the largest.
  rootPhone: { top: 0 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  // Bottom-anchored: the card grows UPWARDS as its animated height increases.
  card: {
    position: 'absolute',
    bottom: 0,
    // left/right/radii are supplied by cardStyle — the card morphs from a
    // floating capsule at rest to an inset, rounded panel. It NEVER reaches the
    // device edges; these static values are only the first frame's.
    left: SHEET_SIDE_INSET,
    right: SHEET_SIDE_INSET,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    overflow: 'hidden',
  },
  cardDocked: { top: 0, left: 0, right: 0, borderRadius: DOCK_RADIUS },
  // NO radius here — `glassStyle` supplies all four, per frame, from the same
  // `cardShapeFor` the card clips with. Every static value that was tried in this
  // slot was wrong at one end of the drag or the other:
  //  • GlassPanel's default 20 (and 0) leaves the corners SMALLER than the card's,
  //    so the glass's specular rim runs outside the card's arc and gets clipped —
  //    rimless corners, which read as the flat/"crooked frame" ends;
  //  • DEVICE_CORNER_RADIUS (62) is LARGER than the card's at every floating
  //    detent, and the larger radius is the tighter shape: the glass, not the
  //    card, then owns the silhouette (measured: 62 at the medium detent where
  //    the card asked for 38 / 52.5). It only looked right at the bar, where
  //    CALayer clamps it to h/2 and the card is a capsule anyway.
  glass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // A docked column has one static shape; `cardDocked` clips at the same value.
  glassDocked: { borderRadius: DOCK_RADIUS },
  // The opaque page fill for the largest detent, over the glass and under the
  // content. Its colour is per-appearance (a render-time prop) and its opacity is
  // a worklet of the drag — see `solidStyle`.
  solid: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  content: { position: 'absolute', top: 0, left: 0, right: 0 },
  // Padding around the header row: at the peek detent this block is EXACTLY the
  // visible card (15 + row + 14), so no body content peeks out under the search
  // bar. Asymmetric on purpose — the top pad IS the grabber band (see
  // HEADER_PAD_TOP), the bottom pad is the plain uniform inset.
  //
  // zIndex: OBSERVED MOUNT RACE (1-in-7, tram card opened from a form sheet with
  // the home sheet at full): this wrapper laid out at ZERO height while still
  // painting its children, so the body ScrollView moved up into the header band
  // and its first row sat OVER the ✕ / identity, stealing their taps for the
  // card's whole lifetime. Root cause not pinned (Yoga/Fabric measure glitch);
  // the defense is structural — the wrapper always wins the z-order so even an
  // overlapping body can never take the header's touches, and an inline
  // minHeight (see the JSX) keeps the column from ever collapsing the band.
  headerWrap: { paddingTop: HEADER_PAD_TOP, paddingBottom: HEADER_PAD_BOTTOM, zIndex: 2 },
  // A docked column has no grabber above the row, so it needs that inset back —
  // otherwise the search field sits flush against the column's rounded top edge.
  headerWrapDocked: { paddingTop: HEADER_PAD_TOP + DOCK_TOP_EXTRA },
  // Full-width row so the pill is centred by ordinary flex layout — `alignSelf`
  // on an absolutely positioned child is not a reliable way to centre it.
  grabberRow: {
    position: 'absolute',
    // GRABBER_TOP_GAP below the card's top edge, which leaves exactly
    // GRABBER_TO_FIELD of clear air above the search field — Apple's band. At
    // the old top:2 the pill was crowded against BOTH the card edge and the field.
    top: GRABBER_TOP_GAP,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  scroll: { flex: 1 },
  // paddingBottom is supplied per-render from the home-indicator inset.
  scrollContent: { paddingTop: 2 },
  // Anchored to the CARD's bottom edge, full width so the pill centres by
  // ordinary flex rules. box-none above, so only the pill itself takes touches.
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: ACTION_PILL.fromCardBottom,
    alignItems: 'center',
  },
});
