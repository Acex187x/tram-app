# Tram Spotter 🚋

Real-time Prague tram spotting for iOS. Every tram in the city glides across a 3D Mapbox
map — smoothly interpolated between Golemio API updates with a physics model, rendered as
detailed 3D models of the actual rolling stock, wrapped in an iOS 26 Liquid Glass UI.

## What it does

- **Live fleet on a 3D map** — all ~180–450 active trams, polled from the
  [Golemio](https://golemio.cz) `vehiclepositions` feed every 5 s and simulated at 15 fps
  between updates.
- **Physics interpolation** — trams accelerate on straights, brake before curves
  (curvature-derived speed limits), dwell at stops (GTFS dwell times), hold at termini,
  slow down in the city center during the day, and rubber-band toward fresh AVL
  observations without ever jumping backwards.
- **Trams ride exactly on their tracks** — positions are distance-along-shape on GTFS
  route geometries; articulated sections and coupled Tatra pairs bend correctly through
  curves (each body section is placed and rotated independently).
- **4 zoom modes** — dots → line-number badges → oversized 3D models → real-scale 3D
  models. Models are procedurally authored GLBs of the real Prague fleet (Tatra T3,
  T3R.P, T3R.PLF, KT8D5.RN2P, Škoda 14T, 15T ForCity Alfa, 52T ForCity Plus), matched to
  each vehicle by its registration number.
- **Feature complete** — tram detail sheet (live speed, delay, next-stop ETA, upcoming
  stops, model fun facts), camera follow mode, line sheets with live tram positions,
  search (lines / registrations / stops), favorites, a journey planner over the live tram
  network, and settings (map light presets, route-line toggle).

## Stack

Expo SDK 57 · React Native 0.86 (new architecture) · expo-router · @rnmapbox/maps 10.3
(Mapbox iOS 11, Standard 3D style) · @tanstack/react-query · zustand · @gltf-transform
(model generation) · jest (171 unit tests).

See `docs/architecture.md` for the full design, `docs/research/` for the API/fleet
research the app is built on, and `docs/model-previews/` for renders of every 3D model.

## Development

```bash
npm install
cp .env.example .env       # EXPO_PUBLIC_MAPBOX_KEY, EXPO_PUBLIC_GOLEMIO_KEY, EXPO_PUBLIC_GOLEMIO_ENDPOINT
npx expo prebuild --platform ios
npx expo run:ios           # dev client on the iOS simulator
npm test                   # engine/data/planner unit tests
node scripts/generate-tram-models.mjs         # regenerate 3D models
node scripts/render-model.mjs assets/models/15t-*.glb out.png  # preview a model
```

## Release build

```bash
eas build -p ios --profile production   # first run interactively (Apple credentials)
```

Data: [Golemio — Prague data platform](https://golemio.cz) · [PID open data](https://pid.cz/o-systemu/opendata/) · Maps: [Mapbox](https://www.mapbox.com).
iOS only.
