# Client tracking investigation — 2026-09-05

Scope: actual production Convex fix/trajectory inputs, the shipping TypeScript
client, map-frame ownership, clock sync, geometry/culling, fallback motion,
UI notification cadence, and camera ownership. This is separate from ML
accuracy and native Mapbox/GPU verification.

## Reproduced defects and changes

- **Reads changed motion.** UI, calibration, camera and diagnostics all advanced
  the same last-frame guard. A future diagnostic probe could move its timestamp
  ahead of the next actual frame; same-timestamp reads bypassed the guard and
  returned the raw target. Only explicit map/bench frame producers now advance
  presentation state. Ordinary getters are read-only with respect to motion.
- **A tolerance became backward velocity.** Subtracting 0.5 metres from the last
  displayed position on every frame permitted 15 m/s backward motion at 30 Hz.
  The guard now has a strict nondecreasing floor. Guarded speed/phase describe
  the displayed motion; a held marker no longer claims to travel at curve speed.
- **Culling tested another location.** It ignored both the presentation guard
  and the moving no-curve fallback. Both use the same distance calculation as
  rendering, before expensive public-state/coordinate allocation.
- **Distance axes could be mixed.** Replacing provisional geometry with an
  authoritative shape now resets presentation state for that geometry.
- **Fast fixes never learned fallback speed.** Every two-second fix replaced a
  baseline that required four seconds to compute pace. Short intervals now
  accumulate. Confirmed stops clear fallback pace, old same-trip fixes are
  ignored, and trip changes reset the baseline.
- **Clock queries were cached.** A sampled set of 112 HTTP `fullSet` replies had
  transaction-clock minus receive-time values from −6,049 to −100 ms (median
  −1,357 ms). These are not exact WebSocket latency measurements, but demonstrate
  why a cached query clock cannot be treated as send time. The updated client samples
  the nonce query `clock:now`, uses RTT midpoint, rejects RTT >2 s, and changes
  the applied offset at no more than 5% of elapsed time. It refreshes on start/
  resume and every minute; pause cancels the timer. Missing endpoint leaves the
  clock explicitly unsynchronized, using device/last-known time.
- **Subscription state could stick after a backend reset.** A genuinely newer
  metadata publication with a lower stream head triggers a reseed. Old queued
  callbacks from replaced cursors are ignored. Metadata does not advance the
  *applied* diff cursor; old diffs cannot roll the store backward.
- **UI cadence was not 1 Hz.** Every ML batch/meta callback invalidated the fleet
  cache and woke all React subscribers. Publication-driven notifications now
  share the one-second gate; explicit render-mode selection remains immediate.
- **Delayed fly-to could cancel newer follow.** Camera ownership changes
  atomically in the selection store. Opening a tram cancels pending place
  fly-to requests; obsolete React effects cannot reclaim the camera.

## Compatible velocity extension

Protocol amendment: `0632328`, `docs/research/physics-v3-protocol.md`.
The decoder accepts optional knot velocity `v` and prepares a cubic Hermite
segment only if its entire derivative remains 0–16.7 m/s and acceleration
−1.4…+1.3 m/s². Infeasible/missing metadata preserves exact legacy linear
interpolation. Exact holds remain flat. Position, inverse crossing time,
terminal coast and server client-projection share the prepared representation.
No per-frame coefficient creation or alternative motion controller was added.

Legacy captures below contain no velocity metadata, so they demonstrate the
client ownership/clock fixes, **not** the benefit of the new velocity field.
Velocity rollout requires a fresh post-deployment capture and independent
backend checks. Synthetic tests demonstrate admissible acceleration/braking,
C1 joins, inverse accuracy, holds, and rejected overspeed/reversal/malformed
spans; they do not establish improved real-world position accuracy.

## Initial fixed-input replay (before the catch-up amendment)

The checked-in compressed fixtures contain only public transit feed inputs:

