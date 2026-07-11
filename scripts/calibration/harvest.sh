#!/bin/zsh
# Harvest Tram Spotter motion logs from the simulator into the repo every 10 min.
UDID=2AB8E802-E82C-4020-957B-27ACD6D56D73
DEST=/Users/acex/git/fable-spots-the-tram/docs/calibration/sim-sessions
while true; do
  C=$(xcrun simctl get_app_container $UDID cz.zabolotny.tramspotter data 2>/dev/null)
  if [ -n "$C" ] && [ -d "$C/Documents/tramspotter-motion/motionlogs" ]; then
    for f in "$C/Documents/tramspotter-motion/motionlogs"/*.jsonl; do
      [ -f "$f" ] || continue
      d="$DEST/sim-$(basename $f)"
      if [ -f "$d" ]; then
        # app truncates its log on relaunch -> MERGE (dedupe lines), never overwrite
        awk '!seen[$0]++' "$d" "$f" > "$d.tmp" && mv "$d.tmp" "$d"
      else
        cp "$f" "$d"
      fi
    done
    date +"%H:%M harvested $(du -sh $DEST | cut -f1)" >> $DEST/harvest.log
  fi
  # keep the app alive (relaunch if it died)
  xcrun simctl launch $UDID cz.zabolotny.tramspotter >/dev/null 2>&1
  sleep 600
done
