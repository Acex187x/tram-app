# Correctness review 1

Scope: all code under `src/` and `scripts/tram-models/lib.mjs`, with callers and existing tests traced before reporting. This review intentionally excludes style-only and performance-only observations.

## Baseline

- `npm test` did not reach Jest because Watchman could not access its sandbox socket (`Operation not permitted`). Running the identical suite with Watchman disabled (`npm test -- --runInBand --no-watchman`) passed: 8 suites, 136 tests.
- `npx tsc --noEmit` passed with no diagnostics.

## Findings

### 1. [P0] The live runtime cannot restart after the app returns from the background

**Location:** `src/hooks/tramData.ts:75-89`

**What breaks:** `onAppState` calls `stop()` for every non-active state. `stop()` removes `appStateSub`, so there is no listener left to receive the later `active` transition and call `start()`. `refCount` remains positive, but all three intervals stay null permanently.

**Concrete failure:** Open the map, background the app once, then foreground it. Polling, simulation ticks, frame notifications, and 1 Hz UI updates never resume; the map freezes on the last fleet state.

**Suggested fix:** Separate “pause timers/network work” from final teardown. Keep the `AppState` subscription installed while `refCount > 0`; remove it only when the last consumer releases the runtime. On `active`, restart the timers and trigger an immediate poll.

### 2. [P1] Fresh AVL positions are ignored after a simulation is created

**Location:** `src/lib/engine/tramSim.ts:189-200` (caller: `src/lib/engine/engine.ts:145-146`)

**What breaks:** `applySnapshot()` stores the new snapshot but computes correction exclusively from the timetable anchor. It never reads the new `snapshot.shapeDistM` or `snapshot.observedAtMs`. Even the hard teleport target is `sSched`, not the observed AVL position. Thus the initial poll is the only live distance observation that anchors a same-trip sim.

**Concrete failure:** A tram loses two minutes between stops while its last-stop delay has not updated yet. Subsequent polls report the tram 200 m behind through `shape_dist_traveled`, but the error is below the 500 m timetable threshold. The renderer continues toward the timetable position and can remain hundreds of metres ahead of the actual tram.

**Suggested fix:** On every snapshot, project `shapeDistM` from `observedAtMs` to `nowMs` (bounded by the schedule pace and geometry), and reconcile toward that observation. Use the projected observation—not `sSched` alone—for teleport/error correction; keep the timetable anchor as a low-gain pace reference.

### 3. [P1] The pace multiplier invalidates the braking envelope and hard speed caps

**Location:** `src/lib/engine/tramSim.ts:225-233`; envelope contract at `src/lib/engine/speedProfile.ts:74-82`

**What breaks:** `vAllowedAt()` returns the maximum speed from which all upcoming zero/curve/zone limits remain reachable with `A_BRK`. `tick()` then multiplies that maximum by up to 1.65. A late tram can therefore cruise above the network/zone/curve cap and postpone braking until it is physically impossible to meet the constraint at `A_BRK`. The later stop snap hides the overshoot but not the invalid approach motion.

**Concrete failure:** With a positive schedule error, a 3.5 m/s curve limit becomes a 5.8 m/s target. On a stop approach, a 10 m/s braking-envelope value becomes 16.5 m/s, so a tram already moving at 13.9 m/s does not brake where the envelope requires it to.

**Suggested fix:** Apply pace control inside the hard envelope, for example `vTarget = Math.min(vAllowed, schedulePace * factor)`, or apply only a bounded additive correction and clamp the final target to `vAllowed`. Tests should assert curve/zone/stop constraints under the maximum positive schedule error, not merely the 1.65 catch-up ceiling.

### 4. [P1] New/reanchored simulations silently skip a stop when initialized near it

**Location:** `src/lib/engine/tramSim.ts:120-129`, called from `createSim()` at `:171` and `reanchorSim()` at `:181`

**What breaks:** `markStopsBehind()` marks every stop with `stop.distM <= sim.sM + STOP_REACH_M` as already dwelled. A stop up to 2 m *ahead* is therefore removed from both `nextUndwelledStop()` and the zero-speed braking constraints. The live `statePosition`, last/next stop sequence, and scheduled departure are not used to initialize a dwell.

**Concrete failure:** Geometry loads while a tram is 1 m before a stop, or while the feed says it is `at_stop`. Creation marks that stop complete. The tram accelerates through it without entering `dwell`; the UI also reports the following stop as next.

