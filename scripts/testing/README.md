# External-app XCTest UI harness

The harness tests the **already installed** `cz.zabolotny.tramspotter` app using
Apple XCTest/XCUIAutomation. It does not modify the Expo project or rebuild the
app. The standalone target generates its own temporary UI runner. It is useful
when macOS computer-use coordinates are unavailable while native iOS testing
remains supported.

Acquire an exact simulator lease with `ios-resource` first. Install the intended
app build on that UDID, release the app-build lease, and retain/heartbeat the
simulator lease through testing. Then run:

```sh
IOS_SIMULATOR_UDID='<leased UDID>' scripts/testing/run-ui-tests.sh
```

The script obtains the build slot through `ios-resource build run`, disables
parallel simulator testing, and writes a unique `/tmp/tram-ui-tests-…` directory. Automatic sysdiagnose/log
archive collection is disabled (`-collect-test-diagnostics never`); explicit
screenshots and XCTest assertion results remain retained.
It leaves the leased simulator running for further review; its owner must
release it afterward. Never use `booted` or let Xcode select another device.
Set `TRAM_UI_TEST_OUTPUT` for a new output directory. Set `TRAM_UI_ONLY_TEST` to
`TramSpotterUITests/TramSpotterUITests/test01Inspector` or
`TramSpotterUITests/TramSpotterUITests/test02AllModelMechanisms` to focus one flow.
`TRAM_UI_SKIP_TEST` accepts the same method format to exclude an already-verified
flow during a focused retry. On the phone's compact home detent, fleet entry
uses the visible pinned search control; the offscreen body row is not tappable
until the sheet expands. On the tall iPad sheet it uses Browse the fleet.

`test01Inspector` enables Debug mode, selects a live tram through fleet search (which engages follow), opens
native Overview/History/Server/Help tabs, pauses/resumes, scrolls inside the
panel, verifies fresh and advancing trajectory publication metadata,
backgrounds/foregrounds and collapses it. Live service availability is a
prerequisite for populated states. `test02AllModelMechanisms` opens all seven
models using `XCUIApplication.open(URL)` (iOS 16.4+), exercises front/rear/whole
presets, doors, both indicator sides from the front, pinch zoom, a drag orbit, background/foreground and
close. The map-detail test zooms through native map gestures, opens a fleet vehicle
and captures its selected 3D map state. `test04AssemblyZooms` remeasures camera zoom after each pinch and captures
selected articulated assemblies at15/16/17 (±0.15), including source counters.
`test05ViewerRotation` checks15T and PLF front/rear framing in both actual iPad
orientations; phones skip that iPad-specific test.
`test06RideTimingMetadata` checks2 eligible and3 excluded predictions with
individual unknown/timestamp/future-input reasons on a synthetic ride row.
The runner stages only `ui-only-timing-fixture.jsonl` in the leased app container
and removes that exact unchanged file on exit; it refuses to overwrite or delete
a changed file and leaves all other rides intact. The fixture is UI-only, never
a GPS or prediction-accuracy validation.

All tests retain screenshots in the xcresult and the script extracts
attachments after success or failure when an xcresult exists.
`test-summary.json` preserves the machine-readable outcome; `attachments/named/`
contains explicit screenshot copies with readable model/state names. The original
manifest retains device and timestamp provenance. Failed exports never change
the native test exit status into success.

**Assertion limits:** control existence and selected/switch values are checked;
image geometry, clipping, movement, lamp timing and smoothness require inspection
of the fresh attachments or an accompanying recording. A green test run alone
is not proof that the GL canvas moved. Native segments missing accessibility
labels fail explicitly rather than being silently skipped.

Prepared against Xcode's installed iOS 26.5 XCUIAutomation headers. The project
plist and shell syntax are checked. The first leased run compiled and launched
the target successfully; selectors were adjusted to the observed native tree.
Runtime/visual results are recorded separately; this README is not a pass claim.

Skin Files import/preview is an opt-in native test because the library normally starts empty. Set `TRAM_SKIN_FIXTURE=/tmp/qa-uv-kt8.skin.json` and `TRAM_UI_ONLY_TEST=TramSpotterUITests/TramSpotterUITests/test07SkinImportAndPreview`. The runner verifies the synthetic package identity, stages one Documents file, and removes that unchanged staging file afterward. Test07 exercises import, synthetic777777 assignment/reset, embedded-texture viewer doors/front/rear and same-ID replacement. It leaves the imported synthetic library record for a separate bounded Mapbox visual check; remove that record after QA. Never copy the synthetic library/assignment into a delivered physical-device container.
