# Programmatic 3D Tram GLB Authoring (Node.js) for Mapbox Model Layers

Research date: 2026-07-11. Target: Expo SDK 57 iOS app, RN 0.86, new architecture,
`@rnmapbox/maps` native Mapbox Maps SDK for iOS (NOT mapbox-gl-js web). Goal: author
~7 detailed tram-type models (× sections) from scratch in a Node script, no Blender, no
downloaded meshes.

---

## TL;DR / Decision

- **Use `@gltf-transform/core` (v4.4.1)** as the authoring engine. It is a pure-Node,
  no-DOM, no-native-deps library with a clean factory API and first-class GLB writing via
  `NodeIO.writeBinary()`. It is the recommended path.
- **Do NOT use three.js `GLTFExporter` in Node** unless forced. `GLTFExporter` targets the
  browser and needs `Blob`/`FileReader`/`TextEncoder` DOM polyfills; it works only with a
  shim (`vblob`) or the `node-three-gltf` wrapper. More moving parts, larger footprint,
  worse control over accessor packing/file size. gltf-transform is strictly better for
  *authoring from primitives*.
- **Build geometry from parametric boxes/extrusions in JS**, assign **PBR
  metallic-roughness materials** (one per visual material: body, glass, roof-gray, black
  trim, emissive headlight). This beats per-vertex COLOR_0 for file size and gives you the
  glass/emissive looks the model layer respects.
- A minimal two-box tram GLB built with the code below is **3.07 KB** and passes the glTF
  validator with **0 errors / 0 warnings**. A fully detailed tram (body bevels, windows,
  doors, pantograph, bogies, wheels) stays **well under 300 KB** uncompressed as long as
  you share materials and don't over-tessellate cylinders (~12–16 sides).

---

## 1. Versions (verified via `npm view`, mid-2026)

| Package | Version | Notes |
|---|---|---|
| `@gltf-transform/core` | **4.4.1** (latest) | ESM. Document API + NodeIO. |
| `@gltf-transform/extensions` | **4.4.1** | KHR_materials_* extensions. |
| `@gltf-transform/functions` | **4.4.1** | `weld`, `dedup`, `prune`, `flatten`, `join`, `quantize`, `draco`, `meshopt`. |
| `gltf-validator` | **2.0.0-dev.3.10** (latest/only current) | Khronos validator, `validateBytes(Uint8Array)`. |
| `three` | 0.185.1 | Only if you go the exporter route (not recommended). |
| `@rnmapbox/maps` | **10.3.2** (latest) | Has `Models`, `ModelLayer` components. Not yet in this repo's package.json — must be added. |
| node | 24.8.0 (repo) | ESM works out of the box. |

Install (dev-only tooling, keep in a `tools/`/`scripts/` workspace or root devDeps):

```bash
npm i -D @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions gltf-validator
```

gltf-transform is **ESM-only**. Use `.mjs` files or `"type":"module"`. `require()` of the
package subpath fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` — import from the package root:
`import { Document, NodeIO } from '@gltf-transform/core';`.

---

## 2. gltf-transform Document API — the pieces you need

The Document is an in-memory graph. Factory methods (`doc.createX()`) return objects with
chainable setters. The shape of a mesh:

```
Scene → Node (translation/rotation/scale) → Mesh → Primitive → { Accessor(POSITION),
        Accessor(NORMAL), Accessor(indices), Material }
