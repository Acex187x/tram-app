# Tram Lab — research infrastructure

Phase-0 of `docs/research/prediction-architecture.md`, built 2026-08-08: a
separate 24/7 service that archives every tram fix, runs THREE predictors in
parallel over the live feed, scores each one against the next real fix (the
continuous at-fix probe), learns pace/dwell surfaces online, and exposes a
plain live map + Grafana telemetry.

**The engine baseline is PINNED to the shipped build.** The lab used to import
`src/lib/engine/*` live from this repo. physics-v3 deletes TramEngine from the
app (protocol §"What dies on the client"), so `engine-live`/`engine-smooth` —
the "what is in users' hands" control line the whole program is measured
against — would have gone dark the moment that landed. Those four files are
therefore vendored VERBATIM at build 12 under `lab/vendor/engine/`:

```sh
git show 050c8ae:src/lib/engine/engine.ts | diff - lab/vendor/engine/engine.ts   # empty
```

`lab/vendor/geo/polyline.ts` is a one-line re-export so the copies stay
byte-identical to their commit, and `lab/vendor/engine-api.ts` declares the
slice of the engine surface the lab consumes (the app's `TramPublicState` is
free to keep changing). To move the control line, replace the vendored files
with the next shipped build's and say so in the findings log. Everything else
— types, geometry, polyline, fleet registry, `serviceDayShiftMs` — is still
imported live from `src/` via tsx + tsconfig paths.

## Variants under test (9 parallel hypotheses, same pairs)

