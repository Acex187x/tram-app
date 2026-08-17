# Curve generation v3 — perceptual motion synthesis (design)

Status: DESIGN (2026-08-16), ready for implementation. Companion to the FROZEN
wire contract `docs/research/physics-v3-protocol.md` — v3 changes **how the
curves are constructed**, not the wire (§9 lists the one protocol-text edit it
needs, a server policy constant, not a shape change).

Owner verdict on the current generator (build 13 + kinematic caps, field,
2026-08-16): *«точнее, но продуктово выглядит в разы хуже прошлой симуляции
физики»* — strong jerks, no braking into sharp curves, sluggish catch-up to
fresh fixes. The bar for v3, owner's words: *«трамвай едет как трамвай, фиксы
уважаются, ничего не дёргается»*.

The one-sentence design: **stop fitting curves to the ML's noisy per-horizon
positions and instead drive a server-side virtual tram down the real geometry —
the old engine's driver (curvature speed limits, braking envelope, learned
pace, observation holds, smoother regimes), with the ML demoted from position
oracle to timetable: it times the legs, physics draws the motion.**

---

## 1. Why the current generator loses, mechanically

`lab/src/trajectory.ts` (`fitProfile`) is a per-step tracker of the raw ML
target curve: `v* = targetSlope + (target − s)/timeLeft`, accel-clamped. Three
structural defects, each mapped to an owner complaint:

1. **Unbounded jerk («дёргается»).** The target is 13 *independent* GBDT
   regressions (one per 10 s horizon, `lab/src/ml.ts`); its finite-difference
   slope is regression noise of ±1–2 m/s between adjacent knots. The tracker
   chases that noise with acceleration slamming rail-to-rail (−1.4 ↔ +1.3) —
   each flip is legal per the accel caps and looks like a driver stomping
   pedals. The lab already measured that caps alone don't fix the look
   (README §Findings 2026-08-16 W2: accel p01 −1.35 / p99 +1.24 — the profile
   *rides its own caps*). Kinematic caps bound amplitude; nothing bounds
   **da/dt**.
2. **Zero curvature awareness («не тормозит в поворот»).** The generator sees
   only `(t, s)` targets. The ML curve encodes curve slow-downs only as a
   statistical average smeared across horizons; the fitted profile happily
   takes a 25 m junction curve at 12 m/s. The old engine solved exactly this
   with `speedProfile.ts` (per-vertex `vLimit` from curvature + braking
   envelope with 400 m lookahead) — deleted from the client by physics-v3 and
   ported to nothing. The server has full `RouteGeometry`
   (`lab/src/geometry.ts`, coordinates + cumDistM + stops), so the port is
   mechanical (confirmed by the prior feasibility check).
3. **Sluggish catch-up («вяло догоняет»).** Convergence demand is
   `gap / (30 s window)` — a 60 m fix correction is dribbled off at ~2 m/s
   surplus over half a minute, precisely *continuity over decisiveness*. The
   old smoother had a **regime table** (track / catch-up / yield with
   hysteresis and a measured sprint ceiling, `smoother.ts`) that made fixes
   feel *respected*; the current generator has one gain for everything.

Also structurally wrong: downstream stops exist in the emitted curve only as
whatever speed-dip the ML expectation happens to produce (expectation smears
dwells into slow rolling — the platform version of the 2026-08-13
«floating off the platform» finding, which the modal rule fixed *only at the
anchor stop*).

## 2. Architecture: the virtual tram

One new module, `lab/src/drive.ts` (replaces `fitProfile`/`findHolds` inside
`lab/src/trajectory.ts`; the wire assembly, seams, and `evalTrack` stay).
Per emission, per vehicle:

```
              RouteGeometry ──► SpeedProfile (ported speedProfile.ts):
                                per-vertex vLimit = curveCap(κ), envelope vAllowedAt(s,v)
                                          │ constraint stack (never violated)
 anchor fix ──► anchor state              ▼
 (at_stop? standingS?)   ┌──► DRIVE: forward sim, 1 s grid, state (s, v, a)
 prev emission ──► C¹⁺ seam│      a commanded by guidance, limited by
 (s, v, a at E)           │      jerk J_MAX and accel A_ACC/A_BRK,
                          │      v capped by vAllowed envelope
 ML Δs curve ──► guidance ┘      holds served: modal anchor hold,
 (leg times, trim)               downstream stops with learned dwell
 learned surfaces ──► pace prior, dwell, release Normal
                                          │
                                          ▼
                    breakpoint compression ≤ 24 knots (constraint-aware)
                    → opinion track;  smooth track = same drive re-run from
                      the previous smooth seam with catch-up/yield regimes
```

Descent map (every component names its ancestor — nothing here is invented
from scratch; the mechanisms users loved are re-hosted at generation time):

| v3 component | descends from | change |
|---|---|---|
| per-vertex `vLimit`, `curveCap`, `vAllowedAt`, `cruiseCapAt`, `brakeTowards`, `TRAIL_LIMIT_M` | `lab/vendor/engine/speedProfile.ts` (verbatim port) | zone caps dropped (§4.1); envelope gains a jerk-onset margin (§5) |
| cruise pace reference | `tramSim.ts` `cruiseProduct` = `min(cruiseCap, V_CRUISE_REF)·paceBias·tod` | replaced by the learned surface `LearnedModel.paceAt` (which already IS per-segment×band×dayType pace — the thing paceBias×TOD approximated) |
| anchor hold + release | modal stop rule (`modalReleaseMs`, protocol §Modal stop rule) ⇐ `tramSim.ts` arrival-fix pin + `fixPinsDwell` | kept verbatim |
| downstream stop dwells | `tramSim.ts` `tick()` stop-serve + `dwellDurationMs` | dwell from `LearnedModel.dwellAt`, clamped |
| braking into all constraints | `vAllowedAt` envelope over stops AND curve vertices, 400 m lookahead | now applied to the emitted curve itself |
| catch-up/yield regimes (smooth) | `smoother.ts` regime table r2 (track / catch-up / yield / hold-follow, hysteresis, `CATCHUP_HEADROOM` ceiling) | applied at generation time against the opinion curve as reference (§6) |
| discontinuity threshold | `tramSim.ts` `teleportThresholdM` (gap-aware, 2026-07-27 feed-degradation fix) | replaces the flat 150 m (§7) |
| jerk limit | new (was a stated hypothesis: `docs/project-review-2026-07-13.md` §P3 "Jerk-limited acceleration / S-curve profile") | comfort cap from rail literature (§5) |
| ML leg timing + trim | `ml-gbdt` targets (demoted) + `smoother.ts` proportional track trim (`1 + err/PACE_GAIN`) | §4.3 |