Accessors reference a Buffer (the binary blob that becomes the GLB BIN chunk).
```

Key calls:

- `doc.createBuffer()` — one shared buffer for the whole file is fine (and smallest).
- `doc.createAccessor().setType('VEC3'|'VEC2'|'SCALAR').setArray(TypedArray).setBuffer(buf)`
  - POSITION/NORMAL → `Float32Array`, type `VEC3`.
  - COLOR_0 → `Float32Array`/`Uint8Array` normalized, type `VEC3`/`VEC4`.
  - indices → `Uint16Array` (SCALAR) if < 65536 verts, else `Uint32Array`.
- `doc.createPrimitive().setAttribute('POSITION', acc).setAttribute('NORMAL', acc).setIndices(acc).setMaterial(mat)`
- `doc.createMesh(name).addPrimitive(prim)` — a mesh may hold several primitives (each with
  its own material). Grouping all opaque body faces into one primitive and glass into
  another is the efficient layout.
- `doc.createMaterial(name)` PBR metallic-roughness setters:
  - `.setBaseColorFactor([r,g,b,a])` (linear 0..1)
  - `.setMetallicFactor(0..1)`, `.setRoughnessFactor(0..1)`
  - `.setEmissiveFactor([r,g,b])`
  - `.setAlphaMode('OPAQUE'|'BLEND'|'MASK')` + `.setAlphaCutoff(x)`
  - `.setDoubleSided(bool)`
- `doc.createNode(name).setMesh(mesh).setTranslation([x,y,z]).setRotation(quat).setScale([x,y,z])`
- `doc.createScene(name).addChild(node)`
- Write GLB: `const glb = await new NodeIO().writeBinary(doc);` → `Uint8Array`.
  Register extensions on the IO if you use any: `new NodeIO().registerExtensions([...])`.

### KHR_materials_* extensions (from `@gltf-transform/extensions`)

- **`KHRMaterialsEmissiveStrength`** — HDR emissive (headlights/tail-lights glow above 1.0).
  ```js
  const emissiveStrength = doc.createExtension(KHRMaterialsEmissiveStrength);
  mat.setEmissiveFactor([1, 0.95, 0.7]);
  mat.setExtension('KHR_materials_emissive_strength',
    emissiveStrength.createEmissiveStrength().setEmissiveStrength(3));
  ```
  ⚠️ See §4: Mapbox's model layer clamps/controls emissive via its own
  `model-emissive-strength` paint property (0–5, default **0**). The GLB emissive factor is
  the *color/mask*; the layer property is the *global multiplier*. Set the layer property
  > 0 or headlights will not glow regardless of the GLB.
- **`KHRMaterialsSpecular`**, **`KHRMaterialsIor`** — tune glass reflectance. Usually
  unnecessary; a dark low-roughness base color reads as glass. Every extension adds bytes
  and a risk the native renderer ignores it — prefer plain metallic-roughness.
- Skip `KHR_materials_transmission` (real refractive glass) — Mapbox model layer does not
  render it; use a dark semi-opaque `BLEND` material or just opaque near-black glass.

---

## 3. Minimal, VALIDATED working sample (two-box GLB)

This exact script was run in Node 24.8.0. Output: **`GLB bytes: 3072`**, validator
**`numErrors: 0 numWarnings: 0`**. `build.mjs`:

```js
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { validateBytes } from 'gltf-validator';
import { writeFileSync } from 'node:fs';

// box centered at origin → {p: Float32Array positions, n: normals, idx: Uint16Array}
function box(sx, sy, sz) {
  const hx = sx/2, hy = sy/2, hz = sz/2, p = [], n = [], idx = [];
  const faces = [
    { nrm:[0,0,1],  v:[[-hx,-hy,hz],[hx,-hy,hz],[hx,hy,hz],[-hx,hy,hz]] },
    { nrm:[0,0,-1], v:[[hx,-hy,-hz],[-hx,-hy,-hz],[-hx,hy,-hz],[hx,hy,-hz]] },
    { nrm:[1,0,0],  v:[[hx,-hy,hz],[hx,-hy,-hz],[hx,hy,-hz],[hx,hy,hz]] },
    { nrm:[-1,0,0], v:[[-hx,-hy,-hz],[-hx,-hy,hz],[-hx,hy,hz],[-hx,hy,-hz]] },
    { nrm:[0,1,0],  v:[[-hx,hy,hz],[hx,hy,hz],[hx,hy,-hz],[-hx,hy,-hz]] },
    { nrm:[0,-1,0], v:[[-hx,-hy,-hz],[hx,-hy,-hz],[hx,-hy,hz],[-hx,-hy,hz]] },
  ];
  faces.forEach((f, fi) => {
    const b = fi*4;
    f.v.forEach(v => { p.push(...v); n.push(...f.nrm); });
    idx.push(b,b+1,b+2, b,b+2,b+3);
  });
  return { p:new Float32Array(p), n:new Float32Array(n), idx:new Uint16Array(idx) };
}