| variant | what it is |
|---|---|
| `naive` | tram stays at its last fix — the floor every model must beat |
| `schedule` | timetable shifted by reported delay — the classical OneBusAway/TRAVIC control line (no learning, no physics) |
| `engine-live` | the app's real predictor (`projectedObservedDistM`), ticked in real time |
| `engine-smooth` | the app's cinematic smoother track (lags by design; context only) |
| `learned` | the plan's core hypothesis: closed-form walk over ONLINE-LEARNED surfaces — pace per (shape × 250 m bucket × 4 h band × day type) with hierarchical fallback, dwell + release per stop |
| `learned-fast` | + corridor residuals (~12 min half-life ratio of measured vs expected pace per km — the plan's phase-2 "leader as congestion sensor") |
| `learned-2h` | + two-hypothesis stop release: E[pos] = (1−p)·standing + p·departed, p from the learned release Normal(mean, sd) |
| `ml-gbdt` | LightGBM trained nightly (and on boot) on the archive: predicts Δs from the shared feature contract (lab/src/ml.ts ↔ lab/ml/service.py, FEATURE_VERSION-guarded); stacked on the learned surfaces — a residual learner |
| `ml-mlp` | small neural net (MLP 64×32) on the same features — the honest "нейронка" probe |
| `ml-mode` | the physics-v3 **opinion** track AS PUBLISHED to phones — ml-gbdt keyframes + the modal stop rule — evaluated with the client's own pure evaluator. Measures what modal (honest-looking) rendering COSTS against a mean-optimal metric |
| `ml-smooth` | the physics-v3 **smooth** track as published: opinion + server-owned continuity. Measures what never teleporting costs |

`ml-mode`/`ml-smooth` are deliberately NOT recomputed at scoring time: they are
read out of the currently published `/api/trajectories/v2` bundle, so the lab
scores the pixels, not a parallel idea of them. They are only scored when the
published bundle is anchored to the same fix every other variant starts from,
which keeps n matched with `ml-gbdt`.

ML training telemetry: `ml_train_log` (Grafana panel «ML: MAE на holdout») +
feature-importance report at `/api/mlreport`. GPU is never needed: LightGBM/
MLP train on CPU in seconds-to-minutes at this data scale.

Scoring: when a genuinely-new fix arrives, each variant's current position
estimate is compared against it (`err = predicted − actual`, meters along
shape, same trip only, gaps 4–300 s). Horizon = the fix gap. Per-minute
rollups (mean/p50/p90/signed, per horizon bucket) feed Grafana.

## Trajectory feeds (what phones fetch)

| endpoint | who | shape |
|---|---|---|
| `GET /api/trajectories` | **build 12, shipped** — do not change | `{atMs, stepS:10, horizonS:120, vehicles:[{key,tripId,line,anchorMs,points:[{t,s}×13]}]}` |
| `GET /api/trajectories/v2` | physics-v3 clients | `docs/research/physics-v3-protocol.md` — FROZEN |

v2 emits BOTH tracks per vehicle over the same ml-gbdt samples v1 uses (one ML
call, no extra inference cost). Since 2026-08-16 the ML output is treated as a
sequence of TARGET POSITIONS and both tracks are **kinematic curves** fitted to
them — the closest curve a real tram could actually drive (`V_MAX` 16.7 m/s,
`A_ACC` ≤ 1.3, `A_BRK` ≤ 1.4 m/s², protocol §Kinematic limits):

- **`opinion`** — the model's belief plus the **modal stop rule**: while the
  learned release model says `P(departed | elapsed + already-standing) < 0.6`
  under `Normal(releaseStats.mean, sd)`, the curve HOLDS at the platform; at
  the crossing it ACCELERATES away (≤ 1.3 m/s²) toward full learned pace
  (`LearnedModel.walkFrom`) instead of stepping onto it. This is the fix for
  the 2026-08-13 field report (expectation floats off the platform) plus the
  2026-08-16 one (the departure was a step function).
- **`smooth`** — server-owned continuity. Each re-emission starts exactly where
  the PREVIOUS smooth track says the tram is at the new `emittedAtMs` (≤2 m,
  server-enforced) **and at the speed it was doing there** (C¹, not just C⁰),
  then DRIVES onto `opinion`: commanded speed = the opinion's own slope + gap /
  time-left-in-the-window, clamped to `V_MAX`, rate-limited to the accel caps,
  and further clamped by the braking envelope `√(2·A_BRK·Δs)` of any upcoming
  hold so catch-up can never blast through a platform. When a gap cannot be
  closed legally in 30 s the WINDOW extends — the limits never bend. If the
  opinion is BEHIND the rendered position the track brakes and waits instead of
  reversing (trams don't drive backwards). `discontinuity:true` (smooth starts
  AT opinion) on trip change or a >150 m break; a first-ever emission is
  `false`.

Both tracks are monotone in `t` and non-decreasing in `s`, ≤24 points, ≥120 s
of horizon — the client is one binary search + lerp (`evalTrack`), no state.
Knots now sit at **profile breakpoints** (instants where acceleration changes)
rather than on the 10 s grid, which is what makes the limits exact rather than
approximate: sampling a constant-acceleration phase at its own breakpoints
makes each segment's mean speed the midpoint instantaneous speed, and the
acceleration a lerping client observes a convex combination of two in-range
phase accelerations. A constant-pace target therefore collapses to 2 knots.

**Realism gate.** `readRealism()` (lab/src/realism.ts) measures a track exactly
as a lerping client experiences it; `RealismCounters` runs it over everything
published and exposes lifetime counts + distributions at `/api/summary` →
`realism`, and `check-v2.mjs` asserts the same thing against the served bytes
and exits non-zero on any violation.

## Other endpoints

| endpoint | what |
|---|---|
| `GET /physics` | debug page: pick a vehicle, see s(t)/v(t)/a(t) for BOTH published tracks against its recent real fixes, with the limit lines drawn. Seeing "how it drives" without a phone |
| `GET /api/vehicle/:key/debug` | JSON behind that page — both tracks with their knot speeds, the raw ML target curve, and the last 10 fixes from SQLite |
| `GET /api/geometry-pack` | gzip (`Content-Encoding: gzip`) `{atMs, shapes:[ServedGeometry…], trips:{tripId:shapeId}}` for the ACTIVE fleet, deduplicated by shapeId — client cold start in one request instead of hundreds of `/geometry/:tripId`. Rebuilt at most every 60 s and served from a cached buffer; `X-Pack-Meta` carries the sizes |

`/api/geometry-pack` dedupes by SHAPE because that is what a physics-v3 client
renders along: it turns a published `s` into a point/bearing via
`coordinates`/`cumDistM`, and dozens of trips share one shape. The trip-scoped
fields of the representative geometry (`tripId`, `headsign`,
`stops[].arrivalMs/departureMs`) belong to whichever trip was picked — only the
shape-scoped fields are valid for every trip in `trips`.

Determinism: the whole v2 body, `serverNowMs` included, is frozen for the 2 s
cache window, so any two clients fetching inside it get byte-identical bytes
and render identically. The price is that a client's clock offset can be up to
2 s stale; `serverNowMs − atMs` makes the bundle's real age visible.

Verify any of this against the live service:

```sh
node lab/scripts/check-v2.mjs            # contract + continuity + KINEMATIC LIMITS
node lab/scripts/determinism-v2.mjs fetch 8 && \
  node lab/scripts/determinism-v2.mjs eval /tmp/v2-bundle.json   # run twice, diff
cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
  ./node_modules/.bin/tsx scripts/selftest-v2.ts                 # offline invariants
docker exec tram-lab node /repo/lab/scripts/score-report.mjs 30  # matched scoring
```

## Data flow

Backend Convex deployment (public queries `stream:fullFleet` /
`stream:batchesSince` — the same diff stream the app's RemoteFeed consumes;
zero extra Golemio load) → lab ingest → SQLite (`/data/lab.db` in the
`tram-lab_lab-data` volume): `fixes`, `scores`, `learned_cells`,
`geometries`, `rollup_*`. Geometry comes from the backend's
`GET /geometry/:tripId`, re-anchored to the current Prague service day with
the repo's own `serviceDayShiftMs`.

## Run / operate

```sh
cd lab
docker compose -p tram-lab up -d      # lab + grafana
docker logs -f tram-lab               # watch ingest/scoring
```

- Live map + API: https://tram-lab.acex.sh (`/api/live`, `/api/summary`, `/healthz`)
- Grafana: https://tram-lab-grafana.acex.sh (admin / password in `lab/.env`,
  dashboard "Tram Lab — точность и обучение")
