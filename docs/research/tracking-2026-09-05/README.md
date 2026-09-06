# Tracking investigation, 5 September 2026

The private candidate runs on the user's home IPsec plane. Production is
unchanged. Setup, ports, restart sequence, isolation and device-build flags are
in [lab/isolated/README.md](../../../lab/isolated/README.md).

## Confirmed defects and changes

- Convex heartbeat incremented a sequence without inserting a batch. Heartbeats
  now preserve sequence; stale sweeps publish removals, use the age index and
  preserve predictor-liveness time rather than making cleanup look like a fix.
- Reused Convex query clocks lagged receipt by 2.02s on average in the 61.6-minute
  sample (p90 absolute 4.70s, worst 16.53s). A nonce clock query now forces a fresh
  transaction. Client changes slew the correction and separate diagnostics
  reads from rendered frames.
- ML outage could hold an expired curve indefinitely if its old anchor still
  matched. The fallback gate now includes horizon expiry and malformed inference
  results are treated as an outage. A configured publisher is unhealthy until
  its first successful publication.
- A real departure of vehicle 9402 was misclassified as a traffic jam because
  only the current fix was required to be on_track. Both fixes must now be
  on_track. [Frozen case](jam-9402.json) includes the three observations and
  false 111s hold before the next fix moved about 1.5km along the route.
- The server's hand-maintained seam projection clamped at a shifted horizon,
  while the client coasted. A concrete case put the client at 218m and the server
  floor at 200m. The server now calls the same pure projection/Hermite evaluator.
- Optional knot velocities retain eligible bounded cubic motion; invalid spans
  fall back to the legacy line. Protocol changes were committed separately.
- The geometry cache retained 26,279 lifetime trip objects for a fleet around 170.
  It now retains active trips and retrieves archived geometry by indexed lookup.
  No stored geometry/archive is deleted.
- Debug responses now expose pending work, ML latency/error and publisher health.
  Primary position scores use observation time and confirmed publication history,
  with explicit coverage counters. Older arrival-time series retain their names.
- A delayed ML response could combine its captured older stop observation with
  standing credit from a newer observation received during inference. The local
  candidate rejects superseded observations before constructing a trajectory;
  the next polling cycle uses the latest fix. The race guard and bounded
  one-generation policy inputs/limiter diagnostics were applied to the private
  Lab at 21:49:28Z, with all 153 vehicles healthy by 21:49:55Z. Segment captures
  at 21:50:00Z; this refresh changed neither models nor stop/pace policy.

## ML timestamp and evidence corrections

Old training treated a position observed at 30s and received at 36s as the target
for a 36s prediction. It could also include that same pair's future measured
speed in corridor features. A 300m example encoded 36s and leaked 10m/s. Version 3
encodes 30s and only evidence received before prediction issue. The online feature
order remains 13 columns; both ML service and predictor require version 3.

The original dataset sorted by vehicle key and then time before taking 80/20,
so its described time holdout was not globally chronological. The new dataset
sorts the entire fleet by observation time, keeps equal timestamps together,
purges labels received after the training cutoff and forecasts issued before it.

The final paired export contains 926,598 same-trip, physically plausible pairs
from a fixed 72h window. A single learned-surface snapshot is shared by all
variants. Exact non-corridor feature parity was asserted; the first preliminary
export did not freeze these surfaces and is superseded. All candidates are
asked for the same observation-time horizon using the same available inputs.
These are matched retrained baselines, not the existing production model binary.

| Validation | Observations | v2 MAE | v3 MAE | v2 p90 | v3 p90 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Strict final 20% |185,206|56.06m|49.02m|134.81m|113.82m|
| Entire final 24h |227,892|56.22m|49.13m|135.87m|114.23m|
| Night subset of 24h |25,168|55.92m|50.18m|134.49m|114.74m|

Final 20% signed bias changes −18.28m→−0.16m. That split has no night rows, so
night claims use the separate 24h experiment. Current aggregate learned surfaces
are still used for historical rows; this is a disclosed hindsight limitation.
AVL observation time/shape position remain proxies for real physical location.
Rider GPS is needed to establish absolute street accuracy.

Reports: [primary](ml-clock-evaluation.json), [night-inclusive](ml-clock-night-evaluation.json),
[model hashes](model-artifact-sha256.json). Raw numeric matrices and fitted
artifacts stay outside git under `/tmp/tram-tracking-20260905/`.
`lab/ml/export_evaluation_dataset.py` and `evaluate_clock_candidate.py` reproduce
the experiment with a read-only archive and fixed bounds.

## Downstream stop policy

Published modal releases still added the legacy 5s feed offset to observation
time. This postponed a real departure after the model clock had been corrected.
The approved correction uses the observation epoch while preserving already
standing credit and genuine long timing holds. In a controlled case-enriched
replay of 91 affected pairs, MAE 67.61m→58.42m and p90 162.80m→143.00m, with no
kinematic violations. [Counterfactual](modal-clock-counterfactual.json).
The baseline reconstruction MAE was 1.07m; unrecorded queue leadership remains
a limitation. The correction is deployed only to the private candidate.

