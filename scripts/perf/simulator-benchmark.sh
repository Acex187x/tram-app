#!/usr/bin/env bash
# Repeatable, mouse-free CPU benchmark for the iOS Simulator build.
#
# This measures the host process that backs the simulated app. It is useful for
# regressions and long-uptime diagnosis; it is not a substitute for the Release
# device thermal soak documented in docs/performance.md.

set -euo pipefail

APP_BUNDLE_ID="cz.zabolotny.tramspotter"
SCENARIO="models"
DEVICE_ID=""
DURATION_SECONDS=60
WARMUP_SECONDS=20
SAMPLE_INTERVAL_SECONDS=1
OUTPUT_DIR=""
ATTACH_ONLY=0
CAPTURE_STACK=0

usage() {
  cat <<'EOF'
Repeatable, mouse-free CPU benchmark for the iOS Simulator build.

This measures the host process that backs the simulated app. It is useful for
regressions and long-uptime diagnosis; it is not a substitute for the Release
device thermal soak documented in docs/performance.md.

Usage:
  scripts/perf/simulator-benchmark.sh [options]

Options:
  --scenario city|badges|models  Fixed camera workload (default: models)
  --device UDID                  Booted simulator UDID (required if ambiguous)
  --duration SECONDS             Measurement window after warm-up (default: 60)
  --warmup SECONDS               Settling time after cold process launch (default: 20)
  --interval SECONDS             CPU sample interval (default: 1)
  --out DIRECTORY                Result directory (default: /tmp/tram-perf-...)
  --attach                       Measure the current process; do not restart/reposition
  --sample-stack                 Capture an 8 s macOS `sample` report after measurement
  -h, --help                     Show this help

Examples:
  scripts/perf/simulator-benchmark.sh --device <UDID> --scenario city
  scripts/perf/simulator-benchmark.sh --device <UDID> --scenario models --sample-stack
  scripts/perf/simulator-benchmark.sh --device <UDID> --attach --duration 300
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)
      [[ $# -ge 2 ]] || die "--scenario needs a value"
      SCENARIO="$2"
      shift 2
      ;;
    --device)
      [[ $# -ge 2 ]] || die "--device needs a value"
      DEVICE_ID="$2"
      shift 2
      ;;
    --duration)
      [[ $# -ge 2 ]] || die "--duration needs a value"
      DURATION_SECONDS="$2"
      shift 2
      ;;
    --warmup)
      [[ $# -ge 2 ]] || die "--warmup needs a value"
      WARMUP_SECONDS="$2"
      shift 2
      ;;
    --interval)
      [[ $# -ge 2 ]] || die "--interval needs a value"
      SAMPLE_INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || die "--out needs a value"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --attach)
      ATTACH_ONLY=1
      shift
      ;;
    --sample-stack)
      CAPTURE_STACK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$SCENARIO" in
  city|badges|models) ;;
  *) die "scenario must be city, badges, or models" ;;
esac
is_positive_integer "$DURATION_SECONDS" || die "duration must be a positive integer"
is_positive_integer "$SAMPLE_INTERVAL_SECONDS" || die "interval must be a positive integer"
[[ "$WARMUP_SECONDS" =~ ^[0-9]+$ ]] || die "warmup must be a non-negative integer"

command -v xcrun >/dev/null || die "xcrun is required"
command -v python3 >/dev/null || die "python3 is required"

if [[ -z "$DEVICE_ID" ]]; then
  BOOTED_IDS="$(
    xcrun simctl list devices booted -j | python3 -c '
import json, sys
data = json.load(sys.stdin)
for devices in data["devices"].values():
    for device in devices:
        if device.get("state") == "Booted":
            print(device["udid"])
'
  )"
  BOOTED_COUNT="$(printf '%s\n' "$BOOTED_IDS" | awk 'NF { count += 1 } END { print count + 0 }')"
  [[ "$BOOTED_COUNT" -eq 1 ]] ||
    die "found $BOOTED_COUNT booted simulators; select one with --device UDID"
  DEVICE_ID="$BOOTED_IDS"
fi

xcrun simctl list devices booted | grep -Fq "$DEVICE_ID" ||
  die "simulator $DEVICE_ID is not booted"
APP_CONTAINER="$(xcrun simctl get_app_container "$DEVICE_ID" "$APP_BUNDLE_ID" app 2>/dev/null)" ||
  die "$APP_BUNDLE_ID is not installed on $DEVICE_ID"
BUILD_NUMBER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_CONTAINER/Info.plist" 2>/dev/null || echo unknown)"
SHORT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_CONTAINER/Info.plist" 2>/dev/null || echo unknown)"
BUILD_KIND="Release"
[[ -e "$APP_CONTAINER/TramSpotter.debug.dylib" ]] && BUILD_KIND="Debug"
if [[ "$ATTACH_ONLY" -eq 0 && "$BUILD_KIND" != "Debug" ]]; then
  die "fixed camera launch arguments require a Debug simulator build (installed: $BUILD_KIND)"
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SCENARIO}"
if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="/tmp/tram-perf-$RUN_ID"
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

