# Model previews

These are review renders of the current Blender fleet. Source choices and
measurement confidence are documented in [model references](../model-references/README.md);
runtime contracts are in [3D model decisions](../decisions/3d-models.md).

Install the repository's locked development dependencies with `npm ci` before
running the pipeline. glTF Transform and the Khronos validator are declared
development tools; no temporary global install or mobile runtime decoder is
required. Blender must be installed locally (`BLENDER_BIN` may override its path).

```sh
node scripts/generate-tram-models.mjs --render
node scripts/generate-tram-models.mjs 15t --render
node scripts/generate-tram-models.mjs --validate-only
```

Each completed `--render` run writes:

- `<id>-front.png`, `-side.png`, `-rear.png`, `-detail.png`: transparent orthographic
  review views of the assembled vehicle.
- `<id>-head-on.png`, `-tail-on.png`: direct cab views for glass topology, lamp
  layout, surface intersections and front/rear distinctions.
- `assets/images/trams/<id>.png`: the app's current list thumbnail.
- `assets/model-source/<id>.blend`: assembled, editable section and movable-part
  nodes, materials, review lighting and camera.

`<id>.png` is a six-view contact sheet assembled from those six review PNGs **after
all renders finish**. It must not retain older views after a partial regeneration.
Contact sheets are documentation assets, not app model textures. Changing a sheet
cannot fix the underlying geometry; fix the generator, render again, then replace
its sheet. The standalone PNGs retain the original resolution for detailed QA.

GLBs use metres, Y-up and front toward −Z. Section lengths describe rigid bodies;
bellows halves and actual T3 couplers extend beyond them. The viewer and map share
the same physical section spacing. Raised pantographs exceed body-height metadata.

The fleet contains **34 static map GLBs + 19 viewer GLBs**. The latter retain
named door/indicator parts and extras for local viewer animation; the static map
files merge the parts and use open/closed asset swaps. There are no baked glTF
animation clips. File budgets are 250 KiB for T3-family assets and 200 KiB per
articulated section; the closed whole-tram ceiling remains 12,000 triangles.

`build-report.json` records Blender exports. `validation.json` records 34 static-map results, including actual serialized
sizes, triangles and Khronos messages. `viewer-validation.json` separately records
19 viewer results, assembled world bounds and mechanism metadata. Together the
completed reports cover all 53 tram assets with zero Khronos errors/warnings.
Check both files and the run scope after regeneration; one model or the static
report alone is not complete fleet verification. Never describe an earlier
validation or installation as proof of subsequently regenerated assets.

Visual checks should cover front and rear silhouette, pane boundaries, roof joins,
lamps, door count/placement, bogies and articulation; compare the correct vehicle
variant with its references. The earlier Three.js tool
`scripts/render-model.mjs` can provide an independent renderer check. Neither
renderer replaces simulator gesture/mechanism tests and a current on-device build.
The user waived Telegram reporting; final review takes place in the application.
