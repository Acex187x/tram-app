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
| `ml-drive` | curvegen-v3 **opinion**: the virtual-tram drive (design §2 + the v3.1 driver doctrine §14 — ML as timetable, learned dwell/pace absorption hierarchy, evidence-gated request-stop skips, jam holds, same-rail anti-collision). Runs as the shadow chain and serves phones that select `?gen=v3` (build 15 «Движок физики») |
| `ml-drive-smooth` | curvegen-v3 **smooth**: the smoother regime table (track/catch-up/yield/hold-follow + §6 creep) re-run over the drive's own opinion |

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

**Doctrine gates (2026-08-17, design §14).** Three additive gates joined
G1–G9, each measured twice (generator counters with full context under
`/api/summary → perceptual`, and independently from served bytes by
`check-v2.mjs` via `/api/live` + `/api/geometry-pack`):

- **G10 behindFix = 0** (every gen, incl. `current` — hotfix class): the
  opinion/fixed track never starts behind its anchor fix, and a same-anchor
  AGE re-emission never falls behind the previously rendered opinion. Counted
  under `realism.g10behindFix` / `shadow.realism.g10behindFix`; the
  anchor-floor firing population (where published bytes may differ from the
  pre-hotfix builders) is under `trajectories.anchorFloor`.
- **G11 midSegmentStops = 0** (v3): stand episodes (v < 0.5 m/s sustained
  > 3 s) outside stop zones with no evidence backing. Evidence-backed stands
  are telemetry, not violations: `jamHolds` (observed-stuck, §14.3) and
  `queueHolds` (pressed behind a standing leader, §14.4).
- **G12 collisionViolations = 0** (v3): a follower's curve never penetrates
  its leader's clearance (generator, exact) / same-shape curves never cross
  (bytes). Ordering evidence is fresh fixes (≤ 30 s), stale fixes fall back
  to the nowcast; near-tied pairs get leadership hysteresis; alias pairs
  (< 15 m separation — one double-reported consist) are excluded.

Doctrine telemetry rides beside them under `perceptual.doctrine`: request-stop
skips with recent examples (§14.2), jam emissions (§14.3), leader-clipped
emissions (§14.4), plus drill-down offender lists for G7/G11/G12.

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

### Measuring what the PHONE draws (not what we serve)

```sh
node lab/scripts/client-path-replay.mjs 240000
```

Every gate below scores the SERVED curve. None of them evaluate the client's
fix-forward shim (`src/lib/physics/fixForward.ts`), which is what the owner is
actually looking at — and that gap is how three sessions of green gates
coexisted with «трамваи стоят посреди перегона». This script polls the two
feeds a phone polls, at a phone's cadences, renders the fleet at 4 Hz and
reports backward steps (attributed to fix update vs bundle swap), stall time
while the curve says the tram is moving, and time rendered behind the newest
fix. **Re-run it after any change to either side of the shim** — it is the only
number that describes the screen. See the 2026-08-19 Findings entry.

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

