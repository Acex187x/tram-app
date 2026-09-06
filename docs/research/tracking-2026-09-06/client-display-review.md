# Client display investigation: complete corrections, not only ordinary frames

The old replay excluded revisions marked `discontinuity` from its velocity and
held-time gate. On the immutable post-served five-minute capture this omitted
208 over-budget displayed movements, including 82 backwards corrections. The
largest world displacement was 744 m in one 33 ms frame. Thus the former zero
violation result did not establish smooth display and directly missed the
physical-device report.

The current frame-owned presentation preserves distance, velocity and
acceleration across same-axis revisions. It follows the received target with
25 m/s presentation speed, ±2.5 m/s² correction acceleration and 4 m/s³ jerk
limits. These are presentation correction limits, not a claim about tram
physics. Causal received-curve endpoint lookahead permits gradual stopping.
Trip/incompatible-axis changes and a frame absence over five seconds require
an explicit fade; old and new invisible frames have separate native delivery
acknowledgements. UI reads and background recording cannot consume transitions.
The renderer pauses presentation advancement while required native sources are
busy. Node replay assumes immediately acknowledged delivery; native congestion
and rendering remain separate gates.

A second ownership issue was the client smooth fix-forward shim: a newer AVL
anchor could place the display ahead of a server continuous curve whose next
revision did not inherit that client offset. The resulting behind-target hold
persisted. Only the explicit `continuous-v1` producer capability disables that
smooth shim. Unknown and public legacy producers retain their old semantics;
this compatibility path still has material hold risk on contradictory curves.

## Controlled comparison before live v4 activation

`client-segmented-display.json` retains the complete display counters and source
report hashes. All arms use 833 actually consecutive matched publications,
96 segments, 38 keys, 60 seconds of frame warmup per segment and the same 484
projected GPS observations. A segment ends at a missing publication; generated
previous curves are reset to the recorded initial state only at segment starts.
The sampled server reconstruction is not a recursive whole-fleet counterfactual.

| Arm | GPS MAE, m | Material hold ≥0.5 m gap, vehicle-s | Moving-target-behind hold, vehicle-s | Visible correction jumps |
|---|---:|---:|---:|---:|
| Recorded build31 presentation | 90.83 | 23.73 | 6.03 | 128 |
| New presentation, legacy shim/producer | 96.14 | 1425.60 | 955.90 | 0 |
| Continuous producer, capability | 102.51 | 215.17 | 26.50 | 0 |
| Approach/legacy dwell phase, capability | 101.59 | 32.77 | 9.03 | 0 |
| Request-stop service phase, capability | 90.62 | 68.80 | 9.00 | 0 |

Every new-presentation arm has zero fully-visible acceleration/braking above
2.5 m/s² and jerk above 4 m/s³. The service-phase arm reduces platform crossings
above 5 m/s from 147 to 70; a geometric crossing alone cannot prove a required
stop or real dwell. Its material holds all have less than 10 m gap. Thousands
of seconds in the historical epsilon-hold counter are sub-0.5 m endpoint
residuals and must not be relabeled as large frozen markers.

Mean accuracy alone conceals worse tails: moving GPS p90/p99 rises from
207.46/382.62 m to 220.31/448.96 m. There is only **one** defensible stationary
near-platform pair, and it regresses from 1.4 m error to 97.4 m behind. This is
not a passed product gate.

Three exact cases locate the remaining error upstream of presentation:

| Vehicle / observedAtMs | Display error, m | Received target error, m | Display minus target, m |
|---|---:|---:|---:|
| 9139 / 1788689125000 | −97.435 | −97.602 | +0.167 |
| 9365 / 1788689302000 | −566.557 | −566.650 | +0.093 |
| 9324 / 1788689452000 | +324.776 | +324.671 | +0.105 |

Backend changes to causal phase inference, own-trip pace, the physical ceiling
and ML v4 are being evaluated on a new actual publication chain. They must not
be credited using the older selected-emission figures above. Real stationary
platform pairs, moving tails, both acceleration signs, every reset and hidden
time must all be reported. Raw `AT_STOP` identifies the source's approach/anchor
phase and does not establish that a tram has stopped. Quantized source shape
distance is retained as a proxy; coherent corridor GPS projection is separate.

