# Physics v3 — the frozen client/server contract

Status: FROZEN 2026-08-16 for the final-physics program (owner directive).
Both workstreams build against THIS file; change it only by editing this file
first, in its own commit.

## Design goals it encodes (owner's words, distilled)

1. Client physics = ONE pure function: `(trajectory bundle, newest fix, nowMs)
   → point`. No controllers, no per-frame state, no integration. 120 calls/s
   must be near-free (binary search + lerp + polyline pointAt). The fix
   argument is the 2026-08-19 amendment — see §Fix-forward; it stays a pure
   function, and everything expensive is still the server's.
2. Everything expensive lives server-side. The server OWNS smoothing:
   continuity between consecutive trajectories is baked into the emitted
   curves, not reconstructed by clients.
3. **Determinism across users**: two clients with the same physics version
   render pixel-identical trams at the same instant, regardless of when they
   opened/backgrounded the app. Achieved by (a) stateless client eval,
   (b) blend anchored to SERVER timestamps, (c) client clock sync via
   `serverNowMs` offset. A late joiner mid-blend evaluates the same curve.
4. **No lying about connectivity**: the bundle's age drives an explicit
   3-state connection UI; stale data is visibly stale.
5. Two render modes, one comparison mechanism:
   - `smooth` (default) — the continuity track; never teleports except
     server-flagged discontinuities (trip change, or a model break beyond the
     gap-aware desync threshold `T_disc` — see §Extended-convergence).
   - `fixed` («более точное положение») — the raw model-opinion track;
     re-anchors on every fix, may jump. Exists to be visibly beaten by
     smooth and eventually removed.

## Wire: `GET /api/trajectories/v2` (predictor service, today tram-lab.acex.sh)

```jsonc
{
  "protocolVersion": 2,
  "serverNowMs": 1786600000000,   // client: offset = serverNowMs - Date.now() at receive; ALL eval uses Date.now()+offset
  "atMs": 1786599998000,          // bundle build time (staleness = serverNow - atMs)
  "horizonS": 120,
  "vehicles": [
    {
      "key": "9251", "tripId": "...", "line": "22",
      "anchorMs": 1786599990000,   // observedAtMs of the underlying fix
      "emittedAtMs": 1786599998000,// birth of THIS trajectory (blend anchor)
      "discontinuity": false,      // true ⇒ smooth mode may fade-teleport once
      "opinion": [ { "t": 1786599998000, "s": 4380.5 }, ... ],
      "smooth":  [ { "t": 1786599998000, "s": 4371.0 }, ... ]
    }
  ]
}
```

- Both tracks: monotone-increasing `t` (non-uniform spacing allowed; denser
  near stops/blends), monotone-non-decreasing `s`, horizon ≥ 120 s past
  `emittedAtMs`, ≤ 24 points per track.
