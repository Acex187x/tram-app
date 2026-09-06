# Map source delivery audit — 6 September 2026

This audit separates continuous curve evaluation from what Mapbox can actually
receive. It follows renewed user feedback on build31. Native testing of the new
runtime is pending the next coordinated application build; no final visual or
thermal validation is claimed here.

## Reproduced structural defects

1. **Assembly spacing and mesh size disagreed.** The previous native style ramp
   enlarged individual GLBs up to5× while center-to-center section spacing,
   bellows gaps and coupled-car offsets remained physical1×. This causes rigid
   shells to overlap. Current feature construction uses the same sampled scale
   for centers, gaps, pair offsets and each feature's `displayScale` vector.
   Model head position stays fixed; the whole assembly extends behind it.
   The installed Mapbox `ModelLayer.swift` additionally documents that a
   zoom-dependent `modelScale` expression is unsupported for a GeoJSON model
   source. Per-feature scale avoids that restriction. Native z15/16/17 evidence
   remains mandatory, since TypeScript and pure geometry tests cannot prove
   actual model rendering.
2. **Far submissions were discrete.** The runtime notified every100 ms but dots
   were submitted every5 s belowz12.5 and every1 s in the middle band. A smooth
   curve therefore still appeared stationary between native source updates.
   The first candidate sampled visible-plus-margin points at10 Hz; detail remains~15 Hz
   points/~30 Hz sections. Native cost below motivated revised2.5/5 Hz coarse
   rates for the next build. Identical stationary and empty payloads are suppressed.
3. **Asynchronous native lookup could rewind a source.** RNMBXViewResolver polls
   up to10 s for a view. Without a token registered before lookup, an older
   callback could apply after a newer callback. The production C++ gate rejects
   superseded callbacks and preserves resolver errors. SourceWriter bounds each
   current source to one native write and one latest unsent payload; it exposes
   submitted, coalesced, pending, acknowledged and failure counts at1 Hz.
4. **Presentation reads must follow delivery ownership.** While any required
   geometry source is busy, no committing fleet getter runs and follow-camera
   retargeting pauses. Data ingestion continues. Hidden old/new rebase frames
   have distinct tokens, each awaiting all visible-source API acknowledgements.
   Acknowledgement confirms API execution, not GPU visibility.

`placeAt` already extended body-only negative section distances behind the first
route tangent. Expanded tests now cover all seven models, head0/5 m, and
zoom14.8/15.6/16.4/17, including coupled cars. Vehicle prediction itself does not
extend beyond the known route. The300 m section margin covers all current
oversized assemblies;600 m pre-allocation margin covers badges and selected/
followed vehicles are retained outside the viewport.

## Cadence cost — captured fleet, JavaScript only

[Full measurements](cadence-cost.json) replay168 vehicles from the existing
captured wire/geometry pair for60 s. Three repeats compare only submission
cadence through the same current feature builder; this is not old-binary versus
new-binary native performance. Native source calls are counted as opportunities,
and UTF-8 JSON size is measured before any native parser.

| Fixed viewport | Former cadence | 10 Hz | New JS cost /60 s |
|---|---:|---:|---:|
| City z11 |14 calls,9.5 KiB/s |602 calls,439.8 KiB/s |24.7–29.6 ms; frame p95≤0.057 ms |
| Badge z13.5 |122 calls,84.4 KiB/s |1202 calls,831.7 KiB/s |168.0–171.0 ms; frame p95≤0.322 ms |

The broad Prague bbox is deliberately demanding. JavaScript cost is small, but
~0.8 MiB/s of native JSON processing in badge mode still needs actual native
comparison. These numbers do not establish GPU cost, frame rate or phone heat.
Reproduce with `npx tsx --tsconfig lab/tsconfig.runtime.json
bench/src/map-delivery-cost.ts WIRE GEOMETRY`. The original local inputs are named
in the JSON artifact; the benchmark does not fabricate a new transit trajectory.

## Native baseline31

The already-installed iPad Pro11 M5 simulator was leased explicitly and its
CFBundleVersion31 verified before launch. [Fixed badge camera](native31-badge-baseline.png)
was left stationary for three30 s process CPU observations:13.29%,9.15%,18.25%.
Raw1 s samples and RSS are in `native31-cpu-{1,2,3}.json`. This is an unmatched live
fleet observation, not controlled replay; there was no native source counter in
build31. Simulator CPU on the M4 host is not physical iPad thermal evidence.

The camera stayed at the app's default center `[14.42,50.082]`, zoom13.8,
pitch45, with the inspector collapsed and no selected tram. A second adjacent
series at11:03–11:05Z measured8.30%,14.51%,7.96% in the same three30 s windows;
all samples remain in `native31-late-cpu-{1,2,3}.json`. Neither series is selected
as a favorable baseline; both show variation in this live observation.

Read-only motion harvest ran10:02:55–11:07:55Z,3899.914 s, in
`/tmp/tram-r2-sim-harvest-build31`. It collected116906 fresh rows across265
vehicle keys, spanning3895.844 s, with zero unavailable-container samples.
The51787 pre-existing rows are excluded from the
[compressed fresh log](../../testing/fixtures/tracking-2026-09-06-build31-hour-sim.jsonl.gz).
[Summary](build31-harvest-summary.json) splits sample counts and raw-fix ages by
Prague hour, central/outer zone and model. The candidate backend evolved during
this hour; this is build31 public-state sampling, not matched replay or native
GPU evidence. [End-of-hour screenshot](native31-badge-after-hour.png) records
the unchanged camera immediately before installing32.

