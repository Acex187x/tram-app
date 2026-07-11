# Tram Spotter — Project History

A chronological narrative of how the app was built, grouped into phases. Each
entry is one commit (`git log --oneline`); the memorable debugging sagas are
called out inline. For the *why* behind individual subsystems, see
`docs/decisions/*.md`; for the current shape of the system, `architecture.md`.

---

## Phase 0 — Research & spike (`b3e3ad4` → `a4e392d`)

**`b3e3ad4` Initial commit.** Bare Expo SDK 57 template.

**`70f1438` Scaffold.** Added the real dependencies (`@rnmapbox/maps`,
`@tanstack/react-query`, `zustand`), the research docs (`docs/research/*` — all
verified empirically on 2026-07-11 against the live Golemio API and installed
`node_modules`, not from memory), `architecture.md`, the shared-contract types
(`src/lib/types.ts`), and a throwaway spike screen. The guiding rule was set
here: **read the exact versioned docs / installed `.d.ts`, never guess prop
names** — Expo and rnmapbox APIs had moved.

**`aae983c` Spike verified.** The single most important de-risking step. Proved
on the simulator that Mapbox's `ModelLayer` + `Models` can render GLB trams
driven by **data expressions** (`modelId: ['get','modelKey']`,
`modelRotation: [0,0,['get','bearing']]`) — so no three.js overlay is needed for
the map. Nailed down the orientation convention (author trams front-toward **−Z**
so `z = bearing` faces correctly) and the GLB-loading gotcha (`require()` URLs
are query-stripped in dev → must resolve `Asset.fromModule().downloadAsync()`
`localUri` before mounting `<Models>`). These conventions carried through the
whole project.

**`a4e392d` App icon.** Prague-tram glyph on PID red, plus splash and the iOS 26
Liquid Glass `.icon` bundle.

## Phase 1 — Wave-2 foundation (`0a3579a`, `37dacad`)

**`0a3579a` Data + engine layer.** The non-visual spine: Golemio client (rate-
limited fetch, `X-Access-Token`), vehicle/GTFS/shape fetchers, disk shape cache,
the fleet registry, the polyline math, and the first cut of the physics
interpolation engine (`speedProfile` + `tramSim` + `engine`) with v1 tram
models and the runtime hooks. Everything pure-TS and unit-tested up front.

**`37dacad` UI foundation.** The root expo-router Stack with form sheets, the
Liquid Glass primitives (`GlassPanel` guarded by `isGlassEffectAPIAvailable()`
with an expo-blur fallback, `LineBadge`, `DelayPill`), and the zustand stores
(planner, selection). Template cruft removed.

## Phase 2 — Mega-wave (`d415c3c`)

**`d415c3c` Mega-wave.** The big one: 7 photo-referenced 3D tram models
(authored programmatically with `@gltf-transform/core`, no Blender), the full
map screen with its 4 zoom modes + follow camera, and every app sheet
(tram / line / search / favorites / planner / settings). This is where the app
first looked like the shipped product — and where the bugs the next phase fixed
were introduced.

## Phase 3 — Review + fix waves, release prep (`13d1b5b` → `f7c0829`)

**`13d1b5b` Fix map data layers.** Two sagas resolved at once:

- **The black basemap.** The spike had *guessed* that a custom `styleJSON` with
  `imports:[{id:'basemap', url:'…/standard'}]` would enable live re-lighting. On
  device that rendered a **completely black basemap**. Fix: feed `MapView` the
  direct `styleURL="mapbox://styles/mapbox/standard"` and mount
  `<StyleImport id="basemap" existing>` **only after `onDidFinishLoadingStyle`**
  (applying config earlier logs "Import basemap does not exist" and is dropped).
- **The invisible route lines.** Route lines and stops silently never appeared.
  Root cause: under Fabric + rnmapbox, a `ShapeSource` whose `shape` prop is
  committed by React **reverts or never applies**. Fix: mount every data source
  ONCE with a stable empty FeatureCollection and push data ONLY via
  `setNativeProps` on a timer/frame (the pattern the tram layers already used).
  Layers also needed `slot="top"` to draw over the Standard style.

**`77e193f` Fix wave — 21 verified review findings.** A dedicated correctness
review (`docs/testing/codex-review-1.md`) surfaced 21 real defects; all fixed in
one wave. Highlights: a **P0** where the runtime could never restart after
backgrounding (`onAppState` called `stop()`, which removed the very listener
that would have restarted it → separated pause from teardown); the pace
multiplier defeating the braking envelope; fresh AVL positions being ignored
after a sim was created; new sims silently skipping a stop they spawned next to;
GTFS epochs an hour wrong across Prague DST; planner BFS dedupe; z-cylinder
inward normals in the model geometry.

**`146cdbb` E2E fixes.** From the simulator QA pass
(`docs/testing/codex-report-1.md`, Codex driving the app): the missing
clear-route chip, line-favorites star, line-number search semantics (numeric
search was matching registration substrings, not line), attribution rows, and
the planner CTA label.

**`4a5901b` / `46ea097` / `822f75a`** EAS project link + build profiles, README
+ `.env.example` + the encryption-compliance flag, and the project-overview
README.