**Suggested fix:** Mark only stops unambiguously behind the observation, preferably using `lastStopSequence`/`nextStopSequence`. If the observation is at a stop, initialize `phase = 'dwell'` and derive the remaining dwell from the scheduled departure/feed state. Do not use the forward reach tolerance when seeding dwell history.

### 5. [P1] GTFS epochs are one hour wrong across Prague DST transitions

**Location:** `src/lib/golemio/gtfs.ts:225-240` (and candidate windows at `:97-100`)

**What breaks:** GTFS clocks are Prague wall-clock values, but the code converts them with `serviceMidnight + seconds * 1000`. A local service day is not always 86,400 elapsed seconds: the spring transition has 23 hours and the autumn transition has 25. The offset at midnight cannot be reused after the transition.

**Concrete failure:** On 2026-03-29, Prague midnight is 2026-03-28 23:00Z. A GTFS arrival of `03:30:00` means 03:30 CEST = 01:30Z, but the current addition produces 02:30Z—one hour late. Autumn trips are shifted in the opposite direction after the repeated hour.

**Suggested fix:** Convert each GTFS clock as a Prague-local date/time: split overflow hours into a service-date day offset plus wall-clock time, then resolve that local timestamp with `Europe/Prague` (or a small tested local-to-UTC resolver). Use the same conversion when comparing candidate service-day windows. Add spring-forward and fall-back tests.

### 6. [P1] Selecting a tram cannot promote its already queued geometry request

**Location:** `src/lib/golemio/shapeCache.ts:88-89,115-124`; immutable queue priority at `src/lib/golemio/client.ts:59-63,91-103`

**What breaks:** The first citywide poll enqueues a background task for every missing trip and records each in `inFlight`. `prioritizeTrip()` calls `requestPrefetch(..., 0)`, but `requestPrefetch()` skips every trip already in `inFlight`. The scheduler waiter retains its original priority forever. The API advertised as raising selected/followed geometry priority therefore does nothing in the common case.

**Concrete failure:** On a cold cache with hundreds of active trips, a tapped tram whose background request is late in the 16-starts-per-8-seconds queue can remain off-shape for minutes, even though the caller requests urgent priority. New urgent polling continues to jump ahead of it as well.

**Suggested fix:** Represent queued requests with a promotable queue handle, or keep the fetch out of `inFlight` until acquisition and allow a later caller to lower the waiter's numeric priority. Add aging/reservation so a sustained higher-priority stream cannot starve old work. Preserve single-flight promise sharing after promotion.

### 7. [P1] The planner expands duplicate trips as distinct routes and can miss valid itineraries

**Location:** `src/lib/planner/network.ts:66-113`; bounded search at `src/lib/planner/planner.ts:58-67,69-105`

**What breaks:** The geometry cache is keyed by `tripId`, so many vehicles contribute identical stop sequences for the same line and direction. `buildNetwork()` inserts every one as a distinct `LineSequence`. The DFS then re-explores the same rides and transfers combinatorially; result signatures deduplicate only after the work. Once `MAX_EXPANSIONS` is exceeded, later branches are silently abandoned, making results dependent on cache insertion order.

**Concrete failure:** With 15–30 loaded trips per direction across several lines at a hub, identical first legs multiply identical transfer recursion. The 20,000-expansion guard can be consumed before the sequence containing the requested second transfer is visited, yielding “No route found” despite a valid loaded path.

**Suggested fix:** Deduplicate network sequences before indexing them, using at least `line + ordered station keys` (and direction/shape when geometrically distinct). Then run a real bounded BFS/Dijkstra over `(station, line, transfers)` states with a best-cost/visited map, so completeness within two transfers is independent of insertion order.

### 8. [P1] Map light presets are applied to an import that does not exist

**Location:** `src/app/index.tsx:159-187`; intended root style in `src/components/map/mapStyle.ts:53-71`

**What breaks:** The map mounts the direct Standard `styleURL`, then mounts `<StyleImport id="basemap" existing>`. The adjacent style module documents that direct Standard has no `basemap` import and provides `buildMapStyleJSON()` specifically to create one, but that function is never used. Consequently live relighting is rejected and settings/automatic dawn-day-dusk-night changes do not apply.

**Concrete failure:** Change Settings → Light preset from Day to Night. The Zustand value and React props change, but Mapbox cannot update import `basemap`; the rendered Standard lighting remains unchanged.

