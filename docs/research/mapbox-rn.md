# Mapbox in Expo SDK 57 — Implementation Research (`@rnmapbox/maps`)

Research date: 2026-07-11. Target app: Expo SDK 57 (`expo ~57.0.4`), React Native `0.86.0`,
React `19.2.3`, new architecture (Fabric) enabled, iOS, 3D Mapbox map of Prague trams moving in
real time. Public token is `EXPO_PUBLIC_MAPBOX_KEY` (`pk.…`) in `.env`.

**Bottom line:** Use `@rnmapbox/maps@10.3.2` (latest, published 2026-07-05). It compiles the native
**Mapbox Maps SDK for iOS v11** (default pinned `11.20.1`, style-spec vendored from `11.23.1`). It
supports RN 0.86 + new architecture + Expo SDK 57 precompiled/static-framework pipeline. It exposes
the **Mapbox Standard** style with 3D buildings/terrain/lighting, and it has first-class
**`ModelLayer` + `Models`** components for rendering **GLB/glTF 3D models** driven by data
expressions — this is the correct rendering path for 3D trams. No three.js / expo-gl overlay needed.

---

## 0. Verified version facts (npm + GitHub, July 2026)

- `npm view @rnmapbox/maps dist-tags` → `{ latest: '10.3.2', next: '10.3.2-rc.2' }`.
- Publish dates: `10.3.0` 2026-03-22, `10.3.1` 2026-05-16, **`10.3.2` 2026-07-05**.
- `peerDependencies` of `10.3.2`: `react-native: '>=0.79'`, `react: '>=17'`, `expo: '>=47.0.0'`.
  → RN 0.86 is inside the supported range.
- `10.3.2` changelog explicitly includes:
  - `fix(ios): support static frameworks under Expo SDK 57 precompiled pipeline` ← **directly relevant**.
  - `fix(android): use getReactTag() for react-native >= 0.87 compatibility`.
  - `fix(PointAnnotation): fix nested children not rendering on New Architecture (Fabric)`.
  - `fix(ShapeSource): minZoomLevel property`; `PointAnnotationManager` with slot support.
  - Style-spec regenerated against **Mapbox Maps SDK 11.23.1**.
- Fabric / new-architecture support has existed since the 10.1.x line; the whole `10.x` series ships
  Fabric component views (`ios/RNMBX/*ComponentView.mm`). New arch is the default on this app and is fine.

> Cross-check before install: `npm view @rnmapbox/maps@latest version` at build time — a `10.3.3`/`10.4.x`
> may land. Pick latest `10.x`. Do not drop to the deprecated `10.1.x`/pre-`10.2` lines.

---

## 1. Install into this Expo CNG app

### 1.1 Add the package + plugin

```sh
npx expo install @rnmapbox/maps
```

`app.json` → `expo.plugins` (this repo currently has only `expo-router` + `expo-splash-screen`):

```jsonc
"plugins": [
  "expo-router",
  ["expo-splash-screen", { /* existing */ }],
  [
    "@rnmapbox/maps",
    {
      "RNMapboxMapsVersion": "11.23.1"   // pin the native iOS SDK; see note below
    }
  ]
]
```

- **`RNMapboxMapsVersion`** — overrides the native Mapbox iOS SDK CocoaPods version. The plugin's
  built-in default (as of `10.3.2`) is `11.20.1`. Pinning to `11.23.1` matches the vendored style-spec
  and gets the newest Standard-style + ModelLayer fixes. Pin it explicitly for reproducible EAS builds.
- **Download token (`sk.…`) is NOT required.** With Mapbox iOS SDK v11 the maintainer has deprecated
  the secret download token. The current `plugin/install.md` shows **only** `RNMapboxMapsVersion` —
  no `RNMapboxMapsDownloadToken`, no `.netrc`. Historically v10-era builds needed a `sk.` token +
  `~/.netrc`; that requirement is gone for v11. Do **not** add `RNMAPBOX_MAPS_DOWNLOAD_TOKEN` to EAS
  secrets unless a future build error explicitly asks for it. (If a build ever 401s pulling the pod,
  the escape hatch is `"RNMapboxMapsDownloadToken": "sk.…"` with `DOWNLOADS:READ` scope, or the
  `RNMAPBOX_MAPS_DOWNLOAD_TOKEN` env var / EAS secret — but this is legacy.)
