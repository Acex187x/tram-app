# Process & Tooling — how Tram Spotter was built and verified

Decision records for the *process*, not the product. Sibling files in this
directory cover the product decisions; this one covers how the code got written,
de-risked, tested, reviewed, and shipped. Grounded in git history, `docs/testing/*`,
`__tests__/`, `scripts/`, `package.json`, and `eas.json`.

---

## 1. Multi-agent build workflow (research → spike → parallel waves)

**Problem.** A single-threaded build of a real-time 3D map app (unfamiliar SDK,
live API, physics engine, 7 vehicle models, full UI) is slow and serializes
independent work. Expo SDK 57 / RN 0.86 (new architecture) is recent enough that
training knowledge is stale — see `AGENTS.md`: *"Expo HAS CHANGED. Read the exact
versioned docs before writing any code."*

**Decision.** Build in **waves**, each wave being a set of agents that own
disjoint files, coordinated through a shared type contract. The git history is the
record of the waves:

| Commit | Wave |
|---|---|
| `70ff...` Scaffold | research docs + `docs/architecture.md` + shared `src/lib/types.ts` + spike screen |
| `aae983c` Spike | on-device verification of the riskiest rendering assumptions |
| `0a3579a` Wave 2 | data layer + interpolation engine + v1 models + runtime hooks |
| `37dacad` UI foundation | root Stack, glass components, stores |
| `d415c3c` Mega-wave | 7 photo-referenced 3D models + map screen + every sheet |
| `77e193f` Fix wave | 21 verified review findings |
| `eca1084`/`acda059`/`7a38905` Iterations 2–4 | user-feedback rounds |

**Why this works.**
- **Contracts first.** `src/lib/types.ts` is declared the *single source of truth*
  (`docs/architecture.md`: "all modules import from it"). Agents in a parallel wave
  code against the shared types, not against each other's implementations, so their
  files compose without merge conflicts.
- **File ownership.** Each parallel agent owns specific files. The clearest example
  is the 3D-model tooling: `scripts/generate-tram-models.mjs` is explicitly
  structured so *"7 per-model agents can run in parallel without touching each
  other's outputs"* — each model id (`t3`, `t3rp`, `t3rplf`, `kt8d5`, `14t`, `15t`,
  `52t`) maps to its own builder file under `scripts/tram-models/` that writes only
  its own section GLBs.
- **Research is a first-class wave.** `docs/research/*.md` (golemio-api, mapbox-rn,
  prague-fleet, expo-ui-digest, glb-authoring) was written *before* the code depends
  on it. `docs/architecture.md` opens with "Read `docs/research/*.md` first — all API
  facts, versions and gotchas live there." This keeps version-specific gotchas in one
  place instead of rediscovered per agent.

---

## 2. Spike-first de-risking (empirical, on-device)

**Problem.** The whole app rests on assumptions about `@rnmapbox/maps` 10.3.2 /
Mapbox iOS 11 that are *not documented* and could invalidate the architecture:
does data-driven `ModelLayer` even work? Can GLBs load at all in a dev build? What
is the model's rotation convention? Getting any of these wrong late would be
catastrophic.

**Decision.** Before building the real engine or UI, ship a throwaway **spike
screen** (`src/app/index.tsx` at `aae983c`) that verifies the riskiest assumptions
*on the actual simulator*, and record the findings as durable conventions in
`docs/architecture.md` (§ "SPIKE-VERIFIED conventions").

**What the spike nailed down** (all empirical, dated, with SDK versions):
- Data-driven `modelId: ['get','modelKey']` and `modelRotation: [0,0,['get','bearing']]`
  **work** — the entire zoom-mode-3/4 rendering strategy depends on this.
- **GLB loading is broken via `require()` asset URLs in dev** (metro strips query
  params). Must use `Asset.fromModule(...).downloadAsync()` → pass `localUri`
  `file://` strings. This would have been a mysterious multi-hour failure if hit
  mid-build.
- **Model orientation convention**: author trams facing **−Z**, then
  `modelRotation z = bearing` faces correctly. A pure measurement, not a guess.