- `fixtures/tracking-2026-09-05-ws.jsonl.gz`: 296.584 s of genuine WebSocket
  seed/diff/meta messages, retaining receive timestamps. Uncompressed SHA-256
  `219742cc58f29223c2a7a8cd960556a38348c5e31b6392004f13f329381f23c5`.
- `fixtures/tracking-2026-09-05-geometry.json.gz`: public geometry pack used for
  the replay. Uncompressed SHA-256
  `730eba112d60dc6279afdfb6346544d9a191967e31b0c5bf8f7bebddb57cabd9`.

```sh
npx tsx --tsconfig lab/tsconfig.runtime.json bench/src/replay-wire.ts \
  docs/testing/fixtures/tracking-2026-09-05-ws.jsonl.gz \
  docs/testing/fixtures/tracking-2026-09-05-geometry.json.gz 30 300
```

Baseline: physics files from `f423ac0`. Identical inputs and 30 Hz schedule,
8,898 frames, 1,274,136 geometry-known vehicle samples. The same 214
server-authorized discontinuities are counted separately from these metrics:

| Metric | Baseline | Initial patched client |
|---|---:|---:|
| Backward display steps >1 cm | 7,264 | 0 |
| Display samples >25.1 m/s | 3,940 | 0 |
| Largest unsanctioned backward step | −76.39 m | 0 m |
| Largest unsanctioned forward step | 75.89 m | 0.833 m |
| p99 absolute frame speed change | 25.254 m/s | 0.191 m/s |
| Host full-fleet sample CPU, p99 | 0.267 ms | 0.276 ms |

Raw results are in `results/tracking-2026-09-05-{baseline,current}.json`.
The current replay has no nonce-clock messages (the endpoint had not yet been
rolled out), so it uses the capture host's local time. The old replay used
cached metadata clocks. CPU numbers are Node on the host, not Hermes, GPU,
thermal or wall-clock app performance. Geometry is available only for pack
trips; this is not a full-route coverage measurement. No rider GPS is present,
so these results do not establish ground-truth positional accuracy.

## Remaining limits

The existing presentation guard remains an explicit exception to fully
history-free **display** determinism. Pure curve evaluation is deterministic;
a continuous viewer can temporarily wait ahead of a newly corrected curve
while a new viewer joins directly at that curve. This guard is not another
predictor, and inspection no longer changes it. It resets for trip/geometry
changes, mode switches, a gap over five seconds, and sanctioned discontinuity.

The initial revision still had 46,266 guard-held samples on the five-minute
fixture. Source targets behind an already displayed correction still need
backend continuity work; removing the floor would reintroduce backward motion.
Admissible Hermite spans alone do not guarantee smooth transitions across all
source/fix-forward/horizon changes or sanctioned discontinuities.

## Presentation catch-up comparison and adoption

Protocol-only amendment `aa6e6d5` allows a **2.5 m/s² visual catch-up cap** on the
existing guard. This is not the server curve's physical acceleration limit.
Every actual map frame records interval velocity; future/UI reads remain pure.
Forward movement is limited by reachable speed, preserving the existing 25 m/s
ceiling and nonreverse floor. A target revised behind the marker can stop it
immediately; the client never coasts beyond truth just to satisfy a braking
bound. Trip/geometry changes, sanctioned discontinuities and long resumes
initialize at the current raw target.

A fully acceleration-and-braking-bounded prototype was rejected: on the
five-minute fixture its held vehicle time increased 1,542→7,287 seconds and
reported-at-stop time >10 m ahead of the raw target increased 749→6,176 seconds.
It looked physically bounded while making the product less accurate and more
likely to appear frozen.

The subsequent comparison froze 2,340.876 seconds of the same public WebSocket
capture, with 10,902,307 known-geometry samples at 30 Hz. All variants use the
same input bytes and geometry. These are pre-deployment production trajectories
without new optional velocities or the candidate ML target-clock corrections.

