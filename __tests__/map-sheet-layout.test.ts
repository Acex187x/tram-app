// Pins the home sheet's layout math: snap points, the CONTINUOUS chrome ride
// (the thing that replaced per-detent springs), fling snapping and rubber
// banding. These functions are worklets executed on the UI thread every frame of
// a drag — jest runs the exact same code.
//
// See src/components/maps-kit/mapSheetLayout.ts.
import { SETTINGS_D, SHEET_H_PAD } from '@/components/home/homeMetrics';
import {
  CARD_DETENT,
  CARD_PAD,
  cardShapeFor,
  CHROME_GAP,
  chromeRideFor,
  DEVICE_CORNER_RADIUS,
  DOCK_INSET,
  DOCK_WIDTH,
  FLOAT_BOTTOM_RADIUS,
  FLOAT_FADE,
  FULL_SIDE_INSET,
  FULL_TOP_GAP,
  GRABBER_H,
  GRABBER_TO_FIELD,
  GRABBER_TOP_GAP,
  HEADER_PAD_BOTTOM,
  HEADER_PAD_TOP,
  HOME_DETENT,
  isDocked,
  largeDetentFraction,
  lastLegFor,
  MEDIUM_BOTTOM_GAP,
  MEDIUM_SIDE_INSET,
  mediumDetentFraction,
  PEEK_FLOAT,
  peekCardHeight,
  peekHeight,
  REGULAR_WIDTH_MIN,
  rubberBand,
  SCRIM_MAX_DARK,
  SCRIM_MAX_LIGHT,
  scrimMaxFor,
  SEARCH_H,
  sheetSolidFor,
  SHEET_MAX_DETENT_RESERVE,
  SHEET_RADIUS,
  SHEET_SIDE_INSET,
  SHEET_SOLID_DARK,
  SHEET_SOLID_LIGHT,
  snapHeights,
  snapIndexFor,
} from '@/components/maps-kit/mapSheetLayout';

/** iPhone 16 Pro. `insetTop` is 62, not the 59 this fixture used to claim —
 *  verified on device by measuring the full detent's top edge off a screenshot
 *  (a FULL_TOP_GAP derived from 59 landed the card exactly 3 pt low). */
const PHONE = { windowWidth: 402, windowHeight: 874, insetTop: 62, insetBottom: 34 };
/** iPad 11" portrait. */
const PAD = { windowWidth: 834, windowHeight: 1194, insetTop: 24, insetBottom: 20 };

describe('isDocked', () => {
  it('keeps a portrait iPhone a bottom sheet', () => {
    expect(isDocked(PHONE)).toBe(false);
  });

  it('docks at regular width (iPad, either orientation)', () => {
    expect(isDocked(PAD)).toBe(true);
    expect(isDocked({ windowWidth: REGULAR_WIDTH_MIN, windowHeight: 1200 })).toBe(true);
    expect(isDocked({ windowWidth: 1194, windowHeight: 834 })).toBe(true);
  });

  it('docks a LANDSCAPE iPhone — a bottom sheet would leave a letterbox of map', () => {
    expect(isDocked({ windowWidth: 874, windowHeight: 402 })).toBe(true);
  });

  it('stays compact in a narrow Slide Over window', () => {
    expect(isDocked({ windowWidth: 320, windowHeight: 1194 })).toBe(false);
  });
});

describe('peekHeight', () => {
  it('is exactly the header block plus the float gap — nothing peeks below it', () => {
    // The header block that fills the collapsed card is grabber + row + gap; the
    // float gap is the air under the floating capsule. Any EXTRA would show the
    // first grouped row bleeding out under the search bar.
    expect(peekHeight(PHONE)).toBe(HEADER_PAD_TOP + SEARCH_H + HEADER_PAD_BOTTOM + PEEK_FLOAT);
  });

  it('does not add the home-indicator inset (Apple Maps floats over that band)', () => {
    expect(peekHeight({ insetBottom: 34 })).toBe(peekHeight({ insetBottom: 0 }));
  });

  it('grows with a taller header (the follow mini card replacing the search row)', () => {
    expect(peekHeight(PHONE, 78)).toBeGreaterThan(peekHeight(PHONE));
    expect(peekHeight(PHONE, 78) - peekHeight(PHONE)).toBe(78 - SEARCH_H);
  });
});

