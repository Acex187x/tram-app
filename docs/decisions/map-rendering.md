# Decision Record — Map Rendering (Mapbox)

Scope: how the live fleet, route network, planner overlay and follow camera are
drawn on the Mapbox map. Grounds: `src/components/map/*`, `src/hooks/tramData.ts`,
`src/lib/render/featureBuilder.ts`, `src/app/index.tsx`, `docs/research/mapbox-rn.md`,
`docs/architecture.md` spike notes.

Audience: the next engineer/agent. Each section is PROBLEM → OPTIONS → DECISION →
WHY → HOW (with file refs). Several conventions are labelled **SPIKE-VERIFIED**
— they were confirmed on-device and are load-bearing; changing them silently
re-breaks the map.

---

## 1. Library + style: `@rnmapbox/maps` 10.3.2 + Mapbox Standard

**Problem.** Need a 3D city map of Prague (extruded buildings, time-of-day
lighting) with first-class per-instance 3D model rendering for the fleet, on
Expo SDK 57 / RN 0.86 / Fabric (new architecture), iOS only.

**Options** (`docs/research/mapbox-rn.md`): a three.js / expo-gl overlay synced
to the camera (rejected — far more work, and it can't depth-occlude against
Standard's buildings); a 2D `SymbolLayer` + `icon-rotate` fallback (rejected as
the primary — flat, no 3D); vs. native `ModelLayer` + `Models`.

**Decision.** `@rnmapbox/maps@10.3.2` (latest, 2026-07-05) compiling the Mapbox
Maps SDK for iOS v11, with the **Mapbox Standard** style and the native
`ModelLayer`/`Models` path for 3D.

**Why.**
- 10.3.2 changelog explicitly ships `fix(ios): support static frameworks under
  Expo SDK 57 precompiled pipeline` and a Fabric nested-children fix — directly
  the environment this app runs in.
- Standard is 3D by default (buildings, sky, `lightPreset`) and exposes
  `ModelLayer` driven by data expressions, so **one** layer renders a
  heterogeneous fleet (per-feature `modelId`/`bearing`). No custom GL overlay.
- No `sk.` download token is required on v11 (deprecated by the maintainer).

**How.**
- Public token set once at module top of the map screen:
  `Mapbox.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_KEY ?? null)`
  (`src/app/index.tsx:35`). `EXPO_PUBLIC_` inlines it at bundle time — fine for a
  `pk.` token.
- Native SDK version is pinned via the `@rnmapbox/maps` config plugin
  (`RNMapboxMapsVersion`) for reproducible EAS builds — see research §1.1.
- Metro must treat `.glb`/`.gltf` as assets (`metro.config.js` `assetExts`).

---

## 2. Standard style via imported styleJSON, not a bare `styleURL`

**Problem.** We want live re-lighting of Standard (change `lightPreset` to match
Prague time-of-day) which goes through `<StyleImport id="basemap" existing
config>`.

**SPIKE-VERIFIED gotcha.** A direct `styleURL: 'mapbox://styles/mapbox/standard'`
has **no import named `basemap`** — `<StyleImport id="basemap">` against it logs
`Import basemap does not exist` and is silently dropped.

**Decision.** Feed the map a tiny custom style JSON whose `imports[]` pulls
Standard in under the id `basemap`; then `StyleImport` config re-lights it live.

**Why.** The import id only exists if *we* named it. The style JSON also carries
root-level `glyphs`, which our own `SymbolLayer`s (line-number badges, stop
labels) require.

**How.** `buildMapStyleJSON(lightPreset)` in `src/components/map/mapStyle.ts:59`
emits `{version:8, glyphs, imports:[{id:'basemap', url:'.../standard', config}]}`.
The shared `STANDARD_CONFIG` (`mapStyle.ts:10`) sets `showPointOfInterestLabels:
false`, `showTransitLabels: false` (see §11), `show3dObjects: true`.