| Measure | Existing guard | Cap 1.3 | **Cap 2.5 adopted** | Cap 4.0 |
|---|---:|---:|---:|---:|
| Guard-held vehicle seconds | 13,673 | 10,011 | **10,766** | 11,055 |
| Launches from <0.1 to >1 m/s in one frame | 2,958 | 0 | **0** | 0 |
| Behind-target p99, reported at_stop / on_track, m | 9.72 / 5.93 | 35.58 / 39.30 | **29.50 / 29.79** | 26.23 / 25.23 |
| Historical AVL MAE, at_stop / on_track, m | 163.57 / 85.77 | 164.83 / 86.07 | **164.23 / 85.94** | 164.02 / 85.88 |
| Hold episode p90, at_stop / on_track, s | 23.57 / 3.03 | 8.10 / 2.90 | **12.80 / 3.03** | 27.13 / 5.33 |
| Vehicle seconds >10m ahead of target, at_stop / on_track | 5,611 / 478 | 4,870 / 402 | **5,405 / 445** | 5,539 / 450 |

The adopted shipping code replay has zero >1 m/s launches and maximum positive
speed change 0.083333 m/s between contiguous 30 Hz frames. Discontinuities and
fleet removal/rejoins are resets, not contiguous acceleration samples. Hard
braking remains possible and is explicitly not hidden by this metric. CPU p99
was effectively unchanged in matched runs (~0.52 ms), while concurrently run
variants reached ~0.9 ms on this host; neither is native Hermes/GPU evidence.

The maximum held episodes remain 253/131 seconds. Several longest cases had
fixes already 70–140 seconds old and flat targets, so total guard-held time is
not synonymous with avoidable false-stop time. State stratification uses the
latest **reported fix state**, not proof of a vehicle's current state. Likewise,
position ahead of a recent at_stop fix is not a measured present stop overshoot.
Historical AVL errors compare the position already displayed at observation
time with the later-arriving fix; no future correction is retroactively scored
as a successful prediction. AVL timestamps and along-shape distance remain a
proxy, not rider ground truth. Source-model errors dominate these distributions.

The replay fixtures are public data, 3.7 MB combined compressed:

- `fixtures/tracking-2026-09-05-39min-ws.jsonl.gz`, uncompressed SHA-256
  `d23918abfdbf65560f1f6d78c4fcd257ce8ff11dac8910217d0770a60021c254`.
- `fixtures/tracking-2026-09-05-39min-geometry.json.gz`, uncompressed SHA-256
  `68c195a89ffa0ab05371abb854cc685d8a94b0cedc6212f02efc9e9bd5755754`.

```sh
npx tsx --tsconfig lab/tsconfig.runtime.json bench/src/replay-wire.ts \
  docs/testing/fixtures/tracking-2026-09-05-39min-ws.jsonl.gz \
  docs/testing/fixtures/tracking-2026-09-05-39min-geometry.json.gz 30 3600
```

Results: `results/tracking-2026-09-05-catchup-{baseline,1_3,2_5,4_0}.json`.
The baseline and 1.3/4.0 files retain the temporary prototype comparison; only
2.5 is the adopted shipping implementation. The standalone command reproduces
that version. The implementation records a single actual interval speed and
adds scalar arithmetic; it introduces no per-frame React or culling allocation.

Validation: 258 tests in 16 targeted suites pass, and TypeScript is clean.
Six new ownership tests cover launches at 10/30/60 Hz with interleaved future
probes, truth-driven braking without overshoot, long resumes and trip changes.
The preexisting geometry, UI reads, same-instant reads, fresh fixes, culling,
transport, clock, fallback and optional-velocity regressions also pass. Runtime
simulator/device and isolated candidate-backend evaluation remain separate
main-task delivery gates. `EXPO_PUBLIC_TRAJECTORY_CONVEX_URL` can route curves
and nonce clock to an isolated deployment while the fix feed stays on its
normal `EXPO_PUBLIC_CONVEX_URL`.

