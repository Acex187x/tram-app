// THE single source of sheet LOOK-AND-FEEL. Every sheet in the app — the owned
// Reanimated home sheet (`MapSheet`), the router `formSheet` options factory in
// `src/app/_layout.tsx`, and the `SheetSurface`/`SheetHeader` primitives — must
// read its geometry from here. Before this module the same numbers were
// re-typed in four places and drifted apart: the home sheet rounded at 38 while
// the native sheets rounded at 24, and the home sheet's fully-open state went
// FULL BLEED while every native one kept Apple's gutter.
//
// ── PROVENANCE ──────────────────────────────────────────────────────────────
// Measured off Apple Maps' PLACE CARD on iOS 26 (iPhone 16 Pro, 402 × 874 pt,
// screenshots at @3). Method: decode the PNG and find the card two independent
// ways — the brightness STEP its glass makes over the map, and the SHARPNESS
// DROP it causes (glass blurs what is behind it). Sub-pixel edge fits, then / 3.
//
// RE-MEASURED END TO END by the parity pass (Apple Maps, iOS 26, same device,
// one session, every number below read off a screenshot rather than inherited):
//
//   bar     card 786.4 → 851.3 (h 64.9); margins 22.5 L / 22.6 R / 22.7 bottom;
//           corner fits R 32.25 (bottom) / 32.75 (top) against h/2 = 32.45 → a
//           TRUE CAPSULE, NOT frame-concentric. Content: a 37.3 pt search field
//           with a UNIFORM 13.8 pt inset above and below it.
//   half    top 486.2 — and the SAME 486.2 for the root search sheet and for a
//           place card, i.e. one detent, not a per-sheet one; insets 5.9 L /
//           5.9 R / 5.9 bottom; top r 35.75; bottom r 52.00 (rms 0.207, n=177),
//           which is 4 pt TIGHTER than concentric. ZERO dim (the pixels above
//           the card are identical to the collapsed state).
//   full    top 111.83 (card height 762.2); insets 0 (edge to edge, flush at
//           the bottom, the display mask doing the rounding); top r 38.00
//           (rms 0.398); the world DIMS by α = 0.527; and the SURFACE stops
//           being glass — a flat opaque fill, (24,29,21) ⇒ luma 27.5 against
//           our #1C1C1E's 28.2.
//
// ── THE THREE STATES, AS ONE RULE ───────────────────────────────────────────
// Every number above falls out of a single model, which is what this module
// encodes and what `cardShapeFor` interpolates between:
//
//   • the card FLOATS by `gap` on the sides and the bottom: 22 at the bar,
//     5.3 / 5.5 at half, 0 at full;
//   • its BOTTOM radius is FLOAT_BOTTOM_RADIUS while it floats, opening to the
//     display's own DEVICE_CORNER_RADIUS as it goes flush — except at the bar,
//     where the whole card is a capsule and the radius is half its height;
//   • its TOP radius is a constant 38 from the moment it detaches;
//   • nothing dims until it leaves the half detent, and the last leg is the
//     ONLY one that changes the material.
//
// An earlier pass froze the silhouette at half all the way to full (a 5 pt
// gutter at the largest detent) on the reading that the user wanted a gap
// there. That was wrong in the other direction — a fully open sheet that keeps
// a gutter and stops short of the screen edges is not what Apple draws and not
// what the user asked for. The measurement was right the first time: at FULL,
// Apple goes edge to edge and the display's corner mask does the rounding.

/**
 * Corner radius of an OPEN sheet card. Constant across every detent — Apple's
 * top corners measure 37.5 at half and 38 at full, i.e. the shape morph from
 * the collapsed capsule reads as the card DETACHING, never as it re-rounding.
 * Native `formSheet` routes should pass this as `sheetCornerRadius`.
 */
export const SHEET_RADIUS = 38;