const doc = new Document();
const emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength);
const buffer = doc.createBuffer();
const scene = doc.createScene('tram');

function addMesh(name, geo, mat, translation) {
  const pos = doc.createAccessor().setType('VEC3').setArray(geo.p).setBuffer(buffer);
  const nor = doc.createAccessor().setType('VEC3').setArray(geo.n).setBuffer(buffer);
  const ind = doc.createAccessor().setType('SCALAR').setArray(geo.idx).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', pos).setAttribute('NORMAL', nor)
    .setIndices(ind).setMaterial(mat);
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim))
    .setTranslation(translation);
  scene.addChild(node);
}

const bodyMat = doc.createMaterial('body')
  .setBaseColorFactor([0.78, 0.12, 0.12, 1]).setMetallicFactor(0.1).setRoughnessFactor(0.6);
const lightMat = doc.createMaterial('headlight')
  .setBaseColorFactor([1, 1, 0.9, 1]).setEmissiveFactor([1, 0.95, 0.7]);
lightMat.setExtension('KHR_materials_emissive_strength',
  emissiveExt.createEmissiveStrength().setEmissiveStrength(3));

// CONVENTION: X = length, Y = up, Z = width (see §4)
addMesh('carbody', box(15, 3, 2.5), bodyMat, [0, 1.5, 0]);
addMesh('lamp',    box(0.3, 0.4, 0.4), lightMat, [7.5, 1.2, 0]);

const glb = await new NodeIO().registerExtensions([KHRMaterialsEmissiveStrength])
  .writeBinary(doc);
writeFileSync('tram.glb', glb);
console.log('GLB bytes:', glb.byteLength);