## 3. What the ML contributes — decided precisely

The ML remains the *accuracy* engine (54.8 m holdout vs learned ≈106 m), but
its output is consumed as **timing, not as a position reference**:

1. **Nowcast anchor**: `opinion(t_E) = M(t_E)` — the ML's position for the
   emission instant (this is where its latency compensation lives; trained on
   obsAt→obsAt pairs it has learned the pipeline lag). Unchanged from today.
2. **Leg arrival times** (the main channel): for each upcoming stop `S_i`
   within the horizon, `τ_i = inf{ t : M(t) ≥ S_i.distM }` — the time the ML
   curve crosses the stop. Crossing times of a monotone curve integrate over
   many knots, so they are *stable* where finite-difference slopes are noise.
   These become per-leg target paces (§4.3).
3. **Tail pace**: mean slope of the last 30 s of `M`, for the stretch past
   the last crossed stop.
4. **In-leg positional trim** (the "weak short-horizon anchor"): a
   multiplicative speed trim `clamp(1 + (M(t) − s)/G_ML, 1−TRIM_AUTH,
   1+TRIM_AUTH)` — the smoother's proportional track regime pointed at the ML
   curve, authority hard-capped at ±15 %.

What the ML may NOT do any more: dictate per-10 s positions (dies), imply
speeds by finite difference (dies), defeat `vAllowed`, the jerk/accel limits,
or a hold. Release timing at the anchor stop stays **modal** (learned Normal,
P ≥ 0.6), not ML — the ML's release is expectation-smeared, which is exactly
the float-off-the-platform defect.

**Expected metric cost, against the measured ladder** (matched window
2026-08-16: ml-gbdt 59.8 m mean / ml-mode 90.2 / ml-smooth ≈90.2 / learned
106–109 / engine-live 126.8; at_stop split: ml-gbdt 54.0 vs ml-mode 105.9;
moving split: ml-mode ≡ ml-gbdt at 67.7 vs 67.8):

- *Moving anchors* (42 % of events): v3 adds curve braking, jerk shaping and
  downstream-stop dwells on top of a leg-time-matched pace. Divergence from
  the ML is bounded by the trim equilibrium (`G_ML·TRIM ≈ 18 m` of standing
  gap at typical pace) plus constraint episodes. Expect **+3…+8 m vs
  ml-gbdt** (today: +0).
- *At-stop anchors* (58 %): today's 105.9 m decomposes into the deliberate
  modal-hold cost (~30 m, priced and accepted 2026-08-16 W1) **plus an
  imported bias**: the post-release branch walks at *learned* pace whose
  lateness is −53.7 m signed in the same window (README: «the bias is
  imported, not intrinsic… drive the post-release branch from the ML curve's
  own increments and re-price»). v3's leg ladder IS that follow-up: release
  stays modal, but the exit is timed by the ML's τ. Expect recovery of
  **10–20 m** of the at-stop mean → ≈85–95 m.
- *Blended forecast*: `0.58·(85…95) + 0.42·(71…76) ≈ **79–87 m mean**`, i.e.
  clearly ≤ learned (ship bar) and at par or slightly better than today's
  ml-mode 90 m. Of the 106→54 gap, v3 keeps roughly half; the unrecovered
  remainder is (a) the modal floor (~15–25 m — a deliberate product choice)
  and (b) ~5 m of physics shaping. Recovering the rest means rendering the
  expectation again — the exact thing the owner rejected on 2026-08-13.

## 4. Control law (opinion track)

### 4.1 Constraint stack — the ported `speedProfile`

Per shapeId (cached beside the geometry, rebuilt only on geometry refresh):

```
κ[i]      = curvatureProfile(coordinates, cumDistM)          // src/lib/geo/polyline, already imported live by the lab
vLimit[i] = curveCap(κ[i]) = clamp(CURVE_SLOW_FACTOR·√(A_LAT/κ), V_CURVE_MIN, V_LIMIT_MAX)
```

**Zone caps are dropped** (the one deviation from the vendored file): the
daytime-centre 31 km/h bbox was a hand proxy for what `paceAt`'s
segment×band×dayType surface now *measures* (centre ≈19 km/h flat — engine-v2
§1c); keeping both would double-count and the prediction-architecture roadmap
(§10 phase 3) retires hand zone caps explicitly. Curve caps stay physical and
city-portable (`A_LAT 0.98`, `CURVE_SLOW_FACTOR 0.85` = measured p90 envelope,
analysis-2026-07-20 §2).

Runtime envelope, evaluated per sim step with the monotone-pointer
optimization (`stopStartIdx`-style, as `tramSim.tick` does):

```
vAllowed(s, v) = min(
  cruiseCapAt(s),                                            // point-constraint semantics kept
  min over curve vertices d ∈ [s − TRAIL_LIMIT_M, s+LOOKAHEAD]:
        d ≤ s ? vLimit(d) : √(vLimit(d)² + 2·A_BRK·slack(d)),
  min over upcoming HOLD points h (stops to serve, geometry end):
        √(2·A_BRK·slack(h)) ,
  V_LIMIT_MAX )
where slack(d) = max(0, d − s − v·T_BRK_BUILD/2)             // jerk-onset margin, §5
```

