# Physics v3 — the frozen client/server contract

Status: FROZEN 2026-08-16 for the final-physics program (owner directive).
Both workstreams build against THIS file; change it only by editing this file
first, in its own commit.

## Design goals it encodes (owner's words, distilled)

1. Client physics = ONE pure function: `(trajectory bundle, nowMs) → point`.
   No controllers, no per-frame state, no integration. 120 calls/s must be
   near-free (binary search + lerp + polyline pointAt).
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
     server-flagged discontinuities (trip change, >150 m model break).
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
*driving*: its commanded speed is the opinion's own speed plus the gap divided
by the time left in the convergence window, clamped to `V_MAX` and rate-limited
to `A_ACC` / `A_BRK`, and further clamped by the braking envelope
`√(2·A_BRK·Δs)` of any upcoming hold so catch-up can never blast through a
platform. When a gap is too large to close legally within 30 s, **the window
extends — the limits never bend.** Convergence therefore reads: *the smooth
track converges onto the opinion within 30 s whenever the kinematic limits
permit, and otherwise as fast as they permit.* Gaps big enough to matter are
already `discontinuity: true` (> 150 m, or a trip change), which resets the
smooth track onto the opinion outright.

## Client pure evaluator (the whole "physics engine")

```ts
evalTrajectory(track: Float64Array /*t0,s0,t1,s1,…*/, tMs: number): number
  // clamp before first / after last knot; binary search inside; lerp.
renderTram(v: ParsedVehicle, serverNow: number, mode: 'smooth'|'fixed')
  → { s, position: [lng,lat], bearing, staleS, pastHorizon: boolean }
  // position/bearing via the existing polyline pointAt/bearingAt on the
  // trip geometry. NO other state. Parse-time work (typed arrays, geometry
  // lookup) happens once per bundle, never per frame.
```

## Connection honesty (client states, from bundle age + fetch health)

| state | condition | UI |
|---|---|---|
| live | fresh bundle < 15 s | normal |
| degraded | 15–45 s | subtle indicator; trams keep following curves |
| offline | > 45 s or fetch failing | explicit banner «Нет связи с сервером — данные устарели»; trams follow curves to horizon end, then freeze dimmed. Never silently animate beyond data. |

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
