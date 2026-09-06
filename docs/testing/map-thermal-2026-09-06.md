# Map source invalidation investigation, 2026-09-06

The build-37 complaint is severe phone heat and app-wide lag. The preceding
change raised city-scale point source opportunities from 5 seconds to 400 ms,
badge opportunities from 1 second to 200 ms, and a selected/followed vehicle
raised the entire coarse source to 100 ms. More opportunities do not establish
more visible motion: each accepted source update reparses geometry and
invalidates native map work. This is a concrete workload regression, not proof
that it alone explains the physical-device heat.

The hotfix retains those due-check intervals and the presentation controller.
`VisualPayload` compares points and badges against their last submitted frame:
less than 0.5 Mapbox style pixels of displacement and 0.5 degrees of heading may
reuse the previous payload. It does not round coordinates. Motion accumulates
against the last submitted pose, not the previous attempted frame. All other
properties and feature membership are compared exactly. Selection, mode and
explicit transition frames bypass this gate, preserving both zero-opacity
native acknowledgements. Failed writes still retry through `SourceWriter`.
Sections retain exact geometry and their existing cadence.

The minute-long source-confidence ramp is rounded to 1% only when building
render features. Exact confidence and observation age remain in public state
and diagnostics. Previously a stationary aging observation changed every
GeoJSON frame, defeating the native writer's identical-payload suppression.
The ramp's endpoints remain exactly 1 and 0.55; presentation fade is not rounded.

## Deterministic invalidation comparison

`__tests__/visual-payload.test.ts` drives the real `SourceWriter` into a resolved
native-target spy using the same 200-tram input before and after gating. The
10-second workloads vary speed by vehicle from 5 to 10 m/s (first vehicle
10 m/s), use Prague latitude, and count actual native calls, not attempted
frames. No Xcode build, device or simulator is involved in these counts.

| Workload | Opportunities | Before calls | After calls |
|---|---:|---:|---:|
| Stationary aging, z14.2, 66 ms | 152 | 152 | 8 |
| Moving city, z12, 400 ms | 25 | 25 | 13 |
| Moving selected city, z12, 100 ms | 100 | 100 | 15 |
| Moving badges, z14.2, 66 ms | 152 | 152 | 51 |
| Moving close map, z17, 66 ms | 152 | 152 | 152 |

These are controlled invalidation counts, not CPU, GPU, power or temperature.
All aging observations in this fixture share their epoch. Heterogeneous ages,
turning vehicles, changing badge placement and frequent transition frames can
reduce suppression. A single vehicle crossing the display threshold updates
the whole source; this is not incremental per-feature native delivery. Full
frame construction still happens on due opportunities; JSON serialization and
native source work are suppressed when the gate finds no visible change.
Mercator style pixels express map scale; at pitch they are not exact projected
screen distances.

Five targeted suites passed (35 tests): visual payload, native writer,
imperative source, source freshness and tick cadence. Cases cover slow motion
accumulation, unchanged coordinate precision, zooming in, wraparound heading,
selection/removal/offset changes, explicit hidden barriers and failed native
submission retries. Device thermal results must be recorded separately.

## Real badge-builder check and overlap tie correction

An additional test feeds 200 uniformly translating vehicles through the actual
`buildFrame` and badge declutter solver. Current badge output is entirely Point
features; obsolete comments about leaders do not describe the implementation.
Initially points reduced 152→51 but badges only 152→141: best-overlap candidate
slots changed on floating-point differences even though relative vehicle
positions were constant. The solver now treats overlap-area differences below
0.001 square style pixels as ties and retains deterministic slot order. Existing
badge placement/collision tests pass. With this correction the actual points and
badge sources each reduce 152→51 native calls over 10 seconds. Slot changes with
meaningful area differences, free-slot selection and return-home clearance
remain unchanged. This additionally removes a source of spurious badge movement.

Final combined verification: all six targeted suites passed, 58 tests total;
TypeScript `tsc --noEmit` passed. Source whitespace checks passed.
