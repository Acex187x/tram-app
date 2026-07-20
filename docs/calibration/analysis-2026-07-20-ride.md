# Calibration analysis — 2026-07-20 — FIRST GROUND-TRUTH RIDE (v4)

The program's first full-length rider recording with the v4 schema (raw+filtered
GPS, 25 Hz IMU, sim state, raw AVL context, rider-on-shape projections). This is
the ground truth the whole pipeline was built to obtain: the rider sits in the
physical tram, so `fLagM = simDist − fDist` is the real rendering error, free of
AVL latency — the thing `%ahead-vs-device` was carried open for since round 12.

**Headline: mean |fLagM| = 136 m, signed mean −85 m (the sim runs BEHIND the
real tram two-thirds of the time). One dominant mechanism (stale at-stop
fix-holds) explains the worst mass; one gated constant shipped
(`STOP_HOLD_MAX_FIX_AGE_S` 60 → 45, ride-replay −25% mean |err|, fleet replay
unchanged). New tool: `ride_replay.py` — the automated ride-calibration
pipeline for every future recording.**

## 1. The ride

- File `20260720-193029-9097.jsonl` (repo root, gitignored; also in ~/Downloads).
- **Line 17, kt8d5 (tram 9097), trip `17_37561_260713`, Mon 2026-07-20
  19:30:29 → 20:10:26 CEST (40.0 min)** — post-cap evening (capless frame),
  h19/h20. Riverside radial: shape span ridden 9 708 → 22 984 m (13.3 km),
  24 platforms passed (seq 20 → 43), avg commercial speed ~20 km/h.
- 2 240 GPS points (1 Hz, one 34 s gap), 59 881 IMU samples, **0 GPS rejects**;
  gpsAcc p50 7.4 m; `fOffM` p50 4.2 / p90 11.8 m — 2 219/2 240 points pass the
  <30 m gate. Filtered vs raw lag differ by 0.2 m on average — the in-app GPS
  filter is essentially transparent on this clean ride (its value is for bad-GPS
  rides). Clean start/end meta; single trip; posMode `smooth` throughout.
- A second export (`20260719-204623-8554.jsonl`, line 31) is a 13 s aborted
  recording (2 points) — unusable.

## 2. Error analysis (ground truth = rider GPS on shape, fOffM < 30 gate)

| metric | value |
|---|---|
| mean \|fLagM\| | **135.7 m** |
| p50 / p90 \|fLagM\| | 98.6 / 305.7 m |
| signed mean / p50 | **−85.3 / −56.5 m** |
| %ahead (sim > real) | 34.7 % |
| \|err\| > 100 m / > 150 m share | 49.9 % / 39.4 % |
| worst excursions | −374 m (behind), +205 m (ahead) |

The user's target band (fleet mean within ~100–150 m) is thus currently *just*
met on average but with half the ride outside 100 m and a heavy behind-tail.

### Decomposition — where the error is born

| stage | signed mean | mean \|·\| | meaning |
|---|---|---|---|
| `gpsDist − obsDist` (raw fix lag) | **+212 m** | 214 m | reality vs the last raw AVL fix |
| `projDist − gpsDist` (projection) | −31 m | 84 m | after schedule-pace forward projection |
| `simDist − gpsDist` (smooth sim) | **−85 m** | 136 m | what smooth mode renders |

- **The feed, not the physics, is the raw enemy**: the real tram is on average
  212 m ahead of its latest fix. Fix lag grows ~5 m/s with fix age (real
  ~18 km/h pace): +77 m at age 0–15 s (≈ 8–14 s of *hidden* pipeline latency
  beyond `obsAt` itself), +229 m at 45–60 s, +449 m at 75–90 s. Fix cadence on
  this ride: age p50 ≈ 40 s (matches the fleet-measured 45 s cadence).
- The engine's schedule-pace projection recovers most of it (−31 m mean) — the
  projection layer works.
- The smooth sim then *gives back* −55 m vs its own projection through holds and
  slow catch-up (below).

### Per-phase and episode structure

- cruise: mean |err| 151 m (signed −98); dwell: 61 m (signed −23) — the error is
  born at stops but *paid for* on the following inter-stop runs.
- **Worst behind-episode (min 16–25, −374 m peak): stale at-stop fix-holds.**
  The AVL kept reporting `at_stop` for 50–75 s per platform (n=50–75 one-second
  samples per stop) while the rider's GPS shows real platform dwells of
  **15–20 s** (26 real stop windows: 6 platform-matched p50 17 s; the AVL
  at-stop state is dominated by cadence+latency, not by boarding). Result: sim
  dwells of **95 s and 47 s** (simDist 14 602 / 14 998) vs real 15 s, devM ≈ 0
  the whole time (sim glued to the stale fix) — then a 300+ m chase.