This is `vAllowedAt` verbatim plus the jerk margin. It is what makes the tram
**brake into sharp curves and platforms early and smoothly** — the headline
perceptual fix.

### 4.2 Stop plan

From the anchor forward, the drive owns an explicit stop plan (descends from
`tramSim.nextStopIdx` + dwell machinery):

- **Anchor hold** (fix at_stop): hold at `stopS` until `modalReleaseMs`
  (unchanged modal rule, P threshold 0.6, standingS credit). May be in the
  past ⇒ departed already.
- **Downstream stops**: every stop ahead within the drive's reach is
  **served**: brake in on the envelope, stand `D_i = clamp(dwellAt(stop_i),
  DWELL_MIN 5, DWELL_CAP 40) s` (the learned per-stop×band dwell; the cap
  mirrors `learned.walk`'s defense against the AVL sticky-hold artifact),
  depart under `A_ACC`+jerk. This renders the *modal* stop behavior at every
  platform, not just the anchor — a tram that visibly serves platforms — and
  removes the expectation-smear rolling. The ML keeps authority over *when*
  the tram reaches each platform (§4.3), so the metric cost is second-order.
- **Terminal**: geometry end is a permanent hold (envelope → 0, then stand) —
  `tramSim` terminal latch semantics.

### 4.3 Guidance — leg-pace ladder + bounded trim

Between consecutive plan events (release → stop i → stop i+1 → … → horizon):

```
depart_k   = planned departure time of leg k's start event (from the sim itself)
τ_k        = ML crossing time of leg k's end stop (§3.2); monotone-clamped
p_k(raw)   = legLen_k / max(T_kin_k, τ_k − depart_k − 0.5·D_k)     // 0.5·D: the ML
             // expectation crosses a platform mid-dwell on average, so half the
             // budgeted dwell belongs to the crossing itself
p_k        = clamp(p_k(raw), PACE_CLAMP_LO·paceAt(leg), PACE_CLAMP_HI·paceAt(leg))
             // trust region around the learned surface: ML times within ±50 %,
             // beyond that the surface (and its own trust ladder) wins
T_kin_k    = kinematic floor: leg time at full A_ACC/A_BRK/jerk between the
             leg's boundary speeds — an impossible τ extends, never speeds
tail pace  = clamp(mean slope of last 30 s of M, same clamps)
```

Per sim step the commanded speed is:

```
vCmd = p_k                                        // leg target pace
vCmd *= clamp(1 + (M(t) − s)/G_ML, 1−TRIM_AUTH, 1+TRIM_AUTH)   // ML positional trim
vCmd  = min(vCmd, vAllowed(s, v))                 // constraints always win
a     = clamp((vCmd − v)/dt, −A_BRK, +A_ACC)
a     = clamp(a, aPrev − J_MAX·dt, aPrev + J_MAX·dt)           // jerk limit
v'    = max(0, v + a·dt);  s' = s + (v+v')/2·dt   // exact for linear v
```

The trim is the smoother's track regime (`1 + err/PACE_GAIN`, clamp
0.7…1.35) with tighter authority and the ML curve as its reference — it mops
in-leg timing residue at ≤ ±15 % speed, which is invisible as motion but keeps
`|drive − M|` bounded (equilibrium standing gap ≈ `G_ML·TRIM_AUTH` = 18 m).

**v0/a0 at the seam**: opinion inherits `speedAt(prev.opinion, t_E)` and the
previous profile's acceleration at `t_E` (both memory-only, `KinTrack` gains
the seam accel) — the C¹ seam becomes effectively C¹⁺: not only does speed not
jump, acceleration transitions under `J_MAX`. A vehicle holding under the
modal rule starts at v=0, a=0 (unchanged).

## 5. The jerk model — number and sources

`J_MAX = 0.8 m/s³` (comfort target), wire gate `J_GATE = 0.9 m/s³`.