/**
 * THE horizontal content inset — the single left/right edge every sheet in the
 * app hangs its content on, owned (`MapSheet`, the tram card) and native
 * (`SheetSurface` route sheets) alike. Measured from the SHEET CARD's edge, so
 * it composes with whatever gutter the card itself currently has (22 at the
 * bar, 5.3 at half, 0 at full).
 *
 * ── WHY 16, AND WHY IT IS NOT `CARD_PAD` ────────────────────────────────────
 * Three independent Apple surfaces on this device (iPhone 16 Pro, iOS 26,
 * 402 pt) agree on it, measured by band-averaged luma steps at @3:
 *
 *   iOS Settings, root insetGrouped list   group card left edge   16.00
 *   Apple Maps place card @ full           Directions capsule     16.00
 *                                          photo rail             16.00
 *   Apple Maps collapsed bar               search field           15.3 from
 *                                                                 the card edge
 *
 * The last one is the CORNER-AWARE half of it: the bar is a capsule whose ends
 * are ~32 pt arcs, and Apple gives the field 15.3 horizontally against only
 * 13.8 vertically. The extra 1.5 pt is exactly the clearance the field's own
 * rounded end needs so it nests inside the capsule's arc instead of grazing it.
 * That is why this is a SEPARATE constant from `CARD_PAD` (the 14 pt VERTICAL
 * inset) rather than the same number reused: Apple's own two insets differ, and
 * for a geometric reason, not a stylistic one.
 *
 * ── WHAT IT REPLACES ────────────────────────────────────────────────────────
 * Before this pass the app had FOUR different content insets, and two of them
 * were inside a single sheet. Measured off the tram card (card edge at 5.3):
 *
 *   header portrait          19.33 pt  ⇒ card + 14   (CARD_PAD)
 *   "Following" action row   25.33 pt  ⇒ card + 20   (TramSheet's own `column`)
 *   upcoming-stops timeline  27.33 pt  ⇒ card + 22
 *   "UPCOMING STOPS" label   42.33 pt  ⇒ card + 37   (20 + SectionLabel's 16)
 *
 * — four left edges in one card, which is what the user reported as things not
 * lining up. The native route sheets were on 20 (`SheetSurface`) while the home
 * sheet was on 14, so the two families did not agree either, and it showed the
 * moment a route sheet was presented over the home sheet.
 */
export const SHEET_H_PAD = 16;

/**
 * Horizontal gap the sheet keeps from the screen edges at the HALF detent
 * (Apple 5.2 L / 5.5 R → 5.3). A half-open sheet is a floating card, not a slab.
 */
export const MEDIUM_SIDE_INSET = 5.3;

/**
 * Gap between the card's BOTTOM edge and the screen bottom at the HALF detent
 * (Apple 5.5). Apple's half sheet floats on ALL THREE free sides, not just the
 * two vertical ones — this is the number that makes it a card rather than a
 * panel welded to the bottom of the display, and it is what `bottomRadius`
 * below is concentric with.
 *
 * It was deferred once, on the grounds that closing the float gap changes the
 * height↔content relationship the peek model is built on. It does not: the card
 * is bottom-anchored and its box is `heightSV − lift` tall with a `−lift`
 * translation, so the TOP edge stays at `windowHeight − heightSV` whatever the
 * lift is. Only the bottom edge moves.
 */
export const MEDIUM_BOTTOM_GAP = 5.5;

/**
 * Horizontal gap at the FULL detent: ZERO — edge to edge, exactly as measured
 * (insetL 0.12 / insetR 0.45 on Apple's own card, i.e. flush within a rounding
 * error) and exactly what the user asks for. The bottom goes flush at the same
 * time and the bottom corners open to the display's own radius, so the card is
 * clipped by the device frame instead of drawing its own rounding inside it.
 *
 * ── AND THE NATIVE ROUTE SHEETS NOW MATCH ───────────────────────────────────
 * UIKit gives an iOS 26 `formSheet` a gutter of its own and CLOSES IT as the
 * sheet rises. Measured on this device (sub-pixel rim fits, one sheet per row,
 * the sheet's top edge in pt):
 *
 *   top 481 (/line, 0.45)      insetL 5.03  insetR 5.29
 *   top 393 (/settings, 0.55)  insetL 2.80  insetR 2.90
 *   top 122 (either, at full)  insetL 0.12  insetR 0.45   ← flush, dark & light
 *
 * That is precisely the curve this module now describes: ~5 pt of float at the
 * partial detents, flush at the largest one. Before this pass the owned sheets
 * froze their gutter at 5 pt and were the family that did NOT match; with
 * `FULL_SIDE_INSET = 0` the two behave identically at every detent.
 */
export const FULL_SIDE_INSET = 0;

