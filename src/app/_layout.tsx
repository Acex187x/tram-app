import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Side-effect import: registers the ride background-location task
// (TaskManager.defineTask) in the GLOBAL scope of the bundle — required by the
// Expo v57 TaskManager contract so iOS can deliver locations after relaunching
// the app headless in the background. Must stay a top-level module import.
import '@/lib/motionlog/location';

SplashScreen.preventAutoHideAsync();
// The map screen hides the splash once the base map has rendered.

/** Form-sheet options shared by every panel that floats over the live map. */
function sheet(detents: number[], undimmedIndex = 0) {
  return {
    presentation: 'formSheet' as const,
    headerShown: false,
    sheetAllowedDetents: detents,
    sheetLargestUndimmedDetentIndex: undimmedIndex,
    sheetGrabberVisible: true,
    sheetCornerRadius: 24,
    contentStyle: { backgroundColor: 'transparent' },
  };
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    // GestureHandlerRootView wraps the whole app so the always-mounted
    // AppleSheet (home bottom sheet) and any other gesture-driven chrome on the
    // map screen have a gesture-handler root ancestor.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          {/* Tram sheet is the flagship detail card: 0.15 is the minimized bar,
              0.42 the card, 0.95 the full sheet. Both the minimized and card
              detents keep the followed tram visible (undimmed). Opens on the CARD
              detent (index 1) like Apple's place card. The native header carries
              ONLY the toolbar star/⋯ — the identity (headsign etc.) now lives in
              the screen's custom CollapsingHeader. The title is blanked (the
              screen renders a space via <Stack.Title>, since an empty string can
              fall back to the "tram/[key]" route name on some entry paths).
              headerTransparent so the sheet's own glass shows through, and NO
              sheetCornerRadius override so the system supplies the corners. */}
          <Stack.Screen
            name="tram/[key]"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.15, 0.42, 0.95],
              sheetLargestUndimmedDetentIndex: 1,
              sheetInitialDetentIndex: 1,
              sheetGrabberVisible: true,
              // No native title — the CollapsingHeader owns identity. This is the
              // default; the screen renders a space <Stack.Title> to reliably blank
              // it (an empty string can fall back to the route name on cold-launch
              // deep links). Loading / gone branches override via <Stack.Title>.
              title: '',
              // Native iOS sheet behavior: dragging the body up on a half-open
              // detent expands the sheet to the next/full detent FIRST, and only
              // scrolls the content once fully expanded
              // (UISheetPresentationController.prefersScrollingExpandsWhenScrolledToEdge).
              // Defaults to true, but only takes effect because the screen's
              // ScrollView is a direct child (see tram/[key].tsx) so the sheet
              // controller can track it.
              sheetExpandsWhenScrolledToEdge: true,
              headerShown: true,
              headerTransparent: true,
              // Regular (not large) title: the headsign sits on the SAME row as
              // the toolbar star/⋯. A large title always drops a full band below
              // them, which read as the title having "fallen down" on the card.
              // NOTE: must be `headerLargeTitleEnabled` — the deprecated
              // `headerLargeTitle` alias is NOT honored here (native reads the
              // new prop), so `headerLargeTitle: false` silently stayed large.
              headerLargeTitleEnabled: false,
              headerBlurEffect: 'none',
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
          <Stack.Screen name="line/[id]" options={sheet([0.45, 0.95])} />
          <Stack.Screen name="stop/[key]" options={sheet([0.45, 0.95])} />
          <Stack.Screen name="favorites" options={sheet([0.5, 0.95])} />
          <Stack.Screen name="planner" options={sheet([0.6, 0.95])} />
          {/* Search opens large (Apple search): single 0.95 detent. */}
          <Stack.Screen name="search" options={sheet([0.95])} />
          <Stack.Screen name="settings" options={sheet([0.55, 0.95])} />
          <Stack.Screen name="icon-preview/[pack]" options={sheet([0.95])} />
          <Stack.Screen name="rides" options={sheet([0.5, 0.95])} />
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
