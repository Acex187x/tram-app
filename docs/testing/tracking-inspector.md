# Tracking inspector — 2026-09-05

Enable Settings → Developer → Debug mode and select a tram. Following is
optional. The inspector starts collapsed, preserving map space. Tap its header
to open native segmented tabs: Overview, History, Server, Help (Russian labels).

- **Overview** distinguishes observation age, vehicle-profile emission age,
  fleet-publication age and local receipt age. It compares the rendered point
  with raw server SMOOTH/FIXED and the raw fix's route-axis distance. Client
  fix-forward and continuity guard are shown separately, including target gap
  and effective horizon. Future charts show only published curve coverage,
  never a clamped endpoint masquerading as forecast.
- **Geometry check** distinguishes a detected contradiction, insufficient evidence
  and no detected contradiction. Rejected geometry takes priority over generic
  loading or hold messages: the map uses the last GPS coordinates without
  extrapolation. Axis-distance history resets while geometry is unavailable;
  a passed check is not a claim of GPS accuracy.
- **History** keeps at most 61 samples/60 seconds for one trip and mode.
  Speed is the position difference between 1 Hz snapshots; gaps over 2.5 s
  are not connected. It is not an FPS or micro-jitter benchmark. The existing
  bounded fleet event journal records fixes, source/profile changes and jumps.
- **Server** reports the separate diagnostics endpoint independently of the
  Convex transport. Absent optional ML/publisher fields remain unknown. A failed
  diagnostics request does not imply a failed motion stream.
- **Pause** freezes the client snapshot, not the map. **Help** stops live panel
  sampling. User GPS is explicitly opt-in and described as noisy evidence,
  useful only while aboard the selected tram.

