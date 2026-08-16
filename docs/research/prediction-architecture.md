# Prediction System v3 — Research: server-side, self-calibrating, multi-city

Status: **RESEARCH (2026-08-08)** — options analysis and a recommended target
architecture for the next-generation prediction system. No decision executed,
no code changed. Companion decision records once work starts: this document
splits into an ADR per phase (`decisions/`).

The question asked (owner's brief, distilled): today's engine rests on
hand-shaped coefficients; to scale to ~50 cities every network behaves
differently, and even within Prague behavior varies by route, position and
consist. Three candidate directions were proposed: (1) train an ML model
server-side on live data, (2) rewrite the physics engine as a deterministic
server-side function calibrated in real time, (3) something between — a set of
small learned models corrected by an algorithm. Requirements: maximum tracking
accuracy, continuous real-time adaptation (jams, weather, season) on the
backend, and a thin client that receives near-ready data.

**Verdict up front: option 3, concretely shaped.** A deterministic, physically
structured predictor (the skeleton we already have) whose *parameters* are a
hierarchy of small, continuously-learned statistical models (which we already
half-have on Convex), plus a new **fast-adaptation layer** (minutes-scale
corridor residuals + leader–follower signals) and a **trajectory wire
protocol** that moves the whole predictor server-side while keeping a ~city-
agnostic micro-renderer on the client. A monolithic learned model is rejected
as the core (§6.1); optional ML slots remain at well-defined leverage points,
gated by a measurement harness this plan builds first (§7.4).

---

## 1. Requirements extracted from the brief

| # | requirement | measurable form |
|---|---|---|
| R1 | maximum achievable position accuracy | fleet-wide predicted-vs-actual error at horizons 15/30/60/120 s; ride ground truth (`fLagM`) where available |
| R2 | real-time adaptation (jam, rain, season, network change) | prediction error during disrupted periods recovers within minutes, not days; no manual retuning |
| R3 | computation on the backend, thin client | client per-frame work = O(visible trams) trajectory evaluations; no client-side learning, polling, or physics integration |
| R4 | scale to ~50 cities | new city = adapter + config + data, zero engine code; day-1 service from GTFS static alone |
| R5 | (implied by repo culture) every change gated by replay evidence | the existing TS replay gate generalizes to a continuous server-side harness |

## 2. Where we actually are (verified against the repo, 2026-08-08)

### 2.1 Client — engine v2 (`docs/decisions/engine-v2.md`, shipped 2026-08-01)

Three layers per tram, all on-device: **fix → predictor → smoother**. The
predictor reseeds on every genuinely-new fix and advances **closed-form**
(segment by segment: learned cruise pace between stops, dwell budgets at
stops, braking envelope, holds/pins), then dead-reckons at
`P = min(cruiseCap, V_CRUISE_REF)·paceBias·tod`. The smoother is a
presentation-layer chase controller (hold-follow / track / catch-up / yield /
teleport regimes). ~3,100 lines of engine + profile code; per-vehicle
`paceBias` EWMA learned on-device; `TOD_PACE_TABLE` / `TOD_DWELL_TABLE` exist
as hooks and are **still all 1.0** — the calibration program never had enough
data to fill them (`speedProfile.ts:140,174`).

### 2.2 Server — Convex backend (built; `docs/decisions/backend-convex.md`)

Already running: 24/7 self-rescheduling poller (2 s cadence against Golemio's
`s-maxage=5` CDN), normalize → diff → `batches` stream (change = `observedAtMs`
advanced or `shapeDistM`/`tripId` changed; retention 10 min), `RemoteFeed`
consuming it behind the unchanged `TramFeed` seam, and — the important part —
**server-side continuous calibration** (`convex/calibration/fold.ts`): every
fresh fix pair folds into time-decayed EWMAs (half-life 14 d) keyed
`segmentStats(shapeId, 250 m bucket, 4 h hourBand, dayType)`,
`modelStats(model)`, `vehicleStats(key)`, `stopStats(stopId, hourBand,
dayType)`, with R13 moving-span gating so signal standstills never pollute
pace. Hourly cron compacts a client-facing prior bundle. Geometry serving and
client prior seeding are designed but not yet wired (rollout steps 3–4).

**Raw fixes are never stored** — a deliberate phase-1 choice
(`fold.ts` header). Consequence: no training corpus, no server-side replay, no
retrospective evaluation of anything.

### 2.3 Measured accuracy and the anatomy of the error

From the executed v2 ship gate (`docs/calibration/baselines/gate-v2.md`,
3-ride rider-GPS ground truth) and the calibration program:

- **Predictor (live mode): mean |err| ≈ 107 m, p50 ≈ 87 m, p90 ≈ 223 m.**
  Smoother (smooth mode) ≈ 139 m mean — deliberately worse: it buys
  monotonic, cinematic motion (trail, no rewinds) at the cost of lag.
- **The dominant error source is fix staleness, not model dynamics.** Golemio
  per-vehicle fix cadence is p50 45–55 s, p90 ~95 s, plus 8–14 s hidden
  pipeline latency. At ~5.3 m/s (19 km/h) mean corridor speed, the tram moves
  ~250–350 m between fixes; the engine must *predict*, not interpolate.
- Error is born at stops: 63 % of AVL records are `at_stop`; the feed holds
  `at_stop` 50–75 s per platform while real dwell p50 ≈ 17 s. Whether the tram
  is still standing or left 40 s ago is the single largest unobservable.
- Measured TOD pace factors came out ≈ 1.0 for every hour; the real structure
  found so far is **zonal** (centre corridor ≈ 19 km/h flat around the clock)
  and per-vehicle. The "peaks are slow / nights are fast" intuition lives
  mostly in **dwell**, and in the tails, not in cruise pace.

### 2.4 Gap between this and the brief

1. Prediction still runs on every phone; the server streams raw fixes plus
   (soon) priors. R3 unmet.
2. Learning adapts on a **14-day** half-life with 4-hour buckets. Nothing
   adapts in minutes: no live corridor state, no leader–follower signal, no
   per-trip delay dynamics. R2 unmet.
3. No fix archive → no server-side accuracy metric, no continuous evaluation,
   no corpus for any future learned component. R1/R5 unmeasurable fleet-wide.
4. Ingest/normalization is Golemio-specific; no city abstraction. R4 unmet.

The foundation, however, is unusually good: the predictor is already
closed-form (event-driven, cheap — exactly what a server needs), the engine is
pure TS behind one seam (Convex already bundles `src/lib` imports, design §5),
and the calibration tables are precisely the "small models" of option 3.

## 3. The physics of the problem: what bounds accuracy

Any predictor — neural or handwritten — computes an estimate of position given
the same information: last fix (age 8–110 s), route geometry, schedule,
learned history, and the live state of *other* vehicles. The residual error at
these horizons is dominated by discrete, fundamentally unobserved events:

| unobservable | scale of induced error |
|---|---|
| did it already leave the stop? (AVL holds `at_stop` up to ~75 s) | 0–300 m |
| red signal / blocked junction mid-segment | 0–200 m |
| dwell length today (demand, wheelchair, tourist crowd) | ±10–40 s ≈ ±50–200 m |
| pace variance driver-to-driver, consist-to-consist | ±10–15 % of distance run |
| a jam that started after the last fix | unbounded until *some* vehicle samples it |

Three consequences frame the whole design:

1. **No model class removes these.** A transformer given the same inputs faces
   the same conditional uncertainty. Model sophistication converts into
   accuracy only where the inputs contain unexploited signal.
2. **The unexploited signal that exists is cross-vehicle and temporal**: the
   tram 90 s ahead through the same corridor *measured* today's pace and
   today's jam; the same stop served 4× in the last hour *measured* today's
   dwell regime; this trip's delay trend is autocorrelated. Today we use none
   of it at prediction time. This — not a bigger model — is the accuracy
   frontier at Prague's fix cadence. (Weather and season are absorbed the same
   way: rain shows up as measured slower traversals within minutes; an explicit
   weather feature is a later, harness-gated refinement, §8.)
