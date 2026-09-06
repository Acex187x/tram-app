# Tram Spotter — Architecture

iOS-only Expo SDK 57 app. Real-time Prague trams on a 3D Mapbox map with physics-based
interpolation, 3D models per tram type, and iOS 26 Liquid Glass UI.

Read `docs/research/*.md` first — all API facts, versions and gotchas live there.

## Module map

```
src/
  lib/feed/remoteFeed.ts       Convex AVL snapshot seed/diff stream
  lib/feed/types.ts            TramFeed snapshots, geometry, health and telemetry seam
  lib/golemio/gtfs.ts          served trip geometry and stop-time conversion
  lib/golemio/geometryPack.ts  provisional bulk geometry for cold starts
  lib/golemio/shapeCache.ts    memory/disk geometry cache and authoritative replacement
  lib/physics/convexSource.ts  separate Convex trajectory seed/diffs/meta + nonce clock
  lib/physics/trajectoryStore.ts typed curves, trip matching and connection health
  lib/physics/evaluator.ts     pure linear/validated Hermite curve evaluation
  lib/physics/fixForward.ts    newer-fix correction and terminal coast
  lib/physics/adapter.ts       evaluated target, presentation guard and public state
  lib/physics/fleet.ts         snapshots, geometry, observed pace and frame-owned state
  lib/render/featureBuilder.ts viewport culling, points and articulated section GeoJSON
  lib/fleet/modelSpecs.ts      physical section lengths, gaps and static model keys
  lib/fleet/registry.ts        registration → type and coupled-pair heuristic
  lib/motionlog/              bounded passive fleet logs and opt-in ride recordings
  hooks/tramData.ts           shared runtime, lifecycle, map cadence and 1 Hz React updates
  components/debug/          selected-tram inspector and imperative map traces
  components/model/          viewer assets, orbit and door/indicator mechanisms
  components/map/            native Mapbox sources, camera, selection and glass chrome
  components/ui/             native controls and guarded Liquid Glass surfaces
  stores/                    persisted settings/favorites and selection/follow ownership
  app/model/[id].tsx         Expo GL / three.js interactive tram viewer
lab/                         server predictor, ML integration, publication and diagnostics
convex/                      public fix/trajectory streams, geometry serving and clock query
scripts/tram-models/blender_fleet.py  editable Blender model authoring
scripts/generate-tram-models.mjs     generation and GLB validation entry point
```

Shared app contracts live in `src/lib/types.ts`. The protocol and rollout notes
are in [physics v3](research/physics-v3-protocol.md); read the dated amendments
as well as the original contract. This document describes the working tree,
including the September 2026 candidate changes; it does not assert production
promotion or device verification.

## Data flow and ownership

1. **AVL fixes:** the server polls Golemio. `RemoteFeed` seeds from
   `stream:fullFleet`, folds `stream:batchesSince` and emits the merged full
   fleet. A retention gap re-seeds; subscriptions periodically advance their
   cursor. `TramRuntime` constructs `RemoteFeed` unconditionally. The retired
   local Golemio feed is not the shipping path; an unavailable client stack
   yields `NullFeed`, never invented positions. Entity keys are registration
   numbers, with trip ID fallback.
2. **Geometry:** served `/geometry/{tripId}` data resolves through `shapeCache`.
   A cold-start `/geometry-pack` request seeds provisional shapes while the
   per-trip queue obtains authoritative stop epochs. Pack failure leaves the
   ordinary per-trip path intact. Replacing a provisional shape resets the
   presentation state for that geometry, avoiding mixed distance axes.
3. **Prediction:** `lab/` combines observations, route/stop geometry and ML
   outputs into `smooth` and `opinion` trajectories. Continuity/seam construction,
   dwell prediction and ML fallback belong to the server. Publication is
   asynchronous: newer fixes remain in `lastFix` for the next refresh, and
   superseded inference is discarded. A configured ML outage rebuilds when a
   curve is missing, belongs to the wrong trip/anchor, or has expired; failure
   diagnostics remain explicit. See [backend evidence and rollout limits](research/tracking-2026-09-05/README.md)
   and the [client replay investigation](testing/client-tracking-2026-09-05.md).
