import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

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
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="tram/[key]" options={sheet([0.38, 0.95])} />
        <Stack.Screen name="line/[id]" options={sheet([0.45, 0.95])} />
        <Stack.Screen name="stop/[key]" options={sheet([0.45, 0.95])} />
        <Stack.Screen name="favorites" options={sheet([0.5, 0.95])} />
        <Stack.Screen name="planner" options={sheet([0.6, 0.95])} />
        <Stack.Screen name="search" options={sheet([0.5, 0.95])} />
        <Stack.Screen name="settings" options={sheet([0.55, 0.95])} />
        <Stack.Screen
          name="model/[id]"
          options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'fade' }}
        />
      </Stack>
    </ThemeProvider>
  );
}
