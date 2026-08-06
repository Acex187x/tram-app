// Pure layout math for the owned map bottom sheet (MapSheet) — snap points, the
// continuous chrome ride, and the compact/regular (iPhone/iPad) split.
//
// WHY THIS IS PURE: the sheet's drag position lives in a Reanimated SharedValue
// and is read by worklets every frame (docs/performance.md invariant #1: no
// React state per frame). Every function here is therefore a `worklet`-safe pure
// function of numbers — the UI thread calls them directly, and jest tests the
// exact same code the sheet runs.

// ── Sheet geometry, MEASURED off Apple Maps on iOS 26 (iPhone 16 Pro) ────────
// The LOOK constants (radius, gutters, top gap, scrim, grabber) now live in ONE
// module — `sheetLook.ts` — so the worklet math here, the native `formSheet`
// options and the sheet primitives cannot drift apart again. This file imports
// them and re-exports the names its existing callers already use.
//
// Method: decode the screenshot and find the card by the brightness step its
// glass makes over the map (luma profile across a band of plain card glass) and
// by the sharpness drop it causes (glass blurs what is behind it). Both agree.
//
//   PEEK    card 786.4 → 851.3 pt (h 64.9), insets 22.5 / 22.6, bottom gap 22.7
//           → the margin is UNIFORM on all three free sides: ~22 pt.
//           corner fits R 32.25 / 32.75 against h/2 = 32.45 → a CAPSULE, not a
//           rounded rectangle (a frame-CONCENTRIC corner at a 22 pt gap would
//           be 62−22 = 40; Apple is measurably a plain capsule here).
//           grabber 50 × 4.7, sitting 4.2 below the card top, clearing the
//           field by 5.3 → the whole top pad is exactly gap+pill+clearance.
//           field 37.3 tall with a UNIFORM 13.8 pt inset above and below it.
//   MEDIUM  top 486.2 — the SAME detent for the root search sheet and for a
//           place card; insets 5.9 / 5.9 and a 5.9 BOTTOM gap, so the card
//           floats free on all three sides; top radius 35.75, bottom radius
//           52.0 (4 pt TIGHTER than concentric). ZERO dim.
//   LARGE   top at 111.83 ⇒ a 762.2 pt card; insets 0 and the bottom flush, so
//           the card is EDGE TO EDGE and the display's own corner mask rounds
//           its bottom; top radius 38.0; the world DIMS (α 0.527); and the
//           surface stops being glass and crossfades to a solid gray fill.
//
// The three things that were wrong before this pass and that the user rejected:
//   (a) our content inset was 14 horizontal but only 9 vertical, and the grabber
//       had 2 pt of air instead of Apple's 5 — the bar read as crowded;
//   (b) the side inset reached 0 within 80 px of peek, so the sheet went
//       full-bleed at the MEDIUM detent and nothing ever dimmed;
//   (c) the correction to (b) overshot: the gutter was then FROZEN at 5 pt all
//       the way to the largest detent, so a fully-open sheet stopped short of
//       the screen edges and stayed a floating card. Apple's does not. The
//       measurement was right the first time — at FULL it is flush — and the
//       fix for (b) belongs where it now is: the gutter closes only over the
//       LAST leg, never during the detach. See `sheetLook.ts`.
//
// And the deviation that used to be listed here as deferred is closed: the
// MEDIUM detent now keeps Apple's 5.5 pt BOTTOM gap too. It costs nothing,
// because the card is bottom-anchored and lifted by a transform — its top edge
// sits at `windowHeight − heightSV` whatever the lift is, so the float gap
// moves the bottom edge only and the height↔content relationship is untouched.

import {
  DEVICE_CORNER_RADIUS,
  FLOAT_BOTTOM_RADIUS,
  FULL_SIDE_INSET,
  FULL_TOP_GAP,
  GRABBER,
  MEDIUM_BOTTOM_GAP,
  MEDIUM_SIDE_INSET,
  SCRIM_MAX_DARK,
  SHEET_RADIUS,
} from '@/components/maps-kit/sheetLook';

