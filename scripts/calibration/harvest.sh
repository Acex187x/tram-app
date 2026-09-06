#!/bin/zsh
# Caller must own an ios-resource Simulator lease for HARVEST_UDID.
set -eu
: "${HARVEST_UDID:?Set HARVEST_UDID to the exact leased Simulator UDID}"
SCRIPT_DIR=${0:A:h}
exec python3 "$SCRIPT_DIR/harvest.py" --device "$HARVEST_UDID" "$@"
