# Decision record: procedural 3D tram GLB pipeline

Scope: how the 7 tram types (+ doors-open variants, + stop totem) that render in
the Mapbox `ModelLayer` are authored, validated, and wired to live vehicles.
Ground truth: `scripts/tram-models/*`, `scripts/generate-tram-models.mjs`,
`scripts/render-model.mjs`, `src/lib/fleet/*`, `src/lib/render/featureBuilder.ts`,
`docs/research/{glb-authoring,prague-fleet}.md`, `docs/architecture.md`.

---

## 1. Author GLBs in code (gltf-transform), not Blender/downloads

**Problem.** Need ~7 detailed, real-scale tram models (× articulated sections ×
doors-open variants = 37 GLBs) for the model layer, on a schedule, regenerable,
diffable, with zero binary-asset provenance risk.

**Options considered** (`docs/research/glb-authoring.md`):
- Download meshes / use Blender — rejected: opaque binaries, no parametric
  reuse, licensing/provenance risk, not regenerable from a diff.
- three.js `GLTFExporter` in Node — rejected: browser-targeted, needs
  `Blob`/`FileReader` DOM shims (`vblob`/`node-three-gltf`), worse control over
  accessor packing and file size.
- **`@gltf-transform/core` (v4.4.1)** — chosen.

**Decision.** Build geometry from parametric boxes/extrusions in pure-Node ESM
and write GLB via `NodeIO().writeBinary()`. Pipeline lives in
`scripts/tram-models/` + `scripts/generate-tram-models.mjs`; GLBs are committed
to `assets/models/` so EAS builds never run the model tooling.

**Why.** No DOM, no native deps, first-class GLB writer, fine control over
accessor packing → small files. Author-from-primitives is strictly gltf-transform's
strength. The spike (research §3) produced a validator-clean 3 KB two-box GLB;
detailed trams land in tens of KB.

**How.**
- `scripts/tram-models/lib.mjs` — the authoring library: `MeshBuilder`
  (accumulates flat-shaded tris per material key), geometry primitives
  (`box`/`cylinder`/`beam`/`prismZ`/`ribbon`/`fan`), the shared PBR material
  palette `MATERIALS`, reusable parts (`buildWall`, `bogie`, pantographs,
  `roofSlab`, `jointCap`, `destinationDisplay`, `roundLamp`…), and GLB assembly
  `writeSectionGlb()` / read-back `readGlbStats()`.
- `writeSectionGlb()` runs `doc.transform(weld(), dedup(), prune())` before
  writing (indexes/dedups accessors, drops unused). No Draco/meshopt — research
  §6: compression adds a native-decoder risk on the model layer and the files
  are already tiny.
- Materials are **factors only** (no textures): metallic-roughness base color +
  emissive factor. Smaller files; the layer relights/tints correctly. Emissive
  is set via `emissiveFactor` only — the layer supplies the global multiplier
  (`modelEmissiveStrength: 1.2`, arch §Map rendering).

---

## 2. Hard geometry conventions (Y-up, meters, FRONT toward −Z)

**Problem.** The Mapbox model layer's orientation/units behavior is
under-documented and partly empirical; getting it wrong silently mis-scales or
mis-points every tram.

**Decision / conventions** (`lib.mjs` header, `docs/architecture.md`
SPIKE-VERIFIED block):
- **Y-up, meters, real size.** Ground at `y=0`. `model-scale` stays ~1 because
  models are authored at true dimensions (a T3 is 14.1 m, not unit-scaled).
- **Each section centered at its own origin** (x=0, z=0 at section center) — so a
  section drops onto a point feature and `modelRotation z = bearing` pivots about
  the body center.
- **FRONT of the tram toward −Z.** This is the calibration story: empirically,
  with `modelRotation z = β`, the model's authored **+Z** axis points at compass
  bearing **β+180°** (clockwise-positive). Therefore authoring the nose toward
  **−Z** makes `z = bearing` face the tram correctly with no per-feature offset
  math. (`docs/architecture.md` still notes a `HEADING_OFFSET` calibration const
  as the general escape hatch, but the −Z convention zeroes it out.)
- **Single-sided materials** (`setDoubleSided(false)`) for perf → outward normals
  and CCW winding matter. See MDL-1 below.

**Consumed at** `src/components/map/TramLayers.tsx:331`:
`modelRotation: [0, 0, ['get','bearing']]`, and `RouteNetwork.tsx` totem at
`[0,0,0]`. `bearing` per section comes from `polyline.bearingAt()` in
`featureBuilder.ts`.

### MDL-1: cylinder normal winding regression