export {
  DEVICE_CORNER_RADIUS,
  FLOAT_BOTTOM_RADIUS,
  FULL_SIDE_INSET,
  FULL_TOP_GAP,
  MEDIUM_BOTTOM_GAP,
  MEDIUM_SIDE_INSET,
  SCRIM_MAX_DARK,
  SCRIM_MAX_LIGHT,
  scrimMaxFor,
  SHEET_H_PAD,
  SHEET_RADIUS,
  SHEET_SOLID_DARK,
  SHEET_SOLID_LIGHT,
  sheetSolidFor,
} from '@/components/maps-kit/sheetLook';

/**
 * Height of the search field — and the DEFAULT header height every function
 * here falls back to. It is a base, not a ceiling: MapSheet measures the real
 * header (`onLayout`) and re-derives the peek detent from that, so the row is
 * free to grow with Dynamic Type.
 *
 * 38, down from 40 (and 48 before that). Apple's own field was re-measured this
 * pass at a clear column of its collapsed bar — fill from 800.2 to 837.5, i.e.
 * 37.3 pt tall, inside a 64.9 pt card with a uniform 13.8 pt inset above and
 * below. Ours rendered 39.7 in a 67.8 pt card, so the bar was 2.9 pt fatter
 * than the reference; the whole difference was the field, since our two insets
 * measured 14.7 / 13.4 against Apple's 13.8 / 13.8.
 *
 * At 38 the card lands on 15 + 38 + 14 = 67 (measured ~65.8) against Apple's
 * 64.9 — inside a point.
 *
 * 38 is 6 under HIG's 44 pt minimum touch target and a point over Apple's own
 * 37.3: the search FIELD spans the row, so its hit area is ~370 × 38 and the
 * miss risk is vertical only. Kept deliberately, matching the reference.
 */
export const SEARCH_H = 38;
/**
 * The card's VERTICAL content inset — Apple's measured 13.8 above and below the
 * collapsed bar's search field, and the pad below every pinned header row.
 *
 * It used to double as the HORIZONTAL inset too, on the reading that Apple's
 * bar is padded uniformly on all four sides. Re-measuring says it is not: the
 * field's side inset is 15.3 against this 13.8, because the bar is a CAPSULE
 * and the field's own rounded end needs the extra clearance to nest inside the
 * ~32 pt arc rather than graze it. The horizontal inset is therefore its own
 * constant — `SHEET_H_PAD` in `sheetLook` — and this one is vertical only.
 */
export const CARD_PAD = 14;
// The grabber band, from the one look module. Re-exported under the names this
// sheet's callers already use rather than re-declared, so there is exactly one
// place a pill dimension can be changed.
/** Air between the card's top edge and the grabber pill (Apple 4.7). */
export const GRABBER_TOP_GAP = GRABBER.topGap;
/** Grabber pill size (Apple 50 × 4.3). Drawn OVER the card's top edge, taking
 *  no layout space — Apple's sits on the edge, not in a band of its own. */
export const GRABBER_W = GRABBER.w;
export const GRABBER_H = GRABBER.h;
/** Clear air between the grabber's bottom edge and the header row (Apple 5.3).
 *  At the old 2 pt the pill visibly grazed the search field's capsule. */
export const GRABBER_TO_FIELD = GRABBER.toContent;
/**
 * Padding ABOVE the header row. Not a free number: it is exactly the grabber
 * band — top gap + pill + clearance — which is how Apple's 14.3 top inset is
 * built (4.7 + 4.3 + 5.3). Ours lands on 15, one point off the 14 pt side
 * inset, which is inside optical tolerance.
 */
