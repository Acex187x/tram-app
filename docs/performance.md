# Performance & Thermal Playbook

This document describes the current physics-v3 working tree. It specifies budgets
and verification requirements; it does not claim that an uninstalled change has
passed a physical-device thermal soak. Earlier engine findings are retained in
the historical section below. See [architecture](architecture.md) for the data
contracts and [candidate evidence](testing/tracking-candidate.md) for dated results.

## Current rendering and data flow

The server computes motion profiles. `RemoteFeed` streams identity and AVL
observations from Convex; a separate Convex source streams trajectories and
publication health. Geometry comes from the initial geometry pack and cached
per-trip requests. The phone evaluates absolute-time curves on demand. It does
not run the retired `TramEngine` predictor/smoother fleet or integrate catch-up
substeps after suspension.

Only actual map frames commit the presentation guard. UI, diagnostics and future
queries are read-only with respect to that guard. Its non-reverse floor, speed
ceiling and forward catch-up acceleration limit operate on actual frame time;
curve evaluation uses the independently corrected server clock. Geometry/fix
coherence is assessed on ingest or geometry changes, never per frame. Strongly
contradictory geometry and curves are excluded, leaving the raw GPS fallback.

### Cadence budgets

| Work | Cadence | Condition |
|---|---|---|
| Map frame notifications / section due-checks | 33 ms, approximately 30 Hz | Enter detail at zoom ≥ 14.0; leave below 13.7; foreground |
| Map frame notifications at far zoom | 100 ms | Outside detail band; foreground |
| Badge/dot pushes | 66 ms / 1 s / 5 s | Zoom ≥ 14 / 12.5–14 / < 12.5 |
| Follow-camera retarget | Approximately 80 ms | Following a tram, map visible; overlapping native glides |
| UI hooks | At most 1 Hz for live sampling | No notification work without listeners; explicit user actions may update immediately |
| Tracking inspector snapshot | 1 Hz | Debug enabled, selected/followed tram, unpaused, outside Help, foreground, model viewer closed |
| Debug map trace | 100 ms | One selected/followed tram, debug enabled, visible map; bounded 20 s / 201 points per trace |
| Server-debug request | 3 s after previous completion | Shared per tram by map/panel, foreground subscribers;8 s timeout |
| Route-network/stop refresh | 2 s | Foreground; fingerprint short-circuit |
| Snapshot feed | Server pushes | Server poll cadence is reported in feed health, normally 2 s; no phone 5 s Golemio poll |
| Trajectory feed | Server pushes | Separate subscription; publication age differs from individual profile age |
| Clock sample | On start, then 60 s after reply | Nonce query, RTT midpoint; cached reactive metadata is not a clock sample |

Both FIXED and SMOOTH animate between publications. There is no raw-mode
poll-dirty special case. A selection or mode change forces an immediate map
refresh rather than waiting for the city-scale interval. A frame notification is
a due-check opportunity, not an instruction to rebuild and push every source.

30 Hz notifications and fast badge pushes share the same detail boundary.
Hysteresis prevents timer churn. At far zoom, Mapbox should idle between sparse
pushes instead of redrawing a near-identical fleet continuously.

### GPU and allocation rules

- Moving GeoJSON uses the patched `ShapeSource.updateShape` direct-native path.
  Stable React props omit `shape`; Fabric cannot replay stale moving geometry
  through a concurrent text/menu commit.
- Sections are viewport-culled with a 300 m margin. Close-zoom pre-allocation
  rejection uses a 600 m margin so off-screen trams do not become full state or
  feature objects. Selected/followed vehicles remain available to overlays.
- Model shadows are off. Mapbox's native render ceiling is 60 fps, including on
  120 Hz ProMotion devices; fleet geometry changes at no more than 30 Hz.
- The opaque `/model/` route unsubscribes hidden map frame pushes and follow
  camera work. Debug traces and panel sampling also suspend. Live data and ride
  recording retain their own lifecycle; hiding the map is not backgrounding.
