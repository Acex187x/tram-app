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
    fleet/registry.ts      # regNumberToModel(), MODEL_SPECS (sections, lengths, livery), coupled-pair heuristic
    geo/polyline.ts        # Polyline: cumulative dists, pointAt(s), bearingAt(s), curvature profile
    engine/engine.ts       # TramEngine (pure TS, no React): ingest() + tick() + getFrame()
    engine/speedProfile.ts # per-shape speed-limit profile from curvature + stops + zones
    engine/tramSim.ts      # per-tram physics/state machine
    render/featureBuilder.ts # engine frame → GeoJSON FCs (points FC + 3D sections FC), viewport culling
  components/map/          # MapScreen composition: layers, camera controller, glass chrome
  components/ui/           # GlassPanel (guarded expo-glass-effect w/ blur fallback), badges, rows
  stores/                  # zustand: favorites (persisted), selection/follow, settings (persisted)
  hooks/tramData.ts        # TramRuntime singleton: poll + thermal-adaptive tick loop + frame/UI
                           #   subscriptions (useTramRuntime/useAllTramStates/useTramState)
  lib/motionlog/           # opt-in ride/motion recorder (settings) — logs polls + device GPS,
                           #   persisted via expo-file-system; decoupled behind a require() guard
  app/                     # expo-router routes (see UI section)
scripts/generate-tram-models.mjs  → assets/models/*.glb
```

Shared contracts: `src/lib/types.ts` — single source of truth, all modules import from it.

## Data flow

1. React Query polls `GET /v2/vehiclepositions?limit=10000` every **5s**
   (`refetchIntervalInBackground: false`). Filter `trip.gtfs.route_type === 0`.
   NEVER pass `includeNotTracking=true`. `shape_dist_traveled` is a **string in km** → meters.
2. Entity key: `vehicle_registration_number` (stable across trips), fallback `trip_id`.
3. Unseen `trip_id` → shape queue: `GET /v2/gtfs/trips/{id}?includeShapes=true&includeStopTimes=true&includeStops=true`,
   ≤2 concurrent, priority: followed > viewport > rest. Result → `RouteGeometry`
   (coords, cumulative meters, per-vertex curvature, stops with dist-along-shape from
   stop_times.shape_dist_traveled (number, km) + arrival/departure + dwell). Disk-cache by
   `shape_id`; stop-times cache by `trip_id` (TTL 24h — trip_ids roll over ~12 days).
4. `TramEngine.ingest(snapshots, tripDetails)` updates per-tram anchors; `tick(now)` advances
   physics; `featureBuilder` emits GeoJSON → `ShapeSource.setNativeProps`. **Thermal-adaptive
   cadence** (`tramData.ts`, iteration 4 — iPad ran hot after an hour): the sim ticks at 60 Hz
   (`TICK_MS` 16) ONLY while the 3D model band is on screen (`setDetailMode` from camera events),
   ~10 Hz (`TICK_IDLE_MS` 100) otherwise. The whole-fleet points FC is pushed at a zoom-dependent
   rate (`pointsPushIntervalMs`: ~15 Hz close, 1 s mid, 5 s far); the sections FC only while the
   band is visible; empty FCs skip stringify+push entirely.

## Interpolation engine (the heart)

Per tram: simulated distance-along-shape `s` (m) and speed `v` (m/s).

Speed limit field, precomputed per shape (`speedProfile.ts`):
- `vLimit[i]` per vertex = min(zone cap, curve cap). Curve cap = `sqrt(A_LAT / κ)` with
  `A_LAT = 0.98 m/s²`, κ = |heading change|/meter smoothed over ±10 m window; clamp to [1.4, 13.9] m/s.
- Zone cap: 13.9 m/s (50 km/h) default; 8.6 m/s (31 km/h) inside CENTER_BBOX
  (lng 14.395–14.46, lat 50.068–50.096) between 07:00–19:00 Prague time.
- Stops are `vLimit = 0` points at their `distM`; terminal = last stop.

Runtime per tick (dt ≤ 100 ms):
- Braking envelope: `vAllowed(s) = min over upcoming limits within 400 m of sqrt(vLim² + 2·A_BRK·(d−s))`,
  `A_BRK = 1.2 m/s²`, `A_ACC = 1.0 m/s²`. → accelerates on straights, brakes before curves/stops.
- Dwell: reaching a stop (within 2 m) → hold `v=0` for `computed_dwell_time_seconds` (fallback
  18 s ± deterministic jitter by stop id hash). Terminal stop → hold until new trip data arrives.
- Anchors (see `tramSim.ts` for the live constants): the pace controller is
  **observation-primary**, not timetable-primary. Each poll re-anchors the raw AVL fix
  (`obsDistM` @ `obsAtMs`). The schedule anchor `sSched(t)` (piecewise-linear dist-vs-time over
  stops, shifted by `delay.actual`) is only a **low-gain reference** used to project the
  observation forward: `sObs(now) = obsDistM + max(0, sSched(now) − sSched(obsAtMs))`.
- Pace target = a blend that rides slightly BEHIND reality:
  `target = OBS_BLEND_WEIGHT·sObs + (1−OBS_BLEND_WEIGHT)·sSched − TRAIL_M`
  (`OBS_BLEND_WEIGHT = 0.75`, systematic `TRAIL_M = 10 m`). Error `e = target − s` drives an
  **asymmetric three-regime** controller:
  - `e < −HARD_BRAKE_ENTER_M` (40 m, sim overran reality) → **crawl regime**: `vTarget ≤ CRAWL_V_MS`
    (1.0 m/s), latched with hysteresis until `e` recovers above `−HARD_BRAKE_EXIT_M` (12 m).
  - `e > BOLD_CATCHUP_ERR_M` (40 m, sim behind) → **bold catch-up**: pace factor up to
    `CATCHUP_MAX_FACTOR` (1.5).
  - between → **gentle proportional**: factor `clamp(1 + e/PACE_GAIN_M, MIN_PACE_FACTOR, GENTLE_MAX_FACTOR)`
    = `clamp(1 + e/120, 0.55, 1.35)`.
  All regimes stay under the braking envelope (`vTarget ≤ vAllowed`) — catch-up can never overrun
  a curve/stop. `s` NEVER decreases.
- Hard teleport: only when the projected OBSERVATION (`sObs`, not the timetable) disagrees with `s`
  by more than `TELEPORT_THRESHOLD_M` (500 m) → snap to `sObs`, reseed stop state, stamp
  `lastTeleportMs` (renderer may dip opacity). New poll data otherwise converges via the pace
  controller with no position jumps.

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
- **Sources are imperative-push-only (Fabric + rnmapbox quirk).** Every data ShapeSource
  (`trams-points`, `trams-sections`, `route-network`, `route-stops`, planner overlay) is mounted
  ONCE with a stable empty FeatureCollection and receives data ONLY via `setNativeProps` on a
  timer/frame. If React ever commits a changing `shape` prop the native source reverts or never
  applies. Layer STYLE props may still change through React freely.
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
