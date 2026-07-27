# UX & Screens — Decision Records

Decisions behind Tram Spotter's UI architecture: the map-first shell, the
formSheet-over-live-map pattern, the Liquid Glass system, and each screen's
flow. Grounded in the code under `src/app/*` and `src/components/*`.

---

## 1. Shell: full-bleed map + sheets over a live map (not tabs)

**Problem.** The app has one primary object — the moving fleet on the Prague
map — and a handful of secondary surfaces (a tram, a line, a stop, favorites,
search, planner, settings). A tab bar would give each surface equal, permanent
weight and permanently steal a strip of the map.

**Decision.** A single always-mounted map screen (`src/app/index.tsx`) with
every other surface pushed as a `formSheet` over it. No tab bar. The map keeps
rendering — and the fleet keeps moving — beneath every sheet.

**Why.**
- The map is the app; it should never be boxed into a tab. Full-bleed 3D
  Mapbox Standard fills the screen (`src/app/index.tsx`, `styles.map: flex 1`).
- Sheets are transient lookups, not peer destinations. A bottom sheet that
  leaves the map visible preserves context: you can watch the tram you tapped
  keep gliding while you read its sheet.
- One mounted map = one runtime. `useTramRuntime()` is called once in
  `MapScreen`; polling + physics simulation live as long as the map lives
  (`src/app/index.tsx:50`). Sheets are pure readers of that runtime.

**How.** `src/app/_layout.tsx` is a single `expo-router` `Stack`. `index` has
`headerShown:false`; every sheet route uses the shared `sheet()` options
factory:

The factory is now a **hook**, `useSheetOptions()`, because two of its values are
derived from the live window and safe area:

```
presentation: 'formSheet'
headerShown: false
sheetAllowedDetents: [mediumDetentFraction(h, f), largeDetentFraction(h, insetTop)]
sheetLargestUndimmedDetentIndex: 0   // small detent does NOT dim the map
sheetGrabberVisible: false           // ours renders instead — see below
sheetCornerRadius: SHEET_RADIUS      // 38, from sheetLook
contentStyle: { backgroundColor: 'transparent' }
```

**Detents are stated in WINDOW fractions, converted at the boundary.** UIKit
takes a custom detent as a fraction of `maximumDetentValue`, not of the window
(react-native-screens `detentsFromMaxHeightFractions`), and
`maximumDetentValue` is ~60 pt short of the window
(`SHEET_MAX_DETENT_RESERVE`, measured). So the same number meant different
heights on the two sheet families: a native "0.95" topped out at **100.8 pt**
while the owned sheet's large detent topped out at 122. `largeDetentFraction`
and `mediumDetentFraction` (`mapSheetLayout.ts`, unit-tested) translate, so a
route asks for the edge it wants in the owned sheet's own units:

| Route | Middle detent (window fraction) | Rationale |
|---|---|---|
| `line/[id]` | `0.45` | |
| `stop/[key]` | `0.45` | |
| `favorites` | `HOME_DETENT` (= `MEDIUM_DETENT`, 0.4436) | the same middle detent the home sheet uses |
| `rides` | `HOME_DETENT` | |
| `settings` | `0.55` | |
| `planner` | `0.6` | taller start — two inputs + results |
| `search` | — (`null`) | opens large; Apple's expanded-search idiom |
| `icon-preview/[pack]` | — (`null`) | |
| `model/[id]` | — | `fullScreenModal`, `animation:'fade'` (immersive 3D) |

The tram card is no longer here at all: it is an owned sheet on the map screen
(`src/components/tram/TramSheet.tsx`), and `tram/[key]` is a deep-link shim.

**Three load-bearing details:**
1. `sheetLargestUndimmedDetentIndex: 0` — at the small detent the map is
   **not** dimmed, so the live fleet stays fully visible and interactive-looking
   behind a peeked sheet. Only the large detent dims.
