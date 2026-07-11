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
  hooks/                   # useTramEngine (poll + tick loop + setNativeProps push), useZoomMode
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
   physics; `getFrame(viewport, zoomMode)` emits GeoJSON at ~15fps → `ShapeSource.setNativeProps`.

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
- Schedule anchor: `sSched(t)` = piecewise-linear distance-vs-time through stops using
  timetable times shifted by `delay.actual` seconds, updated on every poll. Pace controller:
  `e = sSched(now) − s`; cruise target `vTarget = vAllowed · clamp(1 + e/120, 0.55, 1.65)`.
  |e| > 500 m → hard teleport to `sSched(now)` (with 300ms opacity dip if visible).
  `s` NEVER decreases.
- New poll data → recompute sSched + delay; convergence happens via the pace controller
  (no position jumps).

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
| 3 | 14.8–16.6 | ModelLayer, modelScale interpolated 2.6→1.0 by zoom (comically large → real) |
| 4 | ≥ 16.6 | ModelLayer real scale 1.0 |

- ModelLayer style: `modelId: ['get','modelKey']`, `modelRotation: [0,0,['get','bearing']]`
  (+ HEADING_OFFSET calibration const), `modelEmissiveStrength: 1.2`.
- Transparent CircleLayer across all zooms for hit-testing (ModelLayer taps unreliable).
- Route lines: LineLayer over union of loaded shapes (dark red 7A0603 + lighter casing),
  below tram layers; selected line highlighted.
- Stops: CircleLayer small, visible ≥ zoom 14, from stops of loaded shapes.
- Camera follow: per engine frame `camera.setCamera({centerCoordinate, animationMode:'linearTo',
  animationDuration: frameMs})`, optional heading-lock. Style: Mapbox Standard via StyleImport
  `config={{lightPreset: auto by time, show3dObjects:'true'}}`.

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