- **2026-08-19: the gates were measuring the wrong thing, and the fix for
  that measured the build-16 stall.** Every gate here scores the served curve;
  the phone draws the served curve wound forward onto a fix the server had not
  seen when it built it, at a bundle age of up to ~7 s. `client-path-replay.mjs`
  (new, see Run/operate) replays that path against the live feeds. Results,
  4 min, gen=v3, ~280 vehicles:
  - build 16's `max(curve, fix)` clamp renders a tram **standing still for
    2.5–3.0 % of all the time the served curve says it is moving** — the
    «останавливаются посреди перегона» report, previously invisible to every
    gate because the served curve is fine; the CLAMP is the stall.
  - the served curve is behind the phone's newest fix for ~10 % of the fleet at
    any instant, median 73 m, p90 228 m (agreeing with M2's 48 %-at-arrival).
  - **Backward steps are a swap phenomenon, not a fix phenomenon.** Attributing
    every one of them: 0–1 caused by a new fix, **796 of 809 by the bundle
    swap** — the fresh curve landing behind the phone's marker because the
    §14.7 seam floor referenced `evalTrack(prev, t0)`, i.e. where the previous
    curve sat rather than where the client draws it. Fixed by
    `clientProjectionM` (trajectory.ts), which both generators' seam floors now
    use; the `seamJustifiedM` bound still caps it.
  - A space-shifted client shim (`curve + gap`) was tried and rejected on
    measurement: same backward-step count as the time shift (844 vs 854) and it
    carries platform holds off the platform. The time shift ships.

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
  **Cycle 2 (same day, 41 min fresh window 10:23–11:04Z, matched n=9 004):**
  queued fixes landed (feasibility floor bounded by −A_BRK → shadow G1 back
  to 0 over 618 k segments; check-v2 long-run crash fixed) and T_disc went
  300/900/1.1 (G8 1.72 %, inside the ≤3 % budget). Result: bias −60.8 →
  −57.6 (the lever's projected ~3 m), mean gap vs ml-smooth +10.1 → +10.8
  (window-differenced ≈ flat) — the T_disc lever is EXHAUSTED per its own
  CDF math (bias ≥ −45 would need 16–20 % teleports). Re-specced G5 (bytes):
  near/moving p50 15.0 ✓ (≤16) / p90 42.0 ✗ (≤32); near/standing 32.0 ✓ /
  47.0 ✓; far p90 72.0 ✗ (≤60) — the tails are envelope-forced extensions
  (27 % of catch-up steps envelope-bound), the §8 clause's counted-not-
  excused case. G4 10 → 13: NOT the repaired class — consecutive SINGLE-step
  segments at 9–11 m/s across 7–8.8 caps, i.e. compression positional drift
  relocating the sim's legal speeds into capped zones (unsplittable by the
  repair pass); fix direction: pin emitted knot s to the fine sim's s
  instead of re-integrating endpoint trapezoids — needs its own cycle (it
  changes the chord/knot-speed consistency the seams read). Also caught
  live: 16 unflagged 170–630 m PUBLISHED-feed seams during a feed/ML drop —
  the OLD generator's known dropped-chain-rebuild class (no chainBroken);
  the v3 shadow flagged its 112 equivalent breaks honestly in the same
  window — an argument FOR the flip, not against it.

- **2026-08-17 (drive-v3 cycles 1–2): the honest-price theorem + the published
  feed caught lying.** After two tuning cycles every control defect in the
  smooth track is dead (divergences 0, ceil-below-ref 0, behind-unconverged
  22/6,586, G1/G2/G3/G8 green). The residual −57.6 bias / +10.8 m vs the
  published smooth is CDF-provably not recoverable by the discontinuity
  threshold: the carry mass lives in 120–300 m model re-anchors too frequent
  to teleport within any honest budget. Meanwhile check-v2 caught the
  PUBLISHED generator emitting 16 unflagged 170–630 m seams during a feed/ML
  drop (the dropped-chain-rebuild class) — the incumbent's metric advantage
  is partly silent teleportation. Deep levers identified: (a) ML nowcast
  noise reduction (filter the re-anchor sequence — attacks the root, helps
  every variant), (b) owner-level product call on the metric-vs-honesty
  trade. Opinion track ml-drive is flip-grade regardless: 81.7 m, −10.7 m vs
  published, all gates green. G4=13 isolated to compression positional drift
  (fix: pin knots to fine-sim positions — queued); G5 re-specced by start
  state (§8 erratum dc60d11) after the spin-up floor measurement.

- **2026-08-17 (drive-v3.1): the driver doctrine, the anchor-floor hotfix, and
  a day of measured shakedowns.** Owner build-15 field directive encoded as
  design §14 (driver vs dispatcher) and implemented in the v3 generator; the
  published gen took exactly ONE shared correctness hotfix. Verified over a
  41-min bytes window (15:52–16:33Z checker) + 46 min of server counters on
  the final code (n=12,774 matched events, evening peak):
  - **Anchor-floor hotfix (all gens): the fixed track can no longer teleport
    behind the latest fix.** ML Δs < 0 clamped at the single point the
    samples are built; age re-emissions floored at the previously rendered
    opinion, per chain. G10 = **0 / 35,314** emissions (bytes) and 0/0 on
    both generator chains. Published-gen byte impact measured, not asserted:
    Δs-clamp fired on 1,886 of 19,303 emissions (5,680 samples), the age
    floor on 3,876 — everywhere else the builders are pure functions of
    unchanged inputs. Published bundle stayed pristine through the window:
    0 kinematic violations / 773k segments, seams ≤ 0.15 m, byte-determinism
    intact.
  - **Doctrine mechanisms live** (v3 only): dwell-first absorption within
    learned p10..p90 + pace band ±20 % (was ±50 %); evidence-gated
    na-znamení skips (6,743 skips; trusted-long-dwell veto; ML no-dwell
    test); jam holds descending from tramSim stuck-hold (38 observed-jam
    emissions; ML pressure suspended; smooth S-curve exits); anti-collision
    with fix-evidence ordering, leadership hysteresis, alias-pair (< 15 m)
    exclusion and an opinion seam that never re-anchors through its leader
    (1,214 leader-clipped emissions). Every step of tuning was driven by
    live drill-downs (`perceptual.g7recent/g11.../g12...`), five measured
    classes killed in-session (trim smear-chase, blindness boundary step,
    horizon-end trim starvation, stale-fix pair inversion, ML phantom
    overtake).
  - **Gates:** G1 0 / 707k segs · G2 p99 0.800, 0 > 1.0 · G3 1.03/min ·
    G4 5 (compression-drift class, was 13) · G8 1.2 % · G9 max 2.81 m
    (geometry-refresh class, 8 in-window) · **G10 0** · G11 17 gen-side
    (jam/queue stands correctly classified: 75/44) · G12 117 gen-side
    (0.6 % of emissions; bytes 96 — concentrated in one line-9 terminus
    cluster of overlapping/aliased vehicles). G5 near/standing green
    (30.0/48.8 ≤ 32/55); near/moving 18/39 vs 16/32 and far p90 68 vs 60
    MISSED (evening peak; envelope-forced tails — counted, not excused);
    G6 p95 2.0 (pre-existing miss, measured on the pre-v3.1 code at the
    same rate).
  - **Accuracy (matched n=12,774): the doctrine costs ≈ nothing and fixes
    the bias.** ml-drive 81.8 m mean / −13.8 signed — BEATS the published
    ml-mode (85.9 / −31.0) on mean, p90 (185 vs 216) and bias despite the
    tighter pace band. ml-drive-smooth 95.7 / −37.0 vs ml-smooth 86.1 /
    −32.6: the +9.6 m continuity gap holds from cycle 2 (+10.8), while the
    signed bias recovered −57.6 → −37.0 — the anchor floor and the doctrine
    absorbed 20 m of the systematic lateness. Both v3 variants clear the
    ship bar vs learned (103.3 / −54.1) by 8–22 m.
  - **Residual list (ranked):** (1) G7 442 dips / 19,303 emissions (2.3 %,
    all smooth-track, shallow 1–2 m/s ease-offs — the reference-mirroring
    class at g ≤ 25 m and seam transients; opinion-side is clean); (2) the
    line-9 terminus cluster's G11/G12 residuals (stand-classification
    thresholds and smooth transitional crossings among semi-aliased
    vehicles); (3) G5 near/moving + far peak-hour tails; (4) G6 hunting
    p95 2 (pre-existing); (5) ahead-unconverged 327/1,773 — grew by design:
    creep-instead-of-phantom-stand repays leads at the next platform,
    sometimes beyond the horizon.

