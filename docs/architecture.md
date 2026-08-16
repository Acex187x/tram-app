# Tram Spotter — Architecture

iOS-only Expo SDK 57 app. Real-time Prague trams on a 3D Mapbox map with physics-based
interpolation, 3D models per tram type, and iOS 26 Liquid Glass UI.

Read `docs/research/*.md` first — all API facts, versions and gotchas live there.

## Module map

```
src/
  lib/
    golemio/client.ts      # fetch wrapper: base URL + X-Access-Token, rate-limit queue (≤18 req/8s)
    golemio/types.ts       # raw API response types (vehiclepositions, gtfs trips/shapes/stops/routes)
    golemio/vehicles.ts    # fetchTramPositions(): poll + filter route_type===0 → TramSnapshot[]
    golemio/gtfs.ts        # fetchTripDetail(tripId) → RouteGeometry source data; stops/routes helpers
    golemio/shapeCache.ts  # disk-persisted (expo-file-system) shape_id → RouteGeometry, in-mem LRU on top
    feed/types.ts          # TramFeed boundary contract + CalibrationRecord (what a future backend implements)
    feed/localGolemioFeed.ts # TramFeed impl on-client: the 5 s poll loop + shapeCache/motionlog delegation
    feed/calibration.ts    # TramPublicState → CalibrationRecord (field order/rounding = JSONL + API contract)
    fleet/registry.ts      # regNumberToModel(), MODEL_SPECS (sections, lengths, livery), coupled-pair heuristic
    geo/polyline.ts        # Polyline: cumulative dists, pointAt(s), bearingAt(s), curvature profile
    physics/evaluator.ts   # evalTrajectory(track, tMs): binary search + lerp — the whole client physics
    physics/bundle.ts      # /api/trajectories/v2 → typed arrays, once per fetch; clock.ts = server-time offset
    physics/fleet.ts       # curves → TramPublicState behind the seam TramEngine used to occupy
    render/featureBuilder.ts # fleet states → GeoJSON FCs (points FC + 3D sections FC), viewport culling
  components/map/          # MapScreen composition: layers, camera controller, glass chrome
  components/ui/           # GlassPanel (guarded expo-glass-effect w/ blur fallback), badges, rows
  stores/                  # zustand: favorites (persisted), selection/follow, settings (persisted)
  hooks/tramData.ts        # TramRuntime singleton: consumes an injected TramFeed (default
                           #   LocalGolemioFeed) + thermal-adaptive tick loop + frame/UI
                           #   subscriptions (useTramRuntime/useAllTramStates/useTramState)
  lib/motionlog/           # opt-in ride/motion recorder (settings) — stores the feed's calibration
                           #   records + device GPS, persisted via expo-file-system; decoupled
                           #   behind a require() guard
  app/                     # expo-router routes (see UI section)
scripts/generate-tram-models.mjs  → assets/models/*.glb
```

Shared contracts: `src/lib/types.ts` — single source of truth, all modules import from it.

## Feed boundary (TramFeed)

All live data crosses ONE seam: the `TramFeed` interface (`src/lib/feed/types.ts`)
— push-style snapshot batches (`subscribeSnapshots`), trip-geometry resolution
(`getGeometry`/`requestGeometry`/`promoteGeometry`), a calibration-telemetry sink
(`reportCalibration`, `CalibrationRecord`), and feed health (`status()` → status
chip). `TramRuntime` consumes an injected feed and owns only the simulation;
`LocalGolemioFeed` is today's sole implementation — the "backend" running on the
client (5 s Golemio poll loop, shapeCache, motionlog storage). A future
`RemoteFeed` (server polls Golemio at ~1–2 s, pushes diffs, precomputes geometry,
aggregates calibration fleet-wide) replaces it 1:1 with the engine and UI
untouched — see `decisions/backend-plan.md`.

## Data flow

