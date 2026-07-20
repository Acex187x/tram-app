// Pure detent → chrome-layout math for the persistent home sheet.
//
// The native @expo/ui BottomSheet reports only its *resting* detent (peek /
// medium / large) through `presentationDetents`' `onSelectionChange` — there is
// no continuous drag position exposed to JS. So the map chrome (right control
// column + contextual chip cluster) springs between three resting offsets on
// each discrete detent change (docs/performance.md invariant #1: no per-frame
// React). This module is the pure, unit-tested core of that mapping; the
// Reanimated wiring lives in index.tsx + MapChrome.tsx.

/**
 * Structural mirror of @expo/ui's `PresentationDetent` — declared locally so
 * this pure module (and its jest test) never imports the native package.
 */
export type NativeDetent = 'medium' | 'large' | { fraction: number } | { height: number };

export type SheetDetent = 'peek' | 'medium' | 'large';

/**
 * Collapse a native detent back to our three-state model. Our sheet declares
 * `[{ height: peekPx }, { fraction: 0.5 }, 'large']`, and SwiftUI echoes the
 * exact selected detent back through onSelectionChange — but we classify
 * defensively (heights near peek → peek, tall fractions → large) so a re-tuned
 * detent list can't silently break the mapping.
 */
export function classifyDetent(detent: NativeDetent, peekPx: number): SheetDetent {
  if (detent === 'large') return 'large';
  if (detent === 'medium') return 'medium';
  if (typeof detent === 'object' && detent !== null) {
    if ('height' in detent) return detent.height <= peekPx + 1 ? 'peek' : 'medium';
    if ('fraction' in detent) {
      if (detent.fraction >= 0.9) return 'large';
      if (detent.fraction <= 0.1) return 'peek';
      return 'medium';
    }
  }
  return 'peek';
}

export interface ChromeLayout {
  /** Pixels to translate the chrome UP from its peek resting position. */
  shift: number;
  /** 1 = visible, 0 = faded out (hidden behind a full-screen sheet). */
  opacity: number;
}

export interface ChromeLayoutOpts {
  peekPx: number;
  windowHeight: number;
  /** Fraction of the window the medium detent occupies (matches the detent list). */
  mediumFraction?: number;
}

/**
 * Resting chrome offset for a detent. The chrome's static base sits at the peek
 * edge, so `shift` is how far up it must ride to clear the sheet's raised top.
 * At `large` the sheet fills the screen: the chrome parks at the medium offset
 * (so there is no positional jump) and fades out instead.
 */
export function chromeLayoutForDetent(
  detent: SheetDetent,
  { peekPx, windowHeight, mediumFraction = 0.5 }: ChromeLayoutOpts,
): ChromeLayout {
  const mediumShift = Math.max(0, windowHeight * mediumFraction - peekPx);
  switch (detent) {
    case 'peek':
      return { shift: 0, opacity: 1 };
    case 'medium':
      return { shift: mediumShift, opacity: 1 };
    case 'large':
      return { shift: mediumShift, opacity: 0 };
  }
}
