// The persistent Apple-Maps home bottom sheet (IMG_0072–74): gesture-driven
// detents on reanimated shared values, a grabber, a pinned search header, a
// scrollable body revealed at the medium/large detents, and a `heightSV` output
// so the map's chips/controls translate WITH the sheet on the UI thread.
//
// PERF CONTRACT (docs/performance.md): the drag position lives entirely on the
// UI thread in a SharedValue — the sheet height, the scrim opacity, and any
// chrome reflow the parent drives from `heightSV` are all worklet-driven with
// ZERO per-frame React. The one and only React commit is `onIndexChange`, fired
// once when a drag settles onto a detent (mirrored to a local state used solely
// to gate the large-detent scrim's touch-blocking).
import type { ReactNode } from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Radii } from '@/constants/theme';

const SPRING = { damping: 38, stiffness: 380, mass: 1 } as const;
/** How far a fling's velocity projects the release point when picking a detent. */
const FLING_PROJECTION = 0.08;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface AppleSheetHandle {
  snapTo(index: number): void;
}

export interface AppleSheetProps {
  /** Window-height fractions, ascending — e.g. [0.135, 0.46, 0.92]. */
  detents: number[];
  initialIndex?: number;
  /** Grabber + search row — visible at every detent. */
  pinnedHeader: ReactNode;
  /** Scrollable body — revealed at the medium/large detents. */
  children: ReactNode;
  /** Fires once per settle — the only React commit. */
  onIndexChange?: (index: number) => void;
  /** Updated on the UI thread every frame with the sheet height in px. */
  heightSV?: SharedValue<number>;
  appearance?: 'light' | 'dark';
  scrimAtLargest?: boolean;
}

export const AppleSheet = forwardRef<AppleSheetHandle, AppleSheetProps>(function AppleSheet(
  {
    detents,
    initialIndex = 0,
    pinnedHeader,
    children,
    onIndexChange,
    heightSV,
    appearance,
    scrimAtLargest,
  },
  ref,
) {
  const windowH = useWindowDimensions().height;
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const scheme = appearance ?? system;

  const detentsKey = detents.join(',');
  const lastIndex = detents.length - 1;
  const clampIndex = useCallback(
    (i: number) => Math.max(0, Math.min(detents.length - 1, i)),
    [detents.length],
  );
  const initIdx = clampIndex(initialIndex);

  // Snap points in px. Recomputed on window rotation / detent changes.
  const snapPx = useMemo(
    () => detents.map((d) => Math.round(d * windowH)),
    // detentsKey captures the array's content; windowH the rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detentsKey, windowH],
  );

  // Source of truth for the sheet height. If the parent passes a heightSV (to
  // drive chrome reflow), it IS the driver — the sheet and the chrome then read
  // the exact same value every frame. Otherwise an internal one is used.
  const internalH = useSharedValue(snapPx[initIdx]);
  const hSV = heightSV ?? internalH;
  const snapsSV = useSharedValue(snapPx);
  const indexSV = useSharedValue(initIdx);
  const startH = useSharedValue(0);
  const [settledIndex, setSettledIndex] = useState(initIdx);

  const commit = useCallback(
    (i: number) => {
      setSettledIndex(i);
      onIndexChange?.(i);
    },
    [onIndexChange],
  );

  // Keep the snap table + height in sync with rotation / detent changes.
  const didMount = useRef(false);
  useEffect(() => {
    snapsSV.value = snapPx;
    const target = snapPx[Math.max(0, Math.min(snapPx.length - 1, indexSV.value))];
    if (!didMount.current) {
      hSV.value = target; // seed (also initializes an external heightSV)
      didMount.current = true;
    } else {
      hSV.value = withTiming(target, { duration: 160 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapPx]);

  const snapTo = useCallback(
    (i: number) => {
      const snaps = snapsSV.value;
      const clamped = Math.max(0, Math.min(snaps.length - 1, i));
      hSV.value = withSpring(snaps[clamped], SPRING);
      if (indexSV.value !== clamped) {
        indexSV.value = clamped;
        commit(clamped);
      }
    },
    [commit, hSV, snapsSV, indexSV],
  );

  useImperativeHandle(ref, () => ({ snapTo }), [snapTo]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          startH.value = hSV.value;
        })
        .onUpdate((e) => {
          const snaps = snapsSV.value;
          const min = snaps[0];
          const max = snaps[snaps.length - 1];
          let next = startH.value - e.translationY;
          // Rubber-band past the extremes so the sheet never rips off its rails.
          if (next < min) next = min - (min - next) * 0.35;
          else if (next > max) next = max + (next - max) * 0.2;
          hSV.value = next;
        })
        .onEnd((e) => {
          const snaps = snapsSV.value;
          const projected = hSV.value - e.velocityY * FLING_PROJECTION;
          let best = 0;
          let bestDist = Infinity;
          for (let i = 0; i < snaps.length; i++) {
            const d = Math.abs(snaps[i] - projected);
            if (d < bestDist) {
              bestDist = d;
              best = i;
            }
          }
          hSV.value = withSpring(snaps[best], { ...SPRING, velocity: -e.velocityY });
          if (best !== indexSV.value) {
            indexSV.value = best;
            runOnJS(commit)(best);
          }
        }),
    [commit, hSV, snapsSV, indexSV, startH],
  );

  const sheetStyle = useAnimatedStyle(() => ({ height: hSV.value }));
  const scrimStyle = useAnimatedStyle(() => {
    const snaps = snapsSV.value;
    const max = snaps[snaps.length - 1];
    const prev = snaps.length > 1 ? snaps[snaps.length - 2] : 0;
    const t = max > prev ? (hSV.value - prev) / (max - prev) : 0;
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return { opacity: clamped * 0.32 };
  });

  const grabberColor = scheme === 'dark' ? 'rgba(235,235,245,0.3)' : 'rgba(60,60,67,0.3)';

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {scrimAtLargest && (
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel="Collapse sheet"
          pointerEvents={settledIndex === lastIndex ? 'auto' : 'none'}
          onPress={() => snapTo(Math.max(0, lastIndex - 1))}
          style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}
        />
      )}
      <Animated.View pointerEvents="box-none" style={[styles.sheet, sheetStyle]}>
        <GlassPanel variant="regular" appearance={scheme} style={styles.glass}>
          <GestureDetector gesture={pan}>
            <View style={styles.headerWrap}>
              <View style={[styles.grabber, { backgroundColor: grabberColor }]} />
              {pinnedHeader}
            </View>
          </GestureDetector>
          <View style={styles.body}>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>
          </View>
        </GlassPanel>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  scrim: { backgroundColor: '#000000' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: Radii.sheet,
    borderTopRightRadius: Radii.sheet,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  glass: { flex: 1, borderRadius: 0 },
  headerWrap: { paddingTop: 6 },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    alignSelf: 'center',
    marginBottom: 2,
  },
  body: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
});