export const HEADER_PAD_TOP = GRABBER_TOP_GAP + GRABBER_H + GRABBER_TO_FIELD;
/** Padding BELOW the header row — the plain uniform inset (no grabber there). */
export const HEADER_PAD_BOTTOM = CARD_PAD;
/** Horizontal inset of the sheet card from the screen edges at PEEK (Apple 21.8). */
export const SHEET_SIDE_INSET = 22;
/** Corner radius of the DOCKED iPad column. A 38 pt radius belongs to a sheet
 *  edge-hugging a phone; on a 375 pt column it reads as a lozenge. */
export const DOCK_RADIUS = 20;
/**
 * Gap between the card's BOTTOM edge and the screen bottom at the peek detent
 * (Apple 21.8 — the same as the side insets, so the collapsed capsule has a
 * uniform margin). This is what makes the collapsed state a FREE-FLOATING
 * capsule rather than a bar glued to the bottom of the screen.
 */
export const PEEK_FLOAT = 22;
/** Drag distance (px) over which the capsule DETACHES: the float gap closes,
 *  the bottom corners square off and the gutter narrows to MEDIUM_SIDE_INSET. */
export const FLOAT_FADE = 80;
/**
 * THE middle detent, as a fraction of the window height — measured, and the
 * same for every sheet.
 *
 * Apple Maps settles BOTH of its sheets' middle detent with the card's top edge
 * at 486.2 pt on this 874 pt window: the root search sheet the moment Maps
 * opens, and a place card opened straight from a `maps://?q=` URL. Neither was
 * dragged there, so 486.2 is a declared detent and not a landing spot, and the
 * two agreeing to within 0.3 pt over completely different content says it is
 * one number rather than a per-sheet one.
 *
 *   (874 − 486.2) / 874 = 0.4436
 *
 * Both of the values this replaced were wrong in opposite directions: the home
 * sheet's 0.5 ("Apple's half sheet" — it is not half) put its top 49 pt too
 * high, and the tram card's 0.42, inherited from the detent its old native
 * `formSheet` happened to declare, put its top 21 pt too low.
 *
 * Lives here, with the rest of the snap math, so the pure layout tests can pin
 * it without importing a React component.
 */
export const MEDIUM_DETENT = 0.4436;
/** Middle detent of the TRAM CARD. */
export const CARD_DETENT = MEDIUM_DETENT;
/** Middle detent of the HOME sheet — and of the native route sheets that want
 *  to match it (`/favorites`, `/rides`), via `mediumDetentFraction`. */
export const HOME_DETENT = MEDIUM_DETENT;

/**
 * THE LAST LEG of the drag, as a 0 → 1 ramp: 0 at (and anywhere below) the
 * medium detent, 1 at the largest one.
 *
 * This is the single leg on which a sheet stops being "a taller card" and
 * becomes a MODE — it is what drives the world-dimming scrim, the glass → solid
 * surface crossfade (`CardShape.solid`) and, on the tram card, the floating
 * action pill's black → glass crossfade. Extracted out of `cardShapeFor` so
 * those three cannot drift apart, and so a caller that needs ONLY the ramp does
 * not have to invent a `peekCardH` to get it.
 *
 * A worklet: read on the UI thread every frame of a drag.
 */
export function lastLegFor(heightPx: number, snaps: number[]): number {
  'worklet';
  if (snaps.length === 0) return 0;
  const large = snaps[snaps.length - 1];
  const medium = snaps.length > 2 ? snaps[1] : large;
  if (large > medium) {
    const s = (heightPx - medium) / (large - medium);
    return s < 0 ? 0 : s > 1 ? 1 : s;
  }
  // Degenerate table (medium collapsed onto large on a very short window): the
  // leg has no length, so it is a step rather than a ramp.
  return heightPx >= medium ? 1 : 0;
}

