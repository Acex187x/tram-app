/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform, type TextStyle } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * Prague tram (PID) brand palette — shared by map layers and UI chrome.
 * pidRed is the official route color returned by Golemio for every tram line.
 */
export const Tram = {
  /** PID dark red — route lines, brand accents. */
  pidRed: '#7A0603',
  /** Classic Tatra livery red. */
  liveryRed: '#B02A26',
  /** Classic livery cream — badges, glyphs on red. */
  cream: '#F5EBD8',
  /** Route line casing / subtle strokes. */
  redSoft: 'rgba(122, 6, 3, 0.35)',
  /** Selected line highlight. */
  gold: '#E0A526',
  /** Delay states. */
  onTime: '#2E8B57',
  late: '#C7791B',
  veryLate: '#B3261E',
  /** Night line accent (dark blue like PID night routes). */
  night: '#20315C',
} as const;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;

// ─── Apple-Maps design tokens (additive) ─────────────────────────────────────
// The chrome + sheet re-skin to Apple Maps conventions. These sit ALONGSIDE the
// existing Colors/Tram palettes — the PID Tram colors still own badges, livery,
// and every map layer. These tokens own the iOS system accents, translucent
// fills, hairline separators, type ramp, and corner radii of the new UI kit.

/** iOS system accent + fill colors used by the Apple-Maps chrome/sheets. */
export const Apple = {
  /** System blue — primary actions, links, prominent pills, checkmarks. */
  blue: '#0A84FF',
  /** System green — live/fresh tints, positive stats. */
  green: '#30D158',
  /** The big Directions GO button green. */
  goGreen: '#30D158',
  /** System red — destructive, recording. */
  red: '#FF453A',
  /** Secondary translucent fill (search fields, non-prominent pills). */
  fillSecondary: 'rgba(120,120,128,0.16)',
  /** Tertiary translucent fill (control circles, segmented tracks) per scheme. */
  fillTertiary: {
    dark: 'rgba(118,118,128,0.24)',
    light: 'rgba(118,118,128,0.12)',
  },
  /** Hairline separator color per scheme. */
  separator: {
    dark: 'rgba(255,255,255,0.12)',
    light: 'rgba(0,0,0,0.10)',
  },
} as const;

/** iOS text ramp (SF). Spread into a Text style: `style={[Type.largeTitle, …]}`. */
export const Type = {
  largeTitle: { fontSize: 28, fontWeight: '700' },
  title3: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 17, fontWeight: '400' },
  subhead: { fontSize: 15, fontWeight: '400' },
  footnote: { fontSize: 13, fontWeight: '400' },
  caption: { fontSize: 11, fontWeight: '500' },
} satisfies Record<string, TextStyle>;

/** Corner radii used across the Apple-Maps UI kit. */
export const Radii = {
  field: 12,
  card: 16,
  group: 22,
  sheet: 24,
  circle: 999,
} as const;

/** Resolve an Apple scheme's text/secondary/separator/fill in one call. */
export function appleScheme(scheme: 'light' | 'dark') {
  return {
    text: Colors[scheme].text,
    secondary: Colors[scheme].textSecondary,
    separator: Apple.separator[scheme],
    fillTertiary: Apple.fillTertiary[scheme],
    fillSecondary: Apple.fillSecondary,
  };
}
