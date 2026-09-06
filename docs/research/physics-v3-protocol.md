# Physics v3 — the frozen client/server contract

Status: FROZEN 2026-08-16 for the final-physics program (owner directive).
Both workstreams build against THIS file; change it only by editing this file
first, in its own commit.

## Visible continuity amendment — every displayed correction counts (2026-09-06)

The build31 field review and a replay of its previously accepted capture expose
a validation error: server `discontinuity` frames were excluded from motion
statistics while the client used that flag to bypass its presentation guard.
The same five-minute capture contains 208 over-budget visible jumps, including
a 744 m world displacement. A discontinuity is evidence that a prediction needs
correction; it is not permission to teleport a fully visible smooth marker.

This amendment supersedes earlier client-stateless/deterministic-pixel claims
and automatic smooth-reset handling for same-axis discontinuities. Prediction,
platform selection, traffic constraints and trip pace remain server-owned.
The client owns one bounded presentation state: last displayed position,
velocity and acceleration. Ordinary same-axis revisions, restored curves and
forward-fix corrections retain that state, track the supplied target and
velocity with acceleration, braking and jerk bounds, and look ahead along the
received curve to brake into its stationary endpoints. It must not add a second
route predictor, move platform holds, or fabricate ongoing travel after source
expiry. Bounds and any permitted correction lag require fixed-input validation.

An unexpected stop behind a moving marker cannot satisfy instantaneous truth,
zero reversal and finite braking simultaneously. A bounded braking transition
may temporarily remain beyond a revised target; diagnostics expose its error
and reason. A large incompatible correction may instead use a visible fade-out,
rebase only while hidden, and fade-in. Ordinary revisions must not repeatedly
hide vehicles as a substitute for fixing the prediction. Report transition
frequency, duration, correction distance and hidden vehicle-time alongside
position error, stationary time and acceleration/braking/jerk distributions.

An equivalent geometry object must preserve display state. A compatible axis
replacement may reproject the last rendered world position only within 10 m
and an unambiguous matching stop corridor. Incompatible geometry/trip changes
must explicitly transition or start a new identity; they cannot silently reset
an existing fully visible marker. Long suspension is a lifecycle event, not an
ordinary frame integration step; returning to a visible map follows the same
explicit transition rule. User-requested mode changes remain separately labeled.

Only the actual frame producer advances presentation state. Read-only getters,
camera lookahead and diagnostics stay pure; histories and transitions are
bounded and cleaned up with vehicle departure. Map opacity is updated through
the existing imperative sources, without per-frame React rendering.

Validation includes **all displayed frames**, including resets, source recovery,
axis/trip changes and discontinuities. Report raw world/axis jumps and event
reasons even when an intentional transition hides the rebase. Never remove bad
frames from the headline metric. Compare accuracy, prolonged holds, actual
platform crossings, both acceleration signs, jerk, hidden time and native map
cadence on identical inputs; a source `at_stop` label alone is not stop truth.

## Continuous producer and approach-phase amendment (2026-09-06)

A version-2 vehicle may advertise `motionPolicy: "continuous-v1"`. Absence or an
unknown value retains legacy behavior. This capability means that compatible
same-trip, same-axis smooth emissions join the exact shared eligible Hermite
position of the preceding emitted chain, with bounded inherited velocity and
acceleration. Disagreement with a newer observation alone does not authorize a
visible position reset. Trip/axis changes remain explicit discontinuities.

For this capability only, the client disables its **smooth-track** forward-fix
position shim: a second client displacement would destroy the producer's seam
and make the next continuous emission appear behind the displayed tram. Fixed
track behavior, raw observations and error diagnostics remain available. Client
presentation still follows the visible-continuity amendment. Public fallback
producers without this capability retain their measured legacy behavior.

