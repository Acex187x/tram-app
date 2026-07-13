# Triage of the 2026-07-13 external audit

Companion to `project-review-2026-07-13.md` — what we did about each finding and why.
Statuses: **fixed** (this wave), **queued** (accepted, scheduled), **deferred** (accepted,
gated on something), **disputed** (we verified a different conclusion).

## Fixed in this wave

| Finding | Action |
|---|---|
| P0 background ride sim integrates ~¼ of elapsed time (`MAX_ENGINE_DT_S` clamp × 1 Hz tick) | Substep integration ≤250 ms across the whole fleet per substep, explicit clock reset on true pause/resume, bounded catch-up budget → re-anchor. Critical: it would have corrupted every `lagM` ride sample. |
| P2 stuck-hold can strand the sim ahead of the raw fix | Bounded correction back to the fix anchor on the confirming stuck fix. |
| P2 Prague-time fallback hardcodes UTC+2 (wrong in winter) | Shared Prague-time helper reusing the GTFS DST resolver. |
| P1 Golemio client: no timeout/backoff/Retry-After, 401 hammering | AbortController timeout, exp backoff + jitter, Retry-After, 401 cool-down policy surfaced in FeedStatus. |
| P1 soft input validation (`[0,0]` coords, fake `0` dist, `Date.now()` timestamps) | Drop/quarantine invalid records, null unknown distances, rejection counters. |
| P1 `feed.stop()` doesn't cancel geometry prefetch/scheduler queue | Session-level AbortController threaded feed→GTFS→scheduler, generation guards on cache writes. |
| P1 background location contract hardening | Real permission-scope checks (incl. Allow Once), `background` mode reported only after the native task starts, ride deadline enforced in the location callback (JS timers die under suspension). |
| P1 passive calibration log always-on | Settings toggle (default **on** — deliberate: single-user calibration phase; revisit before any public release). |
| P2 stop totems re-enable shadow passes | `modelCastShadows/Receive: false`. |
| P2 Mapbox attribution/logo vs BottomDock overlap | Explicit `logoPosition`/`attributionPosition` bottom-left. |
| P2/P3 repo hygiene: 700 MB raw telemetry tracked, no `.easignore` | `sim-sessions/` untracked + gitignored (files stay on disk), `/build/` + `*.ipa` ignored, `.easignore` excludes docs/raw data from build context. |
| P2 stop hot path re-scans arrays | `nextStopIndex` + sorted-invariant `break` (kept only where the physics trace stays bit-identical). |

## Queued (next waves, blocked on in-flight work or device data)

- **Follow-camera deadband** and **full-screen viewer occlusion** — touch `TramLayers.tsx`,
  which the map-icons wave holds; small, do right after.
- **Whole-fleet getStates before culling at 60 Hz** — accepted; needs the render-snapshot
  refactor (engine-side cull → build). Schedule as its own perf wave with the synthetic
  500-tram benchmark from the audit.
- **Bounded GeometryRepository (LRU + pinning + disk sweep)** — accepted; also the prime
  suspect for the 9 h CPU degradation already tracked in `performance.md`.
- **Calibration schema v3 + TypeScript replay runner on the real engine** — accepted in
  full; this is the "make measurement trustworthy" stage and the prerequisite for every
  further physics coefficient change. Multi-objective pre-registered gate as specced.
- **Shared 1 Hz app clock / `useSyncExternalStore` immutable snapshots / lint burn-down** —
  accepted, fold into one UI-hygiene wave.
- **Harvester incremental drain** — accepted; calibration program is paused, fix before
  resuming soaks.

## Deferred with rationale

- **`paceBias` travel-time mean (vs arithmetic)** — the math criticism is correct, but the
  learned prior 0.62 was fit against the current basis; swapping the estimator without
  re-learning shifts every bias and would *worsen* accuracy until recalibrated. Do it
  together with the schema-v3 + device-`lagM` recalibration round.
- **Smooth target still schedule-paced between fixes** — agreed with the diagnosis (live
  projection already fixed in `98259f5`); the redesign (dead-reckoned target, alpha-beta
  velocity) lands in the same recalibration round where we can gate it on device rides.
- **Central-cap 07:00/19:00 step** — known artifact (calibration rounds 19/29); resolve as
  part of the zone×TOD traffic-prior split, not as a one-off.
- **Queue monotonicity / cross-shape relaxation** — accepted direction (velocity-limit
  before integration, constraint graph); non-trivial engine surgery, schedule after the
  render-snapshot wave so regressions are measurable.
- **RemoteFeed backend** — already the documented plan (`decisions/backend-plan.md`); the
  audit's diff-stream/credential points are folded there.
- **Planner static GTFS graph** — accepted as a backend-era item.

## Disputed / already true

- **"Background location used outside the documented contract"** — verified against the
  installed expo-location 57.0.2 native source: `startLocationUpdatesAsync` is a
  user-initiated foreground-service-style API; when-in-use + `UIBackgroundModes: location`
  + the blue indicator is Apple-documented behavior and does not require Always. We still
  adopted the audit's hardening (scope checks, honest mode reporting, callback deadline).
- **R8 zonal dwell "not release-ready"** — agreed and already the case: dev-flag off in
  release; the audit's censoring/treatment-purity critique is incorporated into the gate-2
  requirements before any promotion.
- **TOD tables neutral** — that's a measured result (30 rounds, double gate), not a gap.