4. **Trajectories:** `ConvexTrajectorySource` seeds `trajectories:fullSet`, folds
   `trajectories:batchesSince`, and listens to `trajectories:meta` for publisher
   freshness. The metadata cursor does not replace the applied diff cursor.
   Retention gaps or a newer publication with a reset stream head re-seed;
   generation guards reject callbacks from obsolete subscriptions. This is a
   separate stream from AVL fixes: either may be fresh while the other is old.
5. **Presentation:** the runtime evaluates the active mode at corrected server
   time, applies explicit newer-fix/presentation rules, and emits native map
   data. Only actual map/bench frame producers commit the displayed position
   and interval velocity. UI, logging, camera look-ahead and diagnostics reads
   cannot advance that guard. Culling uses the same guarded/fallback distance
   as rendering before allocating public state.
6. **Cadence/lifecycle:** map due-checks run at 30 Hz near the glide band (enter
   zoom ≥14.0, exit <13.7), about 10 Hz farther out. Native source pushes have
   their own zoom-dependent budgets. React notifications share a 1 Hz gate,
   including trajectory publications; explicit mode changes are immediate.
   Ordinary background stops sources and timers. An active ride recording may
   retain data subscriptions and its slow logging path, with no map/UI frame
   loop. Resume evaluates current wall time rather than replaying missed ticks.

`EXPO_PUBLIC_CONVEX_URL` selects the fix backend; `EXPO_PUBLIC_CONVEX_SITE_URL`
selects served geometry. `EXPO_PUBLIC_TRAJECTORY_CONVEX_URL`, when set, isolates
only trajectories and their clock for candidate testing. No retired feed/engine
setting silently changes the production source.

## Client physics and displayed motion

The pure evaluator is small, but the complete client is **not stateless**.
Prediction remains server-owned; the client retains observation/geometry state,
newer-fix correction and the last frame actually displayed. Therefore two
clients can share the same raw curve while temporarily having different
presentation histories. Do not claim pixel identity for the guarded marker.

```
AVL fixes ───────────────┐
                        ↓
Convex smooth/opinion → pure evaluator → fix-forward target → frame guard
                        ↑                                  ↓
nonce RTT clock ────────┘                       shape point/bearing → Mapbox
```

- **Evaluation:** binary search over decoded `[t,s]` typed arrays. Optional knot
  velocities prepare cubic Hermite coefficients once at decode. A segment is
  accepted only when its whole span stays monotonic, within 0–16.7 m/s and
  −1.4…+1.3 m/s². Missing/infeasible velocity metadata retains exact linear
  interpolation; holds remain flat. The pure curve clamps outside its range.
  Position, inverse crossing and backend seam projection use compatible math.
- **Clock:** `clock:now` receives a nonce, avoiding cached reactive-query
  timestamps. RTT midpoint samples with RTT ≤2 s feed a three-sample weighted
  estimator. The applied offset approaches its target at at most 5% clock-rate
  correction, preventing fleet-wide jumps from latency jitter. The estimate uses
  the request midpoint; its ramp starts at actual reply receipt. Sampling runs at
  start/resume and once per minute. Missing clock support remains explicitly
  unsynchronized; cached metadata is not used as a substitute.
- **Newer fixes:** `fixForward.ts` advances the curve in time when a newer AVL
  fix establishes a forward anchor. Smooth mode rate-limits catch-up; fixed
  mode applies the correction directly. A terminal coast is bounded to 20 s
  and remains marked stale. A matching trip and coherent geometry are required.
- **Frame guard:** smooth mode cannot reverse between ordinary frames and has
  a 25 m/s presentation ceiling. Forward catch-up acceleration is capped at
  2.5 m/s² using the last displayed interval speed and local actual-frame elapsed
  time, independently of the corrected clock used to evaluate the curve. The marker never coasts past
  a revised target merely to satisfy a braking bound. Explicit discontinuities,
  trip/geometry changes and long suspension have separate reset/seek handling.
  This is a presentation safeguard, not a claim of physically measured motion.