1. The feed (`LocalGolemioFeed`) polls `GET /v2/vehiclepositions?limit=10000`
   every **5s** (foreground only) and pushes each batch into the runtime.
   Filter `trip.gtfs.route_type === 0`.
   NEVER pass `includeNotTracking=true`. `shape_dist_traveled` is a **string in km** → meters.
2. Entity key: `vehicle_registration_number` (stable across trips), fallback `trip_id`.
3. Unseen `trip_id` → shape queue: `GET /v2/gtfs/trips/{id}?includeShapes=true&includeStopTimes=true&includeStops=true`,
   ≤2 concurrent, priority: followed > viewport > rest. Result → `RouteGeometry`
   (coords, cumulative meters, per-vertex curvature, stops with dist-along-shape from
   stop_times.shape_dist_traveled (number, km) + arrival/departure + dwell). Disk-cache by
   `shape_id`; stop-times cache by `trip_id` (TTL 24h — trip_ids roll over ~12 days).
4. `TramEngine.ingest(snapshots, tripDetails)` updates per-tram anchors; `tick(now)` advances
   physics; `featureBuilder` emits GeoJSON → the patched direct-native
   `ShapeSource.updateShape` command (outside Fabric). **Thermal-adaptive
   cadence** (`tramData.ts`, iteration 4 — iPad ran hot after an hour): the sim ticks at 30 Hz
   (`TICK_MS` 33) ONLY while the 3D model band is on screen (`setDetailZoom` from camera events),
   ~10 Hz (`TICK_IDLE_MS` 100) otherwise. The points FC is pushed at a zoom-dependent
   rate (`pointsPushIntervalMs`: ~15 Hz close, 1 s mid, 5 s far) and is culled before public-state
   allocation at close zoom; the sections FC only while the
   band is visible; empty FCs skip stringify+push entirely. Live sources omit the
   React `shape` prop and never use `setNativeProps`, so unrelated Fabric commits cannot replay
   an older source frame.
5. A true background pause records wall time and stops all work. Foregrounding calls
   `TramEngine.resyncAfterSuspension(now)` once: sims seek forward to bounded absolute
   timetable/AVL anchors before rendering resumes, rather than restarting at their old
   position or synchronously replaying every missed physics step.

## Client physics (physics v3)

**One pure function over server-published curves.** The client simulates
nothing any more: prediction, smoothing and all per-tram state live in the
predictor service, which publishes ready-made trajectories; the app only
evaluates them. The wire format, the continuity / modal-stop invariants the
server must honour, and the connection-honesty table are FROZEN in
[`research/physics-v3-protocol.md`](research/physics-v3-protocol.md) — read it
before touching either side. `src/lib/physics/` is the whole engine:

```
GET /api/trajectories/v2   two curves per tram, built server-side
  ├─ smooth   continuity track, blended across emissions → default
  └─ opinion  raw model opinion, re-anchors on each fix  → "fixed" mode
       ↓ evaluated at Date.now() + clockOffset
  s (meters along shape) → polyline.pointAt/bearingAt → position + bearing
```

- **`evaluator.ts`** — `evalTrajectory(track, tMs)`: binary search + lerp over a
  `Float64Array` of `t,s` knots, clamped at both ends, so the app can never
  animate past the data it has. No state, no allocation (100k calls ≈ 4–10 ms).
- **`bundle.ts`** — decodes one fetch into typed arrays once (≤ 24 knots/track);
  nothing per frame. **`trajectoryStore.ts`** is the single network call: one
  bundle per 5 s for the whole fleet.
- **`clock.ts`** — `serverNowMs − Date.now()` offset (EWMA over the last 3
  fetches). Every evaluation uses server time, which is what makes two devices
  render the same tram in the same place at the same instant.
- **`render.ts`** — picks the track: `smooth` (default) or `fixed`
  («Более точное положение»). Switching is FREE — it changes which curve the
  next evaluation reads, and nothing else.
