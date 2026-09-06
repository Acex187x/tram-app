# Build37 — physical review delivery, 6 September 2026

Build37 is installed on the paired iPhone17Pro; CoreDevice readback confirms37.
No Git push or production backend rollout was performed. The private candidate
backend remains the frozen version described in build36 evidence.

## Change from36

Native36 QA revealed a timeline bug: at3m beyond a platform, the old2m slice
removed it and then labelled the following platform as a current dwell. Build37
retains the exact nearby predicted platform within the existing30m threshold,
keys it by stop ID and sequence, preserves NEXT and only attaches the ETA to its
matching occurrence. The label is now EST. AT STOP, not a claim of observed dwell.
Motion, all model assets, skin renderer and native patches are unchanged from36.

## Verification

- Full Jest batch:102 suites/1198tests passed, one external-fixture planner test skipped. That planner check separately passed on the leased simulator's951 geometry cache files. The new timeline cases cover passing the platform, movement, repeated IDs, terminal and incompatible ETA.
- TypeScript and native ShapeUpdateGate checks passed. All53 model GLBs and all seven authored skin-package conversions validated.
- Build36 full iPhone native suite:7passed,1iPad-only skip. iPad:7passed, rotation failure separately investigated. All seven model faces/rears/whole/doors, inspector, map geometry/zooms, ride metadata and skin import/assignment/reset/reimport were exercised. Exact original images are retained beside the summaries.
- Build37 targeted iPhone map/timeline native test passed. iPad follow-up passed23.24s; inspected moving14T9128 with Sibeliova correctly shown asNEXT.
- Simulator and device build source hashes have no drift:[build37-manifest.json](results/build37-manifest.json). Synthetic skin tests remained simulator-only; both simulator QA libraries and assignments were removed; no physical-device library was populated.

## Remaining limits

See [build36 evidence](build36-delivery.md) for paired tracking comparisons and
rejected no-age experiments. Sparse observations, origin layover errors and
world-direction changes at sharp route vertices remain; zero teleportation or
perfect stop accuracy is not claimed. No real advertising roster is bundled:
skins are authored, validated and assigned locally by registration.

The physical iPad is reachable on the LAN but absent from CoreDevice; USB/Trust
pairing verification is still required. Separately, iPad Simulator rotation is
blocked even on its Home screen, with the app terminated; this is not evidence
of an Expo-only restriction. Computer Use reports a locked Mac. User unlock was
requested before changing any app orientation policy. Portrait/native controls
passed; fresh landscape validation remains pending that environment check.
