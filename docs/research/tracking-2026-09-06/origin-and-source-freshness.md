# Origin waiting and successful-ingest freshness, 6 September

Read-only investigation. No production or candidate policy was changed for these findings.

## Fleet-wide pause at 13:08–13:11 UTC

The public fleet's last successful poll was 13:08:45.807. The actual WebSocket capture received no newer batch until 13:11:17.080, when 180 changed vehicles arrived with a newest observation at 13:11:08. Subsequent batches were fresh. A snapshot at 13:11:13 therefore caught the final seconds of a roughly 151-second successful-ingest gap, rather than an ongoing outage observed at 13:15.

The initial WebSocket seed showed generation 731. The 13:11:13 snapshot showed generation 732, 731 restarts, zero consecutive failures, last successful poll still 13:08:45.807, and last poll heartbeat 13:11:08.671. The watchdog writes that heartbeat when scheduling a replacement loop. Thus a recently updated heartbeat and zero recorded fetch failures did not establish successful ingestion. A fresh private predictor publication likewise did not establish a fresh vehicle observation: all 187 observations in that snapshot were 150–286 seconds old.

A direct authenticated Golemio request at 13:15:33 returned 192 trams with minimum/median/maximum observation ages 2.4/30.4/221.4 seconds and CDN Age 0. It confirms recovery, but cannot prove upstream health during the earlier gap. The deployed source writes `lastOkAtMs` after every successful `applyPoll`, even if the upstream positions have not changed. Both the public query and WebSocket evidence therefore support a successful-ingest interruption; its exact initiating exception remains unknown.

Bounded production logs from 13:07:00–13:11:18 contain 12 isolate restarts attributed to `calibration/bundle.js:compact`, repeatedly exhausting the 15-second system-call budget while scanning roughly 3,000 rows. The compactor currently reads up to 12,000 stats rows in one mutation. This is a demonstrated maintenance failure and plausible competing load, **not a proven cause of the poller interruption**. Later watchdog OCC conflicts occurred after recovery and do not establish causation. A future correction should page the compaction reads and bound each transaction, preserving an atomic final bundle publication; lowering the sample budget would silently change calibration coverage.

Neither switching between predictors that share the same AVL feed nor treating a new curve timestamp as a new observation solves this incident. Per-vehicle observation age and the last successful ingest must remain separate from socket, heartbeat, and publication health.

A concrete follow-up for the compactor is a single hourly job with at most one
250-row page read in flight, the existing 3,000/6,000/3,000 table budgets,
deduplication by document identity, and a fixed job epoch for weight decay.
Compile the bounded accumulated input with the unchanged floors, ranking and
shrinkage formulas, then publish the final bundle in one small mutation. Failed
or superseded jobs retain the previous bundle, and a bounded cleanup removes
only their own staging records. Pagination over a changing `by_updated` index
does not create a historical database snapshot: stable cursor/admission rules
and tests for concurrent updates are required before implementation. Tests must
compare paged and current compilation on identical frozen inputs, interruption
and duplicate-page recovery, bounded reads, and no partial bundle publication.
This proposal was not implemented or deployed; it does not justify restarting
or disabling production maintenance without separate review.

## Vehicle 9305: fresh epochs at the origin

Trip `25_18307_260718` repeatedly reported `ON_TRACK`, shape distance zero, the same GPS coordinate `[14.32279, 50.07555]`, first platform `U31Z3P` sequence 1, and next platform `U364Z1P` sequence 2. The served route agrees with those identities. GPS was 5.4 m from the route origin, Bílá Hora; this is not the earlier wrong-axis or projection-clamping failure.

The measured client window contains 19 distinct observation epochs from 11:43:25 through 11:49:14, but one coordinate. The later bounded public-observation archive contains 21 such fixes through 11:58:53. At 11:59:47, the vehicle progressed to the next platform at distance 656 m, then continued normally. Its AVL next-stop arrival was 11:59:00 throughout the initial wait. This is consistent with an origin layover followed by departure; repeated GPS alone cannot prove physical stationarity rather than an upstream frozen position. The geometry's cached timetable was a day old and was excluded from this inference.

The current generator has a semantic gap: near-platform observations are excluded from jam evidence, while ordinary modal dwelling requires `AT_STOP`. An `ON_TRACK` origin wait therefore supplies neither hold. Repeated new observation timestamps can keep refreshing an unsupported departing forecast; actual displayed error grew past 1 km despite all received positions remaining at the origin.

## Admission experiment and counterexample

A read-only scan used only geometry already received in the paced capture. It examined 3,265 distinct fixes; 2,652 had available per-trip geometry. A narrow trial required exact unique first/second platform identities and sequences, two observations 5–120 seconds apart with at most 3 m GPS and projected-axis movement, a current position within 30 m of the origin, age at receipt at most 45 seconds, and a future **AVL** next-stop arrival.