- **Fallback:** without a matching trajectory but with geometry, bounded
  observed pace may advance the marker and is labeled stale. Short fix
  intervals accumulate to estimate pace; stops reset it. Unknown geometry stays
  at the raw fix with zero displayed speed. Ordinary getters remain read-only.
- **Honesty:** fleet publication age drives live/degraded/offline (<15 s,
  15–45 s, >45 s), but individual fix age, curve age, effective horizon and
  local receipt age remain separate diagnostic values. A fresh fleet heartbeat
  does not establish a fresh curve for every tram. Fixed is the model's current
  opinion, not ground-truth accuracy.

The retired on-client predictor/smoother, pace calibration and queue controller
remain documented as history in `decisions/engine-v2.md` and
`calibration/baselines/gate-v2.md`.

Articulation uses physical rigid lengths and gaps from `modelSpecs.ts`. For a
head at route distance `s`, section centers subtract preceding lengths/gaps and
half the section length; each center gets its own shape position and bearing.
Pair spacing is 15.104 m for standard T3 bodies and 16.2 m for PLF. Registration
and line-based pairing is still a heuristic, not a live coupling sensor.

## Fleet registry (live-verified 2026-07 + docs/research/prague-fleet.md)

| reg range | model | sections |
|---|---|---|
| ≤ 8014 (6004, 7269, 7290…) | `t3` historic → t3 model | 1 (14.0 m body) |
| 8015–8249 | `t3rp` (T3R.P) | 1 |
| 8251–8299 | `t3rplf` (T3R.PLF) | 1 |
| 8300–8579 | `t3rp` | 1 |
| 8750–8806 | `t3rplf` | 1 |
| 9051–9113 | `kt8d5` (KT8D5.RN2P) | 3 (30.3 m) |
| 9114–9199 | `14t` (Škoda 14T) | 5 (30.25 m) |
| 9200–9499 | `15t` (Škoda 15T ForCity Alfa) | 3 (31.4 m) |
| 9500–9599 | `52t` (Škoda 52T ForCity Plus) | 5 (31.99 m) |

(NOTE: research doc's "14T = 9404–9629" is wrong — live data confirms 14T cluster 9115–9172,
15T 9201–9459. T6A5 retired 2021 — not in table.)

## Map rendering — zoom modes

One points ShapeSource (all trams, always) + one sections ShapeSource (culled: viewport ∩ zoom ≥ 14.8).
Layers stacked, banded by zoom with opacity crossfades:

| mode | zoom | rendering |
|---|---|---|
| 1 | < 13.2 | CircleLayer dots (PID red, white stroke) |
| 2 | 13.2–14.8 | CircleLayer badge circle + SymbolLayer line number text |
| 3 | 14.8–17.0 | ModelLayer, modelScale on a deliberately cartoonish `exponential(1.6)` curve: **5×** at band entry (14.8, toy trams) → 3.2× (15.6) → 1.6× (16.4) → real-world **1×** only at z17 |
| 4 | ≥ 17.0 | ModelLayer real scale 1.0 |

Band edges live in `mapStyle.ts` (`BAND_DOTS_TO_BADGES` 13.2, `BAND_BADGES_TO_MODELS` 14.8,
`BAND_FADE` 0.3 crossfade); sections source feeds from `SECTIONS_FEED_MIN_ZOOM` 14.6 (warm-up
before the band). Comic curve top zoom is `MODEL_COMIC_REAL_SCALE_ZOOM` 17.0 in `TramLayers.tsx`
(the older `MODEL_REAL_SCALE_ZOOM` 16.6 const in `mapStyle.ts` is now vestigial — the live curve
is in TramLayers).

- ModelLayer style: `modelId: ['get','modelKey']`, `modelRotation: [0,0,['get','bearing']]`
  (NO heading offset — trams authored front-toward −Z so `z = bearing` faces correctly),
  `modelEmissiveStrength: 1.2`. `modelCastShadows`/`modelReceiveShadows` are **off** (iteration-4
  thermal fix — per-model shadow passes were the top GPU cost at pitch).