describe('collapsed-bar geometry vs the measured Apple Maps reference', () => {
  // Measured off an Apple Maps iOS 26 screenshot (iPhone 16 Pro) by decoding it
  // and finding the card via the brightness step + sharpness drop its glass
  // makes over the map. Apple, in pt:
  //   card 786.4 → 851.3 (h 64.9), insets 22.5 / 22.6, bottom gap 22.7,
  //   corner fits 32.25 / 32.75 against h/2 = 32.45
  //   grabber 50 × 4.7, 4.2 below the card top, 5.3 clear of the field
  //   field 37.3 tall with a UNIFORM 13.8 pt inset above and below.
  // Our field is now 38, so the card lands on 67 against Apple's 64.9 — and it
  // renders ~1.2 shy of its declared height, i.e. ~65.8 on screen. The absolute
  // height is pinned here too, not just the relationships.
  it('builds a card within ~2.5 pt of Apple’s 64.9 pt collapsed bar', () => {
    expect(SEARCH_H).toBe(38);
    expect(Math.abs(peekCardHeight() - 64.9)).toBeLessThanOrEqual(2.5);
  });

  it('floats a uniform ~22 pt off the bottom and the sides (Apple 21.8)', () => {
    expect(PEEK_FLOAT).toBe(22);
    expect(SHEET_SIDE_INSET).toBe(22);
    expect(peekHeight(PHONE) - peekCardHeight()).toBe(PEEK_FLOAT);
  });

  it('pads the header row top ≈ bottom vertically (Apple 13.8 / 13.8)', () => {
    // This is the "uneven spacing" fix: it used to be 14 horizontal / 9 vertical.
    expect(HEADER_PAD_BOTTOM).toBe(CARD_PAD);
    // The top pad is one point larger because it is BUILT from the grabber band
    // rather than chosen; optically identical, structurally exact.
    expect(HEADER_PAD_TOP - CARD_PAD).toBeLessThanOrEqual(1);
  });

  // The HORIZONTAL inset is deliberately NOT the vertical one. Apple's collapsed
  // bar is a capsule, and it gives the search field 15.3 pt at the ends against
  // 13.8 above and below — the extra clearance the field's own rounded end needs
  // to nest inside the ~32 pt arc instead of grazing it. This test used to
  // assert the two were equal; that was the assumption, not the measurement.
  it('insets content horizontally by MORE than vertically — the arc clearance', () => {
    expect(SHEET_H_PAD).toBeGreaterThan(CARD_PAD);
    // Apple 15.3 from the card edge; ours 16, i.e. inside a point.
    expect(Math.abs(SHEET_H_PAD - 15.3)).toBeLessThanOrEqual(1);
  });

  // ONE content edge for every sheet, owned and native. Before this pass the app
  // had four (14 home / 20 native + tram body / 16 compact header / 22 timeline),
  // two of them inside the tram card alone.
  it('is the same inset UIKit itself uses for an inset-grouped card (16)', () => {
    // iOS 26 Settings root list: card left edge 16.00 pt, measured at @3.
    // Apple Maps place card at full: Directions capsule 16.00, photo rail 16.00.
    expect(SHEET_H_PAD).toBe(16);
  });

  it('gives the grabber clear air on BOTH sides (Apple: 4.7 above, 5.3 below)', () => {
    expect(GRABBER_TOP_GAP).toBeGreaterThanOrEqual(4);
    expect(GRABBER_TO_FIELD).toBeGreaterThanOrEqual(4);
    // The band must exactly fill the top pad — otherwise the pill either floats
    // in the field's space or the card grows an unexplained sliver.
    expect(GRABBER_TOP_GAP + GRABBER_H + GRABBER_TO_FIELD).toBe(HEADER_PAD_TOP);
  });

  it('sizes the settings circle EXACTLY like the field — one shape family', () => {
    // The previous pass sized it by ratio off Apple's trailing avatar (32/39).
    // That was a misread: Apple's is an UNFILLED person.circle SYMBOL, whose
    // glyph is smaller than its slot by construction. Ours is a filled disc in
    // the same recessed fill as the field, so anything but an exact height match
    // reads as two mismatched shapes — the user's "it looks ridiculous".
    expect(SETTINGS_D).toBe(SEARCH_H);
    // Both are capsules under the same rule, so the row's trailing inset from
    // the card edge is now exactly its leading one.
    const circleToCardEdge = SHEET_H_PAD + (SEARCH_H - SETTINGS_D) / 2;
    expect(circleToCardEdge).toBe(SHEET_H_PAD);
  });

  it('rests as a CAPSULE — radius is half the card height, not a rounded rect', () => {
    const snaps = snapHeights(PHONE);
    const cardH = peekCardHeight();
    const rest = cardShapeFor(snaps[0], snaps, cardH);
    expect(rest.topRadius).toBeCloseTo(cardH / 2, 5);
    expect(rest.bottomRadius).toBeCloseTo(cardH / 2, 5);
    expect(rest.lift).toBeCloseTo(PEEK_FLOAT, 5);
    expect(rest.sideInset).toBeCloseTo(SHEET_SIDE_INSET, 5);
    expect(rest.scrim).toBe(0);
    expect(rest.solid).toBe(0);
  });

  it('stays a capsule for ANY header height — Dynamic Type included', () => {
    // The user's report is "the ends are straight", and a taller row is the case
    // that would break a radius derived from anything but the live card height.
    // 40 is the search row; 52 the tram card's portrait row; 78 the follow mini
    // card; 96 what an accessibility text size can push a two-line row to.
    for (const headerH of [SEARCH_H, 52, 78, 96]) {
      const snaps = snapHeights(PHONE, headerH);
      const cardH = peekCardHeight(headerH);
      const rest = cardShapeFor(snaps[0], snaps, cardH);
      expect(rest.topRadius).toBeCloseTo(cardH / 2, 5);
      expect(rest.bottomRadius).toBeCloseTo(cardH / 2, 5);
      // …and "capsule" means the arcs MEET: no straight segment can exist,
      // because the two radii together span the whole card height.
      expect(rest.topRadius + rest.bottomRadius).toBeCloseTo(cardH, 5);
    }
  });
});

