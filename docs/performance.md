# Performance & Thermal Playbook

Why this doc: after ~1 h of use the app made an iPad Pro noticeably hot (iteration-4 trigger).
The fixes below brought steady-state work down sharply. This page records (A) everything we
did, (B) the **invariants that must not be broken**, and (C) how to verify before shipping.

## A. What was done (chronological)

### Rendering architecture (foundation)
- **Imperative source pushes.** All live GeoJSON flows through
  `ShapeSource.setNativeProps({id, shape})` with *stable* React props (module-const empty FC).
  React never re-commits map data — reconciliation cost is zero per frame, and it dodges the
  Fabric bug where prop-driven shape updates don't apply (`docs/decisions/map-rendering.md`).
- **Viewport culling by whole tram** (+300 m margin) — the 3D sections FC contains only
  what's on screen; typically 3–30 trams × sections, a few KB per push.
- **Zoom banding** — dots / badges / 3D models are separate layers gated by zoom, so the GPU
  never draws models that aren't visible.

### Cadence system (the thermal fix, iterations 2–4)
| work | cadence | condition |
|---|---|---|
| engine tick + sections push + follow camera | 60 Hz (16 ms) | zoom ≥ 14.0 **and** app active |
| engine tick | 10 Hz | zoom < 13.7 (hysteresis band 13.7–14.0) |
| points (badges/dots) push | 66 ms / 1 s / 5 s | zoom ≥ 14 / 12.5–14 / < 12.5 |
| live-projection sims (projSim) | full rate in `live` mode, batched 500 ms in `smooth` | `TramEngine.setProjectionCadence` |
| UI hooks (`useAllTramStates` etc.) | 1 Hz | skipped entirely when no listeners |
| RouteNetwork/stops refresh | 2 s | cheap fingerprint short-circuit first; no-op when backgrounded |
| Golemio poll | 5 s | aborted + all timers cleared on background (P0 fix) |

Key insights behind it:
- Pushing a full-fleet FC 15×/s at far zoom forced Mapbox to re-render **continuously** while
  badges moved sub-pixel — pure GPU heat for nothing. Far-zoom pushes are now 1 s / 5 s.
- 60 Hz work is only justified where 3D models are visible; the cadence boundary must equal
  the fast-points boundary (14.0) — mismatch caused the iteration-4 jerkiness regression
  (15 Hz pushes sampling 10 Hz motion).
- Hysteresis (enter 60 Hz at ≥14.0, leave below 13.7) prevents timer thrash at the band edge.

### GPU knobs
- `modelCastShadows` / `modelReceiveShadows` **off** (largest single GPU saving at pitch).
- Camera retarget loop runs **only while following**; retargets every ~80 ms with ~170 ms
  overlapping `linearTo` glides — never per-frame (60 native animation restarts/s choked the
  animator AND kept the map render loop hot).
- 3D viewer renders at full rate only while touched, ~30 fps idle turntable, full dispose on
  unmount.

### CPU / allocation discipline
- Engine hot path is allocation-light: queue groups cached and rebuilt only on ingest,
  binary-search anchors cached per poll (`obsSchedDistM`), dt from real clock deltas.
- `buildFrame` is skipped entirely on ticks where no push is due (`skipPoints` and due-checks).
- `getStates` results cached per UI version; stringify skipped when a FC stays empty.
- UI rows (fleet browser, lists): memoized row components with primitive props, FlatList
  `windowSize`/`removeClippedSubviews`, glass-free row internals, single shared 1 Hz clock.

### Network
- Rate-limited scheduler (16 starts/8 s, 4 concurrent) — bursts are impossible by design.
- Trip geometries disk-cached (3 days, service-day re-anchored) — steady state fetches only the
  5 s positions poll (~0.9 MB) and geometry deltas for new trips, and a next-day cold start
  re-opens warm instead of re-fetching the fleet.

## B. Invariants — do not break these

1. **No React state per frame.** Anything at > 1 Hz lives in refs/imperative pushes.
   React subscribers use the 1 Hz hooks; `subscribeFrame` is for the map push loop only.
2. **New map layers use the imperative pattern** (stable props, `setNativeProps`, `slot:'top'`),
   and are fed at the *slowest cadence that looks right* — justify anything above 1 Hz.
3. **Every timer/subscription registers with the runtime lifecycle** (created in `resume()`,
   cleared in `pause()`, guarded by the generation counter). Nothing may tick in background.
   Test: background the app, verify zero log output / network until foregrounded.
   **One sanctioned exception:** the runtime's `rideBackground` mode while a GPS ride
   recording is active — see "Sanctioned exception: ride recording in background" below.