- Skip feature building/stringification/native updates when no push is due.
  Empty sources should not repeatedly serialize and push another empty frame.
- Fleet state and diagnostics histories are bounded/pruned. New per-vehicle
  caches must have departure cleanup; no retained multi-hour history by default.
- List rows remain memoized, with primitive props, bounded FlatList windows,
  glass-free row internals and shared 1 Hz time sampling.

### Model viewer budget

Physical devices use native-size PBR rendering,4×MSAA, approximately 30 fps while
idle and display-paced interaction. Simulator OpenGL is software rasterized;
it instead uses Lambert materials, no MSAA and a 640 px maximum-edge render
target, upscaled once to the native view at approximately 12 fps. These rendering
paths share geometry and mechanism metadata, but Simulator shading/resolution
are not evidence of physical-device PBR quality.

The next animation frame is scheduled after the Expo GL flush barrier, preventing
an unbounded native command backlog. Backgrounding cancels frame scheduling;
foregrounding restarts it. Unmount disposes renderer, targets, geometries and
materials. Door and indicator controls update refs; animation is imperative.
The viewport fits above the control card and follows GL drawing-buffer changes.
The camera uses a model/distance-dependent near/far range to preserve depth
precision for separate body, glass and display surfaces.

### Network and geometry

Convex subscriptions seed once, consume bounded diff windows and reseed on
sequence gaps. Seed failures have lifecycle-guarded retry and expose waiting or
failure state; they must not become a silent permanent empty fleet. Clock replies
with excessive RTT are rejected, and offset changes are rate-limited to avoid
fleet-wide jumps. A failed diagnostics endpoint does not imply failed motion
transport.

Per-trip geometry fetches remain rate-limited, single-flight and disk-cached for
3 days with service-day re-anchoring. A provisional geometry pack accelerates
cold start; authoritative trip geometry can replace it. Geometry-landed events
adopt a burst with a 300 ms debounce, rather than waiting for another AVL fix.
The phone no longer downloads a full Golemio positions payload every 5 s.

## Invariants — do not break these

1. **No live React state above 1 Hz.** Continuous motion and mechanisms live in
   refs and imperative paths. The inspector also samples at 1 Hz; the retired
   `DebugLive` 10 Hz React exception no longer exists. User actions are not a live
   sampling timer. Use frame subscriptions only for visible imperative work.
2. **New moving map layers use direct-native updates.** Mount without a React
   `shape` prop; never use `setNativeProps` for moving GeoJSON. Keep stable props
   and the established top slot. See `imperative-shape-source.test.ts`.
3. **Every timer/subscription has lifecycle cleanup and stale-result guards.**
   Full background pause stops data/render/UI work except an active ride
   recording's explicitly bounded mode below. Opaque model routes also suppress
   hidden map work. Final unsubscribe aborts shared debug requests.
4. **Cadence boundaries stay aligned.** The detail notification threshold and
   fast point cadence use one shared boundary; preserve hysteresis.
5. **Payload follows visibility.** High-rate section/point work is culled; never
   push a full fleet at detail cadence. Check serialized sizes after adding props.
6. **No continuous idle map camera/style animation.** Only following may retarget
   continuously. At far zoom, rendering should be event-driven between pushes.
7. **Mapbox expensive features stay off** unless an on-device thermal soak
   justifies enabling shadows, terrain or additional light passes.
8. **Hot paths stay allocation-light and read ownership stays explicit.** Avoid
   per-tram temporary arrays/closures in every frame. Diagnostics/future queries
   must not mutate the displayed-position guard or advance its frame clock.
9. **Heavy feed work stays behind `TramFeed` and the backend boundary.** Inference,
   aggregation, geometry coherence and cache rebuilding never run per frame.

## Active ride recording in background