3. **The step-change lever is data cadence, which varies by city.** Where a
   feed delivers 1–5 s fixes, prediction degenerates toward interpolation and
   errors collapse toward GPS noise regardless of model. Architecture must
   span the 1 s → 95 s cadence envelope with one code path; model investment
   pays off mostly at the sparse end (which Prague is).

## 4. Evidence — production systems and literature

Researched 2026-08-08 (web + primary sources incl. production source code);
URLs in §12. Highlights, ordered by relevance:

**Every production system with documented internals renders between-fix
positions deterministically along route geometry.** OneBusAway interpolates
the *scheduled* trajectory shifted by observed schedule deviation
(`ScheduledBlockLocationServiceImpl.java`, confirmed in source); TRAVIC
(SIGSPATIAL 2014, travic.app) renders worldwide vehicles from timetable +
GTFS-RT delay shift along shapes; TheTransitClock prorates segment times
linearly by distance within a stop path. The canonical academic skeleton is
Cathey & Dailey 2003's Tracker → Kalman Filter → Predictor — the structure
our engine already has.

**TheTransitClock (open source; Swiftly's documented lineage — the Transitime
repo is "created and managed by Swiftly, Inc.") is the strongest template for
our fast-adaptation layer, read from source:**

- Travel-time prediction = **scalar per-segment Kalman blend of (i) the
  immediately preceding vehicle's realized segment time today and (ii) a
  3-day historical average**, gain weighted by historical variance:
  `gain = (lastErr + var) / (lastErr + 2·var)`,
  `pred = (1−gain)·leaderTime + gain·historicalAvg`. A jam reprices followers
  after ONE leader traversal. Explicit cold-start ladder in code: schedule →
  historical average → filter.
- Dwell = **online RLS of log₁₀(dwell) on headway** per stop, forgetting
  factor 0.75 (minutes-scale adaptation); fallback scheduled dwell.
- Post-hoc **bias adjusters**: horizon-dependent residual scaling
  (`y = a·b^x + c`) — production "live residual correction" is a one-line
  multiplicative model.
- Validated: Metro Transit's 2020 bake-off across 1,400 buses found it
  "outperform[ed] the competition … superior predictions during disruptions."
  Swiftly's own claims (15–50 % better than agency CAD/AVL: SEPTA 26 %,
  CTtransit 24 %, Pierce 27 %) sit on this lineage; their internals are
  proprietary.

**Transit app**: ML formula over simple features (time-of-day, day, GPS
report age, delay, location) — +15 % on their patience metric vs agency
predictions; and **GO crowdsourcing densifies the fix stream with rider GPS**
rather than predicting harder. **Helsinki HSL sidesteps prediction entirely**:
1 Hz MQTT vehicle positions; digitransit-ui markers snap to each message —
no interpolation code exists in that path. Both confirm §3.3: data density
beats model sophistication wherever it's available.

**Deep learning evidence is consistently long-horizon.** Google's GNN ETA
(15–45 min road ETA) and Uber's DeepETA solve route-choice/congestion
problems that mostly don't exist for rail-guided vehicles; BusTr covers
cities with NO realtime feed by translating Google's proprietary road-traffic
forecasts — an input we don't have. ArrivalNet (2024, Dresden, includes
trams; 125 days / 5M sequences) beats classical baselines only at 5–10-stop
horizons with tram MAE ≈ 37 s — larger than our whole rendering horizon — and
its baselines did not include a leader+prior Kalman. Follow-up work shows
normalization makes deep models suppress exactly the atypical disruption
patterns we care about ("over-stationarization"); the fix recovers only
~2 % for trams. **No published result shows a deep transit model
transferring between cities without retraining.** DeepETA's transferable
lesson is architectural: deterministic base + learned residual.

**Dwell literature** matches the plan: canonical regression ≈ 5.1 s base
+ 3.5 s/boarding + 1.7 s/alighting; strongest practical predictors without
passenger counts are **time-of-day and headway** (bunching: long gap → more
waiting passengers → longer dwell) — exactly `stopStats` + a live headway
term.

