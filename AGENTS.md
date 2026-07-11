# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Project orientation

Tram Spotter — real-time Prague trams on a 3D Mapbox map (Expo SDK 57, iOS-only).
Start with `docs/README.md` (index), then `docs/architecture.md`. Hard-won platform
quirks live in `docs/decisions/map-rendering.md` and `docs/performance.md` —
**read the performance invariants before touching map/engine/hooks code.**

# Physics calibration loop

If asked to "collect data and improve the physics" (any wording): follow the runbook in
`docs/calibration/plan.md` — it is self-contained (simulator collection via
`scripts/calibration/harvest.sh`, analysis methodology in `docs/calibration/analysis-*.md`,
which engine constants to tune, and the replay-validation gate required before every
commit). Time-of-day behavior matters: peaks are slow (boarding + traffic), nights are
fast — learned values belong in `TOD_PACE_TABLE`/`TOD_DWELL_TABLE`, not hardcoded hacks.