## Verification status

Build32's unchanged default badge camera produced process CPU means34.77%,35.88%,
35.62% across three30 s windows after a30 s warm-up. Root's other app was stopped
during this series. [Screenshot](native32-badge-baseline.png) verifies camera/layout;
`native32-cpu-{1,2,3}.json` preserves the raw samples. Mean35.42% versus the adjacent
build31 mean10.25% is a material cost; these unmatched live observations still do
not isolate CPU cost of each individual implementation change or phone thermals.

Build33 uses400 ms belowz12.5,200 ms throughz14, and the existing
66 ms points/33 ms sections in detail. Selected/followed coarse targets retain
100 ms; an active transition among current rendered keys bypasses the due gate.
At Prague latitude the512-point Mapbox world gives3.52 m/point atz13.8: a200 ms
step at10/16.7/25 m/s is0.57/0.95/1.42 logical points before pitch/density effects.
Atz14− the values become0.65/1.09/1.63; atz12.5− and400 ms they are0.46/0.77/1.15.
These calculations use Mapbox's [512-pixel zoom scale](https://docs.mapbox.com/help/glossary/zoom-level/)
and iOS [point-based world size](https://docs.mapbox.com/ios/maps/api/10.9.1/Classes/Projection.html).
They bound center-scale movement, not measured projected screen error under
perspective. Native CPU observations below do not establish projected frame smoothness.

Build33 at the same unselected badge camera measured31.69%,31.37%,30.11%
across three30 s windows after30 s warm-up (mean31.05%). The other application
was stopped. [Screenshot](native33-badge-baseline.png) confirms the layout;
`native33-cpu-{1,2,3}.json` preserves samples. The reduction from build32 is only
12.3%, and cost remains materially above31. Builds32/33 had only30 s of warm-up,
whereas adjacent31 had run for an hour; cold geometry refinement and initial
presentation transitions may therefore confound the comparison. This is a cadence tradeoff, not a
completed performance or physical-device thermal acceptance. Build34 adds only
malformed-pack/coherence hardening relative to33; its normal render path shares
these rates, but the binaries are not identical.

A [five-second native sample](native33-map-sample.txt.gz) on33 shows mixed cost:
316/1673 JavaScript-thread samples execute React tasks (244 timer callbacks),
175/1673 main-thread samples traverse Mapbox draw, and68 samples occur on the
GeoJSON parsing queue. These are stack occupancy counts, not mutually exclusive
CPU percentages or measured source-call frequency. Hermes stacks lack JavaScript
function names, so the sample cannot isolate controller integration from badge
layout or JSON construction. Mapbox worker stacks also remain active. Actual
source counters and visual motion still need the coordinated native UI run.

The [adaptive cadence replay](cadence-cost-adaptive.json) compares the same
captured60 s fleet/current feature builder at normal unselected rates. City
source calls fall602→152 and JSON439.9→110.5 KiB/s; badge calls1202→602 and
831.8→416.6 KiB/s. Three-run JavaScript totals are6.6–7.5 ms for city and
86.7–88.0 ms for badges. These are cadence-only payload opportunities, not a
measurement of active-transition exceptions, native delivery acknowledgement,
or GPU frames. SourceWriter still suppresses unchanged stationary payloads.

- All seven models: scaled section contacts, front anchor, pair spacing and
  route-origin extension tests pass.
- Opacity expressions remain legal top-level zoom ramps; hiding carries through
  points, badges, models and hit/selection marks without deleting source identity.
- Production C++ latest-wins gate: reordered callback, failure, independent view,
  and10,000-cycle bounded-cleanup checks pass. Full patch reverse dry-run matches
  installed node_modules.
- Source tests: stationary/empty dedup, retry after error, remount,300-request
  native stall bounded to initial/latest writes, and both hidden acknowledgement
  barriers pass. UI snapshot cadence remains1 Hz.
- New native application build, actual map scale screenshots, source queue stats
  and CPU comparison are still pending.


A second [current-controller run](cadence-cost-current.json) includes explicit
virtual hidden-frame acknowledgements and captures geometry with each fixture
frame. Counts remain602/1202 and payload rates439.9/831.8 KiB/s; three-run
JavaScript totals are36.8–49.2 ms (city) and250.4–292.4 ms (badges), p95 at most
0.129/0.896 ms. Model generation was active on the same host in this later run,
so CPU-time differences between the two JSON files are not a runtime regression
claim. Both demonstrate that native parser/GPU cost, not JavaScript string
construction alone, requires measurement in the next app.

### Build34 warm follow-up

After five minutes of map warmup, three serial30-second native iPad Simulator samples measured24.30%,24.3867%,27.2833% process CPU (mean25.3233%). Raw observations are `native34-warm-cpu-{1,2,3}.json`. This is lower than build32's35.4233% and build33's31.0544% means, but remains above build31's10.2544%. Build31 had over an hour of geometry warmup, the fleet changed, and the host is a Simulator: these are observational delivery-cost measurements, not matched replay or physical-device thermal evidence.