Note: `src/app/index.tsx` currently passes `styleURL="mapbox://styles/mapbox/
standard"` directly on `<MapView>` and gates the `<StyleImport>` on
`onDidFinishLoadingStyle` (§3). `buildMapStyleJSON` is the SPIKE-blessed
alternative kept ready; the live re-lighting works because the import is applied
**after** style load, not because a raw styleURL exposes `basemap`.

---

## 3. StyleImport gated on `onDidFinishLoadingStyle`

**Problem.** Applying import config before the style finishes loading is a no-op
(`Import basemap does not exist`, verified on-device).

**Decision.** Mount `<StyleImport>` only once `styleLoaded` is true.

**How.** `src/app/index.tsx:201` sets `styleLoaded` from
`onDidFinishLoadingStyle`; the `<StyleImport id="basemap" existing config={{
...STANDARD_CONFIG, lightPreset }}>` at `:216` renders only when
`styleLoaded`. `lightPreset` comes from `resolveLightPreset` (settings override
or Prague time-of-day, re-evaluated every 5 min via `lightClock`).

---

## 4. GLB loading through `expo-asset`, not `require()` URLs

**Problem.** Register per-tram GLBs with `<Models>`.

**SPIKE-VERIFIED gotcha.** `require('...glb')` asset URLs are **broken in dev**:
native strips the metro query params from the asset URL, so the model never
loads. `<Models>` must also only render once **all** GLBs are resolved.

**Decision.** Resolve every GLB through `Asset.fromModule(require(...))
.downloadAsync()` and pass the resulting `localUri` (`file://`) strings to
`<Models models={{ key: uri }}>`. Render `<Models>` (and any `ModelLayer`) only
after all URIs resolve.

**How.** `src/components/map/useTramModels.ts` downloads `MODEL_ASSETS` + the
stop totem, returning `Record<modelKey, uri> | null` (null while loading). Falsy
module ids (jest / missing asset) are filtered so a missing GLB just disables its
key rather than crashing. `TramLayers` renders `<Models models={modelUris}>` and
appends the `ModelLayer` only when `modelUris != null`
(`TramLayers.tsx:316`,`:368`). `RouteNetwork` defers its totem `ModelLayer` a
tick behind registration (§10).

---

## 5. Imperative `ShapeSource.setNativeProps` with STABLE React props — the Fabric quirk

**Problem.** The fleet is 200–500 features updated ~15–60 Hz. Committing a new
`shape` React prop each frame reconciles the whole tree — untenable.

**SPIKE-VERIFIED gotcha (cost hours).** With Fabric + rnmapbox, a `ShapeSource`
must be mounted **once** with a *stable* empty `FeatureCollection` and receive
data **only** via `setNativeProps`. If React ever commits a *changing* `shape`
prop, the native source **reverts / never applies** the imperative push. Layer
*style* props may change freely; only the source `shape` is the trap.

**Decision.** Every live source (`trams-points`, `trams-sections`,
`tram-fix-overlay`, `route-network`, `route-stops`, `planner-legs`) is mounted
with a constant `EMPTY_FC` and fed exclusively through `ref.setNativeProps({ id,
shape })`.

**Why.** One serialized FeatureCollection per frame over the bridge is the only
cost; rendering (layer draw, model instancing) stays on the native UI/GPU thread.

**How.**
- Fleet: `TramLayers.tsx` subscribes to the engine frame loop
  (`rt.subscribeFrame`, `:153`) and pushes `pointsRef`/`sectionsRef`
  imperatively. The `shape={EMPTY_FC}` props on the `<ShapeSource>` never change.
- Network: `RouteNetwork.tsx:135` pushes on an interval; the on-device note atop
  the file (`:12`) spells out the quirk. Layer *style* props (opacity, filter)
  DO change with React state — that's allowed.
- Planner: `PlannerOverlay.tsx:45` pushes the legs FC (or empty on clear).
- Each `id` is passed to `setNativeProps` because rnmapbox needs the source id on
  the payload.