4. **Cadence boundaries stay aligned**: the 60 Hz tick zoom threshold == the fast points
   cadence threshold (one shared constant). If you change one, change both — or you
   reintroduce the aliasing stutter.
5. **Payload ∝ visible.** Never push the full fleet above 1 Hz. Sections FC must remain
   viewport-culled. If you add per-feature props, check the stringify size at 60 Hz.
6. **No new continuous camera/style animations at idle.** The map must reach a fully idle
   state (no pushes due, no animation running) within ~5 s at far zoom.
7. **Mapbox expensive features (shadows, terrain, extra light passes) stay off** unless
   profiled on-device with a thermal soak (see below).
8. **Engine tick must stay allocation-light.** No closures/array literals in the per-tram
   per-tick path; new per-tram state goes on the sim object.
9. **Heavy work belongs behind the `TramFeed` boundary** — anything that could run
   server-side someday (polling, aggregation) must not leak into render-path modules.

## Sanctioned exception: ride recording in background (2026-07-13)

Ride recordings (Record ride) must survive the app being backgrounded — GPS fixes keep
arriving via the expo-location background task (`UIBackgroundModes: location`), and a ride
point correlated against a frozen simulation is useless. So while — and ONLY while — a ride
is actively recording, backgrounding switches `TramRuntime` to **`rideBackground`** mode
instead of the full pause:

| work | cadence in `rideBackground` |
|---|---|
| Golemio poll (feed) | 10 s (`RIDE_BG_POLL_MS`, vs 5 s foreground) |
| engine tick | 1 Hz (`RIDE_BG_TICK_MS`) — enough for the 1–2 Hz ride log |
| render pushes (`frameListeners`) | **off** |
| UI notifications (`bumpUi`, 1 Hz hooks) | **off** |
| geometry warm-up | unchanged (needed for the ride's `gpsDist`/`lagM` fields) |

Gates that keep invariant #3 meaningful:

- **Entry** only from `onAppState(background/inactive)` when the injected ride-activity
  probe (`TramRuntime.setRideActivity`, wired by `src/lib/motionlog`) reports an active
  recording. An app without a live ride pauses fully, exactly as before.
- **Exit**: foregrounding → full `resume()`; the ride stopping in background (user stop or
  the 90 min auto-stop) → `notifyRideActivity()` → immediate full `pause()`. Nothing may
  keep ticking once `isRiding()` is false.
- Budget is minimal by construction — no Mapbox work at all (the map isn't rendered), no
  React re-renders, one 1 Hz tick + one 10 s poll. This is the floor that keeps the ride
  log's sim-side fields meaningful.
- The background check in section C still applies to the **no-ride** case verbatim.

## C. How to verify (before shipping perf-touching changes)

- **Unit guards:** `__tests__/tick-cadence.test.ts` pins the cadence table;
  extend it when adding cadences.
- **Smoothness check:** simulator, camera at z16.8 over a moving tram → 8 screenshots at
  250 ms; consecutive position deltas must be small and uniform (no 0-0-0-jump).
  Same at z14.2 for badges. (Method used to find/fix the iteration-4 regression.)
- **Idle check:** far zoom (z12), no interaction 30 s → Mapbox should stop re-rendering
  between the 5 s points pushes (watch GPU in Xcode gauges; frames should be event-driven).
- **Thermal soak (device):** 20 min foreground at mid zoom, Xcode Energy gauge / MetricKit:
  CPU should sit in single digits between polls; GPU duty far below 100%; thermal state
  should stay `nominal`/`fair`.
- **Background check:** background 2 min → metro/log silence, then foreground → resumes
  within one poll (the P0 regression class). With a ride recording active, background
  activity must be exactly the `rideBackground` budget (10 s polls, 1 Hz tick, zero pushes)
  and must stop entirely the moment the ride stops.

Related: `docs/decisions/map-rendering.md` (rendering decisions),
`docs/decisions/interpolation-engine.md` (engine hot path), `docs/decisions/backend-plan.md`
(moving poll/aggregation off-device is the next big win).

## Open investigation: long-uptime CPU degradation (found 2026-07-12)

After ~9 h of continuous foreground running (simulator, calibration soak) the app's JS
thread degraded to 99.7% CPU with periodic (~4 min) sim-integration collapses; a restart
fully restored it (11.6% CPU). Host was idle — this is app-side accumulation (suspects:
listener/interval leaks, unbounded caches, motionlog buffers, engine maps for departed
trams). Real users rarely foreground an app for 9 h, but the mechanism should be found:
profile a long session with Instruments (Allocations + Time Profiler), watch
`uiListeners`/`frameListeners` sizes, engine entry counts, motionlog ring size.
Until fixed, calibration soaks restart the app every ~6–8 h (see calibration analysis
2026-07-12, round 20).