The inspector uses the existing native UISegmentedControl wrapper and one
Liquid Glass panel. Selection-specific compact/expanded hierarchy is informed
by [Apple's inspector presentation](https://developer.apple.com/videos/play/wwdc2023/10161/)
and [segmented-control guidance](https://developer.apple.com/design/human-interface-guidelines/segmented-controls).

## Performance and lifecycle

Panel React sampling is 1 Hz, foreground only, with timer cleanup on key change,
help, pause, background, opaque model-viewer routes and unmount. GPS is retained only while its visible
opt-in section is active. The map keeps its separate bounded 10 Hz imperative
ShapeSource trace path; no per-frame React state or declarative moving shape.
The trace subscription and shared diagnostics subscription also stop behind the
opaque model viewer. Actual fixed and smooth markers use the same corrected instant and both include
client-side presentation. Their connector is therefore distinct from the raw
server `deviationM`.

Map and server tab share one request stream per tram. Requests are sequential,
with an 8 s abort timeout and a 3 s delay after completion. Background and final
unsubscribe abort pending work; generation checks reject late responses.
No request registry entries remain after the last subscriber leaves.

## Verification

`npx jest __tests__/debug-diagnostics.test.ts __tests__/debug-overlay-cadence.test.ts __tests__/server-debug-lifecycle.test.ts __tests__/imperative-shape-source.test.ts --runInBand`

22 tests cover history bounds/trip changes/suspension, absent-versus-zero,
forecast endpoints, evidence-based hold/coast diagnoses, foreground cadence,
request coalescing/cancellation/key changes and imperative Mapbox sources.
Native layout, taps, scrolling, pause and background behavior require simulator
QA of the integrated build; these unit tests do not establish pixel quality.

### Integrated iPad QA, build 28 (23:17–23:21 CEST)

iPad Pro 11-inch (M5), iOS 26.5, Release candidate connected to the isolated
trajectory backend. Settings toggle, collapsed/expanded panel, empty-selection
guidance and selecting car 9302 from fleet search all worked through native
accessibility actions. Selection populated the inspector. Later code audit confirmed that opening from
fleet search also engages follow; this flow does not establish the no-follow case.
The panel showed distinct observation/profile/fleet/receipt ages, raw profile
positions, rendered position and future horizon. The [fresh screenshot](results/ipad-2026-09-05/inspector-overview.png)
records this state; the selected marker remained visible below the panel.

Pausing held the panel at 23:19:02 while the vehicle card advanced from
Dělnická through Tusarova toward Holešovická tržnice and fleet counts continued
changing. Resume and background/foreground also worked with the same process:
the panel returned to current snapshots at 23:21:37. Segmented tabs and scrolling
remain to be completed; the computer-use coordinate backend returned
`noWindowsAvailable` despite working accessibility actions and screenshots.

The same build's model viewer exposed a separate native rendering backlog:
the controls updated but the GL image did not, and backgrounding waited on
the GL queue. The process sample had all 2,340 main-thread samples waiting in
deactivation notification dispatch and all 2,340 `host.exp.gl` samples in
`EXGLContext.flush`, predominantly software `GLRendererFloat` draw calls.
CPU was 100% and footprint 845 MB. [Failure screenshot](results/ipad-2026-09-05/viewer-frozen-build28.png)
shows Doors enabled while the geometry remains closed. This is an unresolved
build-28 runtime finding, not a validation of the animation controls.

### Native XCTest follow-up (23:40 CEST)

The separate UI runner in `scripts/testing/` compiled and launched against the
already-installed app. Its adjusted inspector flow passed in 40.4 s, exercising
all four native segments, server-panel scrolling, pause/resume,
background/foreground and collapse. Native XCTest exposes the actual segmented
buttons even though the macOS accessibility bridge returned only a tab group.

The first run also revealed that the left-aligned inspector covered the iPad
home Settings/search header. The regular-width panel now has an explicit 440 pt
width at the right edge; compact width retains its top placement. That layout
fix requires verification in a build containing it. A settings deep link let
the already-built native flow proceed independently of the obstruction.

The first harness run failed due to that obstructed entry and outdated viewer
accessibility labels. Its automatic Xcode failure diagnostics occupied 9 GB and
spent several minutes importing system logs. Summary and explicit attachments
were retained, then that completed disposable result bundle was removed.
Subsequent runs use documented `-collect-test-diagnostics never`; assertion
results, screenshots and test activity logs remain available.

### Full native interaction run before build 29 (23:38–23:43 CEST)

Both XCTest methods passed: inspector 40.4 s and all seven model flows, 282.3 s
total, zero assertion failures. The model flow exercises front/rear/whole
presets, door open/close, both indicator segments, orbit drag and returning
from background for every family. The 107 named screenshots are retained in
`/tmp/tram-ui-tests-candidate-20260905-r3/attachments/`; the authoritative
result bundle is adjacent. Control assertions alone do not prove rendering.

Visual review separately confirmed changed front/rear viewpoints and open
versus closed door geometry on T3, 14T and 52T, including the complete 52T
front destination and rear line number. It also found white triangular ground
artifacts and excessive whitespace around whole-tram views. Those findings
prompted the shadow-shader and viewport-fitting changes in build 29; a fresh
run against that build must establish whether they are resolved.

### Build 29 native validation (23:49–23:55 CEST)

The integrated iPad binary includes the right-edge inspector, opaque-viewer
route suspension and simulator-specific 640 px Lambert rendering. Real Settings
taps succeeded both with the collapsed and expanded inspector. The initial
scroll assertion used the wrong native class: Fabric places the test identifier
on an `Other` wrapper around the actual `ScrollView`. The harness was corrected
to this observed hierarchy, without changing runtime code. Its fresh inspector
run passed in 48.59 s, including an assertion that the server card actually
moved vertically after a gesture inside that scroll view.

Fresh evidence: [selected overview](results/ipad-2026-09-05/inspector-selected-overview-build29.png),
[scrolled server panel](results/ipad-2026-09-05/inspector-server-scrolled-build29.png),
[history](results/ipad-2026-09-05/inspector-history-build29.png),
[collapsed panel](results/ipad-2026-09-05/inspector-collapsed-build29.png).
The full native result is `/tmp/tram-ui-tests-candidate-20260905-r5/Results.xcresult`.

All seven model interaction flows passed again in the preceding R4 run. Fresh
visual review confirmed the larger head-on/rear view fits above the control
card, door geometry changes, complete 52T rear line number, and live right
indicator changes in all seven families. Pixel differences across timed lamp
samples are localized to the visible right lamps. The default whole-tram view
hides the far-side left lamp, so the next harness run samples both sides from
the front. White triangular ground artifacts persisted in this build; the 14T
front destination also showed dark geometry interference. Both were reported
for a later integrated fix. Passing control assertions does not close these
visual defects. R4 screenshots remain in
`/tmp/tram-ui-tests-candidate-20260905-r4/attachments/named/`.

**Evidence correction:** the native fleet-search entry calls `openTram`, which
also engages camera follow. Earlier run notes describing this as selection
without Follow overstated the test. The inspector accepts a selected key even
when the follow key is absent, but these fleet-search runs do not independently
exercise that state.

### Build 30 native validation (2026-09-06, 07:52–07:58 CEST)

Two UI methods passed and 121 explicit screenshots were retained. The geometry
check card showed a valid contradiction check with 48.8 m GPS-to-axis distance,
while the independent trajectory stream correctly showed no received profiles.
The [server tab](results/ipad-2026-09-06/inspector-server-build30.png) exposed
`Trajectory seed timed out waiting for the server`, 0 curves and unsynchronized
clock; the lab-debug request remained healthy. Background/foreground during
this short interval did not recover it. This occurred around the isolated
backend's restart/OOM recovery; it is degraded-state evidence, not a tracking
health pass. The next harness run explicitly requires fresh publication state
and an advancing sequence.

The [14T front](results/ipad-2026-09-06/14t-front-build30.png) now has a clean
destination display, but white ground wedges and side-surface interference
remain visible. Root/client are addressing these in build 31. Door and pinch
interactions ran for all seven families. Timed head-on screenshots now expose
both sides, with changed left and right lamp pixels in every family.

### Build 31 iPad validation (2026-09-06, 08:02–08:08 CEST)

All three native methods passed: inspector, all seven model mechanisms, and
selected 3D map geometry. The inspector now explicitly requires a fresh
trajectory connection and a changing publication sequence over 5 s. Both checks
passed after the backend recovered; the [server snapshot](results/ipad-2026-09-06/inspector-server-build31.png)
records the healthy stream separately from the lab diagnostics request.

Fresh visual review confirmed the [14T front destination](results/ipad-2026-09-06/14t-front-build31.png),
[whole-tram side glazing](results/ipad-2026-09-06/14t-doors-closed-build31.png) and
[52T rear line number](results/ipad-2026-09-06/52t-rear-build31.png) are clear.
The previous white ground wedges and diagonal side-glass interference are no
longer present in these views. Timed lamp samples contain visible left/right
changes for every model; open/closed door and before/after pinch samples also
differ in the canvas, independently of control values.

The [actual Mapbox frame](results/ipad-2026-09-06/map-selected-detail-build31.png)
shows selected 15T 9296 and another articulated tram at close 3D zoom. No previous
diagonal glass/body corruption is apparent at this screenshot's resolution.
It is a native map sample, not the separate Three.js model viewer.
The [test summary](results/ipad-2026-09-06/xctest-build31-summary.json) and
`/tmp/tram-ui-tests-candidate-20260906-r7/Results.xcresult` retain provenance;
123 named screenshots are exported under `attachments/named/`. Explicit
screenshots and test activity logs were retained; no standalone MP4 is claimed.
Physical-device rendering/thermal behavior remains a separate delivery check.

### Build 31 compact iPhone validation (2026-09-06, 08:12 CEST onward)

The seven-model native interaction method passed on iPhone 17 Pro Max Simulator
in 285.8 s. Fresh front/rear inspection confirmed complete destination displays,
cab framing above the control card, and no recurrence of the white ground
wedges or diagonal glass interference in the reviewed views. Evidence includes
[14T whole side](results/iphone-2026-09-06/14t-doors-closed-build31.png),
[52T front](results/iphone-2026-09-06/52t-front-build31.png), and
[52T rear](results/iphone-2026-09-06/52t-rear-build31.png).

The first phone run's inspector and map methods failed before fleet selection:
they tried to tap Browse the fleet in the offscreen body of the compact home
sheet (native frame y=1270). The phone deliberately starts at the peek detent.
The harness now uses the visible pinned Search action in that state; both
entries open the same fleet-search screen. This was a harness correction, with
no runtime change. The retained [first-run summary](results/iphone-2026-09-06/xctest-models-build31-summary.json)
therefore contains one passing model method and two failed navigation methods,
not a full-suite pass. R8 attachments are under
`/tmp/tram-ui-tests-candidate-20260906-r8/attachments/named/`.

The focused R9 retry passed both inspector and map methods (76.1 s total),
including Settings reachability, all four native segments, actual content
scrolling, pause/resume, background recovery, and fresh/advancing trajectory
publication. The [server panel](results/iphone-2026-09-06/inspector-server-build31.png)
shows 135 profiles/publication 358, drive-v3, +88 ms clock offset, and a separate
successful ML diagnostics response. The [overview](results/iphone-2026-09-06/inspector-selected-overview-build31.png)
keeps observation/profile/publication/receipt ages distinct. The
[compact native summary](results/iphone-2026-09-06/xctest-inspector-map-build31-summary.json)
and `/tmp/tram-ui-tests-candidate-20260906-r9/Results.xcresult` retain the outcome.

The [selected native map](results/iphone-2026-09-06/map-selected-detail-build31.png)
shows 14T 9128 near Dělnická with the collapsed inspector. It reports a stationary
marker for six seconds despite a future path and a 36.3 m fixed/smooth gap.
This is useful evidence of a hold, not proof of a physical stop or proof that
all tracking stalls are resolved. The stop card says AT STOP NOW; identifying
the hold's cause requires the corresponding timeline/profile evidence. The
map's visible roof/sections have no obvious diagonal corruption, but this
mostly overhead view is not a full side-glass inspection.

### Post-served-platform backend smoke (2026-09-06, 08:42–08:43 CEST)

After the isolated Lab deployment at 06:39:01Z, R10 reran only the inspector and
map methods on the unchanged installed build 31. Both passed (75.57 s); the
new simulator lease and build slot were released. The unchanged seven-model
flows were not repeated. The [native test summary](results/iphone-2026-09-06/xctest-postserved-build31-summary.json)
and `/tmp/tram-ui-tests-candidate-20260906-r10/Results.xcresult` retain provenance.

At 08:42:25 the [overview](results/iphone-2026-09-06/inspector-selected-overview-build31-postserved.png)
showed tram 9128 moving at 31.4 km/h, AVL age 10.5 s, vehicle-profile age 2.7 s,
fleet-publication age 0.8 s and receipt age 1.9 s. These are separate observations;
fresh publication alone does not establish fresh source AVL. At 08:42:44 the
[server tab](results/iphone-2026-09-06/inspector-server-build31-postserved.png)
showed 140 profiles/publication 758, +143 ms clock offset, no registered transport
error and a healthy separate ML response. The publication advanced during the
five-second test sample.

The [map at Větrník](results/iphone-2026-09-06/map-selected-detail-build31-postserved.png)
again captured a stationary marker for six seconds with a future path. Here
FIXED and SMOOTH coincide (displayed delta 0.0 m), with a 13-second anchor and
4.9 m anchor gap; the card says AT STOP NOW. This is a coherent curve hold at
the displayed stop, unlike the earlier 36.3 m fixed/smooth separation. The
snapshot still cannot prove a real physical stop or attribute the policy
regime; backend replay/debug evidence validates the consumed-platform change.