/**
 * Air between the SAFE-AREA top and the fully-open sheet's top edge.
 *
 * MEASURED 111.83 pt, on a device whose `insets.top` is 62 ⇒ 50.
 *
 * ── WHY THIS MOVED 60 → 50, AND WHY APPLE APPEARS TO GIVE TWO ANSWERS ───────
 * The parity pass measured Apple Maps' two sheets at their largest detent on
 * the same device in the same session and got two different tops:
 *
 *   root SEARCH sheet, alone on screen        top 111.83   dim α 0.527
 *   PLACE CARD, over that same search sheet   top 101.83   dim α 0.775
 *
 * The second is not a second detent — it is the FIRST ONE STACKED. Two of
 * Apple's own veils multiply to 1 − (1 − 0.527)² = 0.776, which is the 0.775
 * measured behind the place card to three decimals, so the card is provably
 * sitting on top of a search sheet that is itself fully open; UIKit's sheet
 * stacking then lifts the front card by a further 10 pt. Our sheets are never
 * stacked (the home sheet slides off stage while the tram card is up), so the
 * SINGLE-SHEET number is ours, and it is 111.83.
 *
 * The 121.8 this constant used to be built on came from a place card measured
 * in an earlier session; whatever it was measuring, both of today's readings
 * are above it, i.e. the old value made our fully-open sheet ~10 pt too short.
 *
 * That band is what makes a full sheet read as a CARD UNDER the status bar
 * rather than a full-screen takeover. An even earlier value was 10, which put
 * the card top at 72 — a takeover, not a card.
 */
export const FULL_TOP_GAP = 50;

/**
 * The display's own corner radius on the reference device (iPhone 16 Pro).
 * A card whose bottom edge is FLUSH takes the full 62: the display mask then
 * clips exactly along its own corner and there is no visible rounding of our
 * own inside it.
 *
 * NOT a "safe" radius for the sheet's glass, which is what it used to double as:
 * see the surface-material notes at the bottom of this file.
 */
export const DEVICE_CORNER_RADIUS = 62;

/**
 * Bottom corner radius while the card FLOATS clear of the screen bottom.
 *
 * MEASURED, not derived. Apple's half-detent place card fits a circle of
 * R = 52.00 (rms 0.207 over n = 177 rim rows) at a bottom gap of 5.9, where the
 * concentric rule this file used to state — `DEVICE_CORNER_RADIUS − gap` = 56.1
 * — is 4 pt too open. Ours rendered 55.75 against Apple's 52.00 and that 3.75 pt
 * is visible as the arc starting further along the bottom edge.
 *
 * So the card's bottom corner is TIGHTER than the display's, not concentric
 * with it: the hairline of map in the corner is a shade wider than the hairline
 * along the straight edges. Declared 52.5 rather than 52.0 because the renderer
 * measures back ~0.75 low (our declared 56.5 fitted at 55.75), which lands the
 * drawn arc on Apple's 52.0.
 *
 * A flat constant rather than a function of the gap: only ONE gap was ever
 * observed, so any `f(gap)` would be an inference dressed as a measurement.
 * `cardShapeFor` interpolates from here to DEVICE_CORNER_RADIUS as the card
 * goes flush, which is the only other point that has been measured.
 */
export const FLOAT_BOTTOM_RADIUS = 52.5;

/**
 * Peak opacity of the black scrim over the world at the largest detent — the
 * ONLY thing that changes on the last leg, and therefore the only thing that
 * makes "full screen" a different mode rather than just a taller sheet.
 *
 * NOTHING dims below full: verified twice — Apple's own card (the pixels above
 * a half-open place card are byte-identical to the collapsed state) and our
 * native route sheets (the map band above /settings at its 0.55 detent reads
 * 70.95 against 71.49 undimmed, i.e. no veil at all).
 *
 * The two values are MEASURED OFF UIKIT'S OWN DIMMING VIEW, not chosen: the
 * same map band above a native `formSheet` dragged to full, against the same
 * band with the sheet away, on this device —
 *
 *   dark   68.65 → 33.21 · 76.79 → 39.68 · 65.69 → 33.01 · 65.68 → 32.43
 *          ⇒ α = 0.516 / 0.483 / 0.498 / 0.506 → 0.50, flat across the band
 *   light  64.05 → 51.22 · 76.22 → 60.79 · 62.32 → 49.90 · 57.69 → 45.92
 *          ⇒ α = 0.200 / 0.202 / 0.199 / 0.204 → 0.20, flat across the band
 *
 * Flat within ±0.02 at every height sampled, so UIKit's veil is a plain black
 * fill and ours (also a plain black fill) can match it exactly — the earlier
 * note that Apple's is a gradient came from a place card, whose material sits
 * over the veil. It is emphatically NOT one number: a single 0.28 was HALF the
 * system's dim in dark and 40% too strong in light, which is why the map read
 * as darkening much harder behind a route sheet than behind the home/tram card.
 *
 * `scrimMaxFor` is the only way to read them, so no caller can forget the split.
 */
export const SCRIM_MAX_DARK = 0.5;
/** Light-appearance twin of `SCRIM_MAX_DARK` — UIKit's measured 0.20. */
export const SCRIM_MAX_LIGHT = 0.2;