- Traefik route file: `/etc/dokploy/traefik/dynamic/tram-lab.yml`

Host smoke run (no docker): `cd lab && npm install &&
CONVEX_URL=https://tram-api.acex.sh SITE_URL=https://tram-site.acex.sh
TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json ./node_modules/.bin/tsx src/main.ts`

## Caveats (v0)

- Per-variant sample sets are not strictly matched during warm-up (engine
  needs a couple of fixes before `projectedObservedDistM` exists); after
  warm-up availability is ~equal. For rigorous claims compare matched
  periods, not the first hour.
- `learned` starts from fallback constants and must EARN its cells (weight ≥3
  per cell). Expect it to lose to `engine-live` on day one — the hypothesis
  is the trend, watch the "vs naive" panel over days.
- Both engine variants are judged at the wall instant of scoring while the
  fix's own timestamp is ~5–15 s older (pipeline latency) — identical
  semantics to the v2 ship gate's at-fix probe, consistent across variants.
- The fast-adaptation layer (corridor residuals, phase 2 of the plan) is NOT
  implemented yet — this lab exists to establish the baseline it must beat.

## Findings log

- **2026-08-09 (day 1): release-estimator cadence bias — found and fixed.**
  The v0 `stopRelease` estimator folded the RAW at_stop→moving fix gap and
  learned ~50.7 s — the AVL sticky-hold artifact — instead of the real ~17 s
  dwell (independently re-measuring the calibration program's known feed
  quirk). Effect: `learned` signed bias drifted −26 → −95 m over 4 h as cells
  gained trust, mean |err| 120 → 144 m. Fix: R13-style clip (deduct the
  travel portion `dDist/pace` from the gap), account time already observed
  standing at the anchor, cap dwell/release use in the walk; poisoned cells
  purged (1,176). Lesson for the production plan: EVERY learned quantity
  needs an estimator audited against feed artifacts, and the harness catches
  it in hours.