- **2026-08-18 (OWNER FIELD REPORT #4): the backward-flying fixed marker —
  measured, mechanized, fixed (§14.7 seam rule + G13 + client floor).**
  Build-15 symptom: a fresh fix arrives, the tram follows it, then ~5–10 s
  later the «fixed» marker FLIES BACKWARD past the fix and stands. G10
  (0 violations throughout) could not see it — it is a CROSS-EMISSION swap
  class, instrumented 2026-08-18 00:00 (SeamCounters + FreshnessCounters,
  `/api/summary → seam`, both chains). Pre-fix window (33 min, night):
  - **M1 swap regression is constant**: published chain 1,094 fix
    re-emissions → 365 (33 %) stepped backward > 2 m at the seam; backward
    step at worst client swap lag p90 **87.5 m** / p99 141.5 m (shadow:
    p90 130.5). Mechanism confirmed: the re-anchor lands at nowcast ≈ fix +
    ds(latency), BEHIND the old curve's projection (archetype: fix moved
    338 m, prevO 89 m past the new fix ≈ latency × speed — continuity was
    owed; counter-archetype: fixes flat, prevO 150 m ahead — overshoot,
    correction owed).
  - **M3 rides on M1**: 306/365 of the big regressions START STANDING
    (modal hold at an at_stop anchor, 273 after a MOVING fix) — the marker
    jumps back AND «тупо стоит».
  - **M2 freshness race is the night-dominant miss**: at fix arrival the
    served opinion trailed the just-landed fix by > 50 m in 36 % of 1,390
    arrivals (p90 205 m, max 598); the phone adds up to ~7–9 s of poll +
    cache lag on top. 114 arrivals contradicted a STANDING curve from
    ahead.
  Fixes: (a) §14.7 seam rule in BOTH generators — evidence-based bound
  `justified = fix + fixAge·vObs + 20 m` (vObs from the fixes themselves):
  within it the new opinion STARTS AT the previous projection (continuity),
  beyond it the honest backward correction stands, modal/jam starts exempt
  (current standing evidence wins); §14.4 leader clamp still outranks.
  (b) G13 «swapRegression» gate (target 0) in SeamCounters + check-v2
  two-fetch byte analysis grounded in /api/live fixes; selftest D19.
  (c) CLIENT last-mile floor (ships with the next build): in fixed mode the
  rendered s is floored at the newest same-trip RemoteFeed fix — the marker
  can never be drawn behind the dot («если мы знаем что трамвай уже
  впереди, эта позиция вообще не должна показываться»); smooth is never
  floored client-side. Two same-night refinements from the first live G13
  hours (both byte-checker-caught): the standing exemption asserts only
  ≥ 5 s holds (`TRAJ_STAND_ASSERT_MS` — sliver holds yanked 50–180 m and
  immediately departed), and the late-swap clause allows 10 m of post-seam
  physics drift (seam speed cap + trim ease from an EXACT floored seam).
  Post-fix clean window (00:47–01:22Z): check-v2 G13 0/95 grounded pairs,
  G10 0/628, G1/G2/G9/G11/G12 all 0; server counters G13 published 2/641
  (0.3 % — a small-magnitude residual, back0 ≤ 10 m / late drift ≤ 20 m,
  vs 33 % at p90 87.5 m pre-fix; `g13Recent` full-context ring deployed to
  characterize it overnight), shadow 0/783. Matched accuracy unchanged.
  Poll cadence 5 s → 3 s NOT taken: the client floor closes the race at the
  pixel level for free, so the battery budget stays.