2. `contentStyle: backgroundColor 'transparent'` — on iOS 26 the system paints
   Liquid Glass behind a transparent formSheet, and **that system material IS
   the sheet's surface**. Do *not* add a root `<GlassPanel>`: glass-on-glass is
   resolved by flattening the inner effect to a vibrant fill that stops
   resolving light/dark with the app, which is how a sheet ends up half light
   and half dark. `SheetSurface` draws `SheetBackground` instead — a sibling
   that renders *nothing* on iOS 26 and a BlurView/solid on older iOS or under
   Reduce Transparency. (`/line` and `/planner` carried GlassPanel roots until
   this pass; `/planner`'s also hard-coded its own `borderRadius: 24`.)
3. `sheetGrabberVisible: false` everywhere, with `<Grabber/>`
   (`src/components/ui/Grabber.tsx`) drawn by `SheetSurface` instead. UIKit's
   pill measures 35.3 × 5.0 pt and paints an opaque ~rgb(112,111,125); ours is
   Apple *Maps*' 50 × 5 at separator weight, and there is no way to make UIKit's
   match. One component, one constant (`sheetLook.GRABBER`), used by
   `SheetSurface` **and** by `MapSheet` (via `GrabberPill`), so the two sheet
   families cannot disagree.

**`SheetSurface` is now the scaffold for every route sheet**, `/search` and
`/icon-preview` included. Its subview shape is load-bearing and not free-form:
react-native-screens sizes a sheet's scroll view itself, and **only when that
scroll view sits at subview index 0 or 1**
(`RNSScreenContentWrapper.mm::coerceChildScrollViewComponentSizeToSize`).
Anything else is left at Fabric's `(0, 0)` and paints from the sheet's top edge,
over the pinned header. Two consequences, both found on device:
  - the grabber lives **inside** the header wrapper, not beside it — as a
    separate sibling it pushed the body to index 2 and the `/search` results
    list rendered under the search field;
  - that sizing runs **once**, from the content wrapper's own layout pass, so a
    scroll view mounted *later* is never corrected. `/search` swaps its body
    between FleetBrowser's `FlatList` and a results `ScrollView` as you type, so
    it wraps both in one stable `View` and lets flexbox lay them out. The cost —
    no `prefersScrollingExpandsWhenScrolledToEdge` — is nil there: `/search` has
    a single detent, so there is no larger detent to expand to.

**Model viewer is the exception** — `fullScreenModal`, not a formSheet. A 3D
turntable needs the whole screen and its own gesture surface, and shouldn't
leave the map visible behind it (`src/app/_layout.tsx:34`).

---

## 2. Liquid Glass with graceful degradation — `GlassPanel`

**Problem.** iOS 26 Liquid Glass (`expo-glass-effect`) is the target aesthetic,
but the app must also run on older iOS and must respect the
**Reduce Transparency** accessibility setting — where translucent chrome is
actively harmful to legibility.

**Decision.** One component, `src/components/ui/GlassPanel.tsx`, with a
three-tier fallback ladder. Every floating surface in the app is a `GlassPanel`
— map chrome, sheet backgrounds, buttons, pills.

**The ladder** (`GlassPanel.tsx:59`):
1. **Real glass** — `glassSupported && !reduceTransparency` → `<GlassView>`
   (`glassEffectStyle` = `variant`, `isInteractive`, `tintColor`).
   `glassSupported` is resolved once at module load:
   `isGlassEffectAPIAvailable() && isLiquidGlassAvailable()`.
2. **Blur** — no glass, transparency allowed → `<BlurView>` (`expo-blur`),
   intensity `35` for `clear` / `60` for `regular`, `systemChromeMaterial*`
   tint by scheme, `overflow:hidden` to clip the blur to the radius.
3. **Solid** — Reduce Transparency on → opaque `<View>`
   (`rgba(28,28,30,0.94)` dark / `rgba(248,248,250,0.96)` light). No blur, no
   translucency: fully legible.

**Reduce-Transparency detail (a real bug that was fixed).**
`AccessibilityInfo.isReduceTransparencyEnabled()` is async. A module-level query
seeds `reduceTransparencyCache`, but a panel mounted *before* that promise
resolves would be stuck on the stale `false` seed — the change listener only
fires on *later* toggles, not the initial value. Fix: each `GlassPanel`
**re-queries on mount** and adopts the result, in addition to subscribing to
`reduceTransparencyChanged` (`GlassPanel.tsx:38-57`). Without this, VoiceOver
users with Reduce Transparency already on could get translucent panels on first
render.

**Variants.** `regular` (default) for legible chrome that sits over the busy
map; `clear` for thin pills and inline buttons where a lighter material reads
better (`GlassPanelProps`, `GlassPanel.tsx:27`). `interactive` opts a button
into glass touch reactivity.

---

## 3. Screen inventory & flows

The map (`/`) is the hub. From it: tap a tram → `/tram/[key]`; the bottom dock →
search / favorites / planner; the control stack → locate / 2D-3D / settings.
Sheets cross-link (tram → line, stop → line, stop → planner, tram → 3D viewer).

### 3.1 Map screen — `src/app/index.tsx`

Full-bleed Mapbox Standard, 3D pitch 45° at Prague center, live re-lighting.
Chrome (all `GlassPanel`, in `src/components/map/MapChrome.tsx`):
- **StatusChip** (top-left): live tram count + a `stale` warning when the last
  poll errored or is >30 s old (`useDataStale`, `MapChrome.tsx:40`).
- **ControlStack** (top-right): locate-me, 2D/3D pitch toggle, settings.
- **BottomDock**: a search pill + favorites + planner buttons.
- **FollowBanner** / **PlannerChip**: stacked glass chips above the dock (see
  §5, §7).

Camera-event handling is deliberately **ref-only** (`onCameraChanged`,
`index.tsx`) — no React state per camera frame. It updates the viewport ref
(frame culling) and sets the zoom-adaptive simulation rate; the one exception is
a single `setFollowPaused(true)` store write when a gesture starts during follow
(§5), which fires at most once per gesture. See §4 for splash timing and §6 for
the light preset.

### 3.1a The home surface — `MapSheet` (rewritten 2026-07-25)

**Problem.** The persistent home surface (search bar → grouped list) was a native
SwiftUI `.sheet` via `@expo/ui` (`HomeSheetNative`). That single choice caused
four separate user-visible defects, and none of them was fixable in place:

| Symptom | Root cause in the native sheet |
|---|---|
| Opaque slab hiding the map | `presentationBackground` takes a **solid `Color`** — Liquid Glass is not expressible |
| Bottom-right controls jumped to the sheet only *after* it settled | A native sheet exposes its **resting detent only**, never a continuous drag position |
| Settings felt slow — the search bar slid away, *then* the panel appeared | A UIKit modal **cannot stack on** a SwiftUI `.sheet`, so presenting any router formSheet dismissed the home sheet first |
| Tram sheet vanished on dismiss, search bar respawned a beat later | Same — the home sheet had to re-present itself after the tram modal closed |
| Wide, half-empty card on iPad | A native sheet at regular width presents as a centered card |

**Decision.** Own the surface: `src/components/maps-kit/MapSheet.tsx`, an
ordinary view in the map screen driven by Reanimated + gesture-handler. Nothing
about it is modal, so router sheets present straight over it.

- **Material** — a `GlassPanel variant="regular"` sibling behind the content.
  Real Liquid Glass; the map reads through it at every detent.
- **One source of look-and-feel — `src/components/maps-kit/sheetLook.ts`.**
  Radius, gutters, the full-detent top gap, the scrim ceiling and the grabber
  live in exactly one module. `mapSheetLayout` imports and re-exports them, so
  the worklet math, the native `formSheet` options and the `SheetSurface` /
  `SheetHeader` primitives cannot drift apart again — which they had: the owned
  sheet rounded at 38 while every native one rounded at 24. It also carries the
  **surface-material rules** (glass as a sibling — at
  `borderRadius: DEVICE_CORNER_RADIUS`, see the capsule note below — transparent
  `contentStyle` on native sheets, no glass-on-glass, capsules at `r = h/2` and
  never `borderCurve: 'continuous'`), and the **solid page fill** the surface
  crossfades to at the full detent.
- **Geometry — measured, not guessed.** The card was matched against Apple Maps'
  place card on the same iOS 26 simulator by *decoding the screenshot*: it is
  found by the brightness step its glass makes over the map and by the sharpness
  drop it causes (glass blurs what is behind it). Both methods agree. The
  **ours** column is what the same decoder reads back off *our* screenshots:

  | | Apple Maps | ours (re-measured) | constant |
  |---|---|---|---|
  | card margin at peek (L/R/bottom) | 22.5 / 22.6 / 22.7 pt | 21.83 / 21.79 / 22.7 | `SHEET_SIDE_INSET`, `PEEK_FLOAT` |
  | collapsed card height | 64.9 pt | **65.8** | derived |
  | shape at rest | **capsule**, R 32.25 / 32.75 vs h/2 = 32.45 | capsule, R 32.50 / 32.00 vs h/2 = 32.9 (rms 0.09) | — |
  | content inset, all four sides | 13.8 T / 13.8 B | 14.7 T / 13.4 B | `CARD_PAD`, `SHEET_H_PAD` |
  | grabber | 50 × 4.7 | 50 × 5 | `GRABBER` |
  | grabber ↓ from card top | 4.2 pt | 5 | `GRABBER.topGap` |
  | grabber → field air | 5.3 pt | 5 | `GRABBER.toContent` |
  | field height | 37.3 pt | **38** (37.7 measured) | `SEARCH_H` |
  | trailing circle | 34.8 (unfilled symbol) | **38 — equal to the field** | `SETTINGS_D` |
  | top of the **medium** detent | 486.2 pt (search sheet AND place card) | **486.5** home · **486.4** tram card | `MEDIUM_DETENT` |
  | side inset at **medium** | 5.9 / 5.9 pt | 5.15 / 5.16 | `MEDIUM_SIDE_INSET` |
  | **bottom gap at medium** | 5.9 pt | 6.1 (home and tram card) | `MEDIUM_BOTTOM_GAP` |
  | bottom radius at medium | **52.00** (rms 0.207, n=177) | **51.75** (rms 0.255, n=182) | `FLOAT_BOTTOM_RADIUS` |
  | top radius at medium | 35.75 (rms 0.256) | 38 — see the residual below | `SHEET_RADIUS` |
  | side inset at **large** | 0 (flush) | **0.0 / 0.0** | `FULL_SIDE_INSET` |
  | bottom at **large** | flush | flush | `DEVICE_CORNER_RADIUS` |
  | top radius at **large** | **38.00** (rms 0.398) | 38 | `SHEET_RADIUS` |
  | top of the **large** detent | **111.83** pt | **111.9** home · **111.9** tram · **111.9** `/settings` | `FULL_TOP_GAP` |
  | world dim at large | α 0.527 dark | α 0.506 dark · α 0.198 light | `SCRIM_MAX_DARK`, `SCRIM_MAX_LIGHT` |
  | surface at large | solid, (24,29,21) ⇒ luma 27.5 | **(28,28,30)** ⇒ luma 28.2 dark · **(242,242,247)** light, opaque | `SHEET_SOLID_DARK/LIGHT` |

  **The place card at `large` is a STACKED sheet, and that is why it reads 10 pt
  higher than the search sheet.** Measured in one session: the root search sheet
  alone tops out at 111.83 with a dim of α 0.527; a place card, which Maps
  presents *over* that search sheet, tops out at 101.83 with a dim of α 0.775 —
  and 1 − (1 − 0.527)² = 0.776, i.e. exactly two of UIKit's own veils. Our sheets
  are never stacked (the home sheet slides off stage while the tram card is up),
  so **111.83 is the number to match**, and the 121.8 the old `FULL_TOP_GAP` was
  built on is not reproducible against either reading.

  **Residuals still over 2 pt after the parity pass** — one, reported rather
  than fixed: the **top corner radius at the medium detent**, Apple 35.75 vs our
  38 (Δ 2.25). Apple is not self-consistent here — the same estimator fits 38.00
  on its *large* detent, where the surface is opaque and the edge crisp — so our
  single constant already matches one of its two readings exactly. Separately,
  Apple's bottom corner is a **continuous** curve and ours is **circular**: at
  40 pt above the bottom edge Apple's rim is 2.64 pt inside its straight edge
  where a circle of the fitted radius predicts 1.4, and ours measures 1.32.
  Fixing that would mean `borderCurve: 'continuous'` on the card, which renders
  the *bar's* capsule as a squircle — a regression in the most-seen state — so it
  is documented, not applied.

  **Cross-family verification (the "every sheet is one component" pass).** The
  same decoder was run over *every* sheet on the iPhone 16 Pro simulator (iOS 26,
  dark, 1206 × 2622 @3): the owned home sheet plus `/search`, `/settings`,
  `/favorites`, `/rides`, `/planner`, `/line/[id]`, `/stop/[key]` and
  `/icon-preview/[pack]`, each at its tallest detent and (where it has one) a
  middle detent. Grabber region, pixel for pixel:

  | | pill w × h | top gap | centre x | composited rgb |
  |---|---|---|---|---|
  | owned home sheet (large) | 50.00 × 5.00 | 5.00 | 200.83 | (16, 18, 22) |
  | all six native route sheets (large) | 50.00 × 5.00 | 4.67 | 200.83 | (66, 67, 73) |

  Top edge of the fully-open sheet: owned **122.00**, every native sheet
  **121.67** — a 0.33 pt spread, inside the ±2 pt target and 21 pt closer than
  the old hard-coded 0.95. Corner radius is now literally the same constant on
  both families.

  **The side-inset deviation at FULL is CLOSED.** It used to read "owned 5.2 /
  5.6 pt against native 0.12 / 0.45, not fixable from JS" — but the unfixable
  half was never the native one. UIKit floats a formSheet at lower detents and
  *closes the gutter as the sheet rises*; re-measured one sheet per height,
  sub-pixel, on this device: top 481 pt (`/line`, 0.45) → **5.03 / 5.29**, top
  393 (`/settings`, 0.55) → **2.80 / 2.90**, top 122 (either, at full) → **0.12 /
  0.45**, identical in dark and light. That is exactly the curve the owned sheets
  now follow, so the two families agree at **every** detent. Re-verified this
  pass at the two ends: `/settings` at its 0.56 detent measures **3.3 / 3.3** and
  at full **0.3 / 0.3, top 122**, against the owned home sheet's **5.0 / 5.9** at
  medium and **0.0 / 0.0, top 122.0** at full.

  One genuine difference is left and it is deliberate: at a *partial* detent the
  native sheets sit **flush at the bottom**, while the owned sheets keep Apple
  Maps' 5.5 pt bottom float. The reference for the owned sheets is the Maps place
  card, not a plain formSheet, and the place card measurably floats on all three
  free sides at half. UIKit exposes no bottom-inset knob for a formSheet, so this
  cannot be pushed either way from JS — and the right way round is the one that
  matches the surface being imitated.
  - **Scrim strength at the FULL detent — FIXED, by splitting it by appearance.**
    UIKit's dimming view is not one value: same map band, sheet away → sheet at
    full, four sub-bands each, on this device — dark 68.65→33.21, 76.79→39.68,
    65.69→33.01, 65.68→32.43 (α 0.516 / 0.483 / 0.498 / 0.506) and light
    64.05→51.22, 76.22→60.79, 62.32→49.90, 57.69→45.92 (α 0.200 / 0.202 / 0.199 /
    0.204). Flat across the band in both, so a plain black fill can match it
    exactly. The old single `SCRIM_MAX` = 0.28 was half the system's dim in dark
    and 40% over it in light. `SCRIM_MAX_DARK` 0.50 / `SCRIM_MAX_LIGHT` 0.20,
    read only through `scrimMaxFor(appearance)`, now land the owned home sheet on
    α **0.502** dark and **0.197** light — against the native sheets' 0.482 and
    0.201 measured in the same session, i.e. inside 0.02 of UIKit in both.

  Three rejected passes and what replaced them:

  1. *Uneven collapsed bar.* The inset was 14 horizontal but only 9 vertical, and
     the grabber had 2 pt of air on each side. Apple pads a **uniform** 14.3 on
     all four sides, and its top inset is not a chosen number — it is exactly the
     grabber band, `4.7 + 4.3 + 5.3`. So `HEADER_PAD_TOP = GRABBER_TOP_GAP +
     GRABBER_H + GRABBER_TO_FIELD` (15, one point off the sides — optically the
     same, structurally exact) and `HEADER_PAD_BOTTOM = SHEET_H_PAD = CARD_PAD`.
     The right side was the other half of the complaint, and the **first fix for
     it was itself wrong**. Apple's trailing element is an *unfilled*
     `person.circle` symbol (34.8 across), so its glyph is naturally smaller than
     its slot and the sheet material shows through it; reading that as "the
     trailing circle is 0.82 of the field" produced a 40 pt filled disc beside a
     48 pt field, and on device the user's verdict was that it looked ridiculous.
     Ours is a *filled* disc in the same recessed fill as the field, so the two
     must be the **same size**: `SETTINGS_D === SEARCH_H`. One height, one
     baseline, one `r = h/2` rule, and a trailing inset equal to the leading one
     (measured back: field right edge → disc 8.0, disc → card edge 14.0). The
     wrapper "slot" is gone — the pressable *is* the circle, so the visible
     button and the tap target are one object. `SEARCH_H` also came down 48 → 40
     (Apple 39–42.7), which is what puts our collapsed card at 68.6 pt against
     Apple's 67.2 instead of the old 77. Glyphs followed: magnifier 17 → 16,
     gear 20 → 18.

  2. *One-stage transition.* The side inset reached 0 within `FLOAT_FADE` of
     peek, so a **half-open sheet was already edge-to-edge** and full screen had
     nothing left to express. `cardShapeFor(height, snaps, peekCardH)` — still one
     pure worklet, monotonic in height — now runs **three stages**:

     | stage | range | bottom gap (`lift`) | radii | side inset | scrim | solid |
     |---|---|---|---|---|---|---|
     | 1 detach | peek → peek+`FLOAT_FADE` (80) | 22 → **5.5** | bottom h/2 → **52.5**, top h/2 → 38 | 22 → 5.3 | 0 | 0 |
     | 2 plateau | → the medium detent | **5.5** | bottom 52.5, top 38 | **5.3** | 0 | 0 |
     | 3 full screen | medium → large | **5.5 → 0** | bottom **52.5 → 62**, top 38 | **5.3 → 0** | 0 → 0.50/0.20 | 0 → **1** |

     Stage 2 is the point: the whole middle of the drag is *one stable shape*, a
     card floating clear on all three free sides, exactly like Apple's half
     sheet. Stage 1's window is clamped to `min(FLOAT_FADE, medium − peek)` so a
     short window still finishes detaching by the plateau instead of overlapping
     stage 3. The bottom radius is the **measured** `FLOAT_BOTTOM_RADIUS` at
     every detent that floats — 52.5, where the concentric rule this document
     used to state (`DEVICE_CORNER_RADIUS − gap` = 56.5) is 4 pt too open
     against Apple's fitted 52.00 — and the bar is the one exception, where the
     card *is* a capsule.

     `lift` is a transform, so the bottom float costs nothing: the card is
     bottom-anchored and its box is `heightSV − lift` tall with a `−lift`
     translation, which leaves the **top** edge at `windowHeight − heightSV`
     whatever the lift is. That is also what the `hidden` hand-off travel is
     derived from, so the two stay consistent.

  3. *Full screen — full-bleed, then frozen, now correct.* This one took two
     wrong passes. First stage 3 closed the gutter **during the detach**, so a
     half-open sheet was already edge-to-edge and read as sliding off past the
     screen edges. The correction over-steered: the gutter was frozen at 5 pt all
     the way to the largest detent, and then a *fully open* sheet stopped short
     of the screen edges and never stopped being a floating card. Neither is what
     Apple draws. The pixel measurement was right the first time — at FULL,
     `insetL = insetR = 0`, the bottom is flush and the bottom corners open to
     r ≈ 62, the display's own radius, so the device mask clips them concentric.

     The fix is not to pick one of the two shapes but to put the change on the
     right leg: the gutter and the bottom float hold at Apple's ~5 pt for the
     whole plateau and close **only over medium → large**. `cardShapeFor` still
     floors `sideInset` at 0 and `lift` at 0, so no drag, overshoot, rounding or
     un-laid-out first frame can make the card wider than the screen or push it
     below the bottom — there is a test across ±400 px of the range — and the
     empty-snap-table branch now returns the *half* detent's shape (floating,
     glass, undimmed), because a first frame that flashed opaque full-bleed would
     be a worse artifact than one that flashed a slightly small card.

     The last leg also stops being only a scrim: the surface **crossfades from
     Liquid Glass to a solid page fill** (`SHEET_SOLID_DARK` #1C1C1E /
     `SHEET_SOLID_LIGHT` #F2F2F7 — Apple's own, sampled at (33,35,37) across two
     plain bands of the dark reference card). That is what makes full screen a
     *mode* rather than a taller card. It is drawn as an **opaque overlay above
     the glass** whose opacity is a worklet of the drag — never by animating the
     glass's own alpha, which is undefined behaviour in UIKit and is the
     documented way to lose the material permanently.

     The full detent also stops **50 pt below the safe-area top** (`FULL_TOP_GAP`),
     which is what puts its top edge at a measured 111.9 against Apple's 111.83
     and its height at 762 against Apple's 762.2. The value was 60 and left the
     sheet 10 pt short; before that it was 10, which made the card 50 pt too tall
     — a takeover, not a card under the status bar. Note that `insets.top` on an
     iPhone 16 Pro is **62**, not the 59 the test fixture used to claim.

     The **scrim** is a sibling *behind* the card covering the whole window (the
     sheet's root container is full-window and `pointerEvents="box-none"`, so the
     map keeps every touch it had). Its opacity comes from the same worklet — zero
     React per frame. Whether it *takes* touches cannot be a worklet (`pointerEvents`
     is a React prop), so it is gated on the settled detent index, written once per
     settle: inert and invisible below large, tappable at large where a tap
     collapses to medium (`accessibilityRole="button"`, label "Collapse sheet",
     and `accessibilityElementsHidden` while inert — `pointerEvents` is invisible
     to UIAccessibility, so without it the map had a phantom button behind it).

  The side inset is a layout prop, but the card is already re-laid-out every
  frame for its height and its content is absolutely positioned at a fixed size,
  so the extra cost is a rounding error.

  Two things that looked "crooked" and were:
  - `GlassPanel` defaults to `borderRadius: 20`. Inside a card clipping at a
    34 pt capsule, the glass's own smaller corners left the map showing through
    the mismatch. The first fix was `borderRadius: 0` — clipped by the card, and
    it removed the mismatch, but it also caused the *next* report: **"the ends of
    the collapsed bar are straight."** They measurably were. A/B on device, same
    bar over the same map, rim found by the first midpoint crossing scanning in
    from the map (immune to the glass's inner specular highlight) and fitted to a
    rounded-rect model: with the glass square the best fit is **R 33.5 (rms
    0.27)** against a 34.75 capsule — a real flat on each end; with the glass
    rounded the best fit **is** the capsule, **R 34.5 (rms 0.15)**. So the glass's
    own shape, not the card's clip, is what the eye reads at the corners.
    The glass now takes `borderRadius: DEVICE_CORNER_RADIUS` (62): CALayer clamps
    a corner radius to half the shorter side, so on the 69.5 pt bar that resolves
    to exactly `h/2` and the glass draws its own capsule *on* the card's, while at
    every taller detent 62 is ≥ the card's largest radius and the card's clip is
    the tighter shape, keeping sole ownership of the animated silhouette.
    Re-measured after the change: best fit **R 34.5** against a 34.75 capsule, at
    the default text size and at `content_size extra-large`.
  - `borderCurve: 'continuous'` was on the search field and the settings button.
    That modifier is for rounded *rectangles*; on a stadium/circle it renders a
    squircle whose silhouette reads as lopsided next to a true circle. Removed —
    capsules use `borderRadius = height / 2` and nothing else.

  The grabber is drawn in a full-width absolutely-positioned row with
  `alignItems: 'center'`. `alignSelf: 'center'` on an absolutely positioned child
  is *not* a reliable way to centre it — that is what put the pill off-centre.
  A card that merely *slid down* could never show that bottom gap, so the card
  box animates `height` for real — but its content is absolutely positioned at a
  **fixed** height anchored to the card's top, so only the box is re-laid-out per
  frame, never the grouped list inside it. The lift is a transform and the corner
  radius is paint-only: `height` is the single animated layout property.
- **Peek height is MEASURED, not assumed** (`onLayout` on the header). The header
  swaps between the search row and the taller follow mini-card; a hand-maintained
  constant drifted from the real layout and let the first grouped row peek out
  under the search bar. The sheet reports its snap table back up
  (`onSnapsChange`) so the chrome and the compass ornament anchor to its real
  edges. A sheet **resting at peek** follows the peek when it moves — clamping
  alone only ever raises the height.
- **Chrome ride** — `chromeRideFor(height, snaps, docked)` (pure worklet, unit
  tested in `__tests__/map-sheet-layout.test.ts`) returns an **absolute** offset
  from the window bottom, read every frame. The controls therefore travel *with*
  the drag instead of chasing it.
- **iPad / landscape** — `isDocked()` switches to a **docked side column**
  (Apple Maps' idiom) at regular width *or* whenever the window is wider than it
  is tall. The map chrome takes a matching `leftInset` so the status tile, the
  contextual chips and the Mapbox ornaments clear the column. A docked column has
  no grabber, so `DOCK_TOP_EXTRA` supplies the top inset the grabber gives a
  bottom sheet for free — without it the search field sat flush against the
  column's top edge. The ornaments are lifted above the floating peek capsule on
  a phone but stay at `bottom: 10` when docked (there the map runs to the bottom,
  and lifting them by the column's height threw them to the top of the screen).
- **Appearance** — the sheet is an app surface, so it follows the **system**
  scheme. Only chrome that floats over the basemap follows the map light preset.
  Mixing the two is what rendered a black gear icon on a dark sheet.

**Perf.** The drag lives entirely in `heightSV` on the UI thread; the sheet
transform, the body's `scrollEnabled` flip and the chrome ride are all worklets.
The only React commit is `onSettle`. Invariant #1 (`docs/performance.md`) holds.

**PRESENTATION HAND-OFF — two owned sheets, one at a time (rewritten 2026-07-26).**
`MapSheet` is not "the home sheet" any more: the **tram card is the same
component** (`src/components/tram/TramSheet.tsx`) with a different header, body
and middle detent. The map screen mounts whichever one is on stage.

- `presentedTramKey` (selection store) is the switch. `openTram(key)` is ONE
  atomic write that presents the card, claims `selectedTramKey` (the map's gold
  halo) and engages follow; `closeTram()` is the ✕'s full semantics — dismiss,
  release the halo, end the follow.
- While it is set, the home sheet is `hidden`: it slides down
  `heightSV + 60` — **translation only, no fade**. The travel is derived from the
  live height because the card's top edge always sits at `windowHeight − heightSV`
  (the float lift cancels), so that distance carries the card fully off screen
  from *any* detent; a fixed peek-sized travel left a sheet hidden from medium or
  full mostly on screen and relied on an opacity to hide it. The fade is gone
  because the card's backing is a `GlassView`, whose effect UIKit leaves undefined
  at **any** alpha below 1 — the old 0.01 floor dodged nothing. Hiding is a
  **transform, not an unmount**, so the search row keeps its identity and the
  return trip is a morph. The reveal is delayed `REVEAL_DELAY_MS` (120) so the
  two motions read as one object rather than crossing.
- The **map chrome rides whichever surface is visible**: the screen holds two
  shared values (`sheetHeight`, `tramHeight`) and two snap tables, and hands the
  chrome the active pair. That switch is one React commit per present/close; the
  ride itself is the same `chromeRideFor` worklet. `useChromeRide` therefore
  lists `sheetHeight` in its `useAnimatedStyle` deps — without it the worklet
  keeps the shared value it captured first and rides the hidden sheet.
- A **docked** column is never hidden (`offstage = hidden && !docked`).

**What this replaces, and why.** The previous pass put the followed tram's
identity in the HOME sheet's header (`FollowMiniCard`), so "minimizing" the tram
card meant *dismissing one surface and revealing a different one* — the identity
re-mounted in another view tree, at another size, behind a cross-fade
(`SheetHeader` ghost), with `expandLocked` / `onExpandAttempt` faking the reverse
gesture by pushing `/tram/[key]`. The user rejected it outright. All of it is
deleted: `FollowMiniCard`, `FOLLOW_CARD_H`, the ghost cross-fade, the lock path
and `LOCKED_RESISTANCE`. The home header is always `HomeSearchRow`.

**`MapSheet`'s new additive props**, all in service of the above:

| Prop | What it does |
|---|---|
| `mediumFraction` | Middle detent as a fraction of the window. Home = `HOME_DETENT`, tram = `CARD_DETENT`; since the parity pass both are the measured `MEDIUM_DETENT` (0.4436 ⇒ a card top at 486.3, against Apple's 486.2 for *both* of its sheets). All three constants live in `mapSheetLayout.ts` so the pure tests can pin them. |
| `initialSnapIndex` | Detent to rest at. The tram card opens at 1 (its card detent) and RISES there from the seeded peek, so there is no separate "open" animation to keep in sync. |
| `overlay` | A floating cluster drawn over the body and anchored to the CARD's bottom edge (Apple's action pill). Fades over the same `FLOAT_FADE` leg the card detaches on, so it is gone before the card is short enough to clip it, and its hit-testing is gated on the settled detent. |
| `label` | VoiceOver name of the resize control ("Home sheet" / "Tram card"). |

The resting detent is now tracked as an **index** (`restingIndex`), not a height.
Everything that moves the snap table — the header being measured for real, a
header that grew with Dynamic Type, rotation, an iPad resize — springs to
`snaps[restingIndex]`. That single rule replaced the old "clamp, unless resting
at peek" heuristic *and* gives the tram card its open-at-a-detent behaviour.

#### The body — four categories and the live gate (rewritten 2026-07-27)

**Problem.** The body was a flat list of four destinations (Favorites, Plan a
trip, Browse the fleet, Recorded rides) plus a "Recent routes" group. Every row
was a *link to somewhere else*: the home surface of a live-tram app showed no
live data at all, and "Plan a trip" sat as a peer of "Recorded rides" while the
user's actual recent routes were exiled to their own section below.

**Decision — four categories, in the order a spotter needs them.**

| # | Section | Content |
|---|---|---|
| 1 | *(no caption)* | **NEAREST STOP** — the closest station, the walk to it, and the next ≤ 4 arrivals (line badge, headsign, model · car number, live ETA). Header row → `/stop/[key]`; each arrival row → that tram's card. |
| 2 | FAVORITES | Starred trams as live rows (line badge, headsign, car number, **live status**, delay pill) → the tram card; starred lines as PID badges → `/line/[id]`; `See all` → `/favorites`. |
| 3 | TRIPS | Recent routes (≤ 3) **and** "Plan a trip" in ONE card — they are one intent, and the planner is what you reach for when none of the remembered pairs is the one you want. No big Plan-a-trip button. |
| 4 | EXPLORE | "Browse the fleet"; "Recorded rides" **only in debug mode**. |

- The hero card carries **no section label**: it is the top card and its own
  header row names it (Apple Maps' top card is uncaptioned too). A caption there
  would push the content the user came for further down for no information.
- **Live status prose** is `src/lib/tramStatus.ts` (pure, unit-tested in
  `__tests__/tram-status.test.ts`). The dwell stop CANNOT be read off the state:
  `nextStopName` is already the stop *after* the platform a dwelling tram is
  standing at, so "At Karlovo náměstí" comes from scanning the tram's own trip
  geometry for the first stop at/past `simDistM` (2 m dwell slack, the engine's).
- Identity, not a clone: the walk pin is `Tram.pidRed`, the badges are PID line
  badges, the arrival subtitles carry the model and the car number.

**THE LIVE GATE — the load-bearing perf decision.** Sections 1 and 2 subscribe to
the 1 Hz runtime (`useAllTramStates` / `useTramState` / `useNowMs`), and section 1
additionally runs `computeArrivals`, which is O(states × stops). None of that may
run while the sheet rests at peek over a hot basemap.

- `HomeSheetContent` takes a `live` prop and gates by **MOUNT**, not by a
  conditional inside a hook: at peek those components *do not exist*, so they hold
  zero subscriptions — the only version of this claim that is verifiable.
- The map screen derives the flag from a **threshold `useAnimatedReaction`** over
  the sheet's `heightSV`: `height > peek + 8`. The worklet emits a BOOLEAN and
  `runOnJS` fires only when that boolean flips, so it is one React commit per
  crossing, never per frame (invariant #1 holds — same discipline as the
  quantized `settledHeight` reaction beside it). `onSettle` was the obvious hook
  and is the wrong one: it fires when a drag *ends*, i.e. while the sheet is
  already springing open with its body partly revealed, so the live rows would
  visibly pop in mid-animation. The 8 pt is hysteresis, not taste — a bare
  `> peek` flaps the flag (and the mounts) under a finger resting on the capsule.
- `presentedTramKey != null` is ANDed in: `hidden` parks the home sheet off screen
  *without* changing its height, so without that term the body would keep polling
  behind the tram card.
- **Location policy** (`src/components/home/useNearbyStop.ts`): a **one-shot**
  `getCurrentPositionAsync` at **Balanced** accuracy (±100 m is plenty to pick a
  tram stop, and far cheaper than the High fix the Locate button takes), never a
  watcher. The fix is cached at **module scope with a 120 s TTL**, which is what
  makes the mount gate free — re-expanding the sheet re-renders the same station
  instantly instead of re-locating. **Never auto-prompt**: on mount we only *read*
  the permission; the system dialog is raised only by a deliberate tap on the
  card's own "Enable" row. A denied/blocked permission is a compact row that opens
  Settings; a failed fix is a quiet "tap to try again" row — never an `Alert`, a
  haptic, or anything that interrupts the map.
- Because `useLoadedGeometries()` returns a fresh array every 1 Hz tick, the
  nearest-station scan (O(all stops) + a haversine per station) is memoized on the
  geometry **count**, not the array identity. The shape cache only ever grows
  within a session, so the count is a sound proxy for "the station set changed".

### 3.2 Tram card — `src/components/tram/TramSheet.tsx` (rewritten 2026-07-26)

**One surface, three detents.** The card is an owned `MapSheet` on the map
screen, not a route. `/tram/[key]` still exists but renders **nothing**: it is a
deep-link shim (transparent modal, `animation: 'none'`) that writes
`openTram(key)` and calls `router.dismissTo('/')`. That keeps cold-launch deep
links and the search sheet's `<Link>` rows (which are Links specifically so each
row gets the native long-press menu) working, with no visible round trip.

| Detent | Height | What is visible |
|---|---|---|
| **bar** | `HEADER_PAD_TOP + header + HEADER_PAD_BOTTOM (+ PEEK_FLOAT)` | the pinned header only — the card clips, so nothing can peek below it. A true capsule: `r = h/2`, verified on device at 5 rows within 1 pt |
| **card** | `CARD_DETENT` = `MEDIUM_DETENT` = 0.4436 × window | header + body, floating on all three free sides — measured **5.0 / 6.2** at the sides and **6.1** at the bottom, top at **486.4** against Apple's 486.2 (it was 0.42 ⇒ 507.0, 21 pt too low) |
| **full** | same large detent as the home sheet | edge to edge (measured top **111.9** against Apple's 111.83, flush at the bottom, `(28,28,30)` to both edges) + the world dims (`scrimMaxFor(appearance)`) + the surface goes solid |

Dragging between them changes exactly one thing: the card box's height. **The
header is the same React element at the same size at every detent** — in
particular the **52 pt portrait never scales**, which the user asked for
explicitly. The old screen's scroll-driven collapse (52 → 28 icon, 64 → 44 band,
`HEADER_TOP_INSET`, `COLLAPSED_TOOLBAR_MASK`, `TOOLBAR_RESERVE`) is gone: the
header is `MapSheet`'s pinned slot, outside the ScrollView, so there is nothing
for it to collapse against.

Measured on device (iPhone 16 Pro, iOS 26, dark, sub-pixel luma-step fits):
portrait **52.0 pt at both the bar and the card detent**; bar card 771 → 852 pt
(height 81 = 15 + 52 + 14, floating 22 pt off the screen bottom, side inset
22.3); card detent side inset 5.0.

**Header chrome** is Apple's place-card set, not a native toolbar: a
`CloseCircle` ✕ on the trailing edge calling `closeTram()` — and nothing else.
(A blue `location.fill` "you are following this" glyph used to sit beside it; it
is gone. The follow state is carried by `FollowChip` floating above the sheet,
and a third indicator in the bar was noise.) There is no
`Stack.Toolbar` and no native header, which is what retired the whole block of
`formSheet` / transparent-header / `scrollEdgeEffects` options this route used to
carry in `_layout.tsx` — including the iOS 26 automatic scroll-edge effect that
used to wash a gradient over the identity block.

**Floating action pill** (`ACTION_PILL` in `sheetLook.ts`, measured off Apple's
place card: h 47, r = h/2, centre-to-centre 54.7, end-to-first-centre 24.0,
bottom edge 27–28.7 pt above the CARD's bottom): **2–3 buttons**,
`[☆ favorite] [ⓘ model info] [📷 photos — only when the car reports a reg]`. It
hangs off the card's bottom edge, so the card's float lift carries it for free,
and it overlays the scrolling body exactly as Apple's does. The ⋯ popover it
replaced (a hand-rolled glass menu guarding two pushes and the recording toggle)
is gone: the pushes each earned a button, and recording moved into the card's own
debug-only section.

**3D is not in the pill.** It has two entries that both *show* what they open —
the 52 pt header portrait and the About plaque — so a third, glyph-only one in
the capsule was the least legible of the three. The capsule hugs its content, so
dropping the button just narrows it; `ACTION_PILL` geometry is unchanged.

This is the app's **one documented exception** to the no-glass-on-glass rule
(`sheetLook.ts`): the pill does not sit *on* the surface, it floats *over*
scrolling content and has to occlude it. A recessed fill cannot.

**The body is three things (content redesign, 2026-07-27).** Pinned identity →
**UPCOMING STOPS** → **About**, plus a debug-only ride-recording section and a
debug-only honesty line. Everything that used to sit between them was deleted,
because every piece of it was a duplicate or a button for a state the user does
not operate:

| Removed | Why, and where it went |
|---|---|
| the `Following` / `Line N` in-content pill row | Following is **implicit**: opening the card starts the follow, and `FollowChip` owns pause / resume / end. `Line N` became a quieter affordance — the **header LineBadge is the button** into `/line/[id]`, with a 9 pt `chevron.forward` as its whole visual affordance (the badge already *is* the line; a second element repeating the number was pure duplication). The bar detent's height does not move. |
| `Next stop` stat tile | The countdown already ticks on the first row of the timeline. |
| `Delay` stat tile | The trip's `DelayPill` moved onto the **UPCOMING STOPS section heading**, where it captions the times it qualifies. |
| `Updated` stat tile | Same heading: an `antenna.radiowaves.left.and.right` glyph + `N s`, green at ≤ 15 s, grey after. |
| the whole `LiveStats` block | Nothing was left of it. There is deliberately **no replacement stats row** — the card gains ~110 pt of timeline above the fold at the card detent, and the timeline is the centerpiece. |

`SectionLabel` grew an optional `trailing` slot for this (`ui/Inset.tsx`). Without
it the component renders byte-identically to before, so no other screen moved.
The heading is the shrinking element (`flexShrink: 1` **and `minWidth: 0`** — a
flex item's automatic minimum is its min-content width, and without the override
the heading stopped shrinking at "UPCOMING" and the *data* clipped instead, which
is backwards; measured at Dynamic Type XXXL). The trailing node sits outside the
header `Text`, so VoiceOver reads two elements and a 1 Hz value never
re-announces a heading.

#### The living timeline — `src/components/tram/StopsTimeline.tsx`

With the stats band gone the timeline **is** the card, so it was rebuilt around
one idea: show the tram *moving*.

**One solid rail, in two tones.** The per-row `railTop`/`railBottom` segments are
gone; the container draws one continuous 2 pt bar from the first dot to the last
(one row further while collapsed, so it runs into the expander exactly as the
segments did). It is painted twice: a dim **travelled** bar at full length, and a
brighter **ahead** bar over it, anchored `transformOrigin: 'bottom'` and scaled
so its top edge is the tram. Nothing is dashed. Both tones are the existing
PID red / livery red at new alphas — dark `rgba(176,42,38, .75/.22)`, light
`rgba(122,6,3, .45/.15)` — so no new hue enters the palette. Measured on device
at the full detent: `(61,31,32)` behind the tram against `(147,39,36)` ahead of
it, with the switch exactly under the glyph.

**A departed row.** The stop the tram just left renders above the upcoming ones,
muted, with a hollow ring. It exists for the animation first — without it the
glyph would be pinned to the first dot with no segment of rail to travel, because
the first *upcoming* stop is the one the tram is heading to — and it doubles as a
genuinely useful "you just left Anděl" cue. It is not counted by
"Show all N stops" and collapsing does not touch it.

**The moving glyph.** A 22 pt disc riding the rail: livery red fill, a white
12 pt `tram.fill`, and a 2 pt ring in the sheet's own full-detent surface fill
(`sheetSolidFor`) at 0.9, which punches it out of the rail and out of any dot it
passes at *both* the glass and the solid detents. Deliberately **not** a
`TramFace`: at 22 pt the authored illustration is a smudge — the face keeps its
52 pt home in the header, where it reads. While the tram dwells, a halo pings out
of it (non-reversing repeat, 900 ms); the halo is *mounted only during dwell*,
because at rest it is a visible ring and would otherwise collar a cruising tram.
It is `pointerEvents="none"` and hidden from VoiceOver — AT STOP NOW / NEXT / the
countdown already say everything it shows.

**The animation contract (perf invariant #1).**

| | |
|---|---|
| anchor | `simDistM` on the shared ~1 Hz tick → `progress = clamp01((simDistM − segFrom) / (segTo − segFrom))`, in **ROW units** from the first rendered dot |
| transport | **one** shared value written once per tick |
| easing | `withTiming(progress, { duration: 1000, easing: Easing.linear })` — linear and exactly 1000 ms so the ramp lands as the next anchor arrives: one constant-velocity glide, not a per-second ease pulse. A late tick holds; it never extrapolates |
| consumers | two `useAnimatedStyle` worklets — the glyph's `translateY` and the ahead-rail's `scaleY`. **Zero React renders per frame, and no row re-renders**: the rows are plain `View`s neither worklet touches |
| snap | a `segKey` of tripId + departed stopId + head stopId — when it changes the list has been re-sliced, so the SV is set directly instead of animated |
| Reduce Motion | `useReducedMotion()` → snap, and the dwell halo becomes a static ring |

**Uniform `ROW_H` is the contract, not styling.** The glyph's offset is
`progress × ROW_H` arithmetic with **no `onLayout` anywhere** — measuring would
cost either a React commit per stop passed or a race with the running animation.
So every row (departed, stop, expander) sets `height: ROW_H` exactly, and the one
thing that could grow a row — the old two-line "Terminus" label — became an inline
`flag.checkered` glyph. `ROW_H` scales with `fontScale` (clamped at
`TextScale.content`) so the rows grow with Dynamic Type instead of clipping, and
the name column carries `minWidth: 0` for the same reason the section heading does.

**What a stop-pass looks like**, measured on device: `upcoming` re-slices and
`departed` advances in the same commit, the whole list shifts up by one `ROW_H`,
and the glyph shifts with it — i.e. it stays glued to the stop it is at while the
list scrolls under it. Verified at 15 s intervals on a cruising night tram: the
glyph moved 24 % → 63 % → 89 % of the way between two fixed dots, and at 3 s
intervals it advanced ~1.0–1.3 pt per sample with no plateaus.

**About is a plaque, not a floating illustration.** Art left (64 pt tall, on the
group's 16 pt row padding), identity + specs right, the whole row being the 3D
affordance (`rotate.3d` + chevron); then an explicit **Model info & history** row
into `/model-info/[id]`. Two text lines carry what four one-fact `InsetRow`s used
to: `manufacturer · yearsBuilt` (allowed **two** lines — rebuilt types carry
compound builder strings that otherwise truncate the years off the end) and
`length m · sections · top speed`. There is deliberately **no seat or capacity
figure**: `TramModelSpec` has no such field, and inventing one on a spec plaque is
exactly the fake datum §8 forbids. The old centred `ModelPreviewButton` wasted
the card's whole right half; it stays in the repo for its other consumers.

**One content grid.** Every top-level element in the body starts at `SHEET_H_PAD`
(16) and every `InsetGroup` row keeps its own 16 (text at 32). The stray
`paddingHorizontal: 4` on the amenity chips and the fun fact is gone, the honesty
line is no longer centred, and the section rhythm is `gap: 22` — the same as the
home sheet.

**Resume-follow is a chip, not a sheet control.** `FollowChip` (in `MapChrome`)
appears only when a follow is active AND paused — i.e. the user grabbed the map.
It lives in the chip cluster, which already rides the ACTIVE sheet's live height
on the UI thread, so it floats just above whichever surface is on screen at any
detent. The body resumes; its ✕ ends the follow. The earlier design put that
button inside the home sheet's follow header, where it vanished the moment the
tram card was open — precisely when a paused follow is most likely.

**State machinery worth knowing:**
- `useEtaCountdown` / `useNowMs` anchor on each ~1 Hz runtime value and tick
  locally every second, so countdowns never freeze between polls.
- `openTram` claims `selectedTramKey` for the map's gold halo. Two call sites
  (the line sheet and the stop sheet) used to forget that entirely and only push
  the route — which is why a tram opened from those had no selection ring.
- **Gone / "Left service"** — if the tram drops out of the feed, `lastSeen`
  (state adjusted during render, not a ref) renders a `GoneHeader` in the pinned
  slot plus a `GoneState` body with the last known line + reg. Dismissal is a
  store write, not `router.back()`: there is nothing on the stack to pop. If
  following, it auto-unfollows.
- Opening from a SHEET (favorites / line / stop / search) is `openTram(key)`
  followed by `router.dismissAll()` — the store write first, so the card is
  already mounted underneath as the sheet animates away.

**The concentric portrait corner (measured 2026-07-25, still current).** The
sheet's corner is `SHEET_RADIUS` 38 and the content inset is `CARD_PAD` 14.
Concentric nesting rule: inner radius = outer − gap, so the two corner centres
coincide and the band between the curves is constant around the whole corner.
`PORTRAIT_RADIUS = 16` with `borderCurve: 'continuous'`; 13 pinched the diagonal,
20 bulged it (verified by screenshot at 3–4×).

### 3.3 Stop sheet — `src/app/stop/[key].tsx`

`key` = `normalizeName(stopName)` — the same station grouping the planner uses,
so a stop is one sheet regardless of platform/direction. A **live arrivals
board** computed from runtime states + loaded geometries via
`computeArrivals()`, recomputed on every ~1 Hz tick (states identity changes) so
ETAs count down without a dedicated timer (`stop/[key].tsx:61`). Each arrival
row shows line badge, headsign, model + reg, an **AC snowflake**, and ETA;
tapping opens that tram's sheet. Header has the serving-line badges (tap → line
sheet), "Show on map", and a **Route here** CTA (§7). Distinct empty states for
loading / stop-not-found / no-trams-approaching.

### 3.4 Line sheet — `src/app/line/[id].tsx`

Header (badge, live active-tram count, a `NIGHT` pill for night lines, favorite
star), a **direction segmented control**, and a stop **timeline** with **live
trams inlined between the stops they're currently between**.

- **Directions = the two most common trip headsigns** (`headsigns`, by
  frequency, `line/[id].tsx:82`). There's no clean "direction" field in the
  feed; the dominant headsigns are the pragmatic stand-in.
- **Track direction by headsign string, not index.** As geometry streams in the
  frequency ordering can shift; an index would silently flip the user's chosen
  direction. `selectedHeadsign` stores the string and falls back to the top
  headsign only when it disappears (`line/[id].tsx:98`).
- **Only same-shape trams are placed on the timeline.** Distance-along-shape
  (`simDistM` vs each stop's `distM`) is meaningless across shape variants /
  diversions, so only trams whose trip shares the displayed `shapeId` are
  interleaved; same-direction trams on other variants are reported as a footer
  count instead of being mis-placed (`line/[id].tsx:127`).

### 3.5 Search sheet — `src/app/search.tsx`

Glass search field, live sections as you type: **Lines** (badge grid), **Trams**
(registration match), **Stops** (diacritics-insensitive via `searchStops`).
Recents kept in a **module-level in-memory list** (last 6) — survives sheet
close, not app restart (`RECENTS`, `search.tsx:37`); a manual **Clear** resets it.

**The line-vs-registration fix** (`search.tsx:96`). A 1–2 digit query is
ambiguous: is `22` line 22, or a substring of registration `9224`/`9322`? Rule:
if the query names a line the network **actually runs** (`lineTramQuery`), the
Trams section lists trams operating **on that line** (sorted by registration),
and the section relabels to *"Trams on line 22"*. Otherwise (2+ digit query that
isn't a live line) it's registration matching, prefix-before-substring. This
stops a line-number search from surfacing unrelated registration coincidences.

### 3.6 Favorites — `src/app/favorites.tsx`

Starred **trams** (with live in-service status) and starred **lines** (with live
active-tram counts), from `useFavoritesStore`. Empty state nudges you to spot &
star on the map. iPad: the lines section becomes a 2-up grid (§10).

### 3.7 Settings — `src/app/settings.tsx`

iOS grouped-inset lists on glass (`InsetGroup` / `SectionLabel` / `RowSeparator`
from `src/components/favorites/`). Groups:
- **Positioning** — the Smooth/Live position-mode segmented control (§11).
- **Map** — light preset (Auto/Day/Dusk/Night, §6), Route lines toggle, "Follow
  locks heading" toggle.
- **Motion data** — export/clear the real-vs-sim telemetry logs (§9).
- **About** + **Data & attribution** (Golemio / PID / Mapbox links, version).

### 3.8 Planner — `src/app/planner.tsx`

See §7 (Google-Maps parity).

---

## 4. Splash handoff

**Problem.** Don't strand the user on the splash if the map is slow or fails.

**Decision.** `SplashScreen.preventAutoHideAsync()` at module load
(`_layout.tsx:5`); the **map** hides it once the base map renders
(`onDidFinishLoadingMap → hideSplash`), with an 8 s **failsafe** timer that
hides it regardless (`index.tsx:47,71`). `splashHiddenRef` guards against a
double-hide. The map, not the layout, owns this because the map is what the user
is waiting for.

---

## 5. Follow banner + pause / return-to-follow

**FollowChip** (`MapChrome.tsx`) floats in the chip cluster, which rides the
ACTIVE sheet's live height on the UI thread — so it sits just above whichever
surface is on screen (the home sheet, or the tram card at any of its three
detents). It is shown **only while a follow is active AND paused**: while the
camera is actually tracking, the tram card's own header already says so with a
blue `location.fill`, and a permanent chip on top of that was pure duplication.
It reads the followed tram via `useTramState(followKey)` for its `Line N · #reg`
detail.

**Follow holds the current map angle — it never auto-turns.** Engaging follow
snapshots the *current* camera zoom/pitch/heading as a **fixed** orientation;
the camera keeps the tram centered under exactly that angle and does **not**
rotate toward the tram's bearing. (An earlier design captured a *heading offset
relative to the bearing* and re-applied it every retarget — which meant a stray
touch silently recorded an offset and the map lurched to a new heading. That
whole mechanism was removed.)

**A gesture pauses follow; it doesn't cancel it.** The moment the user pans/
zooms/rotates/tilts, `onCameraChanged` sets `followPaused` (one store write per
gesture, `src/stores/selection.ts`) and the camera is handed entirely to them.
`followTramKey` is **kept** — we remember which tram — and the chip flips to a
**"Return to follow"** control (`SymbolView location.viewfinder`). Tapping it
re-snapshots the user's *current* zoom/pitch/heading and gently eases the center
back onto the tram (`CAMERA_RETURN_MS`, 600 ms), preserving that angle/zoom. The
chip **✕** ends follow entirely (`setFollowTramKey(null)`, clears both). Because
`setFollowTramKey` always clears the paused flag, a spotter target hop lands as
a live follow, never stuck paused.

---

## 6. Light preset

The map's Standard basemap is re-lit live. `resolveLightPreset(setting, clock)`
maps the settings choice (`auto`/`day`/`dusk`/`night`) — where `auto` follows
Prague time-of-day — to a Standard `lightPreset`, re-evaluated every 5 min via a
`lightClock` tick (`index.tsx:62`). The `<StyleImport>` is mounted **only after
the style loads** — applying import config earlier logs *"Import basemap does not
exist"* and is silently dropped (verified on-device, `index.tsx:216`).

---

## 7. Planner — Google-Maps parity

**Problem.** A bare A→B planner feels primitive next to the transit apps users
already know.

**Decision.** Match the expected affordances: **recents**, **nearest-stop
fill**, **route-here handoff**, and **live wall-clock times + countdowns**.

- **Recents** — persisted pairs in `usePlannerStore`; shown when idle, tap to
  re-plan, swipe/remove supported (`RecentRoutes`).
- **Nearest stop → From** — the locate button reads device location and fills
  From via `nearestStation()`. Permission denial and errors surface as friendly
  `Alert`s and never throw into render (`handleLocate`, `planner.tsx:186`).
- **Route here** — the **stop sheet** hands a prefilled `{from: nearestStop, to:
  thisStop}` to the planner via `requestPrefill`, then `router.replace('/planner')`
  (`stop/[key].tsx:82`). The planner consumes the one-shot prefill, sets both
  fields, and **auto-plans** once geometry is ready (`autoPlanPending`,
  `planner.tsx:218`).
- **Live times** — each result is timed with `computeItineraryTiming()` against
  live tram states and **sorted by earliest live arrival** (schedule-only
  itineraries fall back to fewest transfers / stops). A 1 Hz `nowMs` tick keeps
  wall-clock times and "in N min" countdowns current independent of the ~1 Hz
  states cadence (`ranked`, `planner.tsx:258`).
- **Single planning path.** BFS runs **only** in `runPlan(fromVal, toVal)`,
  driven by explicit values so button-press, keyboard-submit, recent-pick, and
  prefill auto-plan all share one path — never during render (`planner.tsx:130`).
- **Active-route handoff.** Picking an itinerary stores it in `usePlannerStore`
  and closes the sheet; the map draws the route and fits bounds. A **PlannerChip**
  above the dock shows the active route — **tapping its body reopens the planner
  sheet** (users kept losing the sheet with no way back), the ✕ clears the route
  (`MapChrome.tsx:253`).

---

## 8. Tram sheet evolution — the "fake speed" removal

**Problem (original).** The first tram sheet (commit `d415c3c`) showed a
prominent **`{simSpeedKmh} km/h`** live cell. But that number is the *physics
simulator's* interpolated speed, not real telemetry — the feed gives positions
and delays, not instantaneous speed. Presenting a made-up number as a live
readout is dishonest and misleads the user about what's known.

**Decision & evolution.**
1. **Revamp (`eca1084`)** — the km/h cell was **removed** and replaced with
   **real AVL sync age**: *"updated Ns ago"*, the age of the last real
   `origin_timestamp` observation. This tells the truth about data freshness
   instead of inventing a speed (`tram/[key].tsx:211`). The header also gained
   the model face illustration.
2. **Position-mode honesty (`d76eaf2`)** — a **deviation line** was added below
   the live row (`tram/[key].tsx:343`): in Smooth mode it shows *"Sim offset ±N m
   from last fix"* (how far interpolation has drifted from the last real AVL
   fix, `state.deviationM`); in Live mode it shows *"Showing raw reported
   position"*. The simulation now openly declares its own uncertainty.
3. **Tappable face → 3D viewer** — the header illustration became a
   `ModelPreviewButton` opening the full-screen 3D viewer (§ below).

**Principle:** show real, dated data (AVL age, delay from the feed) and label
anything the app synthesizes (sim offset). Never dress up a simulated quantity
as a measurement.

**Amendment (2026-07-27) — the honesty line is now debug-only.** The content
redesign in §3.2 deleted the card's whole stats band, and with it the last
synthesized quantity the card presented. Both honesty strings — *"Sim offset ±N m
from last fix"* and *"Showing raw reported position"* — are unchanged in wording
but now render only when `settings.debugMode` is on.

Rationale, recorded so this does not read as a silent regression of point 2
above: the line existed to qualify something the card was *showing*. After the
band was removed the card surfaces nothing simulated at all — the timeline's
times are feed schedule + feed delay, the freshness chip is the age of a real
`origin_timestamp`, and the delay pill is the feed's own number. The only thing
left for the line to qualify is the **map's dot**, which is chrome this card does
not own and which the user opted into in Settings (§11, Smooth vs Live). A
permanent caption about another surface's uncertainty, under a card that no
longer has any, was noise.

**§8's hard rule stands unchanged:** never present `simSpeedKmh`, or any other
simulated quantity, as a measurement. Nothing in the redesign surfaces a speed —
not on the card, not in a favourite row, not anywhere.

---

## 9. The 3D viewer — `expo-gl` + three 0.162 quirk chain

**Problem.** Render the fleet's authored GLB sections as an interactive turntable
inside RN. `expo-gl` + `three` is the only viable stack, but three r162 makes
web/DOM assumptions that break under Expo GL. Full-screen modal at `/model/[id]`.

**Decision.** Use `expo-gl` + `three@0.162` (pinned) with a chain of
compatibility shims, all guarded so any failure lands in a friendly error state
rather than a crash. The chain (documented in commit `e0e5ddb`):

1. **`three` pinned to 0.162 (WebGL1).** Later three assumes WebGL2 APIs that
   expo-gl doesn't fully provide; 0.162 is the last comfortable WebGL1 line.
   Also pinned so the shims below stay valid.
2. **`navigator.userAgent` polyfill.** RN defines `navigator` without
   `userAgent`; `GLTFLoader` (r162) does `navigator.userAgent.indexOf('Firefox')`
   and crashes on `undefined`. A module-top guard defines a stub UA string
   (`model/[id].tsx:20`).
3. **`getParameter` string shim.** expo-gl returns `undefined` for
   `VERSION` / `SHADING_LANGUAGE_VERSION`; three calls `.indexOf` on them. Wrap
   `gl.getParameter` to return WebGL-1 id strings for those pnames
   (`model/[id].tsx:239`).
4. **Fake canvas.** three r16x wires context-loss listeners and reads
   dimensions off a canvas-shaped object even when handed a raw context —
   `makeFakeCanvas` supplies one (`model/[id].tsx:78`).
5. **MeshBasicMaterial pipeline primer.** *The* non-obvious one: under expo-gl
   WebGL1 the scene renders **blank** unless at least one `MeshBasicMaterial`
   object is drawn — it primes the shader program pipeline for the PBR
   materials. A 1 cm black cube hidden 1 m under the ground disc costs nothing
   and makes everything appear (`model/[id].tsx:291`, verified on-simulator).

**Scene.** All body sections laid nose-to-tail (`layoutSections`, front = −Z,
same convention as `scripts/render-model.mjs`); lighting copied from the thumb
renderer for consistency; a fake radial-gradient contact shadow disc. Camera
frames the whole consist (`fitRadius`). **Orbit math is isolated in
`orbitMath.ts`** so it stays jest-pure — the three.js glue lives in the screen.

**Interaction & perf.** Pan = orbit, pinch = dolly, `Gesture.Simultaneous` so a
two-finger orbit-while-zoom doesn't fight itself (each gesture merges only its
own axes). Untouched → gentle turntable. Render loop runs at full rAF rate while
touched, throttles to ~30 fps idle (`IDLE_FRAME_MS`, `model/[id].tsx:322`). GL
resources disposed on unmount; an in-flight setup bails via `mountedRef`.

**Entry.** From the tram-sheet face illustration (`ModelPreviewButton`) — subtle
press-scale, haptic, then `router.push('/model/[id]')`. Unknown/missing id →
graceful back.

---

## 10. iPad adaptivity

Sheets render **full-width glass**; the *content* is capped and centered — pure
flexbox, no `Platform` checks. `SheetContent` centers a `maxWidth:640` column
(`src/components/ui/SheetContent.tsx`); wide screens (`width >
SHEET_CONTENT_MAX_WIDTH`) additionally switch some lists to grids: favorites
lines go 2-up (`favorites.tsx:113`), the line sheet caps + centers its FlatList
content (`line/[id].tsx:50`). The bottom dock caps at 560 pt and centers instead
of stretching edge-to-edge (`MapChrome.tsx:331`).

---

## 11. Position mode — Smooth vs Live (accuracy-vs-smoothness as a user choice)

**Problem.** The feed updates roughly every ~1 Hz per tram (often slower). To
show trams *gliding*, the physics engine interpolates between fixes — beautiful,
but it's a simulation that can drift from the real reported position. Some users
(and the honest answer) want to see the **raw** data.

**Options.** (a) Always smooth — prettiest, least honest. (b) Always raw —
honest, but trams teleport on every update. (c) Let the user choose.

**Decision (c).** A **Smooth / Live** segmented toggle in Settings →
Positioning (`positionMode` in `useSettingsStore`, added in `d76eaf2`).
- **Smooth** (default) — physics-interpolated motion between updates; the tram
  sheet shows the sim's *offset from the last fix* so the drift is visible.
- **Live** — renders the exact reported AVL positions and jumps on every update;
  the tram sheet's deviation line reads *"Showing raw reported position"*.

The mode flows into rendering (`featureBuilder` / `TramLayers` read
`positionMode`, e.g. `bearing` = `observedBearing` in Live vs simulated
`bearing`, `index.tsx:104`) and into the tram sheet's honesty line (§8). Settings
footnote states the tradeoff plainly: *"Smooth interpolates motion between
updates. Live shows exact reported positions and jumps on every update."*

**Principle (again):** when the app synthesizes reality, give the user a switch
to see the raw truth — and label the synthesis.

---

## 12. Motion logging + ride recording UX

Two flavors of real-vs-sim telemetry, both landing on-device only (see also the
data-layer decisions):

- **Passive motion logs** — the network's poll stream logged at ~1 Hz by
  piggy-backing on the runtime's UI notifications (`src/lib/motionlog/index.ts`).
  No UI while recording; exportable from Settings.
- **Ride recording** — a user-initiated GPS capture of *their* location vs the
  simulated tram position, started from the tram sheet's **RideRecorder**
  (`src/components/tram/RideRecorder.tsx`). It's driven through the **MotionLog
  singleton**, so recording **survives the sheet closing**. Only one ride at a
  time: opening a *different* tram's sheet while recording shows a chip pointing
  at the tram being recorded, with a Stop button. Active state shows a pulsing
  red dot, elapsed time, and captured-point count.

**Settings → Motion data** exports logs / rides (native action sheet when
several files) and clears all with a destructive confirm. Footnote: *"Recordings
capture GPS against the simulated position to recalibrate the physics. Nothing
leaves the device until you export it."* The purpose is calibration data for the
interpolation engine, gathered honestly and kept private by default.

---

## Cross-cutting principles

1. **The map is the app.** One mounted map, one runtime; everything else floats
   over it as a transient sheet.
2. **Glass everywhere, but degrade gracefully.** `GlassPanel`'s three-tier
   ladder (glass → blur → solid) and its Reduce-Transparency re-query are the
   contract for every floating surface.
3. **Tell the truth about synthesized data.** Fake speed removed; AVL sync age,
   sim-offset line, and the Smooth/Live switch all exist to keep the simulation
   honest.
4. **One code path per action.** Planner BFS runs only in `runPlan`; selection
   ownership is claimed/released by the tram sheet with a store-identity guard —
   patterns to preserve when extending these screens.