const report = await validateBytes(new Uint8Array(glb));
console.log('numErrors:', report.issues.numErrors, 'numWarnings:', report.issues.numWarnings);
```

Run: `node build.mjs`. `gltf-validator`'s `validateBytes` returns a report object; assert
`report.issues.numErrors === 0` in your build pipeline.

---

## 4. Coordinate system, units, and orientation for the Mapbox model layer

**This is the highest-risk area — details are under-documented and partly empirical.**

- **Units = meters.** `model-translation` is documented as meters (`[longitudinal,
  latitudinal, altitude]`). Author real dimensions: a Prague tram is ~15–32 m long, ~2.46 m
  wide, ~3.0–3.6 m tall. `model-scale` defaults to `[1,1,1]` — if you author in meters you
  do NOT need the huge `modelScale:[50,50,50]` seen in demo apps (those demos ship
  centimeter/unit-scaled models). Author in meters → keep scale ~1.
- **Up axis = glTF standard Y-up.** glTF 2.0 mandates +Y up, and the Mapbox model layer
  keeps the model's Y as vertical (altitude). Author with **Y = up**.
- **Ground plane = X/Z.** Put the tram's **length along one horizontal axis** and width
  along the other. Recommended: **length along +X, width along Z, up along Y** (as in the
  sample).
- **Heading via `model-rotation` Z component.** `model-rotation` is `[x, y, z]` in
  **degrees** (default `[0,0,0]`). The iOS SDK example rotates the car with
  `.modelRotation(x:0, y:0, z:90)` — i.e. the **z** euler term spins the model in the
  ground plane about the vertical axis. This is exactly what you use to point a tram along
  its direction of travel. Mapbox bearing is degrees **clockwise from true north**; the
  model-rotation z sign/zero-offset relative to north must be **calibrated empirically once**
  (render a tram pointing a known compass direction, read back). Plan for a per-project
  constant like `modelRotation = [0, 0, headingDeg + HEADING_OFFSET]`.
- **Right-handed, CCW winding, outward normals.** glTF front faces are CCW. The `box()`
  helper above already emits outward normals + CCW winding (validator-clean). Keep
  `setDoubleSided(false)` for perf; only glass/thin panels may need double-sided.
- **Model origin.** Place the model origin at the tram's **footprint center on the ground
  (Y=0 at rail level)** so `model-translation` altitude and rotation behave predictably.
  In the sample the body is lifted so its bottom sits near Y≈0.

### Mapbox `model` layer paint/layout properties (verified against style spec)

| Property | Type / range | Default | Meaning |
|---|---|---|---|
| `model-id` (layout) | string | `""` | Key into `Models` registry, or a URL. |
| `model-rotation` | `[x,y,z]` **degrees** | `[0,0,0]` | Euler; z = ground-plane heading. |
| `model-scale` | `[x,y,z]` | `[1,1,1]` | Multiplier on authored size. |
| `model-translation` | `[lng,lat,alt]` **meters** | `[0,0,0]` | Positional offset. |
| `model-color` | color | `#ffffff` | Tint. |
| `model-color-mix-intensity` | 0–1 | **0** | How much tint replaces model color. Keep 0 to preserve authored PBR colors. |
| `model-opacity` | 0–1 | 1 | |
| `model-emissive-strength` | 0–5 | **0** | Global emissive multiplier. **Must be > 0** for headlight glow to appear. |
| `model-roughness` | 0–1 | 1 | Overrides/pushes material roughness. |
| `model-cast-shadows` | bool | true | |
| `model-receive-shadows` | bool | true | |
| `model-ambient-occlusion-intensity` | 0–1 | 1 | Applies if AO present. |

rnmapbox `ModelLayer` prop names are camelCased: `modelId`, `modelScale`, `modelRotation`,
`modelTranslation`, `modelColor`, `modelOpacity`, `modelEmissiveStrength`, etc.

### Lighting / PBR behavior

- Model layer uses **metallic-roughness PBR**. Supported maps: base color, normal,
  metallic-roughness, occlusion. (We use factors only, no textures — smaller files.)
- Lighting comes from the **style's `light`/`lights` (ambient + directional)**, plus the 3D
  lighting model of Mapbox Standard. There is no per-model light. Emissive is the only way
  to make a surface self-lit (headlights, destination signs) and requires
  `model-emissive-strength > 0`.
- Transparency: "opaque, alpha-blended, alpha-masked" supported. Dark BLEND glass works;
  true refraction/transmission does not.

---

## 5. Detailed multi-part tram — modeling recipe

Build these as **separate primitives sharing a small set of materials**, all merged under
as few meshes/nodes as practical (see §6 multi-mesh caveat):

- **Body**: box or lofted extrusion of the cross-section profile. "Beveled edges" = author
  the cross-section as an N-gon (e.g. 8–12 pt rounded rectangle) and extrude along length,
  or add small 45° chamfer strips at the top edges. Chamfers cost few tris and read well.
- **Windows**: inset quads on the side, slightly recessed (translate inward ~2–3 cm), using
  a dark low-roughness material (`baseColor ≈ [0.02,0.03,0.04,1]`, roughness ~0.1,
  metallic 0). Optionally BLEND with alpha ~0.6 for tinted glass.
- **Doors**: separate slightly-inset panels with a distinct trim material and thin recess
  lines (gap geometry), so doors are visually distinct even without animation.
