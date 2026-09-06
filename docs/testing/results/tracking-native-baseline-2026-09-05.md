# Native baseline collection

The existing Release app remained foreground on the leased iPhone 17 Pro Max
simulator (`758B3A6C-34BB-449D-8960-E50A6FC80504`) for 65 minutes, approximately
22:13–23:18 Prague on September 5. The read-only harvester preserved both rotated
files and copied complete lines without deleting the app's live log. Local raw
evidence: `/tmp/tram-night/baseline-motion`; filter `t >= 1788639208676` to exclude
records already present when collection began.

That window contains 85,848 public-state records and 256 distinct vehicle keys.
Observed-fix age at sampling is median 35.435 s, p90 81.419 s and p99 264.466 s.
These ages include repeated observations and terminal vehicles; they are not
network latency measurements. Sparse/old AVL fixes are a substantial part of
the input, so extrapolation must have an explicit horizon and degraded state.

The attached 120-second host-process sample near the end of this session found:

| Metric | Existing Release app |
| --- | --- |
| CPU median / p95 / maximum | 36.05% / 42.60% / 48.60% |
| Resident memory start / end / peak | 557 / 562 / 570 MiB |
| Threads | 34–37 |

Evidence: `/tmp/tram-night/perf-baseline-long-lived`. This is the already-open
close map view, not one of the Debug-only fixed-camera scenarios. Blender and
another simulator were also active on the host. It establishes that the old
process did not exhibit continuous 100% CPU in this interval; it does not
establish candidate performance, a controlled before/after improvement, or
real-device energy behavior. Use the wire replay for rendered-frame comparisons;
these legacy public-state logs do not identify individual native frames.