export interface CardShape {
  /**
   * Points the card is lifted off the screen bottom (a transform — free), i.e.
   * the BOTTOM float gap: 22 at the bar, MEDIUM_BOTTOM_GAP at the half detent,
   * 0 (flush) at the largest one.
   */
  lift: number;
  /** Top corner radius: capsule at rest → SHEET_RADIUS once detached. */
  topRadius: number;
  /**
   * Bottom corner radius. FLOAT_BOTTOM_RADIUS (a measured 52.5) at every detent
   * that floats — except at the bar, where the card is a capsule and the radius
   * is half its height instead. At the largest detent the card is flush, so this
   * reaches the display's own 62 and the device mask does the rounding.
   */
  bottomRadius: number;
  /**
   * Horizontal inset: peek gutter (22) → MEDIUM_SIDE_INSET for the whole middle
   * of the drag → FULL_SIDE_INSET (0, edge to edge) over the last leg only.
   * Never below FULL_SIDE_INSET, so nothing can make the card wider than the
   * screen.
   */
  sideInset: number;
  /** Black-scrim opacity over the rest of the screen: 0 until the medium detent,
   *  `scrimMax` (the caller's appearance-resolved peak) at the largest one. */
  scrim: number;
  /**
   * Opacity of the SOLID fill that covers the glass on the last leg: 0 up to the
   * medium detent, 1 at the largest. Apple's fully-open card is an opaque gray
   * page, not a translucent one. Drawn as an overlay ABOVE the glass — never by
   * animating the glass's own alpha, which destroys the material (see
   * `sheetLook.ts` and MapSheet's `cardStyle`).
   */
  solid: number;
}

/**
 * The collapsed capsule → inset panel → full-screen transition, as one
 * continuous, monotonic function of the drag. Read by a worklet every frame:
 * `lift` is a transform and the radii/scrim are paint-only, so the card's
 * HEIGHT stays the single animated layout property (the side inset is a layout
 * prop, but the card is already re-laid-out for its height and its content is
 * absolutely positioned at a fixed size).
 *
 * THREE STAGES, matching Apple Maps:
 *   1. peek → peek+FLOAT_FADE — the capsule DETACHES: its 22 pt margin relaxes
 *      to Apple's half-detent float (MEDIUM_SIDE_INSET at the sides,
 *      MEDIUM_BOTTOM_GAP below — it never lands on the screen bottom), its top
 *      corners relax to SHEET_RADIUS and its bottom corners open from the
 *      capsule's h/2 to the measured FLOAT_BOTTOM_RADIUS.
 *   2. → the medium detent — nothing moves. A plateau, so the whole middle of
 *      the drag is one stable shape: Apple's half sheet is a card floating
 *      ~5 pt clear on all three free sides, with zero dim.
 *   3. medium → large — the card GOES EDGE TO EDGE: the side gutter and the
 *      bottom float both close to 0, the bottom corners open the rest of the way
 *      to the display's own 62 (so the device mask clips them),
 *      the world dims, and the surface crossfades from glass to a solid fill.
 *      The top radius is the one thing that does NOT move — Apple's is a
 *      constant 38 from the moment the card detaches.
 *
 * `snaps` is the live snap table (ascending); `peekCardH` is the card's own
 * height at rest (peek minus the float gap) — half of it is the capsule radius.
 *
 * `scrimMax` is the veil's peak opacity, which is APPEARANCE-DEPENDENT because
 * UIKit's own is (0.50 dark / 0.20 light — measured off a native route sheet;
 * see `sheetLook.ts`). Callers resolve it with `scrimMaxFor(appearance)`; omit
 * it and you get the dark peak, so the only way to get the wrong veil is to
 * render a light sheet without asking, and every caller that draws one asks.
 *
 * PLATFORM QUIRK, learned the hard way: the fallback is resolved in the BODY,
 * not as a `scrimMax = SCRIM_MAX_DARK` default parameter. Reanimated's plugin
 * captures the identifiers a worklet's BODY closes over; one that appears only
 * in a default-parameter expression is not captured, and the worklet dies on
 * the UI thread with "Property 'SCRIM_MAX_DARK' doesn't exist" the first frame
 * the sheet is dragged. (Verified on device, then fixed by this line.)
 */