It admitted 14 pairs for 9305 and one for 9257, and rejected 25 moving-origin pairs. This is coverage evidence, not a false-hold rate. The 9257 case is a material counterexample to holding until the next measured departure: it was at the origin at 11:40:11, its AVL next arrival was 11:41:00, and the next observation at 11:41:01 was already 336 m ahead. That observation arrived at 11:41:12. A strict wait-for-departure policy would hold about 51 seconds after admission and then need to recover a 336 m deficit.

Consequently the broad pair-based origin hold was **not activated**. The long-wait 9305 case has 10–16 minutes of advertised time before the first downstream platform, unlike 9257's 49 seconds. Any narrower origin policy must account for the first-leg travel budget, explicitly expire stale evidence, preserve bounded acceleration and the continuous presentation seam, and be tested against ordinary departures. Cached timetable or the `AT_STOP` label alone must not stand in for evidence of stationarity.

## Removing forecast renewals is not automatically a motion fix

An hour of actual receipt history contained 12,427 consecutive same-trip fix
gaps: median 48 s, p90 83 s, p95 102 s and p99 155 s. Of these, 332 exceeded
120 s; observations older than 120 s occupied 3.02% of vehicle-seconds. The
paced 15-minute capture was similar (3.34%). A 45- or 60-second hard prediction
stop would therefore interrupt many ordinary journeys.

The server currently refreshes a same-anchor prediction every 60 seconds and
requests another 120 seconds from the current computation time, plus padding.
Stopping refreshes only once the anchor is 120 seconds old would still leave
the last permitted track ending roughly 230–250 seconds after that anchor. It
would be a finite bound, not an original 120-second forecast bound.

A complete same-anchor suppression experiment removed 1,271 of 4,537 received
updates while preserving their original sequence envelope. On the same client
and 2,484 geographic references, display MAE increased 97.52→101.16 m and
material holds increased 389.7→1,260.6 vehicle-seconds. This input-removal test
retains the actual next-fix producer predecessors, so it is not a regenerated
chain and cannot by itself decide the producer policy.

The subsequent producer experiment regenerated all 833 captured publications
inside the same 96 contiguous segments, resetting the predecessor at each
segment boundary and carrying the generated predecessor thereafter. Both arms
used identical reconstructed 20-column ML input, sampled frozen learned cells,
captured modal parameters and recorded leader curves. The conservative variant
kept two same-anchor repairs where a changed leader would otherwise intersect
the retained follower, suppressing 201 age-only emissions. On 490 geographic
references inside the 60-second-warmed windows, target MAE increased
82.55→87.16 m and p99 absolute error 358→395 m. There were 32 regressions above
30 m versus 11 improvements, and four references beyond the retained track's
endpoint. The earlier stationary 9139 case worsened from −91.8 to −120.4 m.
No curve-speed or mid-segment-stop violation was introduced, but those checks
do not establish that the display avoids holds. This is a paired approximate
producer study, not a reconstruction of every current production ML request
or a whole-fleet counterfactual.

No age-suppression policy was activated. Observation-age visibility and a
bounded prediction controller are separate changes; the former must not be
presented as having solved unsupported forecast renewal.

The final client replay of these **regenerated** chains used identical 96
windows, 808,130 measured frames, 26,937.6 vehicle-seconds and 484 geographic
references. Baseline → no-age → no-age-with-leader-repair display MAE was
82.32 → 86.10 → 86.91 m; p99 was 366.18 → 395.36 → 395.36 m. Material guard
holds improved 84.97 → 70.10 → 68.93 vehicle-seconds, while holds behind a
moving target worsened 10.33 → 23.60 → 22.43 seconds. Effective-horizon holds
increased from zero to 5.83 seconds. All three arms had zero hidden
relocations, zero hidden duration and 100% sampled presentation coverage.
Passing platform markers above 5 m/s increased 64→67; this describes map
motion, not verified missed boarding. The mixed result and worse geographic
tails do not justify activation. The earlier severe hold regression from
input removal must not be substituted for this more causal result.

## Evidence retained locally

- `/tmp/tram-r3-source-timeline.json`: actual WebSocket pause and recovery.
- `/tmp/tram-r3-pack-lab-snapshot/fleet.json`: stale fleet and poller metadata at actual receipt.
- `/tmp/tram-r3-upstream-freshness.json`: safe timestamp-only direct upstream probe.
- `/tmp/tram-r3-poller-gap-logs.json`: bounded, credential-filtered compactor timeout evidence.
- `/tmp/tram-r3-9305-source.json` and `/tmp/tram-r3-9305-extended-observations.json`: exact source coordinates, identities, and later departure.
- `/tmp/tram-r3-origin-study.json` and `/tmp/tram-r3-9257-origin-events.json`: admission coverage and counterexample.

These are source/target diagnostics. They do not establish new physical ground truth, a globally bounded world-vector acceleration/jerk guarantee, or acceptance of a new runtime policy.
