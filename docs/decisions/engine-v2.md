# Engine v2 — Predictor + Smoother (design record)

Status: **IMPLEMENTED (2026-08-01); ship gate §3 executed — see
`docs/calibration/baselines/gate-v2.md`** for the pre-vs-post table, the
per-criterion verdicts (live/predictor improved 11.8%; two smoother clauses
honestly failed against the oracle-assisted pre-v2 baseline — analysis in the
gate record), the shipped constants (`FEED_LATENCY_S 5`,
`STOP_HOLD_MAX_FIX_AGE_S 40`) and the evaluated-and-rejected candidates
(blind-gap damp, TRAIL 0). Design text below is r2 as implemented. Supersedes
the dual-controller architecture of `decisions/interpolation-engine.md`
§6/§11; everything else in that record (empirics, field-fix rationale,
calibration history) remains the evidence base. Review findings incorporated
below are marked `[R]`.

---

## 1. Problem — why a rewrite, not another calibration round

### 1a. The mode-divergence defect (forensic, 2026-08-01)

Smooth mode (main sim) and live mode (projSim) are **two independent
controllers with unrelated speed references**:

- **main sim** chases `target = 0.75·sObs + 0.25·sSched − 10 m` with a pace
  factor `clamp(1 + e/120, 0.7, 1.35→1.4)`, a ×1.25 departure burst, and
  crawl/soft-yield latches. Between fixes both blend terms advance at the
  **schedule slope σ**, so the controller equilibrates at `factor = σ/P` — the
  smooth cruise speed is slaved to the *timetable's* pace.
- **projSim** dead-reckons the last fix at the **learned pace**
  `P = min(cruiseCap, V_CRUISE_REF)·paceBias·tod` — no target, no factor, no
  burst (R11 redesign).

