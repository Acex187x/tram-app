# Interpolation Engine — Decision Record

How a sparse, laggy AVL feed (Golemio polls every ~20 s, positions already seconds
stale) becomes smooth 60 fps tram motion. The engine is pure, deterministic, timer-free
TypeScript — the caller drives `ingest()` per poll and `tick()` per frame.

- `src/lib/engine/tramSim.ts` — per-tram physics/state machine (`TramSim`)
- `src/lib/engine/speedProfile.ts` — per-shape speed limits + braking envelope
- `src/lib/engine/engine.ts` — `TramEngine`: owns all sims, queueing, projection, public state
- Tests: `__tests__/tram-sim.test.ts`, `engine-queue.test.ts`, `engine-projection.test.ts`, `speed-profile.test.ts`

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

- **Curve cap** `curveCap(κ) = clamp(sqrt(A_LAT/κ), 1.4, 13.9)` (`speedProfile.ts:55`).
  `A_LAT = 0.98 m/s²` is the lateral comfort accel; κ (rad/m) from `curvatureProfile()`.
  Physically: the fastest speed at which lateral accel in a curve of curvature κ stays ≤ A_LAT.
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

**Fix.** The pace factor multiplies **only the cruise reference cap**, and the result is then
clamped by the hard envelope (`tramSim.ts:398`):

```ts
vTarget = Math.min(vAllowed, cruiseCapAt(...) * factor);
```

A late tram may hold the track's cruise speed but can **never** defeat the braking envelope
toward a stop or curve. `cruiseCapAt`'s doc-comment (`speedProfile.ts:74-82`) states this
invariant explicitly: *pace scaling may multiply cruiseCap only, never vAllowedAt*.
Regression: `tram-sim.test.ts` "late tram braking (catch-up never defeats the envelope)"
(`:485`) forces a 20 m/s schedule (factor pegged at max) and asserts arrival speed ≈ the
envelope value at the reach boundary (~2.2 m/s), not a 60 km/h snap.

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

**Note — no adaptive `paceBias`.** The systematic bias is this single fixed constant. There
is **no per-tram adaptive `paceBias` / EWMA / recency-half-life term in the current code**
(grep of `src`/`__tests__`/`docs` finds none). If a future task lands a per-driver/per-district
adaptive bias, it would layer on top of the `targetDistAt` blend here — but as of this writing
it does not exist. Do not document it as present.

---

## 6. Asymmetric pace controller — gentle band, bold catch-up, hard-brake crawl

**Problem.** Convergence must be smooth when close, aggressive when far behind, and must
**not overshoot** when the sim has run ahead of reality — all without ever reversing.

**Decision.** Around `e = target(now) − s` (`tick` `:364`), three regimes:

| regime | condition | behavior |
|---|---|---|
| **gentle** | `\|e\| ≤ 40 m` | `factor = clamp(1 + e/120, 0.55, 1.35)` on cruise cap |
| **bold catch-up** | `e > 40 m` | same proportional factor, ceiling raised to `1.5` |
| **hard-brake crawl** | `e < −40 m` (ran ahead) | `vTarget = min(vAllowed, 1.0 m/s)` |

Constants: `PACE_GAIN_M = 120`, `GENTLE_MAX_FACTOR = 1.35`, `CATCHUP_MAX_FACTOR = 1.5`,
`MIN_PACE_FACTOR = 0.55`, `BOLD_CATCHUP_ERR_M = 40`, `CRAWL_V_MS = 1.0` (`:34-42`). *(The
1.65 in old test comments / architecture.md is the superseded ceiling.)*

**Crawl regime + hysteresis.** When the sim overruns the target by > `HARD_BRAKE_ENTER_M =
40 m`, it latches `crawling = true` and creeps at ≤ 1 m/s until the error recovers above
`−HARD_BRAKE_EXIT_M = 12 m` (`:383-387`). The two thresholds give a hysteresis band that
prevents brake/sprint oscillation at the boundary. Critically the sim **crawls forward, never
reverses** — reality catches up *to* it rather than the sim snapping back. Covered by "hard-
brake crawl when the sim ran ahead of reality" (`tram-sim.test.ts:289`).

Final: acceleration clamped to `[−A_BRK, +A_ACC]` = `[−1.2, +1.0] m/s²` (`:402`), `vMs ≥ 0`,
`sM` never decreases.

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