- `RNMapboxMapsImpl` is an Android-only knob (`mapbox` vs `mapbox-gl`); irrelevant on iOS.

### 1.2 Runtime access token (the `pk.` token)

There is **no plugin field** for the public token — set it in JS before the first map mounts:

```ts
import Mapbox from '@rnmapbox/maps';

Mapbox.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_KEY!);
```

Do this once at module top-level in the root layout (e.g. `src/app/_layout.tsx`), guarded so it only
runs on native. The `EXPO_PUBLIC_` prefix means the value is inlined at bundle time — fine for a `pk.`
token (public by design). Optionally `Mapbox.setTelemetryEnabled(false)`.

### 1.3 Build

Cannot run in Expo Go — requires a dev client. Rebuild native:

```sh
npx expo prebuild --clean        # regenerate ios/ with the plugin (CNG)
npx expo run:ios                 # or: eas build --profile development --platform ios
```

For the on-device / production route use `eas build`. Add
`NSLocationWhenInUseUsageDescription` via the `expo-location` plugin only if you show the user puck.

---

## 2. 3D: Standard style, buildings, terrain, pitch, camera

### 2.1 Standard style with 3D objects (buildings + landmarks + lighting)

The **Mapbox Standard** style is 3D by default (extruded buildings, trees, 3D landmarks, sky/atmosphere,
time-of-day lighting). Set it via `MapView.styleURL`:

```tsx
import Mapbox, { MapView, Camera, StyleImport } from '@rnmapbox/maps';

<MapView
  style={{ flex: 1 }}
  styleURL={Mapbox.StyleURL.Standard}   // === 'mapbox://styles/mapbox/standard'
  projection="globe"                     // or "mercator"; globe looks great when zoomed out
  scaleBarEnabled={false}
>
  <Camera /* see §2.2 */ />

  {/* Configure the Standard basemap's built-in imports (v11 only) */}
  <StyleImport
    id="basemap"
    existing
    config={{
      lightPreset: 'dusk',            // 'dawn' | 'day' | 'dusk' | 'night'
      theme: 'default',               // 'default' | 'faded' | 'monochrome'
      show3dObjects: true,            // 3D buildings + landmarks
      showPointOfInterestLabels: false,
      showTransitLabels: true,
      showRoadLabels: true,
      showPlaceLabels: true,
    }}
  />
</MapView>
```

- `Mapbox.StyleURL.Standard` is the beautiful default 3D city view. `Mapbox.StyleURL.StandardSatellite`
  (`mapbox://styles/mapbox/standard-satellite`) is the 3D satellite variant. The example app still
  references `mapbox://styles/mapbox/standard-beta`; prefer the GA `standard`.
- `StyleImport` with `existing` + `config` is how you toggle the Standard style's imported basemap
  config (this is v11-only and is the rnmapbox equivalent of `setConfigProperty('basemap', …)`).
  `lightPreset: 'night'`/`'dusk'` gives a dramatic city look; changing it re-lights buildings live.
- **Terrain:** Standard already includes globe atmosphere. For exaggerated 3D terrain add a raster-dem
  source + `<Terrain />`:
  ```tsx
  import { RasterDemSource, Terrain, Atmosphere } from '@rnmapbox/maps';
  <RasterDemSource id="dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={514} maxZoomLevel={14}>
    <Terrain style={{ exaggeration: 1.4 }} />
  </RasterDemSource>
  ```
  Prague is fairly flat — terrain is optional; the building/tram 3D matters more.
- If you ever need a **fully custom** style, build it in Mapbox Studio on top of the Standard base and
  put your `mapbox://styles/<user>/<id>` URL in `styleURL`; you can still add ModelLayer/ShapeSource at runtime.

### 2.2 Pitch + camera follow with heading

```tsx
<Camera
  ref={cameraRef}
  defaultSettings={{ centerCoordinate: [14.4378, 50.0755], zoomLevel: 15, pitch: 55 }}
  // static declarative control:
  pitch={55}                 // 0 = top-down, 60 = strong 3D tilt (iOS max ~85)
  heading={0}                // bearing, degrees from true north
  animationMode="easeTo"
  animationDuration={800}
/>
```

For a beautiful 3D city look: `zoomLevel` 15–17, `pitch` 45–60. See §6 for smooth moving-target follow.

---

## 3. CRITICAL — 3D model rendering (`ModelLayer` + `Models`) ✅ SUPPORTED