- **`connection.ts`** — live / degraded / offline derived from BUNDLE AGE
  (< 15 s, 15–45 s, > 45 s), not from fetch outcomes; drives the explicit
  offline banner and the dimmed `stale` render prop.
- **`adapter.ts` / `fleet.ts`** — curves → `TramPublicState` behind the exact
  seam `TramEngine` used to occupy (`ingest()` / `getStates*`), so the ~40 UI
  consumers stayed untouched across the replacement.

There is no tick loop and no per-tram state left: `TICK_MS` now only paces the
map's push due-checks, and resuming after any suspension is correct by
construction (evaluate at `now`) — no seek, no catch-up integration.

The v2 engine — predictor (`tramSim`), smoother, `speedProfile`, the
`paceBias`/TOD calibration surface and the client queue/junction constraints —
is retired. Its design record and gate results survive as history in
`decisions/engine-v2.md` and `calibration/baselines/gate-v2.md`; the physics
they encoded now belongs to the server.

Sections (articulated bending): model spec gives section lengths `L_i` and gaps. Head at `s`;
section i center at `s − (Σ previous lengths + gaps) − L_i/2`; its position/bearing from
`polyline.pointAt/bearingAt`. Each section = one GeoJSON feature `{modelKey: '15t-b', bearing}`.
Coupled T3 pairs (T3R.P/PLF on day lines except 23): render second car 14.5 m behind.

## Fleet registry (live-verified 2026-07 + docs/research/prague-fleet.md)

| reg range | model | sections |
|---|---|---|
| ≤ 8014 (6004, 7269, 7290…) | `t3` historic → t3 model | 1 (14.1 m) |
| 8015–8249 | `t3rp` (T3R.P) | 1 |
| 8251–8299 | `t3rplf` (T3R.PLF) | 1 |
| 8300–8579 | `t3rp` | 1 |
| 8750–8806 | `t3rplf` | 1 |
| 9051–9113 | `kt8d5` (KT8D5.RN2P) | 3 (30.3 m) |
| 9114–9199 | `14t` (Škoda 14T) | 5 (30.25 m) |
| 9200–9499 | `15t` (Škoda 15T ForCity Alfa) | 3 (31.4 m) |
| 9500–9599 | `52t` (Škoda 52T ForCity Plus) | 5 (~32 m) |

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

Debug mode adds a compact horizontal command deck over the top of the app and
an in-world comparison for the selected/followed tram: raw AVL fix (magenta),
projected live position (lime), and smooth physics position (cyan), with
20-second trails and a live↔smooth delta. The active render mode is marked with
`*`; the trace GeoJSON uses direct-native `ShapeSource.updateShape` updates.

Routes (expo-router Stack, map = root):
- `/` map + glass chrome: top-right button stack (locate me, pitch 2D/3D, style), bottom glass
  pill: search (line #, reg #, stop) + Lines / Favorites / Planner buttons.
- `/tram/[key]` formSheet (detents [0.35, 0.9], largestUndimmed so map stays live): model name +
  type info, line badge, headsign, delay, sim speed, next stops timeline, AC/USB badges,
  Follow + Favorite buttons.
- `/line/[id]` formSheet: stops list w/ live tram positions, active tram count, tap-to-fly.
- `/favorites` formSheet: favorite trams (live status: line/not in service) + favorite lines.
- `/planner` formSheet: stop A → stop B over tram network graph (built from cached trip stop
  sequences): direct + 1-transfer BFS, results drawn on map.
- `/settings` formSheet: light preset override, about, Golemio/PID attribution.

Persistence: zustand/persist over expo-file-system adapter (favorites, settings, shape cache index).

## Testing

- jest-expo unit tests: polyline math, speed profile, braking envelope, dwell, pace controller,
  fleet registry ranges, feature builder.
- Simulator E2E: Codex drives the app, screenshots each zoom mode + screens.