describe('cardShapeFor — the three-stage capsule → panel → full-screen model', () => {
  const snaps = snapHeights(PHONE);
  const [peek, medium, large] = snaps;
  const cardH = peekCardHeight();
  const shape = (h: number) => cardShapeFor(h, snaps, cardH);

  it('STAGE 1: detaches within FLOAT_FADE into Apple’s FLOATING half-sheet card', () => {
    const detached = shape(peek + 80);
    // It does NOT land on the screen bottom: Apple's half detent floats on all
    // three free sides, and the bottom gap is the one that used to be missing.
    expect(detached.lift).toBeCloseTo(MEDIUM_BOTTOM_GAP, 5);
    expect(detached.bottomRadius).toBeCloseTo(FLOAT_BOTTOM_RADIUS, 5);
    expect(detached.topRadius).toBeCloseTo(SHEET_RADIUS, 5);
    expect(detached.sideInset).toBeCloseTo(MEDIUM_SIDE_INSET, 5);
    expect(detached.scrim).toBe(0);
    expect(detached.solid).toBe(0);
  });

  it('STAGE 2: the whole plateau up to medium is ONE stable, FLOATING card', () => {
    // The rejected model reached sideInset 0 eighty pixels above peek, so a half
    // sheet was already edge-to-edge. Apple's medium detent floats ~5 pt clear on
    // the sides AND the bottom, with its bottom corners concentric to the frame.
    const plateau = [peek + 80, (peek + medium) / 2, medium - 1, medium];
    for (const h of plateau) {
      const s = shape(h);
      expect(s.sideInset).toBeCloseTo(MEDIUM_SIDE_INSET, 5);
      expect(s.lift).toBeCloseTo(MEDIUM_BOTTOM_GAP, 5);
      expect(s.bottomRadius).toBeCloseTo(FLOAT_BOTTOM_RADIUS, 5);
      expect(s.topRadius).toBeCloseTo(SHEET_RADIUS, 5);
      expect(s.solid).toBe(0);
    }
    // BOTH gaps are real — this is the pin for "the medium sheet floats".
    expect(MEDIUM_SIDE_INSET).toBeGreaterThan(0);
    expect(MEDIUM_BOTTOM_GAP).toBeGreaterThan(0);
    // …and the bottom corners are TIGHTER than concentric with the display —
    // Apple's fit is 52.0 where `62 − gap` would be 56.1, so this pins the
    // direction as well as the number.
    expect(FLOAT_BOTTOM_RADIUS).toBeCloseTo(52.5, 5);
    expect(FLOAT_BOTTOM_RADIUS).toBeLessThan(DEVICE_CORNER_RADIUS - MEDIUM_BOTTOM_GAP);
  });

  it('STAGE 3: the last leg goes EDGE TO EDGE, dims, and turns solid', () => {
    // The previous pass froze the silhouette here, so a fully open sheet kept a
    // 5 pt gutter and stopped short of the screen edges. Apple's goes flush: the
    // gutter and the bottom float both close, the bottom corners open to the
    // display's own radius, the world dims and the glass becomes an opaque page.
    expect(shape(medium).scrim).toBe(0);
    expect(shape(medium).solid).toBe(0);

    const half = shape((medium + large) / 2);
    expect(half.scrim).toBeGreaterThan(0);
    expect(half.scrim).toBeLessThan(SCRIM_MAX_DARK);
    expect(half.solid).toBeGreaterThan(0);
    expect(half.solid).toBeLessThan(1);
    // Mid-leg it is genuinely between the two shapes, not snapped to either.
    expect(half.sideInset).toBeGreaterThan(FULL_SIDE_INSET);
    expect(half.sideInset).toBeLessThan(MEDIUM_SIDE_INSET);
    expect(half.lift).toBeGreaterThan(0);
    expect(half.lift).toBeLessThan(MEDIUM_BOTTOM_GAP);
    expect(half.topRadius).toBeCloseTo(SHEET_RADIUS, 5);

    const full = shape(large);
    expect(full.sideInset).toBe(0);
    expect(full.lift).toBeCloseTo(0, 5);
    expect(full.bottomRadius).toBeCloseTo(DEVICE_CORNER_RADIUS, 5);
    expect(full.topRadius).toBeCloseTo(SHEET_RADIUS, 5);
    expect(full.scrim).toBeCloseTo(SCRIM_MAX_DARK, 5);
    expect(full.solid).toBeCloseTo(1, 5);
  });

  it('crossfades the surface to solid over the LAST leg only, monotonically', () => {
    // Nothing below the medium detent may tint the glass: the whole point of an
    // owned sheet is that the map is visible through it until it takes over.
    for (let h = peek - 40; h <= medium; h += 7) expect(shape(h).solid).toBe(0);
    let prev = 0;
    for (let h = medium; h <= large; h += 5) {
      const s = shape(h).solid;
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s).toBeLessThanOrEqual(1 + 1e-9);
      prev = s;
    }
    expect(shape(large).solid).toBeCloseTo(1, 5);
    // The two solid fills are the iOS system pair, and the reader is the one way
    // to get them — a caller that hard-codes one will drift on the other scheme.
    expect(sheetSolidFor('dark')).toBe(SHEET_SOLID_DARK);
    expect(sheetSolidFor('light')).toBe(SHEET_SOLID_LIGHT);
    expect(SHEET_SOLID_DARK).not.toBe(SHEET_SOLID_LIGHT);
  });

  it('veils the world with UIKit’s own dim, which is per-appearance', () => {
    // Measured off a native route sheet dragged to full on the reference device
    // (same map band, sheet away vs. sheet at full): black at α 0.50 in dark and
    // 0.20 in light, flat across the band in both. A single value for both — the
    // old 0.28 — was half the system's dim in dark and 40% over it in light, so
    // the map visibly darkened harder behind a route sheet than behind this one.
    expect(SCRIM_MAX_DARK).toBeCloseTo(0.5, 5);
    expect(SCRIM_MAX_LIGHT).toBeCloseTo(0.2, 5);
    expect(scrimMaxFor('dark')).toBe(SCRIM_MAX_DARK);
    expect(scrimMaxFor('light')).toBe(SCRIM_MAX_LIGHT);
    // The peak the caller asks for is the peak it gets, at the largest detent
    // and nowhere below it.
    expect(cardShapeFor(large, snaps, cardH, SCRIM_MAX_LIGHT).scrim).toBeCloseTo(
      SCRIM_MAX_LIGHT,
      5,
    );
    expect(cardShapeFor(medium, snaps, cardH, SCRIM_MAX_LIGHT).scrim).toBe(0);
    // Unasked, it is the dark peak: a caller that forgets over-dims a dark
    // sheet by 0, never under-dims a light one into an invisible veil.
    expect(cardShapeFor(large, snaps, cardH).scrim).toBeCloseTo(SCRIM_MAX_DARK, 5);
  });

  it('FULLY OPEN it is EDGE TO EDGE and flush, with device-concentric corners', () => {
    const full = shape(large);
    expect(FULL_SIDE_INSET).toBe(0);
    expect(full.sideInset).toBe(0);
    expect(full.lift).toBeCloseTo(0, 5);
    // The top stays a card under the status bar; only the BOTTOM goes flush, and
    // there the radius equals the display's so the mask clips it concentrically.
    expect(full.topRadius).toBeCloseTo(SHEET_RADIUS, 5);
    expect(full.bottomRadius).toBeCloseTo(DEVICE_CORNER_RADIUS, 5);
    // …and that is now the SAME behaviour the native route sheets already have
    // (measured insetL 0.12 / insetR 0.45 at their largest detent): the two
    // families finally agree at full as well as at the partial detents.
    expect(FULL_SIDE_INSET).toBeLessThan(MEDIUM_SIDE_INSET);
  });

  it('can NEVER make the card exceed the screen width, overshoot included', () => {
    for (let h = peek - 400; h <= large + 400; h += 11) {
      expect(shape(h).sideInset).toBeGreaterThanOrEqual(0);
      expect(shape(h).lift).toBeGreaterThanOrEqual(0);
    }
    // Degenerate tables too: an un-laid-out sheet must show the SAFE shape — a
    // floating, glass, undimmed card — never a flash of opaque full-bleed.
    const blank = cardShapeFor(0, [], cardH);
    expect(blank.sideInset).toBe(MEDIUM_SIDE_INSET);
    expect(blank.solid).toBe(0);
    expect(cardShapeFor(500, [300], cardH).sideInset).toBeGreaterThanOrEqual(0);
  });

  it('tops the full detent out FULL_TOP_GAP below the safe area (Apple 111.83)', () => {
    // Apple's fully-open sheet, measured ALONE on screen (a place card stacked
    // over the search sheet reads 10 pt higher, and two of UIKit's own veils
    // multiplying to the 0.775 measured behind it is what proves the stack),
    // starts at y = 111.83 ⇒ a 762.2 pt card. Ours used a 60 pt gap and was
    // 10 pt too short; before that a 10 pt gap made it a full-screen takeover.
    expect(large).toBe(PHONE.windowHeight - PHONE.insetTop - FULL_TOP_GAP);
    expect(PHONE.windowHeight - large).toBeCloseTo(111.83, 0);
    expect(large).toBeCloseTo(762.2, 0);
  });

  it('never dims below the medium detent — a peeked map is never veiled', () => {
    for (let h = peek - 40; h <= medium; h += 7) expect(shape(h).scrim).toBe(0);
  });

  it('moves every value monotonically across the WHOLE range, including overshoot', () => {
    // The card only ever gets LESS inset and LESS lifted as it grows, and only
    // ever MORE dimmed, MORE solid and MORE frame-concentric at the bottom. A
    // non-monotonic value is a shape that visibly reverses mid-drag.
    let prev = shape(peek - 60);
    for (let h = peek - 60; h <= large + 60; h += 3) {
      const cur = shape(h);
      expect(cur.lift).toBeLessThanOrEqual(prev.lift + 1e-9);
      expect(cur.bottomRadius).toBeGreaterThanOrEqual(prev.bottomRadius - 1e-9);
      expect(cur.bottomRadius).toBeLessThanOrEqual(DEVICE_CORNER_RADIUS + 1e-9);
      expect(cur.sideInset).toBeLessThanOrEqual(prev.sideInset + 1e-9);
      expect(cur.scrim).toBeGreaterThanOrEqual(prev.scrim - 1e-9);
      expect(cur.scrim).toBeLessThanOrEqual(SCRIM_MAX_DARK + 1e-9);
      expect(cur.solid).toBeGreaterThanOrEqual(prev.solid - 1e-9);
      prev = cur;
    }
  });

  it('still detaches by the medium detent on a window too short for FLOAT_FADE', () => {
    // Portrait (so it is not docked) but short enough that medium sits closer
    // than FLOAT_FADE above peek — the capsule must still be fully detached by
    // the time the plateau starts, or stages 1 and 3 would overlap.
    const tiny = { windowWidth: 320, windowHeight: 340, insetTop: 20, insetBottom: 0 };
    const t = snapHeights(tiny);
    expect(t[1] - t[0]).toBeLessThan(80);
    expect(cardShapeFor(t[1], t, peekCardHeight()).lift).toBeCloseTo(MEDIUM_BOTTOM_GAP, 5);
    const at = cardShapeFor(t[t.length - 1], t, peekCardHeight());
    expect(at.lift).toBeCloseTo(0, 5);
    expect(at.sideInset).toBeCloseTo(FULL_SIDE_INSET, 5);
  });

  it('is total — an empty snap table yields the SAFE floating half-sheet shape', () => {
    expect(cardShapeFor(0, [], cardH)).toEqual({
      lift: MEDIUM_BOTTOM_GAP,
      topRadius: SHEET_RADIUS,
      bottomRadius: FLOAT_BOTTOM_RADIUS,
      sideInset: MEDIUM_SIDE_INSET,
      scrim: 0,
      solid: 0,
    });
  });
});

