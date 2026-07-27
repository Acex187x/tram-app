# Interpolation Engine — Decision Record

How a sparse, laggy AVL feed (Golemio polls every ~20 s, positions already seconds
stale) becomes smooth 60 fps tram motion. The engine is pure, deterministic, timer-free
TypeScript — the caller drives `ingest()` per poll and `tick()` per frame.

- `src/lib/engine/tramSim.ts` — per-tram physics/state machine (`TramSim`)
- `src/lib/engine/speedProfile.ts` — per-shape speed limits + braking envelope
- `src/lib/engine/engine.ts` — `TramEngine`: owns all sims, queueing, projection, public state
- Tests: `__tests__/tram-sim.test.ts`, `engine-queue.test.ts`, `engine-projection.test.ts`, `speed-profile.test.ts`, `pace-bias.test.ts`, `tod-pace.test.ts`

> **Doc-vs-code drift warning.** `docs/architecture.md` (lines ~64–70) still describes the
> **pre-fix** controller (`vTarget = vAllowed · clamp(1+e/120, 0.55, 1.65)`, teleport to
> `sSched(now)`). That design was replaced in commit `77e193f` ("Fix wave: 21 verified review
> findings") — see the codex findings in `docs/testing/codex-review-1.md`. **This file
> supersedes architecture.md for the engine.** Several test comments also still say "1.65";
> the live ceilings are 1.5 / 1.35 (below).

---

## 1. Distance-along-shape (1D) simulation

**Problem.** Trams follow fixed rails. Interpolating in raw 2D lat/lng would let a
tram cut corners, drift off-track, or reverse across a curve when a noisy fix lands
off the rail.

**Decision.** Simulate a single scalar `sM` = meters traveled along the trip's shape
polyline. World position is `pointAt(coordinates, cumDistM, sM)` and bearing
`bearingAt(...)` — the tram is *always* on the rail by construction (`engine.ts:392-393`).

**Why.** Reduces the whole problem to 1D kinematics: speed limits, braking, dwell,
and car-following all become comparisons on `sM`. `sM` is **monotonically
non-decreasing** except on an explicit teleport (`tramSim.ts:1-3`) — trams never
visibly reverse. AVL fixes arrive as `shapeDistM` (from GTFS `shape_dist_traveled`),
so the feed speaks the same coordinate.

---

## 2. Per-shape speed profile — curvature + zone caps

**Problem.** A tram must slow for curves and for the city-center slow zone, not just
for stops. Needs to be cheap enough to evaluate every frame for every tram.

**Decision.** Precompute a per-vertex `vLimit[]` once per geometry (`buildSpeedProfile`,
`speedProfile.ts:62`), `vLimit[i] = min(zoneCap, curveCap)`:

- **Curve cap** `curveCap(κ) = clamp(CURVE_SLOW_FACTOR · sqrt(A_LAT/κ), 1.4, 13.9)`
  (`speedProfile.ts`). `A_LAT = 0.98 m/s²` is the lateral comfort accel; κ (rad/m) from
  `curvatureProfile()`. Physically: the fastest speed at which lateral accel in a curve of
  curvature κ stays ≤ A_LAT, scaled down by **`CURVE_SLOW_FACTOR = 0.85`** (realism
  heuristic, 2026-07-19: real trams brake for curves harder than pure lateral comfort —
  switch frogs, worn rail). The factor applies **before** the clamp, so gentle arcs whose
  raw cap exceeds `V_MAX_MS` (radius ≳ 270 m) are unaffected; tight junction curves get
  ~15% slower. Deliberately conservative — **tunable, calibrate against real ride
  recordings** (`fLagM`/`gpsSpeed` through curves).
- **Zone cap** `zoneCapAt` (`:47`): `V_MAX_MS = 13.9` (50 km/h) network default;
  `V_CENTER_MS = 8.6` (31 km/h) inside `CENTER_BBOX` **only during daytime** (07:00–19:00
  Prague time). Rebuilt when the daytime flag flips (`engine.ts:150 refreshDaytime`, profiles
  keyed `shapeId`+`daytime`).

**Why per-vertex, not per-segment.** A sharp apex is a *point* constraint. `cruiseCapAt`
(`:84`) returns `max()` of the two segment endpoints so a single slow vertex does **not**
blanket-limit a long straight leading into it — the braking envelope (below) handles the
approach to that point instead. `TRAIL_LIMIT_M = 15` keeps a just-passed apex limiting for
~one tram length behind the head (the body is still on the curve, `:126-134`).

---

## 3. Braking envelope `vAllowedAt` — and why pace must NEVER multiply it

**Problem.** To arrive smoothly at a stop/curve, a tram must start braking *before* it,
bounded by `A_BRK = 1.2 m/s²`.

**Decision.** `vAllowedAt(profile, geometry, sM, minStopDist)` (`speedProfile.ts:105`) =
the max speed at `sM` from which **every** upcoming limit point within `DEFAULT_LOOKAHEAD_M
= 400 m` is still reachable by braking at `A_BRK`:

```
vAllowed(s) = min over limit points d≥s of  sqrt(vLim(d)² + 2·A_BRK·(d−s))
```

Limit points: shape vertices (curve/zone caps), stops (`vLim = 0`), and the geometry end
(`vLim = 0`, never overshoot the terminal). Stops with `distM < minStopDist` are skipped so
already-dwelled/passed stops don't pin the tram (`:138-144`).

### The `66 → 0 km/h` snap bug (P1, fixed in `77e193f`)

**What broke (pre-fix).** The pace controller multiplied the **braking envelope** by the
catch-up factor: `vTarget = vAllowed · factor` (up to 1.65×). A late tram would therefore
cruise *above* the curve/stop cap and postpone braking until it was physically impossible to
stop at `A_BRK` — e.g. a 10 m/s envelope value became 16.5 m/s on a stop approach. The tram
sailed in at ~66 km/h and then the stop-reach clamp (`sM = min(sNew, next.distM)`, `vMs = 0`)
**snapped it from ~66 km/h to 0 in one frame** — a visible teleport-into-the-platform.
(`docs/testing/codex-review-1.md` finding #3.)

**Fix.** The pace factor multiplies **only the cruise reference**, and the result is then
clamped by the hard envelope (`tramSim.ts tick()`):

```ts
vTarget = Math.min(vAllowed, Math.min(cruiseCapAt(...), V_CRUISE_REF_MS) * factor * paceBias * todPaceFactor(now));
```

A late tram may hold the track's cruise speed but can **never** defeat the braking envelope
toward a stop or curve. `cruiseCapAt`'s doc-comment states this
invariant explicitly: *pace scaling may multiply cruiseCap only, never vAllowedAt*.
Regression: `tram-sim.test.ts` "late tram braking (catch-up never defeats the envelope)"
forces a 20 m/s schedule (factor pegged at max) and asserts arrival speed ≈ the
envelope value at the reach boundary (~2.2 m/s), not a 60 km/h snap.

### Cruise reference vs. hard cap (calibration round 1, R3)

`V_CRUISE_REF_MS = 11.7` (42 km/h) bounds the **pace-controller reference** — the speed the
controller aims for on an unconstrained straight before the catch-up factor, `paceBias` and
the TOD factor multiply it. Measured basis (`docs/calibration/analysis-2026-07-11.md` §3):
real outside-center speeds are p50 23.0 / p90 42.9 km/h; only 4.6% of inter-fix intervals
exceed 50 km/h. So 50 km/h is right as a **cap** and ~2× too fast as a cruise **target**.
`V_MAX_MS = 13.9` keeps bounding the braking envelope (`vAllowedAt`) and zone/curve caps —
caps stay caps — and catch-up regimes (factor ≤ 1.4, smooth wave) can still exceed the reference up to
that envelope. The pace calibration measures its real/expected ratio against the same
reference (`meanCruiseCapOver(..., V_CRUISE_REF_MS)`), so converged `ref × bias` equals the
tram's real motion pace by construction.

---

## 4. Schedule anchor vs OBSERVATION-PRIMARY re-anchoring

**Problem.** Where "should" a tram be *right now*, between two 20 s-apart fixes?

**Two references:**
- **Schedule anchor** `sSched(t)` — piecewise-linear distance-vs-time through the trip's
  stops, using timetable arrival/departure times shifted by `delaySeconds`, flat during
  dwells (`buildScheduleAnchor` `:101`, `evalScheduleAnchor` `:121`, binary search).
- **Projected observation** — the last AVL `shapeDistM` at `observedAtMs`, advanced forward
  to `nowMs` **at schedule pace** (never backwards), clamped to geometry (`observedDistAt`
  `:151`).

### The timetable-only drift bug (P1, fixed in `77e193f`)

**What broke (pre-fix).** `applySnapshot` stored the new snapshot but computed corrections
**exclusively from the timetable anchor** — it never read the fresh `shapeDistM`/`observedAtMs`,
and even the teleport target was `sSched`. So only the *very first* poll ever anchored a
same-trip sim to a real observed position; after that the sim tracked the paper timetable and
drifted from reality as delay accumulated. (codex finding #2.)

**Decision — observation-primary.** `applySnapshot` (`:331`) now re-anchors the observation
(`obsDistM @ obsAtMs`) on **every** poll and caches `obsSchedDistM` for cheap projection.
The pace-controller **target** is an observation-weighted blend (`targetDistAt` `:162`):

```
target = OBS_BLEND_WEIGHT·sObs + (1−OBS_BLEND_WEIGHT)·sSched − TRAIL_M   (OBS_BLEND_WEIGHT = 0.75)
```

The projected AVL observation carries 75% of the weight; the timetable is a low-gain
reference (25%) so a tram with no fresh fix still drifts toward its schedule instead of
freezing. Test "trusts a fresh observation over a large timetable error" (`:444`) proves the
target stays near the observation even when `sSched` disagrees by ~950 m.

---

## 5. Trail bias — `TRAIL_M = 10`

**Problem.** Prediction error is roughly symmetric, but the *cost* is not: a sim rendered
**ahead** of the real tram is jarring (it arrives at a stop the rider hasn't reached; the next
fix yanks it back). A sim slightly **behind** reads as natural lag.

**Decision.** Subtract a fixed `TRAIL_M = 10 m` from the blended target (`:165`) — the sim
deliberately aims ~10 m *behind* projected reality. "Ride behind reality, not ahead of it."
Verified by `tram-sim.test.ts` "trail bias" (`:261`), which checks the exact blend − TRAIL_M.

**Adaptive `paceBias` (landed `bda0255`, recalibrated in round 1).** On each genuinely-new
AVL fix, `updatePaceBias` folds the clamped ratio (real inter-fix average speed ÷
reference-expected average speed over the same span, scheduled dwells deducted) into a
time-based EWMA with half-life `PACE_BIAS_HALF_LIFE_S = 150 s`; per-sample ratio clamp
`[PACE_BIAS_MIN_RATIO, PACE_BIAS_MAX_RATIO] = [0.4, 1.6]`. The bias multiplies the cruise
reference in `tick()` (see §3) so a consistently-slow tram is simulated at its own pace
between fixes instead of sprint-and-crawl. Calibration round 1
(`docs/calibration/analysis-2026-07-11.md`):

- **Prior**: new sims start at `PACE_BIAS_PRIOR = 0.62` (the fleet's converged median),
  **not** 1.0 — a 1.0 prior made every fresh sim simulate ~1.7× too fast for its first
  ~4–5 min (56% rendered ahead of the fresh fix, |err| p90 385 m).
- **Inheritance**: the learned bias **survives hard teleports** (same vehicle, same driver;
  the teleporting fix itself is excluded from calibration — a re-anchor jump is not motion)
  and **survives trip changes / respawns** via `TramEngine`'s per-key memory
  (`paceBiasMemory`, pruned after `PACE_BIAS_MEMORY_TTL_MS = 15 min`). Reset to the prior
  happens only for genuinely new (or long-gone) vehicles. `projSim`s are (re)seeded with the
  main sim's live bias — they never receive `applySnapshot`, so they cannot learn themselves.

---

## 6. Asymmetric pace controller — gentle band, bold catch-up, soft-yield ahead regime

**Problem.** Convergence must be smooth when close, aggressive when far behind, and must
**not overshoot** when the sim has run ahead of reality — all without ever reversing.

### The pedestrian-crawl extremes (smooth wave, 2026-07-19)

**What was wrong (pre-fix).** The ahead regime crawled at a flat `1 m/s` the moment the sim
overran the target by 40 m — the user-visible symptom: *"в smooth трамвай между остановками
замедляется до скорости пешехода, потом внезапно едет быстро"*. Mid-street walking-pace
dips followed by 1.5× sprints read as glitches, not traffic.

**Decision.** Ahead-error is now repaid *where it is natural* — at stops (adaptive dwell,
§13) — while mid-segment corrections stay inside a **narrow, never-pedestrian band**. The
calibrated average pace (prior 0.62, `V_CRUISE_REF_MS`, paceBias learning) is untouched —
the swing around it is redistributed, not the mean. Around `e = target(now) − s`:

| regime | condition | behavior |
|---|---|---|
| **gentle** | `\|e\| ≤ 40 m` | `factor = clamp(1 + e/120, 0.7, 1.35)` on cruise cap |
| **bold catch-up** | `e > 40 m` | same proportional factor, ceiling `1.4` |
| **soft yield** | `e < −40 m` (ran ahead) | `vTarget = min(vAllowed, max(3.0, 0.5 · cruiseProduct))` |
| **deep backstop** | soft yield AND `e < −120 m` | `vTarget = min(vAllowed, 1.0 m/s)` |

`cruiseProduct = min(cruiseCap, V_CRUISE_REF_MS) · paceBias · todPaceFactor` — the yield is
*half the tram's own pace*, floored at `AHEAD_SLOW_MIN_V_MS = 3.0 m/s` (~11 km/h — slow
tram, not pedestrian). Constants: `PACE_GAIN_M = 120`, `GENTLE_MAX_FACTOR = 1.35`,
`CATCHUP_MAX_FACTOR = 1.4` (was 1.5), `MIN_PACE_FACTOR = 0.7` (was 0.55),
`BOLD_CATCHUP_ERR_M = 40`, `AHEAD_SLOW_FACTOR = 0.5`, `AHEAD_SLOW_MIN_V_MS = 3.0`,
`CRAWL_V_MS = 1.0` (deep only).

**Two hysteresis latches.** The ahead regime latches at `HARD_BRAKE_ENTER_M = 40` / releases
at `−HARD_BRAKE_EXIT_M = 12` (`sim.crawling`, as before). Inside it, the walking backstop has
its **own** band — enter `DEEP_AHEAD_ENTER_M = 120`, exit `DEEP_AHEAD_EXIT_M = 60`
(`sim.deepCrawl`) — needed because a reality slower than the 3 m/s floor would otherwise let
the ahead-error widen without bound (the backstop bounds runaway at ~120 m; the next stop's
`DWELL_MAX_EXTEND_S = 75 s` extension absorbs what the yield doesn't). The sim **yields
forward, never reverses**. Speed-of-change is bounded by the accel clamp `[−A_BRK, +A_ACC]`
= `[−1.4, +1.3] m/s²`; `vMs ≥ 0`, `sM` never decreases.

**Why walking pace is still reachable at all.** Sub-3 m/s speeds remain legitimate exactly
where the spec allows them: the braking envelope (stops/curves), stuck-holds (§14), dwells —
and the deep backstop, which is genuinely broken tracking, not normal riding. Replay gate
(2026-07-19, 60 MB extract of the newest sim session, 1292 fresh-fix events): S70 (soft
yield + 0.7/1.4 clamps) vs R62 shipped — median |at-fix err| 142.8 → 141.7 m (−0.8%),
signed p50 +30.4 → +25.7 (toward the logged device reality of −38), devM p50 flat 203.
Tests: `tram-sim.test.ts` "soft-yield when the sim ran ahead of reality" (band, deep
backstop, no-pedestrian-dips gate, phase='dwell'-only-at-platform).

---

## 7. Dwell seeding by stop sequence — the skipped-stop bug

**Problem.** When a sim is (re)created near a stop, which stops count as "already served"?

### The skipped-stop bug (P1, fixed in `77e193f`)

**What broke (pre-fix).** `markStopsBehind()` marked every stop with `distM ≤ sM + STOP_REACH_M`
as dwelled — i.e. a stop up to **2 m ahead** was removed from `nextUndwelledStop()` *and* from
the zero-speed braking constraints. If geometry loaded while a tram sat 1 m before a stop (or the
feed said `at_stop`), the sim marked that stop complete and **accelerated straight through it**;
the UI even showed the *following* stop as "next". (codex finding #4.)

**Decision.** `seedStopState` (`tramSim.ts:203`) marks a stop served only when it is
**unambiguously behind**:
- strictly behind by more than `STOP_BEHIND_EPS_M = 0.5 m`, **or**
- at/before the feed's `lastStopSequence` when that sequence matches the geometry —
  never the *forward* reach tolerance.

If the sim starts **at** a stop (feed `at_stop` within `AT_STOP_MATCH_M = 50 m`, or an unmarked
stop within `STOP_REACH_M = 2 m` of the spawn), it **begins a dwell there** instead of skipping:
remaining dwell = scheduled departure (+ delay); if that already passed and the feed reports
`at_stop`, fall back to the default dwell; else treat as served (`:255-264`). Tests: "spawning
near a stop (dwell seeding)" (`:541`) — three cases: 1 m before → dwell, feed `at_stop` → dwell,
departure already passed → served-no-dwell.

**Dwell duration** (`dwellDurationMs` `:181`): feed value if > 0, else `DEFAULT_DWELL_S = 18 s`
± deterministic 0–8 s jitter hashed from `stopId` (deterministic → same tram dwells identically
across re-renders).

---

## 8. Terminal behavior

**Decision.** The last stop (or any `isTerminal`) → `phase = 'terminal'`, `v = 0`, held until
fresh trip data swaps geometry (`ingest`'s trip-change path re-anchors onto the new shape). A
tram that runs off the geometry end with no stops left also latches terminal. At stops, the
render layer plays a doors-open animation during the dwell (iteration 4).

### Terminal un-latch (calibration round 1, R2)

Terminal used to be an **absorbing** state: `tick()` pins `v = 0`, so a sim that sprinted to
the last stop *ahead of reality* sat there wrongly until the real tram arrived or the trip
swapped — sub-500 m errors never teleport. In the 2026-07-11 session this was the worst
per-mode error: 2.2% of records in `terminal` with signed sim−obs p50 **+324 m** (p90 560).

**Fix** (`applySnapshot`): while `phase === 'terminal'`, a **fresh** fix (new `observedAtMs`
or changed `shapeDistM`) whose projection lies more than `TERMINAL_UNLATCH_BEHIND_M = 150 m`
**behind** the latched position re-anchors the sim to the observation and resumes normal
simulation. This is a deliberate, bounded **backward teleport** — the one sanctioned break of
`sM` monotonicity besides the 500 m teleport. Why monotonicity is broken here: the pace
controller can never recover from a wrong terminal latch (v is pinned to 0 and reality is
*behind*, so no forward motion can reduce the error); un-latching forward is impossible by
definition. It renders as a teleport (`lastTeleportMs` opacity dip), not a visible reverse
drive. 150 m tolerance keeps genuine end-of-trip fix scatter (platform fixes slightly short
of the geometry end) latched. Tests: `tram-sim.test.ts` "terminal un-latch".

---

## 9. Car-following / queueing

**Problem.** Two trams on the same track must not overlap or pass through each other; a
follower must queue behind a dwelling/teleported leader.

**Decision** (`engine.ts:310 applyQueueConstraints`). Group sims by **`shapeId`** (only groups
of ≥ 2; `rebuildQueueGroups` `:281`, rebuilt lazily after `ingest`, so `tick` allocates nothing).
Within a group, sort ascending `sM` and walk leader → follower:

- **limit** = `leader.sM − leader.lengthM − QUEUE_GAP_M` (`QUEUE_GAP_M = 3 m`). `lengthM`
  includes any coupled trailer (`COUPLED_TRAILER_OFFSET_M = 14.5 m`), so a follower reserves the
  *physical* tail of the set ahead.
- **inside the buffer** (`gap ≤ 0`): clamp `sM` to the limit, cap speed to the leader's — the
  follower parks behind a dwelling leader and departs only after it clears.
- **approaching** (`gap > 0`): cap speed to `leader.vMs + sqrt(2·A_BRK·gap)` so followers
  decelerate smoothly instead of slamming into the buffer.

Runs **after** all position updates each tick (and inside `ingest`, since a teleport can drop a
leader onto a follower), so a dwelling leader compresses the whole queue in one pass regardless
of iteration order (`:277`, `:257`).

**Why grouped by `shapeId`, not by line/route.** Opposite directions and route variants have
**different** shapeIds and (usually) share no rail — blanket-constraining them would freeze a
tram behind a tram on the *other* track. Cross-shape sharing is handled by the targeted
mechanism below instead. Coupled-set length uses the `defaultIsCoupled` heuristic
(`engine.ts`): `runsCoupled` models on numeric day lines 1–26 excluding 23 (night lines queue
at single-car spacing — `engine-queue.test.ts`).

### Cross-shape car-following (field feedback #6, 2026-07-13)

**Problem.** In the centre several LINES share one street and one physical track with
**different** shapeIds — the per-shape queue could not see them, and trams of different lines
drove through each other.

**Decision** (`engine.ts rebuildCrossPairs/applyCrossPairs`). Candidate **pairs** are
discovered on **ingest only** (performance invariant #8 — the tick allocates nothing):
sims are grid-bucketed by world position (`CROSS_GRID_CELL_M = 150`), and a pair within a
bucket (or forward-neighbor bucket) qualifies when it is on **different shapes**, within
`CROSS_CANDIDATE_RADIUS_M = 120` (covers the worst closing speed over a 5 s poll), travelling
the **same way** (`Δbearing ≤ CROSS_BEARING_MAX_DEG = 12°` — opposite/branching directions
never couple), and one sim's position projects onto the other's shape within
`CROSS_LATERAL_MAX_M = 2` (same physical rail; adjacent parallel tracks are ~3 m away).
The projection also yields a per-pair **along-shape offset** mapping the leader's `s` into
the follower's shape coordinates. Pairs are applied inside `ingest` too, so a teleport/reseed
landing on another line's tail is resolved immediately.

### Cross-pairs BRAKE ONLY — never rewrite the follower's position (build-20 regression, 2026-07-17)

**What broke.** `applyCrossPairs` originally used the *same* clamp as the same-shape queue:
inside the buffer (`gap ≤ 0`) it set `follower.sM = max(0, limit)`. But `limit` is derived
from the leader's `s` **translated through the build-time `offsetM`** — a mapping valid only
where the two rails physically coincide. When the leader passed a junction/divergence,
`leader.sM + offsetM` mapped to a **garbage point** on the follower's shape; the clamp then
**teleported the follower backward / off the drawn line and froze it at an angle** — reported
as "tram stands sideways off the route", *most often mid-route in the dense centre* where
false pairs are common (crossings, parallel rails, momentary bearing alignment). It was a
regression from the cross-shape queue landing in build 20.

**Fix.** Cross-pairs now **only cap speed, never write `sM`** (`applyCrossPairs`): `gap ≤ 0`
→ `follower.vMs = min(follower.vMs, leader.vMs)`; approaching → the same
`leader.vMs + √(2·A_BRK·gap)` envelope. The follower decelerates and, if genuinely blocked,
stops **on its own shape** — it can never be thrown off-route. Three guards make false pairs
rare and harmless:
- **Tighter gates** (above): lateral `4 → 2 m`, bearing `25 → 12°`. Only a truly shared rail,
  truly same direction, qualifies.
- **Staleness drop** (`CROSS_PAIR_STALE_ADVANCE_M = 30`): a pair is skipped once its leader has
  advanced > 30 m past the point where lateral alignment was verified (the rails may have
  diverged since). Cheap O(1)/zero-alloc vs. re-projecting each tick (invariant #8); a fresh
  ingest re-discovers still-valid pairs with a new projection every 5 s. Small because a
  freshly-built pair was just verified, and a slow/dwelling leader (the case a follower must
  actually brake for) never advances 30 m within a poll.

**Accepted trade-off.** Brake-only holds a *following distance* rather than a hard clamp, so
over a long same-rail pin the `QUEUE_GAP_M` buffer can slowly erode (the follower ratchets
closer over accel/decel cycles) — but it **never overtakes and never teleports**. This is far
better than the off-route teleport it replaces; the same-shape queue (where `limit` is always
a valid on-rail position) keeps its hard clamp.

**Live projections queue too.** `projSim`s get their own same-shape groups and cross-pairs
(same brake-only rule for cross): what live mode renders must not drive through the tram ahead
either. Known bound: pairs refresh on the 5 s poll, so a tram closing more than the candidate
radius between two polls could briefly miss its pair — impossible at tram speeds (≤ ~70 m per
poll). Tests: `engine-queue.test.ts` "cross-shape car-following (brake-only …)" — (а) brakes
without overtaking or backward-teleport, (б) freed once the leader passes a divergence,
(в) adjacent parallel track (>2 m) is not coupled, plus the same-direction/opposite-direction
and live-projection cases.

### Junction conflict yield — crossing shapes separate in TIME (2026-07-19)

**Problem.** The cross-shape pairs above deliberately couple only *same-direction* trams
(Δbearing ≤ 12°, lateral ≤ 2 m). At complex junctions, trams on **crossing** shapes
(different bearings) therefore drove visually **through each other's sides** — and stitching
crossing lines into a car-following queue would be wrong (they share a point, not a rail).

**Decision** (`engine.ts findJunctionConflict/applyJunctionPairs`). A third, speed-only
mechanism:

- **Discovery (ingest only, invariant #8).** Candidate pairs come out of the same grid-bucket
  sweep as cross-pairs; a pair whose current Δbearing is in `(12°, 155°]` is probed for a
  **crossing point**: sample one tram's shape from `sM − lengthM` to `sM +
  JUNCTION_LOOKAHEAD_M = 80` every 10 m, project each sample onto the other shape; a sample
  within `JUNCTION_LATERAL_M = 6 m` whose **at-point** crossing angle is in
  `[JUNCTION_MIN_ANGLE_DEG = 25°, JUNCTION_MAX_ANGLE_DEG = 155°]` is the conflict point
  (`sConfA` on A / `sConfB` on B). Anti-parallel pairs (> 155° — the opposite-direction
  shared street) never qualify; merges/diverges (< 25°) belong to the same-rail cross-pairs.
  Unlike a cross-pair's offset mapping, the conflict point is a **fixed geometric property
  of the two shapes** — it cannot go stale as the trams move, so no staleness guard needed.
- **Per-tick application (O(1)/pair, zero alloc).** While neither tram's tail has cleared its
  conflict point (+`JUNCTION_CLEAR_M = 3 m`): the tram **closer** to (or already inside) the
  `JUNCTION_ZONE_M = 12 m` conflict zone proceeds; the other **yields** — a
  braking-envelope speed cap toward a hold point `JUNCTION_ZONE_M` short of the crossing,
  mirrored into `tramSim.yieldHoldM` so the next tick's `vTarget` brakes toward the same
  point (no per-tick creep past the hold). **Strictly speed-only**: a yielder's `sM` is
  never rewritten — there is no teleport class here at all; the trams cross **in sequence**.
  Holds are re-derived from scratch every constraint pass, so a cleared crossing releases
  within one tick. Escapes: a priority tram *standing* outside the zone (dwelling/stuck
  short of the junction) blocks nobody; both-already-inside pairs are left to roll apart
  (braking a frozen overlap in place would be worse).
- **Projections too** — `projJunctionPairs`, same conflict points (shape properties).

### Switch/junction slow-down — contested crossings are passed moderately (2026-07-19)

Realism heuristic, deliberately conservative until measured: real trams take switches and
complex crossings noticeably slowly. Detecting switches from a single shape is not possible,
so the **proxy is the discovered junction conflict point** (above): while a junction pair is
active, **both** trams (priority and yielder alike) are capped at `SWITCH_SLOW_V_MS = 6.0
m/s` (~22 km/h) within `SWITCH_SLOW_RADIUS_M = 25 m` of the conflict point — approached on
the smooth braking envelope (`capSwitchSpeed`, no instantaneous drop; composes with the
no-speed-extremes contract of §6). A lone tram at an empty junction keeps only the curve
caps (`CURVE_SLOW_FACTOR`, §2). **Tunable — calibrate both constants against real ride
recordings** (`gpsSpeed` over junctions). Tests: `engine-junction.test.ts` (in-sequence
crossing, zone hold, standstill escape, no false yields at distance, moderate pass speed).

### Same-shape back-clamp fade (`QUEUE_BACK_FADE_M = 5`)

The same-shape queue *does* clamp `follower.sM` back to `limit` (always a valid on-rail point).
A back-clamp larger than `QUEUE_BACK_FADE_M = 5 m` now stamps `follower.lastTeleportMs` so the
renderer dips opacity (a teleport fade) instead of showing a visible reverse slide — the same
convention as the other sanctioned backward corrections (stuck-hold, terminal un-latch).

---

## 10. Teleport rules

**Decision.** `applySnapshot` hard-teleports only when the **projected
observation** disagrees with the sim by more than `TELEPORT_THRESHOLD_M = 500 m`. Then: snap
`sM` to `sObs`, `v = 0`, reset to cruise, rebuild dwell memory (`seedStopState`), stamp
`lastTeleportMs` (renderer dips opacity ~300 ms). The learned `paceBias` is **kept** (round 1:
same vehicle, same driver) and the teleporting fix is excluded from pace calibration (the
jump is a re-anchor artifact, not motion). Errors **under** 500 m are absorbed by the
pace controller — no jump (except the terminal un-latch, §8).

**Why 500 m / why the observation not the timetable.** Sub-500 m disagreements are normal poll
lag + prediction error and should converge smoothly. Above 500 m the sim is on the wrong block
(bad shape match, long GPS dropout, trip mismatch) — teleporting to the paper *timetable* there
would compound the error, so the target is the projected **AVL observation**. Trip-change
re-anchoring (`engine.ts:210-227`) reuses this budget: keep smooth position only if the old
world point projects within `REANCHOR_MAX_OFFSET_M = 100 m` of the new shape **and** within 500 m
of the new target; else `createSim` fresh. Tests: "teleport on large observation error" (`:416`).

### 10.1 Gap-aware threshold + physical advance cap (2026-07-27 feed degradation)

**Problem (measured live).** The 500 m constant assumes the calibrated fix cadence
(p50 ≈ 45 s). On 2026-07-27 Golemio delivered fixes **65–134 s apart fleet-wide**
(spot gaps to 250 s), in which time a tram honestly covers 600–950 m — so nearly
every fix tripped the flat threshold and the whole fleet hard-snapped several
times a minute, forward (dwell-pinned sims falling behind) **and backward**
(schedule-projected anchors overshooting stalled reality, then collapsing on the
next fix; the same car measured +1035 m then −537 m minutes apart). User-visible
as "trams randomly jerk backward while moving".

**Decision — two coupled changes (`tramSim.ts`):**
1. `teleportThresholdM(fixGapS)` — the ingest threshold scales with the observed
   gap between consecutive fixes at cruise-reference pace with margin
   (`gap × V_CRUISE_REF_MS × 1.25`), clamped to `[45 s, 240 s]` of gap and capped
   at `TELEPORT_THRESHOLD_MAX_M = 1500` (beyond that it is desync no matter the
   gap). A teleport now means *desync*, not *slow feed*; everything under the
   threshold converges through the existing catch-up/crawl regimes.
2. `maxAdvanceM(fixAgeS) = fixAgeS × V_CRUISE_REF_MS` — the schedule-pace
   forward projection of a stale fix (`observedDistAt` / `targetDistAt`) is
   bounded by what the real tram could physically have driven since the fix.
   An uncapped anchor racing a fast timetable while reality stalls is what
   manufactured the backward half of the oscillation.

**Effect (measured, same feed conditions):** steady-state teleports fell from
~12–15/min fleet-wide to ~1–2/min, and **backward teleports to zero**; the
remainder are honest catch-ups after genuinely large gaps. Tests: the gap-aware
block in "teleport on large observation error" (tram-sim) pins the formula, the
no-teleport-at-90 s-gap case, the true-desync case, and the advance cap
invariant; two engine-queue fixtures were raised over the new floor since their
subject is the post-teleport queue behavior itself.

---

## 11. Dual-sim: smooth mode vs live projection (`projSim`)

**Problem.** Some users want honest "where was it last actually seen" (accepting jumpy fixes);
others want smooth motion. Both must be available without re-deriving physics twice differently.

**Decision — two independent sims per tram** (`engine.ts:67 Entry`):

- **main `sim`** — the smoothed, trail-biased, **queue-constrained** position. Feeds
  `simDistM`/`position`/`bearing`. This is "Smooth" mode.
- **`projSim`** — a dead-reckoning sim **re-seeded at the raw fix** whenever a *genuinely new*
  observation arrives (new `observedAtMs` **or** new `shapeDistM`, or trip/shape change), then
  advanced between polls by the **same** physics (speed profile, stops, dwells) at the
  vehicle's **learned pace**. Feeds `projectedObservedDistM`. This is "Live" mode.

### Projection pace redesign (R11 fix, field feedback 2026-07-13)

**What was wrong.** The projSim used the same `tick()` controller as the main sim — i.e. it
*chased* `targetDistAt` (the schedule-projected observation blend **minus `TRAIL_M`**) with
the pace factor and crawl regime. Despite the old note here claiming "not trail-biased", the
live rendering therefore carried the 10 m trail bias and a systematic **schedule-pace drag**
between fixes — calibration R11 measured it as `prev=on_track` at-fix signed ≈ −41…−46 m
with slope +4.1…+4.8 m per ΔdelayS-second (10+ reproductions, "designed drag"). This is the
mode the user rides with, and the drag is visible from inside the real tram.

**Decision.** Projection sims (`TramSim.projection = true`, set by `TramEngine` for projSims
only) do **not** chase any target: no `targetDistAt`, no `TRAIL_M`, no pace factor, no crawl
latch. Each tick they cruise at `min(vAllowed, min(cruiseCap, V_CRUISE_REF_MS) · paceBias ·
todPaceFactor)` — honest dead-reckoning of the last fix at the pace this vehicle has actually
been driving, under the same braking envelope, stops and (fixed) dwells. The observation-
pinned holds (§14) apply to projections too. Tests: `engine-realism.test.ts` "live projection
pace" (advances at learned pace when the schedule sprints at 20 m/s; never crawls when the
schedule lags).

**Why re-seed only on a new fix.** Between identical polls `projSim` integrates smoothly (no
snapping to a re-projection); when a fresh fix lands it **jumps** to it — forward or backward.
That jump is the *accepted* live-mode UX: it shows the true correction the AVL feed just
reported. Tests `engine-projection.test.ts`: seeds at the fix and advances smoothly,
jumps back / forward, does **not** re-seed on a repeated stale fix,
dwells at stops with the same physics. `projectedObservedDistM` falls back to the
schedule-pace `observedDistAt` only if `projSim` is somehow absent (normally unused).

---

## 12. Deviation metrics

**Decision.** `toPublicState` (`engine.ts:353`) exposes, per tram:
- `observedPosition`/`observedBearing` — the last raw AVL `shapeDistM` placed on the shape,
  **not** projected forward in time (honest "last fix", `:385`, `:395`).
- `deviationM = |sim.sM − observedDistM|` — how far the smoothed sim currently sits from that
  raw fix. Surfaced in the tram sheet as sim-vs-fix deviation + sync age.
- Without geometry: `deviationM = null`, position falls back to raw feed coordinates,
  `hasGeometry = false`, `phase = 'unknown'` (`:357-379`).

`deviationM` is the honest quality signal — large or growing deviation means the smoothing is
fighting the feed; the "Live" toggle lets the user see the raw fix directly.

---

## 13. Adaptive dwell synchronization — stop dwells as the primary error corrector

**Problem.** The pace controller corrects tracking error *mid-segment*, where corrections are
visible: a sim that ran ahead crawls at 1 m/s down an open street, a late one sprints — both
read as unnatural speed manipulation. Stops are the one place where holding still or leaving
promptly *is* the natural behavior: dwell time already varies with boarding in reality.

**Decision.** Use stop dwells as the primary error-correction mechanism, keyed off the same
error the pace controller uses, `e = targetDistAt(now) − s` (observation-primary blend −
`TRAIL_M`). Applied **only** to the main smooth-mode sim via `createSim(..., { adaptiveDwell:
true })` (`tramSim.ts CreateSimOptions`); `TramEngine` sets it on main sims only. **projSims
are never adaptive** — they dead-reckon the raw fix and must mirror reality with fixed dwells
(`engine.ts`, projSim creation). Bare `createSim` defaults to off.

**How** (`tramSim.ts tick()`):

- **Sim AHEAD at a stop (`e ≤ −DWELL_EXTEND_RELEASE_M` when the base dwell expires):** keep
  dwelling — "boarding takes longer". Re-evaluated **every tick**, so a fresh fix that closes
  the gap releases it immediately; hard-capped at base dwell + `DWELL_MAX_EXTEND_S = 75 s`.
  `phase` stays `'dwell'` throughout (doors-open rendering keys off it).
- **Sim BEHIND at arrival (`e > 0`):** base dwell scaled by
  `clamp(1 − e/DWELL_SHORTEN_GAIN_M, 0, 1)` — the real tram already spent part of its dwell
  here — floored at `DWELL_MIN_S = 4 s` (no 1-s door blinks).
- **Badly behind (`e > DWELL_SKIP_ERR_M = 60 m`):** skip the dwell entirely — the real tram
  already left. The stop is marked served (`dwelledStopSeqs` + `minStopDist`, so it neither
  re-triggers nor pins the envelope) and the sim rolls through the stop zone at ≤
  `DWELL_SKIP_ROLL_V_MS = 4 m/s`. The decision fires only once the stop is within
  `DWELL_SKIP_ZONE_M = v²/(2·A_BRK) ≈ 6.7 m` — the braking envelope has already brought the
  sim to ≤ the roll cap there, so releasing the stop's 0-limit never violates the envelope.
  `phase` never enters `'dwell'` (doors stay closed — correct, the real tram is gone).
  Terminal stops are never skipped.

**Composition.** The crawl/catch-up pace controller still owns mid-segment error; adaptive
dwell owns error at stops. The car-following clamp (`engine.ts applyQueueConstraints`) runs
after all sim ticks and **still wins**: a follower can neither depart into nor pass through a
leader held in an extended dwell (test "a follower never overlaps a leader held in an
extended dwell"). `s` stays monotonic in all three branches. Tests: `tram-sim.test.ts`
"adaptive dwell" — extension until a fresh fix / cap at 75 s / non-adaptive contrast /
skip-roll-through / proportional shortening / 4 s floor / queue invariant.

| constant | value | role |
|---|---|---|
| `DWELL_MAX_EXTEND_S` | 75 s | max hold past the base dwell |
| `DWELL_EXTEND_RELEASE_M` | 8 m | extended dwell releases once e > −8 m |
| `DWELL_SHORTEN_GAIN_M` | 80 m | behind-dwell factor = clamp(1 − e/80, 0, 1) |
| `DWELL_SKIP_ERR_M` | 60 m | behind-error that skips the dwell entirely |
| `DWELL_MIN_S` | 4 s | minimum visible dwell when stopping at all |
| `DWELL_SKIP_ROLL_V_MS` | 4 m/s | roll cap through a skipped stop's zone |
| `DWELL_SKIP_ZONE_M` | ≈ 6.7 m | skip-decision window / roll-zone half-width |

---

## 14. Observation-pinned holds — stop-hold & stuck-hold (field feedback, 2026-07-13)

Real-tram ride sessions surfaced two classes of phantom motion, both caused by trusting a
*projection* over a *contradicting fix*:

### Stop-hold (`fixPinsDwell`, tramSim.ts) — never depart ahead of an at-stop fix

**Problem.** A fresh fix showed the tram standing at a stop, but the schedule/projected
target had moved on — the sim departed while the real tram (with the rider inside) was still
boarding.

**Decision.** When a dwell's base duration expires, the dwell **keeps holding** while the
latest fix still pins the tram at the stop: fix within `[−STOP_HOLD_AHEAD_EPS_M,
+STOP_HOLD_NEAR_BEHIND_M]` of the dwell position (or explicit `at_stop` within
`AT_STOP_MATCH_M`), **and** the fix has not advanced more than `STOP_HOLD_MOVE_EPS_M` past
the fix seen at dwell entry (`dwellObsDistM`), **and** the fix is younger than
`STOP_HOLD_MAX_FIX_AGE_S = 45 s` **on the latency-aware clock** (below). Release triggers: a
fresh fix that **moved** (departure evidence — released within a tick), or fix **staleness**
(the feed's cadence is ~45 s p50; a tram that left right after its last fix shows a moving
fix within ~one cadence, so past the bound an unseen departure is likelier than a record
dwell — the bounded compromise, never an eternal wait). Applies to **all** sims — main and
projections (both render modes had the early-departure bug). Fresh at-stop fixes re-arm the
hold indefinitely: that is reality.

### Latency-aware effective fix age (R12, first ground-truth ride 2026-07-20)

**Problem.** `obsAt` is not the instant the tram was at `obsDist`. The rider recording
(`docs/calibration/analysis-2026-07-20-ride.md` §2) shows the raw fix trails reality by
**+77 m at an apparent age of 0–15 s** — i.e. ≈ 8–14 s of hidden pipeline latency (poll +
AVL processing) **beyond `obsAt`**, at the ~5 m/s real pace. The feed keeps reporting
`at_stop` for 50–75 s while the real platform dwell is 15–20 s, so a staleness clock run on
the *apparent* age pinned the sim at stops long after the real departure (worst observed
**−374 m**, the ride's single largest behind-mass; sim glued to a stale fix for 95 s vs a
15 s real dwell).

**Decision.** Every "is this fix too stale to still be a stand?" check runs on the **true**
age `staleFixAgeMs = (now − obsAt) + FEED_LATENCY_S` (`tramSim.ts`), used by both
`fixPinActive` (the arrival-pin projection freeze / target cap) and `fixPinsDwell` (the
dwell hold). A stale at-stop hold therefore releases `FEED_LATENCY_S` **earlier** than its
apparent age — the tram departs the phantom-held stop sooner and the following inter-stop
run starts from a smaller deficit. **`STOP_HOLD_MAX_FIX_AGE_S` is unchanged (45 s = one fix
cadence p50)** — this corrects the age *measurement* it is compared against, not the
cadence constant; the effective wall release lands at ~42 s, still within one cadence (not
the sub-cadence 35–40 s hold the analysis defers pending ≥2 rides). `FEED_LATENCY_S = 3 s`
is a **shrunk half-step** from the shipped 0 toward the ride-replay optimum (~5–8 s), well
under the measured 8–14 s — **tunable, recalibrate on future ride recordings.**

Gate: **ride replay** (`ride_replay.py`, scored vs the rider GPS) mean |err| **135 → 124 m
(−8 %)**, p90 266 → 257 (dispersion improves — the behind-tail shrinks), signed −94 → −81;
**fleet replay** (`replay.py`, session-2026-07-11) **bit-identical** (median 124.9 — the
hold bound never binds at fleet cadence, verified identical across 35–45 s, the same
neutrality the STOP_HOLD 60→45 change had). The projection-forward variant (adding the
latency to the schedule-pace dead-reckoning) was rejected: it cut the signed bias but
inflated the ride's ahead-tail and grew the fleet at-fix median (it scores against lagged
fixes, so any forward compensation reads as "more ahead") — the stale-hold release attacks
the same bias where the error is actually born. Tests: `engine-realism.test.ts`
"latency-aware release … without jitter".

### Arrival-fix anchor (`updateFixStopPin`, tramSim.ts) — a fix AT a stop never overshoots it (2026-07-19)

**Problem.** The stop-hold above only guards a dwell that already *started*. The arrival
side was still broken: a fresh fix showed the tram **standing at a stop** while the sim was
still approaching — and because the schedule ran slightly late, `observedDistAt` projected
the at-stop fix *forward at schedule pace* and the target already lay **past** the platform.
The sim then accelerated by the stop (adaptive dwell shortened or skipped it — `e > 0`)
while the real tram stood boarding: "до апдейта ещё ехал к остановке, после апдейта уже
уехал с неё".

**Decision.** A fresh fix that pins the tram AT a stop is **authoritative** (`fixStopDistM`):

- **Detection** (`detectFixStop`): explicit `statePosition === 'at_stop'` (feed-declared
  stop via `lastStopSequence`, else nearest platform within `AT_STOP_MATCH_M = 50 m` of the
  fix), **or** positional — the fix rests within `FIX_AT_STOP_TOL_M = 20 m` of a platform
  *and* has advanced ≤ `STOP_HOLD_MOVE_EPS_M = 8 m` since the previous fix (standing
  evidence; a tram sweeping past a platform shows a large inter-fix advance and is never
  pinned). The positional branch closes the `STUCK_NEAR_STOP_M` hole where platform stands
  were suppressed from stuck-holds but nothing else owned them.
- **While pinned & fresh** (same latency-aware `STOP_HOLD_MAX_FIX_AGE_S = 45 s` staleness
  bound as the stop-hold — `fixPinActive` uses `staleFixAgeMs`, R12): the observation is
  **not** projected forward at schedule pace
  (`observedDistAt`), and `targetDistAt` is **capped at the platform** — a late timetable
  can never drag the sim beyond a stop the fix holds it at; the adaptive shorten/skip paths
  see `e ≤ 0` there and never trim the dwell.
- **Snap-to-platform**: a sim caught still approaching (`stop.distM − sM > STOP_REACH_M`)
  is snapped **onto** the platform into a dwell (dwell end = scheduled departure if still
  ahead, else the default dwell; the stop-hold then keeps it standing until the fix moves or
  goes stale). Forward-only — `sM` stays monotonic; jumps > `FIX_STOP_SNAP_FADE_M = 25 m`
  render as a teleport fade. Sims already at/past the platform are left alone
  (dwell/fix-hold/soft-yield own those).
- **Both render modes**: `createSim` derives the pin from an explicit at_stop state (so new
  sims and **projSim reseeds** spawn *dwelling at the platform* instead of dead-reckoning
  past it at cruise pace); `TramEngine` passes the main sim's live pin into every projSim
  reseed. Release is only by fix movement (> 8 m) or staleness — mirroring reality.

Tests: `tram-sim.test.ts` "arrival-fix anchor" (at_stop snap + no overshoot + capped
target, positional two-fix pin, live-projection stand).

### Stuck-hold (`updateStuckHold`, tramSim.ts) — jams are not schedule progress

**Problem.** Two+ genuinely new fixes at the same mid-segment point mean the tram is
physically stuck (light/jam/incident). The sim kept creeping forward at target pace.

**Decision.** On a fresh fix whose position matches the previous fix within
`STUCK_FIX_EPS_M = 8 m` (with `observedAtMs` advanced — a repeated *poll* is not evidence),
set `stuckAtM` to the fix: `tick()` clamps `vTarget` to the braking envelope toward that
point (0 past it) — the sim brakes to a stand **at the fix** and holds. Suppressed within
`STUCK_NEAR_STOP_M = 40 m` of a stop or on `at_stop` state (dwell + stop-hold own platform
stands). Released **only by a moving fix** (> 8 m — per the field requirement), after which
the normal pace controller performs the soft catch-up; projections jump at their reseed.
Stuck fixes never pollute `paceBias` (`Δs < PACE_BIAS_MIN_DS_M` skips them). The main sim's
`stuckAtM` carries into projSim reseeds so live mode stands still too instead of driving off
and snapping back every poll.

---

## 15. Mid-segment cruise seeding & motion-profile redistribution (field feedback #2/#4)

### Seed speed (`seedCruiseSpeed`, tramSim.ts)

A sim (re)created **between stops** — new vehicle, trip change, hard teleport, projSim
reseed — used to start at `v = 0` and visibly "accelerate out of nowhere". A tram observed
mid-segment is *already moving*: seed `vMs = min(vAllowedAt, min(cruiseCap, V_CRUISE_REF_MS)
· paceBias · todPaceFactor)` — its own cruise pace, bounded by the braking envelope (a seed
10 m short of a stop starts at the envelope value, not cruise). Sims seeded into a
dwell/terminal or pinned by a stuck fix stay at 0.

### Motion profile (speedProfile.ts / tramSim.ts)

Real trams move *bolder* than the calibrated average suggests: brisk stop exits, later and
harder braking — the average is dragged down by dwells and traffic lights, not by gentle
driving. Redistribution, without touching the calibrated average pace (`paceBias` learning
and its `V_CRUISE_REF_MS` expectation basis are unchanged):

- **`A_ACC` 1.0 → 1.3 m/s², `A_BRK` 1.2 → 1.4 m/s²** — bolder acceleration; braking onset
  moves closer to the stop automatically (the envelope derives from `A_BRK`). Both remain
  inside vehicle service capability. `DWELL_SKIP_ZONE_M` shrinks accordingly (derived).
- **Departure burst** (`DEPART_BURST_FACTOR = 1.25` over `DEPART_BURST_DIST_M = 150 m`):
  on dwell release the cruise product is boosted ×1.25 until 150 m past the stop. The debt
  this builds against the pace target (~−20 m) is repaid where it is least visible — at the
  next stop, via the adaptive-dwell extension ("boarding takes longer") — so stop-to-stop
  timing stays target-locked. **Main smooth-mode sims only** (`adaptiveDwell` gates it):
  projections must mirror the real average pace and have no dwell-extension compensator.

Replay gate (2026-07-13 session, 64 MB extract, 362 trams): seed+profile alone is **neutral**
(R60 ≡ NEW on every metric); adding stuck-hold (R62 = shipped set) trades median |at-fix err|
137 → 142 m (+3.6%) for **halving the signed ahead-bias** (+60 → +31, toward the logged
device-session reality of −38) and improving devM p50 224 → 203 (−9%) — the accepted cost of
holding honest during a jam with a ~45 s fix cadence (the at-fix metric penalizes the hold at
the first post-jam fix by construction). See `analysis-2026-07-13.md` realism-wave note.

---

## 16. Bearing robustness (field feedback #7)

- **Folded-window guard** (`bearingAt`, geo/polyline.ts): the ±2 m averaging window at a
  terminal-loop / switchback apex spans both legs — its chord points ACROSS the fold
  (perpendicular trams, typically where trams cluster). If the chord is shorter than
  `0.9 ×` the along-shape window, fall back to the nearest non-degenerate **segment**
  direction (always along the rails; even a 5 m-radius curve keeps chord/arc ≥ 0.97, so
  legitimate bends never trip the guard).
- **Movement-derived fallback bearing** (`Entry.fallbackBearing: number | null`, engine.ts):
  trams without geometry used the feed's instantaneous bearing — garbage at v≈0 (perpendicular
  spawns). The engine now adopts a bearing **only** from raw-position movement ≥ 10 m and holds
  the last good value while standing. `fallbackBearing` starts **`null`** (not the feed bearing)
  and the feed's instantaneous AVL bearing is **never** adopted, not even at entry creation —
  at v≈0 there is simply no orientation, and `toPublicState` reports `bearing: 0`. This is safe
  because a geometry-less tram now renders as an **un-oriented dot** (no 3D body, no rotated
  teardrop — see map-rendering.md §8), so a missing heading has no visual consequence.

### Geometry-less trams render as a bare dot (build-20 hardening, 2026-07-17)

A tram with no loaded shape (`hasGeometry: false` — trip just changed at an endpoint, or the
shape is still streaming in) is a **short-lived transient**. It is rendered as a single
**un-oriented dot at the raw GPS position** — no articulated 3D body, no perpendicular
`TRACK_OFFSET`, no bearing rotation. The old fallback drew a full body along the unreliable
raw bearing, standing the tram at an angle off the network (sometimes inside buildings). The
transient is shortened by fetching the new trip's geometry at **raised priority** on a trip
change: `TramRuntime.onSnapshots` (`src/hooks/tramData.ts`) diffs each key's `tripId` against
the previous poll and calls `feed.requestGeometry(changedTrips, 1)` (vs. the background `2`
warm for brand-new trams), returning the tram to the drawn line within 1–2 polls. Render
contract details in `docs/decisions/map-rendering.md` §8.

### Red-dot hardening (2026-07-18) — visible-first warm-up + geometry-landed re-ingest

Field report: trams sometimes sat as a **motionless dot** until tapped. Cause chain: a
geometry-less tram renders at its raw fix (moves only on the 5 s poll); ALL missing shapes
were warmed at background priority `2`, so in dense frames a visible tram could wait out a
long scheduler queue (16 starts/8 s); tapping promoted the trip to `0`, loaded the shape,
and the tram "came alive" — so the tap looked like the trigger. Three fixes, all in
`tramData.ts` / `shapeCache.ts` (rate-limit contract untouched):

- **Visible-first priority.** `onSnapshots` reads the map's viewport (provider registered
  by `TramLayers`; read once per poll, never per frame) and splits missing shapes:
  on-screen (+500 m margin) → priority `1`, off-screen → `2`. Trip changes stay at `1`,
  taps at `0`. `shapeCache.requestPrefetch` now also **promotes an already-queued waiter**
  (`promoteTag`) when re-requested at a higher priority, so a background-warmed tram that
  scrolls into view jumps the queue on the next poll.
- **Geometry-landed re-ingest.** `shapeCache` announces every geometry that lands
  (`subscribeLoaded` → optional `TramFeed.subscribeGeometry`); the runtime debounces the
  bursts (`GEOMETRY_ADOPT_DEBOUNCE_MS = 300`) into one extra `ingest`, so the sim appears
  ≤ ~0.3 s after the shape arrives — **without a tap and without waiting for the next
  poll**. The 2.5 s post-poll nudge remains as the fallback for feeds without the event.
- **Loading look.** The dot renders as a line-colored "loading roundel" with the line
  number, not an alarming solid red marker (map-rendering.md §8).

Tests: `tram-feed.test.ts` (visible > background priority, no-tap revival, burst
coalescing), `shape-cache-promote.test.ts` (waiter promotion, loaded notifications).

### Red-dot RECURRENCE (2026-07-18, same day) — why the fix above wasn't enough

The dots came back in the field. Three compounding causes, all in the queue/cache
layer (the visible-first split and the geometry-landed re-ingest above were working
as designed — they were being *starved*):

1. **Scheduler aging inverted every priority.** Anti-starvation aging bumped ANY
   waiter with priority ≥ 1 up one level per 30 s window with no floor. A
   cold-start backlog (hundreds of background geometry waiters draining at ~2/s
   for minutes) marched 2→1→0 within two windows; at priority 0 their older `seq`
   won every tie — against fresh visible-lane requests, against taps, and against
   the 5 s poll itself. Fix: `AGING_FLOOR = 1` — aging never enters the urgent
   lane (`client.ts`).
2. **Priority was assigned once, at enqueue, under whatever bbox was current.**
   At the initial zoom (13.8) the bbox covers most of the network, so on a cold
   start essentially the WHOLE fleet classified "visible" → one giant FIFO lane;
   zooming in later couldn't reorder it (a re-request only *promoted*, never
   *demoted*). Fix: the per-poll warm-up now re-asserts the split in BOTH
   directions — `requestPrefetch` demotes a queued waiter re-requested at
   background (`demoteTag`, never urgent waiters) — and the visible lane is
   enqueued **nearest-to-viewport-center first** (`orderByViewportProximity`,
   once per poll). The queue continuously tracks what is on screen NOW.
3. **Cold starts were the daily norm.** The disk cache TTL (24 h) expired between
   daily sessions although trip_ids live ~12 days and reads are service-day
   re-anchored — so every morning was a whole-fleet burst against 16 starts/8 s.
   Fix: TTL → 3 days; a returning user re-opens on a warm cache and the burst
   path becomes the exception again.

Also hardened: `TramRuntime` keeps the **last known viewport** as a fallback for
provider gaps (map-layer effect remounts previously degraded a poll to
"everything background"), and the post-poll nudge timer no longer leaks when
overwritten. Rate-limit contract untouched (16 starts/8 s, 4 concurrent).

Tests: `golemio-client.test.ts` (aging floor: a 2-window-old backlog never
starves an urgent poll; demotion ordering; urgent never demoted),
`shape-cache-promote.test.ts` (background re-request demotes; one fetch per trip
across re-polled bursts), `tram-feed.test.ts` (nearest-first burst ordering,
last-viewport fallback, per-poll re-assertion of the split).

---

## Tuning constants (single source of truth: the code)

| constant | value | file | role |
|---|---|---|---|
| `A_LAT` | 0.98 m/s² | speedProfile.ts | curve cap lateral accel |
| `CURVE_SLOW_FACTOR` | 0.85 | speedProfile.ts | curve-cap scaling (§2 heuristic 2026-07-19, tune vs ride data) |
| `A_BRK` / `A_ACC` | 1.4 / 1.3 m/s² | speedProfile.ts | brake / accel clamps (realism wave 2026-07-13; were 1.2 / 1.0) |
| `AHEAD_SLOW_FACTOR` / `AHEAD_SLOW_MIN_V_MS` | 0.5 / 3.0 m/s | tramSim.ts | soft-yield band while ahead (§6, smooth wave 2026-07-19) |
| `DEEP_AHEAD_ENTER/EXIT_M` | 120 / 60 m | tramSim.ts | walking-backstop hysteresis (§6) |
| `FIX_AT_STOP_TOL_M` / `FIX_STOP_SNAP_FADE_M` | 20 / 25 m | tramSim.ts | arrival-fix pin: positional tolerance / snap fade (§14) |
| `JUNCTION_LOOKAHEAD_M` / `JUNCTION_LATERAL_M` | 80 / 6 m | engine.ts | junction conflict discovery (§9, 2026-07-19) |
| `JUNCTION_MIN/MAX_ANGLE_DEG` | 25° / 155° | engine.ts | genuine crossing-angle gate (§9) |
| `JUNCTION_ZONE_M` / `JUNCTION_CLEAR_M` | 12 / 3 m | engine.ts | conflict-zone hold point / tail-clear margin (§9) |
| `SWITCH_SLOW_V_MS` / `SWITCH_SLOW_RADIUS_M` | 6.0 m/s / 25 m | engine.ts | contested-junction pass cap (§9 heuristic, tune vs ride data) |
| `STOP_HOLD_MAX_FIX_AGE_S` | 45 s | tramSim.ts | fix-hold staleness release, one fix cadence (§14) |
| `FEED_LATENCY_S` | 3 s | tramSim.ts | latency-aware effective fix age: hold releases this earlier (§14, R12, tune vs ride data) |
| `STOP_HOLD_MOVE_EPS_M` | 8 m | tramSim.ts | fix advance past dwell-entry fix = departure evidence |
| `STOP_HOLD_NEAR_BEHIND_M` / `STOP_HOLD_AHEAD_EPS_M` | 30 / 8 m | tramSim.ts | "fix pins this stop" window |
| `STUCK_FIX_EPS_M` / `STUCK_NEAR_STOP_M` | 8 / 40 m | tramSim.ts | stuck detection / near-stop suppression (§14) |
| `DEPART_BURST_FACTOR` / `DEPART_BURST_DIST_M` | 1.25 / 150 m | tramSim.ts | departure burst (§15, main sims only) |
| `CROSS_CANDIDATE_RADIUS_M` | 120 m | engine.ts | cross-shape pair discovery radius (§9) |
| `CROSS_LATERAL_MAX_M` / `CROSS_BEARING_MAX_DEG` | 2 m / 12° | engine.ts | same-rail / same-direction gates — tightened, build-20 fix (§9) |
| `CROSS_PAIR_STALE_ADVANCE_M` | 30 m | engine.ts | drop a cross-pair once the leader advances this far past the verified point (§9) |
| `QUEUE_BACK_FADE_M` | 5 m | engine.ts | same-shape back-clamp beyond this → teleport fade (§9) |
| `V_MAX_MS` / `V_CENTER_MS` | 13.9 / 8.6 m/s | speedProfile.ts | zone caps (50 / 31 km/h) — envelope/hard limits |
| `V_CRUISE_REF_MS` | 11.7 m/s | speedProfile.ts | pace-controller cruise reference (42 km/h, round 1 R3) |
| `DEFAULT_LOOKAHEAD_M` | 400 m | speedProfile.ts | braking-envelope horizon |
| `OBS_BLEND_WEIGHT` | 0.75 | tramSim.ts | observation vs timetable weight |
| `TRAIL_M` | 10 m | tramSim.ts | ride-behind bias |
| `HARD_BRAKE_ENTER/EXIT_M` | 40 / 12 m | tramSim.ts | ahead-regime hysteresis band |
| `CRAWL_V_MS` | 1.0 m/s | tramSim.ts | DEEP-ahead walking backstop only (§6, smooth wave) |
| `CATCHUP/GENTLE_MAX_FACTOR` | 1.4 / 1.35 | tramSim.ts | pace ceilings (catch-up 1.5→1.4, smooth wave) |
| `MIN_PACE_FACTOR` / `PACE_GAIN_M` | 0.7 / 120 | tramSim.ts | pace floor (0.55→0.7, smooth wave) / gain |
| `PACE_BIAS_PRIOR` | 0.62 | tramSim.ts | fresh-vehicle paceBias prior (fleet median, round 1 R1) |
| `PACE_BIAS_HALF_LIFE_S` | 150 s | tramSim.ts | paceBias EWMA half-life |
| `PACE_BIAS_MIN/MAX_RATIO` | 0.4 / 1.6 | tramSim.ts | per-sample ratio clamp (and seed clamp) |
| `PACE_BIAS_MIN_DT_S` / `MIN_DS_M` | 8 s / 15 m | tramSim.ts | degenerate-sample floor |
| `TERMINAL_UNLATCH_BEHIND_M` | 150 m | tramSim.ts | terminal un-latch tolerance (round 1 R2) |
| `TELEPORT_THRESHOLD_M` | 500 m | tramSim.ts | hard-teleport floor — scaled by fix gap, see §10.1 |
| `DEFAULT_DWELL_S` | 18 s ±0–8 | tramSim.ts | fallback dwell |
| `QUEUE_GAP_M` | 3 m | engine.ts | follower clearance |
| `COUPLED_TRAILER_OFFSET_M` | 14.5 m | engine.ts | coupled-set extra length |
| `STALE_AFTER_MS` | 90 s | engine.ts | drop unseen trams |
| `PACE_BIAS_MEMORY_TTL_MS` | 15 min | engine.ts | per-key learned-bias memory lifetime (round 1 R1) |
</content>