**Related SPIKE rule.** `<ShapeSource>` children must be a plain array of
elements with **no `false`/`undefined` holes** — rnmapbox clones each child to
inject the `sourceID`. Optional layers (the tram `ModelLayer`, the stop totem)
are `.push()`ed onto a `ReactElement[]` rather than inlined as `{cond && <…>}`
(`TramLayers.tsx:299`, `RouteNetwork.tsx:166`).

**Related SPIKE rule.** All custom layers use `slot="top"` so they draw over the
Standard basemap (a raw ModelLayer without a slot renders under buildings).

**Related SPIKE rule.** Hot reload does **not** re-register models/layers
reliably — **restart the app** when iterating on map code.

---

## 6. Zoom-band system + the COMIC oversized model scale

**Problem.** ModelLayer meshes are heavy and near-invisible at low zoom; the app
must stay readable from city scale down to a single followed tram, and the
product spec calls for "comically oversized" toy trams at mid zoom.

**Decision.** Stack layers on the points source, each owning a zoom band with
opacity crossfades, and render 3D only near the top. Band edges
(`src/components/map/mapStyle.ts`):

| band | zoom | rendering |
|---|---|---|
| 1 | < 13.2 | direction **teardrops** (`tram-dots`) — sprite rotated to the tram bearing, map-aligned (FR24-style), so heading reads at city scale |
| 2 | 13.2–14.8 | teardrop **marker** at the true position + **model capsule badge** floating above it (`tram-badge-markers` / `tram-badges`) |
| 3–4 | ≥ 14.8 | articulated 3D `ModelLayer` (sections source) |

`BAND_DOTS_TO_BADGES = 13.2`, `BAND_BADGES_TO_MODELS = 14.8`, `BAND_FADE = 0.3`
(crossfade half-width).

**Bands 1–2 are sprite `SymbolLayer`s** (redesign, commit `e72340f`):

- **19 fixed PNG sprites** live in `assets/images/map-icons/`, generated by
  `scripts/tram-models/render-map-icons.mjs` (puppeteer+esbuild ad hoc, NOT in
  `package.json`): 4 teardrop variants `dot-<day|night>[-fav]`, 14 capsules
  `cap-<modelId>-<day|night>` with the model's two-tone **side silhouette**
  (rendered orthographically from the real GLBs) baked in, plus `fav-star`.
- **Data-driven variant picking.** Which sprite a feature gets is a style
  **expression** over props the points FC already carried — `DOT_ICON` /
  `CAP_ICON` concat `line` (night lines 90–99 → navy variants via
  `NIGHT_LINE`), `modelId` and `favorite` (`TramLayers.tsx`). The 60 Hz push
  payload did not grow, and day/night contrast holds on both lightPresets.
- **Capsule label anatomy.** The badge is two symbol layers at the same point:
  the bearing teardrop at the true position, and the capsule (iconAnchor
  `bottom`, floated 14 pt up) with the live line number as `SymbolLayer` text
  seated in the sprite's darkened left zone. `iconOffset`/`textOffset` are in
  em/lockstep with `iconSize`/`textSize`, so the number stays seated across
  the whole band's size ramp (`CAP_TEXT_OFFSET_EM`).
- **Fabric-safe sprite loading — same pattern as the GLBs (§4).** Each PNG is
  resolved via `Asset.fromModule(...).downloadAsync()` → `localUri` and
  registered **once** through a single `<Images images={...}>`; the
  sprite-driven layers are appended to the layer array only after
  registration (`useMapIcons` returns null while loading). Until then a
  minimal fallback `CircleLayer` dot keeps the whole fleet visible and
  tappable — a sprite load failure degrades, never blanks the map.

**The comic scale curve.** `modelScale` follows an `exponential(1.6)` interpolate
on zoom (`TramLayers.tsx:326`):

```
14.8 → 5×   15.6 → 3.2×   16.4 → 1.6×   17.0 → 1×
```

