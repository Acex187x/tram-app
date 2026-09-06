# Decision record: reference-based Blender tram pipeline

Current implementation: September 2026. This replaces the former pure-Node
per-tram builders. The earlier `d76eaf2` / `d415c3c` and `acda059` procedural
iterations remain in Git history, but their geometry, dimensions and generation
instructions are not the current contract.

## Authoring and evidence

The fleet is generated from scratch by
[scripts/tram-models/blender_fleet.py](../../scripts/tram-models/blender_fleet.py).
Blender provides an editable source scene and deterministic geometry generation;
no downloaded tram mesh or old tram builder is imported. The saved
`assets/model-source/<id>.blend` files retain the assembled sections, named door
and indicator parts, materials, review lighting and camera. Change parameters in
the generator to make a reproducible revision; an isolated manual `.blend` edit
is not reproduced by the next generation run.

[Model references](../model-references/README.md) distinguish printed dimensions,
scale-derived rigid-shell/bellows measurements, and photo-based detail choices.
The physical section fits now preserve the published body totals:

| Model | Rigid sections, m | Gaps, m | Total body, m |
|---|---|---|---|
| T3 / RP | 14 | — | 14 |
| PLF | 15.1 | — | 15.1 |
| KT8 | 10.9 / 6.5 / 10.9 | 2 × 1 | 30.3 |
| 14T | 6.265 / 5.48 / 3.38 / 5.48 / 6.265 | 4 × 0.845 | 30.25 |
| 15T | 10.4 / 8.6 / 10.4 | 2 × 1 | 31.4 |
| 52T | 9 / 3.5 / 3.79 / 3.5 / 9 | 4 × 0.8 | 31.99 |

These section boundaries are modelling fits, not certified CAD dimensions. Source
pages, pixel calibration, door centers, bogie centers and uncertainty live in
[orthographic-measurements.json](../model-references/technical/orthographic-measurements.json).
The original drawings reproduced in later documents are identified individually;
research proposals and non-Prague liveries in those documents are not references.

Front/rear differences are authored per family: all T3 variants have a broad
central front pane plus two corner panes; PLF has distinct low windows, rear
lamps and rear wiper. KT8 has a driving cab at **both** ends. The one-direction
Škodas have route-only rear displays and appropriate rear fittings. Similar
front/rear shell profiles are retained where the technical drawings support
that similarity. A new generic rear shape would not improve accuracy.

## Coordinates and placement

- GLB coordinates are **metres, Y-up, front toward −Z**, with rail level at Y=0.
  Every section origin is at its rigid body's center. Mapbox uses the section's
  route bearing; do not add another 180-degree heading correction.
- `MODEL_SPECS` in `src/lib/fleet/modelSpecs.ts` describes rigid body dimensions.
  The renderer and viewer assemble the same lengths and `jointGapM` values;
  accessory bounding boxes must not determine spacing.
- Half of each articulation bellows belongs to each adjacent asset and extends
  outside its rigid-body bounds. Shared running gear is likewise divided at
  the relevant articulation. KT8 shared bogies are at 11.4/18.9 m; 15T at
  10.9/20.5 m from the front.
- The 15T's end-bogie **wheel-pair center is 1.85 m** from its end, whereas its
  eccentric body pivot is at 2.2 m. Confusing these produces wheels in front of
  the nose. The outer wheel axes are 0.9/2.8 m from the front.
- T3 couplers visibly project beyond the body: combined front/rear projection
  is 1.104 m for ordinary T3/RP and 1.100 m for PLF. Their body metadata stays
  14/15.1 m. The pair heuristic in `registry.ts` and placement in
  `featureBuilder.ts` use 15.104/16.2 m center spacing. Mixed RP/PLF consists
  remain a limitation of the available same-type trailer heuristic.
- Body-height metadata excludes a raised pantograph. Complete GLB bounds include
  roof equipment, collector and other attachments.
- KT8 also has projecting couplers: 0.470 m per end on the original type drawing,
  31.240 m over couplers and a 0.525 m axis. Its rigid-body metadata remains
  30.300 m; the end-section validation includes each asymmetric attachment.

## Static map assets and movable viewer assets

There are **53 tram GLBs**, separate from the stop totem:

1. **34 map assets:** 19 closed body sections plus 15 open-door variants.
   `MODEL_ASSETS` contains only these. Door/indicator part geometry is merged
   into the section mesh, keeping the established map batching. The map swaps
   `openModelKey` using the renderer's near-stop/low-speed door predicate; no
   skeletal or per-leaf animation runs in Mapbox.
2. **19 viewer assets:** one `<section>-viewer.glb` per closed section, registered
   separately in `src/components/model/viewerAssets.ts`. Named child nodes carry
   door translation/rotation and indicator-side extras. They have no baked glTF
   animation clips. `mechanisms.ts` and `mechanismMath.ts` apply local transforms
   and lamp material changes for the viewer's explicit demonstration controls.

