# Simulator performance benchmark

This is the reproducible CPU regression check for Tram Spotter. It controls the
iOS Simulator and the app entirely through `simctl`; it does not click, drag,
move the pointer, use AppleScript, or depend on the simulator window being
focused.

The result measures the macOS process that backs the simulated app. Use it to
compare commits and diagnose the long-uptime 100% CPU failure. It does **not**
measure iPhone/iPad temperature, power, or Metal cost faithfully; the Release
device thermal soak in [`performance.md`](performance.md) remains the shipping
gate.

## Run the fixed workloads

Prerequisites:

1. Build/install a current **Debug** simulator app and keep Metro on port 8081.
2. Boot one simulator, or pass its UDID explicitly when more than one is booted.
3. Leave the simulator window untouched during each run. Other host load should
   be comparable between runs.

List booted devices:

```sh
xcrun simctl list devices booted
```

Run each workload for 60 seconds after a 20-second warm-up:

```sh
scripts/perf/simulator-benchmark.sh --device <UDID> --scenario city
scripts/perf/simulator-benchmark.sh --device <UDID> --scenario badges
scripts/perf/simulator-benchmark.sh --device <UDID> --scenario models --sample-stack
```

The script performs a cold **process** restart (`simctl terminate` followed by
`simctl launch`). It deliberately preserves the installed app, permissions,
Golemio data and Mapbox caches: erasing the simulator would mix installation
and cache-fill cost into the steady-state result. A debug-only launch argument
sets the camera without a URL confirmation dialog:

| scenario | centre | zoom | pitch | intended workload |
|---|---:|---:|---:|---|
| `city` | 14.420, 50.082 | 12.0 | 0° | city dots, 5 s pushes, idle between updates |
| `badges` | 14.420, 50.082 | 14.2 | 35° | fast badges just above the detail threshold |
| `models` | 14.420, 50.082 | 16.8 | 55° | close 3D models and 30 Hz simulation |

Each result directory contains:

- `summary.txt`: mean, median, p95 and max process CPU; memory and thread range;
- `samples.csv`: the one-second time series;
- `top.txt`: unprocessed macOS `top` output, including host CPU/load context;
- `metadata.txt`: app/build, Git commit/dirty state, PID, process start and
  uptime before/after measurement;
- `process.sample.txt`: native stack samples when `--sample-stack` was passed.

Repeat every scenario three times and compare the median of the run medians.
Do not compare Debug to Release, different simulator device types/runtimes, or
a quiet host to a host compiling Xcode targets. Simulator `%CPU` can exceed
100: 100% means roughly one host logical core, not “the whole Mac” and not an
iOS thermal percentage.

## Diagnose the long-uptime failure

`--attach` leaves the process and camera untouched. It is the appropriate mode
for a process already showing suspicious CPU in Activity Monitor:

```sh
scripts/perf/simulator-benchmark.sh \
  --device <UDID> \
  --attach \
  --duration 300 \
  --sample-stack \
  --out /tmp/tram-perf-long-lived
```

Then immediately run the same view through a cold process restart and compare
CPU, memory, threads, uptime and the stack reports. A high **cumulative CPU
time** in Activity Monitor does not itself prove a current regression. A stable
near-100% time series from `samples.csv` that collapses after restart does: that
is the long-uptime degradation class tracked in `performance.md`.

Useful quick reads:

```sh
cat /tmp/tram-perf-long-lived/summary.txt
head -30 /tmp/tram-perf-long-lived/metadata.txt
rg -n "MapView|DisplayLink|Mapbox|Hermes|TramEngine" \
  /tmp/tram-perf-long-lived/process.sample.txt
```

The benchmark records process threads and memory because growth there helps
separate listener/timer/allocation leaks from a stable native render loop. JS
engine entry/listener counts are intentionally not polled during the run:
exporting them through React state or a periodic bridge call would perturb the
hot path being measured. Their lifecycle remains covered by unit tests; use an
explicit one-off diagnostic build if the host metrics point to accumulation.

## 2026-07-30 diagnostic snapshot

Environment: build 10 Debug, iPhone 16 Pro simulator on iOS 26.0, 20 s warm-up,
60 one-second samples, fixed Prague cameras above. This was a busy development
host (`load average` roughly 6–10), so these are diagnostic results rather than
permanent pass/fail thresholds:

| scenario | CPU mean | median | p95 | max | memory start → end (peak) | threads |
|---|---:|---:|---:|---:|---:|---:|
| `city` | 13.43% | 10.10% | 28.70% | 42.10% | 663 → 674 MiB (683) | 28–32 |
| `badges` | 44.41% | 44.00% | 57.30% | 65.30% | 755 → 775 MiB (785) | 36–42 |
| `models` | 40.36% | 39.45% | 50.00% | 60.20% | 770 → 794 MiB (801) | 35–36 |

The native `sample` report identified Mapbox's display-link → Metal draw path as
the dominant native stack, not the tram physics loop. Capping Mapbox's preferred
frame rate reduced that stack from 1,804 to 1,180 samples (−34.6%). Against the
same valid fixed-`models` camera before the cap, CPU changed as follows:

| metric | before | after cold run | change |
|---|---:|---:|---:|
| mean | 46.80% | 40.36% | −13.8% |
| p95 | 67.60% | 50.00% | −26.0% |
| max | 78.80% | 60.20% | −23.6% |

No valid fresh-process scenario reached the 100.9% shown in Activity Monitor.
That screenshot's 50 minutes of cumulative CPU time is consistent with a
long-lived process, but cumulative time alone cannot identify current load. The
useful evidence is the live 100.9% reading plus the previously observed
long-uptime degradation that disappears after restart. Use the `--attach` versus
cold comparison above if it reappears; do not treat one Activity Monitor row as
a benchmark.

## Engine-layer micro-benchmark (`scripts/perf/engine-bench.ts`)

The simulator benchmark measures the whole app process; when only the ENGINE
changed, `npx tsx scripts/perf/engine-bench.ts` isolates its CPU in seconds:
150 synthetic trams on 30 shapes, 33 ms ticks with 5 s ingests and staggered
45 s fixes for 60 simulated seconds, in both projection cadences (3 passes
each; compare warm passes). To compare engines across commits, `git worktree
add` the old commit, symlink `node_modules`, copy the script, run in both.

Engine-v2 ship gate (2026-08-01, node 24, M-series host, median warm pass,
ms per simulated second — smaller is better):

| cadence | pre-v2 (`332ad73`) | v2 | change |
|---|---:|---:|---:|
| `coarse` (smooth/raw mode) | 0.82 | 0.55 | **−33%** |
| `full` (live mode) | 1.01 | 0.85 | **−16%** |

The v2 read path also serves bbox-culled reads (`getStatesInBounds`), which
`332ad73` predates (its passes fall back to full `getStates` — ~60 of the
~1 800 loop iterations). The full-app simulator benchmark comparison remains
open: no pre-rewrite baseline was captured before the rewrite landed, so a
true one needs a `332ad73` worktree Debug build (see
`docs/calibration/baselines/gate-v2.md`, criterion 4).

## 2026-08-01 post-v2 reference snapshot

The engine-v2 reference baseline going forward (this closes the "no app-level
baseline" gap for FUTURE comparisons; it is not a pre/post verdict on v2 —
see the paragraph above for why none is possible). Environment: same installed
Debug build as 2026-07-30 (native untouched by v2 — all changes are JS/TS),
Metro serving the v2 working tree, iPhone 16 Pro simulator on iOS 26.0, 20 s
warm-up, 60 one-second samples, 3 runs per scenario. Median-of-run-medians:

| scenario | CPU median (3 runs) | mean range | p95 range | memory end range | threads |
|---|---:|---:|---:|---:|---:|
| `city` | 11.9% (11.7 / 12.05 / 11.9) | 13.3–15.3% | 22.2–27.4% | 667–681 MiB | 27–32 |
| `badges` | 42.2% (40.0 / 42.65 / 42.2) | 40.9–43.3% | 48.6–51.8% | 759–768 MiB | 36–37 |
| `models` | 45.0% (44.1 / 45.85 / 45.0) | 44.5–45.9% | 51.8–54.1% | 790–799 MiB | 35–37 |

Same class as the 2026-07-30 diagnostic snapshot on every axis (different day
and host load — reference, not a comparison): the idle-city invariant holds,
badges sits slightly below the old reading, models slightly above, memory in
the same envelope, no thread growth.