- `<StyleImport id="basemap">` does **not** exist over a direct `StyleURL.Standard`
  — later confirmed as the root cause of a real bug (see §4, finding #8).

**Why.** The cost of a spike is one screen and an hour; the cost of discovering
`require()` GLB loading is broken *after* wiring 7 models into a culling pipeline is
a day of confused debugging. **Verify the riskiest assumption first, cheaply, on the
real target.** The convention block in `architecture.md` is the durable output — a
future engineer inherits the answers, not the search.

---

## 3. Testing stack — 271 unit tests, jest-expo, by area

**Problem.** The engine (physics, schedule anchoring, DST math, planner graph) is
pure logic that is *hard to eyeball* and easy to regress, but the rendering /
gestures / native-glass surface can only be judged on a device.

**Decision.** Split verification by tractability:
- **Unit tests** for everything pure — run with `npm test` (`jest`, preset
  `jest-expo/ios`, `testMatch **/__tests__/**/*.test.ts`). **271 tests across 16
  suites**, all passing.
- **Device/E2E verification** for the rest (see §5).

**What is unit-tested** (`__tests__/`, tests per suite):

| Suite | Tests | Area |
|---|---|---|
| `tram-sim.test.ts` | 21 | per-tram physics/state machine (braking, dwell, pace, teleport) |
| `feature-builder.test.ts` | 38 | engine frame → GeoJSON, section placement, viewport culling |
| `gtfs-time.test.ts` | 28 | GTFS epoch conversion incl. DST spring-forward/fall-back |
| `polyline.test.ts` | 22 | cumulative distance, `pointAt`, `bearingAt`, curvature |
| `arrivals.test.ts` | 20 | stop-arrival computation |
| `speed-profile.test.ts` | 19 | curvature/zone speed-limit field + braking envelope |
| `model-viewer.test.ts` | 17 | interactive `/model/[id]` viewer (three + expo-gl) |
| `motionlog.test.ts` | 14 | telemetry buffering/flush/eviction (in-memory fakes) |
| `planner.test.ts` | 13 | network build, dedupe, bounded BFS |
| `engine-queue.test.ts` | 10 | shape-fetch priority queue + aging |
| `engine-projection.test.ts` | 7 | AVL observation projection/anchoring |
| `model-specs.test.ts` | 7 | fleet spec/section integrity |
| `fleet-registry.test.ts` | 5 | `regNumberToModel()` range mapping |
| `golemio-client.test.ts` | 4 | rate-limit window arithmetic |
| `stops-timeline.test.ts` | 4 | Prague-tz stop-time formatting |
| `planner-real-data.test.ts` | 1 | real-data planner geometry regression (see §4.1) |

Plus a standalone generator test `scripts/tram-models/cylinder-normals.test.mjs`
(runs via `node`, not jest) asserting all 72 cylinder side-triangles face outward —
guards the z-axis-normal bug from review finding #15.

**What is NOT unit-tested** (device-verified instead): Mapbox layer stacking / zoom
crossfades, ModelLayer rendering & taps, Liquid Glass chrome, camera follow,
form-sheet detents, location permission, background/relaunch recovery.

**Dependency-injection for testability.** Pure logic is kept pure so it can run
under jest without a device: `src/lib/engine/engine.ts` is *"pure TS, no React"*;
`src/lib/motionlog/core.ts` injects all I/O, time, location, and timers
(`MotionLogDeps`) so buffering/flush/eviction is testable with in-memory fakes.
(Note: `README.md` still says "171 unit tests" — stale; the real count is 271.)

---

## 4. Code review — multi-dimension review + adversarial verify → confirmed-fix waves

**Problem.** Agent-written code can be plausible-looking but subtly wrong,
especially in a physics engine where the bug is a slow drift, not a crash.

**Decision.** Run a **correctness-focused review pass** (`docs/testing/codex-review-1.md`)
that (a) explicitly excludes style/perf, (b) *traces callers and existing tests
before reporting*, and (c) states a concrete failure repro for each finding. Then a
single **fix wave** (`77e193f`) that lands **only verified findings** — 21 of them —
each accompanied by a regression test.

**Why the format matters.** Every finding in the review carries a *"Concrete
failure"* (specific inputs → wrong output). That is what makes a finding
*actionable and falsifiable* — and, in one case, *refutable* (§4.1). The review also
lists "Reviewed paths with no confirmed correctness defect" so the fix wave doesn't
re-litigate already-correct code (rate-limit window arithmetic, `pointAt`/`bearingAt`,
Expo File API usage).

**Representative confirmed findings** (from `codex-review-1.md`, fixed in `77e193f`):
- **[P0] Background resume dead runtime** — `stop()` removed the AppState listener,
  so foregrounding never restarted timers. The app froze on the last frame after any
  backgrounding. (`src/hooks/tramData.ts`)
- **[P1] Pace multiplier broke the braking envelope** — the ×1.65 catch-up factor was
  applied *outside* the hard speed cap, so a late tram could blow through curve/stop
  limits. Fix: clamp target inside `vAllowed`. (`src/lib/engine/tramSim.ts`)
- **[P1] DST-wrong GTFS epochs** — `serviceMidnight + seconds*1000` is off by an hour
  across Prague DST transitions (a service day is 23 h / 25 h, not always 86 400 s).
  Fixed with spring-forward/fall-back tests. (`gtfs-time.test.ts`)
- **[P2] Z-axis cylinder inward normals** — headlight/taillight bezels culled at
  oblique angles; single-sided materials. Fixed + generator test.

### 4.1 The false-positive adjudication (planner geometry)

**Problem.** The Codex E2E pass (§5) reported, twice, a **Major** bug: "planner
route continues far south beyond Národní divadlo" (`codex-report-1.md` §7,
`codex-report-2.md` §1). It looked deterministic and user-visible — a release
blocker.