## Actual geometry receipts and missing-axis world continuity

The raw `new-zero` identity bug found after the first run is now fixed and
covered by two acknowledgement regressions. The repeated complete rerun has
no unrevealed transitions at the end of either window. Cold hidden time drops
14.80→2.67 vehicle-seconds; warm hidden time drops 15.73→6.27. Maximum hidden
run is 0.133 s in every arm (virtual native acknowledgements). Opacity-weighted
visible coverage is 99.9099→99.9838% cold and 99.9634→99.9854% warm. Thus the
relocation reduction below is not obtained by keeping markers permanently
hidden. This still does not establish native delivery or overall product readiness.

`geometry-world-continuity-audit.json` uses the completed 900-second public wire
capture starting at 1788694533625. Geometry arrives at recorded response times;
the first app-origin pack seeds provisional axes and per-trip responses refine
those axes. Later diagnostic pack polls do not retroactively replace them.
There were no capture error events. The harness starts at most one per-trip
request per second with two in flight; this differs from the native scheduler,
and does not prove native HTTP delivery performance.

The build34-era presentation faded on every new GPS coordinate while no valid
axis existed. It also rebased the shown GPS pose directly to the latest model
forecast when geometry arrived, even when the old pose was only a few metres
from the correct route. This explains repeated disappear/reappear teleports
which an ordinary-frame longitudinal audit missed.

The client now keeps bounded signed world P/V/A while geometry is missing.
A unique same-trip stop-corridor projection within 10 m can adopt the first
axis while retaining tangential P/V/A and a C2 lateral residual. Derivative
budgets include the residual, and all articulated/coupled centres receive the
same offset. Missing stopping runway, incompatible velocity, ambiguous
projection and real trip changes retain explicit hidden transitions. A fresh
GPS target does not itself trigger a fade. A return after more than five
seconds still requires the acknowledged hidden transition; it cannot consume
seconds of lateral alignment on its first visible frame.

| Identical candidate publications / actual geometry timeline | Hidden relocations | GPS MAE, m | Material hold, vehicle-s |
|---|---:|---:|---:|
| Cold first 300 s, previous client | 107 | 94.04 | 117.40 |
| Cold first 300 s, world continuity | 18 | 94.27 | 115.07 |
| After 120 s warmup, next 770 s, previous client | 109 | 97.44 | 394.27 |
| After 120 s warmup, next 770 s, world continuity | 46 | 97.52 | 389.67 |

Neither arm has an opaque displacement over the 3 m/frame teleport threshold.
**Hidden relocations still count as unresolved perceived teleports.** The two
windows overlap and their counts must not be added. Their timestamp-scored
observation counts are identical between arms (891 cold, 2496 warm). Missing
and unbracketed axis history is reported separately, not treated as zero error.

Continuity has a material route-missing accuracy cost that the scored GPS mean
cannot show: cold raw-marker separation from the latest received GPS target
has p90 274.7 m and p99 690.6 m; time above 100 m totals 733 vehicle-seconds,
versus 16 before. The previous client achieved its low target separation by
jumping. This measure is receipt-time target lag, not timestamp-matched truth.
Early correct geometry availability remains necessary; smoothing an 1187 m
source correction cannot simultaneously preserve position and adopt it instantly.

World-vector diagnostics also expose an existing route representation limit.
Piecewise GTFS vertices rotate velocity abruptly even when scalar acceleration
is bounded. New continuity can prolong 25 m/s catch-up along those vertices:
maximum actual world acceleration rises from 86 to 144 m/s² in the warm window.
The largest new cases (9445, 9264) have zero lateral residual and no geometry
change; the extra magnitude is path curvature during catch-up. No terminal
clamp with a moving speed label occurs in this captured window. These facts
are not a claim that all possible terminal states or native animations pass.

The longer window also contains 19 defensible near-platform flat GPS pairs.
Their mean error is 241.61/240.64 m, dominated by 9305: 19 distinct source
timestamps retain one coordinate at the first platform while the received
forecast advances to more than 1 km ahead. A parked tram and frozen source GPS
cannot be distinguished from this capture alone. Either interpretation leaves
a conflict with available position evidence; it is an unresolved backend/source
case, not a passed stop-behaviour gate. Two stationary pairs in the cold window
remain unchanged at 14.83 m mean error.