- **Roof**: gray box slab; add AC/resistor boxes as small boxes.
- **Pantograph**: thin boxes/cylinders — two diagonal arms (thin long boxes rotated) + a
  horizontal collector bar (thin box) + base insulators (short cylinders). ~12-sided
  cylinders. Dark metal material (metallic ~0.9, roughness ~0.4).
- **Bogies/underframe**: a dark box under the body.
- **Wheels**: cylinders (radius ~0.35 m) with ~16 sides, near-black material, placed at
  bogie positions (mostly hidden but add silhouette).
- **Headlights**: small boxes with the emissive material (front white, rear red).

Provide a `cylinder(radius, height, segments, axis)` helper alongside `box()`. Keep total
triangle count modest (a rich tram ≈ 2k–8k tris) → tens of KB.

### Per-vertex color vs materials

- **Use materials, not COLOR_0**, for the primary look. A handful of shared materials
  (body, glass, gray, black, emissive-white, emissive-red) is tiny and lets the Mapbox
  layer tint/relight correctly. COLOR_0 forces every vertex to carry RGB(A) (bloats the
  buffer) and multiplies base color per-vertex (harder to control, and some renderers ignore
  it on the model layer). Reserve COLOR_0 only for subtle gradients you can't get otherwise.

### 7 tram types × sections

Author one parametric function `buildTram(spec)` where `spec` encodes length, #sections,
livery color, door count, pantograph style, roof kit. Multi-section trams (e.g. articulated
15T/Škoda ForCity, KT8, T3 pairs) = repeat the body segment with articulation boxes
between. Export **one GLB per rendered unit** (a whole articulated tram as a single GLB is
simplest for placement — one point, one model). Only split into per-section GLBs if you need
to bend sections around curves; that adds N model layers per tram and per-section rotation
math. Recommendation: **one GLB per tram type**, sections baked in, unless curve-bending is a
hard requirement.

---

## 6. File size & the multi-mesh caveat

- Target <300 KB is easy: the two-box file is 3 KB; a detailed tram with shared materials
  and modest tessellation lands ~20–120 KB uncompressed. **No Draco/meshopt needed** — and
  compression adds a decoder dependency and native-support risk on the model layer. Skip it.
- Optimize with `@gltf-transform/functions` before writing:
  ```js
  import { weld, dedup, prune, flatten, join } from '@gltf-transform/functions';
  await doc.transform(weld(), dedup(), prune(), flatten());
  ```
  - `weld()` merges duplicate vertices (indexed) → smaller. `dedup()` removes duplicate
    accessors/materials/meshes. `prune()` drops unused resources. `flatten()` collapses the
    node tree. `join()` merges compatible primitives/meshes into fewer draw calls.
- **⚠️ Multi-mesh rendering bug (web only):** mapbox-gl-js issue #13341 reports that GLB
  files with **many separate meshes** render merged/glitched at high zoom in **gl-js v3.8**.
  This app uses the **native iOS SDK via rnmapbox**, a different renderer, so it likely does
  not apply — but as insurance, **`join()` your primitives into a single (or few) mesh per
  GLB** and keep the node hierarchy flat. This also improves instanced-draw performance,
  which Mapbox explicitly recommends (low draw-call count, few model variations). **Verify on
  a real device** with a multi-part tram early.
- LOD: Mapbox suggests very low-poly LODs at low zoom (10–20 verts). For city-level tram
  dots you may ship a simplified "blob" GLB and swap to the detailed GLB when zoomed in
  (different `model-id` per zoom-based layer), if perf demands it.

---

## 7. Referencing GLB assets from `@rnmapbox/maps` in Expo

Verified from rnmapbox source (`src/components/Models.tsx`) and the `SimpleModelLayer`
example. The `Models` component takes a name→asset map and resolves it with
`Image.resolveAssetSource`:

