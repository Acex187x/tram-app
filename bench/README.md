# bench — offline replay of the shipping client physics

Tools that run the REAL client code (`src/lib/physics`) over captured wire
streams, deterministically, on a virtual clock. No runtime service lives here
any more (the 24/7 anomaly watcher was retired on 2026-09-13 together with its
250 GB window archive); what remains is what the tests and the calibration
runbook use:

| file | role |
|---|---|
| `src/replay-wire.ts` | replay a captured Convex wire recording through `TrajectoryStore` + `TramFleet`, audit presentation (command in `docs/testing/client-tracking-2026-09-05.md`) |
| `src/displayAudit.ts` | presentation invariants used by the replay and by `__tests__/physics-display-audit.test.ts` |
| `src/geometryReplay.ts` | geometry-event folding shared with `__tests__/physics-geometry-replay.test.ts` |
| `src/presentationPrototype.ts` | client presentation prototype under evaluation in the replay |
| `scripts/analyze-recording.mjs` | eligible/excluded counts for ride or calibration JSONL (`docs/calibration/plan.md`) |

Run with the app's own dependencies from the repo root:

```sh
npx tsx --tsconfig lab/tsconfig.runtime.json bench/src/replay-wire.ts <recording.jsonl.gz> …
node bench/scripts/analyze-recording.mjs <ride.jsonl …>
```
