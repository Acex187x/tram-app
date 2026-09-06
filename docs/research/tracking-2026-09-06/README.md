# Second tracking investigation, 6 September 2026

This is a research and private-review deployment record. Production has not been
changed. Build31's earlier “zero jumps” metric excluded source-sanctioned
`discontinuity` events; it did not prove visible continuity. The new client audit
includes those events, coordinate displacement, negative speed steps, material
hold gaps and observation coverage.

## Input semantics established from primary sources

Golemio `at_stop` denotes the closest anchor/announced station, not measured zero
speed or open doors. Its DPP integration also handles `ARRIVAL_ANNOUNCED` before
reaching the platform, while retaining the original nearest-anchor distance.
`shape_dist_traveled` is therefore an anchor-distance proxy, not exact GPS truth.

- [Golemio position OpenAPI](https://api.golemio.cz/docs/static/vp-output-gateway/openapi.json)
- [Published Golemio PID5.19.0 PositionsManager source](https://unpkg.com/@golemio/pid@5.19.0/dist/integration-engine/vehicle-positions/workers/vehicle-positions/helpers/PositionsManager.js)
- [PID GTFS data and documentation](https://pid.cz/o-systemu/opendata/)

The first61-minute night capture had6116 distinct `at_stop` fixes;2882 were45–150m
before the exact current platform. Among101 same-platform consecutive `at_stop`
pairs,60 moved at least15m in both reported axis and coordinates; only3 met the
bounded stationary proxy. `lab/scripts/analyze-source-phases.py` reproduces this
classification. Sparse AVL cannot establish every dwell or door event.

The existing request-stop heuristic was also applied to ordinary platforms.
Current official PID GTFS has467635 tram stop-time rows with service0/0 and45556
with3/3. A bounded initial join found362 hypothetical skipped ordinary-platform
occurrences versus62 explicit request occurrences (560 unknown due to selected
trip coverage). These are emitted plans, not proof that each skip was rendered.
The accepted contract now requires `requestOnly===true`, derived from exact
trip/stop/sequence and both service flags3; missing/stale/mixed data stays mandatory.

## New capture and controlled comparisons

`capture-summary.json` records3701.5 seconds of fresh private-candidate diagnostics
with3678 distinct captured policy emissions and no HTTP errors. Client-owned
actual WebSocket streams share byte-identical AVL input receipt times. No candidate
restart or policy change occurred during this hour. Source batch age median8.14s,
p9517.21s,max22.09s; publisher failure counter remainedzero. The observed problems
therefore also occur with a healthy reachable predictor.

Raw files are retained in `/tmp/tram-tracking-r2-20260906`. The offline chain
runner pins generator baseline commit93720af, rather than silently using edited
serving source. `counterfactual-phase-chain.mjs` reads exact captured raw ML/modal/
leader/prior inputs plus separately sampled250m learned surfaces. For the accepted
comparison,833 emissions in96 contiguous source segments are retained; generated
history resets to the recorded predecessor at each segment boundary. Missing
publications are not silently filled with unchanged curves. Shared GPS projection
accepts only the known station corridor within30m of the rail, excluding ambiguous
parallel/lap matches. Coverage and missing GPS observations remain explicit.

The clean implementation matches the phaseService research outputs exactly on
these inputs. Relative to the reconstructed chained baseline, producer GPS MAE:
opinion85.76→78.33m; smooth92.35→93.20m. Client-owned full presentation replay is the
release gate, not this producer-only metric. Its preliminary result sharply lowers
moving-curve-behind-display holds, but worst vehicle tails remain and must be
reported:9139 had a verified stationary proxy with opinion+5m and smooth−98m;
9365 reached smooth−568m after an unusually fast94-second observation interval;
9324 had smooth+325m while opinion was+38m. Large prior error cannot be corrected
both instantaneously and continuously.

The chain uses recorded leader inputs, not a recursively rebuilt whole-fleet
leader model. Consequently collision and phantom-dip counters are not allzero:
for the smooth track, counted collisions64→27 and phantom dips6→33. Curvature
violations remainzero. Added mandatory stops require fresh full-candidate chain
validation before a final product claim. There was onlyone verified stationary
platform pair in the bounded client comparison; no comprehensive dwell-accuracy
claim is justified.

## Model experiment and serving contract

The isolated72-hour export produced863234 forecast pairs with one frozen slow
feature snapshot. The strict final24-hour holdout contains222253 pairs, including
24244 night pairs. Labels are observation-time anchor-distance differences, not
arrival-time positions or precise GPS. Training labels arriving across the split
and holdout issues before the split are purged.

Version4 appends causal own-trip pace/trust/age/ratio, inferred current-platform
offset/known and coordinate-confirmed standing duration.180s is an exponential
half-life, not a hard expiry. Current platform inference uses a unique successor
predecessor because the archive lacks raw current-stop identity; richer live
identity is diagnostic provenance and does not silently alter trained columns.
The shared Python/TypeScript goldens establish numerical parity.

`motion-model-evaluation.json` records v3→v4 MAE46.92→45.35m, with night49.32→48.25m
and on-track45.83→44.03m. This modest forecast gain alone does not establish smooth
motion. Reviewed weights stay isolated; model activation requires the matching
20-column serving version. A missing optional MLP returns null shadow predictions
instead of relabeling the GBDT as a second model.

## Private GTFS metadata bridge

The private Lab still reads production geometry. Optional
`STOP_SERVICE_METADATA_FILE` plus `STOP_SERVICE_REFRESH_SCRIPT` enables a derived
public GTFS overlay without modifying production geometry or credentials. The
bounded Python child refreshes every12h, with a120s process timeout,100MiB ZIP cap
and streaming CSV limits. Source age over36h cannot mark a stop request-only.
Atomic replacement preserves the previous file on download/parser failure.
Summary diagnostics expose source age, refresh status, matched/unmatched stops and
errors. The normal future production path is the shared geometry converter's
optional field and its existing cache refresh.


## Subsequent parity and runtime checks

The existing `FUSE_FIX_AXIS` preprocessing runs before archiving, learned updates,
ML feature construction and opinion generation. Accordingly both model labels and
v4 own-trip pace use that fused axis, while the preserved WebSocket files retain
original provider values. Neither axis is relabeled exact GPS ground truth.

A real-input audit found an older training/serving defect: Python looked at stored
slow-cell weight, while TypeScript decayed trust over 14 days at the lookup time.
Of 1,770 matched real-anchor lookups, 87 differed (75 pace, 12 release). One 9139
release lookup was 41.58 seconds in Python and the 20-second fallback in TypeScript.
The corrected extractor now mirrors TypeScript; shared threshold/fallback fixtures
pass in both languages. Re-export and matched retraining retain 863,234 rows and
222,253 holdout pairs, with v3→v4 MAE 46.76→45.23 m and night MAE 49.38→48.41 m.
These are new frozen-snapshot experiments, not a controlled comparison between
old and new live learned states.

The real motion-feature parity fixture checks 13,230 values from 378 fixes and 23
actual learned-pace callbacks exactly. Separately, 91 actual served 20-column rows
reconstruct the published ML targets with 0.00 m difference after the documented
anchor/monotonicity transform. Those same rows through the corrected model's HTTP
server match native prediction within 0.05 m, explained by 0.1 m wire rounding.
See `served-row-validation.json`; numerical parity does not establish GPS accuracy.

Content keys now prevent the cold-start pack from conflating reused provider
`shapeId` values. The key preserves provider identity and hashes the coordinate,
distance and ordered-platform axis. Sibling timetable epochs are excluded; the
client must still refine provisional per-trip metadata. Actual cached geometries
were exported per trip for all 249 trips in the first live-v4 capture, rather than
using a deduplicated pack as authoritative evidence.

The private Convex process reached its 2 GiB cap with about 330 MB swapped, despite
healthy retention (94 current batches spanning 341 seconds; 22,832 MVCC revisions,
81 MB JSON; query cache about 105 MB, V8 heap 80 MB and three WebSockets). These
exposed counts do not explain all anonymous memory. At 11:10:01Z its cap increased
to 3 GiB without restart, preserving a 4 GiB memory-plus-swap limit. No additional
memory.max events occurred in the immediate observation; this mitigates pressure,
it is not a demonstrated leak fix. Candidate and production container identities
and exact deployment boundaries are retained in `candidate-deployment.json`.

## Historical tails and rejected recovery policies

Reconstructed v4 requests for the original 833 emissions improve smooth GPS MAE
92.40→89.35 m over 627 paired observations. Their feature rows are approximate:
slow cells were frozen later, producer receipt time substitutes for unavailable
Lab receipt time, corridor history starts empty, and archived removals are missing.
They therefore support sensitivity analysis, not exact historical-model attribution.
The known tails remain: 9139 at the stationary-platform observation is 89 m behind,
9324 is 324 m ahead, and 9365 is 352/250 m behind on its two fast-running observations.

A measured-pace catch ceiling lowers aggregate MAE to 88.11 m, but introduces three
new on-track errors beyond 30 m ahead and two absolute-error regressions over 30 m.
A separate ahead-only prototype admits two receipt-available projected observations
on the same axis with errors over 100 m, keeps existing physical constraints, and
adds a stronger yield cap. It barely changes MAE (89.35→89.28 m) while adding four
midstreet correction holds of 14, 14, 19 and 39 seconds and one infeasible planned
stop. All such holds remain counted; none are renamed traffic jams. The 39-second
case has measured motion at 3.45 m/s, so it cannot be justified as an observed stop.
Both policies were rejected for activation. See `recovery-experiments-rejected.json`.

The earlier 1,000-second estimate for 9324 describes closing a gap at one local
3.3−3.0 m/s plateau, not its complete future stop plan. In its next emitted profile,
the baseline reaches within 30 m of the opinion in 73 seconds at a platform;
the stronger-yield prototype does not improve that horizon convergence. Future
profile convergence is itself a prediction, not observed geographic accuracy.

The modal `releaseStats` lookup also used undecayed trust even though `releaseAt`
and `dwellStats` decay it. Protocol e8cc7f6 resolves that discrepancy with the same
14-day half-life and unchanged fallback distribution (20±12 s). Shared fixtures
check both lookup forms against Python release features; 22 focused backend tests
and the Python parity test pass. Only this correction was activated at 12:48:07Z.
The model and Convex process were not restarted. Public production was unchanged.

Remaining gates are explicit: long-tail geographic errors and stationary-platform
coverage are still incomplete; historical counterfactual leaders are recorded,
not recomputed; native every-frame correction metrics belong to the client report.
Convex anonymous memory continued growing to 2.52 GiB under its 3 GiB cap with no
new pressure/OOM events. This remains an operational limitation, not a solved leak.

The subsequent read-only investigation of origin waiting, a 151-second successful
public ingestion gap, and repeated production calibration-compaction timeouts is
in [origin-and-source-freshness.md](origin-and-source-freshness.md). The candidate
was not changed in that round. Its latest verified runtime hashes, process start
times, publisher counters and remaining memory headroom are recorded separately
under `latestReadOnlyVerification` in `candidate-deployment.json`.