Single-sided walls mean an inward-facing normal is back-face culled and the part
(e.g. a `roundLamp` headlight bezel built on the z axis) *disappears* at oblique
angles. `MeshBuilder.cylinder()` winds x/z-axis rings one way and y-axis the
mirror. `scripts/tram-models/cylinder-normals.test.mjs` is a standalone node
regression asserting `dot(faceNormal, radialDir) > 0` for every side triangle on
all three axes. (Standalone, not in jest — `lib.mjs` is pure ESM pulling in
gltf-transform.)

---

## 3. Budgets & validation gates (the generator fails loud)

**Problem.** A broken model (wrong size, sunk below ground, off-center, blown tri
budget, oversized file) must never ship silently.

**Decision.** `scripts/generate-tram-models.mjs` builds each section, reads the
GLB back with `readGlbStats()` (bbox + tri count from the actual file), and gates
it. Any violation → non-zero exit.

**Gates** (`generate-tram-models.mjs`):
| gate | value |
|---|---|
| section length vs spec | ±0.30 m |
| height | [3.0, 3.6] m |
| width | [2.4, 2.65] m |
| min Y (no sinking) | ≥ −0.01 |
| centered on X and Z | \|min+max\| ≤ 0.05 |
| file size / section | ≤ 150 KB |
| tris / section | ≤ 12000 |
| whole-tram tris | [3000·min(1, L/30), 12000] |

Reads back the *written* file (not the in-memory builder) so the gate catches
serialization bugs too. Prints a `console.table` report per run.

