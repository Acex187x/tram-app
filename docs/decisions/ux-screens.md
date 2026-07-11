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

```
presentation: 'formSheet'
headerShown: false
sheetAllowedDetents: [...]
sheetLargestUndimmedDetentIndex: 0   // small detent does NOT dim the map
sheetGrabberVisible: true
sheetCornerRadius: 24
contentStyle: { backgroundColor: 'transparent' }
```

Per-route detents (`src/app/_layout.tsx:27`):

| Route | Detents | Rationale |
|---|---|---|
| `tram/[key]` | `[0.38, 0.95]` | small peek keeps the followed tram in view |
| `line/[id]` | `[0.45, 0.95]` | |
| `stop/[key]` | `[0.45, 0.95]` | |
| `favorites` | `[0.5, 0.95]` | |
| `search` | `[0.5, 0.95]` | |
| `settings` | `[0.55, 0.95]` | |
| `planner` | `[0.6, 0.95]` | taller start — two inputs + results |
| `model/[id]` | — | `fullScreenModal`, `animation:'fade'` (immersive 3D) |

**Two load-bearing details:**
1. `sheetLargestUndimmedDetentIndex: 0` — at the small detent the map is
   **not** dimmed, so the live fleet stays fully visible and interactive-looking
   behind a peeked sheet. Only the large detent dims.
2. `contentStyle: backgroundColor 'transparent'` — the sheet container itself is
   see-through; each screen supplies its own opaque surface via a root
   `<GlassPanel style={{flex:1}}>`. This is why every sheet component
   (`tram/[key].tsx:236`, `stop/[key].tsx:117`, `line/[id].tsx:282`,
   `search.tsx:184`, `favorites.tsx:66`, `planner.tsx:299`, `settings.tsx:319`)
   opens with `<GlassPanel style={styles.root}>` — the glass *is* the sheet
   background. If you forget it, you get a transparent sheet over the map.

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
`index.tsx:83`) — no React state per camera frame. It updates the viewport ref
(frame culling), sets the zoom-adaptive simulation rate, and captures follow
gesture overrides. See §4 for splash timing and §6 for the light preset.

### 3.2 Tram sheet — `src/app/tram/[key].tsx`

The richest screen; also the one that evolved most (see §8). Layout top-to-bottom:

1. **Header** — line badge, headsign + `DelayPill`, model name + reg number +
   AC snowflake, and a tappable **face illustration** (`ModelPreviewButton`,
   top-right) that opens the 3D viewer.
2. **Live row** — three cells: *updated ago* (age of the last real AVL fix,
   ticking; green antenna when ≤15 s), *phase now* (Cruising / At stop / At
   terminus / Tracking), and *next stop + ETA* (live countdown).
3. **Deviation line** — honesty about the simulation (§8).
4. **Actions** — Follow / Favorite / Show line.
5. **RideRecorder** — real-vs-sim GPS telemetry capture (§9).
6. **Upcoming stops** timeline, then **About this tram** spec card.

**State machinery worth knowing:**
- `useEtaCountdown` and `useNowTick` anchor on each ~1 Hz runtime value and tick
  locally every second, so countdowns never freeze between polls
  (`tram/[key].tsx:33,59`).
- This sheet **owns `selectedTramKey`** (drives the map's gold halo). It sets it
  on mount and clears it on unmount — but only if the store still points at it,
  so a newer sheet that already claimed selection wins (`tram/[key].tsx:173`).
- **Gone / "Left service"** — if the tram drops out of the feed while the sheet
  is open, `lastStateRef` lets it render a friendly "Left service" card with the
  last known line + reg instead of a blank sheet (`GoneState`,
  `tram/[key].tsx:122`). If following, it auto-unfollows.

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

## 5. Follow banner + gesture persistence

When following a tram, a **FollowChip** floats above the dock (line badge, reg,
delay, "tap to stop"). It reads the followed tram via `useTramState(followKey)`
and hides if the tram leaves service (`MapChrome.tsx:208`).

**Follow gestures don't cancel follow.** While following, the user can pan/zoom/
rotate; instead of dropping follow, `onCameraChanged` captures their chosen
zoom, pitch, and **heading offset relative to the tram's bearing** and keeps
re-applying them on each retarget (`index.tsx:97`). The heading offset is
normalized to `(-180, 180]` so the shortest-way offset persists. Overrides are
scoped to one follow session — a new follow (or follow end) resets to the
default chase view (`index.tsx:143`). `onMapIdle` is a belt-and-braces reset for
gesture-end paths that don't surface via `onCameraChanged`.

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