describe('the pinned header seed vs. the measured header', () => {
  // MapSheet MEASURES the header (onLayout) and re-derives peek from the real
  // value; the constants a caller passes are only the first-frame seed. They
  // still have to be right, or frame one springs visibly to the corrected
  // geometry.

  // The tram card's pinned header is a 52 pt portrait beside two text lines, and
  // it is the SAME element at every detent — the bar detent is literally that
  // row plus the card's own padding. This is the number the whole "swipe the
  // card down and it becomes the bar" morph rests on.
  const TRAM_HEADER = 52;

  it('the tram bar detent is exactly its header row plus the card insets', () => {
    expect(peekCardHeight(TRAM_HEADER)).toBe(HEADER_PAD_TOP + TRAM_HEADER + HEADER_PAD_BOTTOM);
    // …and the peek height is that card floating PEEK_FLOAT off the bottom, so
    // nothing of the body can occupy the bar: the card clips at exactly the
    // header block's height.
    expect(peekHeight(PHONE, TRAM_HEADER)).toBe(peekCardHeight(TRAM_HEADER) + PEEK_FLOAT);
  });

  it('a taller measured header moves the peek detent by exactly the difference', () => {
    expect(peekHeight(PHONE, TRAM_HEADER) - peekHeight(PHONE)).toBe(TRAM_HEADER - SEARCH_H);
  });

  it('re-derives the whole snap table from the measured header, peek only', () => {
    const seeded = snapHeights(PHONE, SEARCH_H);
    const measured = snapHeights(PHONE, SEARCH_H + 12);
    expect(measured[0] - seeded[0]).toBe(12);
    // Medium and large are window-derived — a header change must not move them.
    expect(measured.slice(1)).toEqual(seeded.slice(1));
  });

  it('keeps the chrome ride glued to the MEASURED peek, not to the seed', () => {
    const measured = snapHeights(PHONE, TRAM_HEADER);
    expect(chromeRideFor(measured[0], measured, false).offset).toBe(measured[0] + CHROME_GAP);
  });
});