**Parallel authoring.** Each model id maps to its own builder file under
`scripts/tram-models/` and writes only its own section GLBs, so 7 per-model
agents run in parallel without touching each other's outputs. `node
scripts/generate-tram-models.mjs 15t kt8d5` builds a subset; no args = all.

---

## 4. Per-model authoring: photo-reference iteration (round 1 → round 2)

**Problem.** Round-1 models (commit `d76eaf2`/`d415c3c`, "Mega-wave: 7
photo-referenced 3D tram models") were parametric-but-generic. User feedback on
the first pass was that trams were **unrecognizable**.

**Decision.** Round 2 (commit `acda059`, "model fidelity round 2 … photo-matched")
rebuilt each model against **≥8 reference photos** of specific Prague cars, with
the concrete measured observations written into each builder file's header as a
**diff list** (heights in meters, ground = 0). This is the durable record of
*why* each dimension is what it is.

**Evidence in the files:**
- `14t.mjs` header: "ACCURACY ROUND 2 — rebuilt against 10 reference photos
  (Wikimedia Commons: 9135 Rudolfinum 3/4, 9119 Hlubočepy front, …)" then a
  labeled nose/livery/roof observation list.
- `t3.mjs`: museum car **6102** photo set; wrap-around windshield sill/​top,
  chrome bumper strip, red belt sweeping down at the cab corners, etc.
- `t3rp.mjs`: cars **8216, 8315, 8318, 8331, 8448, 8456, 8534, 8540**; notes a
  round-1 error corrected in round 2 — "round 1 wrongly used a half-panto",
  T3R.P actually carries a **yellow full scissor pantograph**.

**Structural consequence.** Round 2 split the T3 family into three *dedicated*
photo-matched builders (`t3.mjs` museum, `t3rp.mjs`, `t3rplf.mjs`), each
exporting its own `sections()` + `buildOpen`. `t3-common.mjs` retains the
parametric shared `buildT3(variant)` and T3 mask (the round-1 lineage / reference
for the plain-T3 mask) but the shipping variants diverged from it for fidelity.

---

## 5. Section splitting for articulation + sealed joint caps (black-interior bug)

**Problem.** Articulated trams (KT8D5=3, 14T/52T=5, 15T=3 sections) bend around
curves. One rigid GLB can't bend. But splitting exposes a bug: a lone section
shows the **open black interior of the hull** at its cut face — reported as
"трамваи обрезаются, сзади чёрная внутренность" (trams cut off, black interior at
the back).

**Decision.** One GLB per section (placed as separate point features; see §8),
and **every articulated end gets a closed dark gasket end-cap** so a lone section
reads as *finished*.

**How** (`lib.mjs`):
- `buildSectionShell()` builds the common skeleton (walls, roof slab, floor
  plate, underframe, bogies) and, for any `front:'joint'` / `rear:'bellows'|'joint'`
  end, calls `jointCap()`.
- `jointCap()` extrudes a closed, house-shaped `trim` prism across the whole
  cross-section (sides + roof dome + underside + both z-faces) then insets a
  darker `black` diaphragm panel a hair proud → reads as a rubber-bellows gasket.
  A few dozen tris, guaranteed-outward normals (prism/box primitives only).
- Per-model overrides: `14t.mjs` uses `gaiterCap()` (silver pleated covers, its
  livery) instead of the shared black `jointCap`, but keeps the cross-section
  fully sealed.

Sections are laid head-to-tail; the render harness (§7) spaces them along −Z to
preview the whole consist.

---

## 6. Doors-open variants (swap at dwell via `openModelKey`)

**Problem.** Show doors opening while a tram sits at a stop, without runtime skinned
animation (the model layer has none).

**Decision.** Author a second GLB per door-bearing section — the doors-OPEN
variant, keyed `<modelKey>-open` — and swap `modelKey` at dwell. No animation;
just a model-id swap driven by tram phase.

**How.**
- Authoring: `buildWall()` (in `lib.mjs`) takes `doorsOpen`. Door segments
  render leaves slid ~80% aside into edge pockets, a recessed dark doorway
  (`doorwayDark`), and a warm emissive interior glow (`doorGlow`, `emissive
  [1.0,0.72,0.4]`) — sized for a map-scale read. The pocket is fully sealed
  (floor/ceiling/reveals) so it doesn't reintroduce a black-interior hole.
  Segments flagged `noOpen:true` (driver doors) stay shut.
- Generator: `generate-tram-models.mjs` builds `<key>-open.glb` for any section
  whose `sections()` entry provides a `buildOpen`, held to the same gates.
  Sections without passenger doors have no open variant — e.g. `14t-a` (narrow
  silver driver door only), `52t-b`/`52t-d` (pantograph middles). See
  `modelSpecs.ts` — those `sections[]` entries omit `openModelKey`, and
  `MODEL_ASSETS` omits their `-open` requires.
- Spec: `src/lib/fleet/modelSpecs.ts` `sections[].openModelKey`.
- Swap: `src/lib/render/featureBuilder.ts` `sectionModelKey(section, dwelling)`
  returns `openModelKey` when `dwelling && openModelKey !== undefined`, else
  `modelKey`. `dwelling = state.phase === 'dwell'` — doors close again (normal
  key) on departure.

---

## 7. Coupled T3 pairs

**Problem.** T3-family cars frequently run as a mechanically-coupled **two-car
pair** ("dvojice"), reported by Golemio as one vehicle. Rendering one body is
wrong; a single 28 m artic mesh is also wrong (it's two independent rigid cars).

**Decision.** Detect likely pairs heuristically and render the same section GLBs
**twice**, the trailer offset one car-length behind along the shape.

**How.**
- Heuristic: `src/lib/fleet/registry.ts` `isLikelyCoupledPair(modelId, line)` —
  T3-family (`t3`/`t3rp`/`t3rplf`) on numeric day lines 1–26, excluding 23.
- Plumbed via `hooks/tramData.ts` `coupledPairFn` → `featureBuilder.ts`.
- Rendering: `sectionsAlongShape()` / `sectionsAtRawPosition()`, when `coupled`,
  emit a second feature per section at `centerDist − COUPLED_OFFSET_M`
  (`= 14.5`, `featureBuilder.ts:38`) — two connected but separately-jointed
  bodies, per the research doc's guidance.

---

## 8. Fleet registry: reg-number ranges (live-verified overrides of research doc)

**Problem.** Map a Golemio `vehicle_registration_number` (DPP evidenční číslo,
4-digit int) to a tram model id.

**Decision.** An ordered range table, first-match wins, unknown → `t3rp`
fallback (most common single-body type). Crucially, the shipped ranges are the
**live-verified** table, which *overrides* `docs/research/prague-fleet.md` where
the research was wrong.

**How** (`src/lib/fleet/registry.ts` `RANGES` + `regNumberToModelId`):
| reg range | model |
|---|---|
| ≤ 8014 | `t3` (historic) |
| 8015–8249 | `t3rp` |
| 8251–8299 | `t3rplf` |
| 8300–8579 | `t3rp` |
| 8750–8806 | `t3rplf` |
| 9051–9113 | `kt8d5` |
| **9114–9199** | `14t` |
| **9200–9499** | `15t` |
| 9500–9599 | `52t` |

**Live-verified overrides** (`architecture.md` §Fleet registry note): the
research doc claimed **14T = 9404–9629**; a live `vehiclepositions` snapshot
(observed reg range 6004–9520) put the 14T cluster at **9115–9172** and 15T at
**9201–9459**. The code follows the live data, not the research doc. **T6A5**
(retired June 2021) is deliberately absent — its old 8600–8750 block resolves to
the fallback rather than a wrong model, so stale data can't render a retired
type.

`getModelSpec()` / `MODEL_SPECS` (`modelSpecs.ts`) carry per-model section lists,
lengths, livery, `runsCoupled`, and fun facts; `MODEL_ASSETS` maps every
`modelKey` (incl. `-open`) to a bundled GLB. A model-specs test asserts
`MODEL_ASSETS` has no key a `TramModelSpec` doesn't reference — which is why the
totem is a *separate* export (§10).

---

## 9. Render harness: puppeteer + three contact sheets (the agents' feedback loop)

**Problem.** Agents authoring GLBs in pure Node can't *see* the result without
launching the whole iOS app.

**Decision.** `scripts/render-model.mjs` renders a GLB (or a glob of sections) to
a PNG in headless Chromium via three.js — the visual feedback loop that let the
round-2 photo-matching converge.

**How.**
- puppeteer (`--use-gl=angle`) loads a three + `GLTFLoader` bundle (esbuild,
  cached under `node_modules/.cache`), parses base64 GLBs, and screenshots.
- Multiple GLBs are laid **end-to-end along Z, head (−Z) first**, like a real
  consist. A red cone marks the FRONT (−Z) so orientation is unambiguous.
- Three output modes:
  - default → a 2×2 **contact sheet** (front 3/4, side, rear 3/4, front detail)
    on a grey grid.
  - `--thumb` → single 3/4-front on **transparent** bg, tight bbox-projected
    fit; this is the UI thumbnail (`MODEL_IMAGES` in `modelSpecs.ts`, files in
    `assets/images/trams/*.png`).
  - `--face` → extreme close-up of just the front 30% of the first (head) GLB,
    transparent — the "face thumbnails" from commit `acda059`.
- Committed contact sheets live in `docs/model-previews/` (`t3.png`, `15t.png`,
  …) as a dev aid — not shipped in the app bundle. `docs/model-previews/README.md`
  documents the regenerate-then-preview loop and the −Z/red-cone convention for
  the per-model agents.

---

## 10. Stop totem

**Problem.** Map stop markers need a recognizable Prague tram-stop sign. Round 1
shipped a lone **red circle with a tram in it** — which actually reads as the
road prohibition sign "no trams" (user: "не как в реальной жизни").

**Decision.** Round-2 rebuild (`scripts/tram-models/stop-totem.mjs`): a real PID
označník — slim grey pole carrying a **rectangular portrait white PID board**
(red border, red roundel + dark tram pictogram, yellow accent, stop-name bars,
line-number chips) plus a lower A4 glass timetable case and a base foot.

**How / notable choices.**
- Same conventions as tram sections (Y-up, meters, origin at base center, FRONT
  toward −Z) so it drops straight into the model layer.
- **Double-sided by construction**: single-sided materials, so every visible
  face is painted on **both** −Z and +Z (`paintBoardFace`/`paintCaseFace` called
  with `dir=-1` and `+1`) — the sign reads the same from either side, like the
  real one.
- Its own validation in the file's run-as-script block (≤30 KB, height
  [2.9, 3.35] m, x-centered).
- Registered **separately** as `STOP_TOTEM_ASSET` (not in `MODEL_ASSETS`) because
  the model-specs test rejects any `MODEL_ASSETS` key no `TramModelSpec`
  references; combined at load time as `{ ...MODEL_ASSETS, 'stop-totem':
  STOP_TOTEM_ASSET }` (`useTramModels.ts`, `RouteNetwork.tsx`
  `STOP_TOTEM_MODEL_KEY`).

---

## Appendix: file map

| file | role |
|---|---|
| `scripts/tram-models/lib.mjs` | authoring library: MeshBuilder, primitives, MATERIALS, shared parts, GLB write/read |
| `scripts/tram-models/{t3,t3rp,t3rplf,kt8d5,14t,15t,52t}.mjs` | per-model builders (each `export sections()`) |
| `scripts/tram-models/t3-common.mjs` | shared parametric T3 mask / `buildT3` (round-1 lineage) |
| `scripts/tram-models/stop-totem.mjs` | PID stop totem |
| `scripts/tram-models/cylinder-normals.test.mjs` | MDL-1 normal-winding regression |
| `scripts/generate-tram-models.mjs` | build + validate all/subset → `assets/models/*.glb` |
| `scripts/render-model.mjs` | puppeteer+three PNG contact sheets / `--thumb` / `--face` |
| `src/lib/fleet/registry.ts` | reg→model ranges, coupled-pair heuristic, `getModelSpec` |
| `src/lib/fleet/modelSpecs.ts` | `MODEL_SPECS`, `MODEL_ASSETS`, `STOP_TOTEM_ASSET`, `MODEL_IMAGES` |
| `src/lib/render/featureBuilder.ts` | section placement, doors-open swap, coupled trailer |
| `docs/model-previews/` | committed contact-sheet PNGs (dev aid) |
| `docs/research/{glb-authoring,prague-fleet}.md` | pipeline + fleet research |