Whenever `σ ≠ P` the modes diverge **by construction**. Measured worst case
(stale-release departure from a shared stop — the exact user-reported
scenario): identical release instant, then smooth cruises at up to
`1.4 × 1.25 = 1.75·P` (12.7 m/s vs live's 7.25 m/s) or latches soft-yield at
`0.5·P` — a −50%…+75% visible speed disagreement on identical data. Each half
is individually documented and intentional; the *composition* was never
evaluated. Unfixable by tuning: no constant makes `σ = P`.

### 1b. Accidental complexity (inventory, 2026-08-01)

~20 mechanisms with: 3 parallel representations of "stops still ahead";
4 near-identical brake-to-a-point clamps; 5 sites computing the cruise
product; duplicated advance-cap arithmetic; 5 different distance tolerances
for "the tram is standing"; 4 overlapping reset paths each clearing a
different subset of transient state; 2 dormant multiplier systems threaded
through the hot path.

### 1c. Empirics the design must respect (calibration program)

- Fix cadence p50 **45–55 s**, p90 ~95 s, irregular; plus **8–14 s hidden
  pipeline latency** beyond `origin_timestamp` (fix already ~+77 m behind
  reality at apparent age 0–15 s).
- Real moving pace: fleet p50 ~22–24 km/h; centre corridor **~19 km/h flat
  around the clock (zonal, not time-of-day)**; TOD factors measured 1.0 for
  every hour; per-vehicle pace learning absorbs the diurnal dynamics.
- Real trams have sprint headroom (real p90 46 km/h vs sim 40); the v1
  catch-up ceiling pins below free-running pace when bias is contaminated.
- paceBias contaminated by signal standstills (0.72 → 0.46 on stop-heavy
  stretches); 63% of AVL records are `at_stop`; the AVL holds `at_stop`
  50–75 s per platform vs real dwell p50 ≈ 17 s.
- `A_ACC 1.3` / `A_BRK 1.4` = real IMU p90; `CURVE_SLOW_FACTOR 0.85` = p90
  envelope; `DEFAULT_DWELL_S 18` confirmed.
- Error is born at stops (stale at-stop holds) and paid on the following run.

---

## 2. Decision — one predictor, one smoother, three render modes

```
fix      (layer 0)  the last raw AVL fix on the shape        → "Raw" mode
   ↓ seeds
predictor (layer 1)  best estimate of the REAL tram now       → "Live" mode
   ↓ is chased by
smoother  (layer 2)  cinematic tracker of the predictor       → "Smooth" mode
```

The divergence class disappears structurally: the smoother's reference IS the
predictor. There is no second physics controller and no schedule-slope pace
reference anywhere.

### 2.1 Layer 0 — fix

`snapshot.shapeDistM` placed on the shape (`observedPosition` /
`observedBearing`) — unchanged semantics. New third render mode **`raw`**
(`PositionMode = 'smooth' | 'live' | 'raw'`). Raw-mode plumbing is specified
end-to-end in §2.7 `[R]`.

### 2.2 Layer 1 — predictor

One physics sim per tram estimating where the real tram is right now.

- **Reseed on every genuinely-new fix** (new `observedAtMs` or `shapeDistM`,
  or trip/shape change): seed at the fix, then advance to `now` over the span
  `(now − observedAtMs) + FEED_LATENCY_S` `[R: latency makes the fix OLDER
  than obsAt claims — same clock staleFixAgeMs already uses]`, bounded by
  `maxAdvanceM` computed on that same true age. The advance is **closed-form,
  not replayed physics**: segment the span by the stops between the fix and
  the advance bound, moving at the learned cruise pace between stops and
  spending scheduled/default dwell at each — O(stops crossed), never
  hundreds of substeps inside ingest `[R: p90 fix age ≈ 95 s would otherwise
  cost ~380 substeps/tram on the ingest path]`.
- **Between fixes**: cruise at `P = min(cruiseCap, V_CRUISE_REF)·paceBias·tod`
  under the braking envelope; stops with fixed dwells
  (`DEFAULT_DWELL_S · todDwellFactor`, scheduled dwell values never scaled);
  terminal latch + un-latch (un-latch propagates to the smoother, §2.3).
- **Observation-pinned holds live here** (statements about reality):
  arrival-fix pin, stuck-hold, latency-aware staleness release (45 s on
  `(now − obsAt) + FEED_LATENCY_S`).
- **Trip/shape change is atomic for both layers** `[R]`: one ingest swaps
  geometry for predictor AND smoother together; the smoother re-anchors by
  projecting its old world point onto the new shape (keep v1's ≤ 100 m offset
  / ≤ teleport-threshold rule verbatim), else fade-teleports to the
  predictor. `getGeometry(key)` returns that single shared geometry — the
  live head must never be evaluated on a different polyline than the one
  `getGeometry` hands to featureBuilder.
- **paceBias** learned here from inter-fix spans. **R13 as clip-not-drop**
  `[R: dropping every at_stop-endpoint span would starve the EWMA — 63% of
  records are at_stop; acceptance would fall to ~14% fleet-wide, worst in the
  centre]`: deduct the *standing portion* of each span (scheduled dwells as
  today, plus pin/stuck-active time, bounded), keep the moving remainder as
  the sample when it clears `PACE_BIAS_MIN_DS_M`; drop the span only when no
  confident moving remainder survives. Pre-registered measurement before
  shipping: acceptance rate per zone must stay within 2× of v1's effective
  sample rate. Prior 0.62 / half-life 150 s / memory TTL 15 min unchanged.
- **Schedule anchor demoted** to: dwell durations, terminal semantics, UI
  ETAs. Never a pace reference, never blended into a position target.
- Gap-aware teleport thresholds unchanged.
- **`resyncAfterSuspension(now)` v2 semantics** `[R: the v1 body seeks to the
  schedule-blend target, which no longer exists]`: re-anchor the predictor
  closed-form from its last fix (the same segmented advance as reseed,
  bounded by `maxAdvanceM`, respecting stuck-hold / at-stop pin / staleness),
  snap the smoother to `sPred − TRAIL_M` with a fade stamp, re-arm both
  layers' clocks. Forward-only, monotonic — preserves the
  `engine-substep.test.ts` behavioral pins with a new mechanism.

### 2.3 Layer 2 — smoother

A thin tracker. State: `sM`, `vMs`, dwell-presentation state. Reference:
`err = sPred − sM − TRAIL_M` (TRAIL_M = 10 while the predictor is moving;
**suppressed while the predictor holds** `[R]`; whether 10 → 0 entirely is
arbitrated by the replay gate, not inherited on inertia).

**Regime table (r2).** Hard clamps always: `vTarget ≤ vAllowedAt`, accel
`[−A_BRK, +A_ACC]`, `sM` monotonic, on-shape.

| regime | condition | vTarget |
|---|---|---|
| **hold-follow** `[R: blocker fix]` | predictor standing (dwell / stuck / pin / terminal), i.e. `vPred ≈ 0` | reference becomes the **point** `sPredHold`, TRAIL suppressed: behind → `brakeTowards(sPredHold)` (roll onto the platform / jam tail, capture via stop-reach clamp, join the dwell → doors open); ahead → brake to a stand (no 3 m/s floor — reality itself is standing) |
| track | `vPred > 0`, `\|err\| ≤ 40 m` | `vPred · clamp(1 + err/120, 0.7, 1.35)` |
| catch-up | `vPred > 0`, `err > 40 m` | ramps continuously from `1.35·vPred` at err = 40 to the ceiling at err ≈ 120 `[R: no step discontinuity]`; ceiling = `min(vAllowed, cruiseCapAt, CATCHUP_HEADROOM · paceBias · V_CRUISE_REF)`, `CATCHUP_HEADROOM ≈ 1.9` (measured p90/p50 free-running ratio) `[R: full track cap would sprint 50 km/h through the night centre where the real corridor is 19 km/h — the ceiling's anchor is observed free-running pace, not the legal cap]` |
| yield | `vPred > 0`, `err < −40 m` (exit −12, hysteresis kept) | `max(3.0, 0.5·vPred)` — never pedestrian while reality moves |
| teleport | `\|err\|` > gap-aware threshold | snap + fade (`lastTeleportMs`) |

**Stops (r2)** `[R: the previous draft was unspecified in the common cases]`:

- Dwell-sync **binds per stop index** — the smoother syncs only to a
  predictor dwell at the *same* stop.
- Arrive while predictor dwells at that stop → dwell until the predictor
  departs, **capped at `DWELL_MAX_EXTEND_S = 75 s`** past which doors close
  (phase leaves `'dwell'`) while position holds — an unbounded doors-open
  wait reads as a broken app.
- Arrive after the predictor already departed, `0 < err ≤ 60 m` → dwell
  `max(DWELL_MIN_S = 4 s, predictor's remaining dwell at smoother arrival)` —
  the validated shorten rule, re-expressed against the predictor.
- `err > 60 m` at the stop → skip the dwell, roll through ≤ 4 m/s (the real
  tram is gone; doors stay closed). Terminal stops never skipped.
- **Terminal un-latch propagation** `[R: blocker-adjacent]`: a predictor
  terminal un-latch (sanctioned backward re-anchor at 150 m) propagates to
  the smoother as a sanctioned backward **fade-teleport, independent of the
  gap-aware threshold** — otherwise the smoother wedges at the wrong terminal
  (the R2 +324 m class).

**Constraints (r2)** `[R: "inherits by following" was false — following
preserves order, not time separation]`: the same-shape queue clamp AND the
cross-shape brake-only caps AND the junction speed-only yields all run on the
**smoother fleet too**, exactly as v1 ran them on its second fleet. Discovery
stays ingest-driven; per-tick application is O(1)/pair. What smooth mode
renders must not drive through the tram ahead — that sentence from v1 §9
survives verbatim.

**Deleted from v1** (unchanged from r1): schedule-target chasing,
`OBS_BLEND_WEIGHT`, departure burst, crawl/deepCrawl double latch (the
hold-follow rule + yield hysteresis replace them), adaptive-dwell
extend/shorten machinery in its v1 form (subsumed by the stop rules above),
`rewindToStuckFix` (stuck-holds live in the predictor).

### 2.4 Cadence & performance contract `[R: r1 had this inverted]`

The performance invariant stands verbatim: *"applying/sorting an unchanged
second fleet on every 33 ms smooth-mode tick is forbidden"*
(`docs/performance.md`). Therefore:

- `setProjectionCadence('full' | 'coarse')` **keeps today's meaning**:
  - `'full'` (live mode): predictor advances every substep.
  - `'coarse'` (smooth mode): predictor batched at
    `PROJ_COARSE_INTERVAL_MS = 500` (250 ms allowed if the benchmark clears
    it); the smoother's per-substep reference `sPred` is **linearly
    interpolated** between predictor batch points (monotone, cheap, no
    physics). The smoother itself advances every substep — it is the
    rendered layer.
- `tick-cadence.test.ts` / `engine-projection.test.ts` semantics survive;
  the benchmark decides whether full-cadence-in-smooth is *allowed later*,
  not whether coarse is needed now.
- Tick/substep contract preserved: dt 33–1000 ms, `MAX_ENGINE_DT_S 0.25`,
  catch-up cap 2 s, first-tick anchor, constraints after every substep.

### 2.5 Public-state mapping

| field | v2 source | note |
|---|---|---|
| `simDistM` / `position` / `bearing` / `simSpeedKmh` / `phase` | smoother | unchanged meanings |
| `projectedObservedDistM` | predictor | unchanged meaning |
| `observedPosition` / `observedBearing` / `snapshot.shapeDistM` | fix | unchanged |
| `deviationM` | `\|smoother − fix\|` | unchanged |
| `nextStopName` | **smoother's** next undwelled stop `[R: predictor-sourced identity contradicted the timeline/spotter — one sheet, one stop identity]` | unchanged meaning |
| `nextStopEtaS` | **predictor's ETA to that same stop** | reality's clock for the animation's stop; never a different stop than the marker approaches |
| `paceBias` | predictor | unchanged |

**`SimDebugInfo` changes shape** `[R: r1 claimed "verbatim" while deleting
the producers]`: latch booleans (`crawling`, `deepCrawl`, `burstActive`,
`skipRollActive`) are replaced by a `regime` enum
(`'hold-follow' | 'track' | 'catchup' | 'yield'`) + `errPredM` (replacing
target-based `errorM`); `targetDistM` reports `sPred − TRAIL`. DebugOverlay
is an **in-scope consumer change**; `engine-debug-info.test.ts`'s pure-read
pin is kept.

Preserved verbatim: the `TramFeed` seam; `TramEngine`'s public methods;
stale-entry semantics (90 s); geometry-less bare-dot path; fallback-bearing
rule; calibration JSONL field meanings; `getStates*` allocation behavior;
allocation-light tick (invariant #8).

### 2.6 Simplifications & non-negotiables

Locked in (unchanged from r1): one stops-ahead representation
(`nextStopIdx` + derived `minStopDist`); one `brakeTowards()`; one
`cruiseProduct()`; one `standingFix()` detector with one tolerance table; one
`resetTransients()` with explicit opt-outs.

**Zonal dwell ships as a separate flagged commit immediately after v2**, gated
by its own replay comparison `[R: bundling it into the rewrite makes gate
failures unattributable; the ride corpus has zero centre-crossing rides]`.
TOD tables stay as hooks (the Convex backend feeds them later).

NOT simplified away: braking envelope + speed profile; gap-aware teleport;
terminal latch/un-latch (+ propagation); arrival-fix pin & stuck-hold
(predictor); paceBias EWMA + prior + inheritance; queue/cross/junction
constraints **on both fleets**; seed-cruise-speed; monotonic `sM`;
fade-stamping every sanctioned backward correction (the smoother's terminal
un-latch snap is now one of them).

### 2.7 Raw mode plumbing `[R: r1 hand-waved this]`

| concern | decision |
|---|---|
| cadence | `'coarse'`; raw pushes ride the existing points-push due-check with an ingest-set dirty flag — a raw frame changes only when a fix changes. No new cadence row semantics; `tick-cadence.test.ts` extended, not rewritten. Both layers keep ticking (all three anchors stay populated — debug traces & instant mode switch). |
| marker jump | new-fix jump stamps the standard fade (`lastTeleportMs` convention) |
| culling anchor | `getStatesInBounds` `useProjection: boolean` → `anchor: 'smooth' \| 'live' \| 'raw'`; raw culls by the fix position |
| follow camera | anchors `observedPosition`/`observedBearing`, zero lead, eased `linearTo` glide on fix jump (~45–95 s cadence makes hard camera snaps unacceptable) |
| boolean call sites to update | `applyPositionMode` (tramData), `TramLayers` mode reads, `featureBuilder` head selection, `HonestyLine` (three-way copy: "Raw reported position"), `DebugMapTraces` active-dot, motionlog `posMode` passthrough |

---

## 3. Validation gate (r2)

TS replay runner driving the **real engine code** — no Python mirror:

- `scripts/calibration/replay-v2.ts`: ride parsing ported once from
  `ride_replay.py`'s `Ride` class (shape from rider GPS, stops from at_stop
  clusters, fixes from obsAt advances — engine-independent), then drives
  `TramEngine.ingest/tick` at recorded cadence; scores smoother AND predictor
  tracks against `fDist`; also emits the **at-fix probe** per ride.
- **Baseline discipline** `[R: 89.9 m was the 2-ride number; the 3-ride
  aggregate is ≈116 m — and the old engine is deleted in the same PR]`: the
  baseline = the TS runner's score of the **pre-rewrite engine**, captured on
  the same 3-ride aggregate and committed **before** the old engine is
  deleted. 89.9 m is only the 07-28 pair sub-check.
- **Gate to ship v2** (all mandatory):
  1. Ride gate, 3 rides aggregated: smoother mean |fLagM| ≤ pre-rewrite
     baseline; **signed mean not more positive than baseline; %ahead within
     +5 pp** `[R: the trail/hold architecture exists for the asymmetric cost —
     an unsigned gate could ship the ahead-regression class]`; both
     contiguous halves agree in direction.
  2. Fleet check: at-fix probe from the ride runner (real fixes,
     reconstructable shapes) must not regress; the v1-schema
     session-2026-07-11 **cannot drive the real engine** (no obsAt/tripId,
     expired trip_ids) `[R]` — it stays as an advisory 1D cross-check only.
     Before landing, harvest a fresh v2-schema fleet session via
     `scripts/calibration/harvest.sh` and run the at-fix probe on it.
  3. Full jest + `npx tsc --noEmit` green. New pins: **mode-consistency
     scoped to the track regime** (converged `|err| ≤ 40`, no teleport in
     window: smooth and live cruise speeds within tolerance on identical
     data) + a separate assertion that catch-up/yield divergence is transient
     (err monotonically shrinks) `[R: an unscoped test would contradict the
     regime table]`; hold-follow platform capture (smoother dwells ON the
     platform, doors open); terminal un-latch propagation; raw-mode anchor
     selection.
  4. Perf: `scripts/perf/simulator-benchmark.sh` three-run medians for
     `city`/`badges`/`models` not regressed vs pre-rewrite baseline (capture
     baseline before the rewrite lands).
- Ride files: `20260720-193029-9097.jsonl` (repo root) +
  `20260728-172812-9507.jsonl` / `20260728-182204-9506.jsonl` (copy from
  `~/Downloads`; gitignored, never committed).

## 4. Rollout

1. Capture baselines (perf runs + TS-runner scores of the old engine).
2. Land v2 behind the same seam; old engine deleted in the same PR.
3. `PositionMode` gains `'raw'` + §2.7 plumbing + settings UI third toggle.
4. Zonal dwell as a separate flagged follow-up commit with its own gate.
5. Docs: superseded banner in `interpolation-engine.md`; `architecture.md`
   engine section rewritten; RUNBOOK gains the TS runner.