describe('the tram card shares the home sheet\'s snap math', () => {
  // The bar IS the tram sheet's smallest detent, so both sheets must be built by
  // the SAME function. Since the parity pass they do not even differ in their
  // middle detent: Apple Maps declares ONE (top 486.2) for its search sheet and
  // its place card alike, so both of ours are MEDIUM_DETENT.
  const TRAM_HEADER = 52;

  it('is now identical to the home sheet, middle detent included', () => {
    const home = snapHeights(PHONE, TRAM_HEADER);
    const card = snapHeights(PHONE, TRAM_HEADER, CARD_DETENT);
    expect(card).toHaveLength(3);
    expect(card).toEqual(home);
    expect(card[1]).toBeCloseTo(874 * CARD_DETENT, 5);
    // …and that detent puts the card's top edge on Apple's measured 486.2.
    expect(PHONE.windowHeight - card[1]).toBeCloseTo(486.2, 0);
  });

  it('is still strictly ascending, so the snap picker and rubber band hold', () => {
    const card = snapHeights(PHONE, TRAM_HEADER, CARD_DETENT);
    expect([...card].sort((a, b) => a - b)).toEqual(card);
    expect(new Set(card).size).toBe(card.length);
  });

  it('shows NOTHING but the header at the bar: the card is the header block', () => {
    // At the bar detent the card's own height (peek minus the float gap) equals
    // the pinned header block exactly, so the ScrollView below it is entirely
    // outside the card's clip.
    const card = snapHeights(PHONE, TRAM_HEADER, CARD_DETENT);
    expect(card[0] - PEEK_FLOAT).toBe(peekCardHeight(TRAM_HEADER));
  });

  it('keeps the floating action pill hidden at the bar and shown at the card', () => {
    // The pill fades over the same leg the card DETACHES on (FLOAT_FADE), which
    // both snap tables share — so it is fully gone at peek and fully present by
    // the middle detent for either sheet.
    const card = snapHeights(PHONE, TRAM_HEADER, CARD_DETENT);
    expect(card[1] - card[0]).toBeGreaterThan(FLOAT_FADE);
  });

  it('morphs from a capsule bar to an inset card with the same shape function', () => {
    const card = snapHeights(PHONE, TRAM_HEADER, CARD_DETENT);
    const peekCardH = peekCardHeight(TRAM_HEADER);
    const bar = cardShapeFor(card[0], card, peekCardH);
    expect(bar.lift).toBe(PEEK_FLOAT);
    expect(bar.topRadius).toBeCloseTo(peekCardH / 2, 5);
    expect(bar.bottomRadius).toBeCloseTo(peekCardH / 2, 5);
    expect(bar.scrim).toBe(0);
    expect(bar.solid).toBe(0);
    // The TRAM CARD's middle detent must float exactly like the home sheet's —
    // this is the check that "every owned sheet" got the bottom gap, not just
    // the one the constant happened to be tested through.
    const open = cardShapeFor(card[1], card, peekCardH);
    expect(open.lift).toBeCloseTo(MEDIUM_BOTTOM_GAP, 5);
    expect(open.sideInset).toBeCloseTo(MEDIUM_SIDE_INSET, 5);
    expect(open.bottomRadius).toBeCloseTo(FLOAT_BOTTOM_RADIUS, 5);
    expect(open.scrim).toBe(0);
    expect(open.solid).toBe(0);
    const full = cardShapeFor(card[2], card, peekCardH);
    expect(full.sideInset).toBe(FULL_SIDE_INSET);
    expect(full.lift).toBeCloseTo(0, 5);
    expect(full.bottomRadius).toBeCloseTo(DEVICE_CORNER_RADIUS, 5);
    expect(full.scrim).toBeCloseTo(SCRIM_MAX_DARK, 5);
    expect(full.solid).toBeCloseTo(1, 5);
  });

  it('gives the home sheet and the tram card IDENTICAL shapes at every detent', () => {
    // Same function, same constants — the only thing that may differ between the
    // two owned sheets is WHERE the middle detent sits, never how it looks.
    const home = snapHeights(PHONE, TRAM_HEADER);
    const card = snapHeights(PHONE, TRAM_HEADER, CARD_DETENT);
    const peekCardH = peekCardHeight(TRAM_HEADER);
    for (const i of [0, 1, 2]) {
      const a = cardShapeFor(home[i], home, peekCardH);
      const b = cardShapeFor(card[i], card, peekCardH);
      expect(b).toEqual(a);
    }
  });
});