An active GPS ride needs current model-side values when a background location
sample arrives. `TramRuntime` therefore enters `rideBackground` only while the
ride-activity probe reports a recording. It preserves data access without map or
React work:

| Work | Background ride budget |
|---|---|
| Snapshot feed | Convex subscription retained; local deliveries throttled to 10 s |
| Trajectory feed | Convex push subscription retained; it is not a 10 s HTTP poll |
| Position evaluation | On demand at the recorder's sample instant; no frame timer |
| Map pushes/follow camera | Off |
| UI notifications | Off |
| Geometry | Available for route-distance/lag correlation |

Stopping a ride, including the 90 min auto-stop, immediately transitions to full
pause. Foregrounding restores normal subscriptions and due-check timers. With no
ride, backgrounding pauses fully; there is no simulation catch-up integration
when the app returns. Absolute-time evaluation makes the next visible state
current. Background network traffic is therefore not accurately described as
"exactly two 10 s polls": trajectory pushes and the retained source's clock
queries follow their existing subscription lifecycle.

## Verification before shipping performance changes

- Run the fixed `city`/`badges`/`models` and long-lived attach scenarios in
  [performance benchmark](performance-benchmark.md). Comparisons require the
  same simulator/runtime/build and three runs per scenario. Do not benchmark
  while Xcode imports multi-gigabyte failure diagnostics or another renderer
  saturates this Mac.
- Keep cadence, imperative-source, lifecycle and motion-replay tests current.
  See [client evidence](testing/client-tracking-2026-09-05.md),
  [inspector evidence](testing/tracking-inspector.md) and
  [backend evidence](research/tracking-2026-09-05/README.md). Simulation continuity
  tests and native control assertions do not establish geographic accuracy.
- Inspect actual map motion at detail and badge zoom, looking for repeated
  holds/jumps and checking fix, profile and publication age separately. Pair
  screenshot/video review with frame/replay metrics rather than inferring
  micro-jitter from the inspector's 1 Hz chart.
- Leave city-scale map idle 30 s and check event-driven rendering between 5 s
  point pushes. Open the model viewer and verify hidden map pushes stop.
- Perform a physical-device thermal soak of at least 20 min at mid zoom; record
  CPU, GPU, memory and thermal state. Aim for nominal/fair thermal state and low
  inter-update CPU/GPU duty. Simulator CPU is not a device energy measurement.
- Background for 2 min with no ride: no runtime network/render work; foreground
  restores fresh state. Repeat with an active ride and verify only its retained
  data budget, no map/UI pushes, and immediate full pause when the ride ends.
- Use `scripts/testing/` for native inspector/model taps, scrolling, pinch,
  door/indicator samples and background recovery. Review fresh screenshots and
  recordings separately. Automatic Xcode failure diagnostics are disabled in
  this harness; explicit assertion results and attachments remain retained.

## Historical findings (retired engine, not active v3 invariants)

The iteration 2–4 thermal work addressed excessive full-fleet pushes and cadence
aliasing on an iPad Pro. Those findings produced the direct-native path,
zoom-dependent push budget, shared detail threshold and hysteresis retained
above. The old implementation also batched a secondary predictor fleet at 500 ms
and constrained projection queues only when that fleet advanced. `TramEngine`,
its queue/braking integration and `setProjectionCadence` are retired; those
instructions do not apply to v3 curve evaluation.

A 2026-07-12 calibration soak showed 99.7% JS CPU after approximately 9 h; restarting
returned it to 11.6%. The old engine retained speed profiles for departed shapes;
2026-07-30 ingest pruning fixed that identified structure. This historical result
is not proof of current native Mapbox/Metal memory stability. Multi-hour device
soaks still need to track bounded listener/history counts and process memory.

Related: [map rendering decisions](decisions/map-rendering.md),
[physics-v3 contract](research/physics-v3-protocol.md),
[architecture](architecture.md). Earlier interpolation-engine/backend-plan
papers are historical context, not the current execution plan.