The raw provider `at_stop` field denotes an announced stop/closest anchor, not
proof of zero speed or open doors. A source marked `at_stop` can be admitted as
an approach when a corridor-validated GPS projection and exact current-platform
ID/sequence place it more than 30 m and no more than 150 m before that platform,
with observation age below 120 seconds. Integrate opinion from that observation's
actual epoch and projected route distance through the ordinary platform plan,
then crop at emission time; do not start a new arrival hold at the earlier
announcement anchor. Initial pace uses a causal preceding projected observation
5–120 seconds earlier, nonnegative displacement and a 16.7 m/s cap, or the
learned fallback constrained to 2–13.9 m/s. The existing physical envelope still
applies. Near-platform modal dwell remains probable, not verified door telemetry.

Legacy learned dwell cells were indexed by the **next** stop. Planned dwell for
an actual platform must adapt that convention through a unique ordered successor.
Ambiguous or terminal mappings use the untrusted 18±8 second fallback rather than
borrow another platform's learned cell. Request-stop service eligibility follows
the explicit PID amendment below. Diagnostics expose approach admission, source
age, GPS projection and pace evidence; they must not relabel `at_stop` as verified
stationarity. The 13-column version-3 ML artifact is unchanged by this amendment.

Release requires paired full-chain replay: all visible transitions, GPS-projected
and raw-anchor errors reported separately, guarded-held vehicle-time, required
platform crossings and acceleration/braking/jerk. Partial replacement curves must
start from their actual captured predecessor, and coverage must be reported.

## Platform service eligibility amendment (2026-09-06)

Route geometry may carry `RouteStop.requestOnly?: boolean`. It is true only
when the authoritative PID GTFS `stop_times` row for the exact trip, stop ID
and stop sequence has both `pickup_type = 3` and `drop_off_type = 3`. Other
known combinations are false. Missing metadata, ambiguous joins and old cached
geometry are treated as ordinary required stops. The predictor's learned
request-stop skip policy is gated by `requestOnly === true`; terminal stops
retain their existing required-stop rule. A raw AVL `at_stop` label never
establishes request-stop eligibility.

Converters preserve this optional property. Convex validators accept it without
changing the trajectory wire version; old clients may ignore it. An isolated
candidate that still reads production geometry can join a derived public PID
GTFS metadata overlay, strictly by trip ID, stop ID and stop sequence. Its source
date and unmatched counts must be exposed. Stale or absent overlay data cannot
turn an unknown stop into a request stop. No production deployment is implied.

Validation includes 0/0 ordinary stops, 3/3 request stops, mixed service flags,
terminal and missing/ambiguous metadata, plus captured actual platform crossings.

## Review deployment availability amendment (2026-09-06)

An optional private trajectory deployment may use the already configured public
production trajectory service as a read-only fallback. Production-only builds
retain one source. After 15 seconds without an initial seed or advancing
publication, a review build attempts the public source; it keeps the last
accepted curves aging until a replacement seed arrives. A quiet fleet's advancing
publisher heartbeat counts as progress. Replayed cached metadata does not.

While on the fallback, a bounded primary probe runs at most every two minutes.
Recovery requires a valid seed and at least five seconds of advancing publisher
progress; a probe closes after twenty seconds if this is not established. Only
one endpoint supplies displayed data. Probing may briefly own a second socket,
with a bounded fleet snapshot; old-generation callbacks cannot mutate the active
store. Backgrounding closes both sockets and every watchdog/probe timer.

The active source, fallback reason and recovery probe must be visible in health.
A public fallback uses the production predictor, not the isolated candidate;
never label those results as candidate validation. Source sequence cursors belong
to separate epochs. Switching sources replaces the fleet atomically, invalidates
old clock samples, retains the last applied time offset until a fresh nonce reply
and slews the new offset. Compatible trip/axis presentation state survives the
switch; the visible-continuity amendment still applies to every revision.

## Compatible amendment — clock samples and knot velocities (2026-09-05)