## Isolated candidate: paired public WebSocket capture

The 21:25–21:35 UTC window follows the isolated candidate restart/model load and
modal observation-clock correction (all curves ready 21:24:36 UTC). Production
was unchanged. Two real Convex clients received independent trajectory streams;
production AVL messages were copied byte-for-byte with identical receipt times.
Fresh nonce queries recorded request/receipt times. Geometry is a refreshed union
of the public pack. Both replays use the current client, join at exactly
1788643500000 ms, and run 600 seconds at 30 Hz: 2,801,580 known-geometry samples
and 1,765 matched historical AVL observations. This compares backend pipelines,
not the old application binary against the new one.

| Measure | Production curves | Isolated candidate curves |
|---|---:|---:|
| Guard-held vehicle seconds | 2,957.53 | 353.50 |
| Held with a moving target behind the rendered floor, s | 1,218.46 | 32.27 |
| Historical AVL MAE, reported at_stop / on_track, m | 155.55 / 69.86 | 119.35 / 71.55 |
| Historical AVL median absolute error, at_stop / on_track, m | 141.44 / 48.61 | 98.27 / 40.47 |
| Positive speed jump >1 m/s between contiguous frames | 0 | 0 |
| Backward ordinary frames / speed >25 m/s | 0 / 0 | 0 / 0 |
| Largest instantaneous braking change, m/s | 25.00 | 24.68 |
| Full-fleet CPU p99 on Node/M4, ms | 0.543 | 0.593 |

The on-track MAE regression is real in this sample despite improved median:
747 matched on-track observations include a worse upper tail. Several remaining
outlier vehicles were selected for independent raw-ML/opinion/smooth attribution.
This short evening sample is not a full-day or rider-ground-truth accuracy claim.
Production lacks the new nonce endpoint and remains explicitly clock-unsynced;
candidate ends with an estimated +7.3 ms offset. Native rendering cost is not
included in the Node CPU measurement.

Candidate guard-held time splits into 230.43 seconds with flat target, 59.87
with AVL older than 45 seconds, 32.27 with moving target behind the floor,
26.27 low-speed catch-up, 4.60 during backward target revisions, and 0.07 past
effective horizon. These categories use the first matching cause in that order
of priority: old AVL, expired horizon, reverse target, flat target, moving
behind floor, low-speed catch-up. They describe observed inputs, not a causal
proof that a physical tram was incorrectly stopped. The three longest candidate
holds were 32.5 seconds for #9440 (target behind by 0.55 m), 30.9 seconds for
#8763 (0.33 m), and 39.6 seconds for #9330 (5.54 m).

Reproducible fixtures and results are named
`tracking-2026-09-05-{production,candidate}-stable600s.*` and
`tracking-2026-09-05-paired-stable600s-geometry.json.gz`. The wire fixture includes
pre-join events to seed stream state and one post-window event to ensure identical
endpoints. Pass `30 600 1788643500000` after wire and geometry paths to
`bench/src/replay-wire.ts`. Results retain per-observation errors for exact matched
vehicle/trip/timestamp attribution.

## Clock, cold-start and viewer runtime regressions

A real nonce reply exposed two remaining clock bugs: offset interpolation started
at request midpoint instead of reply receipt, and presentation acceleration used
the corrected clock interval rather than elapsed local frame time. Both are fixed.
Offset estimation still uses midpoint; application is continuous from receipt.
The same paired early capture that had 21 positive >1 m/s jumps now has zero.
Tests cover delayed reply application and 10/30/60 Hz frame bounds while the clock
slews. A hanging first Convex query now marks the empty connection offline after
15 seconds without spawning duplicate pending queries. Late success recovers;
background cleanup cancels the watchdog and rejects obsolete completions.