`14t-a` (driver access), `14t-c` (central motor body), and `52t-b/d` (bogie bodies)
have no passenger open-door asset. The rear 14T passenger door is single width;
the other four passenger openings are double width. KT8 has five doors per side;
its map open variant and viewer demonstration operate on the travel-right side.

Viewer mechanism state is an illustration, not live door or indicator telemetry.
Door travel takes 1.6 seconds for the full range and reverses from the current
pose. Indicators use an 800 ms cycle. Reduce Motion snaps the doors to their
requested pose and holds the selected indicator steadily lit. This local viewer
work does not change the tracking engine or add a map subscription.

The GL viewport follows the measured `GLView.onLayout` size in physical pixels.
Expo GL 57.0.1 initializes `drawingBufferWidth/Height` once in
`EXWebGLRenderer.cpp`; `GLView.swift` subsequently resizes native buffers without
updating those JavaScript properties. Reading them on each frame therefore does
not detect a resize. Build32 native screenshots exposed the result: the taller
ready-state control card cropped cab roofs and destination boards. Layout now
resizes the renderer, simulator render target and camera together. Aspect changes
preserve the current relative zoom, including iPad rotation/Stage Manager.

## Material and geometry budgets

Materials use opaque, single-sided metallic/roughness factors with no image
textures. Outward triangle winding matters; broad glass and painted cab patches
must follow the actual triangulated shell so they do not disappear into it.
Mirrors, wipers, number labels and couplers also need to follow their local
surface, rather than cutting a curved shell with a straight chord.

Clipped cab patches inherit the parent loft's interpolated normals. Independently
recomputed patch normals previously produced stripes and triangular shading
defects even where the positions followed the hull. The collapsed roof crest
uses an explicit upward normal; the exporter rejects smooth faces whose corner
normals point inside the surface. The Blender subprocess uses
`--python-exit-code 1`, so a failed generator cannot validate yesterday's GLBs
and report success. Geometry validation remains separate from visual fidelity.

| Constraint | Current contract |
|---|---|
| Whole closed tram | ≤ 12,000 triangles across all its sections |
| Individual section | ≤ 12,000 triangles |
| T3-family asset size | ≤ 250 KiB |
| Articulated section size | ≤ 200 KiB |
| Textures / transparent or double-sided materials | None |
| Units / orientation | Metres / Y-up / front −Z |
| Section-length validation | Body + explicit bellows/coupler attachments, not body alone |

[generate-tram-models.mjs](../../scripts/generate-tram-models.mjs) reads back the
exported GLBs, checks real bounds and geometry, and invokes the Khronos validator.
A completed subset validation cannot certify the whole fleet. Complete release
verification must include all 34 static and 19 viewer files, including viewer
part metadata. The completed reports are split between
[validation.json](../model-previews/validation.json) (34 static assets) and
[viewer-validation.json](../model-previews/viewer-validation.json) (19 viewer
assets); check both counts and their timestamps, not an earlier console log.
No Draco or meshopt decoder is introduced by this authoring change.

## Regeneration and visual verification

```sh
node scripts/generate-tram-models.mjs --render
node scripts/generate-tram-models.mjs 15t --render
node scripts/generate-tram-models.mjs --validate-only
```

Blender 5.2.1 is the authoring runtime; `BLENDER_BIN` overrides the executable.
`--render` writes orthographic front/side/rear/detail/head-on/tail-on images,
app thumbnails and editable `.blend` files. Contact sheets are assembled from
those current PNGs only after the render run finishes. See the
[preview workflow](../model-previews/README.md). Node glTF validation tools are
build tooling, not mobile runtime dependencies.

Compare both noses and tails with the representative car's references. Technical
validation does not establish visual fidelity. Blender images likewise do not
replace simulator tests of selection, zoom, rotation, controls, reduced motion,
backgrounding and navigation, or a current build installed on the user's devices.
Record current delivery evidence after regeneration; earlier installations do
not contain newly exported files.

## Registry and stop totem

`src/lib/fleet/registry.ts` remains the authority for registration-number mapping
and the coupled-pair heuristic. `modelSpecs.ts` owns the section and map-asset
registry; `featureBuilder.ts` owns placement and static door-state swaps. Avoid
copying registry ranges into this document, where they would become stale.

The separate PID stop-totem builder remains
`scripts/tram-models/stop-totem.mjs`, using the remaining Node geometry library.
Its asset is registered separately as `STOP_TOTEM_ASSET`; it is not one of the
53 tram GLBs. `scripts/render-model.mjs` remains an optional Three.js GLB
inspection tool, not the fleet's authoring pipeline.