**Why 5×→1×.** At mid zoom a real-world-scale tram is a tiny sliver among
buildings; blowing it up to 5× makes the fleet the hero of the map. Models only
ease to true real-world 1× at **z17** (`MODEL_COMIC_REAL_SCALE_ZOOM = 17.0`,
`TramLayers.tsx:50`) — deeper than the earlier `MODEL_REAL_SCALE_ZOOM = 16.6`
(kept in `mapStyle.ts:82` as the older band table's value). Oversized models
overlapping at hubs is explicitly accepted per spec.

**Model orientation — SPIKE-VERIFIED.** Trams are authored **front toward −Z**,
so `modelRotation: [0, 0, ['get','bearing']]` faces the model correctly with **no
heading offset** (`TramLayers.tsx:331`; earlier docs mention a `HEADING_OFFSET`
calibration const — it resolved to 0 and is gone). `modelEmissiveStrength: 1.2`
gives a slight glow; `modelElevationReference: 'ground'`.

**Hit-testing across all zooms — SPIKE-VERIFIED.** Tapping ModelLayer meshes is
unreliable, so a transparent `CircleLayer` (radius 26, opacity **0.011** — nonzero
so native keeps it rendered and hit-testable) sits on the points source across
all zooms (`tram-hit-targets`, `TramLayers.tsx:498`). A second per-**section**
hit circle (`tram-section-hit-targets`, `TramLayers.tsx:303`) sits on the sections
source so a tap anywhere along a 30 m articulated body — not just the head — opens
and follows the tram. Tapping selects + follows **immediately**, then pushes the
`/tram/[key]` sheet (`onPressTram`, `TramLayers.tsx:281`); a matching gold
selection halo tracks the selected tram at all zooms (`tram-selected-halo`).

---

## 7. Right-hand-traffic offset (1.35 m)

**Problem.** Opposite-direction trams share adjacent parallel tracks; rendered on
the raw shape they overlap into one blob.

**Decision.** Shift **every** rendered position (points AND sections)
`TRACK_OFFSET_M = 1.35` m to the perpendicular-**right** of its bearing. Prague
runs right-hand traffic, so this visually separates the two directions onto their
real tracks.

**How.** `offsetRight()` in `src/lib/render/featureBuilder.ts:102` — inlined local
trig with a `cos(lat)` correction (the modulo/normalization of the general
`destinationPoint` is skipped since this runs per feature per frame). Applied to
points at `:358` and to each section via `sectionFeature` at `:125`.

---

## 8. Whole-tram culling — the cut-tram bug chain

**Problem.** Articulated bodies (up to 5 sections + a coupled trailer ≈ 46 m) were
being **visually cut in half** at the screen edge, and sometimes only the front
piece showed.

Three distinct failures fed the same symptom; the fix is a chain:

1. **Per-tram cull margin.** Culling is ALWAYS per **whole tram**, keyed on the
   head position against the viewport bbox expanded by `CULL_MARGIN_M = 300` m —
   far larger than any body+trailer. A tram whose head is near the edge renders
   **all** its sections; individual sections are never dropped
   (`featureBuilder.ts:35`,`:314`,`:379`). This kills the cut-at-edge case.

2. **No-geometry multi-section fallback.** Before a trip's shape streams in, a
   naïve renderer drew only the head section → "tram cut off, only the front
   piece visible". `sectionsAtRawPosition` (`featureBuilder.ts:209`) now lays
   **all** sections in a straight line trailing the raw AVL position along its
   bearing, so a shapeless tram is still a whole tram. (With geometry,
   `sectionsAlongShape` places each section at its distance along the polyline.)

3. **Sealed GLB end caps.** Even correctly placed, a section whose neighbour
   doesn't perfectly abut showed a hollow cut face. The model generator seals
   every articulated joint face with a closed dark gasket cap (`jointCap` in
   `scripts/tram-models/lib.mjs:587` — "fully seals the whole cross-section: side
   walls, roof dome, underside and both z faces"), so a visible gap between
   sections reads as a bellows, not a hole.

**Note on section placement math.** `placeAt` (`featureBuilder.ts:136`) handles
**negative** along-shape distances by extrapolating straight back from the shape
origin, so rear sections / coupled cars keep their physical spacing near the start
of a trip instead of piling up at vertex 0. `COUPLED_OFFSET_M = 14.5` m trails the
second car of a coupled T3 pair.

---

## 9. Adaptive cadence & thermal work — the iPad heat story

**Problem.** Running the sim at 60 Hz and re-pushing the whole fleet FC 15–60×/s
regardless of zoom made the **iPad run hot after ~an hour** (user-reported), for
zero visible benefit when nothing on screen is moving fast.

**Decision.** Everything scales down when detail isn't visible. Five levers:

1. **Zoom-gated sim tick with hysteresis.** The engine ticks at `TICK_MS = 16`
   (~60 Hz) **only** while the map is in the 3D sections band; below it the
   runtime drops to `TICK_IDLE_MS = 100` (~10 Hz) — badges/dots don't move faster
   than that (`src/hooks/tramData.ts:19`,`:26`). The map flips the rate via
   `getRuntime().setDetailMode(zoom >= SECTIONS_FEED_MIN_ZOOM)` from its camera
   events (`src/app/index.tsx:92`). `setDetailMode` restarts the tick timer only
   on an actual change and only while running (`tramData.ts:157`). The band feed
   threshold `SECTIONS_FEED_MIN_ZOOM = 14.6` is deliberately **below** the model
   band `14.8` — it warms the sections source up slightly early so models don't
   pop in cold; that 0.2 gap is the hysteresis.

2. **Zoom-based points cadence.** The whole-fleet points FC is pushed at
   `pointsPushIntervalMs(zoom)` (`tramData.ts:34`): ~15 Hz (66 ms) at zoom ≥14
   where badges visibly glide, 1 s at mid zoom, 5 s (one per poll) at city scale
   — far-zoom badges are near-static, and re-pushing GeoJSON 15×/s forces Mapbox
   to re-render constantly (GPU heat for no visible change). The sections FC is
   pushed every tick but **only** while in-band; on leaving the band it's cleared
   once so stale models never linger (`TramLayers.tsx:169`).

3. **Empty-frame short-circuits.** Stringify+push is skipped entirely while a FC
   stays empty (`sectionsEmptyRef`/`fixEmptyRef`), and frames that would push
   nothing skip `buildFrame` altogether (`TramLayers.tsx:175`,`:214`).
   `skipPoints` lets `buildFrame` skip the points FC on frames that only need
   sections (`featureBuilder.ts:352`).

4. **Shadows off.** Per-model shadow passes are the biggest GPU cost at pitch, so
   `modelCastShadows`/`modelReceiveShadows` are **false**; ambient occlusion stays
   on for grounding (`TramLayers.tsx:357`).

5. **Camera-loop gating + background idle.** The follow retarget only fires while
   following and at `CAMERA_RETARGET_MS` cadence (§10). The runtime pauses all
   timers on background and resumes on `active` (`tramData.ts:186`); the UI 1 Hz
   bump is skipped entirely when there are no UI subscribers (`tramData.ts:253`);
   `RouteNetwork` does no work while backgrounded and only rebuilds when the
   loaded-geometry set actually grew (fingerprint check, `RouteNetwork.tsx:131`).

---

## 10. Follow-camera evolution

**Problem.** Following a moving tram smoothly with `setCamera`.

**Evolution (per git history — architecture.md → iter 3 → iter 4):**

1. **v0 (per-frame flooding).** Original plan: retarget `setCamera` on every
   ~16 ms tick with `animationDuration = frameMs`. On-device this **restarted the
   native camera animator 60×/s**, choking it into ~1 Hz visible stutter
   (user-reported regression).

2. **v1 (overlapping glides + lead).** Retarget every `CAMERA_RETARGET_MS = 80`
   ms with a **longer** `CAMERA_GLIDE_MS = 170` ms `linearTo` glide: each new
   glide starts before the previous ends, so consecutive animations **overlap**
   into continuous motion while the animator restarts only 12.5×/s
   (`TramLayers.tsx:86`). The target is **led** along the bearing by the distance
   the tram covers in one retarget interval (`leadTarget`, `:97`) so the camera
   glides toward where the tram *will* be, not where it *was*.

3. **v2 (behind-view, gesture-persistent follow, banner-only stop).** Default
   chase view is `FOLLOW_ZOOM = 17.5`, `FOLLOW_PITCH = 60`, heading = the tram's
   bearing — the camera sits **behind** the tram looking forward over the roof, so
   buildings no longer occlude the followed tram (`TramLayers.tsx:61`,`:259`).
   - **Gestures do NOT cancel follow.** While the user's fingers are on the map
     the retarget loop **yields** (`FollowGestureState.gestureActive`,
     `TramLayers.tsx:247`); their chosen zoom/pitch/heading are captured as
     **offsets** relative to the tram bearing and re-applied on every subsequent
     retarget (`index.tsx:97`, headingOffset normalized to (−180,180] for
     shortest-way). `onMapIdle` clears the gesture flag belt-and-braces
     (`index.tsx:120`). Overrides reset on each new follow session
     (`index.tsx:143`).
   - Follow is ended **only** by the banner (`MapChrome.tsx:222`) — not by
     panning. It also auto-ends if the followed tram disappears (left service /
     pruned) (`TramLayers.tsx:249`).
   - In **live** position mode the camera anchors to the **projected
     observation** (the last fix dead-reckoned to now, same as the rendered
     position) rather than the raw fix — anchoring to the raw fix left the
     camera parked while the tram drove away (commit `1d371ac`).

4. **v3 (stationary-target deadband — the dwell-idle fix).** The v1 retarget
   loop kept sending an *identical* target every 80 ms while the followed tram
   dwelled at a stop; each `setCamera` restarts a native animation, so the map
   never reached a quiet state (project-review P2, violating the
   performance-invariant "map must be able to go fully idle"). Now a computed
   target is compared against the **last actually sent** camera
   (`withinDeadband`, `src/components/map/followCamera.ts`): moved
   < `CAMERA_DEADBAND_M = 0.5` m **and** turned < `CAMERA_DEADBAND_DEG = 0.5°`
   (shortest way) **and** zoom/pitch overrides unchanged → the send is skipped
   entirely. Both thresholds are sub-pixel at follow zoom, so suppression is
   invisible, and deltas accumulate against the last SENT target, so even a
   crawl keeps retargeting (just at the rate it actually moves). While
   suppressed **and** the tram reads as dwelling (speed ≈ 0) evaluation relaxes
   from 12.5 Hz to 4 Hz (`CAMERA_DWELL_EVAL_MS`). Retarget is immediate (next
   frame, cadence gate bypassed) on a follow-target switch, and a gesture
   clears the last-sent reference so the first post-release retarget always
   re-centers — a teleport exceeds the deadband by definition. Verified on-sim:
   at ~20 km/h every eval sends (glide smoothness untouched); parked, sends
   drop to ≈ 0. Pure math + policy unit-tested in
   `__tests__/follow-camera.test.ts`.

---

## 11. Stops, totems, labels — OUR markers vs Mapbox POIs

**Problem.** Mapbox Standard ships its own transit POIs, but Golemio stop
positions differ and only *our* stops are clickable / drive the `/stop` sheet.

**Decision.** Hide Mapbox's transit + POI labels
(`STANDARD_CONFIG.showTransitLabels: false`, `showPointOfInterestLabels: false`,
`mapStyle.ts:13`) and render our own stop markers as the source of truth.

**How** (`src/components/map/RouteNetwork.tsx`):
- Route lines: one PID-red `LineLayer` over the union of loaded trip shapes
  (deduped by `shapeId`), plus a gold `route-lines-selected` line filtered to the
  selected line id.
- Stops (≥ zoom 14): white core + PID-red ring `CircleLayer`, a transparent
  hit-target circle (opacity 0.011, radius 20), and stop **name** labels from
  ≥15.8 (`textOptional` so crowded areas drop labels not markers; theme-aware
  halo). Tapping a stop opens `/stop/<normalizeName(stop name)>` — the station key
  groups platforms by normalized name, shared with the planner network.
- 3D **totems** (≥ zoom 16): a `ModelLayer` keyed on `STOP_TOTEM_MODEL_KEY =
  'stop-totem'`, mounted **150 ms after** the GLB registers so registration always
  precedes the layer (spike rule; `RouteNetwork.tsx:116`). Skipped entirely if the
  asset isn't shipped (defensive).
- The whole network hides while a planner itinerary is shown (§12).

---

## 12. Planner overlay + route-only mode

**Problem.** When a planned route is on the map it must be the only thing
readable — the full network + citywide fleet would bury it.

**Decision.** While an itinerary is set:
- **Planner legs** draw as a bold gold casing (`lineWidth 9`) with a line-colored
  inner stroke (PID red / night blue), pushed imperatively to the `planner-legs`
  source; the camera `fitBounds` to the itinerary once with generous bottom
  padding (the planner sheet floats there) — `PlannerOverlay.tsx:45`,`:62`.
- **Route-only fleet filter.** `buildFrame` receives a `lineFilter` set of the
  itinerary's leg lines; trams off those lines vanish entirely (points AND
  sections) — `featureBuilder.ts:322`, wired in `TramLayers.tsx:184` (the set is
  cached per itinerary ref).
- **Network hides.** `RouteNetwork` zeroes route/stop/totem opacity and ignores
  stop taps while `plannerActive` (`RouteNetwork.tsx:108`,`:149`).
- A **planner chip** (`MapChrome.tsx:253`) reopens the planner sheet on tap
  (users kept losing the sheet) and clears the route on ✕.

---

## 13. Last-real-fix overlay

**Problem.** In the tram sheet / live mode the user should see how far the
smoothed sim has drifted from the raw AVL fix.

**Decision.** For the followed/selected tram only, emit a `fixOverlay` FC: the raw
last fix as a **Point** plus a dashed gold connector **LineString** from it to the
rendered position (sliced along the shape when geometry is known, straight
otherwise). Independent of the section zoom band and viewport cull.

**How.** `buildFixOverlay` (`featureBuilder.ts:273`, `sliceShape` at `:248`);
rendered by the `tram-fix-overlay` source (dashed `LineLayer` + white/gold fix
dot, `TramLayers.tsx:518`), pushed at the sections cadence.

---

## Quick reference — the SPIKE-VERIFIED conventions that must not regress

1. GLB via `Asset...downloadAsync()` → `localUri`, not `require()` URLs. §4
2. `ShapeSource` mounted with a STABLE empty FC, fed only by `setNativeProps`.
   Changing the React `shape` prop breaks the source. §5
3. `ShapeSource` children = plain element array, no false/undefined holes. §5
4. `slot="top"` on all custom layers. §5
5. `<StyleImport id="basemap">` needs the imported-styleJSON naming AND
   gating on `onDidFinishLoadingStyle`. §2, §3
6. Models registered before ModelLayers mount. §4, §11
6a. Sprite icons likewise: expo-asset `localUri` → one `<Images>`, and the
   sprite `SymbolLayer`s are appended only after registration (fallback dots
   until then). §6
7. Transparent CircleLayer (opacity 0.011) for hit-testing — ModelLayer taps are
   unreliable. §6, §9
8. Trams authored front-toward −Z ⇒ `modelRotation z = bearing`, no offset. §6
9. Hot reload does not re-register models/layers — restart the app. §5