**Suggested fix:** Mount the generated root style through the MapView `styleJSON` prop (and initialize it with the resolved preset), then use `StyleImport existing` for later config changes. Do not simultaneously mount the direct Standard `styleURL`.

### 9. [P2] Articulated sections overlap at the beginning of a shape

**Location:** `src/lib/render/featureBuilder.ts:81-113`

**What breaks:** Each negative section-center distance is independently clamped to zero. Near the start of a trip, all rear sections—and a coupled second car—can therefore receive the same coordinate and bearing instead of retaining their physical spacing.

**Concrete failure:** A three-section 15T whose head is 5 m into the shape places all three GLBs at or near vertex zero. They render superimposed until the head has advanced roughly a full tram length.

**Suggested fix:** Extrapolate negative distances backward from the first non-degenerate segment bearing, or suppress sections that cannot yet be placed. Keep the signed along-track center distance until the final coordinate lookup rather than clamping every center to the same point.

### 10. [P2] Fallback stop projection can make stop distances non-monotonic on looped shapes

**Location:** `src/lib/golemio/gtfs.ts:116-155,227-233`

**What breaks:** When `shape_dist_traveled` is null, each stop is projected independently to the globally nearest segment. At a loop, crossing, or repeated station coordinate, equal/near-equal candidates select the first segment encountered, regardless of `stop_sequence`. The resulting stop distance can move backward relative to the preceding stop, breaking schedule interpolation, dwell ordering, and planner legs.

**Concrete failure:** An inbound stop near a turning loop lacks distance metadata and lies equally close to an outbound segment visited earlier in the shape. It is assigned the outbound distance, so `nextUndwelledStop()` returns stops out of travel order and `buildScheduleAnchor()` interpolates decreasing distance.

**Suggested fix:** Project stop times in sequence and choose among candidates subject to `distM >= previousDistM` (with a small tolerance), optionally using the next known GTFS distance as an upper bound. Validate/clamp the final stop-distance series as monotonic and reject irrecoverable geometry.

### 11. [P2] Planner polylines omit their actual endpoints and can disappear entirely

**Location:** `src/lib/planner/network.ts:124-140`; consumer skip at `src/components/map/PlannerOverlay.tsx:23-25`

**What breaks:** `sliceCoordinates()` returns only existing shape vertices whose cumulative distances fall between the stop distances. It does not insert interpolated points at `fromDistM` and `toDistM`. If two stops lie on one long shape segment, the slice contains zero or one vertex; the overlay then drops the leg because it has fewer than two coordinates.

**Concrete failure:** Plan a one-stop ride whose two stop distances fall between the same pair of GTFS shape points. The itinerary card is valid, but no route line is drawn for that leg and camera fitting may omit it.

**Suggested fix:** Start with `pointAt(..., fromDistM)`, append strictly interior vertices, and end with `pointAt(..., toDistM)`, deduplicating coincident points. Reverse the result if reverse traversal is later supported.

### 12. [P2] Stop times display in the device timezone instead of Prague time

**Location:** `src/components/tram/StopsTimeline.tsx:22-25`

**What breaks:** Route stop epochs are Prague schedule instants, but `fmtClock()` uses `Date#getHours()`/`getMinutes()`, which format in the device's current timezone. The UI label explicitly represents the Prague timetable.

**Concrete failure:** A visitor whose phone remains on London time sees every summer Prague arrival two hours early; a user in another timezone sees a correspondingly larger shift.

**Suggested fix:** Format with an `Intl.DateTimeFormat` fixed to `Europe/Prague` (with the same tested fallback policy used elsewhere), rather than device-local getters.

### 13. [P2] Line-screen tram placement compares distances from different shapes

**Location:** `src/app/line/[id].tsx:82-114`

**What breaks:** The screen chooses one longest geometry for a headsign, then interleaves every same-headsign tram by that tram's own `simDistM`. Distance-along-shape is only meaningful within its source geometry; short turns, diversions, and shape variants can have different origins/lengths and cannot be directly compared.

**Concrete failure:** Two trips share a headsign but one uses a diversion with 600 m of extra track before a common stop. Its tram is inserted several stops away from its actual location in the chosen timeline.

**Suggested fix:** Include only states driven by the selected shape, or project each state's world coordinate onto the selected geometry and accept it only below a reasonable offset. Prefer grouping directions by shape/direction identity, not headsign alone.

### 14. [P2] Tram selection state is neither established nor cleared consistently by the detail screen