Grounding: EN 13452-1 (mass-transit brake systems — trams/LRT/metro in scope)
sets the service-braking **jolt limit at 1.5 m/s³** — the not-to-exceed
([SIS: SS-EN 13452-1](https://www.sis.se/en/produkter/railway-engineering/metro-tram-and-light-rail-equipment/ssen134521/),
[BSI EN 13452-1:2003](https://www.en-standard.eu/bs-en-13452-1-2003-railway-applications-braking-mass-transit-brake-systems-performance-requirements/)).
Comfort *design* values sit well below the standard's ceiling: rail comfort
surveys report thresholds 0.5–2 m/s³ with **"less than 1 m/s³ more typical"**
([PWI passenger-comfort design analysis](https://www.thepwi.org/wp-content/uploads/2021/02/Presentation_200304_Passenger-comfort-design-analysis.pdf));
the Beijing Subway ATO comfort model scores **full comfort below 0.5 m/s³**
and zero above 3 ([MDPI, Sustainability 12(11):4541](https://www.mdpi.com/2071-1050/12/11/4541));
jerk-limited speed-planning literature uses 0.5–1.0 m/s³ as the comfort
constraint ([Artuñedo et al., jerk-limited time-optimal planning](https://autopia.car.upm-csic.es/wp-content/papercite-data/pdf/artunedo2022_jerklimitedtime.pdf));
the passenger-stability literature confirms rate-of-change matters as much as
magnitude ([Powell & Palacín, Urban Rail Transit 2015](https://link.springer.com/article/10.1007/s40864-015-0012-y)).
0.8 m/s³ is therefore: inside the comfort band, half the EN 13452-1 jolt
limit, and reachable — a full −1.4→+1.3 accel reversal takes 3.4 s, which at
1 s sim steps and ≥1 s wire segments is representable. (The 2026-07-13
project review §P3 already proposed exactly this S-curve profile and asked for
IMU-derived parameters; the 07-20 IMU corpus was never reduced to jerk — do
that reduction opportunistically, it can only *lower* the cap.)

Two derived consequences:

- **Accel/brake build time** `T_ACC_BUILD = A_ACC/J_MAX ≈ 1.6 s`,
  `T_BRK_BUILD = A_BRK/J_MAX = 1.75 s`.
- **Envelope margin**: a jerk-limited stop from speed v needs
  ≈ `v²/(2·A_BRK) + v·T_BRK_BUILD/2` — hence `slack(d)` in §4.1 bites
  `v·T_BRK_BUILD/2` (~10 m at cruise) out of the distance, which is also
  exactly "the driver starts braking a touch early".

**Wire observability** (same argument as the accel gates, protocol §Kinematic
limits): the client-observable acceleration of segment pair *i* is a time
average of the fine profile's acceleration over adjacent windows; averages of
a `J`-Lipschitz function over adjacent windows differ by at most `J ×` the
distance between window centres. So wire-observable jerk (Δ of consecutive
central-difference accels ÷ the time between their centres) is **≤ J_MAX by
construction**; `J_GATE = 0.9` absorbs cm/ms rounding (≤ ~0.04 m/s³ at ≥1 s
segments), mirroring the +0.05 accel slack.

## 6. Fix respect — the smooth track's regimes

`opinion` re-anchors on every fix (kept, unchanged — «более точное положение»
stays honest). `smooth` is the SAME drive re-run with: start state = previous
smooth seam (s, v, a at `t_E`), reference = the freshly built opinion curve
`O(t)` (already physical), stop plan = opinion's stop plan. Guidance is the
smoother.ts regime table transplanted to generation time, with the gap
`g(t) = O(t) − s(t)`:

| regime | condition | commanded speed | descends from |
|---|---|---|---|
| **track** | \|g\| ≤ 40 m | `vO(t) · clamp(1 + g/PACE_GAIN, 0.7, 1.35)` where `vO` = opinion's own speed at t | smoother track regime, verbatim constants |
| **catch-up** | g > 40 m | `vO + min(DV_CATCH_MAX, g/T_CLOSE)`, capped by `CEIL = min(vAllowed, max(CATCH_HEADROOM·paceCorr, vO + CATCH_DV_MIN))` where `paceCorr = max(paceAt(s,t), paceAt(o,t))` — the surface over BOTH ends of the gap corridor | smoother catch-up; `CATCH_HEADROOM 1.9` = measured p90/p50 free-running ratio (the ceiling is anchored on observed sprint pace, never the legal cap — the night-centre lesson). **Tuning deviation 2026-08-17**, see note below |
| **yield** | g < −40 m enter / −12 m exit (hysteresis) while opinion is MOVING | `max(YIELD_FACTOR·vO, min(YIELD_MIN 3.0, vO))` — slow tram, never pedestrian **and never faster than the reality it yields to**, never reverse | smoother yield + the v1 «пешеходная скорость» field fix; **tuning deviation 2026-08-17** |
| **hold-follow** | opinion standing (anchor hold / downstream dwell / terminal) | behind: brake onto the hold point at ≤ `min(vAllowed, max(CATCH_HEADROOM·paceCorr, HOLD_APPROACH_MIN))` (envelope captures the platform); at/ahead: stand (reality itself is standing) | smoother hold-follow (the r2 blocker fix); **tuning deviation 2026-08-17** |

**Tuning deviation (2026-08-17) — the ceiling and yield formulas.** The original
single-bucket ceiling `CATCH_HEADROOM·paceAt(s,t)` was measured live (12 h
shadow + per-step limiter drill-down) binding **62 % of all catch-up steps**
(mean 3.3 m/s of demanded closing speed clipped), and in 5 % of bound steps it
sat **below the reference's own speed** — the smooth was commanded slower than
the thing it chases, i.e. divergence, not honesty. Root cause: `paceAt` at the
smooth's own position is the stop-zone bucket at exactly the moments catch-up
starts (fix re-anchors cluster at departures), and stop-zone cells are
dwell-contaminated (moving→moving spans that cross a stop fold dwell time into
pace; the R13 guard only drops at_stop endpoints). G5 read p50 22.5 s / p90
45.5 s against the 12/28 design gates, and tuning the demand constants to
their band edges (T_CLOSE 10→8, DV 6→7) had already moved nothing — the
demand was never the binder. The reform keeps the observed-pace anchor but (a)
takes the pace surface over BOTH ends of the corridor being closed, (b) floors
the catch-up ceiling at `vO + CATCH_DV_MIN 2.5` — the reference's speed is
itself an observed-pace quantity (ML-timed, learned-clamped, envelope-legal),
so a modest surplus above it never sprints past what reality supports — and
(c) floors the hold-follow approach at `HOLD_APPROACH_MIN = DEFAULT_PACE`
(the brake parabola owns the last metres regardless; 42 % of approach steps
had been ceiling-bound below the brake envelope). The yield floor 3.0 is kept
only while the reference itself does ≥ 3.0 (21 % of yield steps had been
commanded ABOVE `vO`, growing the lead they were meant to repay).

All regimes then pass the same constraint stack (envelope, accel, jerk,
v ≥ 0, monotone s). Notes:

- **Decisive catch-up, justified.** `T_CLOSE = 10 s`, `DV_CATCH_MAX = 6 m/s`.
  Closing a gap g to <15 m takes ≈ `t_ramp + (g−15)/Δv` with
  `t_ramp ≈ Δv/A_ACC + T_ACC_BUILD ≈ 6.2 s` at the surplus cap: **40 m gap →
  ~10 s, 80 m → ~17 s, 120 m → ~24 s** (vs ~30 s+ today for everything). An
  80 m gap in ≤12 s flat would need ~7 m/s of surplus — legal only at
  above-typical paces, so the *gate* is set where physics lives (G5, §8).
  When the envelope forbids the surplus (curve, platform ahead), the window
  extends — protocol §Extended-convergence, limits never bend. On slow
  corridors the `CATCH_HEADROOM` ceiling binds before `DV_CATCH_MAX` does —
  by design (never sprint the night centre).
- **Yield-when-ahead**: never reverse (kept). New vs today: while the opinion
  is *moving*, the smooth track no longer brakes to a dead stand mid-street
  (today's behavior — reads as a phantom breakdown); it yields at
  `max(3.0, 0.5·vO)` and lets the remainder be absorbed at the next platform
  hold, which it reaches early and simply dwells longer — the v1 §13 lesson
  («ahead-error is repaid where it is natural — at stops») executed by
  construction, since the smooth drive serves the same stop plan and its hold
  ends only when the opinion's hold ends. If the opinion itself is standing,
  hold-follow brakes to a stand — that stand is honest.
- **TRAIL_M dies.** The 10 m ride-behind bias was a client-side hedge against
  raw-fix asymmetry; the reference here is the latency-compensated ML nowcast
  and the comparison UI draws smooth−fixed distance — a built-in 10 m of
  permanent error buys nothing now. (engine-v2 already put TRAIL on notice:
  "whether 10 → 0 is arbitrated by the replay gate, not inherited".)

## 7. The 150 m discontinuity threshold — revised policy

Measured: on fix-driven re-emissions the model's own re-anchor jump is
p50 75.8 m and crosses 150 m in **16.4 %** of cases (README 2026-08-16 W2) —
users see a teleport-fade every ~6th fix-driven re-emission per vehicle, and
replaying the old converge-exactly behaviour gives 17.2 %: **the threshold is
tripped by re-anchor noise, not by smooth-track drift.** A teleport must mean
*desync*, not *model noise* — the exact lesson of the 2026-07-27 feed
degradation, already solved once in `tramSim.teleportThresholdM`.

Policy: replace the flat `TRAJ_DISCONTINUITY_M = 150` with the gap-aware
desync test, re-anchored on the learned surface instead of V_CRUISE_REF:

```
T_disc = clamp( clamp(fixGapS, 45, 240) · max(paceAt(s,t), DEFAULT_PACE 5.5) · 1.25,
                DISC_FLOOR 350, DISC_CAP 1200 )   // meters
discontinuity ⇐ tripId changed  OR  |smooth(t_E) − opinion(t_E)| > T_disc
```

Everything under `T_disc` is **driven off** by the §6 regimes (150–350 m gaps
close in ~25–60 s at the catch-up ceiling; the marker is en-route and
decisive rather than teleporting). Expected fix-driven discontinuity rate:
16.4 % → **< 5 %** (gate G8; the residual is genuine trip changes + true
desync). The wire is untouched — `discontinuity: true` keeps its exact client
semantics; only the server's trigger policy changes. This DOES require a
one-line edit of the frozen protocol text (which names ">150 m"), in its own
commit first, per that file's own change rule.

Metric exposure is bounded: the at-fix probe charges the smooth track for at
most one convergence window per event, and the same probe showed continuity
costing 0.0 m mean when convergence was *lazier* than this (W1 finding), so
decisive-drive-instead-of-teleport is strictly cheaper than it was.

## 8. Perceptual gate — «красиво», measured

All metrics are computed in TWO places by design: **(a) generator counters**
(`lab/src/realism.ts` extended — sees full context: vAllowed, holds, regime
tags; feeds `/api/summary → perceptual` + Grafana), and **(b) the independent
checkers** against served bytes (`lab/scripts/check-v2.mjs` — no imports, wire
math only) and offline invariants (`lab/scripts/selftest-v2.ts` — tsx, can
import the speed profile for curve checks). The builder guaranteeing a
property is not a measurement — existing lab doctrine.

| # | metric | definition (wire-observable unless noted) | PASS | computed |
|---|---|---|---|---|
| G1 | kinematic limits | per-segment speed; central-diff accel | v ≤ 17.0; a ∈ [−1.45, +1.35]; **0 violations** | existing: realism.ts + check-v2 |
| G2 | **jerk p99 / max** | Δ of consecutive observable accels ÷ time between their centres | p99 ≤ 0.9 m/s³; **0 samples > 1.0** | realism.ts (new jerk histogram) + check-v2 |
| G3 | **accel sign-flip rate** | flips between accel phases > +0.2 and < −0.2 m/s² (deadband; intervening \|a\|≤0.2 phases don't reset), per minute of track time | fleet mean ≤ 2.0/min; per-track p95 ≤ 3.0/min. Basis: ≈2 flips per served stop × ~1–2 stops per 2 min horizon + curve dips | realism.ts + check-v2 |
| G4 | **curvature violations** | emitted segment mean speed vs the curve envelope over the segment span | 0 above `cap·1.05 + 0.3 m/s` | generator (exact, has vLimit) + selftest-v2.ts (recomputes profile from geometry-pack) |
| G5 | **fix-catch-up latency** | per fix-driven re-emission with gap ∈ [20, 120] m: earliest `t − t_E` with \|smooth(t) − opinion(t)\| < 15 m, on the emitted curves | p50 ≤ 12 s, p90 ≤ 28 s (§6 math: 40 m → ~10 s, 120 m → ~24 s + envelope headroom); gaps 120 m–T_disc: p90 ≤ 60 s (350 m at capped surplus ≈ 62 s is the physical worst case — still better than a teleport). Envelope-forced extensions are counted, not excused: if p90 fails on them, the ceiling is wrong, not the gate | generator counters + check-v2 (from observed transitions, evalTrack) |
| G6 | **oscillation / overshoot** | sign changes of (smooth − opinion) after first convergence, per episode | p95 ≤ 1 (converge, settle, no hunting) | generator + check-v2 |
| G7 | **phantom brake dips** | local v-minimum ≥ 1.0 m/s below both neighbors, not at a hold, with **no binding constraint** (generator tags binding envelope/curve/hold per knot) | 0 per 24 h | generator only (needs context); check-v2 reports raw dip-rate as advisory |
| G8 | discontinuity honesty | fix-driven same-trip re-emissions flagged `discontinuity` | ≤ 5 %; age-driven ≈ 0 % | generator counters + check-v2 |
| G9 | seams & contract | \|Δsmooth(t_E)\| ≤ 2 m; ≤ 24 knots; ≥ 120 s horizon; determinism | unchanged | existing check-v2/determinism-v2 |

G2/G3/G4/G7 are the «ничего не дёргается» gates, G5/G6/G8 the «фиксы
уважаются» gates, G1/G4 the «едет как трамвай» floor. The accuracy bar rides
beside them (§10).

## 9. What stays / what dies

| thing | verdict | where |
|---|---|---|
| modal stop rule (P 0.6, standingS, learned Normal) | **stays**, becomes the virtual tram's anchor hold; generalized: downstream stops served with learned p50 dwell (modal, not expectation) | §4.2 |
| raw ML Δs targets as the tracked reference | **die**; demoted to leg times + tail pace + ±15 % trim + nowcast anchor | §3 |
| C¹ seams (inherit s, v) | **stay**, upgraded C¹⁺ (seam accel inherited, jerk-limited) | §4.3 |
| wire shape, limits, both tracks, ≤24 knots, ≥120 s | **unchanged** | — |
| `TRAJ_DISCONTINUITY_M = 150` flat | **dies** → gap-aware `T_disc`. Protocol text edit, own commit — two touches: the ">150 m" figure, and the §Extended-convergence *mechanism description* (commanded-speed formula), whose invariant («converges as fast as the limits permit, never lies») is unchanged but whose ceiling is now the observed-pace `CATCH_HEADROOM` ceiling, not bare `V_MAX` — the night-centre honesty rule | §7 |
| kinematic caps A_ACC/A_BRK/V_MAX (contract) | **stay** frozen | protocol |
| `speedProfile.ts` curve caps + envelope + lookahead + trail window | **reborn server-side** (the port) | §4.1 |
| zone caps (daytime centre bbox) | **die** (superseded by learned pace surfaces) | §4.1 |
| V_CRUISE_REF × paceBias × TOD product | **dies** (the learned `paceAt` surface IS this, measured per segment×band×dayType) | §2 map |
| smoother regime table, hysteresis, catch-up ceiling anchor | **reborn at generation time** | §6 |
| TRAIL_M 10 | **dies** | §6 |
| emission triggers (fix-driven + 60 s age), ML-down ⇒ drop vehicle, 2 s JSON freeze | **stay** (unchanged scope) | run.ts |
| fleet constraints (queue / cross-shape / junction yields) | **stay dead in v3** — explicitly out of scope; the server-side revival is the prediction-architecture "headway clip" (phase 2 of the big program), a separate design | — |
| stuck-hold (jam pinning from repeated fixes) | **not in v3** (the generator sees one fix, not fix history; ML's corridor feature approximates slowdowns). Noted limitation; candidate v3.1: thread `prevObsDistM` into the anchor like `standingS` already is | — |

## 10. Parameter table (complete)

Frozen = protocol contract; port = value inherited with its original evidence;
new = introduced here, pre-registered for tuning by the gates.

| constant | value | descends from | status |
|---|---|---|---|
| `TRAJ_V_MAX_MS` / gate | 16.7 / 17.0 m/s | protocol | frozen |
| `TRAJ_A_ACC` / gate | 1.3 / 1.35 m/s² | speedProfile A_ACC (IMU p90: real accel p50 0.50 / p90 1.30) | frozen |
| `TRAJ_A_BRK` / gate | 1.4 / 1.45 m/s² | speedProfile A_BRK (IMU p90: real decel p90 1.18, envelope value) | frozen |
| `J_MAX` / `J_GATE` | 0.8 / 0.9 m/s³ | new; EN 13452-1 jolt ≤1.5, comfort band 0.5–1.0 (§5 sources) | new, tunable 0.6–1.0 |
| `V_LIMIT_MAX` | 13.9 m/s | speedProfile V_MAX_MS (50 km/h network cap; stays the profile clamp — the 16.7 wire bound is never approached) | port |
| `A_LAT` | 0.98 m/s² | speedProfile | port |
| `CURVE_SLOW_FACTOR` | 0.85 | speedProfile (p90 envelope vs ride GPS, analysis-07-20) | port |
| `V_CURVE_MIN_MS` | 1.4 m/s | speedProfile | port |
| `DEFAULT_LOOKAHEAD_M` | 400 m | speedProfile | port |
| `TRAIL_LIMIT_M` | 15 m | speedProfile (body still on the curve behind the head) | port |
| `T_BRK_BUILD` / `T_ACC_BUILD` | 1.75 / 1.63 s | derived A/J | derived |
| envelope jerk margin | `v·T_BRK_BUILD/2` | new (§5) | derived |
| `PACE_CLAMP_LO/HI` | 0.5 / 1.5 ×`paceAt` | paceBias ratio clamp [0.4, 1.6] (tramSim), tightened | new, tunable |
| `G_ML` (trim gain) | 120 m | smoother `PACE_GAIN_M` | port |
| `TRIM_AUTH` | 0.15 | smoother track clamp (0.7/1.35 → ±15 % of the tight side) | new, tunable 0.10–0.25 |
| `DWELL_MIN` / `DWELL_CAP` | 5 / 40 s | learned-walk clamps (sticky-hold defense); real dwell p50 ≈ 17 s | port |
| `DEFAULT_DWELL_S` | 18 s | tramSim (confirmed by rides) | port |
| `TRAJ_MODAL_P` | 0.6 | protocol / learned-2h | frozen |
| `PACE_GAIN_M` (smooth track band) | 120 m | smoother | port |
| track clamp | 0.7 / 1.35 | smoother | port |
| `CATCH_ENTER` / `YIELD_ENTER` / `YIELD_EXIT` | +40 / −40 / −12 m | smoother TRACK_BAND / hysteresis | port |
| `T_CLOSE` | 8 s | new (replaces the 30 s blend window as the *demand* constant); tuned to its band edge after the first live G5 window (was 10) | new, tunable 8–15 |
| `DV_CATCH_MAX` | 7.0 m/s | new (bounds surplus; the CATCH_HEADROOM ceiling binds first on slow corridors); tuned to its band edge after the first live G5 window (was 6.0) | new, tunable 4–7 |
| `CATCH_HEADROOM` | 1.9 ×`paceCorr` (both corridor ends — §6 deviation note) | smoother CATCHUP_HEADROOM (measured p90/p50 free-running) | port, amended 2026-08-17 |
| `CATCH_DV_MIN` | 2.5 m/s | 2026-08-17 deviation (§6 note): ceiling floor above the reference's own speed | new, tunable 2–3.5 |
| `HOLD_APPROACH_MIN` | 5.5 m/s = `DEFAULT_PACE` | 2026-08-17 deviation (§6 note): hold-follow approach floor | new |
| `YIELD_FACTOR` / `YIELD_MIN_V` | 0.5 / 3.0 m/s | smoother | port |
| `DISC_FLOOR` / `DISC_CAP` / margin / gap clamp | 350 / 1200 m / 1.25 / [45, 240] s | tramSim teleportThresholdM (500/1500 floor/cap rescaled to the drive's close-out ability) | new, tunable |
| `CONV_TOL_M` (G5 target) | 15 m | new (≈ one tram length) | new |
| `TRAJ_SIM_STEP_MS` | 1000 | existing | keep |
| `TRAJ_MAX_POINTS` / `TRAJ_MIN_SEG_MS` | 24 / 1000 | protocol | frozen |
| compression `FREE_M` | 0.02 m | existing emit() | keep |
| near-term compression weight | `w(t) = 1/(1 + (t−t_E)/45 s)` on merge cost | new (§11) | new |
| flip deadband (G3) | 0.2 m/s² | new | new |
| emission cadence / age re-emit / JSON TTL | fix-driven / 60 s / 2 s | run.ts | keep |

## 11. Emission under 24 knots — constraint-aware compression

The jerk-limited drive has more breakpoints than the old profile (each stop ≈
brake-build / brake / release-build / stand / accel-build / accel / cruise).
The existing greedy position-error-minimal merge stays, with two changes:

1. **Protected knots** — never merged: hold entry/exit instants, the modal
   release, seam knot, and knots where the profile *rides a binding curve
   cap local minimum*. Rationale: merging across a curve dip re-lerps the
   client's speed OVER the dip — a wire-level curvature violation (G4) that
   the fine profile never committed. With protection, G4 = 0 by construction.
   **Erratum (2026-08-17, measured live):** corner protection alone does NOT
   give structural zero — four additional mechanisms produced ~40 violations
   per day: (a) *cornerless descents*: braking into a hold ACROSS a curve
   zone is monotone in v, so no local minimum exists to protect, yet the
   merged chord's positional midpoint lands in the dip with a mean above its
   cap; fixed by an **envelope guard in the merge loop** — a merge whose
   resulting chord would cross `cap·1.05 + 0.25` at the chord's EMITTED
   positional midpoint (accumulated endpoint-trapezoid position — fine-grid
   approximations drifted metres apart deep in budget-forced horizons and
   let a t+99 s chord slip through) is forbidden, re-evaluated after every
   accepted merge; the over-budget escape merges farthest-first anyway and
   counts it in the §11 pressure gauge; (b) *hot seams*: the previous
   emission's CHORD speed at `t_E` can exceed the local curve envelope (it
   was legal at its own midpoint), and both tracks now cap the inherited
   seam speed with a **margin-aware seam cap** — the largest v satisfying
   `v ≤ env(s; jerk-onset margin(v, a0) + 2·dt)` (bisected), with the
   inherited accel clamped ≤ 0 whenever the cap bites (§4.3, §6); the
   opinion's earlier raw-envelope seam cap was necessary but not sufficient
   (measured: a raw-capped age-seam still printed 7.37 m/s across a 6.72 cap
   one segment in); (c) *plateau overshoot*: a full-throttle ramp arriving
   at any demand plateau overshoots by up to `A_ACC²/2J ≈ 1.06 m/s` under
   the jerk window; fixed by the **S-curve approach ceiling**
   `a ≤ +√(2·J·(vCmd − v))` — the exact accel-side mirror of the §4.3
   landing floor; (d) *the margin cliff*: the §5 onset margin is
   a-dependent, so a hard ramp COLLAPSES its own envelope demand — a vertex
   that looked far at a = 0 suddenly bites at a = +1.3, after jerk can no
   longer comply (measured: 3-consecutive-step overshoots up to +1.3 m/s
   entering dips during ceiling-unlocked catch-up); fixed by a
   **one-step-ahead feasibility clamp** — each step's accel is bisected down
   (within the jerk window) until the post state `(v', a')` passes its own
   margin test, the discrete form of "never enter a state you cannot brake
   out of".
2. **Near-term weighting**: merge cost × `w(t)` (table above). The far half
   of the horizon is routinely superseded by the next emission (~50 s
   cadence); spending knot budget there at the expense of the next 30 s is
   backwards.

Worst-case budget check: dense centre, 3 stops + 2 curve dips in 120 s ≈
3×6 + 2×4 + seam/tail ≈ 28 fine breakpoints → 24 after merging the cheapest
(far-horizon accel-build shoulders), sub-meter position error. If the
protected set alone ever exceeds 24 (pathological), drop protection farthest-
first — and count it (`knotBudgetPressure` gauge).

## 12. Validation plan

Phase A — **shadow** (no published bytes change):

1. Implement `drive.ts`; wire a parallel build in `refreshTrajectories`:
   every emission also builds v3 opinion+smooth from the same inputs and prev
   v3 seam state, kept in memory per key, NOT published.
2. Score them as new variants **`ml-drive`** (v3 opinion) and
   `ml-drive-smooth` (v3 smooth) in the standard at-fix harness — the scores
   schema is variant-string generic (`lab/src/db.ts`), so this is one push in
   `processSnapshot` next to the ml-mode probe, same matched-n discipline
   (only when anchored to the same fix).
3. Run the perceptual counters on the shadow tracks; run ≥ 48 h covering two
   weekday peak pairs and one night.
4. Compare via `lab/scripts/score-report.mjs` (matched events) + the
   `/api/summary → perceptual` gauges.

**Ship bar (all mandatory):**
- metric: `ml-drive` mean |err| ≤ `learned` in the same matched window
  (aggregate AND in ≥ 60 % of hourly buckets — no time-of-day regression
  hiding in the mean); signed mean not more positive than +10 m (never
  systematically ahead — the v2 gate's asymmetric-cost clause);
- every perceptual gate G1–G9 green over the full window;
- `selftest-v2.ts` + `determinism-v2.mjs` + full `check-v2.mjs` green.

Phase B — **flip**: `buildV2Vehicle` switches to the v3 drive; `ml-mode` /
`ml-smooth` now measure the published v3 pixels (their meaning — "what phones
render" — is unchanged); `ml-drive` shadow retires after one overlap week.
The protocol-text edit (§7) lands first, in its own commit.

Phase C — **visual review** (owner-facing, before the app points at it):
- `/physics` page, ≥ 5 vehicles including: one crossing a known tight
  junction curve (curve-capped zone), one at a terminal loop, one mid-route
  at night. Reviewer looks at: v(t) dips into curve caps with S-curve
  shoulders (not steps); departure S-curves out of holds; a(t) has NO
  rail-to-rail comb; after a large fix jump the smooth v(t) shows one clean
  surplus hump, no hunting; holds are flat and release at plausible instants.
- iOS simulator (Mac `ios-resource` build queue per repo rules): watch the
  same vehicles on the map in smooth mode with the smooth↔fixed comparison
  on. Checklist: braking visibly begins before sharp curves and platforms;
  no mid-street full stops without a standing opinion; fix arrival produces
  a decisive, tram-like surge that settles within ~10–20 s; platform
  behavior — arrive, stand, depart — with no floating; nothing twitches at
  re-emission seams.

## 13. Migration risks

| risk | mitigation |
|---|---|
| ML leg times physically impossible / crossing noise at trip tails | `T_kin` floor + pace trust clamps; tail-pace fallback; τ monotone-clamped |
| learned cells sparse (new stops/segments) | the surface's own fallback ladder ends at DEFAULT_PACE/DEFAULT_DWELL — the drive degrades to "generic tram", never to garbage |
| knot budget pressure in dense-centre horizons | §11 weighting + pressure gauge; worst case loses far-horizon fidelity that the next emission repaints anyway |
| longer driven convergence (no 150 m teleport) exposes the smooth score | bounded by T_disc/ceiling math (≤ ~60 s worst); W1 measured continuity at 0.0 m mean cost with *lazier* convergence; G5/G8 watch it |
| compute cost | fine sim ≤ 300 steps × O(1) amortized constraint scan per vehicle-emission; ~10–20 emissions per 2 s cycle — same order as today's fit, well under the ML inference time already in the loop |
| regression only visible in feel, not metrics | that is exactly what G2–G7 + Phase C exist for; do not ship on metrics alone (the 2026-08-16 lesson: caps alone made metrics fine and the product worse) |
| night request-stops (tram genuinely skips empty platforms) | dwell floor 5 s at night bands via learned `dwellAt` (band-keyed); accepted residual — the ML leg times still carry the true pace |

## 14. Source index

Repo: `docs/research/physics-v3-protocol.md` (contract);
`lab/src/trajectory.ts`, `lab/src/run.ts`, `lab/src/ml.ts`,
`lab/src/learned.ts`, `lab/src/realism.ts` (current pipeline);
`lab/vendor/engine/{speedProfile,tramSim,smoother}.ts` +
`docs/decisions/{interpolation-engine,engine-v2}.md` (the mechanisms and
their evidence); `lab/README.md` §Findings (the measured ladder and W1/W2
pricings); `docs/calibration/analysis-2026-07-{11,20,28}*.md` (IMU p90
accel/decel, curve-factor envelope, dwell p50 17 s, sticky-hold 50–75 s,
cadence p50 ~50 s / p90 ~95 s + 8–14 s latency);
`docs/research/prediction-architecture.md` (program frame, zone-cap
retirement, headway-clip deferral); `docs/project-review-2026-07-13.md` §P3
(the original jerk-limit hypothesis).

External (jerk):
[SS-EN 13452-1](https://www.sis.se/en/produkter/railway-engineering/metro-tram-and-light-rail-equipment/ssen134521/) ·
[BS EN 13452-1:2003](https://www.en-standard.eu/bs-en-13452-1-2003-railway-applications-braking-mass-transit-brake-systems-performance-requirements/) ·
[PWI comfort-design analysis](https://www.thepwi.org/wp-content/uploads/2021/02/Presentation_200304_Passenger-comfort-design-analysis.pdf) ·
[Beijing Subway ATO comfort model](https://www.mdpi.com/2071-1050/12/11/4541) ·
[Artuñedo et al. 2022, jerk-limited planning](https://autopia.car.upm-csic.es/wp-content/papercite-data/pdf/artunedo2022_jerklimitedtime.pdf) ·
[Powell & Palacín 2015, Urban Rail Transit](https://link.springer.com/article/10.1007/s40864-015-0012-y)