This additive amendment retains `protocolVersion: 2`, both track names, the
24-knot budget, and all legacy position/kinematic gates. Existing clients
continue reading `{t,s}` and ignore the optional `v` field below.

**Clock:** Convex feed query results can be cached. Their `serverNowMs` is
the query transaction's clock, not a delivery timestamp, so a client must
not repeatedly derive its offset from seed, batch, or meta delivery. The
read-only query `clock:now({nonce: string}) → {serverNowMs: number}` accepts
a unique request nonce to force a fresh transaction. A client estimates
offset against the local request/response midpoint, rejects round trips
over 2 seconds, refreshes on foreground and at most once per minute, and
slews subsequent corrections without reversing render time. If this
optional query is unavailable it retains local/last-known time and reports
the clock as unsynchronized, while continuing to consume the fleet.

**Velocity:** each opinion/smooth knot may additionally carry `v`, the
generator's instantaneous velocity in metres per second at `t`. Legacy
`s` and `t` stay byte-compatible. A capable client may evaluate a segment
using cubic Hermite interpolation through its two positions and velocities,
with tangents `v₀·Δt` and `v₁·Δt` (Δt in seconds). It uses the cubic only
when both velocities are finite, its derivative stays in `[0,16.7] m/s`,
and its acceleration stays in `[-1.4,+1.3] m/s²` over the **whole** segment;
the derivative's interior extremum and both acceleration endpoints must
be checked analytically. Otherwise that segment retains legacy linear
interpolation. A zero-distance hold remains exactly constant. Missing or
invalid velocity metadata never drops an otherwise valid legacy trajectory.

Forward evaluation, inverse crossing-time lookup, terminal coast speed,
diagnostics, and the server's client-projection seam must use the same
eligible segment representation. Inversion must remain bounded and exploit
monotonicity. Client preparation/cache work belongs at parse time; per-frame
evaluation remains allocation-free. This does not authorize a second
client motion controller or moving platform holds to different positions.

Validation must compare identical recorded fixes/curves with legacy and
velocity-aware evaluators: position-error distribution, hold duration,
backward steps, speed/acceleration bounds, revision speed jumps, and CPU.
The extra field is deployed server-side only after the Convex validator
accepts it; old producers and clients remain supported throughout.

## ML target-clock amendment — feature contract version 3 (2026-09-05)

The model predicts position at an **observation-time horizon**. A training
pair uses `tEval = next.observedAtMs`, `gapS = (tEval − prev.observedAtMs)/1000`,
and target `next.shapeDistM − prev.shapeDistM`. Arrival/ingest time is
transport telemetry, never a substitute for the target's timestamp. At
inference `tEval` is the absolute instant of the requested trajectory knot;
therefore a knot for wall time now predicts position now, rather than the
position belonging to a delayed observation arriving now.

This changes target semantics even though the 13 feature columns keep their
order. It requires `FEATURE_VERSION = 3` on both trainer and predictor.
Version-2 persisted models must not load under version 3, and inference
requests with a mismatched version must fail closed to the existing bounded
outage policy. Train and validate an isolated candidate before coordinating
the ML service and predictor rollout; the client wire remains version 2.

Validation separates two clocks: observation-time position error (primary)
and ingest latency (transport). Score an already-issued curve at the next
fix's `observedAtMs`; do not score a curve issued after that instant as if it
had predicted the observation. Historical arrival-time scores remain labeled
as such and must not be mixed with the new primary series. Training/holdout
splits are chronological across the **whole fleet**, not the order of
vehicle keys. Keep same-trip pairs and physical jump/gap rejection. Report
MAE, bias and p90 by anchor state and horizon, with matched sample counts;
compare both candidates on exactly the same holdout observations.