- **2026-08-19 (G12 anti-collision): three mechanisms killed, and the real
  through-passing traced OUT of §14.4.** Trigger: `collisionViolations` had
  reached 14,372 over 35 h and read like a 100× regression on the v3.1
  window's 117. It was not one.
  - **The headline number was a UNIT error.** `collisionViolations` sums
    violating SAMPLED SECONDS, and one bad emission contributes its entire
    ~120 s horizon; dividing by `emissions` overstates incidence ~100×. The
    2026-08-17 "117 / 0.6 % of emissions" had the same bug, so the two were
    never comparable. `g12collision.tracks / measuredTracks` is now the
    per-emission population, with `penM.over5` as the through-passing gate.
  - **The counter and the product defect are different populations.** A
    bytes-side probe (`lab/scripts/g12-probe.ts`, 25 min, 9,612 emissions,
    24,118 pair-tracks) found **30 genuine curve crossings, p50 118.8 m, max
    336.6 m, all on line 9** — while the generator's own G12 moved +8
    violating seconds in a comparable window. The counter could not see them:
    every `leaderFor` / `effLeader` `return null` is a hole where the
    constraint does not apply and therefore cannot be violated. Two framings
    from the v3.1 report were wrong — the cluster is NOT at a terminus (all 30
    are 3.7–8.7 km from either shape end) and NOT standing-related (0 of 1,734
    violating seconds had a standing follower).
  - **M1 — the inherited overlap was FROZEN, not repaid.** `effLeader` clipped
    the enforced gap to `max(0, clear0 − 0.5)`, so an inversion the seam
    handed the drive (its own fresh fix / modal hold / smooth continuity all
    legitimately outrank an older leader curve) was charged as fresh
    penetration every second, and the `vLead` cap meant the pair could never
    heal — it persisted a full horizon and was re-inherited by the next
    emission. Fixed: the gap is a SCHEDULE, `gap0` may be negative, and it
    relaxes to nominal at `QUEUE_GAP_RECOVER_MS` 0.5 m/s with the follower
    held at `vLead − 0.5` inside the boundary (floored at 0 — a speed cap
    never reverses). Sim cap and G12 measurement now read one schedule, so
    `pen(t_E) = −0.5 m` by construction and a violation means only "closed
    faster than the recovery allows". Live proof of the repayment, one pair
    across consecutive emissions: gap0 **−38.6 → −21.1 → −12.5 → −7.2 → −5.3
    → −4.3 m**.
  - **M2 — a diverging curve could declare ITSELF the leader.** Ordering fell
    back to `max(nowcast, fix)` past 30 s of fix age. But ORDER and POSITION
    age at different rates: order is topological and survives silence ("
    overtaking is rare"), while position diverges fast — measured fleet-wide,
    a curve sits a median **343 m** past its own fix at 60–120 s of fix age
    (max 1231 m). 28 of the 30 crossings had a stale fix on at least one side
    (only 2 fresh/fresh) on pairs whose FIXES were a queue-distance 20–32 m
    apart. Ordering is now fix-based at every age, matching the alias
    exclusion and leadership memory which were already fix-based; the
    phantom-cap failure the fallback guarded is handled by
    `QUEUE_INVERT_MAX_M` (5 → 60 m), the band inside which an inversion is
    clipped-and-healed rather than dropped, sized so a full-band inversion is
    repaid within one horizon.
  - **M3 — an ended leader was treated as a leader PARKED.** `evalTrack`
    freezes past the last knot, and emissions are staggered by a median
    **15.6 s (max 56 s)** across the bundle, so a follower's horizon routinely
    outlives its leader's. Both the sim and the measurement braked for / counted
    against a phantom at the leader's final position — at 8 m/s a 15 s stagger
    is 120 m of pure artifact. This was the entire "grown" class (every
    violating track showed `penAt0 = −0.5` then tens of metres accumulated
    late). Fixed: the constraint lapses past the leader's last knot (no
    prediction ≠ a prediction of standing, §14.4/G11), and `measureCollision`
    samples only where both curves are defined.
  - **Hypotheses measured and DISCARDED rather than assumed.** The
    leader-freshness guard (`staleCurve`) — **0** over 5.8 k calls; a vehicle
    whose fixes stop arriving keeps `fixObsAtMs === observedAtMs` and stays
    leadable. The leadership-memory lock (`memoryHeld`) — **0**, so the memory
    was NOT pinning wrong orders and was left in place. The `[−5,−1)`
    frozen-overlap class predicted from the drill-down ring — **0
    occurrences**. New `shadow.leaderPick` gauge makes all of these visible:
    the real leader-drop mass is `tooFar` (>1500 m, ~68 %) and `noCandidate`.
  - **The residual through-passing is NOT an anti-collision defect** —
    forensics (`lab/scripts/g12-forensics.ts`) caught it with full context.
    The leader's SMOOTH curve renders **behind its own fresh fix** while the
    §6 catch-up converges: leader 8529, fix 14769.0 @ 6 s, smooth at 14652.5 —
    **−116.5 m behind its own fix** — recovering −116.5 → −102.1 → −84.7 →
    −46.9 → −9.8 → +5.2 → +53.6 m over ~25 s. Any same-shape vehicle behind it
    renders as passing through it. G10 floors only the OPINION, and the §14.7
    client last-mile floor deliberately does not apply to smooth. §14.4 cannot
    repair this without teleporting a curve backward, which §14.7/G13 forbid.
    Recommended next step (NOT taken here — it is a §6/G5 change with accuracy
    implications): floor the collision boundary, and the rendered smooth, at
    the leader's own anchor fix, the same "a fix is evidence" rule G10 already
    applies to the opinion.
  - **Post-fix window (45 min, 15:29–16:14 local, 19,095 shadow emissions).**
    Generator-side G12 **11 violating track-emissions / 2,250 leader-clipped
    tracks**, i.e. **0.029 % of all track-emissions — the < 0.1 %-per-emission
    target is MET** — but `penM.over5` = 8 (p50 20.4 m, p90 31.9 m), so the
    **"no through-passing above 5 m" bar is NOT met**. Class split is the
    proof M1/M3 landed: **0 inherited, 11 grown**, every one with
    `penAt0 = −0.5 m`. The constraint now actually engages on inversions
    instead of dropping them — 15 inverted seams clipped-and-healed inside the
    band vs 8 dropped beyond it. Bytes side (check-v2, 40 min, 34,750 tracks,
    696 k segments): G12 **58 / 26,880 pair-tracks = 0.216 %**, down from
    0.484 % pre-fix (2.2×), but magnitudes still p50 35.3 m / max 626.1 m.
    Unregressed elsewhere: G1 0, G2 p99 0.800 with **0 over 1.0**, G3
    1.03/min, G8 1.0 %/0.5 %, G11 56 / 20,560, G4 25 (all smooth, **seg12 0**
    — the seam class stays dead). G5 near/moving p90 40 s, far p90 68 s and G6
    p95 2.0 fail at the same rate the README already records as pre-existing.
    Determinism intact. **Matched accuracy stable (n=7,233):** ml-drive 79.8 m
    mean / −8.3 signed / p90 181.9 vs published ml-mode 85.6 / −24.9 / 217.3;
    ml-drive-smooth 91.1 / −25.4 — both at or better than the v3.1 window
    (81.8 / −13.8 and 95.7 / −37.0), so the recovery cap costs nothing
    measurable.
  - **What the residual actually is, measured (50 forensics events + 62 probe
    crossings).** `diffTrip` **50/50**; `follower-projects-far-more` **46/50**;
    stale-follower/fresh-leader **41/50**; and the probe's decisive column,
    **follower's emission OLDER than the leader's in 53 of 62**. The archetype:
    a follower's AGING emission is rendered against a leader that has since
    re-anchored on a fresh fix and often stands (`curve == fix == engine`
    exactly). The constraint was satisfied when the follower was built — the
    bundle then ages and the pair becomes inconsistent in the rendered frame.
    `probeCrossing` exists precisely to re-emit such followers and is
    demonstrably not converting them; that, not the clearance math, is the
    next lever. Second contributor, same data: a leader's SMOOTH curve renders
    behind its own fresh fix while §6 catch-up converges (8529 measured at
    **−116.5 m behind its own fix**, recovering to +53.6 m over ~25 s), and
    G10 floors only the opinion. Both are outside §14.4 — no clearance rule
    can fix a stale bundle or a lagging catch-up without teleporting a curve
    backward, which §14.7/G13 forbid.
  - **G13 verdict: bounded, and the constant is now chosen from data.**
    Published **21 / 10,747 (0.20 %)**, shadow **0 / 13,054**. New
    `lateDriftM` histogram over 3,545 continuous-seam re-emissions: p90
    **0.25 m**, p99 **8.25 m**. The new `lateTolTable` shows every violation
    sits in a narrow band just above the current slack — tol 6 → 76 fires,
    tol 10 → 21, **tol 15 → 0**, tol 20 → 0, tol 30 → 0. The pre-restart
    `g13Recent` ring agrees: 16 of 17 events at `back0 ≈ 0.00` (the continuity
    floor landing exactly) with +2 s drift 10.05–15.33 m, 0 standing starts.
    So the residual is NOT a backward teleport — the seam is exact and the
    class is post-floor deceleration drift, bounded at ~15 m. Left at 10 m
    deliberately: raising the constant to 15 would zero the counter without
    changing a pixel, and this project counts rather than excuses. (The
    "missing g13Recent observer" in the task framing was a false alarm — it
    lives at `seam.published.swap.g13swapRegression.recent`, not under
    `perceptual`.)
  - **Byte impact:** none on the published default gen. `TRAJ_V3_PUBLISH` is
    unset, so `current` is built by `trajectory.ts`; every change is confined
    to the v3/shadow chain (`drive.ts` + the shadow leader wiring).
    Determinism intact (5 fetches byte-identical, eval digest reproduced).
    New selftests `drive/queue-inverted`, `drive/queue-wide-inversion`,
    `drive/queue-lapse` cover M1–M3.

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
