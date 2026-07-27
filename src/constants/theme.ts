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
  /** Delay states — map layers and coloured *text on the sheet background*. */
  onTime: '#2E8B57',
  late: '#C7791B',
  veryLate: '#B3261E',
  /**
   * Delay states as a FILL carrying white text (the DelayPill). Darker than the
   * text variants above so 12 pt white clears 4.5:1: on-time 5.3:1, late 4.7:1,
   * very late 6.5:1. The lighter `onTime`/`late` above only reach 4.3:1 / 3.4:1.
   */
  onTimeFill: '#1E7B34',
  lateFill: '#A9640C',
  veryLateFill: '#B3261E',
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

/**
 * iOS system accents as LIGHT/DARK pairs, exactly as UIKit resolves them.
 *
 * Resolve these through `appleScheme(scheme)` rather than reading them directly:
 * the chrome that floats over the basemap passes the map's *light preset* as its
 * appearance, which a `PlatformColor` cannot express (it only ever follows the
 * system scheme). Sheets pass the system scheme and get the system values.
 */
export const AppleAccent = {
  /** System blue — primary actions, links, prominent pills, checkmarks. */
  blue: { light: '#007AFF', dark: '#0A84FF' },
  /** System green — live/fresh tints, positive stats. */
  green: { light: '#34C759', dark: '#30D158' },
  /** System red — destructive, recording. */
  red: { light: '#FF3B30', dark: '#FF453A' },
  /**
   * Fill for the big Directions GO button. Darker than systemGreen so the white
   * label clears 4.5:1 (systemGreen itself carries white at only ~2.1:1).
   */
  goGreen: { light: '#1D8348', dark: '#248A3D' },
} as const;

/** @deprecated Read accents from `appleScheme(scheme)` so they adapt to appearance. */
export const Apple = {
  /** @deprecated use `appleScheme(scheme).blue` */
  blue: AppleAccent.blue.dark,
  /** @deprecated use `appleScheme(scheme).green` */
  green: AppleAccent.green.dark,
  /** @deprecated use `appleScheme(scheme).goGreen` */
  goGreen: AppleAccent.goGreen.dark,
  /** @deprecated use `appleScheme(scheme).red` */
  red: AppleAccent.red.dark,
  /**
   * Secondary translucent fill (search fields, non-prominent pills) per scheme.
   * This used to be ONE scheme-blind value — the light-mode 16% — so every dark
   * sheet painted its recesses with the light fill. Dark needs the heavier 28%
   * (systemFill's dark value): 16% grey over a dark glass sheet barely reads as
   * a recess at all. src/components/home/HomeSearchRow.tsx had already hardcoded
   * this pair locally rather than trust the token.
   */
  fillSecondary: {
    dark: 'rgba(120,120,128,0.28)',
    light: 'rgba(120,120,128,0.16)',
  },
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
  /** Pressed-state fill for list rows (the system tints, it does not fade out). */
  fillHighlight: {
    dark: 'rgba(120,120,128,0.36)',
    light: 'rgba(120,120,128,0.20)',
  },
} as const;

/**
 * iOS text ramp (SF), at the default (Large) Dynamic Type size. Spread into a
 * Text style: `style={[Type.body, …]}`. Sizes off this ramp read as foreign on
 * iOS — pick the nearest step instead of inventing 19 pt or 10.5 pt.
 */
export const Type = {
  /** Sheet titles. Title 1 at bold weight. */
  largeTitle: { fontSize: 28, fontWeight: '700' },
  title2: { fontSize: 22, fontWeight: '600' },
  title3: { fontSize: 20, fontWeight: '600' },
  /** Row titles and anything that leads a group — Body at semibold. */
  headline: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 17, fontWeight: '400' },
  callout: { fontSize: 16, fontWeight: '400' },
  subhead: { fontSize: 15, fontWeight: '400' },
  footnote: { fontSize: 13, fontWeight: '400' },
  /** Caption 1 — the smallest step for real content. */
  caption1: { fontSize: 12, fontWeight: '400' },
  /** Caption 2 — 11 pt is Apple's legibility floor. Never go below it. */
  caption: { fontSize: 11, fontWeight: '500' },
} satisfies Record<string, TextStyle>;

/**
 * Dynamic Type policy. `allowFontScaling={false}` is an accessibility failure —
 * clamp growth with `maxFontSizeMultiplier` instead so text still scales, just
 * not past what its container can hold.
 *
 * ```tsx
 * <Text style={Type.body} maxFontSizeMultiplier={TextScale.content}>…</Text>
 * ```
 */
export const TextScale = {
  /** Sheet body copy, list rows, anything in a scrolling container. */
  content: 1.6,
  /** Rows and pills of fixed height that can still absorb some growth. */
  compact: 1.35,
  /** Chrome floating over the map, where the layout is a fixed capsule. */
  chrome: 1.25,
  /**
   * Badges locked to a circular/stadium frame (line numbers). Still honours
   * *smaller* accessibility sizes, unlike `allowFontScaling={false}`.
   */
  badge: 1.0,
} as const;

/** Live-updating digits must not reflow their neighbours as they tick. */
export const TabularNums = { fontVariant: ['tabular-nums'] } satisfies TextStyle;

/** Corner radii used across the Apple-Maps UI kit. */
export const Radii = {
  field: 12,
  card: 16,
  group: 22,
  sheet: 24,
  circle: 999,
} as const;

/** Resolve an Apple scheme's text/secondary/separator/fill/accents in one call. */
export function appleScheme(scheme: 'light' | 'dark') {
  return {
    text: Colors[scheme].text,
    secondary: Colors[scheme].textSecondary,
    separator: Apple.separator[scheme],
    fillTertiary: Apple.fillTertiary[scheme],
    fillSecondary: Apple.fillSecondary[scheme],
    /** Pressed-row highlight — the system uses a fill, not an opacity fade. */
    fillHighlight: Apple.fillHighlight[scheme],
    blue: AppleAccent.blue[scheme],
    green: AppleAccent.green[scheme],
    red: AppleAccent.red[scheme],
    goGreen: AppleAccent.goGreen[scheme],
  };
}