/**
 * The scrim's peak opacity for an appearance — the ONE way to read the split.
 *
 * Resolved on the JS thread at render (the appearance is a React value that
 * changes only with the system scheme) and handed to `cardShapeFor` as a plain
 * number, so nothing per-frame ever has to know about appearances. Marked a
 * worklet anyway so a future UI-thread caller cannot become a crash.
 */
export function scrimMaxFor(appearance: 'light' | 'dark'): number {
  'worklet';
  return appearance === 'dark' ? SCRIM_MAX_DARK : SCRIM_MAX_LIGHT;
}

/**
 * The FULL detent's surface fill. Apple's fully-open place card is NOT Liquid
 * Glass: sampled across two plain background bands of the dark reference shot it
 * is a flat, opaque gray — (33, 35, 37) and (32, 35, 35), i.e. no map, no blur,
 * no per-pixel variation beyond dithering. (The greenish +3 on G is the last of
 * the basemap showing through; the neutral system token is the honest reading.)
 *
 * So the last leg does two things, not one: the world dims AND the sheet stops
 * being glass. That second half is what makes a fully-open sheet read as a
 * MODE — a page you are in — rather than a very tall floating card.
 *
 * ── HOW IT IS APPLIED, AND THE ONE WAY IT MUST NOT BE ───────────────────────
 * As an OPAQUE OVERLAY ABOVE the glass, whose own opacity is animated 0 → 1.
 * NEVER by animating the glass's opacity: the glass is a native
 * UIVisualEffectView (a UIGlassEffect one on iOS 26) and UIKit leaves its
 * rendering undefined at any alpha below 1 — a round trip through fractional
 * alpha is the documented way to lose the material permanently, and it is
 * exactly the defect that made the home sheet come back as a clear hole.
 */
export const SHEET_SOLID_DARK = '#1C1C1E';
/** Light-appearance twin — iOS's `secondarySystemBackground`. */
export const SHEET_SOLID_LIGHT = '#F2F2F7';

/** The full detent's surface fill for an appearance. The ONE way to read it. */
export function sheetSolidFor(appearance: 'light' | 'dark'): string {
  'worklet';
  return appearance === 'dark' ? SHEET_SOLID_DARK : SHEET_SOLID_LIGHT;
}

/**
 * The grabber pill. Drawn OVER the card's top edge (absolutely positioned), so
 * it takes NO layout space — Apple's sits on the edge, not in a band of its own.
 * `topGap` + `h` + `toContent` is exactly Apple's 14.3 pt top content inset,
 * which is why the sheet's top padding is built from these three rather than
 * chosen: 5 + 5 + 5 = 15 against Apple's 4.7 + 4.3 + 5.3 = 14.3.
 */
export const GRABBER = {
  /** Apple 50. */
  w: 50,
  /** Apple 4.3 — rounded up so the pill survives a 1 px hairline at @3. */
  h: 5,
  /** Air above the pill, from the card's top edge (Apple 4.7). */
  topGap: 5,
  /** Clear air BELOW the pill, before the header row (Apple 5.3). At the old
   *  2 pt the pill visibly grazed the search field's capsule. */
  toContent: 5,
  /** iOS's own grabber tint — `separator`-weight fill, legible on glass in both
   *  appearances without needing a per-scheme branch. */
  color: 'rgba(120,120,128,0.45)',
} as const;

/**
 * The FLOATING ACTION PILL Apple Maps hangs over its place card — a centred
 * glass capsule of circular icon buttons that overlays the SCROLLING content
 * (photos scroll under it at half, the reviews heading at full) and disappears
 * at the collapsed bar.
 *
 * Measured off the Prague Castle place card on the same device:
 *   height 47.0, radius 23.5 (r = h/2 — a true capsule, verified sub-pixel),
 *   width 157.8 for THREE buttons, centre-to-centre spacing 54.7, and the
 *   capsule's end to the first icon centre 24.0. Its bottom edge sits 27.0 above
 *   the CARD's bottom edge at half and 28.7 at full — i.e. it hangs off the
 *   card, not off the window, and therefore rides the card's float lift for
 *   free. Glyphs measure ~17 across.
 *
 * ── AND IT IS NEVER BLACK ───────────────────────────────────────────────────
 * `fill` below is the one number this pass changed, and it was measured rather
 * than picked. Apple's own pill, sampled across its interior at @3:
 *
 *   over the photo rail (card detent)   rgb 28,34,39 … 41,42,47   luma 33–42
 *   over the solid page (full detent)   rgb 27,29,27              luma 28.55
 *                                       …against a page of 27.9  ⇒ +0.6
 *
 * So it is ONE dark-gray glass at every detent: essentially invisible against
 * the opaque page at full, and a translucent gray — never lower than luma 33 —
 * over live content at the card detent. Ours was `#000000`, sampled at a flat
 * luma 0.00, which is the "сильно чёрный" report: a hard black slab where Apple
 * has a gray one you can still see the timeline through.
 *
 * `fill` therefore paints the NON-glass end of the crossfade as a dark gray
 * that is still translucent, so the glass and the content behind it keep
 * showing through the way Apple's does. It is deliberately expressed as an rgba
 * fill on a plain sibling view: the glass's own alpha must never be animated
 * (the UIVisualEffectView hazard documented above), so the crossfade stays two
 * stacked backgrounds with only the opaque one's opacity moving.
 */