describe('snapHeights', () => {
  it('is ascending peek → medium → large on a phone', () => {
    const snaps = snapHeights(PHONE);
    expect(snaps).toHaveLength(3);
    expect(snaps[0]).toBe(peekHeight(PHONE));
    expect(snaps[1]).toBeCloseTo(874 * HOME_DETENT, 5);
    // Apple's measured middle detent: card top at 486.2 on this window.
    expect(874 - snaps[1]).toBeCloseTo(486.2, 0);
    expect(snaps[2]).toBe(874 - PHONE.insetTop - FULL_TOP_GAP);
    expect([...snaps].sort((a, b) => a - b)).toEqual(snaps);
  });

  it('keeps all three detents in the regular-width side sheet', () => {
    expect(snapHeights(PAD)).toHaveLength(3);
  });

  it('caps the side sheet at its inset container and still reacts to header/detent inputs', () => {
    const snaps = snapHeights(PAD);
    expect(snaps[0]).toBe(peekHeight(PAD));
    expect(snaps[1]).toBeCloseTo(PAD.windowHeight * HOME_DETENT, 5);
    expect(snaps[2]).toBe(PAD.windowHeight - PAD.insetTop - DOCK_INSET * 2);
    expect(snapHeights(PAD, 52)[0]).toBe(peekHeight(PAD, 52));
    expect(snapHeights(PAD, 52, CARD_DETENT)[1]).toBeCloseTo(
      PAD.windowHeight * CARD_DETENT,
      5,
    );
  });

  it('never emits duplicate or unsorted snaps on a very short window', () => {
    const tiny = { windowWidth: 320, windowHeight: 200, insetTop: 20, insetBottom: 0 };
    const snaps = snapHeights(tiny);
    expect(new Set(snaps).size).toBe(snaps.length);
    expect([...snaps].sort((a, b) => a - b)).toEqual(snaps);
  });
});

