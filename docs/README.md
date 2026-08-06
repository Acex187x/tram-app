# Tram Spotter — Documentation Index

iOS-only Expo SDK 57 app: real-time Prague trams on a 3D Mapbox map with
physics-based interpolation, per-type 3D models, and iOS 26 Liquid Glass UI.

**New here?** Read in this order: `architecture.md` → the `decisions/` record for
the subsystem you're touching → the relevant `research/` note (all API facts and
version gotchas live there). `history.md` explains how the code got this way.

## Top-level

| Doc | What it is |
|---|---|
| [`architecture.md`](architecture.md) | The current system: module map, data flow, the interpolation engine, zoom-mode/map rendering, fleet registry, UI, and the on-device-verified rnmapbox quirks. Start here. |
| [`history.md`](history.md) | Chronological project narrative (~20 commits) grouped into phases, with the debugging sagas (black basemap, invisible route lines, WebGL1 viewer chain, iPad thermals, follow-cam flooding). |

## Decision records (`decisions/`)

Engineering decision records — each states the PROBLEM, OPTIONS, DECISION, WHY,
and HOW (with `src/…` references) for one subsystem.

| Doc | Covers |
|---|---|
| [`decisions/data-pipeline.md`](decisions/data-pipeline.md) | Golemio polling, rate-limit queue, entity keying, GTFS/shape fetching + disk cache, `RouteGeometry` construction. |
| [`decisions/engine-v2.md`](decisions/engine-v2.md) | **The current engine** (2026-08-01): the fix → predictor → smoother layer stack, three render modes (smooth/live/raw), why the dual-controller design was replaced, and the TS replay ship gate. Start here for physics. |
| [`decisions/interpolation-engine.md`](decisions/interpolation-engine.md) | SUPERSEDED by engine-v2.md for the controller architecture; still the evidence base for the braking envelope, holds, queueing, and every field-fix's rationale. |
| [`decisions/backend-convex.md`](decisions/backend-convex.md) | **The backend as built** (Convex): 24/7 self-rescheduling Golemio poller, diff-stream via reactive queries, server-side continuous calibration (segment/model/vehicle/stop EWMAs → client prior bundle), `RemoteFeed`. |
| [`decisions/backend-plan.md`](decisions/backend-plan.md) | The original backend design record (generic WS/HTTP sketch) — motivation and the `TramFeed` seam; transport superseded by backend-convex.md. |
| [`performance.md`](performance.md) | Performance & thermal playbook: everything done for perf (cadence system, GPU knobs, allocation discipline), the invariants that must not be broken, and the pre-ship verification checklist. |
| [`decisions/map-rendering.md`](decisions/map-rendering.md) | Zoom bands, ModelLayer scaling, the imperative-push source pattern, the follow camera (80 ms retarget / 170 ms overlapping glide, persistent gestures), thermal cadences. |
| [`decisions/3d-models.md`](decisions/3d-models.md) | Programmatic GLB authoring (`@gltf-transform/core`), the −Z front convention, per-type sections, and the expo-gl + three interactive viewer (WebGL1 chain). |
| [`decisions/ux-screens.md`](decisions/ux-screens.md) | The Liquid Glass shell and the form-sheet screens (tram / line / search / favorites / planner / stop / settings), follow/selection UX. |
| [`decisions/process-and-tooling.md`](decisions/process-and-tooling.md) | Testing strategy, EAS build config, model-generation scripts, and the review/QA loop. |
| [`decisions/ride-recording.md`](decisions/ride-recording.md) | Ride recording (schema v4): 25 Hz DeviceMotion batches, the GPS outlier filter, background-recording mechanics + researched options (Live Activity, CMSensorRecorder, why not audio). |

## Research (`research/`)

Empirical notes, all verified on 2026-07-11 against live systems / installed
`node_modules`. Source-of-truth for API facts and versions.

| Doc | Covers |
|---|---|
| [`research/golemio-api.md`](research/golemio-api.md) | Golemio PID API: auth, endpoints, rate limits, `vehiclepositions`/GTFS response shapes, and the gotchas (km-as-string distances, `includeNotTracking`). |
| [`research/mapbox-rn.md`](research/mapbox-rn.md) | `@rnmapbox/maps` 10.3.2 on Expo SDK 57 / RN 0.86 / Fabric: Standard style, `ModelLayer` + `Models`, version facts. |
| [`research/glb-authoring.md`](research/glb-authoring.md) | Authoring tram GLBs from primitives in Node with `@gltf-transform/core` (no Blender) — materials, file size, validation. |
| [`research/prague-fleet.md`](research/prague-fleet.md) | The active DPP tram fleet, type-by-type, with registration ranges — and what is retired (T6A5, classic T3) and must NOT be mapped. |
| [`research/expo-ui-digest.md`](research/expo-ui-digest.md) | Expo SDK 57 iOS-native / Liquid Glass UI cheat-sheet: installed versions and the real API surface of `@expo/ui`, `expo-glass-effect`, router, symbols. |

## Testing (`testing/`)

| Doc | Covers |
|---|---|
| [`testing/codex-review-1.md`](testing/codex-review-1.md) | Correctness review of all `src/` code — 21 findings (1 P0, several P1) that drove the `77e193f` fix wave. |
| [`testing/codex-report-1.md`](testing/codex-report-1.md) | Simulator E2E QA pass 1 (Codex drives the app): severity summary + evidence. |
| [`testing/codex-report-2.md`](testing/codex-report-2.md) | Focused re-test of the pass-1 fixes, incl. the planner-geometry false positive later adjudicated in `7ab527e`. |

## Model previews (`model-previews/`)

| Doc | Covers |
|---|---|
| [`model-previews/README.md`](model-previews/README.md) | How to regenerate a model's GLBs and its contact-sheet preview; the `<modelId>.png` naming + −Z-front convention. |

Contact-sheet PNGs (`t3`, `t3rp`, `t3rplf`, `kt8d5`, `14t`, `15t`, `52t`) sit
alongside — dev aids so you can SEE a model without launching the app; not
shipped in the bundle.
</content>
