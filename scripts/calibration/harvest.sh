#!/bin/zsh
# Harvest Tram Spotter motion logs from the simulator into the repo every 10 min.
UDID="${HARVEST_UDID:-2AB8E802-E82C-4020-957B-27ACD6D56D73}"
DEST=/Users/acex/git/fable-spots-the-tram/docs/calibration/sim-sessions
while true; do
  C=$(xcrun simctl get_app_container $UDID cz.zabolotny.tramspotter data 2>/dev/null)
  if [ -n "$C" ] && [ -d "$C/Documents/tramspotter-motion/motionlogs" ]; then
    for f in "$C/Documents/tramspotter-motion/motionlogs"/*.jsonl; do
      [ -f "$f" ] || continue
      d="$DEST/sim-$(basename $f)"
      if [ -f "$d" ]; then
        # app truncates its log on relaunch -> MERGE (dedupe lines), never overwrite
        awk '!seen[$0]++' "$d" "$f" > "$d.tmp" && mv "$d.tmp" "$d" && rm -f "$f"
      else
        cp "$f" "$d" && rm -f "$f"
      fi
      # drain the source after a successful merge: the app's motionlog dir has an
      # 8 MB cap (DIR_CAP_BYTES, core.ts) and enforceDirCap() evicts the ACTIVE
      # daily log once it grows past it (only the active ride file is protected)
      # -> everything since the previous harvest is lost. Discovered round 10:
      # holes every ~15-20 min since 08:17 on 2026-07-12 (1-13 min each). With
      # the drain the container file stays ~5 MB/10 min and never hits the cap;
      # the app recreates it on the next flush (~5 s), losing at most one batch.
    done
    date +"%H:%M harvested $(du -sh $DEST | cut -f1)" >> $DEST/harvest.log
  fi
  # keep the app alive (relaunch if it died)
  xcrun simctl launch $UDID cz.zabolotny.tramspotter >/dev/null 2>&1
  sleep 600
done