- **The chase is slow because paceBias gets contaminated**: bias fell 0.72 →
  0.46 across the stop-heavy stretch (traffic-light standstills are not
  deductible — only scheduled dwells are), pinning the catch-up ceiling at
  `1.4 × 11.7 × 0.46 ≈ 7.5 m/s = 27 km/h` while the real tram free-ran at
  37–46 km/h. The sim needed ~8 min to close a 350 m gap.
- **Worst ahead-episode (+205 m, min 7): a 55 s standstill** (signal or held
  departure ~50 m past a platform) invisible to the sim until the stuck-hold
  confirmed it two fixes (~90 s) later.

### Physics validation against reality (IMU + GPS)

- Real accel (2 s window): p50 0.50 / p90 1.30 / p99 2.18 m/s²; real decel p50
  0.46 / p90 1.18 / p99 1.80 m/s². **A_ACC 1.3 / A_BRK 1.4 sit exactly at the
  real p90 — correct as envelope values, no change.**
- Curve caps (curvature reconstructed from the ride track): real-speed/cap p90 ≈
  1.00–1.06 across curve-capped zones (13 % of moving samples exceed the cap;
  tight curves cap 2–4 m/s read ratio ~1.18 at n=8). **CURVE_SLOW_FACTOR 0.85 ≈
  correct as a p90 envelope; raising it helped one ride-half only and nothing
  after the hold fix → no change (would be single-ride overfit).**
- Moving speed: real p50 24.6 / p90 46.3 km/h vs sim p50 26.5 / p90 39.7 — the
  sim's *median* pace is right (TOD h19/h20 = 1.0 confirmed from the ground
  truth side); it lacks the real tram's *sprint* headroom, which is a catch-up
  ceiling story (bias × 1.4), not a cruise-pace story.
- Real platform dwells p50 ~17 s ⇒ DEFAULT_DWELL_S 18 confirmed; TOD_DWELL
  h19/h20 = 1.0 confirmed.

## 3. What actually governs Prague tram speed (research + ride evidence)

Ride-observed stop budget (40 min): **26 standstills ≥8 s totalling 531 s
(22 % of ride time) — only ~6 clearly at platforms; ~20 are signals/junctions/
held departures** even though ~89 % of Prague signals have tram preference
(219/247 by end-2020, Prague Transportation Yearbook). Literature (tram ops
studies) ranks commercial-speed determinants: (1) dwell count+duration,
(2) intersection/signal delay where preference is absent or conditional,
(3) shared vs dedicated right-of-way congestion (dedicated ROW ⇒ punctuality;
line 17 is mostly dedicated riverside — and still lost 22 % of time standing),
(4) curve/switch speed restrictions, (5) vehicle accel/brake capability (minor
between Tatra/Škoda families at street speeds). Time-of-day acts through all of
(1)–(3) — consistent with the sim-side program's finding that TOD is
fleet-neutral in the evening and zonal (centre dwell x1.2–1.3) rather than a
global pace factor.

Implications for the model: unobservable signal stops are irreducible from AVL
alone (the stuck-hold already handles the observable tail); what IS reducible
is (a) trusting stale at-stop states too long, (b) letting signal standstills
poison the learned cruise pace, (c) catch-up ceilings below real free-running
speed. (a) is shipped this round; (b)/(c) are the top structural follow-ups.

## 4. Applied (engine) — gated