Offline corridor features may use only measured samples whose **arrival**
preceded the prediction issue time (the anchor's receipt in a fix-pair
replay). The target pair's speed and later-arriving samples are unavailable
inputs, even when their observation timestamps precede the target arrival.
Decay eligible evidence to `tEval`, matching the online feature horizon.
Disclose that historical learned surfaces currently use today's aggregates;
this separate limitation does not justify leaking future corridor samples.

The modal stop-release clock uses the same observation epoch:
`t0 = anchor.observedAtMs`, with measured already-standing credit and learned
release duration. Do not add the legacy five-second feed-latency offset to
this epoch: transport delay does not postpone the vehicle's departure.
The frozen legacy comparison engine may retain its original clock, but new
published v3 trajectories must use observation time consistently.

The annotation corrects an implementation mismatch with the original
prediction architecture §7.4: its scorer called for `s_predicted(t_fix)`,
while the v2 training/scoring implementation used the later ingest clock.
Public AVL timestamps are still a proxy for vehicle observation time; rider
GPS remains the higher-quality calibration source when available.

## Served-platform identity amendment (2026-09-06)

An `at_stop` observation can identify the current served platform while its
reported axis and GPS remain inside the approach station zone. The initial
modal hold already accounts for that stop. A distance-only future stop plan
must not schedule another dwell for the **same occurrence** after release.
This is a narrow exception to §4.2's serve-every-platform-ahead rule:

- The captured anchor is `at_stop` and supplies a modal hold plus non-null
  last/next stop IDs and finite, ordered last/next stop sequences.
- Exactly one geometry occurrence matches each ID/sequence pair, the next
  occurrence is farther along the axis, and the current occurrence is neither
  terminal nor the final geometry stop.
- The current platform is strictly ahead of the modal anchor by at most 150 m,
  and no different platform occurs between them. Missing or contradictory
  evidence retains the existing plan. Repeated IDs never suppress later laps;
  only the exact identified sequence may be consumed. The initial rollout
  conservatively retains the ordinary plan when the current stop ID repeats
  anywhere in the geometry.

The generator omits that one occurrence from the future stop plan while
preserving the initial modal hold/release and its position. If the ML crosses
that consumed platform, its crossing enters the existing request-stop trim
blinding list, with the same bounded timing window. This prevents residual
ML dwell smear from manufacturing a speed dip for a stop already accounted
for. It changes no cruise pace, speed/acceleration/jerk limits, curve envelope,
leader clearance, route-end clamp, subsequent stop, client controller or wire.
The evidence is scoped to each captured anchor, not a sticky served-stop flag;
new observations and trip changes rebuild the decision.

Validation includes exact-input replay with unchanged learned surfaces and
previous chains, truthful future-observation scoring, duplicate hold counts,
physical gates and speed dips. Exclude ambiguous identities, reversed/missing
sequences, intervening platforms, terminal cases and offsets beyond the bound;
check recovery to the ordinary plan on the next moving/different anchor.

## Geometry coherence amendment — contradictory route axes (2026-09-05)

A reported shape distance is usable only on a compatible route geometry. A
captured vehicle reported distance zero while its GPS was over 10 km from that
axis point and neither reported last/next stop existed on the served variant.
Projecting its GPS onto another part of that variant would invent a route.

The client and server share a pure coherence check. A decisive contradiction
requires **both** non-null reported stop IDs to be absent from the served trip
and the GPS coordinate to lie more than 500 m from the reported distance's
point on its shape. Missing geometry, coordinates or stop identifiers cannot
by themselves prove a contradiction. Ordinary near-platform offsets and a
single missing stop ID must retain the established bounded correction path.

On a decisive contradiction, the server does not learn, score or construct a
trajectory on that axis; an existing trajectory is withdrawn. Diagnostics
retain the reason and the underlying observation. The client ignores curves
on that axis and may show the raw observed GPS coordinate as stale, without
route extrapolation or projection onto an alternative variant. Re-evaluate
when either the fix or geometry changes and resume ordinary motion when the
evidence is coherent. Cache this check outside the frame loop.