### SPIKE-VERIFIED conventions (2026-07-11, simulator, rnmapbox 10.3.2 / Mapbox iOS 11.20.1)
- Data-driven `modelId: ['get','modelKey']` AND `modelRotation: [0,0,['get','bearing']]` WORK.
- GLB loading: `require()` asset URLs are BROKEN in dev (native strips query params from metro
  URLs). MUST load via `Asset.fromModule(require(...)).downloadAsync()` → pass `localUri`
  (file://) strings to `<Models models={{key: uri}}>`. Render `<Models>` only after all resolved.
- Model orientation (empirical): GLB Y-up, meters. With `modelRotation z = β`, the model's
  authored +Z axis points at compass bearing β+180°, rotation clockwise-positive.
  ⇒ CONVENTION: author trams with FRONT toward **−Z**; then `z = bearing` faces correctly.
- `ModelLayer` needs `slot="top"` over the Standard style; add layers only after style load
  (models registered before layers — <Models> first works).
- Hot reload does NOT re-register models/layers reliably — restart the app when iterating on map code.

### POST-SPIKE quirks (verified on-device during the fix waves — supersede the spike notes)
- **Base style — styleURL, NOT a custom styleJSON.** The spike guessed a custom styleJSON with
  `imports:[{id:'basemap', url:'…/standard'}]` would enable live re-lighting. On device that path
  rendered a **black basemap**. Live layout (`index.tsx`) uses `styleURL="mapbox://styles/mapbox/standard"`
  directly and mounts `<StyleImport id="basemap" existing config={…}>` **only after
  `onDidFinishLoadingStyle`** — applying config before the style loads logs "Import basemap does
  not exist" and is silently dropped. (`buildMapStyleJSON` in `mapStyle.ts` is the abandoned
  styleJSON path, kept for reference; it is not mounted.)
- **Live sources bypass Fabric (rnmapbox patch).** Every data ShapeSource
  (`trams-points`, `trams-sections`, `route-network`, `route-stops`, planner overlay) is mounted
  once without a `shape` prop and receives data only via the patched direct-native
  `ShapeSource.updateShape` command. `setNativeProps` is not safe for moving data on Fabric:
  concurrent UI commits can replay an older ShadowTree source value, visible as a rewind.
  Layer style props may still change through React freely.
- **ShapeSource children must be a plain element array** — no `false`/`undefined` holes. rnmapbox
  clones each child to inject `sourceID`; a hole crashes it. Optional layers (3D totem, extra model
  layer) are pushed into an array conditionally, never rendered as `{cond && <Layer/>}` inline.
- **Data-driven `modelId: ['get','modelKey']` works for the stop totem too**, not just trams — one
  totem GLB registered under `stop-totem`, every stop feature carries `modelKey: 'stop-totem'`
  (`RouteNetwork.tsx`). The totem ModelLayer is mounted one commit AFTER the GLB registers
  (`stopTotemReady` → 150 ms defer) to honor the models-before-ModelLayers rule.
- **GLB asset URIs must resolve before `<Models>` mounts** — `useTramModels` downloads every GLB via
  `Asset.fromModule().downloadAsync()` and passes `file://` `localUri` strings; `<Models>` (and any
  ModelLayer) render only once the whole map is non-null (`require()` query-stripping bug from the
  spike still applies in dev).
- Transparent CircleLayer across all zooms for hit-testing (ModelLayer taps unreliable).
- Route lines: LineLayer over union of loaded shapes (PID red), below tram layers; selected line
  highlighted gold.
- Stops: CircleLayer small, visible ≥ zoom 14, from stops of loaded shapes; NAME labels ≥ 15.8;
  3D totem ModelLayer ≥ 16.
- Camera follow (`TramLayers.tsx`): **NOT per-frame**. Retargeting `setCamera` on every 16 ms tick
  restarts the native Mapbox animator 60×/s and chokes it into ~1 Hz stutter (device-reported
  regression). Instead: retarget every `CAMERA_RETARGET_MS` (80 ms, ~12.5 Hz) with a longer
  `CAMERA_GLIDE_MS` (170 ms) `linearTo` glide — each glide starts before the previous ends, so
  they overlap into continuous motion. Default chase view is FROM BEHIND (`heading = tram bearing`,
  `FOLLOW_ZOOM` 17.5, `FOLLOW_PITCH` 60) so buildings don't occlude the tram; the center is
  lead-projected (`leadTarget`) toward where the tram will be at the next retarget.