- **2026-08-09 (day 1): ML strongly ahead on matched pairs.** ml-gbdt vs the
  app engine on 43,925 identical events: **70.5 m vs 120.4 m mean |err|**,
  better in 65 % of events, trained in 3.7 s on CPU. It implicitly learned
  correct release behavior from the same data the v0 estimator misused
  (top features: distToNextStop, gapS). Supports the plan's premise that the
  headroom over the current engine is real and mostly lives at stops.

- **2026-08-11 (day 3): geometry re-anchor double-shift — found and fixed.**
  `reanchor()` shifted stop epochs to the current service day but kept the
  old `serviceMidnightMs`, so each daily `reanchorAll()` re-applied the shift
  cumulatively → the `schedule` variant's timetable drifted ±whole days after
  Prague midnight (km-scale spikes, bias swings ±7 km). Fixed (midnight
  advances with the stops) + `schedule` made self-locating (evaluates shifts
  −1/0/+1 day, picks the branch nearest the previous fix). Only `schedule`
  was affected — other variants don't consume stop epochs.
- **2026-08-11 (day 3): feed-discontinuity gate added.** 743 of 441 k events
  (0.17 %) had displacements implying > 25 m/s — shape/odometry resets in the
  city feed, not travel. They charged km-scale errors to every variant at
  once (the synchronous minute-panel spikes). Scoring now skips such events
  (> 22 m/s physical cap, same criterion as the server calibration) and
  counts them in `rollup_ingest.discarded`.
- **2026-08-11 (day 3): milestones.** Nightly retrain #2 on 366 852 pairs
  (×55 data): GBDT holdout MAE 66.8 → 58.6 m, MLP 81.4 → 72.3 — models
  improve with data. Matched 24 h comparison (252 760 identical events):
  **learned 108.7 m / p50 79.4 vs engine-live 126.1 m** — the learned family
  now beats the app engine after the day-1 release fix; ml-gbdt leads at
  71.2 m / p50 45.5. Night hourBand cells populated after first full night.
  ml-mlp shows fat tails (mean 136.7 vs p50 82.9) — trees > MLP on tabular,
  as the literature predicted.

