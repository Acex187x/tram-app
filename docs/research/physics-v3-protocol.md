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
  `discontinuity: true`. Convergence to `opinion` completes within ≤ 30 s and
  the blended curve stays monotone (never reverses to converge — if the new
  opinion is BEHIND the rendered position, the smooth track holds position
  until the opinion catches up, mirroring "trams don't drive backwards").
- **Modal stop rule (both tracks)**: while the release model says
  P(departed) < 0.6 the curve HOLDS at the stop; it departs at full learned
  pace when the threshold crosses. No expectation-floating off platforms.
- `opinion` re-anchors to each fresh fix (jumps allowed between emissions).
- Removed vehicles disappear from `vehicles`; clients drop them.

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
