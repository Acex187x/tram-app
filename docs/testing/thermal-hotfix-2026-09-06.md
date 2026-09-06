# Build39 thermal regression hotfix

The user reported severe physical iPhone heating and application-wide lag after
build37. Earlier Simulator CPU comparisons were insufficient to validate the
physical thermal impact before that delivery. This hotfix addresses measured
unnecessary rendering and main-thread work; it does not assert that a physical
thermal soak passed.

## Changes and evidence

- Moving map data was synchronously decoded on the main thread. A build37
  process sample attributed151 of1630 main-thread samples to GeoJSON decoding.
  The patch now decodes immutable JSON on a serial background queue. Only source
  application/ACK is on main. Native tokens remain current through decoding,
  reject delayed obsolete lookups before they reach the view, and are consumed
  immediately before application. Removal, declarative shape/URL and animator
  changes invalidate pending decodes. The new stack shows decoding on
  `RNMBX.ShapeDecode`, not the main thread. C++ tests exercise both async races.
- Points and badges suppress changes below0.5 Mapbox style pixels against the
  last sent pose, before stringification. Presentation barriers bypass the gate.
  Render-only freshness uses1% steps. Stable overlap ties prevent badge slots
  oscillating on floating-point noise. See the [actual builder fixture](map-thermal-2026-09-06.md).
- Model viewing used an endless full-resolution PBR/4xMSAA rendering loop on
  phones, even with a stationary camera. It now renders only for input or a
  running mechanism. Doors/gestures cap at30fps; indicators request their400ms
  state edges. Automatic turntable rotation is removed. The idle scene schedules
  no timers/frames; materials, geometry and explicit-frame resolution remain.

## Runtime measurements

All numbers below are host CPU percentages for the iPhone17Pro Simulator, not
phone power, GPU energy, temperature or FPS. Default live badge camera, no
selection; debug panel enabled but unselected. Live input differs between runs,
so these are observational regression checks, not identical-feed benchmarks.

| Build | Samples | Mean CPU, one core | Median | Notes |
|---|---:|---:|---:|---|
|37|30|30.01%|28.75%|Original installed Release binary|
|38|60|22.58%|21.55%|Intermediate, before final badge tie fix|
|39|60|22.10%|21.75%|Final hotfix;297–300MiB during sample|

Build39 KT8 viewer stationary window:20 samples, mean3.745%, median2.7%,
maximum10.4%. This includes live-feed/background JS activity; the whole process
is not claimed to consume zero CPU. The viewport pixels were identical before
and after65 seconds idle. Native test then opened doors, backgrounded15 seconds,
resumed, changed the camera preset and closed successfully. CPU samples during
this window are in `results/thermal-2026-09-06/viewer-idle/top.txt`.

The simulator uses its separate640px Lambert/no-MSAA rendering path. The physical
PBR path has the same demand scheduler but is not visually or thermally validated
by these Simulator numbers. At close3D zoom meaningful geometry changes still
run at the existing30Hz budget; this patch does not promise a GPU reduction there.

## Validation and delivery

- TypeScript passed;105 Jest suites passed,1213 tests, one external-fixture test
  skipped. Actual native C++ gate race/cleanup tests passed.
- Release Simulator build39 succeeded. Native idle/resume test passed.
- Further mechanism/map UI and physical installation results are added below.
- No backend changes, deployment or push. Build37 binary retained locally.

Physical Instruments could not attach: it listed pipka as offline and timed out
waiting for boot, while CoreDevice reported paired, booted, developer mode on,
DDI available and an active network tunnel. CoreDevice process launch succeeded.
The user was asked to leave iPhone unlocked for profiling; no reply had arrived
at the time of these measurements. Do not treat the installation capability as
proof that Instruments profiling succeeded.

The standalone all-model UI harness initially failed before its first interaction
because `app.open` had no established accessibility session. Adding an explicit
`app.launch()` (as in the passing idle/resume test) fixes the harness startup;
the failed result remains at `/tmp/tram39-model-mechanisms-ui/Results.xcresult`.
This is recorded separately from the retry outcome.

Native build39 UI retry passed all seven models (doors, left/right indicators,
pinch, orbit, front/rear presets, background/resume), and the selected-map test
passed. Pixel checks within the3D viewport confirmed door, pinch and orbit
changes on each model and exactly two captured lamp states for both left and
right on every model. These checks establish visible state changes, not an FPS
measurement. A separate read-only lifecycle audit found no further blocking
issue;24 focused background/failover/cancellation/cadence tests passed.

Signed physical build39 succeeded and was installed on the paired iPhone17Pro
over the local network. CoreDevice app inventory independently returned bundle
version39. Source hashes had no drift between Simulator and device builds.
Only the iPhone appeared in the connected-device inventory; iPad installation
was unavailable. No push or backend mutation was performed.

Post-install process launch was denied explicitly because iPhone was locked
(CoreDevice10002 / FBSOpenApplicationErrorDomain7). Installation and version39
readback succeeded; no successful physical runtime launch or thermal measurement
is claimed for39. Open the installed app on the unlocked phone for review.