The experimental kinematic leg-timing inverse improved only 0.43m MAE in 211
pairs and remains **off**. [Result](leg-timing-final.json). No broad pace or
stop-duration constants were tuned from this narrow sample.

## Captures and runtime validation

Production HTTP capture spans 3,698.6s with no request errors. It has 278,086
sampled vehicle states and 14,484 revisions. Under the published wire's legacy
linear evaluation, 1,877 sampled states held smooth while opinion moved, and 154
had a fresh fix over 60m ahead of a held marker. There were no expired profiles
in this normal-service window, so outage expiry is a regression-tested failure
path rather than an observed cause in that hour. [Full analysis](wire-analysis-final.json).
These are wire-profile findings, not counts of user-visible client guard events.
A separate actual WebSocket capture and paired production/candidate capture are
owned by the client review; their receive times support presentation replay.

Candidate initially started 21:08:43Z. Final frozen models and the modal-clock
fix were applied by a candidate-only restart 21:23:43Z; ML loaded 21:24:01Z and
all 153 vehicles had geometry and successful publications by 21:24:36Z. Use
21:25:00Z onward for stable final-candidate comparisons. Production Lab, ML,
Convex and Watch container identities/start timestamps are unchanged.

At steady state before the final refresh, candidate RSS was approximately
186MB Convex +114MB Lab +202MB ML. These short-run values are not a matched
long-duration memory benchmark. Latest ML batches were 27–48ms and publishing
had no errors. The private deployment has hard 1GB/service limits and its own
native dependency volume; production dependencies are unchanged.

Validation: 8 backend Jest suites / 20 tests, the complete existing drive invariant
suite, 2 Python dataset regressions, and Lab TypeScript checks pass. The candidate
also loaded both persisted models, accepted version 3 and refused version 2, and
served real private WS, clock, publication and geometry-upload traffic.

## Morning continuation, 6 September

At 05:41Z the private candidate had run over eight hours without a restart:
56,932 emissions, zero publication failures, zero ML outage/fallback emissions,
39,372 eligible observation scores, 87 missing and zero beyond-horizon scores.
Lab memory was 182 MiB and ML 123 MiB. Convex reached its initial 1 GiB cap and
used approximately 389 MB swap; it did not OOM or restart, but this needs a
separate capacity correction before interpreting the short-run memory values
above as a delivery budget. Production identities/start times remain unchanged.

The source-coherence gate is now implemented on both sides and deployed to the
private Lab. A proven
invalid axis withdraws only that vehicle's curves, learned anchor and scoring
history. A coherent next fix or corrected geometry restores normal ingestion;
there is no permanent quarantine latch. Eleven backend/shared Jest suites with
36 tests and Lab TypeScript checks pass. Explicit withdrawal also removes an
invalid persisted Convex row after predictor restart, retries a failed removal,
and yields to coherent recovery. Older same-trip fixes cannot quarantine a
newer valid observation.

The capacity correction initially exposed excessive SQLite bootstrap memory:
the old candidate accumulated 106,610 document revisions/303 MB of JSON.
It is preserved in its original volume. The replacement private Convex started
05:56:52Z on a fresh volume, with the same minimal functions/push token, a
rotated admin credential, 2 GiB cap and one-hour MVCC retention. Lab's learned
archive and models were retained. The recovered service published 128 curves,
served a fresh nonce clock at 67 ms RTT, and used 207 MiB Convex memory with
zero swap/pressure events. The recovered instance was stable from 06:00Z; the maintenance
interval is not normal-service evidence. [Recovery procedure](../../../lab/isolated/README.md).

Further controlled policy work and its limitations are recorded in
[downstream attribution](downstream-attribution.md). Broad pace-band changes
remain rejected; a local-horizon alternative for the 9511 tail-pace case has
modest aggregate gains and individual regressions, so it is not silently
promoted as a universally better motion policy.


## Final served-platform correction (6 September)

The native 9128 freeze investigation exposed an extra scheduled dwell for the
same platform already represented by the known modal anchor hold. The separately
committed identity amendment now consumes that occurrence and reuses existing
ML-crossing trim blinding. The [downstream attribution](downstream-attribution.md#duplicate-service-of-the-current-platform)
records the exact screenshot match, conservative identity/sequence/terminal
bounds, paired future-observation metrics, rejected skip-only variant, real
successive-fix validation and explicit residual error regressions.

Only candidate Lab restarted, at **06:39:01.483Z**. Use **06:41Z onward** for
final app validation. Its SHA256 is
`4c6ac240245688496da2cd66551adab3abb8ea761ed29bbf9724a52c446d6d77`.
Convex/ML and all production container identities/start times remained unchanged.
At 06:40:47Z, the candidate had 138 active vehicles, 489 curves published with
zero failures and 22 ms last ML latency. A bounded live probe found 37 admitted
platform profiles, all publication-synced, with zero duplicate platform holds in
either track. This demonstrates deployed behavior, not fleet-wide accuracy.
Eleven focused backend suites (32 tests) and both app/Lab TypeScript checks pass;
root-owned full app testing and the fresh recursive-chain capture are separate.