**Weather, measured**: Melbourne 5-year tram AVL study — +1 mm peak-period
rain ≈ **+8 s** average travel time; macroscopic urban studies: light rain
+0.1–2.1 %, heavy snow +7–11 %; temperature negligible. Conclusion for us:
steady-state weather is smaller than and subsumed by a leader/residual signal
within minutes; the one regime worth an explicit multiplier is
**snow/day-type**, plus first-service-after-onset segments with no leader.

**Tram specifics**: documented modern-tram initial acceleration 1.2–1.3 m/s²
(Avenio 1.2, Flexity E-class 1.3) — our `A_ACC 1.3`/`A_BRK 1.4` p90 IMU
values are the documented class, i.e., genuinely city-portable kinematics.
Signal priority (6–27 % run-time reduction, ~35 % variance reduction where
deployed) makes inter-stop times **bimodal, low-variance** — favoring
per-segment distributions + kinematic caps over smooth-congestion models.
Particle-filter precedents exist for exactly our shape (Elliott & Lumley
2020: real-time PF vehicle model over a GTFS network, Auckland; Hans et al.
2015: route-state PF predicting bunching at 8-min windows) — the upgrade path
from our deterministic predictor if §7.4 ever shows multi-hypothesis wins.

**Prague upstream (important operational lead):** ROPID's own docs state the
MPVnet dispatch source updates vehicle statuses "typically in 10–20 second
intervals," arriving in 5–20 s XML batches — while we measure p50 45–55 s
per-vehicle at the Golemio v2 endpoint. If a fresher tier (ROPID realtime
XML / newer API) is accessible, closing that gap is worth more than any
modeling work in this document (§3.3). Also documented upstream: the
`delay` field is itself computed by shape-projection + interpolation
(improved MPVnet algorithm), so treating it as ground truth double-counts an
interpolation assumption — prefer our own shape-projected odometry; and
shape self-overlap at loops/terminal balloons requires history-aware
matching (they flag it explicitly).

## 5. Evidence — the 50-city data landscape

Researched 2026-08-08 across 18 tram cities/regions (official portals where
fetchable; URLs in §12; several claims UNVERIFIED where docs are thin —
marked in the source list). The distribution, not the details, is the design
input:

| class | share (n=18) | cities |
|---|---|---|
| **(a)** ≤5 s raw positions | **~6 %** — a singular outlier, not a class | Helsinki HFP: 1 Hz MQTT with heading, speed, acceleration, odometer, **door state**, occupancy |
| **(b)** 10–30 s-class raw positions | **~55–60 %** | Prague (also official GTFS-RT protobuf — but cached 40–50 s vs 5 s JSON, so the JSON path we use is objectively fresher), Budapest, Krakow, Warsaw (~60 s latency!), Amsterdam/NL (event-driven KV6), Brussels, Oslo/Norway (Entur SIRI+GTFS-RT+WS), Melbourne (hard 30 s cache), Toronto, SF (60 req/hr limit), Sydney |
| **(c)** TripUpdates/predictions only — **no vehicle positions at all** | **~28 %** | Vienna, Berlin (VBB feed also publicly degraded for 2+ months in 2026), Munich, all-Switzerland (explicit: "vehicle positions are not available", 2 req/min), Paris |
| **(d)** nothing public | ~11 % | Milan (in-app only), Lisbon city trams (unverified) |

Extrapolated to ~50 cities: ≈half usable 10–30 s GTFS-RT-class feeds (one
protobuf decoder + per-city config covers most), a third predictions-only, a
couple of high-frequency gems, ~10 % closed. Structural facts that shape the
architecture:

- **German-speaking Europe is systematically position-less** in public feeds
  (VDV-453/454 heritage exchanges stop-level times, not coordinates). A
  50-city product therefore NEEDS a **schedule-synthesis mode**: positions
  reconstructed from TripUpdates delay + schedule + shapes — precisely what
  our predictor already does when a fix is stale, running from a "virtual
  fix" (delay at last passed stop). Same engine, lower-fidelity input class,
  honestly labeled in the UI. This is how VBZ's own tram-locator and Berlin
  community feeds work.
- **Per-vehicle fix cadence is almost never documented — it is learned
  empirically per feed** (as this project did for Prague). The canonical
  ingestion layer must measure and store `fix_interval_hint` per feed/mode
  and drive gap-aware logic off consecutive `t_fix` deltas (our engine
  already does; the envelope just widens: 1 s → 60 s+, plus Warsaw-style
  ~60 s *latency* on ~10 s data).
- **Canonical fix = superset with optionality as the design**: three
  timestamp semantics (true AVL time / feed-generation / ingest — record
  which); position as raw GPS OR linear-reference (STIB distance-from-stop,
  KV6) OR schedule-synthesized; bearing missing ~50 %, speed ~always missing,
  delay sometimes only via joined TripUpdates. Each fix carries
  **`position_quality` (raw_gps | snapped | linear_projected |
  schedule_synthesized)** so the filter weights innovation accordingly and
  never "corrects" toward a synthesized position.
- **Rate limits and fair-use terms force the shared server-side poller**
  (SF: 60 req/hr default; Switzerland: 2 req/min; Vienna: ≥15 s fair-use +
  IP bans). Client-side polling is not even *legal-envelope-possible* in
  several cities — independent confirmation of the server-centric move.
- **Feeds fail for months** (VBB degraded since 2026-06). Per-city feed
  health scoring + automatic degrade-to-schedule mode belong in the canonical
  layer, not in per-city code.
