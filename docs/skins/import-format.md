# Skin import and vehicle assignment

Settings → Tram skins opens a native sheet. Import a JSON package through Files,
preview its three-dimensional model, then enter the actual vehicle registration.
Assignments are local to the device and model-specific. A registration which
currently reports another model is rejected; an unavailable registration can be
saved, but rendering still requires the model to match. Reset restores standard
paint. The library is initially empty and no campaign is assigned automatically.

Use the [authoring tool](authoring.md) to export UV guides, paint a real campaign,
and derive compatible static/open/viewer GLBs. Package its output with:

```sh
node scripts/tram-models/package-skin.mjs AUTHOR_DIRECTORY metadata.json campaign.skin.json
```

The packager checks exact base triangles/mechanisms with the authoring verifier,
then applies the same import checks as the app. Metadata is:

```json
{"id":"campaign-vehicle","title":"Campaign name","modelId":"kt8d5","sourceUrl":"https://operator.example/reference","notes":"Reference date and author notes"}
```

The example URL is a schema placeholder, not evidence of a real advertisement.
Copy the resulting JSON to Files, iCloud Drive, AirDrop, or the app's shared
Documents folder. Only the package is imported; the app never follows asset URLs.
Native file sharing also makes existing app documents visible to their owner.

## Version1 package

`schemaVersion:1`, `id`, `title`, `modelId`, optional `sourceUrl` and `notes`, plus
`mapAssets` and `viewerAssets` objects. Every value is a base64 GLB. Map keys are
the model's exact section keys plus all authored `-open` keys; viewer keys are
the closed section keys. Viewer filenames in the author output use `-viewer.glb`,
which packaging removes from manifest keys. GLB PNG images and buffers must be
embedded. The app rejects external assets, required/optional GLB extensions,
separate skin rigs/animations, invalid indices/accessor ranges, non-finite
attributes, unused nodes/meshes and changed viewer mechanism metadata.
Validation work is also bounded to512accessors and1million float components
perasset, rejecting excess triangles during traversal. Materials
must remain opaque and single-sided; texture, image, sampler and material
references are checked before native loading.

Import checks world-space envelopes within5 cm of this build's base models.
The open envelope comes from the viewer's actual fully-open door transforms,
not the older static pocket approximation. Envelope checks are not an exact
mesh-equivalence proof; the companion packager performs that stronger triangle
comparison. Refresh compatibility after base geometry changes:

```sh
npx tsx --tsconfig lab/tsconfig.runtime.json scripts/testing/skin-compatibility.ts
```

Limits:4 MiB perGLB,32 MiB decoded package,12,000 triangles per whole closed/viewer
tram,2048×2048 perPNG. Decoded pixel budgets include a conservative full mip chain:
96 MiB map assets and64 MiB viewer assets perpackage. All assigned skins together
must fit96 MiB map texture allocation; unassigned skins are not registered with
Mapbox. Base models remain mounted; each assigned imported revision registers
a separate immutable native model group and versioned IDs, so reimporting a
campaign cannot silently keep its previous texture. Up to8 skins and96 MiB encoded GLB storage may be installed. The working
store has a384 MiB ceiling including older versions pending cold-start cleanup.
The viewer loads one model at a time, decodes PNGs through native image loading,
and disposes textures/files on close. NPOT textures use clamp/linear sampling
without mipmaps, avoiding Three's browser-canvas resize path.

Library saves use immutable index generations, retaining three recovery states.
A partial write can fall back to an earlier valid index. Cold-start cleanup
removes only directories unreferenced by those valid recovery states; if no
valid index exists, it leaves files intact. Deletion or replacement never erases
an asset before saving the new index.

The inferred second car in a coupled consist has no known registration in the
current feed. A livery assignment changes only the known leading vehicle;
changing an anonymous trailer would falsely imply its identity.

Native build35 iPad import, embedded-PNG viewer appearance, doors, assignment/reset
and same-ID reimport passed test07; inspected images are in
[the native skin evidence](../testing/results/skins-ipad-2026-09-06/README.md).
Build36 iPad also passed native Mapbox assignment/reset: the visible middle-section
edge changes blue and returns to red, with base outer sections preserved.
[Fresh build36 evidence](../testing/results/ipad-2026-09-06-build36/README.md)
distinguishes this overhead view from full-surface UV proof. Phone build36 also passed native import/assignment/reimport/reset and map tests.
The separate iPad rotation gate has not yet passed; system Home also remains
portrait after the same orientation request, so this is tracked independently. Build34 visual
evidence predates this feature and is not skin-rendering evidence.