This is a source-validity gate, not a new motion policy. It adds no mandatory
wire fields and does not change the public AVL ingestion service. Validation
must include the captured contradictory case, coherent route starts, large
but explainable route offsets, missing IDs and recovery after geometry/fix
replacement. Accuracy comparisons must disclose excluded contradictory axes.

## Presentation amendment — bounded forward catch-up (2026-09-05)

The existing smooth-marker guard is the sole allowed presentation
state. Server curve/fix evaluation remains a pure deterministic function and
continues to expose its unguarded target independently from displayed position.

Only a frame actually submitted by the map renderer may update a guard's last
position, timestamp and displayed interval velocity. UI, inspector, future
probes and offscreen culling reads must not advance or consume this state.
The guard is scoped to a vehicle, trip and geometry coordinate axis. Late join,
trip/geometry change, an explicitly sanctioned discontinuity, or a frame gap
longer than five seconds initializes at the current raw target; no old velocity
may leak across that reset. Fixed mode retains the raw projection.

For a contiguous smooth frame with interval dt seconds, raw target x and last
presented position p and interval velocity v, choose:

    displayed = clamp(x, p, p + min(25, max(0,v) + A*dt)*dt)

A = 2.5 m/s² is a presentation catch-up cap, not a claim about tram physics. This bounds
forward catch-up while retaining the existing 25 m/s correction ceiling. It
never invents forward coasting beyond the target. Displayed interval speed is
(displayed-p)/dt, including when the raw target was reachable; a same-instant
read retains the last displayed speed. Geometry endpoints are a hard boundary.

There is deliberately no global braking-acceleration promise. When a revised
source target moves behind the marker, forward overshoot would worsen both
accuracy and false holds. The marker can stop immediately at its existing
position. Such corrections remain visible in diagnostics; a future explicit
presentation transition would require its own evidence and contract amendment.
No new predictor, integrator, platform location, target trajectory, or smoothing
controller is introduced.

The raw target remains identical across clients. Presented positions depend on
the map's frame history and initialization, an explicit exception to raw
projection determinism already present in the guard. Verify 10/30/60 Hz, read
interleaving, late join/resume, discontinuity consumption, fresh fixes behind
the last frame, stop holds, geometry replacement and offscreen culling.

Validation must use identical received wire captures and compare held vehicle
time, per-state hold episode p90/max, signed target gaps, historical displayed
position against later-arriving AVL fixes at their observation timestamps,
speed/acceleration steps, and host CPU. State labels from latest AVL fixes are
reported states, not proof of a vehicle's state now. Do not call present position
minus an old at_stop fix a measured stop overshoot. No candidate is acceptable
merely because its acceleration histogram looks physical.

The adoption comparison uses a frozen 2,340.876-second public Convex capture
with 10,902,307 geometry-known frame samples at 30 Hz. Held vehicle time falls
from 13,673 to 10,766 seconds, and launches exceeding 1 m/s per frame fall from
2,958 to zero. The cost is behind-target p99 increasing from 9.72/5.93 m to
29.50/29.79 m for reported at_stop/on_track fixes. Historical displayed-position
MAE against later-arriving AVL observations increases by 0.66/0.17 m. These
are presentation tradeoffs on the old production model, not ground-truth
accuracy guarantees. The longest holds remain unchanged (253/131 seconds);
several involve stale fixes and flat targets, so they are not all guard-caused
false stops. A fully acceleration-and-braking-bounded candidate was rejected
because coasting beyond revised targets multiplied false holds and overshoot.

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

## Transport (amended 2026-08-21 — the promotion)