**`STOP_HOLD_MAX_FIX_AGE_S` 60 → 45 s** (tramSim.ts; also bounds
`fixPinActive`'s projection freeze — same staleness semantics). Mechanistic
anchor: one fix-cadence p50 (fleet-measured 45 s; this ride 40 s) instead of
~p90. Gate record:

- **Ride replay** (`ride_replay.py`, surrogate replaying the ride's own fix
  sequence, scored vs rider GPS): mean |err| **180 → 135 m (−25 %)**, p90
  348 → 266, signed −155 → −89; **both contiguous ride halves agree**
  (175.9/183.6 → 134.9/135.6) — the Codex-recommended freeze-and-score split.
- **Fleet replay** (`replay.py`, session-2026-07-11, S70 shipped config; its
  60 s stuck-hold mirror synced to 45 s): **bit-identical metrics** (p50 124.8,
  frs 139.0/382.7) — the bound rarely binds at fleet cadence; no regression.
- jest green, `npx tsc --noEmit` clean (tests reference the constant
  symbolically).

Deliberately NOT shipped despite replay wins (anti-overfit): hold 35–40 s
(−33…−42 % on this ride but below one cadence — needs ≥2 independent rides),
CATCHUP_MAX_FACTOR 1.5+ (≤5 %, inconsistent), CURVE_SLOW_FACTOR 1.0 (one half
only), V_CRUISE_REF 12.5 (would shift the whole 0.62-bias frame the fleet
program is normed against), TOD h19/h20 ≠ 1.0 (contradicts the fleet double
gate on far more data; the ride's median-pace parity confirms neutral).

## 5. Methodology — ride-driven calibration loop (designed this round)

**Tool: `docs/calibration/ride_replay.py <ride.jsonl> [ride2 …] [--sweep]`** —
parses v3/v4 rides, reconstructs the shape + curvature from the rider's own
track, extracts the stop table from at-stop fix clusters, replays the full
smooth-sim controller 1D (regimes, envelope, adaptive dwell, fix-holds,
stuck-hold, paceBias EWMA) over the ride's AVL fixes, and scores against the
rider's `fDist`. Multiple rides aggregate. Self-check: the `fid_mean` column
(replay vs the *logged* simDist) validates the surrogate (~105–120 m here —
the port lacks the timetable anchor; cross-config deltas are what to trust,
plus the on-device logged error for absolute truth).

**Loop for every new ride** (orchestrator-runnable):

1. Export the ride → `python3 docs/calibration/ride_replay.py <ride(s)>
   --sweep`. Diagnose on the report + the per-minute lag profile.
2. Candidate constants must have a mechanistic story (latency, cadence,
   measured accel/dwell) — never free-fit values.
3. **Double gate**: (a) mean |err| drops on ride-replay **across all
   accumulated rides** (and on the contiguous-half split of any single ride);
   (b) `replay.py` on the newest fleet session does not regress. jest + tsc.
4. **Regularization / shrinkage** (per Codex consult, 2026-07-20): treat a
   ride's effective sample size as its independent episodes (~51 fixes,
   ~26 stop events here — NOT 2 240 rows). One ride may move a fleet constant
   at most half-way toward its replay-optimal value (this round: 60→45, not
   →40); full moves need ≥2 independent rides agreeing in direction. Fleet
   AVL-only data keeps authority over pace/dwell distributions (it cannot see
   sim-vs-reality lag; rides cannot match its sample size — they own the
   latency/hold/controller parameters).
5. Per-dimension extensions as data accumulates (pre-registered): per-ROUTE
   pace residual (line 17 dedicated-ROW vs street-running lines — needs rides
   on ≥3 route classes), per-MODEL accel/decel (IMU per family), per-JUNCTION
   switch-slow calibration (gpsSpeed over contested junctions), continuous
   per-vehicle bias (already live in-engine). Each lands as a small
   L2-shrunk factor toward the fleet value, never a hardcoded exception.

**Structural follow-ups surfaced by this ride** (need tramSim/engine changes,
own the next rounds; all replay-testable in ride_replay.py first):

- **R12 (top): latency-aware projection** — project fixes forward by
  `age × robust v_est` (moving-fix EWMA, uncertainty growing with age) instead
  of pure schedule pace; the +77 m at fix age 0–15 s says even `obsAt` hides
  ~10 s of pipeline latency. Expected to attack most of the remaining −85 m
  signed bias.
- **R13: bias decontamination** — update paceBias only over confidently-moving
  spans (exclude spans containing standstill evidence: flat-fix stretches,
  at_stop transitions), so signal stops stop halving the catch-up ceiling.
  (Codex: "don't let paceBias learn feed latency or dwell artifacts".)
- **R14: catch-up ceiling from free-running pace** — a catch-up tram may target
  the route's observed p90 free-running speed rather than `1.4 × bias ×` ref
  (bounded by the envelope), so a 300 m gap closes in ~2 min, not 8.
- **R15: adaptive hold age** — hold ≈ observed per-tram fix cadence + margin
  instead of a fleet constant (cadence varies 20–90 s within one ride).

## 6. Open items

- Confirm hold-45 on the next independent ride (pre-registered confirmation
  set; if it reproduces, evaluate 35–40 with the same split discipline).
- More rides wanted, prioritized: a centre-crossing line (zonal dwell ground
  truth), a street-running line (per-route residual), an AM peak ride (TOD
  peak ground truth), any non-kt8d5 model (per-model).
- `%ahead-vs-device` (carried since round 12): **CLOSED** — 34.7 % ahead /
  mean −85 m, the smooth sim is behind-biased vs the real tram; the sign was
  the open question.
- IMU (59 881 samples) barely scratched: per-stop jerk signatures could
  separate platform dwells from signal stops automatically — future tooling.
