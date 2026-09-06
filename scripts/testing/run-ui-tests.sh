#!/bin/bash
set -euo pipefail
: "${IOS_SIMULATOR_UDID:?Set IOS_SIMULATOR_UDID to the exact simulator granted by ios-resource}"
test_root="$(cd "$(dirname "$0")" && pwd)"
test_stamp="$(date +%Y%m%d-%H%M%S)"
test_output="${TRAM_UI_TEST_OUTPUT:-/tmp/tram-ui-tests-$test_stamp}"
mkdir -p "$test_output"
# Requires an already-installed app and an active caller-owned simulator lease.
# The wrapper acquires/releases the single build slot; it never reserves or
# boots an additional simulator and disables Xcode's parallel test clones.
args=(test -project "$test_root/TramSpotterUITests.xcodeproj"
  -scheme TramSpotterUITests -configuration Debug
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID"
  -derivedDataPath "$test_output/DerivedData"
  -resultBundlePath "$test_output/Results.xcresult"
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1
  -collect-test-diagnostics never
  CODE_SIGNING_ALLOWED=NO)
if [[ -n "${TRAM_UI_ONLY_TEST:-}" ]]; then args+=("-only-testing:$TRAM_UI_ONLY_TEST"); fi
if [[ -n "${TRAM_UI_SKIP_TEST:-}" ]]; then args+=("-skip-testing:$TRAM_UI_SKIP_TEST"); fi
set +e
ios-resource build run -- xcodebuild "${args[@]}" 2>&1 | tee "$test_output/xcodebuild.log"
test_status=${PIPESTATUS[0]}
set -e
# xcresult is the authoritative test outcome; attachments are extracted for
# human visual review, not used to turn button assertions into visual claims.
if [[ -d "$test_output/Results.xcresult" ]]; then
  xcrun xcresulttool get test-results summary --path "$test_output/Results.xcresult" > "$test_output/test-summary.json" || true
  xcrun xcresulttool export attachments --path "$test_output/Results.xcresult" --output-path "$test_output/attachments" || true
  if [[ -f "$test_output/attachments/manifest.json" ]]; then
    python3 "$test_root/name-screenshots.py" "$test_output/attachments" || true
  fi
fi
exit "$test_status"