- **2026-08-12 (day 4): v1 feature plateau → feature contract v2.** Retrain #3
  on 657 571 pairs (×1.8 data) left GBDT holdout MAE flat at 58.6 m — the
  models saturated on v1 features, so the residual is either irreducible
  (signals, drivers) or a MISSING FEATURE. Shipped contract v2: corridorPace
  (recent measured pace of the same km by any vehicle, 12-min half-life — the
  plan's phase-2 "leader as congestion sensor") + corridorTrust. Offline
  computation is strictly leak-free (samples before t_eval only); persisted
  models are version-stamped so a restart can't serve v1 models against v2
  features. Hypothesis: leader signal is the next accuracy increment; if v2
  MAE ≈ v1 MAE, congestion variance is NOT the plateau's cause — equally
  valuable outcome.

- **2026-08-13 (day 5, OWNER FIELD REPORT — the first human-vs-model finding).**
  Build 12 in the wild: ML mode "иногда трекается чуть ли не с точностью до
  метра", BUT at stops a fresh fix sometimes THROWS the marker forward off the
  platform while the real tram is still standing (also seen in live mode of
  the physics engine). Diagnosis: expectation-rendering. The model outputs
  E[position]; near a stop that expectation sits BETWEEN "still standing" and
  "departed" (P(departed) grows with elapsed time), so the rendered point
  floats forward off the platform — statistically optimal for mean |err|,
  perceptually wrong. Quantified 2026-08-16 (24 h, ml-gbdt by anchor state):
  at_stop anchors p50 31.2 m but p90 144.4 m (60 % of events, 58 % of error
  mass); the tail IS the departure-timing ambiguity. Metric and perception
  DIVERGE at stops: mean-optimal rendering ≠ honest-looking rendering.
  Fix direction (planned): render the MODAL hypothesis, not the mean — hold
  at the stop while P(departed) < threshold, then depart at full pace
  (learned-2h already computes the probability). Candidate variant `ml-mode`
  to score the modal renderer against the mean renderer.
- **2026-08-16 (day 8, physics-v3 W1): modal stops and continuity, PRICED.**
  `/api/trajectories/v2` shipped (opinion + smooth tracks, protocol frozen the
  same day) and both tracks entered scoring as `ml-mode`/`ml-smooth`, read out
  of the PUBLISHED bundle. First reading — 2 171 events, all 11 variants
  matched on every one (100 % probe coverage), weekday afternoon:
  - **continuity is free.** The smooth track moves ≤0.01 m at every seam
    (309 non-discontinuity re-emissions measured live, p50 0.00 m) while the
    raw opinion teleports p50 1.3 m / p90 83.5 m / max 453 m at re-anchor.
    Cost: 0.0 m of mean error (90.2 vs 90.2), +0.3 m p50; rendered distance
    from the opinion p50 0.0 m, mean 3.0 m, p90 6.1 m. 4.9 % of re-emissions
    are flagged discontinuities (trip change or >150 m break) — honest
    teleports, not drift.
  - **modal stops cost ~30 m of mean error and buy a marker that stays on the
    platform.** Matched: ml-gbdt 59.8 m mean / 41.1 p50 → ml-mode 90.2 / 59.9.
    At `at_stop` anchors (58 % of events) 54.0 → 105.9 m mean, 24.6 → 70.4
    p50, and the rendered position sits a median **64 m** (p90 222 m) from the
    mean-optimal marker — that gap IS the "floating off the platform" of
    2026-08-13, now paid for explicitly instead of being smeared into the
    metric. At `moving` anchors ml-mode ≡ ml-gbdt (67.7 vs 67.8 m mean, 53.9
    vs 53.7 p50): the control proving the rule fires only at stops.
  - **still ahead of what users have.** On the same events the shipped engine
    is 126.8 m mean / 98.7 p50 vs ml-mode 90.2 / 59.9 — honest rendering is
    not a regression against build 12, it is 36 m better.
  - **the bias is imported, not intrinsic.** ml-mode's signed error at stops is
    −56.6 m, but `learned` runs −53.7 m signed in the same window: most of it
    is the learned walk's known lateness, inherited through the "departs at
    full learned pace" branch, not the hold itself. Worth a follow-up: drive
    the post-release branch from the ML curve's own increments and re-price.
- **2026-08-16 (day 8, physics-v3 W2): realism is FREE — the kinematic limits
  cost nothing measurable.** Owner field report on build 13: smooth caught up
  to fixed at impossible speed, and both tracks braked instantly into stops.
  Both tracks are now kinematic curves (V_MAX 16.7 m/s, a ≤ +1.3 / ≥ −1.4)
  fitted to the ML target positions instead of the targets being published raw.
  - **gate: ZERO violations.** 2 112 published tracks / 45 676 segments over a
    3 min live sweep: per-segment speed p50 4.19, p90 8.38, p99 16.26, max
    16.70 m/s (exactly V_MAX); between-segment acceleration p01 −1.35, p50
    −0.01, p99 1.24, min −1.40, max +1.30 m/s² — the profile rides its own
    physical caps and never crosses the +1.35/−1.45 wire tolerance. Continuity
    survived untouched: 645 non-discontinuity seams, max |Δsmooth| 0.01 m.
  - **the impossible catch-up, quantified.** Over 289 catch-up episodes the OLD
    time-weighted blend implied `opinion' + δ/30` with nothing bounding the
    sum: p99 21.35 m/s, max 21.70 m/s (78 km/h), and **31 % of episodes would
    have driven above V_MAX**. Worst three: 9388/line 15 (gap 150 m) 78 → 60
    km/h, 8576/line 21 (144 m) 77 → 60, 9515/line 5 (142 m) 77 → 60. The
    median episode is unchanged (11.11 → 11.12 m/s) — the fix clips only the
    tail that was lying.
  - **price of realism ≈ 0 m.** Matched 15 min post-change (n=2 665) against
    the untouched `ml-gbdt` control, differenced to cancel the traffic
    difference between windows: ml-mode − ml-gbdt went **+35.6 → +34.5 m mean**
    and **+20.3 → +16.3 m p50**; ml-smooth − ml-gbdt +35.8 → +34.7 m. At
    at_stop anchors the gap narrowed 60.8 → 57.9 m mean. The only regression is
    ml-smooth at MOVING anchors (+1.6 → +3.7 m vs ml-gbdt), which is the honest
    cost of C¹ seams plus physics-limited convergence. Absolute levels rose
    (~5 m) in both the control and the tracks — that is the window, not the
    change.
  - **the discontinuity rate was never 4.9 %.** This run showed 20 % of
    same-trip re-emissions flagged, which looked like a regression and is not:
    the day-8 figure was measured in a window dominated by AGE-driven
    re-emissions (|Δopinion| p50 0.3 m) rather than FIX-driven ones (p50
    75.8 m). Replaying the same 501 fix-driven events under the old
    converge-exactly behaviour gives **17.2 % teleports vs 16.4 % now** — the
    threshold is being crossed by the model's own re-anchor error, not by the
    smooth track. Worth a follow-up: 150 m may simply be the wrong threshold.
- **2026-08-16 (day 8): the lab's engine baseline had to be pinned.** physics-v3
  deletes `src/lib/engine/*` from the app; the lab imported it live, so the
  first restart after that landed crash-looped (`MODULE_NOT_FOUND`, ~4 min of
  ingest lost) and `engine-live`/`engine-smooth` would have gone dark for good.
  Build 12's engine is now vendored verbatim under `lab/vendor/engine/` with a
  lab-owned interface (`lab/vendor/engine-api.ts`) so app type churn cannot
  break the lab again. Lesson: a 24/7 measurement rig must not depend on the
  live source tree of the thing it measures.
- **2026-08-16 (day 8, weekly synthesis).** Lab ran 3 days unattended (owner
  limits) with zero ingest gaps; archive 1.88 M fixes. Trainings kept
  improving on data alone: gbdt 56.7 → 54.8 m holdout (1.74 M pairs), mlp
  69.1 → 64.9. learned beat engine-live 23/25 hours in the last day —
  checkpoint verdict (08-13: 47/49 hours, +12.2 %) SUSTAINED. Corridor/leader
  layer still UNPROVEN: no real disruption day occurred all week (learned-fast
  ≡ learned within 0.2 m). Info-ceiling reading stands: ×260 data growth moved
  holdout only 66.8 → 54.8 m — the residual at Prague's fix cadence is mostly
  irreducible without a denser upstream feed.

- **2026-08-17 (day 9, curvegen-v3 shadow tuning): the smooth track's deficit
  was the CEILING, not the demand — and G4's "structural zero" had four real
  holes.** After 12 h of shadow (157 k emissions, matched n=115 087) the drive
  OPINION already beat the published pair (ml-drive 81.7 m mean vs ml-mode
  94.2) but ml-drive-smooth ran 109.1 m / bias −67.0 vs ml-smooth 94.4 /
  −30.7, with G5 catch-up p50 22.5 s / p90 45.5 vs the 12/28 design gates —
  and the demand constants were already at their band edges (T_CLOSE 8, DV 7),
  so the demand was never the binder. A per-step limiter drill-down
  (`/api/summary → perceptual.g5catchup.limiter`, kept) proved it in minutes:
  **62 % of catch-up steps were bound by the observed-pace ceiling** (mean
  3.3 m/s of closing speed clipped), 5 % of bound steps commanded the smooth
  SLOWER than the opinion it chases, 42 % of hold-follow approaches were
  ceiling-bound below the brake parabola, and 21 % of yield steps OUTRAN the
  reference (the lead grew while "repaying"). Root cause: `paceAt` at the
  smooth's own position is the stop-zone bucket at exactly the moments
  catch-up starts, and stop-zone cells are dwell-contaminated (moving→moving
  spans crossing a stop fold dwell into pace; R13 only guards at_stop
  endpoints). Fix (design §6 tuning deviation): the ceiling's pace anchor
  spans BOTH ends of the gap corridor, floored at `vO + CATCH_DV_MIN 2.5`
  (catch-up) / `DEFAULT_PACE` (hold-follow approach); yield never exceeds the
  reference's own speed. G4's 513 violations decomposed into (a) hot SEAM
  imports — the previous emission's chord/knot-lerp speed at t_E exceeds the
  local envelope when the chord spans a dip; fixed by a margin-aware
  `seamSpeedCap` on BOTH tracks (+ inherited accel clamped ≤ 0 when it
  bites); (b) CORNERLESS DESCENTS — braking into a hold across a curve zone
  is monotone in v, so §11's local-minimum knot protection provably cannot
  see it; fixed by an envelope guard on every compression merge, evaluated at
  the chord's EMITTED accumulated position (fine-grid approximations drifted
  metres in budget-forced horizons); (c) a full-throttle ramp arriving at a
  demand plateau overshoots by A²/2J ≈ 1.06 m/s; fixed by the S-curve
  APPROACH ceiling `a ≤ +√(2·J·Δv)` — the exact accel-side mirror of the
  landing floor; (d) the a-dependent onset margin lets a hard ramp COLLAPSE
  its own envelope demand after jerk can no longer comply (the margin
  cliff); fixed by a one-step-ahead feasibility clamp — never enter a state
  you cannot brake out of. **Post-fix fresh window** (40 min, 09:15–09:56Z,
  14 213 emissions, matched n=10 336): ml-drive 76.3 m mean / −24.8 signed
  (vs ml-mode 87.3 / −33.8), ml-drive-smooth 97.6 / −60.8 (vs ml-smooth
  87.5 / −35.2) — the smooth deficit narrowed +14.7 → +10.1 m mean and
  −67.0 → −60.8 signed but still misses the flip bar (≤ +2 / ≥ −45). The
  residual is no longer the ceiling (ceil-below-ref 0, yield-outrun 0,
  behind-unconverged 535 → 10 of 7 171 episodes): it is honest gap-carry —
  v3 DRIVES OFF re-anchor gaps the published smoother teleports over (G8
  fix-driven discontinuity 0.65 % vs ~16 % published; T_disc 350–1200 m vs
  the flat 150). G5 near p50 22.5 s / p90 43.5 (lifetime counter incl.
  restart transient; steady-state bytes 09:26–09:52: moving starts 16.0 /
  41.0, standing starts 30.0 / 48.0 at 15 % share — the jerk spin-up the §6
  latency math never priced) vs targets 14/30 — missed; ahead-unconverged
  12.8 % (was 17.4, target <10) — missed; G4 10 per 578 k segments (was 513
  per 6.43 M — 4.7× down, all deep-horizon t+84–116 s: upstream merges
  shift downstream emitted midpoints AFTER their guard check — repair pass
  queued); G2 jerk p99 0.795 / 0 over 1.0; G3 1.26 flips/min; G9 3
  (2.2–4.4 m, geometry-refresh re-anchor class, pre-existing at the same
  rate); published feeds untouched (0 kinematic violations over 615 k
  segments, v1 13-point shape, determinism byte-identical); one shadow
  accel −1.467 m/s² from the feasibility clamp's unbounded fallback floor
  (fix queued: bound it by −A_BRK). Next lever within the design's own
  tunables: tighten T_disc so the largest gap-carriers teleport honestly
  instead of dragging −200 m errors for 60–90 s — G8 has 7× headroom.

## Teardown

```sh
docker compose -p tram-lab down            # stop (keeps data volumes)
rm /etc/dokploy/traefik/dynamic/tram-lab.yml
# volumes tram-lab_lab-data (the archive!) and tram-lab_grafana-data survive
# until explicitly removed with `docker volume rm`.
```

NOTE: since 2026-08-16 the compose mounts the MAIN checkout
(/root/code/pets/tram-app) as /repo — verified via the container's compose
labels. Code changes apply with `docker restart tram-lab`; the runtime loads
sources at boot (tsx, no watch).