Validation: nine focused suites / 67 tests pass, including 10/30/60 Hz raw
retarget bounds, a 100-second stationary target, nonzero-offset first adoption,
read purity, background return, outgoing raw fade continuity and terminal
runway rejection. Global TypeScript checking passes. Replay assumes accepted
native submissions without congestion; physical-device delivery remains separate.

## Preferred Lab geometry with a public supplement

The candidate build now uses the Lab's geometry pack, with a 3-second hard
transport/body deadline, then requests the ordinary public pack with its
20-second bound. Accepted Lab geometry seeds immediately; the supplement only
fills still-missing trips. Both remain provisional, never overwrite resident
axes, and the ordinary per-trip scheduler runs in parallel. Background/release
cancels both stages, rejects late bodies, and permits the interrupted attempt
to retry on resume. The default public-only build behaviour is preserved.

`preferred-pack-availability-audit.json` retains an actual 180-second paired
capture and 170-second measurement starting at 1788701036388. The same helper
made real Lab→public requests; the control requested only public. Geometry
arrivals are not synthesized or inserted into an older capture. The study
intentionally omits per-trip refinement to isolate pack availability.

Missing-geometry time falls from 3471 to 1799 vehicle-seconds (48.2%). While
geometry is absent, separation from the latest received GPS above 100 m falls
from 653 to 199 vehicle-seconds; its p90 falls from 242 to 116 m. These remaining
lags are material and are not timestamp-matched accuracy. Both arms have zero
hidden relocations/hidden duration, 100% transition-opacity visible coverage
and no unrevealed transitions at measurement end.

All 464 projected GPS observations scored by the control are also available in
the treatment; treatment additionally covers 30. On those identical 464 pairs,
MAE is 80.5481168/80.5482148 m, with identical p90/p99/max and ahead-30m counts.
The only difference is 4.5 cm in one pair. The availability gain is therefore
not being credited through a different accuracy cohort. This is not a claim
that 80 m mean error meets the final product goal.

Observation visibility now ages from the original observation time, independent
of newer publications. Ages 60–120 seconds are explicitly ageing, not broken or
offline, and gently dim from 1 to 0.55. Older observations stay visible at 0.55;
an untrusted clock or invalid/far-future timestamp is unknown. This separate
factor never changes distance, speed, curve horizon or hidden acknowledgements.
Fresh timestamps with a frozen coordinate, such as 9305, require separate source
contradiction handling and cannot be detected by age alone.

## Final bounded gate during build 36

`final-ack-boundary-review.json` records a read-only lifecycle review plus three
isolated assertion probes against the frozen application. Stale acknowledgements
cannot revive a removed/reappearing key or cross an explicit mode change.
Future/fixed diagnostic reads cannot consume the hidden transition. Geometry
arriving during old-zero stays outgoing until acknowledgement, then receives a
separate new-zero token. No additional blocker was found in those boundaries;
this is not a substitute for the parent's native delivery tests.

`no-age-regenerated-display-audit.json` records the separate, rejected research
experiment that suppresses same-anchor age-only publications and regenerates
subsequent producer curves from retained predecessors. All three arms retain
the original 96 windows, 60-second segment warmup, 808,130 measured samples,
26,937.60 vehicle-seconds and identical 484 projected GPS pairs. Baseline / no-age /
no-age-with-leader-repair MAE is 82.32 / 86.10 / 86.91 m; p99 is 366.18 / 395.36 /
395.36 m. Material correction holds improve from 84.97 to 70.10 / 68.93 seconds,
but moving-target-behind holds increase from 10.33 to 23.60 / 22.43 seconds.
Expired-target holds appear for 5.83 seconds in both proposed arms.

All three have zero hidden relocations, zero hidden duration, no unrevealed
transitions and complete transition-opacity coverage. Scalar correction bounds
pass; piecewise-route world-vector peaks remain explicitly included. Geometric
platform crossings above 5 m/s rise from 64 to 67, which alone cannot prove a
missed actual dwell. The offline study retains frozen learned/modal context and
recorded leaders; it is not a full-fleet live counterfactual. Its modest hold gain
does not justify the accuracy and recovery regressions. No suppression policy
was added to the application or deployed backend.