- **Licensing is mostly permissive** (CC-BY family, NLOD, OGL; free API
  keys), with contractual attribution in places (511: mandatory "powered by
  511.org"); a few thin/unverified license texts (Krakow, OVapi, Budapest)
  need confirmation before commercial launch. Nothing found that blocks the
  model per se; onboarding gates per city stand (§11).
- **Aggregation platforms mean country ≠ 50 integrations**: Entur (all
  Norway), 511 (Bay Area), OVapi (all NL), Belgian Mobility,
  transport.data.gouv.fr — one adapter per *platform*.

## 6. Options analysis

### 6.1 Option 1 — monolithic ML position model: rejected as the core

What it would be: a sequence model (GBDT-per-horizon, LSTM/GNN) trained on
archived fixes, input = (last fix, route features, schedule, time, weather…),
output = position now / at t+Δ. Server-side inference per vehicle per reseed.

Why not as the core engine:

- **Accuracy ceiling, not floor.** §3: at 5 s–2 min horizons on a rail-guided
  vehicle, position ≈ integral of a piecewise speed process whose structure
  (stops, dwells, signals, curvature caps) we know exactly. A learned lookup
  of that structure's parameters (== our EWMA tables, refined) captures the
  same conditional mean the net would learn, with samples it can get in days,
  not months. The literature (§4) finds deep models earn their keep on
  long-horizon ETA with rich exogenous traffic data — not here.
- **Cold start violates R4.** City #23 launches with zero history. The
  structured engine runs day-1 on GTFS static (geometry + schedule + universal
  tram kinematics: `A_ACC 1.3`/`A_BRK 1.4` are vehicle physics, not Prague
  facts) and converges per-segment within days of self-collected data. A
  monolith needs a per-city corpus + training + validation before it beats
  naive schedule-following.
- **Adaptation latency violates R2.** Retraining is the *slowest* possible
  adaptation loop (hours–days + deploy). The jam/rain requirement is solved by
  cheap online statistics (fast residual layer, §7.2) updating in
  *one traversal*. "Adaptivity" and "learning" are different timescales;
  conflating them is the classic failure here.
- **Ops per city.** 50 training pipelines, drift monitors, model registries,
  version-skew debugging on a self-hosted single-node backend — versus EWMA
  folds that are one internal mutation, already running.
- **It kills the replay-gate culture** (R5). The repo's whole discipline —
  pre-registered constants, signed-error gates, "no constant without a ride
  replay" — assumes an inspectable model. A 100 m regression in a net is a
  shrug; in the structured engine it bisects to a table cell.

### 6.2 Option 2 — deterministic engine, real-time calibrated: right skeleton, insufficient alone

This is essentially the current line of travel (engine v2 + Convex EWMA). Its
ceiling: hand-shaped *global* structure (one cruise ref, zone caps, neutral
TOD tables) with slow per-cell learning. It leaves the cross-vehicle/temporal
signal (§3.2) untouched, keeps prediction on the phone, and its "calibration"
adapts over weeks. Good bones — the closed-form segmented advance, the hold
semantics, the braking envelope all survive — but as stated it does not meet
R2/R3 and undersells R1.

### 6.3 Option 3 — structured probabilistic engine + hierarchy of small learned models: **recommended**

The precise shape of "вариант между": keep the deterministic, physically
constrained predictor as the *skeleton*; make every coefficient it consumes a
*learned surface* with two timescales (slow EWMA structure + fast live
residuals); move the whole thing server-side; emit trajectories, not
positions; measure everything continuously. Details in §7. This is also the
only option that degrades gracefully offline: the same pure-TS predictor runs
on-device from the prior bundle when the backend is unreachable (today's
LocalGolemioFeed path survives as the fallback, one codebase, R4-clean).

## 7. Target architecture

```
                        ┌────────────────────────── per city ──────────────────────────┐
 feed adapter → normalize → map-match →  per-vehicle filter/predictor  → trajectory emit
 (Golemio /      (canonical   (s along     state (s, v, phase, delay)        │
  GTFS-RT VP /    fix)         shape)      + fleet constraints (queue,       ▼
  SIRI-VM /                                  junction, headway)        batches diff stream
  MQTT)                                          ▲      ▲                    │ (Convex)
                                                 │      │                    ▼
                              ┌──────────────────┘      │              thin client:
                              │ slow structure          │ fast state   s(t) eval + micro-
                              │ (EWMA tables,           │ (corridor    smoother + fades
                              │  hierarchical           │  residuals,
                              │  shrinkage)             │  live dwell,
                              │                         │  leader signal)
                              └───── continuous eval ───┘
                                    (fix archive → shadow scoring → dashboard)
```

### 7.1 Server pipeline (per city)

1. **Adapter** — one module per feed protocol producing the canonical fix
   (already `TramSnapshot`-shaped; §5 evidence defines the variance envelope:
   fix rate 1–95 s, optional bearing/delay/state flags). City config: feed
   endpoint(s), GTFS static source, timezone, fleet registry (optional), poll
   cadence.
2. **Map-match** — project to distance-along-shape (exists: feed
   `shape_dist_traveled` for Prague; `projectDistanceOnPolyline` for feeds
   without it).
3. **Predictor per vehicle** — the *existing* closed-form segmented advance
   (`tramSim.ts` semantics: seed at fix, walk stop-to-stop at learned pace,
   spend dwells, respect holds/pins/terminal latches, braking envelope),
   upgraded to consume the layered pace/dwell surfaces (§7.2) and run
   **event-driven inside ingest**: only for vehicles whose fix changed
   (~8–16/poll fleet-wide), O(stops crossed) each. No server tick loop exists
   at all — between events the truth is a closed-form curve that clients
   evaluate locally.
4. **Fleet constraints** — queue (no driving through the leader), junction
   yields, and the new headway clip: a follower's trajectory is clipped
   against its leader's; a leader reseed that frees or tightens the corridor
   re-emits affected followers (bounded cascade over pairs the engine already
   discovers at ingest).
5. **Trajectory emit** — per vehicle, knots `[(t₀+δᵢ, sᵢ, vᵢ)…]` covering
   now → +90–120 s (a knot at every stop arrival/departure and regime
   change, ~6–12 knots, non-uniform: dense near stops), plus hold semantics
   (dwelling-at-stop-idx, pinned, terminal), confidence, and the stop-ETA
   list the UI needs. Re-emitted under the DIS-style policy of §7.3
   (divergence threshold / heartbeat / state change — a confirming fix costs
   zero bytes). Rides the existing `batches` diff-stream pattern — same
   transaction, same subscription shape, at most today's snapshot event rate.

### 7.2 The learned surfaces — two timescales (the actual answer to R2)

**Slow structure (exists, refine):** the EWMA tables, upgraded from fixed
4-hour bands to **hierarchical shrinkage**: estimate at the finest cell that
has weight, shrink toward parents —
`bucket×hour×dayType → bucket×band → segment → route → zone → city-default`.
(The bundle compactor already shrinks vehicle → model → fleet; this
generalizes that discipline to the pace/dwell surfaces.) Season migrates
automatically (14-day half-life); no winter/summer switch to maintain.

**Fast state (new — this is the jam/rain/season adapter):** small in-memory
tables (Convex docs) with minutes-scale decay:

- **Corridor residual**: per (shapeId-bucket-run of ~1 km), the ratio of
  *actually measured* traversal pace by the last K vehicles vs the slow
  surface's expectation, exponentially decayed (half-life ~10–15 min). A jam
  shows up after ONE tram samples it and immediately re-prices every follower.
  Rain slows the whole network → residuals dip everywhere within minutes.
  This is also the theoretical optimum: no system can know about a jam before
  some probe samples it, and our probes are the fleet itself. This is not
  speculative — it is the documented core of TheTransitClock/Swiftly-lineage
  prediction (§4): a variance-weighted blend of the leader's realized segment
  time with the historical prior, validated "during disruptions" in Metro
  Transit's 1,400-bus bake-off. Their gain formula
  (`gain = (lastErr + var)/(lastErr + 2·var)`) is a ready-made starting
  point — our `segmentStats` already tracks the variance it needs.
- **Live dwell regime**: per stop, observed dwell of the last few services vs
  the slow surface (event crowds, replacement-bus chaos).
- **Per-trip delay dynamics**: `delaySeconds` is autocorrelated along a trip;
  a trip running +180 s and growing keeps drifting in the short term — a
  one-parameter AR(1)-style drift per active trip, reset at terminals.

The predictor consumes
`pace(s) = slowSurface(s, t) × corridorResidual(s) × vehicleBias × modelBias`
and `dwell(stop) = shrunk(stopStats) × liveDwellFactor(stop)`.
Every factor is a number a human can read in the dashboard when a tram renders
wrong — that property is worth more than any single accuracy point and is why
the monolith (§6.1) loses.

### 7.3 Wire protocol — trajectories, not position streams

**This exact protocol runs in production on the Swiss railways' public live
map**: geOps Tralis sends per-vehicle trajectory messages — a LineString
between stops plus `time_intervals` of `[timestamp, fraction, direction]`
tuples — re-emitted "whenever a train passes the next stop or new timing
information is available"; clients interpolate the fraction at render time,
with BBOX-scoped subscriptions and timetable-only fallback where realtime is
missing. The same shape is standardized since the 1990s as **DIS/IEEE 1278
dead reckoning**: sender extrapolates its own entity with the receiver's
model and emits a new state only on threshold divergence or a ~5 s heartbeat;
receivers smooth on replacement ("prevents entity teleporting" — our fade).
Game networking (Valve Source, Gaffer On Games) documents the dense-stream
alternative's costs: clients must render 2–3 update intervals in the past to
survive jitter, and naive extrapolation is trusted for only ~0.25 s — for
unpredictable motion; a rail vehicle on known geometry with a learned pace
model is the best possible case for server-authored extrapolation instead
(Flightradar24 renders model-estimated aircraft for minutes to hours on the
same logic).

The brief proposed streaming server-computed positions every 500 ms–1 s.
Rejected — the arithmetic (repo-derived, Prague-scale):

| | trajectory keyframes (recommended) | 500 ms position stream |
|---|---|---|
| emit trigger | fix that *diverges* / constraint change (upper bound: ~8–16 vehicles per 2 s poll ≈ **≤5–8 msg/s** fleet-wide; less under the divergence policy) | clock (**~800–1000 msg/s** at 400–500 vehicles × 2 Hz) |
| server DB writes | unchanged vs today (same diff-stream transaction) | ×100 write amplification on a single-node self-hosted Convex |
| citywide bandwidth (all-fleet subscription) | ~300 B × 8/s ≈ **2–3 KB/s** (≈ today's snapshot stream) | ~40 B × 1000/s + sync overhead ≈ **40+ KB/s**, radio never idles |
| client work | s(t) binary search over ≤12 knots + `pointAt(s)` per visible tram per frame; **no physics, no ingest, no learning** | lerp two points — but ALSO still needs jitter smoothing, stall extrapolation, teleport handling ⇒ a worse engine by another name |
| 60 fps smoothness | exact by construction (client evaluates a continuous curve) | hostage to network jitter; 2 Hz samples of accel/brake phases alias |
| 2–10 s network stall | invisible (trajectory already extends 120 s; confidence decays) | dot freezes or client re-grows an extrapolator |
| iOS battery | bursty (~fix-rate) socket traffic, radio can sleep | continuous traffic pins the radio in high-power state |

The deep reason: positions at 500 ms are *derived* from the same trajectory
the server would compute at reseed time; streaming them is transmitting the
evaluation of a function instead of the (much smaller) function. Nothing about
accuracy improves — the information content changes only when a fix arrives.
Battery seals it: measured LTE radio behavior (tail timer ≈ 11.6 s at
~1.06 W) means any sub-tail packet cadence pins the radio in its high-power
state by construction — a 2 Hz stream cannot be tuned out of that; sparse
trajectory bursts can (Apple's energy guidance says batch transfers
explicitly).

**Re-emit policy (the DIS pattern, refined vs "emit per fix"):** emit a
replacement trajectory only when (a) a new fix *diverges* from the published
trajectory beyond an along-shape threshold (tens of meters — tuned via the
replay gate), (b) remaining horizon < ~30 s (heartbeat), or (c) trip/hold
state changes. A fix that *confirms* the prediction costs zero bytes — which
is also the accuracy metric being computed anyway (§7.4: the shadow-scoring
residual and the re-emit trigger are the same number). Convex's own
optimization guidance agrees: "don't write when nothing changed."

**Convex delivery constraints (documented):** subscriptions re-send the FULL
query result on every invalidation — so trajectories must ride the existing
seq-cursor diff pattern (`batchesSince` + re-subscribe-at-cursor), which this
backend already implements; with it, delivered bytes ≈ changed trajectories
only. Writes must stay batched: trajectory generation runs inside the
existing 0.5 Hz `applyPoll` mutation (per-vehicle docs are disjoint — no OCC
contention), adding **zero** new commits; per-transaction ceilings (16 MiB /
16 k docs written) are two orders of magnitude away. A 2 Hz variant would
instead add a permanent self-rescheduling tick loop (~5.2 M mutations/month)
whose every commit invalidates every fleet subscription.

**Client remainder (the honest floor for "everything on the backend"):**
frame-rate rendering can never move server-side — network jitter ≥ frame
budget — so the client keeps: (a) trajectory evaluation, (b) the *existing*
smoother as a micro-chase-controller against the evaluated `sPred` (its
reference today is already exactly that — `smoother.ts` survives nearly
verbatim, minus everything Prague-specific), (c) teleport fades. Everything
deleted from the client: polling, normalization, geometry-fetch orchestration
(already moving), the 932-line predictor, speed-profile construction,
paceBias learning, TOD tables, queue/junction constraint solving. Client
per-frame cost drops below today's (no substep physics, no ingest reseeds, no
constraint sorting) — directly serving the thermal invariants in
`docs/performance.md`.

Render modes survive: raw = last fix (unchanged), live = trajectory at `now`
(reseed jumps + fades = today's honest UX), smooth = micro-smoother output.

### 7.4 Continuous evaluation — the flywheel that gates everything (R1, R5)

New, and prerequisite to every other phase:

- **Archive fixes.** Stop discarding them. ~780 k fixes/day for Prague
  (~450 vehicles / ~50 s cadence) ≈ 10–20 MB/day compressed — trivial.
  Batched per vehicle-hour into packed docs or Convex file-storage blobs;
  retention 90 d raw + aggregates forever.
- **Shadow scoring.** When a fix arrives, score the *previous* trajectory at
  the fix's timestamp: `err = s_predicted(t_fix) − s_fix`. That is the at-fix
  probe from the v2 gate, running continuously, fleet-wide, per
  (route, segment, hourBand, horizon bucket). Plus nightly full replays of
  archived days against candidate constants — `replay-v2.ts` generalized to
  drive the server predictor.
- **Dashboard metric** (the definition of done for R1): p50/p90 |err| at
  15/30/60/120 s horizons, split normal vs disrupted periods, per city.
  Ride recordings stay the gold standard where they exist.
- **The Helsinki trick** (once city #2 exists, §7.5): HSL's 1 Hz feed is
  free ground truth at scale — feed the predictor fixes *downsampled to
  Prague's cadence* (one per 45–95 s), score against the withheld 1 Hz
  positions. Thousands of ride-equivalents per day without a single
  recorded ride; the sparse-cadence engine gets validated far beyond what
  the 3-ride corpus can ever offer.
- **Gate discipline extends, not changes**: any surface/constant/ML candidate
  ships only on a green shadow-replay comparison — the RUNBOOK culture,
  automated.

This harness is also the *entry gate for ML* (§7.6): a candidate model must
beat the structured engine on the same dashboard to earn inference cost.

### 7.5 Multi-city shape (R4)

- **City = row, not fork**: `cities` config table + one adapter per protocol
  family (evidence §5: GTFS-RT VehiclePositions polling, SIRI-VM, MQTT
  streaming, plus per-city JSON like Golemio — and the **schedule-synthesis
  adapter** for position-less (c)-class cities, which reuses the predictor's
  own virtual-fix path). All learned tables already key by city-scoped ids
  (shapeId/stopId/vehicle key); add a `cityId` prefix. Every fix carries
  `position_quality` and per-feed learned `fix_interval_hint` (§5); per-city
  feed health scoring with automatic degrade-to-schedule is part of the
  canonical layer.
- **Deployment**: one Convex deployment per city (or small region) — the
  self-hosted compose already exists; per-city isolation caps blast radius,
  keeps subscriptions/tables small, and scales horizontally without any
  cleverness. Learning cost scales with *fleet size* (fix-driven), serving
  cost with users — both linear, no coupling across cities.
- **Cold start (day 0 → week 1)**: GTFS static → geometry, stops, schedule;
  kinematic universals (accel/brake envelopes, curvature caps); schedule-pace
  prior where no history exists. That is already better than most official
  apps. Segment surfaces converge fast because the server watches every
  vehicle 24/7: a busy segment collects ~100+ traversals/day → usable p50s in
  days, tight surfaces in weeks, automatically.
- **Cadence envelope**: the same filter spans HSL-style 1 s feeds (prediction
  ≈ interpolation, error → GPS noise) and Prague-style 45–95 s feeds (learned
  structure carries the load). Client/protocol identical in both; only
  emit rate and confidence differ.

### 7.6 Where ML plugs in later — deliberately small, harness-gated (§7.4)

Ordered by expected value per unit of ops burden:

1. **Dwell-duration model** (GBDT): features stop×TOD×headway×delay×dayType —
   dwell is the largest single unobservable (§3) and tabular models fit it
   well; trains per-city in minutes on CPU; inference = tree walk inside the
   predictor.
2. **Delay-evolution model** replacing the AR(1) drift if the harness shows
   structure the one-parameter version misses.
3. **Segment-pace residual model** only if, after hierarchical surfaces +
   corridor residuals, the dashboard still shows systematic (predictable)
   residual — the burden of proof is on the model.

Each slot consumes the archived corpus (§7.4), deploys as a versioned
artifact, and must win its A/B on shadow scoring. None sits on the critical
path; deleting any of them reverts to the statistical layer.

## 8. What NOT to build

- **No 500 ms position streaming** (§7.3 table).
- **No monolithic neural position model** (§6.1) — revisit only if a future
  city supplies dense exogenous data (traffic feeds) AND the harness shows
  headroom the structured engine can't reach.
- **No weather-API feature in v1** — measured effects (§4: +1 mm peak rain ≈
  +8 s tram travel time) are smaller than what corridor residuals price in
  within minutes. The two exceptions worth revisiting after phase 0 data:
  a **snow/day-type multiplier** (the one +7–11 % regime) and
  first-service-after-onset segments where no leader has sampled yet.
- **No per-city hand tuning ever** — any constant that would be tuned per
  city must become a learned surface with a sane prior instead.
- **No client-side learning** — the phone stops being a calibration agent;
  motionlog/ride-recording stays as the ground-truth instrument it already is.

## 9. Expected gains (honest, to be validated by the §7.4 harness)

| lever | expected effect (Prague-cadence city) |
|---|---|
| server-side predictor + fresher server polling (done) | already banked in v2/backend (−11.8 % predictor gate) |
| finer dwell structure + live dwell regime | attacks the largest error source (stop-time uncertainty); double-digit % on p50 plausible |
| corridor residuals + headway clip | mostly the **p90/disrupted tail** — the "app is lying" moments; this is where user-perceived quality lives |
| hierarchical pace surfaces (zone/TOD where evidenced) | single-digit % on p50; removes the hand-tuned zone caps |
| trajectory protocol | ~0 accuracy; large thermal/battery/simplicity win; enables everything above to ship city-agnostically |
| ML dwell model (later) | incremental on top of learned dwell tables; measured, not promised |

Floor to respect: at 45–95 s fix cadence a mean error well under ~50 m is
likely information-theoretically out of reach (§3); cities with dense feeds
will sit far below that with the *same* stack. If Prague ever exposes a denser
feed (or a future crowdsourced signal from ride-recording users), the
architecture absorbs it as just another adapter with a tighter cadence
envelope.

## 10. Phased roadmap (each phase independently shippable + gated)

| phase | scope | gate |
|---|---|---|
| **0. Measure** | fix archive + shadow scoring + dashboard (server-only; zero client/product risk); ALSO: investigate the fresher upstream feed tier (§4 — MPVnet updates 10–20 s vs our observed 45–95 s) — **IMPLEMENTED 2026-08-09 as `lab/` (Tram Lab): 24/7 archive + naive/engine-v2/learned bake-off + live map (tram-lab.acex.sh) + Grafana; feed-tier question still open** | dashboard live; baseline error surfaces per route/TOD captured; feed-tier answer documented |
| **1. Server predictor + trajectory stream** | shared-code predictor inside ingest; trajectory docs on the batches pattern; client thin-render mode behind `feedSource`-style flag; existing engine stays as offline fallback | shadow metrics ≥ current client engine on identical data; device perf/battery ≤ today's; replay gate green |
| **2. Fast-adaptation layer** | corridor residuals, live dwell, trip-delay drift, headway clip | disrupted-period p90 improves; normal-period p50 not regressed |
| **3. Learned-surface upgrade** | hierarchical shrinkage; retire hand zone caps + neutral TOD tables into surfaces | p50 improves on shadow replay of ≥ 2 archived weeks |
| **4. Multi-city** | adapter interface + city config + deployment template; pilot city #2 = one dense-feed city (Helsinki — validates the interpolation end AND gives 1 Hz ground truth to validate the predictor against, §5), #3 = one sparse GTFS-RT city (validates transfer). (c)-class schedule-synthesis cities are a later product decision, not phase 4 | new city live with zero engine edits; day-7 error report auto-generated |
| **5. ML slots** | dwell GBDT first (§7.6) | beats phase-3 surfaces on the dashboard A/B |

Phases 0–1 are prerequisites; 2 and 3 are independent after 1; 4 needs 1
(not 2/3); 5 needs 0's corpus plus whatever it competes against.

## 11. Risks & open questions

- **Convex mutation budget for ingest-time prediction** — predictor advance is
  O(stops crossed) per changed vehicle (~16/poll); well inside limits, but the
  headway cascade needs a bound (defer re-clips beyond N pairs to the next
  poll tick). Prototype early in phase 1.
- **Trajectory semantics for the smoother** — the smoother needs `vAllowed`
  context near the evaluated point; carrying `vᵢ` per knot likely suffices,
  else knots gain a coarse cap field. Decide during phase-1 design against
  `smoother.ts` as-is.
- **Multi-hypothesis dwell** (still standing vs departed) — the current
  engine picks one hypothesis with holds/pins. A two-hypothesis predictor
  (probability-weighted release) may beat it at stops; try only after phase 0
  can measure it.
- **Self-hosted capacity at ~50 cities** — 50 pollers ≈ 25 req/s outbound,
  ~25 ingest mutations/s total; per-city deployments make this a provisioning
  question, not an architecture one. Revisit hosting (managed Convex vs more
  nodes) when city #5 exists.
- **Shape self-overlap at loops/terminal balloons** — Prague's upstream docs
  flag it explicitly (§4); generic map-matching for cities without
  `shape_dist_traveled` must be history-aware (monotonic-progress constraint),
  not nearest-point.
- **Feed licensing per city** (§5 evidence) — commercial-use terms vary;
  gate each city's onboarding on its license, not on engineering.

## 12. Sources

Compiled from the three research passes (2026-08-08). Repo-internal evidence
cited inline throughout (§2). Selected load-bearing external sources:

**Production prediction systems**
- TheTransitClock source (Kalman leader+prior, RLS dwell, bias adjusters,
  cold-start ladder): <https://github.com/TheTransitClock/transitime> —
  `core/predictiongenerator/.../kalman/KalmanPredictionGeneratorImpl.java`,
  `.../dwell/DwellRLS.java`, `.../bias/*.java`; project claims + Metro
  Transit 2020 bake-off: <https://thetransitclock.github.io/>; pilot
  description: <https://camsys.com/blog/a-pilot-to-enhance-real-time-bus-predictions-for-metro-transit>
- OneBusAway schedule-deviation interpolation:
  `ScheduledBlockLocationServiceImpl.java` in
  <https://github.com/OneBusAway/onebusaway-application-modules>; developer
  confirmation: <https://groups.google.com/g/onebusaway-developers/c/LrSdEjLbqk0>
- Swiftly accuracy claims (proprietary internals):
  <https://www.goswift.ly/blog/prediction-accuracy-more-than-the-best-transit-etas>
- Transit app Montreal ML + GO crowdsourcing:
  <https://blog.transitapp.com/can-we-make-montreals-buses-more-predictable-no-but-machines-can-e42f28a1a0ba/>,
  <https://blog.transitapp.com/better-predictions/>
- TRAVIC timetable/delay interpolation rendering:
  <https://ad-publications.cs.uni-freiburg.de/SIGSPATIAL_TRAVIC_BBS_2014.pdf>
- **geOps Tralis / SBB trajectory protocol** (production protocol-A):
  <https://backend.developer.geops.io/tralis-docs/asyncapi_html/>,
  <https://geops.com/en/blog/draw-train-on-maps-in-realtime>
- Prague upstream (MPVnet cadence; delay computed by interpolation; loop
  disambiguation):
  <https://janvlasaty.github.io/ropid-vehiclepositions.github.io/docs/realtime-api/zdroj-dat>,
  <https://janvlasaty.github.io/ropid-vehiclepositions.github.io/docs/realtime-api/zpozdeni-spoju>

**Literature**
- Cathey & Dailey 2003 (Tracker→Filter→Predictor):
  <https://www.sciencedirect.com/science/article/abs/pii/S0968090X03000238>
- Particle filters on GTFS networks: Elliott & Lumley 2020
  <https://onlinelibrary.wiley.com/doi/10.1111/anzs.12294>; Hans et al. 2015
  <https://www.sciencedirect.com/science/article/pii/S2352146515000617>
- ArrivalNet (Dresden trams, deep model, 5–10-stop horizons):
  <https://arxiv.org/html/2410.14742v3>; over-stationarization follow-up:
  <https://arxiv.org/pdf/2509.06979>
- Uber DeepETA (residual-on-deterministic-base):
  <https://www.uber.com/us/en/blog/deepeta-how-uber-predicts-arrival-times/>;
  Google GNN ETA: <https://arxiv.org/abs/2108.11482>; BusTr:
  <https://arxiv.org/abs/2007.00882>
- Dwell determinants (boarding/alighting regressions):
  <https://digitalcommons.usf.edu/cgi/viewcontent.cgi?article=1340&context=jpt>
- Weather on tram travel times (Melbourne AVL, +8 s per mm peak rain):
  <https://jtte.chd.edu.cn/article/doi/10.1016/j.jtte.2015.03.001>; urban
  weather effects: <https://www.sciencedirect.com/science/article/pii/S0966692312002694>

**Multi-city feeds** (distribution table §5; per-city URLs)
- Prague/Golemio: repo `docs/research/golemio-api.md`; <https://pid.cz/en/opendata/>
- Helsinki HFP 1 Hz MQTT:
  <https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/>
- Entur (Norway): <https://developer.entur.org/pages-real-time-intro/> ·
  Melbourne: <https://opendata.transport.vic.gov.au/dataset/gtfs-realtime> ·
  Toronto: <https://bustime.ttc.ca/gtfsrt/> · SF Bay:
  <https://511.org/open-data/transit> · Kraków:
  <https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2600> · Warsaw:
  <https://api.um.warszawa.pl/> · NL/OVapi: <http://gtfs.ovapi.nl/nl/> ·
  Brussels: <https://data.belgianmobility.io/en/data.html> · Budapest:
  <https://opendata.bkk.hu/>
- Position-less (c)-class documentation: Switzerland ("vehicle positions are
  not available"): <https://opentransportdata.swiss/en/cookbook/realtime-prediction-cookbook/gtfs-rt/>;
  Berlin VBB (TripUpdates-only + 2026 degradation):
  <https://production.gtfsrt.vbb.de/>, <https://github.com/OpenDataVBB/gtfs-rt-feed>;
  Vienna: <https://www.wienerlinien.at/open-data>
- GTFS-RT spec/best practices: <https://github.com/google/transit/blob/master/gtfs-realtime/spec/en/reference.md>,
  <https://gtfs.org/documentation/realtime/realtime-best-practices/>

**Protocol & platform**
- Valve Source networking (interp 100 ms, extrapolate ≤0.25 s):
  <https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking>
- Gaffer On Games snapshot interpolation / state sync:
  <https://gafferongames.com/post/snapshot_interpolation/>,
  <https://gafferongames.com/post/state_synchronization/>
- DIS dead reckoning (threshold + heartbeat + smoothing):
  <https://github.com/AF-GRILL/DISPluginForUnreal>
- Flightradar24 estimated positions:
  <https://www.flightradar24.com/blog/inside-flightradar24/exploring-estimated-coverage-in-flightradar24/>
- Convex internals (read-set invalidation, single committer, full-result
  re-send, caching): <https://stack.convex.dev/how-convex-works>,
  <https://github.com/get-convex/convex-backend/issues/95>,
  <https://docs.convex.dev/production/state/limits>,
  <https://stack.convex.dev/optimizing-openclaw> ("don't write when nothing
  changed"), self-hosted: <https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md>
- iOS/LTE energy (radio tail 11.576 s @ ~1060 mW; batch transfers):
  <https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/EnergyandNetworking.html>,
  Huang et al. MobiSys 2012 <https://lafibre.info/images/4g/201204_4g_performance_and_power_characteristics.pdf>
