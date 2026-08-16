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
call, no extra inference cost):

- **`opinion`** — v1's curve plus the **modal stop rule**: while the learned
  release model says `P(departed | elapsed + already-standing) < 0.6` under
  `Normal(releaseStats.mean, sd)`, the curve HOLDS at the platform; at the
  crossing it departs at full learned pace (`LearnedModel.walkFrom`). Extra
  keyframes are inserted at the release instant and +5 s so a 10 s grid cannot
  smear the departure into a creep. This is the fix for the 2026-08-13 field
  report: the mean-optimal expectation floats off the platform while the real
  tram is still standing.
- **`smooth`** — server-owned continuity. Each re-emission starts exactly where
  the PREVIOUS smooth track says the tram is at the new `emittedAtMs` (≤2 m,
  server-enforced), then converges onto `opinion` within 30 s. If the opinion
  is BEHIND the rendered position the track holds instead of reversing (trams
  don't drive backwards) — the protocol's explicit exception to the 30 s bound.
  `discontinuity:true` (smooth starts AT opinion) on trip change or a >150 m
  break; a first-ever emission is `false`.

Both tracks are monotone in `t` and non-decreasing in `s`, ≤24 points, ≥120 s
of horizon — the client is one binary search + lerp (`evalTrack`), no state.

Determinism: the whole v2 body, `serverNowMs` included, is frozen for the 2 s
cache window, so any two clients fetching inside it get byte-identical bytes
and render identically. The price is that a client's clock offset can be up to
2 s stale; `serverNowMs − atMs` makes the bundle's real age visible.

Verify any of this against the live service:

```sh
node lab/scripts/check-v2.mjs            # wire contract + continuity invariant
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

## Teardown

```sh
docker compose -p tram-lab down            # stop (keeps data volumes)
rm /etc/dokploy/traefik/dynamic/tram-lab.yml
# volumes tram-lab_lab-data (the archive!) and tram-lab_grafana-data survive
# until explicitly removed with `docker volume rm`.
```

NOTE: the compose currently mounts THIS worktree as /repo. If this branch's
worktree is ever removed, redeploy from the main checkout after merging.