**`7ab527e` Planner geometry adjudication.** Codex pass 2
(`docs/testing/codex-report-2.md`) still reported the planner drawing a route
"far beyond the destination" as a **FAIL**. Investigation with a real-data
regression test proved the legs *do* end at the destination — the Codex finding
was a **geographic false positive** (the shape genuinely passes near, but the
leg is clipped correctly). Lesson recorded rather than "fixed."

**`355294e` / `f7c0829` EAS build fixes.** The model-generation tooling (which
builds `sharp` from source on the builder) was breaking `npm ci` on EAS →
dropped from `devDependencies`, jest moved to devDeps, and the `package-lock`
regenerated from scratch to shed stale `sharp`-era optional deps.

## Phase 4 — Iteration 2, device feedback (`eca1084`, `d76eaf2`)

**`eca1084` Iteration 2 (user feedback).** Broad polish driven by real-device
use: stop queueing with a right-hand offset, whole-tram tap → instant follow
(tap anywhere on a 30 m articulated body, not just the head), 60 fps sections,
section end caps, custom stops with 3D totems, a stop-arrivals sheet, a revamped
tram sheet with model art + real sync age, planner times + models, keyboard
fixes, and the first **iPad** accommodations (dock caps at 560 pt and centers).
The first thermal signal appeared here — the iPad ran hot.

**`d76eaf2` Position mode.** A Smooth/Live toggle that renders the **honest raw
AVL fix** instead of the simulation, plus a sim-vs-fix deviation readout in the
tram sheet — so the interpolation can be audited against reality on device.

## Phase 5 — Iteration 3 + the interactive model viewer (`1bd30ff` → `e0e5ddb`)

**`1bd30ff` Deps.** Added `expo-gl` + `three` and the `/model/[id]` route for a
standalone interactive 3D model viewer (separate from the Mapbox ModelLayer,
which can't be freely orbited).

**`acda059` Iteration 3.** Two headline changes plus fidelity work:

- **Follow-cam flooding fixed.** Retargeting `setCamera` on every 16 ms sim tick
  restarted the native Mapbox camera animator 60×/s, which choked it into ~1 Hz
  visible **stutter**. Fix: retarget every 80 ms with an overlapping 170 ms
  `linearTo` glide (each glide starts before the last ends → continuous motion,
  animator restarted only 12.5×/s), with a small lead toward where the tram will
  be.
- **Comic zoom scale.** Model scale re-tuned to a deliberately cartoonish
  `exponential(1.6)` curve — 5× toy trams at band entry (14.8) easing to real 1×
  only at z17 — replacing the old 2.6→1.0 / z16.6 ramp.
- Model fidelity round 2 (7 trams + PID totem, photo-matched), face thumbnails,
  and the interactive expo-gl + three viewer itself.

**`e0e5ddb` Model viewer fixes — the WebGL1 chain.** The viewer wouldn't render
until three things lined up, all because **expo-gl is WebGL1, not WebGL2**:
(1) `three` pinned to **0.162** (later versions assume WebGL2); (2) a
`navigator.userAgent` polyfill because GLTFLoader r162 sniffs
`navigator.userAgent.indexOf('Firefox')` and RN's `navigator` has no
`userAgent`; (3) a `MeshBasicMaterial` "pipeline primer" first draw to warm
expo-gl's shader pipeline before the real materials render.

## Phase 6 — Iteration 4, device feedback (`7a38905`)

**`7a38905` Iteration 4.** The final shipped wave, driven by extended device
use:

- **Thermal cadences + shadows off.** The definitive fix for the iPad heat: the
  sim ticks at 60 Hz **only** while the 3D model band is on screen and ~10 Hz
  otherwise (`setDetailMode` from camera events); the whole-fleet points FC is
  pushed at a zoom-dependent rate (15 Hz close → 5 s far); model `castShadows`/
  `receiveShadows` turned **off** (the top GPU cost at pitch).
- **Follow gestures persist.** Panning/zooming/rotating during follow no longer
  cancels it — the user's zoom/pitch and heading-**offset** (relative to tram
  bearing) are captured and re-applied on every retarget for the rest of the
  session; follow now stops only from the banner, and the default view moved to
  a behind-the-tram chase.
- **Pace controller rewrite.** Moved to an **observation-primary** blend with a
  systematic 10 m **trail bias** (ride slightly behind reality) and asymmetric
  **crawl / catch-up** regimes with hysteresis (`tramSim.ts`).
- **Live projection mode + fix overlay**, **doors-open at stops**, **motion logs
  + ride recording** (`src/lib/motionlog`, opt-in), and planner
  recents / nearest / route-here / times + on-map stop labels.

---

## Recurring lessons

- **Verify against the live system, not memory.** Every research doc and every
  fleet range was checked against the real API / real vehicle numbers; several
  brief-supplied "facts" (14T range, T6A5 still active) were wrong.
- **Fabric changes the rules.** Data sources are imperative-push-only; camera
  animators can be flooded; models must register before their layers. Most map
  bugs traced back to treating rnmapbox like declarative React.
- **expo-gl is WebGL1.** Any three.js work on native must pin compatible
  versions and polyfill the browser globals GLTFLoader expects.
- **Thermals are a feature.** On a device left running for an hour, redundant
  GeoJSON pushes and shadow passes are the enemy — cadence is tuned to visible
  motion, not a fixed frame rate.
</content>
</invoke>