- Follow gestures **persist and do NOT cancel follow** (iteration 4): while the user's fingers are
  on the map the retarget loop yields; their zoom/pitch and heading-**offset** (relative to the
  tram bearing) are captured via `FollowGestureState` (owned by the map screen's `onCameraChanged`)
  and re-applied on every subsequent retarget for the rest of that follow session. A new follow (or
  follow end) resets to defaults. Follow is stopped only from the banner (tap-to-stop), the tram
  disappearing, or another fly-to.
- Style: Mapbox Standard. `config={{...STANDARD_CONFIG, lightPreset}}` (auto by Prague time, or a
  settings override), re-lit live via StyleImport.

## UI (iOS 26 Liquid Glass)

Theme: PID dark red `#7A0603`, cream `#F3E9D2`, asphalt. All chrome = GlassView (guarded by
`isGlassEffectAPIAvailable()`, fallback expo-blur) floating over full-bleed map.

The owned map sheet is a full-width bottom sheet on compact-width devices and a
375 pt left side sheet on iPad/landscape. Regular width changes only its width
and placement: it retains the same peek → medium → large detents, grabber and
pan/scroll hand-off. It opens large on iPad and can be pulled down to the compact
search capsule; replacing it with a tram sheet slides the home sheet offstage.

Debug mode adds a collapsed selection inspector with native Overview/History/
Server/Help segments, bounded 60 s history and foreground-only 1 Hz sampling.
Following is optional. Separate raw fix, displayed smooth/fixed and ML target
traces use imperative native source updates. A held curve is not labeled a
real stop without evidence; GPS comparison is opt-in for a rider aboard that
tram. See [inspector contract and QA](testing/tracking-inspector.md).

The model viewer loads 19 viewer-specific GLBs with named door/indicator nodes,
separate from the 34 static map assets. Front/rear presets and accessible orbit
actions accompany gestures. Door demos interpolate leaf transforms over 1.6 s;
selected-side indicators blink with an 800 ms period. Reduce Motion makes doors
instant and lamps steady. The viewer uses native PBR on devices and a bounded
640 px Lambert render target on Simulator, schedules frames after the Expo GL
flush barrier and preserves depth precision with a model-aware camera range.
Native build-31 iPad controls and rendered mechanism changes passed; the dated
QA note separates those checks from earlier failures and physical-device tests. Asset geometry,
authoritative references and budgets are in [3D model decisions](decisions/3d-models.md).

Routes (expo-router Stack, map = root):

- `/` owns the map, adaptive home/tram sheets and floating map controls. The tram
  card contains its stop timeline, ride recording and model information; its
  action capsule exposes favorites, information and photos.
- `/tram/[key]` is an invisible deep-link bridge. It opens the owned tram card,
  selects and follows the vehicle, then dismisses navigation back to the map.
- `/search` presents live fleet/stop search; `/line/[id]` and `/stop/[key]` show
  line stops and live station arrivals, with explicit fly-to actions.
- `/favorites`, `/planner`, `/settings` and `/rides` use the shared native sheet
  configuration. Settings includes render mode, appearance and developer tools.
- `/model-info/[id]` and `/tram-photos/[reg]` present details and reference photos.
  `/model/[id]` is the opaque interactive GL viewer, with its own close control.

Persistence: zustand/persist over expo-file-system adapter (favorites, settings, shape cache index).

## Testing

- jest-expo unit tests: curve evaluation and malformed velocity fallback, clock/transport
  recovery, frame ownership, geometry/culling, fleet registry, mechanisms and diagnostics.
- Fixed-input wire replay: compare baseline/candidate at identical receive times; separate
  sanctioned discontinuities, stale coverage and positional accuracy from frame smoothness.
- Native Simulator E2E: `scripts/testing/` drives real XCTest gestures and controls,
  exports state screenshots and checks live publication advancement. Visual review
  and physical-device delivery remain separate from assertion success.