export function cardShapeFor(
  heightPx: number,
  snaps: number[],
  peekCardH: number,
  scrimMax?: number,
): CardShape {
  'worklet';
  const veil = scrimMax === undefined ? SCRIM_MAX_DARK : scrimMax;
  const capsule = peekCardH / 2;
  if (snaps.length === 0) {
    // The degenerate case resolves to the HALF detent's shape, not the full
    // one: an un-laid-out sheet that flashed edge-to-edge (or worse, dimmed and
    // went opaque) for a frame is exactly the artifact being removed. A
    // floating, glass, undimmed card is the safe thing to show for one frame.
    return {
      lift: MEDIUM_BOTTOM_GAP,
      topRadius: SHEET_RADIUS,
      bottomRadius: FLOAT_BOTTOM_RADIUS,
      sideInset: MEDIUM_SIDE_INSET,
      scrim: 0,
      solid: 0,
    };
  }
  const peek = snaps[0];
  const large = snaps[snaps.length - 1];
  const medium = snaps.length > 2 ? snaps[1] : large;

  // Stage 1. Never overrun the medium detent, so a short window (where medium
  // sits less than FLOAT_FADE above peek) still finishes detaching by then.
  const fade = Math.max(1, Math.min(FLOAT_FADE, medium - peek));
  const t = (heightPx - peek) / fade;
  const k = 1 - (t < 0 ? 0 : t > 1 ? 1 : t); // 1 at rest → 0 once attached

  // Stage 3. Below the medium detent this is flat 0, so stages 1 and 2 are
  // untouched by it and every value stays monotonic in height. Shared with the
  // tram card's action pill through `lastLegFor` — one ramp, three consumers.
  const u = lastLegFor(heightPx, snaps);

  // THE GUTTER and THE FLOAT are the same two-stage blend, written the same way:
  // stage 1 (k) relaxes the peek margin to the half detent's, stage 3 (u) closes
  // the half detent's to the full one's. `k` is 0 by the time `u` leaves 0, so
  // the two never fight and every value is monotonic in height.
  const gutter =
    (MEDIUM_SIDE_INSET + (SHEET_SIDE_INSET - MEDIUM_SIDE_INSET) * k) * (1 - u) +
    FULL_SIDE_INSET * u;
  // `Math.max` is the hard floor: no drag, no overshoot, no rounding may make
  // the card wider than the screen.
  const sideInset = Math.max(FULL_SIDE_INSET, gutter);
  const lift = (MEDIUM_BOTTOM_GAP + (PEEK_FLOAT - MEDIUM_BOTTOM_GAP) * k) * (1 - u);

  // Bottom corners: the measured FLOAT_BOTTOM_RADIUS at the half detent,
  // opening to the display's own 62 as the card goes flush — except at the bar,
  // where the card IS a capsule and the radius is half its own height. On a card
  // taller than 2 × FLOAT_BOTTOM_RADIUS the capsule radius is the larger and
  // this eases DOWNWARDS across stage 1; that is correct (a fat capsule
  // un-rounding onto the frame) and only reachable with a very tall header.
  const openBottom = FLOAT_BOTTOM_RADIUS;
  const bottomRadius =
    (openBottom + (capsule - openBottom) * k) * (1 - u) + DEVICE_CORNER_RADIUS * u;

  return {
    lift,
    topRadius: SHEET_RADIUS + (capsule - SHEET_RADIUS) * k,
    bottomRadius,
    sideInset,
    scrim: veil * u,
    // The glass → solid crossfade rides the same last leg as the scrim: the two
    // together are what turn "a taller sheet" into "a different mode".
    solid: u,
  };
}
/**
 * Air between the sheet's top edge and the map chrome riding above it. Apple
 * Maps leaves a clear gap so controls never look glued to the sheet.
 */
export const CHROME_GAP = 14;