**Location:** `src/app/tram/[key].tsx:126-164`; setters used only on some navigation paths at `src/components/map/TramLayers.tsx:119-130` and `src/components/favorites/FavoriteTramRow.tsx:32-39`

**What breaks:** `selectedTramKey` is documented as the tram whose detail sheet is open, but the detail screen never sets or clears it. Map taps/favorites set it before navigation and leave the halo after dismissal; search and line-screen navigation never set it, so the same detail sheet opens without a halo.

**Concrete failure:** Tap a tram on the map and close its sheet: its gold selection halo remains indefinitely. Open another tram from search: the old halo can remain while the new detail is shown.

**Suggested fix:** In the detail screen, set `selectedTramKey(key)` on mount/key change and clear it on cleanup only if the store still points to that key. Remove path-specific pre-navigation ownership or keep it only as an optimistic update.

### 15. [P2] Z-axis cylinder side faces have inward normals/winding

**Location:** `scripts/tram-models/lib.mjs:154-187`; visible users at `:553-558`

**What breaks:** `cylinder()` uses the same reversed side-quad order for the `y` and `z` axes. That order is outward for `y` but inward for `z`. Materials are explicitly single-sided (`:671`), so z-axis cylinder walls are back-face culled or lit from the wrong direction. `roundLamp()` builds every lamp ring and lens on the z axis.

**Concrete failure:** Generated tram headlights/taillights show their front caps, but their cylindrical bezels/sides vanish at oblique camera angles. A direct builder check gives the first z-cylinder normal `[-0.924, -0.383, 0]` where the radial outward direction is `[+0.924, +0.383, 0]`.

**Suggested fix:** Give the z-axis branch the outward order (`quad(a, b, c, d)` for the current ring construction), and add a generator test asserting `dot(faceNormal, radialDirection) > 0` for all three axes.

### 16. [P2] Runtime teardown leaves network work and delayed ingest callbacks alive

**Location:** `src/hooks/tramData.ts:75-82,92-119`

**What breaks:** `stop()` clears only intervals. It does not abort the current poll or retain/cancel the 2.5-second timeout created after a miss. Those callbacks can ingest snapshots, mutate the engine, write caches, and notify listeners after the runtime has no consumers or while the app is backgrounded.

**Concrete failure:** Dismiss/unmount or background the map immediately after a poll schedules the geometry nudge. The timeout still fires and performs a full engine ingest in the stopped runtime; an in-flight citywide request likewise completes and can enqueue another geometry batch.

**Suggested fix:** Track an `AbortController`, pending timeout handles, and a run/generation token. Abort/cancel them on final release or pause, and ignore completions whose generation is no longer active.

### 17. [P2] Initial Reduce Transparency state is not propagated to mounted glass panels

**Location:** `src/components/ui/GlassPanel.tsx:15-44`

**What breaks:** The module-level async `isReduceTransparencyEnabled()` updates only `reduceTransparencyCache`. Panels mounted before that promise resolves initialize state from the old `false` value, and no `setReduceTransparency()` is called for them. The change listener normally fires only when the setting changes, not for the initial query result.

**Concrete failure:** Launch the app with iOS Reduce Transparency already enabled. Panels mounted during startup can continue rendering Liquid Glass/blur for the whole session, violating the accessibility setting, until the user toggles the system option.

**Suggested fix:** Query the initial value inside the component effect (guarding unmount) and update state, or expose a small shared external store that publishes both the initial promise result and later accessibility events.

## Reviewed paths with no confirmed correctness defect

- `vehiclepositions.shape_dist_traveled` is correctly parsed from a kilometre string and multiplied by 1,000; GTFS shape/stop distances are correctly handled as numeric kilometres and multiplied by 1,000.
- The 16-start/8-second rolling-window accounting and four-request concurrency release path are correct. The defect is promotion/starvation behavior, not the window arithmetic.
- `segmentIndexAt()`, `pointAt()`, local bearing normalization, and the current curvature prefix-window implementation are correct for their stated monotonic cumulative-distance contract.
- The Expo SDK 57 `File`/`Directory` APIs used by the Zustand adapter and shape cache match the versioned API (`File.write`, `textSync`/`text`, `exists`, `delete`, idempotent directory creation). No persistence correctness bug was confirmed there.
- Zoom-band opacity expressions, section culling margin, frame subscription cleanup, and the follow-camera store reads are internally consistent; no additional correctness bug was confirmed in those paths.