find_app_pid() {
  ps -axo pid=,command= | awk \
    -v device_marker="/CoreSimulator/Devices/$DEVICE_ID/" \
    -v executable_suffix="/TramSpotter.app/TramSpotter" '
      index($0, device_marker) && index($0, executable_suffix) {
        if (!found) print $1
        found = 1
      }
    '
}

if [[ "$ATTACH_ONLY" -eq 0 ]]; then
  # "Cold" here means a brand-new app process with the installed app/data and
  # Mapbox caches preserved. Erasing the simulator would benchmark installation,
  # permissions and cache fill instead of steady app work.
  xcrun simctl terminate "$DEVICE_ID" "$APP_BUNDLE_ID" >/dev/null 2>&1 || true
  # A custom URL cold launch triggers an iOS 26 confirmation alert. Native
  # launch arguments are fully CLI and land in NSUserDefaults' argument domain;
  # the debug-only map hook reads TramPerfScenario through RN Settings.
  LAUNCH_OUTPUT="$(xcrun simctl launch --terminate-running-process "$DEVICE_ID" \
    "$APP_BUNDLE_ID" -TramPerfScenario "$SCENARIO" -TramPerfRun "$RUN_ID")"
  APP_PID="${LAUNCH_OUTPUT##*: }"
  [[ "$APP_PID" =~ ^[0-9]+$ ]] || APP_PID="$(find_app_pid)"
  [[ -n "$APP_PID" ]] || die "app process did not appear within 30 s"
  DEEP_LINK="(none: simctl launch arguments)"
else
  APP_PID="$(find_app_pid)"
  [[ -n "$APP_PID" ]] || die "no running app process found for $DEVICE_ID"
  DEEP_LINK="(attach: camera unchanged)"
fi

PROCESS_START="$(ps -p "$APP_PID" -o lstart= | sed 's/^ *//')"
PROCESS_UPTIME_START="$(ps -p "$APP_PID" -o etime= | tr -d ' ')"

{
  echo "run_id=$RUN_ID"
  echo "device_id=$DEVICE_ID"
  echo "bundle_id=$APP_BUNDLE_ID"
  echo "app_version=$SHORT_VERSION ($BUILD_NUMBER)"
  echo "build_kind=$BUILD_KIND"
  echo "mode=$([[ "$ATTACH_ONLY" -eq 1 ]] && echo attach || echo cold-process-restart)"
  echo "scenario=$([[ "$ATTACH_ONLY" -eq 1 ]] && echo unchanged || echo "$SCENARIO")"
  echo "deep_link=$DEEP_LINK"
  echo "pid=$APP_PID"
  echo "process_start=$PROCESS_START"
  echo "process_uptime_before_warmup=$PROCESS_UPTIME_START"
  echo "warmup_seconds=$WARMUP_SECONDS"
  echo "duration_seconds=$DURATION_SECONDS"
  echo "sample_interval_seconds=$SAMPLE_INTERVAL_SECONDS"
  echo "git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "git_dirty=$([[ -n "$(git status --short 2>/dev/null)" ]] && echo true || echo false)"
  echo "host_logical_cpus=$(sysctl -n hw.logicalcpu)"
  echo "host_load_before=$(uptime | sed 's/^ *//')"
} > "$OUTPUT_DIR/metadata.txt"

echo "Tram Spotter simulator benchmark"
echo "  device:   $DEVICE_ID"
echo "  app:      $SHORT_VERSION ($BUILD_NUMBER), $BUILD_KIND, pid $APP_PID"
echo "  workload: $([[ "$ATTACH_ONLY" -eq 1 ]] && echo attached-current-view || echo "$SCENARIO")"
echo "  output:   $OUTPUT_DIR"

if [[ "$WARMUP_SECONDS" -gt 0 ]]; then
  echo "  warm-up:  ${WARMUP_SECONDS}s"
  sleep "$WARMUP_SECONDS"