/**
 * Width (pt) at/above which the sheet becomes a DOCKED SIDE COLUMN regardless of
 * orientation — 768 is the iPad portrait width. An iPad Slide Over window (~320)
 * correctly stays below it and keeps the compact bottom sheet.
 */
export const REGULAR_WIDTH_MIN = 768;
/** Width of the collapsible iPad side sheet. */
export const DOCK_WIDTH = 375;
/** Inset of the docked column from the screen edges. */
export const DOCK_INSET = 16;
/**
 * Legacy export retained for native-sheet geometry consumers. The owned iPad
 * sheet now has the same grabber band as the phone sheet, so it needs no extra
 * header padding of its own.
 */
export const DOCK_TOP_EXTRA = 8;

export interface SheetEnv {
  windowWidth: number;
  windowHeight: number;
  /** Safe-area inset at the top (status bar / notch). */
  insetTop: number;
  /** Safe-area inset at the bottom (home indicator). */
  insetBottom: number;
}

/**
 * True when the sheet should present as a narrow SIDE SHEET rather than a
 * full-width bottom sheet. It still has the same vertical detents and drag
 * gesture as the phone sheet; "docked" describes width/placement, not a locked
 * interaction state.
 *
 *  • regular width (iPad): a full-width bottom sheet on a 1024 pt canvas is a
 *    vast, mostly empty slab, and the search field stretched across it read as
 *    broken. A narrow docked column keeps the map the subject.
 *  • LANDSCAPE anything (including an iPhone on its side): a bottom sheet eats
 *    the short axis, leaving a letterbox of map. Apple Maps docks left here too.
 */
export function isDocked({
  windowWidth,
  windowHeight,
}: Pick<SheetEnv, 'windowWidth' | 'windowHeight'>): boolean {
  return windowWidth >= REGULAR_WIDTH_MIN || windowWidth > windowHeight;
}

/**
 * Resting height (px) of the peek detent — the pinned header row only, clearing
 * the home indicator. This is also the map chrome's static base: the control
 * column and chip cluster sit CHROME_GAP above it.
 *
 * `headerH` varies with what the header currently IS: the search row (SEARCH_H)
 * or the taller follow mini-card that replaces it while a tram is followed.
 *
 * This is the card body PLUS the float gap below it, so the header block exactly
 * fills the visible card at rest and no body content peeks under the search row.
 * The home-indicator inset is deliberately NOT added: Apple Maps' collapsed bar
 * floats over that band rather than clearing it (its 23 pt gap sits inside the
 * 34 pt inset), and adding it left a tall empty strip of sheet below the row.
 *
 * With the default header this is 15 + 40 + 14 + 22 = 91, i.e. a 69 pt card
 * floating 22 pt off the bottom — within 1.8 pt of Apple's measured 67.2, with
 * Apple's own insets around it. (It used to be a 77 pt card, because the search
 * field was 48 rather than Apple's 39–42.7.)
 */
export function peekHeight(
  _env: Pick<SheetEnv, 'insetBottom'>,
  headerH: number = SEARCH_H,
): number {
  return peekCardHeight(headerH) + PEEK_FLOAT;
}

/** Height of the card itself at rest (no float gap). Half of it is the capsule
 *  radius. The top pad is the grabber band, the bottom pad the uniform inset. */
export function peekCardHeight(headerH: number = SEARCH_H): number {
  return HEADER_PAD_TOP + headerH + HEADER_PAD_BOTTOM;
}