**Decision.** *Refute it with real data before "fixing" it.* Commit `7ab527e` adds
`__tests__/planner-real-data.test.ts`: a regression harness that loads the **actual
cached GTFS geometries** from the simulator's app container
(`Library/Caches/tripgeo`) and asserts every itinerary's final leg polyline **ends
< 300 m from the destination stop**. It passes.

**Why it was a false positive.** Line 18 from Malostranská genuinely runs across
Mánesův most → along Smetanovo nábřeží (the riverside stretch Codex read as
"continues far south") → corner at most Legií → east onto Národní. The stop *Národní
divadlo* is on Národní ~150 m east of the river corner — exactly where the gold line
ends. Codex's visual judgment was a **geographic** misread, not a code defect. The
adjudication is recorded inline at the bottom of `codex-report-2.md`.

**Lesson.** An adversarial E2E screenshotter is valuable *and* fallible. When a
visual finding contradicts the code, resolve it with a **data-grounded regression
test**, not by editing until the screenshot "looks right." The test is now a
permanent guard (`describe.skip` when the real cache is absent, so CI stays green
off-device).

---

## 5. Codex E2E passes + simulator verification loops

**Problem.** No unit test can tell you the map actually renders, trams visibly move,
follow mode tracks, sheets open, or that Metro is error-free.

**Decision.** Drive the running app on the **iPhone 17 Pro simulator (iOS 26)** with
an agent (Codex), capturing a screenshot per step and a Metro log, then write a
**severity-tagged QA report** with per-finding repro + evidence filenames.

**The loop** (two documented passes):
- **Pass 1** (`codex-report-1.md`): full sweep — movement soak (5 min, fixed
  camera, live count 181→184), follow, detail sheet, search, favorites, planner,
  settings, relaunch/cache recovery, **Metro error scan**. Verdict: PARTIAL, 6
  Majors + a **10-entry Metro error count**.
- **Fix + Pass 2** (`codex-report-2.md`): focused re-test of exactly the pass-1
  findings + a regression sweep. Verdict: all fixed, **Metro `ERROR` count 0**, one
  finding adjudicated as a false positive (§4.1).

**Verification primitives** (referenced across the reports and the real-data test):
- **`simctl`** — launch/terminate, `get_app_container` to read the app's on-disk
  GTFS cache (the real-data test shells out to it).
- **Screenshots** — every step captures a PNG (`NN-description.png`) as evidence; the
  report references them by name so a finding is auditable.