The production feed no longer travels over HTTP polling. The predictor pushes
every re-emission into Convex (`convex/trajectories.ts`: `trajectoryVehicles`
per-vehicle rows + `trajectoryBatches` diff stream + `trajectoryMeta`
heartbeat singleton, mutation `trajectories:publish` gated by
`ENGINE_PUSH_TOKEN`), and the client folds the same diff-stream shape the fix
feed already uses (`src/lib/physics/convexSource.ts` →
`TrajectoryStore.seedConvex/foldConvex/noteConvexMeta`). Fix→curve-on-glass
drops from ~7–11 s (poll against a JSON freeze) to ~2–4 s (the ML round trip
itself). `GET /api/trajectories/v2` STAYS, byte-compatible, for the research
generations (`?gen=v3|mix`), the lab pages and the gates.

Each published vehicle carries one field the HTTP wire does not:
`source: 'ml' | 'naive'`, plus `anchorS` (the anchor fix's shapeDistM, for
devtools).

**One emission per fix (owner doctrine, amended 2026-08-24; supersedes the
two-phase emission of 2026-08-21).** Every fix-driven rebuild goes straight to
ml-gbdt: the ML round trip (~0.3–2.5 s) is fully covered on the client by the
matured fix-forward shim (`fixed` jumps to the fresh fix via wind/τ=∞ the
moment it lands, `smooth` closes under the slew guard), so the former instant
naive pass-1 bought ~1–2 s on a pipeline that is ~10–13 s late upstream while
costing an extra seam and a source flap on every correction.

The naive learned-walker remains STRICTLY the outage fallback: when
`predictBatch` fails (service down / unusable answer) AND the old curve is
provably wrong about the new fix (gone, wrong trip, overrun, or off by more
than `INSTANT_NAIVE_GAP_M`), the vehicle is emitted from naive targets
(`source: 'naive'`, same generator and limits). A still-valid old curve is
held instead — an ML blip must not degrade a good prediction.

## Wire: `GET /api/trajectories/v2` (research transport; same shape as the Convex rows)

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
- **Overrun fixes are walked to, never snapped to (amended 2026-08-21).** When
  the fix is past everything the curve predicts (`τ = ∞`), the first draft
  floored BOTH modes at the fix — an instantaneous snap followed by a standing
  marker, the «телепортируется за новый фикс и стоит» field report (build 18).
  Now only `fixed` jumps (its license); `smooth` walks toward the fix at the
  same bounded catch-up rate, with the allowance measured from the CURVE's
  start — the same datum the finite-τ branch uses, so the two branches are
  continuous at the boundary and a fix that flips τ from finite to ∞ cannot
  reset the allowance (`__tests__/physics-fix-forward.test.ts`, the τ=∞ suite).
  The server replaces an overrun curve within ~one publish cycle (naive
  substitute if ML is down), so the walk is short-lived by construction.
- **Naive client fallback (amended 2026-08-21).** With no curve AT ALL the tram
  no longer freezes: it dead-reckons from its last fix at the observed
  fix-over-fix pace (fleet.ts bookkeeping) for ≤ 60 s (`NAIVE_HORIZON_S`),
  dimmed (`pastHorizon`) the whole time, then stops. Bridges a new vehicle's
  first emission and short feed blips without inventing unbounded motion.

### The server has to model the shim (§14.7 amendment)

The shim changes where the phone draws, and §14.7 continuity is defined against
exactly that. Left alone, the seam floor would keep referencing the *unshifted*
previous curve — a marker that has not been on screen since build 17 — so the
fresh curve lands behind the phone's tram and the swap steps backward. That is
not a theory: attributing every backward step in a four-minute live replay puts
**796 of 809 at the bundle swap and 0–1 anywhere else.**

So `clientProjectionM` in `lab/src/trajectory.ts` is the server's copy of the
rule, and both generators' seam floors read it instead of `evalTrack(prev, t0)`.
Since 2026-08-21 the SMOOTH seam resumes from `clientSmoothProjectionM` — the
rate-limited twin that models the smooth marker's bounded walk (finite τ AND
τ = ∞) — because resuming from the unshifted curve handed the accrued
catch-up back as a backward step on every swap.
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