fi
kill -0 "$APP_PID" 2>/dev/null || die "app exited during warm-up"
MEASUREMENT_START_EPOCH="$(date +%s)"
{
  echo "measurement_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "process_uptime_at_measurement_start=$(ps -p "$APP_PID" -o etime= | tr -d ' ')"
} >> "$OUTPUT_DIR/metadata.txt"

SAMPLE_COUNT="$(awk -v duration="$DURATION_SECONDS" -v interval="$SAMPLE_INTERVAL_SECONDS" \
  'BEGIN { count = int(duration / interval); if (count < 1) count = 1; print count }')"
RAW_TOP="$OUTPUT_DIR/top.txt"
CSV="$OUTPUT_DIR/samples.csv"

echo "  measure:  ${DURATION_SECONDS}s (${SAMPLE_COUNT} samples)"
# top's first process sample has 0.0 CPU because it has no preceding delta.
# Request one extra iteration and discard that bootstrap row.
LC_ALL=C top -l "$((SAMPLE_COUNT + 1))" -s "$SAMPLE_INTERVAL_SECONDS" \
  -pid "$APP_PID" -stats pid,cpu,time,threads,mem > "$RAW_TOP"

awk -v pid="$APP_PID" -v interval="$SAMPLE_INTERVAL_SECONDS" '
  BEGIN { print "sample,elapsed_s,cpu_percent,cpu_time,threads,memory" }
  $1 == pid {
    seen += 1
    if (seen == 1) next
    gsub(/%/, "", $2)
    gsub(/[-+]$/, "", $5)
    split($4, thread_parts, "/")
    sample += 1
    printf "%d,%.3f,%s,%s,%s,%s\n", sample, sample * interval, $2, $3, thread_parts[1], $5
  }
' "$RAW_TOP" > "$CSV"

MEASURED_COUNT="$(( $(wc -l < "$CSV") - 1 ))"
[[ "$MEASURED_COUNT" -eq "$SAMPLE_COUNT" ]] ||
  die "expected $SAMPLE_COUNT samples, got $MEASURED_COUNT (did the app exit?)"

python3 - "$CSV" "$OUTPUT_DIR/summary.txt" <<'PY'
import csv
import math
import statistics
import sys

csv_path, summary_path = sys.argv[1:]

def bytes_from_top(value: str) -> int:
    suffixes = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}
    value = value.strip().rstrip("-+")
    if value[-1:].upper() in suffixes:
        return int(float(value[:-1]) * suffixes[value[-1].upper()])
    return int(float(value))

def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]

with open(csv_path, newline="") as source:
    rows = list(csv.DictReader(source))

cpu = [float(row["cpu_percent"]) for row in rows]
memory_mib = [bytes_from_top(row["memory"]) / 1024**2 for row in rows]
threads = [int(row["threads"]) for row in rows]

lines = [
    f"samples={len(rows)}",
    f"cpu_mean_percent={statistics.fmean(cpu):.2f}",
    f"cpu_median_percent={statistics.median(cpu):.2f}",
    f"cpu_p95_percent={percentile(cpu, 0.95):.2f}",
    f"cpu_max_percent={max(cpu):.2f}",
    f"memory_start_mib={memory_mib[0]:.1f}",
    f"memory_end_mib={memory_mib[-1]:.1f}",
    f"memory_peak_mib={max(memory_mib):.1f}",
    f"threads_min={min(threads)}",
    f"threads_max={max(threads)}",
]
text = "\n".join(lines) + "\n"
with open(summary_path, "w") as destination:
    destination.write(text)
print(text, end="")
PY

MEASUREMENT_END_EPOCH="$(date +%s)"
{
  echo "process_uptime_at_measurement_end=$(ps -p "$APP_PID" -o etime= | tr -d ' ')"
  echo "measurement_wall_seconds=$((MEASUREMENT_END_EPOCH - MEASUREMENT_START_EPOCH))"
  echo "host_load_after=$(uptime | sed 's/^ *//')"
} >> "$OUTPUT_DIR/metadata.txt"

if [[ "$CAPTURE_STACK" -eq 1 ]]; then
  echo "  stack:    sampling pid $APP_PID for 8s"
  sample "$APP_PID" 8 1 -file "$OUTPUT_DIR/process.sample.txt" \
    > "$OUTPUT_DIR/sample-command.txt" 2>&1 || true
fi

echo "Result: $OUTPUT_DIR/summary.txt"