export const ACTION_PILL = {
  /** Apple 47.0. */
  h: 47,
  /** Apple 54.7 — button centre to button centre. */
  gap: 54.7,
  /** Apple 24.0 — capsule end to the first button's centre. */
  endInset: 24,
  /** Apple ~17 pt glyph width. */
  glyph: 17,
  /** Apple 27.0 (half) / 28.7 (full), from the pill's bottom to the CARD's. */
  fromCardBottom: 28,
  /**
   * The pill's NON-glass fill — iOS's `systemGray6` elevated dark (#2C2C2E,
   * luma 44.1) held at 0.82, which composites over our own dark glass into
   * Apple's measured 33–42 band instead of the flat 0 a black capsule gave.
   * Still translucent, so the scrolling content reads faintly through it.
   */
  fill: 'rgba(44,44,46,0.82)',
} as const;

// ── SURFACE MATERIAL ────────────────────────────────────────────────────────
// Notes rather than constants, because the material is expressed differently by
// the owned sheet (a React child) and by the native ones (screen options). Both
// must land in the same place:
//
//  • The sheet body is REAL Liquid Glass (`GlassPanel variant="regular"`), as a
//    SIBLING behind the content, never a wrapper — a wrapper would drag the
//    whole scrolling subtree into the glass's compositing pass.
//  • The glass's OWN corner radii must EQUAL the card's, frame by frame — the
//    sheet animates them onto it (`MapSheet`'s `glassStyle`) rather than parking
//    a constant there. The rule, learned by getting it wrong twice:
//      – the visible silhouette is the INTERSECTION of the card's clip and the
//        glass's rounded rect, and on a shared box the BIGGER radius is the
//        TIGHTER shape (a 62 pt arc cuts further into the corner than a 38 pt
//        one). So a glass rounder than the card OWNS the silhouette. The old
//        `borderRadius: DEVICE_CORNER_RADIUS` was chosen on the opposite belief
//        ("≥ the card's radius ⇒ the card's clip always wins") and cost the
//        entire corner shape at the floating medium detent: the card asked for
//        38 top / 52.5 bottom and the screen drew 62 on all four. It was masked
//        at both ends of the drag — at the bar CALayer clamps 62 to h/2, which
//        is the card's capsule, and at full the opaque solid overlay covers the
//        glass and is clipped by the card alone — so only the most-used detent
//        was wrong;
//      – a glass FLATTER than the card (`GlassPanel`'s default 20, or 0) is not
//        safe either. The card then clips it correctly, but the glass's specular
//        RIM runs along its own flatter path and is cut away in the corners,
//        leaving them unlit: the "crooked, uneven frames" / "the ends are
//        straight" reports. Measured A/B on the same bar over the same map: with
//        the glass at 0 the rim fits a rounded rect of R = 33.5 (rms 0.27)
//        against a 34.75 capsule; with the glass rounded to the card's own
//        radius the best fit IS the capsule, R = 34.5, rms 0.15.
//      – equality is the only value that satisfies both.
//  • Native `formSheet` routes must set `contentStyle.backgroundColor:
//    'transparent'` and paint their own `GlassPanel`, or they present as an
//    opaque slab: `presentationBackground` accepts a solid colour only.
//  • Nothing on the sheet stacks Liquid Glass ON Liquid Glass. Controls that sit
//    on the sheet (the search field, the settings button) use a RECESSED
//    translucent fill instead — HIG is explicit about this, and it is what Apple
//    Maps' own search field is.
//  • Capsules use `borderRadius = height / 2` and nothing else.
//    `borderCurve: 'continuous'` is for rounded RECTANGLES; on a stadium or a
//    circle it renders a squircle that reads as lopsided beside a true circle.
