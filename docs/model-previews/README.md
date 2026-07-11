# Model previews

Contact-sheet PNGs of the generated tram GLBs, so humans and agents can SEE a
model without launching the app. Not shipped in the app bundle — dev aid only.

## Regenerate a model's GLBs then its preview

```sh
# build only this model's section GLBs (writes only its own files)
node scripts/generate-tram-models.mjs 15t

# whole-tram contact sheet (sections laid head-to-tail along −Z)
node scripts/render-model.mjs assets/models/15t-*.glb docs/model-previews/15t.png

# single section
node scripts/render-model.mjs assets/models/15t-a.glb docs/model-previews/15t-a.png
```

Valid model ids: `t3 t3rp t3rplf kt8d5 14t 15t 52t` (no args = build all).

## Convention for the per-model agents

Drop a whole-tram preview named `<modelId>.png` here (e.g. `t3.png`,
`kt8d5.png`). The red cone in each view marks the FRONT (−Z end) — trams are
authored front-toward-−Z so `modelRotation z = bearing` faces correctly.