Native Simulator profiling located the viewer hang in software OpenGL rasterization,
with queued PBR frames blocking the app's background transition. Rendering now has
an explicit Expo GL flush barrier; Simulator rendering uses a 640-pixel offscreen
target and vertex-lit Lambert materials. Authored geometry, paint, transparency,
textures and door/indicator mechanisms remain intact; metallic highlights are
approximate only in Simulator. Physical devices retain direct native PBR. The
opaque viewer route also stops hidden Mapbox frame/camera pushes without stopping
live subscriptions or ride recording. Contact-shadow smoothstep edges were ordered
to remove undefined shader behavior. Native repeated-interaction verification
remains required; one stress sample was confounded by concurrent Xcode diagnostics
consuming 11 GB on the 16 GB host.

Front/rear presets now fit the projected cab box (including the five-degree
camera elevation), while free whole-consist orbit keeps its bounding-sphere fit.
The GL surface occupies the space between the close control and the measured
bottom card. Layout changes preserve gesture state; explicit presets use the
current aspect. Twelve focused tests cover projected corner containment at three
aspect ratios, render target sizing/disposal, material fidelity, and reversible
mechanisms; TypeScript passes. Native cab/readability verification is pending.

## Source coherence and downstream error attribution (September 6)

The source-validity amendment adds a shared, cached check at fix/geometry changes.
A contradiction requires both reported non-null stop IDs absent from the served
trip and GPS more than 500 m from the reported shape-distance point. Missing
inputs alone are inconclusive. The client ignores curves/geometry for this key,
shows stationary stale raw GPS, and rechecks when fix or geometry changes;
observed pace is reset so recovery does not inherit a distance-axis jump.
The backend shares the same pure helper. Nine focused tests cover the captured
case, missing/nonfinite inputs, independent-evidence requirements, raw-GPS
culling and recovery. Full validation before the pause: 961 tests passed in
72 suites; the resumed geometry/frame/shadow subset passes 31 tests and TypeScript.

For #8772, exact segment projection (not nearest vertex) gives 78.04 m lateral
offset at route distance 11,891.53 m. GPS is 10,088.31 m from the reported s=0
axis point; neither last/next stop ID exists on this variant, and the reported
schedule is about 18.7 hours old. This is contradictory route/source input.
Automatically projecting onto that other variant would invent the route, and
its huge along-axis errors cannot be interpreted as measured physical overshoot.
The stored headline A/B numbers predate exclusion and retain this case.

An independent stop-ID audit of the paired capture found 1,929 at_stop fixes
within 30 m of a platform: 1,919 matched lastStopId, zero matched nextStopId.
Legacy learned dwell/release cells are keyed by nextStopId, but future drive
platform lookups use actual stop IDs. Cells also mix multiple predecessor
platforms at route branches; globally renaming them is not a lossless migration.
Current modal lookup is self-consistent with the legacy namespace and must not
be changed as a side effect. Backend owns a separately evaluated adapter.

Case #9511 demonstrates a different downstream loss. The request-stop rule
skipped U529Z2P at 9,899 m; the next planned stop U12Z2P at 10,533 m lies outside
the ML horizon. The no-crossing fallback therefore used the last 30 seconds'
ML tail pace (3.82 m/s) for the whole current leg. Pace-band and trim rules
produced a 5.88 m/s plateau lasting 59 seconds, although near-term ML movement
was around 13 m/s and the geometric envelope allowed 13.9 m/s. At the next
observation raw ML error was −27.76 m, opinion/smooth −229.12 m. A diagnostic
initial-speed reset alone improved reconstructed error to −193.39 m, with
baseline reconstruction error −0.11 m: inherited zero launch speed explains
only part of the loss; the later pace policy dominates this case.