`@rnmapbox/maps` **natively supports** the Mapbox v11 `model` style layer through two components:
`Models` (register GLB/glTF assets by name) and `ModelLayer` (render them off a `ShapeSource`,
positioned per feature, styled with data-driven expressions). This is confirmed in source
(`src/components/ModelLayer.tsx`, `src/components/Models.tsx`, `ios/RNMBX/RNMBXModelLayer.swift`,
`RNMBXModels.swift`) and in the shipped example `example/src/examples/V10/SimpleModelLayer.js`.

### 3.1 Canonical usage (verified example, adapted)

```tsx
import { MapView, Camera, ShapeSource, Models, ModelLayer } from '@rnmapbox/maps';

// 1. Register local GLB assets by name. VALUE = require() of a .glb/.gltf (number asset id)
//    OR a string URL / absolute file path. require() IS the supported local-asset path.
const models = {
  tram_t3:   require('../../assets/models/tram_t3.glb'),
  tram_15t:  require('../../assets/models/tram_15t.glb'),
  // 'remote': 'https://cdn.example.com/tram.glb',   // string URL also allowed
};

// 2. A ShapeSource whose features carry per-tram properties (type, bearing, color, …)
const fleet /* GeoJSON.FeatureCollection */ = buildFleetFeatureCollection();

<MapView styleURL={Mapbox.StyleURL.Standard} style={{ flex: 1 }}>
  <Camera centerCoordinate={[14.4378, 50.0755]} zoomLevel={16} pitch={55} />
  <Models models={models} />
  <ShapeSource id="trams" shape={fleet}>
    <ModelLayer
      id="tram-models"
      style={{
        // modelId is DATA-DRIVEN: choose the GLB per feature by a property
        modelId: ['get', 'modelKey'],                    // e.g. 'tram_t3' | 'tram_15t'
        // rotate each tram to its heading. modelRotation = [x, y, zDegrees]
        modelRotation: [0, 0, ['get', 'bearing']],
        // scale to real-world size (tune per model export; example used [50,50,50])
        modelScale: ['literal', [8, 8, 8]],
        modelCastShadows: true,
        modelReceiveShadows: true,
        modelElevationReference: 'ground',               // 'sea' | 'ground' | 'hd-road-markup'
        modelColorMixIntensity: 0,
      }}
    />
  </ShapeSource>
</MapView>
```

### 3.2 `Models` prop shape (verified from `docs/Models.md` + source)

```ts
type Models = { [modelName: string]: string | number };
// number  -> require('...glb') asset id (Metro bundles the .glb; supported for LOCAL assets)
// string  -> file path or http(s)/mapbox:// URL
```