```tsx
import { MapView, Camera, ShapeSource, Models, ModelLayer } from '@rnmapbox/maps';

// require() a bundled .glb → resolved via Image.resolveAssetSource
const models = {
  t3:      require('../assets/models/tram-t3.glb'),
  forcity: require('../assets/models/tram-forcity.glb'),
  // ...7 types
};

const style = { modelId: 't3', modelScale: [1, 1, 1], modelRotation: [0, 0, 0] };

<MapView>
  <Camera centerCoordinate={[14.42, 50.08]} zoomLevel={15} pitch={60} />
  <Models models={models} />
  <ShapeSource id="trams" shape={tramFeatureCollection}>
    <ModelLayer id="tram-models" style={style} />
  </ShapeSource>
</MapView>
```

Key facts:

- `models` accepts `string | number`. A **`require('x.glb')`** returns a numeric asset id →
  rnmapbox calls `Image.resolveAssetSource(require(...))` internally. A **string** value is
  treated as a raw URL (`{ url: model }`) — use for `https://` or `file://` URIs.
- So three delivery options: **(a) bundled `require()`** (recommended for the 7 shipped
  models), **(b) `https://` URL**, **(c) `file://` URL** (e.g. downloaded to
  `expo-file-system` documents dir at runtime).
- **Metro must be told `.glb` is an asset.** By default Expo/Metro does not include `glb` in
  `assetExts`, so `require('*.glb')` fails to bundle. Add a `metro.config.js`:
  ```js
  const { getDefaultConfig } = require('expo/metro-config');
  const config = getDefaultConfig(__dirname);
  config.resolver.assetExts.push('glb', 'gltf');
  module.exports = config;
  ```
- In **dev**, `resolveAssetSource` yields an `http://<metro>` URL (served by the packager);
  in a **release/EAS build** the GLB is packaged into the app bundle and resolves to a
  `file://`/bundle path. Both are handled by the native SDK. Test the model layer in a
  **dev client / release build**, not Expo Go (rnmapbox is a native module → needs a custom
  dev client anyway).
- `ModelLayer` needs a source of points (a `ShapeSource`/vector source); it renders the
  model at each feature. Per-feature orientation: drive `modelRotation` with a data
  expression reading a `bearing` property on each tram feature, e.g.
  `modelRotation: ['literal', [0, 0, ['+', ['get', 'bearing'], HEADING_OFFSET]]]` (validate
  expression support for the array-valued property on the native SDK; fallback is one layer
  or grouping features by quantized heading).

---

## 8. Build-pipeline suggestion

`scripts/build-models.mjs`:
1. Define `TRAM_SPECS` (7 entries) → `buildTram(spec)` returns a `Document`.
2. `await doc.transform(weld(), dedup(), prune(), flatten(), join())`.
3. `writeBinary` → `assets/models/<type>.glb`.
4. `validateBytes` → throw if `numErrors > 0`; warn on file > 300 KB.
5. Commit GLBs (they're small) so EAS builds don't need Node model-gen.

---

## References

- gltf-transform Document API: https://gltf-transform.dev/modules/core/classes/Document
- gltf-transform functions: https://gltf-transform.dev/modules/functions
- Mapbox model layer spec: https://docs.mapbox.com/mapbox-gl-js/style-spec/layers/#model
- Using 3D models (Mapbox): https://docs.mapbox.com/style-spec/guides/using-3d-models/
- Mapbox iOS 3D model layer: https://docs.mapbox.com/ios/maps/examples/3D-model-layer/
- Multi-mesh bug (gl-js): https://github.com/mapbox/mapbox-gl-js/issues/13341
- Model layer notes: https://github.com/mapbox/mapbox-gl-js/issues/12847
- rnmapbox Models: https://rnmapbox.github.io/docs/components/Models
- rnmapbox source: `src/components/Models.tsx`, `example/src/examples/V10/SimpleModelLayer.js`
- three GLTFExporter in Node (why to avoid): https://discourse.threejs.org/t/nodejs-threejs-gltfexporter-server-side-blob-issue/4040