A second offline intervention changes only no-crossing/no-target leg fallback:
while at least five seconds of ML support remains, use the secant over the next
up to 30 seconds from departure instead of the distant tail secant. All physical,
stop and pace-band constraints remain. It uses exact captured raw/modal/leader/
previous-chain inputs after the 21:50 UTC candidate restart; learned surfaces
were separately sampled in 250 m bins. Of 381 timestamp-eligible observation
pairs from 513 reconstructed emissions, 326 have both baseline reconstruction
errors ≤2 m (mean absolute 0.05/0.07 m for opinion/smooth).

| Faithful paired subset | Existing opinion / smooth MAE, m | Local-pace intervention, m |
|---|---:|---:|
| All 326 observations | 96.95 / 111.72 | 93.74 / 108.41 |
| 153 on_track observations | 70.04 / 83.05 | 67.94 / 81.06 |
| 173 at_stop observations | 120.74 / 137.08 | 116.55 / 132.60 |

This is **not adopted**: six observations worsen by over 30 m versus nineteen
that improve, and individual regression reaches 61 m. No new at_stop smooth
overshoot crosses +30 m (two resolve); one on_track case newly crosses it (two
resolve). Curve-speed, collision and mid-segment-stop violations stay zero;
opinion phantom-dip detections rise from two to four, while smooth falls from
ten to nine. This one-emission experiment preserves the actual inherited
history; it is not a chained rollout or a native-client final accuracy score.
It identifies a concrete policy defect and a possible correction, while its
mixed gate does not justify silently changing final runtime behavior.

The offline intervention is reproducible without editing drive.ts:

```sh
mkdir -p /tmp/tram-local-pace-replay
# Contains only captured public fixes, candidate diagnostics and derived surfaces.
tar -xzf docs/testing/fixtures/tracking-2026-09-06-local-pace-inputs.tar.gz \
  -C /tmp/tram-local-pace-replay
node lab/scripts/counterfactual-local-pace.mjs /tmp/tram-local-pace-replay
```

The runner transforms a private in-memory copy of the current driver and deletes
its temporary bundle afterward. It aborts if the intervention's source anchor
changes. Stored output:
`results/tracking-2026-09-06-local-pace-counterfactual.json`. A repeat with the
same captured inputs reproduced the output exactly. No policy is enabled by
adding this research runner.

## Final frozen client gate and native depth fix

With source coherence enabled, the same 600-second paired fixture retains
2,747,960 coherent frame samples and 1,741 historical observations per variant.
The excluded complete observation keys are #8504, #8772 and #9319. Every retained
historical displayed error matches the previous replay **exactly** (maximum
absolute change zero); the coherence change does not retune other vehicles.
Ordinary reverse motion, speeds over 25 m/s and positive >1 m/s frame jumps
remain zero. Guard-held seconds are 2,926.36 production / 353.17 candidate;
at_stop AVL MAE 155.39 / 118.50 m, on_track 68.18 / 69.66 m. CPU p99 was
0.67 / 0.60 ms on Node during a native build, not a device GPU benchmark.
Final outputs: `results/tracking-2026-09-06-{production,candidate}-final-replay.json`.

Build 30 native screenshots showed that replacing the custom shadow shader
with vertex-alpha material did not eliminate the ground wedges. That decorative
shadow has therefore been removed entirely, including its unused helper/test.
The same screenshot exposed severe side-window z-fighting: Three r162's WebGL1
render-target depth-only buffer is DEPTH_COMPONENT16, while near=0.1/far=600
quantizes depth by roughly 0.24–0.75 m at the 40–70 m overview distance. Authored
window layers are separated by only 8–11 mm. This explains clean Blender output
and broken native Simulator output without changing the physical geometry.

The viewer now projects the consist AABB onto camera forward and tightens
near/far to its depth extent plus a one-metre animated-door margin. Cab targets,
all orbit angles and close zoom are included; initial render errors also retain
the error state. Fourteen focused depth/cab/render tests pass and TypeScript is
clean. Native build 31 must verify the visual fix; mathematical depth bounds
alone are not pixel validation.