/**
 * Snap heights (px) in ascending order: peek → medium → large.
 *
 * `large` stops short of the very top by the status-bar inset PLUS FULL_TOP_GAP,
 * so the sheet reads as a card under the status bar rather than a full-screen
 * takeover (iOS 26 sheets). That gap is measured, not chosen: Apple's full place
 * sheet tops out at y = 111.83 on a device reporting a 62 pt top inset ⇒ 50 of
 * clear band, giving a 762 pt card. Ours used 10, which put the top at 72 —
 * 50 pt too tall, and the reason the full detent read as a takeover, not a card.
 * On iPad the largest detent is capped by the side sheet's inset container, but
 * peek and medium remain available. The old single-height special case made
 * the panel impossible to dismiss and left half the app permanently covered.
 *
 * `mediumFraction` is the middle detent as a fraction of the window height. The
 * home sheet and the TRAM CARD now both land on the measured MEDIUM_DETENT, so
 * it is the same number twice — but it stays a parameter rather than becoming a
 * constant read inside, because
 * everything else about the two sheets' geometry — peek from the measured
 * header, the full detent, the shape morph — must stay literally identical: the
 * bar IS the tram sheet's smallest detent, and it has to be built by the same
 * math that builds the home sheet's.
 */
export function snapHeights(
  env: SheetEnv,
  headerH: number = SEARCH_H,
  mediumFraction: number = HOME_DETENT,
): number[] {
  const { windowHeight, insetTop } = env;
  const peek = peekHeight(env, headerH);
  const large = Math.max(
    peek,
    isDocked(env)
      ? windowHeight - insetTop - DOCK_INSET * 2
      : windowHeight - insetTop - FULL_TOP_GAP,
  );
  const medium = Math.max(peek, Math.min(large, windowHeight * mediumFraction));
  // Dedupe (a very short window can collapse medium onto peek/large) while
  // keeping ascending order — the snap picker assumes strictly sorted values.
  return Array.from(new Set([peek, medium, large])).sort((a, b) => a - b);
}

// ── NATIVE formSheet detents ────────────────────────────────────────────────
// The route sheets (/search, /settings, /line, …) are UIKit `formSheet`s, and
// their detents are declared as FRACTIONS OF `maximumDetentValue`, not of the
// window (react-native-screens `detentsFromMaxHeightFractions`,
// RNSScreen.mm:1093). `maximumDetentValue` is UIKit's, not ours, so the same
// number means different heights on the two sheet families — which is precisely
// how a native sheet at "0.95" ended up 21 pt taller than the owned sheet's
// large detent while both claimed to be "nearly full".
//
// These two functions are the translation layer: callers state the height they
// want in the OWNED sheet's terms (window fractions, the measured full top gap)
// and get back the UIKit fraction that produces it. Pure, so jest pins them.

/**
 * The band UIKit reserves above a `formSheet` at its LARGEST detent, i.e.
 * `windowHeight − maximumDetentValue`.
 *
 * MEASURED on the reference device (iPhone 16 Pro, 874 pt tall, iOS 26): a
 * sheet declaring 0.95 settles with its top edge at 100.8 pt, so
 * `0.95 × maximumDetentValue = 874 − 100.8 = 773.2` ⇒ `maximumDetentValue =
 * 813.9` ⇒ a reserve of 60.1. Treated as a constant band rather than a fraction
 * because that is what it behaves like: it is UIKit's fixed top gap for a sheet,
 * not a proportion of the screen.
 */
export const SHEET_MAX_DETENT_RESERVE = 60;

/** `maximumDetentValue` — the height a native sheet gets at fraction 1.0. */
function maxDetent(windowHeight: number): number {
  return Math.max(1, windowHeight - SHEET_MAX_DETENT_RESERVE);
}

/** Clamp into the (0, 1] range UIKit accepts for a custom detent fraction. */
function detentFraction(value: number): number {
  return Math.min(1, Math.max(0.05, value));
}

/**
 * The native fraction whose sheet top lands on the OWNED sheet's large detent —
 * `insetTop + FULL_TOP_GAP` below the screen top, the same expression
 * `snapHeights` uses. On the reference device: (874 − 62 − 50) / 814 = 0.9361,
 * i.e. a 762 pt sheet topping out at 112 pt, against the owned sheet's 112.
 *
 * Derived per-device from the live window and safe area rather than baked in, so
 * the two families track each other on any screen.
 */