- **Continuity invariant (server-enforced)**: `smooth_n(emittedAtMs_n)` equals
  the previous emission's `smooth_{n-1}(emittedAtMs_n)` within 2 m, unless
  `discontinuity: true`. Convergence to `opinion` completes within ≤ 30 s
  **when the kinematic limits below allow it** (see the extended-convergence
  exception) and the blended curve stays monotone (never reverses to converge —
  if the new opinion is BEHIND the rendered position, the smooth track brakes
  at ≤ `A_BRK` and waits rather than reversing, mirroring "trams don't drive
  backwards").
- **Modal stop rule (both tracks)**: while the release model says
  P(departed) < 0.6 the curve HOLDS at the stop; when the threshold crosses it
  departs **under the acceleration limit** (`≤ A_BRK`… `≤ A_ACC`, §Kinematic
  limits) toward full learned pace. No expectation-floating off platforms, and
  no teleport-speed departures either.
- `opinion` re-anchors to each fresh fix (jumps allowed between emissions).
- Removed vehicles disappear from `vehicles`; clients drop them.

## Kinematic limits — a contract property (added 2026-08-16)

Owner field report, build 13: *«трамваи не умеют резко тормозить»* — both
tracks braked instantly into stops (10 s knots + a modal hold is a step
function), and the smooth track closed its catch-up gap at visibly impossible
speed because the ≤ 30 s convergence rule was purely temporal. A curve that
disobeys physics is a lie no matter how accurate its endpoints are, so the
limits are now part of the wire contract, not an implementation detail.

Every published track is the sampling of a **piecewise-constant-acceleration
profile** that never violates:

| symbol | limit | source |
|---|---|---|
| `V_MAX` | 16.7 m/s (60 km/h) | vehicle capability ceiling. Deliberately above the 50 km/h network cap (the old engine's `V_MAX_MS = 13.9`): this is a *never-lie* bound, not a pace target — the ML curve, not this number, decides how fast a tram is drawn |
| `A_ACC` | ≤ +1.3 m/s² | `lab/vendor/engine/speedProfile.ts` — measured against real stop exits (field feedback 2026-07-13) |
| `A_BRK` | ≥ −1.4 m/s² | same source — service braking, comfortably inside Tatra/Škoda capability (~1.5+) |

Knots are emitted **at profile breakpoints** (instants where acceleration
changes), not on a fixed grid. Because the client lerps between knots, the
only observable quantities are the per-segment mean speed and the
central-difference acceleration between consecutive segments:

```
v_i = (s_{i+1} − s_i) / (t_{i+1} − t_i)                    [segment mean speed]
a_i = (v_{i+1} − v_i) / ((Δt_i + Δt_{i+1}) / 2)            [between segments]
```

Sampling a constant-acceleration phase at its own breakpoints makes `v_i` the
instantaneous speed at the segment midpoint and `a_i` a convex combination of
the two phases' accelerations — so both are bounded by construction, exactly,
with no reliance on the sampling density.

**Guarantee**: for every segment of every published track of every vehicle,

```
v_i ≤ 17.0 m/s        and        −1.45 ≤ a_i ≤ +1.35 m/s²
```

(the 0.3 / 0.05 slack absorbs the cm-and-millisecond rounding of the wire
format). This is machine-checked live by `lab/scripts/check-v2.mjs`, which
exits non-zero on any violation, and counted continuously in the lab's
`/api/summary` under `realism`.

**Extended-convergence exception.** The smooth track closes its seam gap by
*driving*: its commanded speed is the opinion's own speed plus a bounded
closing surplus (the gap divided by a fixed close-out time constant, capped),
itself capped by the observed-pace catch-up ceiling — `CATCH_HEADROOM ×` the
learned pace surface at the tram's position, never the bare legal `V_MAX`,
which would sprint the night centre at multiples of anything real — rate- and
jerk-limited to `A_ACC` / `A_BRK` / `J_MAX`, and further clamped by the
braking envelope `√(2·A_BRK·Δs)` of any upcoming hold so catch-up can never
blast through a platform. When a gap is too large to close legally within
30 s, **the window extends — the limits never bend.** Convergence therefore
reads: *the smooth track converges onto the opinion within 30 s whenever the
kinematic limits permit, and otherwise as fast as they permit.* Gaps big
enough to matter are already `discontinuity: true` — a trip change, or a seam
gap beyond the gap-aware desync threshold (server policy constant, replacing
the former flat 150 m: a teleport must mean *desync*, never model re-anchor
noise)

```
T_disc = clamp( clamp(fixGapS, 45, 240) · max(learnedPace, 5.5 m/s) · 1.25,
                350 m, 1200 m )
```

— which resets the smooth track onto the opinion outright.

## Client pure evaluator (the whole "physics engine")

```ts
evalTrajectory(track: Float64Array /*t0,s0,t1,s1,…*/, tMs: number): number
  // clamp before first / after last knot; binary search inside; lerp.
renderTram(v: ParsedVehicle, serverNow: number, mode: 'smooth'|'fixed',
           fixS?: number, fixAtMs?: number)
  → { s, position: [lng,lat], bearing, staleS, pastHorizon: boolean }
  // position/bearing via the existing polyline pointAt/bearingAt on the
  // trip geometry. NO other state. Parse-time work (typed arrays, geometry
  // lookup) happens once per bundle, never per frame.
```

## Fix-forward — the client's one correction (added 2026-08-19)

Owner field report, build 16: the `fixed` marker still flies behind the AVL
dot, and trams stop dead mid-segment. Both are the same defect, and it is not
in the curves — it is in the fact that **the phone holds two asynchronous
streams and only one of them waits for the ML model**:

| stream | path | on screen after the tram was there |
|---|---|---|
| fixes | Golemio → Convex → WebSocket push | ~2 s |
| curves | Golemio → lab poll → **ML round trip** → emit → 2 s JSON freeze → 5 s client poll | ~7–11 s |

So for part of every inter-fix window the client knows an observation the
served curve was not built from, and the measurements agree on the size of it:

- lab M2, published chain (9 484 fix arrivals): **48 % of fixes land ahead of
  the curve being served**, p90 142 m, p99 290 m, max 1 114 m;
- the phone's view, replaying the live streams at a realistic bundle age:
  **~10 % of the fleet at any instant**, median 73 m, p90 228 m.

Build 16 answered this with a floor — `max(curve, fix)` — which removed the
backward marker and replaced it with a tram standing still on open track until
the curve climbed past the fix. Replaying the client path against the live
streams for four minutes prices that: **2.5–3.0 % of all the time the served
curve says a tram is moving, build 16 renders it standing still.** That freeze
is the «останавливаются посреди перегона» report.

The rule, client-side, in `src/lib/physics/fixForward.ts`:

> When the client holds a fix observed **strictly after** a curve's `anchorMs`,
> the curve is wound forward **in time** until it is where that fix proves the
> tram is, and read from there:
> `τ = crossingTime(curve, fixS) − fixAt`, `s(t) = curve(t + τ)`.

Read it as: the curve is not wrong about how this tram drives, it is **late**.
Everything else follows — the profile's accelerations, brake-ins and holds are
untouched, the speed is the curve's own speed at the position the tram is
actually at, and there is no invented catch-up.

A *space* shift (`curve(t) + gap`) was tried first and measured worse, twice
over. It carries the curve's FEATURES with it, so a platform hold the tram has
already left lands 180 m down the block and the marker stops dead in
mid-segment — the artefact being fixed, relocated. And it double-counts: a
curve that is behind because it held too long will depart and close the gap
itself, so adding the gap on top overshoots.

Constraints on it:

- **Gated on `anchorMs`.** A curve may legitimately sit behind the fix it was
  built from — that is precisely what `smooth` does at every emission, resuming
  from the previous curve. Winding that forward would re-introduce the teleport
  the smooth track exists to remove.
- **Forward only.** A curve that over-ran its fix is left alone: pulling a
  marker back is the §14.7 seam decision, and the server owns it with evidence
  (observed fix-over-fix speed) the client does not have. The shim can give
  back the metres it added — when a tram that was running ahead stalls, τ
  collapses — but never more, so the marker is never behind where an unshimmed
  client would have drawn it.
- **Rate-limited per mode.** `fixed` is the track the protocol licenses to jump,
  so it takes the whole shift at once. `smooth` may not teleport, so it walks to
  the wound-forward curve at ≤ 2 m/s of extra speed — an order below the
  build-13 «догоняет с невозможной скоростью» rate, and the total stays inside
  `V_MAX`. That allowance accrues from the **curve's** start, not the fix's:
  measuring it from the fix reset it on every AVL update and made the marker
  give back ~28 m (up to 44 m) each time, in the default render mode.
- **Still deterministic** (design goal 3). Both τ and the ramp are functions of
  server timestamps only, never of when this phone happened to receive
  anything, so two clients holding the same bundle and the same fix render the
  same pixel.
- **Still no invented motion.** With no curve there is no profile to wind and
  the tram stands on its raw fix, dimmed, exactly as before.

### The server has to model the shim (§14.7 amendment)

The shim changes where the phone draws, and §14.7 continuity is defined against
exactly that. Left alone, the seam floor would keep referencing the *unshifted*
previous curve — a marker that has not been on screen since build 17 — so the
fresh curve lands behind the phone's tram and the swap steps backward. That is
not a theory: attributing every backward step in a four-minute live replay puts
**796 of 809 at the bundle swap and 0–1 anywhere else.**

So `clientProjectionM` in `lab/src/trajectory.ts` is the server's copy of the
rule, and both generators' seam floors read it instead of `evalTrack(prev, t0)`.
The server has the same two inputs the phone does — the previous curve and the
newest fix — so the two agree by construction rather than by luck. The
`seamJustifiedM` bound still caps it: a projection the newest fix can prove
wrong is still corrected honestly, never floored.

**Past the horizon** the marker no longer stops dead at the last keyframe
either: it decelerates to a standstill over 20 s from the final segment's speed
(≤ 0.84 m/s² even at `V_MAX`, well inside `A_BRK`) and then freezes. This is
presentation, not prediction — `pastHorizon` stays true throughout, so the tram
is dimmed and the connection banner tells the truth the whole time.

The client path is the part of the system no lab gate covers: every gate scores
the SERVED curve, and none of them evaluate this file. It is pinned by
`__tests__/physics-fix-forward.test.ts`, which asserts the properties above as
invariants over swept grids rather than at instants — and the grids sweep the
FIX as well as the clock. That is the lesson that cost the first draft: proving
monotonicity against one frozen fix says nothing about the instant the next one
lands, which is exactly when the marker was observed to fly backwards.

## Connection honesty (client states, from bundle age + fetch health)

| state | condition | UI |
|---|---|---|
| live | fresh bundle < 15 s | normal |
| degraded | 15–45 s | subtle indicator; trams keep following curves |
| offline | > 45 s or fetch failing | explicit banner «Нет связи с сервером — данные устарели»; trams follow curves to horizon end, coast to a halt over 20 s (§Fix-forward) and freeze dimmed there. Never silently animate beyond data. |

## What dies on the client (excision list)

`TramEngine`/`tramSim`/`smoother`/`speedProfile` runtime use, paceBias, TOD
tables, queue/junction client constraints, schedule-target logic, the old
smooth/live/raw mode machinery and its devtools. Devtools are rebuilt around:
bundle age, per-tram smooth↔fixed delta, discontinuity events, connection
state, clock offset. The comparison harness (smooth vs fixed on-screen)
STAYS — it is how we measure distance from the ideal.

## Scoring continuity (lab)

The lab scores two new variants from the same generator: `ml-mode`
(= opinion track, modal stops) and `ml-smooth` (= smooth track) against the
same at-fix probe, so the cost of continuity and of modal stops is measured,
not assumed.
