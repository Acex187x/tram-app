# Build 36 review candidate — 6 September 2026

Status: build36 installed on iPhone17Pro at15:46 CEST and read back. iPhone simulator full suite passed7 tests (one iPad-only skip); iPad passed7 with rotation still under system-level investigation. Build37 supersedes36 with a newly found timeline-label correction.

## Included changes

- Raw GPS corrections retain bounded world position/velocity/acceleration. First-axis adoption requires an unambiguous corridor, bounded residual and braking runway. Raw new-zero identity transitions no longer generate a fresh token forever.
- Candidate geometry prefers the direct Lab pack with a three-second deadline, then public fallback/supplementation. Resident preferred/authoritative geometry wins; cancellation prevents late seeding.
- Observation age has independent fresh/aging/stale/unknown presentation, with a separate nonzero opacity factor. Fresh publisher heartbeats cannot renew observation age. This changes uncertainty display, not motion or stop decisions.
- KT8D5 middle glazing/waist and single-arm collectors are rebuilt from the operator photographs. Dimensions are reference-derived, not a CAD accuracy claim.
- Local vehicle-specific skins support Files import, compatible registration assignment, preview, replacement and reset. The companion UV authoring tool preserves all seven base geometries and moving doors. No real advertising roster or synthetic assignment is shipped.

## Fixed-input evidence

On a fresh 170-second replay with identical AVL/curve receipts, actual sequential Lab→public helper calls reduced missing-geometry vehicle-time from3471 to1799seconds, and raw fallback target lag over100m from653 to199seconds. Both arms had100% visible coverage, no hidden relocations and no unrevealed vehicles at the end. This experiment did not simulate later per-trip refinement.

All464 common projected-GPS observations had effectively identical error: MAE80.54812→80.54821m; p90/p99/max and the count ahead by30m were unchanged. Treatment covered30 additional observations, excluded from that paired comparison. Remaining raw fallback p90target lag was116m, so this is an improvement in route availability, not proof of complete tracking accuracy.

The earlier longer receipt-timed capture still contains incompatible transitions, stationary errors and sharp polyline corners. World derivative bounds for added correction do not make every rail vertex smooth. Source GPS can be sparse or stale, and fresh timestamps at an origin do not prove departure. In particular9305's long BíláHora layover exposed an unresolved server prediction error.

Removing all same-anchor server refreshes was tested and rejected: the simple filtered replay increased material holds from389.7 to1260.6vehicle-seconds and MAE97.52→101.16m. A regenerated-chain arm used96 matched windows and484 commonGPS observations: MAE82.32→86.91m, material holds84.97→68.93s, but moving-target-behind holds10.33→22.43s and expired-target holds0→5.83s. This mixed result also failed acceptance. Neither policy is activated. Client fading is not a fix for unsupported server renewal.

## Validation and artifact identity

- Full Jest:101 suites,1192 tests passed; one real-data planner test skipped in that batch. Exit0. The planner test then passed separately against951 geometry cache files from the root-owned leased simulator; the test now accepts an explicit fixture directory instead of accessing an unrelated hardcoded simulator.
- TypeScript:no errors.
- All34 static map GLBs and19 articulated viewer GLBs:Khronos validation without errors/warnings; geometry and mechanisms match.
- Skin authoring conversion:all seven models preserve closed triangles within10µm export tolerance and open poses match transformed viewer mechanisms. This tolerance concerns conversion, not physical tram fidelity.
- Simulator source manifest:[build36-manifest.json](results/build36-manifest.json); build36 readback, no source drift at completion.
- Backend remains the existing isolated candidate; production containers were not restarted or redeployed. Lab artifact1e791e958c6a942933511c9d59ce1ab833de82f2b06980615e6d477dc5b1f01f, ML model5e7c59877064aac605723e8ea040b3fb4db0f83d812931e8b77273606b35e39e.

Native originals and inspection are retained in results/iphone-2026-09-06-build36 and results/ipad-2026-09-06-build36. The iPad rotation failure remains disclosed until its bounded follow-up completes. No push is authorized.