**Decision.** The last stop (or any `isTerminal`) → `phase = 'terminal'`, `v = 0`, held
indefinitely (`tick` `:367`, `:414`). A tram that runs off the geometry end with no stops left
also latches terminal (`:424`). It stays there until fresh trip data swaps geometry
(`ingest`'s trip-change path re-anchors onto the new shape). At stops, the render layer plays a
doors-open animation during the dwell (iteration 4).

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
**different** shapeIds and share no rail — constraining them would freeze a tram behind a tram on
the *other* track. They are intentionally **unconstrained** (`engine-queue.test.ts:193` "does NOT
constrain trams on different shapeIds"). Coupled-set length uses the `defaultIsCoupled` heuristic
(`engine.ts:55`): `runsCoupled` models on numeric day lines 1–26 excluding 23 (night lines queue
at single-car spacing — `engine-queue.test.ts:186`).

---

## 10. Teleport rules

**Decision.** `applySnapshot` (`tramSim.ts:338`) hard-teleports only when the **projected
observation** disagrees with the sim by more than `TELEPORT_THRESHOLD_M = 500 m`. Then: snap
`sM` to `sObs`, `v = 0`, reset to cruise, rebuild dwell memory (`seedStopState`), stamp
`lastTeleportMs` (renderer dips opacity ~300 ms). Errors **under** 500 m are absorbed by the
pace controller — no jump.

**Why 500 m / why the observation not the timetable.** Sub-500 m disagreements are normal poll
lag + prediction error and should converge smoothly. Above 500 m the sim is on the wrong block
(bad shape match, long GPS dropout, trip mismatch) — teleporting to the paper *timetable* there
would compound the error, so the target is the projected **AVL observation**. Trip-change
re-anchoring (`engine.ts:210-227`) reuses this budget: keep smooth position only if the old
world point projects within `REANCHOR_MAX_OFFSET_M = 100 m` of the new shape **and** within 500 m
of the new target; else `createSim` fresh. Tests: "teleport on large observation error" (`:416`).

---

## 11. Dual-sim: smooth mode vs live projection (`projSim`)

**Problem.** Some users want honest "where was it last actually seen" (accepting jumpy fixes);
others want smooth motion. Both must be available without re-deriving physics twice differently.

**Decision — two independent sims per tram** (`engine.ts:67 Entry`):

- **main `sim`** — the smoothed, trail-biased, **queue-constrained** position. Feeds
  `simDistM`/`position`/`bearing`. This is "Smooth" mode.
- **`projSim`** — a dead-reckoning sim **re-seeded at the raw fix** whenever a *genuinely new*
  observation arrives (new `observedAtMs` **or** new `shapeDistM`, or trip/shape change —
  `:236-245`), then advanced between polls by the **same** physics (speed profile, dwells). It is
  **not** trail-biased and **not** queue-constrained — it dead-reckons the raw AVL fix, not the
  rendered fleet. Feeds `projectedObservedDistM`. This is "Live" mode.

**Why re-seed only on a new fix.** Between identical polls `projSim` integrates smoothly (no
snapping to a re-projection); when a fresh fix lands it **jumps** to it — forward or backward.
That jump is the *accepted* live-mode UX: it shows the true correction the AVL feed just
reported. Tests `engine-projection.test.ts`: seeds at the fix and advances smoothly (`:67`),
jumps back (`:101`) / forward (`:117`), does **not** re-seed on a repeated stale fix (`:133`),
dwells at stops with the same physics (`:148`). `projectedObservedDistM` falls back to the
schedule-pace `observedDistAt` only if `projSim` is somehow absent (`engine.ts:400`, normally
unused).

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

## Tuning constants (single source of truth: the code)

| constant | value | file:line | role |
|---|---|---|---|
| `A_LAT` | 0.98 m/s² | speedProfile.ts:9 | curve cap lateral accel |
| `A_BRK` / `A_ACC` | 1.2 / 1.0 m/s² | speedProfile.ts:11-13 | brake / accel clamps |
| `V_MAX_MS` / `V_CENTER_MS` | 13.9 / 8.6 m/s | speedProfile.ts:15-17 | zone caps (50 / 31 km/h) |
| `DEFAULT_LOOKAHEAD_M` | 400 m | speedProfile.ts:21 | braking-envelope horizon |
| `OBS_BLEND_WEIGHT` | 0.75 | tramSim.ts:21 | observation vs timetable weight |
| `TRAIL_M` | 10 m | tramSim.ts:26 | ride-behind bias |
| `HARD_BRAKE_ENTER/EXIT_M` | 40 / 12 m | tramSim.ts:28-30 | crawl hysteresis band |
| `CRAWL_V_MS` | 1.0 m/s | tramSim.ts:32 | ran-ahead crawl speed |
| `CATCHUP/GENTLE_MAX_FACTOR` | 1.5 / 1.35 | tramSim.ts:36-38 | pace ceilings |
| `MIN_PACE_FACTOR` / `PACE_GAIN_M` | 0.55 / 120 | tramSim.ts:40-42 | pace floor / gain |
| `TELEPORT_THRESHOLD_M` | 500 m | tramSim.ts:11 | hard-teleport trigger |
| `DEFAULT_DWELL_S` | 18 s ±0–8 | tramSim.ts:15 | fallback dwell |
| `QUEUE_GAP_M` | 3 m | engine.ts:33 | follower clearance |
| `COUPLED_TRAILER_OFFSET_M` | 14.5 m | engine.ts:39 | coupled-set extra length |
| `STALE_AFTER_MS` | 90 s | engine.ts:27 | drop unseen trams |
</content>
