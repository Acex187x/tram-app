# Vehicle liveries

A livery belongs to a physical registration and one compatible tram model. It
must not recolor every vehicle of that type. Imported packages start unassigned;
author a real advertisement from dated references before assigning it to a car.
A coupled trailer inferred by the app has no known registration, so an assignment
to the leading car does not silently apply to that trailer.

## Paint an existing model

The authoring helper preserves the bundled geometry and all viewer door and
indicator nodes. It prepares a separate authoring copy; the base fleet remains
texture-free and keeps its map budgets.

```sh
node scripts/tram-models/author-skin.mjs template kt8d5 /tmp/my-kt8-livery
# Paint /tmp/my-kt8-livery/kt8d5-a.png, -b.png and -c.png.
node scripts/tram-models/author-skin.mjs build kt8d5 /tmp/my-kt8-livery
node scripts/tram-models/verify-skin-geometry.mjs /tmp/my-kt8-livery
# Create metadata.json with id, title, modelId and dated sourceUrl/notes.
node scripts/tram-models/package-skin.mjs /tmp/my-kt8-livery metadata.json /tmp/my-kt8.skin.json
```

Each section has a transparent **1536×1024 PNG** and a separate SVG guide.
The helper exports 768×512 atlases to keep a full multi-section wrap within the
mobile texture budget; retain the larger source canvas for later revisions.
Keep the guide on a non-exporting layer in the image editor. The six 512-pixel
cells run right / left / front across the first row, rear / roof / underside
across the second. Coordinates refer to the tram's direction, not the camera.
The canvas is shared by all paint colors within that section: transparent areas
retain the original paint, opaque areas replace it, and translucent ink blends
over it. Do not resize, crop or rotate the canvas after using the guide.

The projection uses the original closed-door coordinates, then bakes static
open-door variants from those same viewer mechanisms. An advertisement therefore
moves with its door instead of sliding to another part of the texture. All
outputs use opaque, embedded PNG textures and contain no external resources.
Only red, cream, white and silver body paint receives the overlay. Windows,
destination displays, black door frames, lamps, wheels, bellows and collectors
remain protected. Perforated advertising over glazing requires a separately
authored, validated package; this first paint helper does not fake transparent
windows or draw ads over lights.

`map/` contains canonical `<section>.glb` and `<section>-open.glb` files.
`viewer/` contains `<section>-viewer.glb` files with original movable-node
metadata. The helper validates every output with Khronos glTF Validator and
rejects an asset over 4 MiB. Import also enforces package and geometry budgets.
Inspect the result in the app from both sides with doors open and closed before
assigning a registration. A valid file is not evidence of visual fidelity.

## Package contract

Version 1 is a self-contained JSON object with `schemaVersion`, a stable slug
`id`, human-readable `title`, `modelId`, optional `sourceUrl` and `notes`, and
`mapAssets` / `viewerAssets` maps. Values are base64-encoded GLBs, not URLs or
filesystem paths. Map keys include every required closed and open section;
viewer keys are section keys without the `-viewer` filename suffix. Keep dated
reference and campaign details in the metadata. Do not invent a live vehicle
assignment from a generic advertisement photograph.

Open Settings → Tram skins and import the resulting JSON through Files.
Preview it, then assign a compatible vehicle registration. Assignments remain
local to this installation; resetting an assignment restores the base paint.
No real advertisement or advertising-vehicle roster is bundled yet.

The geometry verifier compares every closed triangle against the bundled viewer
with a 10-micrometre numerical tolerance, preserves mechanism metadata exactly,
and compares each open map asset against the transformed viewer. This tolerance
checks file conversion only; it is not a claim of real-world modelling accuracy.
The authoring pipeline has been exercised for all seven tram types. A separate
blue/yellow UV-test skin is a test fixture, not a real vehicle advertisement.
