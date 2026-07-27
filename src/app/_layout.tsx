import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  HOME_DETENT,
  largeDetentFraction,
  mediumDetentFraction,
} from '@/components/maps-kit/mapSheetLayout';
import { SHEET_RADIUS } from '@/components/maps-kit/sheetLook';

// Side-effect import: registers the ride background-location task
// (TaskManager.defineTask) in the GLOBAL scope of the bundle — required by the
// Expo v57 TaskManager contract so iOS can deliver locations after relaunching
// the app headless in the background. Must stay a top-level module import.
import '@/lib/motionlog/location';

SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ fade: true, duration: 350 });
// The map screen hides the splash once the base map has rendered.

// Seeds `index` beneath any deep-linked child route. Without it a cold-launch
// deep link (fablespotsthetram://tram/9123, Handoff, dev tooling) mounts ONLY
// the target sheet: no map behind the transparent formSheet, no
// `useTramRuntime()` feeding it, and `canGoBack()` false so dismissing it
// leaves a blank screen.
export const unstable_settings = { anchor: 'index' };

/**
 * Form-sheet options shared by every panel that floats over the live map — and
 * the ONE place a route sheet's look is decided. Nothing route-specific belongs
 * in a `Stack.Screen` any more: a screen states only how tall its middle detent
 * is, as a fraction OF THE WINDOW, and gets the shared surface for free.
 *
 * The three things it enforces, all of them from `sheetLook`/`mapSheetLayout` so
 * they cannot drift from the owned sheets (`MapSheet`, the tram card):
 *
 *  • `sheetCornerRadius: SHEET_RADIUS` (38, Apple's measured sheet corner). It
 *    used to be 24 while the owned sheets rounded at 38 — the single most
 *    visible "this is a different component" tell.
 *  • `sheetGrabberVisible: false`. UIKit's pill is 35.3 × 5.0 pt and opaque;
 *    ours is Apple Maps' 50 × 5 at separator weight. `SheetSurface` draws
 *    <Grabber/> instead, so every sheet in the app has the same one.
 *  • detents translated out of UIKit's `maximumDetentValue` space and into the
 *    owned sheets' window space, so "large" is the SAME EDGE on both families.
 *
 * `contentStyle` stays transparent: iOS 26 paints Liquid Glass behind a
 * transparent formSheet, and that system material IS the sheet's surface (a
 * second full-bleed pane over it is glass-on-glass, which the system resolves by
 * flattening the inner effect). `SheetBackground` covers older iOS / Reduce
 * Transparency.
 *
 * THE ONE THING THIS FACTORY CANNOT REACH: the sheet's side gutter. UIKit
 * floats a formSheet by 5.0/5.3 pt at a 0.45 detent, 2.8/2.9 at 0.55, and 0.1/
 * 0.5 — flush — once it is dragged to the largest one (all measured on this
 * device, dark and light alike). So these sheets match the owned ones exactly
 * while partly open and go edge-to-edge at full, where the owned ones keep
 * their 5 pt float. The surface is the system's, so there is no width, inset or
 * margin to set; the only way out would be capping the largest detent at a
 * ~424 pt half sheet. Recorded in `sheetLook.ts` beside `FULL_SIDE_INSET` —
 * do NOT "resolve" it by closing the owned sheets' gutter, which is the exact
 * thing the user rejected on device.
 */
function useSheetOptions() {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return useCallback(
    (mediumWindowFraction: number | null, undimmedIndex: number | 'none' = 0) => {
      const large = largeDetentFraction(height, insets.top);
      const detents =
        mediumWindowFraction == null
          ? [large]
          : [mediumDetentFraction(height, mediumWindowFraction), large];
      return {
        presentation: 'formSheet' as const,
        headerShown: false,
        sheetAllowedDetents: detents,
        sheetLargestUndimmedDetentIndex: undimmedIndex,
        sheetGrabberVisible: false,
        sheetCornerRadius: SHEET_RADIUS,
        contentStyle: { backgroundColor: 'transparent' },
      };
    },
    [height, insets.top],
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const sheet = useSheetOptions();
  return (
    // GestureHandlerRootView wraps the whole app so the always-mounted
    // MapSheet (home bottom sheet) and any other gesture-driven chrome on the
    // map screen have a gesture-handler root ancestor.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          {/* `tram/[key]` is a DEEP-LINK SHIM that renders null — the tram card
              itself is an owned sheet on the map screen now (see
              src/components/tram/TramSheet.tsx and the file header of
              src/app/tram/[key].tsx). It exists so deep links and the search
              sheet's <Link> rows still have somewhere to navigate to; the screen
              writes `presentedTramKey` and immediately dismisses back to `/`.

              Transparent + `animation: 'none'` so that round trip is INVISIBLE:
              a formSheet (or any animated presentation) would slide an empty
              surface up and straight back down. Nothing is drawn at all, so
              there is no material to configure — the whole block of formSheet /
              transparent-header / scroll-edge-effect options this screen used to
              carry moved into the owned sheet's own code. */}
          <Stack.Screen
            name="tram/[key]"
            options={{
              presentation: 'transparentModal',
              animation: 'none',
              headerShown: false,
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
          {/* Middle detents are WINDOW fractions now — the same units the owned
              sheets' `mediumFraction` uses (HOME_DETENT is their half). The
              factory converts. `null` means "no middle detent": open large. */}
          <Stack.Screen name="line/[id]" options={sheet(0.45)} />
          <Stack.Screen name="stop/[key]" options={sheet(0.45)} />
          <Stack.Screen name="favorites" options={sheet(HOME_DETENT)} />
          <Stack.Screen name="planner" options={sheet(0.6)} />
          {/* Search opens large (Apple search): a single detent. With one
              detent, index 0 IS the largest, so the factory default would leave
              it undimmed — 'none' keeps the "only the large detent dims" rule. */}
          <Stack.Screen name="search" options={sheet(null, 'none')} />
          <Stack.Screen name="settings" options={sheet(0.55)} />
          <Stack.Screen name="icon-preview/[pack]" options={sheet(null, 'none')} />
          <Stack.Screen name="rides" options={sheet(HOME_DETENT)} />
          <Stack.Screen name="model-info/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="tram-photos/[reg]" options={{ headerShown: false }} />
          <Stack.Screen
            name="model/[id]"
            options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'fade' }}
          />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