export function largeDetentFraction(windowHeight: number, insetTop: number): number {
  return detentFraction((windowHeight - insetTop - FULL_TOP_GAP) / maxDetent(windowHeight));
}

/**
 * The native fraction that reproduces a WINDOW fraction — so a route asking for
 * "half" gets the same edge as the owned sheet's `mediumFraction` half, instead
 * of half of UIKit's smaller `maximumDetentValue` (which came out 30 pt lower).
 */
export function mediumDetentFraction(windowHeight: number, windowFraction: number): number {
  return detentFraction((windowHeight * windowFraction) / maxDetent(windowHeight));
}

export interface ChromeRide {
  /**
   * Distance (px) from the WINDOW BOTTOM to the map chrome's bottom edge — i.e.
   * the chrome sits exactly CHROME_GAP above the sheet's top edge. An absolute
   * offset rather than a shift-from-peek so the chrome can never drift out of
   * sync with the sheet when the header (and therefore the peek height) changes.
   */
  offset: number;
}

/**
 * The map chrome's continuous response to the sheet height — read by a worklet
 * EVERY FRAME of the drag, so the bottom-right control column and the chip
 * cluster travel WITH the sheet instead of jumping once a detent settles.
 *
 * - Between peek and medium the chrome rides up 1:1 with the sheet edge.
 * - Past medium it PARKS (riding all the way up would shove the controls under
 *   the status bar) and the sheet, which keeps growing, simply covers it —
 *   fully, by the large detent, where the card is edge to edge and opaque.
 *   There is deliberately no opacity here: every cluster the offset drives is
 *   made of GlassPanels, and animating a glass view's (or an ancestor's) alpha
 *   destroys the material — see `useChromeRide` in `MapChrome`.
 * - On a docked iPad column the chrome sits at the bottom of the map area: the
 *   sheet is beside the map, not over it, so there is nothing to ride.
 */
export function chromeRideFor(heightPx: number, snaps: number[], docked: boolean): ChromeRide {
  'worklet';
  if (docked || snaps.length === 0) return { offset: DOCK_INSET + CHROME_GAP };
  const peek = snaps[0];
  // With only one snap there is nothing to ride.
  if (snaps.length === 1) return { offset: peek + CHROME_GAP };
  const large = snaps[snaps.length - 1];
  const medium = snaps.length > 2 ? snaps[1] : large;

  const edge = heightPx < peek ? peek : heightPx > medium ? medium : heightPx;

  return { offset: edge + CHROME_GAP };
}

/**
 * Index of the snap the sheet should settle on after a drag, given the release
 * height and the fling velocity (px/s, positive = downward). The velocity is
 * projected forward so a flick carries past the nearest snap, which is what
 * makes a sheet feel native rather than sticky.
 */
export function snapIndexFor(heightPx: number, velocityY: number, snaps: number[]): number {
  'worklet';
  if (snaps.length === 0) return 0;
  // 0.08 s of projected travel: enough that a deliberate flick skips a detent,
  // small enough that a slow drag still lands on the nearest one.
  const projected = heightPx - velocityY * 0.08;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < snaps.length; i++) {
    const d = snaps[i] - projected;
    const abs = d < 0 ? -d : d;
    if (abs < bestDist) {
      bestDist = abs;
      best = i;
    }
  }
  return best;
}

/**
 * Rubber-banding past the snap range so the sheet never rips off its rails:
 * resistance is stronger below the peek (the sheet must not be draggable away —
 * peek is its resting state, not "closed") than above the large detent.
 */
export function rubberBand(heightPx: number, snaps: number[]): number {
  'worklet';
  if (snaps.length === 0) return heightPx;
  const min = snaps[0];
  const max = snaps[snaps.length - 1];
  if (heightPx < min) return min - (min - heightPx) * 0.25;
  if (heightPx > max) return max + (heightPx - max) * 0.15;
  return heightPx;
}