- Register **once** near the map root; keep the object stable (don't re-`require` on every render).
- `.glb` (binary glTF) and `.gltf` are both accepted. Prefer `.glb` (single file, smaller). Keep models
  low-poly (a tram is a box with detailing) — hundreds of instances share ONE registered model, so the
  cost is per-vertex × on-screen instances, not per-file.
- Metro must be told `.glb` is an asset. Add to `metro.config.js`:
  ```js
  const config = getDefaultConfig(__dirname);
  config.resolver.assetExts.push('glb', 'gltf');
  module.exports = config;
  ```

### 3.3 `ModelLayer` style props (from `src/components/ModelLayer.tsx`, style-spec 11.23.1)

All the interesting ones accept **Mapbox expressions** (data-driven), which is what makes one layer
render a whole heterogeneous fleet:

| Prop | Type | Data-driven inputs | Notes |
|---|---|---|---|
| `modelId` | string | zoom, **feature** | pick GLB per feature via `['get', …]` |
| `modelRotation` | `[x,y,z]` deg | feature, feature-state, zoom | z = heading; orient tram to bearing |
| `modelScale` | `[x,y,z]` | feature, feature-state, zoom | tune to model export units |
| `modelTranslation` | `[x,y,z]` m | feature, feature-state, zoom | nudge off ground / along track |
| `modelOpacity` | 0–1 | feature, feature-state, zoom | fade in/out per zoom |
| `modelColor` | color | feature, feature-state, measure-light, zoom | tint per route/line |
| `modelColorMixIntensity` | 0–1 | feature, feature-state, measure-light | how strongly `modelColor` tints |
| `modelEmissiveStrength` | 0–5 | feature, feature-state, measure-light | glow at night |
| `modelType` | `common-3d` \| `location-indicator` | — | keep `common-3d` |
| `modelCastShadows` / `modelReceiveShadows` | bool | — | realism; costs GPU |
| `modelElevationReference` | `sea`\|`ground`\|`hd-road-markup` | — | `ground` for trams |
| `modelRoughness`, `modelAmbientOcclusionIntensity`, `modelCutoffFadeRange`, `modelHeightBasedEmissiveStrengthMultiplier` | — | mostly zoom/feature | material tuning |

Props are passed via the single `style={{…}}` object (`ModelLayerStyleProps`); transitions accept
`{ duration, delay }`.

### 3.4 Gotchas for 3D models

- **Orientation:** glTF models often face +Z or +Y; you'll almost certainly need a constant offset baked
  into `modelRotation` (e.g. `[0,0, ['+', ['get','bearing'], 90]]`) so the tram faces its heading. Verify
  visually and bake the correction into the GLB export axis or the expression.
- **Scale is unit-dependent:** the example uses `modelScale: [50,50,50]` for a sport car; the right value
  depends on your GLB's export units (meters vs cm). Export in meters → scale near `[1,1,1]`. Calibrate
  against a real building.
- **Zoom-out fallback:** ModelLayer meshes are heavy and near-invisible at low zoom. Combine with
  `CircleLayer`/`SymbolLayer` on the same ShapeSource, toggled by zoom (see §5) — models only above
  ~zoom 15.
- **Not usable on web** (`react-native-web`); this is native-iOS-only. The map screen must be native.

**Alternatives (NOT needed, but for the record):** a three.js/expo-gl overlay synced to the camera is
far more work and won't depth-occlude against Standard buildings. A `SymbolLayer` with a 2D icon +
`icon-rotate` is the 2D fallback. Given ModelLayer is fully supported, use it.

---

## 4. High-frequency animation of hundreds of moving points

Two mechanisms exist; use them **together**.

### 4.1 Native `ShapeAnimator` — UI-thread, smooth, but per-geometry

Source: `src/shapeAnimators/*`, `ios/RNMBX/ShapeAnimators/*`. Exposed under the **experimental**
namespace:

```ts
import Mapbox from '@rnmapbox/maps';
const animator = new Mapbox.__experimental.MovePointShapeAnimator([lng, lat]); // start coord
// later, each time you get a new position:
animator.moveTo({ coordinate: [lng, lat], durationMs: 1200 });
// feed it straight into a ShapeSource as the shape:
<ShapeSource id="one-tram" shape={animator as any}>…</ShapeSource>
```

- The tween runs **natively on the UI thread** — no per-frame JS bridge traffic; buttery even when JS
  is busy. `ChangeLineOffsetsShapeAnimator` animates line offsets similarly (used by
  `example/src/examples/Animations/AnimatedLineOffsets.tsx`).
- **Limitation that decides architecture:** `MovePointShapeAnimator` holds **one point**. One
  animator ⇒ one ShapeSource ⇒ one feature. It does NOT animate a whole FeatureCollection. So it's
  ideal for **the single selected/followed tram**, not for 200–500 at once.

### 4.2 Fleet updates — JS interpolation + `ShapeSource` imperative update

For the whole fleet (~200–500 features) at 10–30 fps, keep **one** `ShapeSource` holding a
FeatureCollection and push new geometry each frame **imperatively** to avoid React reconciliation:

```tsx
const src = useRef<ShapeSource>(null);
// in a requestAnimationFrame / setInterval loop (throttled to ~15–20fps):
src.current?.setNativeProps({ shape: interpolatedFeatureCollection });
```

`ShapeSource.setNativeProps({ shape })` exists on the component (verified in `src/components/ShapeSource.tsx`,
line ~248) and updates the native source without a full re-render — the standard rnmapbox pattern for
live GeoJSON. Passing `shape` as a React prop also works but re-renders the tree; `setNativeProps` is
cheaper for high-frequency updates.

**What runs where:**
- Interpolation math (lerp/slerp position + bearing between server samples) runs in **JS**. Do it in a
  plain `requestAnimationFrame` loop or a Reanimated worklet; keep it O(n) and allocation-light (mutate
  a reused array, don't rebuild deep objects).
- The bridge cost is **one** serialized FeatureCollection per frame. That's the throttle target.
- Actual map rendering (layer draw, model instancing) is on the **native UI/GPU thread**.

**Best practice for 200–500 trams:**
1. Server gives positions every few seconds. Between samples, **interpolate in JS** along the route
   polyline (GTFS shape) so motion is smooth, not teleporting.
2. Run the interpolation loop at **15–20 fps** (not 60) — visually smooth for slow trams, ~⅓ the bridge
   traffic of 60fps. `requestAnimationFrame` + a time accumulator; skip frames when the app backgrounds.
3. Push via `setNativeProps({ shape })` to **one** ShapeSource feeding both the ModelLayer and the
   circle/symbol fallback layers.
4. Only render **on-screen** trams as 3D: keep the FeatureCollection full but let `ModelLayer` +
   `minZoomLevel`/`maxZoomLevel` and expressions cull; or pre-filter to viewport bbox in JS.
5. Reserve `MovePointShapeAnimator` for the single tram the user tapped/follows — its own ShapeSource
   with native UI-thread tweening, so the followed tram is perfectly smooth regardless of JS load.
6. Avoid `PointAnnotation`/`MarkerView` for the fleet — they are per-view and won't scale to hundreds.
   Layers (Circle/Symbol/Model on a ShapeSource) are the scalable path.

---

## 5. Zoom-dependent, data-driven rendering (Circle → Symbol → Model)

Put **multiple layers on the same ShapeSource** and let each own a zoom band. All use Mapbox
expressions; visibility/size transitions come from `step`/`interpolate` on `['zoom']`.

```tsx
<ShapeSource id="trams" ref={src} shape={fleet}>
  {/* Low zoom (10–13): tiny colored dots */}
  <CircleLayer
    id="tram-dots"
    maxZoomLevel={13.5}
    style={{
      circleRadius: ['interpolate', ['linear'], ['zoom'], 10, 2.5, 13, 5],
      circleColor: ['get', 'lineColor'],          // per-route color from feature props
      circleStrokeWidth: 1,
      circleStrokeColor: '#ffffff',
      circleOpacity: ['interpolate', ['linear'], ['zoom'], 13, 1, 13.5, 0], // fade out
    }}
  />

  {/* Mid zoom (13.5–15.5): line-number badge with text */}
  <SymbolLayer
    id="tram-badges"
    minZoomLevel={13.5}
    maxZoomLevel={15.5}
    style={{
      iconImage: 'tram-badge',                    // registered via <Images />
      iconSize: ['interpolate', ['linear'], ['zoom'], 13.5, 0.6, 15, 1],
      iconAllowOverlap: true,
      textField: ['get', 'lineNumber'],
      textSize: 12,
      textColor: '#ffffff',
      textHaloColor: ['get', 'lineColor'],
      textHaloWidth: 2,
      symbolSortKey: ['get', 'priority'],
    }}
  />

  {/* High zoom (15.5+): 3D model, see §3 */}
  <ModelLayer id="tram-models" minZoomLevel={15.5} style={{ /* … §3 */ }} />
</ShapeSource>
```

- **Zoom transitions:** use `interpolate`/`step` on `['zoom']` for `circleRadius`, `iconSize`,
  `*Opacity`. Overlap the fade of one layer with the fade-in of the next for a smooth handoff.
- **`minZoomLevel`/`maxZoomLevel`** on each layer are the hard cutoffs; opacity interpolation softens edges.
- **Register icons** with `<Images images={{ 'tram-badge': require('…png') }} />` (or `nativeAssetImages`)
  as a sibling of the layers, analogous to `<Models />` for GLBs.
- **Data-driven styling** reads feature `properties` via `['get','prop']`, feature-state via
  `['feature-state','prop']` (e.g. highlight a selected tram without rebuilding the FeatureCollection —
  use `MapView.setFeatureState` / source feature state).

### Taps / hit-testing
- Put `onPress` on the **`ShapeSource`** (or a layer); the event payload has `event.features` (array of
  hit GeoJSON features) plus `coordinates` and `point`. Use `event.features[0].properties.tramId`.
  ```tsx
  <ShapeSource id="trams" onPress={(e) => selectTram(e.features[0]?.properties?.tramId)}>
  ```
- Imperative queries on the `MapView` ref:
  `mapRef.queryRenderedFeaturesAtPoint([x,y], filterExpr?, ['tram-models','tram-dots'])` and
  `queryRenderedFeaturesInRect([top,left,bottom,right], filter?, layerIDs?)`.
  Note: tapping **ModelLayer** meshes for hit-testing is less reliable than tapping the flat
  Circle/Symbol layer — keep an invisible/low CircleLayer to catch taps across all zooms.

---

## 6. Camera API — follow a moving tram smoothly

### 6.1 Imperative follow (recommended for a moving target)

Drive the `Camera` via ref each time the followed tram's interpolated position updates:

```tsx
const cameraRef = useRef<Camera>(null);

function onTramTick(pos: [number, number], bearing: number) {
  cameraRef.current?.setCamera({
    centerCoordinate: pos,
    bearing,                    // rotate map to tram heading (optional)
    pitch: 55,
    zoomLevel: 16.5,
    animationDuration: 900,     // slightly LONGER than your tick interval for continuous glide
    animationMode: 'easeTo',    // 'easeTo' | 'linearTo' | 'flyTo' | 'moveTo' | 'none'
    padding: { paddingTop: 200, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 },
  });
}
```

- **Smoothness trick:** set `animationDuration` ≥ the interval between position updates and use
  `easeTo`/`linearTo`. Each new `setCamera` retargets mid-animation, producing a continuous glide
  instead of stutter. `linearTo` gives constant-velocity tracking (good for steady trams); `easeTo`
  is gentler. Avoid `flyTo` for continuous follow (it's the zoom-out-swoop; use it only for jumping to
  a tram initially).
- **`padding`** shifts the focal point — push the tram up when a bottom sheet covers the lower screen
  (`paddingBottom` = sheet height).

### 6.2 Declarative follow

`Camera` props also support declarative follow of the **user** puck:
`followUserLocation`, `followUserMode` (`UserTrackingMode`: `follow` / `followWithHeading` /
`followWithCourse`), `followZoomLevel`, `followPitch`, `followUserHeading`. This is for the *user's*
location, not an arbitrary feature — for a **tram** you own the coordinate, so use §6.1 `setCamera`.

### 6.3 Camera props / methods reference

- Declarative props: `centerCoordinate`, `zoomLevel`, `pitch`, `heading`, `bounds`, `padding`,
  `animationMode`, `animationDuration`, `defaultSettings`, `minZoomLevel`, `maxZoomLevel`,
  `followUserLocation`, `followUserMode`, `followZoomLevel`, `followPitch`, `followUserHeading`.
- Imperative (via ref): `setCamera(config)`, `flyTo(coords, duration?)`, `moveTo(coords, duration?)`,
  `zoomTo(zoom, duration?)`, `fitBounds(ne, sw, padding?, duration?)`.
- `setCamera` config keys: `centerCoordinate`, `bounds`, `heading`/`bearing`, `pitch`, `zoomLevel`,
  `padding`, `animationDuration`, `animationMode`.
- Set `defaultSettings` so the very first frame is already tilted (avoids a top-down flash before the
  first `setCamera`).

---

## 7. Reference snippets index

- Standard style + 3D config: §2.1 (`StyleImport existing config`).
- 3D model rendering: §3.1 (`Models` + `ModelLayer`, verified against `SimpleModelLayer.js`).
- Fleet high-freq update: §4.2 (`ShapeSource.setNativeProps({ shape })`).
- Single-tram native tween: §4.1 (`Mapbox.__experimental.MovePointShapeAnimator`).
- Zoom-banded layers + taps: §5.
- Follow camera: §6.1.

## 8. Open risks / things to validate on-device

- `RNMapboxMapsVersion` pin: `11.23.1` matches the vendored style-spec but confirm the CocoaPod version
  exists; if a pod resolve fails, fall back to the plugin default `11.20.1`.
- ModelLayer performance with 200–500 instanced GLBs at pitch 55 on real hardware is unverified — must
  profile; may need viewport culling + LOD (models only ≥ zoom 15.5, dots below).
- `.glb` require() bundling needs the `metro.config.js` `assetExts` addition (§3.2) — not automatic.
- `queryRenderedFeatures` reliability against ModelLayer meshes is uncertain — keep a transparent
  CircleLayer for taps.
- Standard style `standard` (GA) vs `standard-beta` (in the example) — use GA; verify `show3dObjects`
  and `lightPreset` config keys are honored by the pinned SDK version.