describe('chromeRideFor — the continuous ride', () => {
  const snaps = snapHeights(PHONE);
  const [peek, medium] = snaps;

  it('sits exactly CHROME_GAP above the sheet edge at rest', () => {
    expect(chromeRideFor(peek, snaps, false)).toEqual({ offset: peek + CHROME_GAP });
  });

  it('rides 1:1 with the sheet edge between peek and medium', () => {
    // This is the whole point of the rewrite: a MID-DRAG height must already
    // have moved the chrome, not wait for the detent to settle.
    const mid = peek + (medium - peek) / 2;
    expect(chromeRideFor(mid, snaps, false).offset).toBeCloseTo(mid + CHROME_GAP, 5);
    expect(chromeRideFor(peek + 1, snaps, false).offset).toBeCloseTo(peek + 1 + CHROME_GAP, 5);
  });

  it('is monotonic across the whole drag range (never jumps backwards)', () => {
    let prev = -1;
    for (let h = peek; h <= snaps[2]; h += 7) {
      const { offset } = chromeRideFor(h, snaps, false);
      expect(offset).toBeGreaterThanOrEqual(prev);
      prev = offset;
    }
  });

  it('parks the offset at medium and lets the sheet cover the chrome', () => {
    // Past medium the offset is FROZEN — the sheet keeps growing over the parked
    // clusters and occludes them. It must not fade them out instead: they are
    // GlassPanels, and animated alpha destroys the material (see MapChrome's
    // `useChromeRide`), which is why the ride returns nothing but an offset.
    const large = snaps[2];
    expect(chromeRideFor(large, snaps, false).offset).toBeCloseTo(medium + CHROME_GAP, 5);
    expect(chromeRideFor((medium + large) / 2, snaps, false).offset).toBeCloseTo(
      medium + CHROME_GAP,
      5,
    );
    expect(Object.keys(chromeRideFor(large, snaps, false))).toEqual(['offset']);
  });

  it('clamps below peek (rubber-band overshoot must not push the chrome down)', () => {
    expect(chromeRideFor(peek - 40, snaps, false).offset).toBe(peek + CHROME_GAP);
  });

  it('never moves the chrome when the sheet is a docked iPad column', () => {
    const docked = chromeRideFor(500, snaps, true);
    expect(chromeRideFor(1000, snapHeights(PAD), true)).toEqual(docked);
  });
});

describe('snapIndexFor', () => {
  const snaps = snapHeights(PHONE);

  it('lands on the nearest snap when released at rest', () => {
    expect(snapIndexFor(snaps[0] + 5, 0, snaps)).toBe(0);
    expect(snapIndexFor(snaps[1] - 5, 0, snaps)).toBe(1);
    expect(snapIndexFor(snaps[2] - 5, 0, snaps)).toBe(2);
  });

  it('carries past the nearest snap on a fling (velocity is projected)', () => {
    // Just above peek but flung hard upwards (negative velocityY) → medium.
    expect(snapIndexFor(snaps[0] + 20, -2500, snaps)).toBeGreaterThan(0);
    // Near medium, flung hard downwards → back to peek.
    expect(snapIndexFor(snaps[1] - 20, 2500, snaps)).toBe(0);
  });

  it('is total — any height/velocity yields a valid index', () => {
    for (const h of [-500, 0, 1e6]) {
      for (const v of [-9999, 0, 9999]) {
        const i = snapIndexFor(h, v, snaps);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(snaps.length);
      }
    }
  });
});

describe('rubberBand', () => {
  const snaps = snapHeights(PHONE);

  it('passes heights inside the range through untouched', () => {
    expect(rubberBand(snaps[1], snaps)).toBe(snaps[1]);
  });

  it('resists below peek — the sheet can never be dragged away', () => {
    const pulled = rubberBand(snaps[0] - 100, snaps);
    expect(pulled).toBeLessThan(snaps[0]);
    expect(pulled).toBeGreaterThan(snaps[0] - 100);
  });

  it('resists above large', () => {
    const max = snaps[snaps.length - 1];
    const pulled = rubberBand(max + 100, snaps);
    expect(pulled).toBeGreaterThan(max);
    expect(pulled).toBeLessThan(max + 100);
  });
});

describe('dock geometry', () => {
  it('uses a narrow column that leaves most of the iPad map visible', () => {
    expect(DOCK_WIDTH).toBeLessThan(PAD.windowWidth / 2);
  });
});


