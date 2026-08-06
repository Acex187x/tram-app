# Engine replay baselines

Scores produced by the TS replay runner (`scripts/calibration/replay-v2.ts`),
which drives the **real** `TramEngine` (no Python physics mirror) over the ride
recordings' AVL fix sequences and scores both tracks against the rider's
filtered GPS ground truth (`fDist`, gated `fOffM < 30`). Metric:
`err = s − fDist`, meters along shape, **positive = engine ahead of the real
tram**; aligned per wall-clock second, point-weighted across rides.

## Files

- **`pre-v2.json`** — the pre-rewrite baseline: the OLD dual-controller engine
  (main sim + projSim) scored on the 3-ride corpus
  (`20260720-193029-9097` line 17 kt8d5, `20260728-172812-9507` +
  `20260728-182204-9506` line 12 52t). This is the number the engine-v2 gate
  (`docs/decisions/engine-v2.md` §3) compares against: v2's smoother mean
  |e| must be ≤ this baseline's `aggregate.sim.meanAbs`, signed mean not more
  positive, %ahead within +5 pp, both contiguous halves agreeing in direction.
- **`post-v2.json`** — the v2 engine (predictor + smoother) scored by the same
  runner on the same corpus, at the shipped configuration
  (`FEED_LATENCY_S 5`, `STOP_HOLD_MAX_FIX_AGE_S 40`, `TRAIL_M 10`).
- **`gate-v2.md`** — the executed gate record: pre-vs-post table, per-criterion
  verdicts, iteration log, and the analysis of the two failing smoother
  clauses (oracle-assisted baseline bias + dispersion floor).

## Reproducing

```
npm run replay:v2 -- --dry                              # score only, touch nothing
npm run replay:v2                                       # rewrites pre-v2.json (OLD engine worktrees only!)
npm run replay:v2 -- --out=docs/calibration/baselines/post-v2.json \
                     --engine='v2 (predictor + smoother)'
```

The default (flag-less) invocation writes `pre-v2.json` and labels the engine
"pre-v2" — only meaningful in a worktree that still contains the old engine
(`332ad73`). In this worktree always pass `--dry` or `--out`.

Ride files live gitignored in the repo root (backups in `~/Downloads`).

## Reading the JSON

- `perRide[file].sim` — main sim (smooth mode) vs ground truth;
  `.proj` — projection (live mode) vs ground truth; `.halves.sim` —
  contiguous-half split of the sim errors (direction-agreement check).
- `aggregate` — point-weighted across all rides (same fields).
- `atFix` — the at-fix probe: engine position at the last tick **before** each
  genuinely-new fix was ingested, vs that fix's `obsDist` (fresh-truth
  1D error; the fleet-check analogue that needs no Python).
- `runner` — harness parameters (tick 250 ms, poll re-ingest 5 s,
  projection cadence `full`, 8 m shape resample, `delaySeconds` forced 0).

## Caveats (why these numbers ≠ ride_replay.py's)

Same ground truth, different harness — only same-runner comparisons are valid:

- The real engine applies the daytime centre zone cap by wall clock; the
  Python harness ran `daytime=False` for every ride. The 07-28 rides are
  daytime (17:28 / 18:22 CEST); the 9507 ride is ~39% inside `CENTER_BBOX`.
- The schedule anchor is reconstructed from **observed** at-stop cluster times
  (min/max `obsAt`, `dwellSeconds` 0, `delaySeconds` 0), not from GTFS and not
  from Python's inter-fix pace-proxy EWMA.
- The reconstructed shape ends where the rider alighted, so the engine treats
  the final platform as a terminal (isTerminalStop last-stop fallback).
- Python's 3-ride point-weighted aggregate was ~116 m mean |e|; this runner
  reads 122.7 m on the same corpus — the expected same-vicinity agreement.
