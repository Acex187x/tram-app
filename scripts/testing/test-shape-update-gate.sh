#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/../.."
output=$(mktemp -d /tmp/tram-shape-gate.XXXXXX)
trap 'rm -rf "$output"' EXIT
# Shared build arbitration applies even to this tiny native compile.
ios-resource build run -- clang++ -std=c++17 -pthread \
  -I node_modules/@rnmapbox/maps/ios/RNMBX \
  scripts/testing/native/shape-update-gate.cpp -o "$output/test"
"$output/test"
patch --dry-run -R -p1 < patches/@rnmapbox+maps+10.3.2.patch