// ── Native formSheet detents ────────────────────────────────────────────────
// The route sheets are UIKit formSheets whose detents are fractions of
// `maximumDetentValue`, NOT of the window. These two functions translate, so a
// native sheet and an owned sheet asking for the same edge get the same edge.
describe('native formSheet detents', () => {
  /** The height UIKit gives a native sheet at fraction 1.0 on this device. */
  const maxDetent = PHONE.windowHeight - SHEET_MAX_DETENT_RESERVE;
  /** Top edge (pt from the screen top) a native sheet settles at, given a fraction. */
  const nativeTop = (fraction: number) => PHONE.windowHeight - fraction * maxDetent;

  it('lands the largest detent on the OWNED sheet\'s large top, not 21 pt above it', () => {
    const owned = snapHeights(PHONE);
    const ownedTop = PHONE.windowHeight - owned[owned.length - 1];
    const top = nativeTop(largeDetentFraction(PHONE.windowHeight, PHONE.insetTop));
    expect(top).toBeCloseTo(ownedTop, 6);
    // And that top is the measured Apple one: insetTop + FULL_TOP_GAP.
    expect(top).toBeCloseTo(PHONE.insetTop + FULL_TOP_GAP, 6);
    // The old hard-coded 0.95 sat higher than the measured top — the drift
    // being removed. (The margin is now ~11 pt, not the ~21 it was before
    // FULL_TOP_GAP came down 60 → 50; the point is the SIGN, not the size.)
    expect(nativeTop(0.95)).toBeLessThan(top - 5);
  });

  it('reproduces a WINDOW fraction for the middle detent', () => {
    for (const f of [0.45, 0.5, 0.55, 0.6]) {
      const top = nativeTop(mediumDetentFraction(PHONE.windowHeight, f));
      expect(top).toBeCloseTo(PHONE.windowHeight * (1 - f), 6);
    }
    // A native 0.5 would have landed 30 pt lower — the drift being removed.
    expect(nativeTop(0.5)).toBeGreaterThan(nativeTop(mediumDetentFraction(PHONE.windowHeight, 0.5)));
  });

  it('matches the owned sheet detent-for-detent, so both families share one table', () => {
    const owned = snapHeights(PHONE); // [peek, medium, large]
    expect(nativeTop(mediumDetentFraction(PHONE.windowHeight, HOME_DETENT))).toBeCloseTo(
      PHONE.windowHeight - owned[1],
      6,
    );
  });

  it('never emits a fraction UIKit would clamp or reject', () => {
    for (const h of [568, 667, 874, 1194, 2000]) {
      for (const f of [0.05, 0.45, 0.6, 0.99, 1.4]) {
        const v = mediumDetentFraction(h, f);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      for (const top of [0, 24, 62, 120]) {
        const v = largeDetentFraction(h, top);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the large detent above the medium one on every plausible device', () => {
    for (const [h, top] of [
      [568, 20],
      [667, 20],
      [874, 62],
      [932, 62],
      [1194, 24],
    ] as const) {
      expect(largeDetentFraction(h, top)).toBeGreaterThan(mediumDetentFraction(h, 0.6));
    }
  });
});

// The LAST LEG ramp — the single 0 → 1 the world-dim scrim, the sheet's
// glass → solid surface crossfade and the tram card's floating action pill
// (black at the card detent, Liquid Glass when fully open) all ride. It was
// extracted out of cardShapeFor so those three cannot drift apart; these cases
// pin that they have not.
describe('lastLegFor', () => {
  /** The tram card's 52 pt portrait row — the sheet whose action pill rides it. */
  const TRAM_HEADER = 52;
  const CARD = snapHeights(PHONE, TRAM_HEADER, CARD_DETENT);

  it('is flat zero for the whole bar → card half of the drag', () => {
    expect(lastLegFor(CARD[0], CARD)).toBe(0);
    expect(lastLegFor(CARD[0] + FLOAT_FADE, CARD)).toBe(0);
    expect(lastLegFor(CARD[1], CARD)).toBe(0);
    // Below the bar (rubber-banding past the peek) must not go negative.
    expect(lastLegFor(CARD[0] - 40, CARD)).toBe(0);
  });

  it('ramps to exactly 1 at the largest detent and clamps past it', () => {
    expect(lastLegFor((CARD[1] + CARD[2]) / 2, CARD)).toBeCloseTo(0.5, 5);
    expect(lastLegFor(CARD[2], CARD)).toBe(1);
    // Rubber-banding above the large detent must not overshoot 1 — an opacity
    // above 1 would clip the pill's black layer back to opaque at the top of an
    // overscroll.
    expect(lastLegFor(CARD[2] + 60, CARD)).toBe(1);
  });

  it('IS the ramp cardShapeFor uses for the scrim and the solid fill', () => {
    const peekCardH = peekCardHeight(TRAM_HEADER);
    for (const h of [CARD[0], CARD[0] + 40, CARD[1], (CARD[1] + CARD[2]) / 2, CARD[2]]) {
      const u = lastLegFor(h, CARD);
      const shape = cardShapeFor(h, CARD, peekCardH, SCRIM_MAX_DARK);
      expect(shape.solid).toBeCloseTo(u, 10);
      expect(shape.scrim).toBeCloseTo(SCRIM_MAX_DARK * u, 10);
    }
  });

  it('degrades safely on tables the shape function can produce', () => {
    // No snaps yet (first frame): no last leg, so nothing dims and the pill
    // stays black rather than flashing glass over a still-glass sheet.
    expect(lastLegFor(400, [])).toBe(0);
    // A single-snap table (docked iPad column) has no leg either.
    expect(lastLegFor(400, [700])).toBe(0);
    expect(lastLegFor(900, [700])).toBe(1);
  });
});