- **Deep links / gesture bridge** — driving taps and navigation; the report is honest
  where the bridge was insufficient (far-out zoom "could not be reliably reached with
  the mouse-only gesture bridge — do not treat it as passed").
- **Metro log scan** — a case-insensitive `ERROR` count is a first-class release gate;
  pass 1 failed on 10 pre-existing errors (undefined identifiers in `RouteNetwork.tsx`,
  Mapbox layer/source failures), pass 2 gated on 0.

**Why.** The reports are deliberately *conservative* — they distinguish PASS /
PARTIAL / "unverified, do not treat as passed", and the Metro error count catches
runtime errors that never surface visually. The screenshot-per-step convention makes
every claim reproducible by a future engineer.

---

## 6. Build & deploy — EAS cloud vs local, and the lockfile failures

**Problem.** Ship an iOS build to real devices. Two paths: EAS cloud build, or a
local `eas build --local` + direct device install. The cloud builder is a *clean
environment* that surfaced dependency problems the local dev machine hid.

**Config** (`eas.json`): `appVersionSource: remote`, three profiles —
`development` (dev client, internal, `ios.simulator: false`), `preview` (internal,
auto-increment), `production` (auto-increment). Bundle `cz.zabolotny.tramspotter`.

**The EAS build failures and their fixes** (two consecutive commits):
- **`355294e` — model tooling broke the builder.** The 3D-model generation deps
  (`@gltf-transform/*`, `puppeteer`, `three`, `esbuild`, and the transitive `sharp`)
  were in `devDependencies`; `sharp` builds *from source* on the EAS builder and the
  toolchain was slow/broke `npm ci`. **Decision: model tooling is NOT in
  `package.json` at all.** Install it ad hoc with `npm i -D --no-save` only when
  regenerating models (documented in `README.md`). `jest`/`jest-expo` were moved to
  `devDependencies` at the same time.
- **`f7c0829` — stale lockfile.** The `package-lock.json` still carried "sharp-era"
  optional deps that broke `npm ci` on the builder. **Decision: regenerate the
  lockfile from scratch** (−828/+618 lines).

**Local path.** For fast device iteration the workflow is `expo run:ios` (dev client
on simulator) and, for physical hardware, a **local `eas build --local` + `devicectl`
install to iPhone/iPad** — avoiding the cloud round-trip. iPad support is a first-class
target (iterations mention explicit iPad fixes).

**Why the split matters.** Keeping heavy, build-only tooling *out* of the manifest is
the load-bearing decision: it keeps both `npm ci` on the clean builder and everyday
`npm install` fast, at the cost of a documented ad-hoc install step when models
change. The generator itself is self-validating — `generate-tram-models.mjs` reads
each GLB back and fails loudly on bbox / triangle-count / file-size violations, so a
broken model can't ship silently even without the app in the loop.

---

## 7. Motion-log calibration loop (built; recalibration is future work)

**Problem.** The physics constants (`A_LAT=0.98`, `A_BRK=1.2`, `A_ACC=1.0`, zone
caps, dwell fallbacks — see `docs/architecture.md`) are *hand-tuned guesses*. Ground
truth is how the real trams actually move, which only exists on real rides.

**Decision.** Ship telemetry now, recalibrate later. `src/lib/motionlog/core.ts` is
a *"pure, dependency-injected engine for collecting real-vs-sim telemetry so the
physics can be recalibrated later"* — two independent streams:
- **Passive daily log** (`motionlogs/<date>.jsonl`): one compact record per
  tram-with-geometry every poll — `{t,key,model,line,obsDist,simDist,projDist,devM,
  lat,lng,mode}`. Capped in-memory ring buffer, batch-flushed ≤ once/`FLUSH_MS`,
  whole directory capped ~8 MB (oldest evicted). A flush failure *never* throws into
  the map runtime.
- **Ride recording** (`rides/<ts>-<key>.jsonl`): while the user is physically on a
  tram, ~1 Hz GPS fixes correlated with the simulated state, auto-stopping after
  `RIDE_MAX_MS` to spare battery. Driven from `src/components/tram/RideRecorder.tsx`.

**Wiring** (`src/lib/motionlog/index.ts`): the singleton piggy-backs on the runtime's
1 Hz UI notifications (detecting a fresh poll via advancing `lastPollAtMs`) so the
map runtime file stays untouched; `stateProvider` reads sim state straight from the
engine. `devM` (observed-vs-simulated deviation) is the key calibration signal.

**Status.** The *collection* half is built, tested (`motionlog.test.ts`, 14 tests),
and shipped in iteration 4 (`7a38905`). The *recalibration* half — user exports logs,
physics constants re-fit against `devM` distributions per model/zone — is the planned
next step, not yet done. The data schema exists specifically so that future step
needs no app change.

---

## Quick reference

| Concern | Where |
|---|---|
| Shared contracts | `src/lib/types.ts` |
| Spike-verified native conventions | `docs/architecture.md` § "SPIKE-VERIFIED conventions" |
| Research (API/fleet/versions) | `docs/research/*.md` |
| Correctness review + findings | `docs/testing/codex-review-1.md` |
| E2E QA passes + adjudication | `docs/testing/codex-report-1.md`, `-2.md` |
| Unit tests | `__tests__/` (271 tests, `npm test`) |
| Real-data planner regression | `__tests__/planner-real-data.test.ts` |
| Build profiles | `eas.json` |
| Model tooling (not in manifest) | `scripts/generate-tram-models.mjs`, `scripts/tram-models/*` |
| Telemetry for recalibration | `src/lib/motionlog/*` |
