# Engine v2 ship gate — executed record (2026-08-01)

The validation gate of `docs/decisions/engine-v2.md` §3, run with the TS replay
runner (`scripts/calibration/replay-v2.ts`) that drives the REAL engine over
the 3-ride ground-truth corpus. Same-runner comparison only: `pre-v2.json`
(old dual-controller engine, worktree at `332ad73-dirty`) vs `post-v2.json`
(v2 predictor + smoother, this worktree). err = engine − rider truth (fDist),
`+` = ahead of the real tram; truth gated `fOffM < 30`.

Commands:

```sh
npm run replay:v2 -- --dry                       # score without touching baselines
npm run replay:v2 -- --out=docs/calibration/baselines/post-v2.json \
                     --engine='v2 (predictor + smoother)'
```

Baseline integrity: `pre-v2.json` was generated from a dirty worktree
(`332ad73-dirty`); during this gate the runner was re-run in a **clean**
`git worktree` at `332ad73` and reproduced every aggregate row exactly
(122.7 / −104.2 / 24.9, at-fix 115.9 / 127.1) — the dirty-provenance caveat is
retired.

## Final numbers (shipped configuration)

Per ride and aggregate, smoother (sim / smooth mode) and predictor (proj /
live mode):

| track | mean\|e\| | p50 | p90 | signed | %ahead | n |
|---|---:|---:|---:|---:|---:|---:|
| 9097 (L17) sim — pre | 131.0 | 115.7 | 257.9 | −115.3 | 17.9 | 2219 |
| 9097 sim — **post** | **134.7** | 123.8 | 264.9 | −79.3 | 19.8 | 2219 |
| 9097 proj — pre | 120.7 | 102.8 | 252.3 | −98.0 | 16.5 | 2219 |
| 9097 proj — **post** | **93.9** | 83.1 | 188.4 | −44.2 | 35.0 | 2219 |
| 9507 (L12) sim — pre | 113.7 | 96.8 | 257.9 | −90.3 | 31.1 | 1065 |
| 9507 sim — **post** | **137.8** | 110.7 | 311.8 | −105.2 | 25.0 | 1065 |
| 9507 proj — pre | 122.0 | 96.6 | 290.9 | −104.5 | 27.7 | 1065 |
| 9507 proj — **post** | **117.6** | 94.2 | 291.6 | −74.0 | 39.8 | 1065 |
| 9506 (L12) sim — pre | 106.5 | 47.4 | 267.6 | −86.5 | 41.3 | 550 |
| 9506 sim — **post** | **157.8** | 118.8 | 341.4 | −155.0 | 7.5 | 550 |
| 9506 proj — pre | 125.6 | 51.4 | 382.6 | −94.5 | 42.9 | 550 |
| 9506 proj — **post** | **142.3** | 111.3 | 382.6 | −67.9 | 52.7 | 550 |
| **AGG sim (smooth) — pre** | **122.7** | 103.5 | 259.4 | **−104.2** | **24.9** | 3834 |
| **AGG sim (smooth) — post** | **138.9** | 118.5 | 293.3 | **−97.4** | **19.5** | 3834 |
| **AGG proj (live) — pre** | **121.8** | 99.2 | 271.0 | −99.3 | 23.4 | 3834 |
| **AGG proj (live) — post** | **107.4** | 86.9 | 223.0 | −55.9 | 38.9 | 3834 |
| agg sim halves — pre | 105.7 / 139.7 | | | −75.1 / −133.3 | 34.1 / 15.6 | 1916/1918 |
| agg sim halves — post | 139.5 / 138.3 | | | −63.6 / −131.1 | 26.4 / 12.6 | 1916/1918 |
| at-fix sim — pre | 115.9 | 102.6 | 243.0 | −70.2 | 25.5 | 94 |
| at-fix sim — post | 121.6 | 88.2 | 314.2 | −53.9 | 28.7 | 94 |
| at-fix proj — pre | 127.1 | 105.7 | 311.8 | −78.5 | 23.4 | 94 |
| at-fix proj — post | **111.5** | 84.7 | 291.6 | −22.8 | 35.1 | 94 |

## Verdict per criterion

| # | criterion (engine-v2.md §3) | result |
|---|---|---|
| 1a | smoother mean \|fLagM\| ≤ baseline (≤ 122.7) | **FAIL** — 138.9 (+13.2%) |
| 1b | signed mean not more positive than baseline (≤ −104.2) | **FAIL** — −97.4 (by 6.8 m; see analysis — the ahead-class this clause guards did not regress: %ahead 19.5 vs 24.9) |
| 1c | %ahead within +5 pp (≤ 29.9) | **PASS** — 19.5 (−5.4 pp vs baseline) |
| 1d | both contiguous halves agree in direction | **PASS** — −63.6 / −131.1, both behind |
| 2a | at-fix probe not regressed | **SPLIT** — proj 111.5 vs 127.1 (improved); sim 121.6 vs 115.9 (+5.7, coupled to 1a) |
| 2b | fresh v2-schema fleet session at-fix probe | **NOT RUN** — needs a multi-hour live-feed simulator session via `scripts/calibration/harvest.sh`; run before the PR merges |
| 3 | full jest + `npx tsc --noEmit` green (incl. new §3.3 pins) | **PASS** — 839 passed / 0 failed / 1 pre-existing skip; tsc 0 errors |
| — | predictor (live) track not regressed | **PASS** — 107.4 vs 121.8 (−11.8%), p90 223 vs 271 |
| 4 | perf: `simulator-benchmark.sh` medians vs pre-rewrite baseline | **NOT RUN at app level** — no pre-rewrite perf baseline was ever captured (rollout step 1 skipped by earlier stages); a true baseline now requires a `332ad73` worktree Debug build. **Engine-layer evidence instead**: `scripts/perf/engine-bench.ts` run in both worktrees (150 trams, 60 sim-s, warm-pass medians) — v2 **faster** in both cadences: coarse 0.55 vs 0.82 ms/sim-s (−33%), full 0.85 vs 1.01 (−16%); details in `docs/performance-benchmark.md` |

**Net verdict: the gate as written does NOT pass** (1a, 1b). Per the ship-gate
instructions the gate was not relaxed; the numbers above are the honest result
of the best configuration found in 3 iterations. The analysis below documents
why the failing pair is structurally unreachable for the r2 architecture on
this harness, and what was tried.

## Shipped configuration (best found)

- `FEED_LATENCY_S` 3 → **5** (sanctioned tunable 3–8; measured pipeline
  latency 8–14 s; ride-replay optimum band ~5–8 s).
- `STOP_HOLD_MAX_FIX_AGE_S` 45 → **40** (top of the 35–40 s band the
  2026-07-20 analysis pre-registered but deferred until ≥2 more rides existed;
  the corpus now has 3).
- `TRAIL_M` stays **10** (TRAIL 0 was measured at −3.1 m mean but +≈7 m
  signed — arbitrated against, per §2.3's replay-gate clause).
- `CATCHUP_HEADROOM` stays **1.9** — measured non-binding (paceBias p50 0.80
  ⇒ ceiling ≈ 17.8 m/s; the local cruise caps and the braking envelope bind
  first).
- Blind-gap pace damping (predictor cruise fading beyond one fix cadence of
  true age) was implemented, measured, and **rejected**: floor 0.55 at 120 s
  cost +7.2 m mean for −8.9 m signed — predictor slow-down enlarges the
  forward reseeds the smoother then pays for in catch-up transit.

## Iteration log

| iter | change | agg sim mean / signed | agg proj mean |
|---|---|---|---|
| 0 | core-stage v2 as landed (lat 3 / hold 45) | 155.9 / −120.0 | 116.4 |
| 1 | lat 5 / hold 40 | **138.9 / −97.4** | **107.4** |
| 2 | + blind-gap damp (45→120 s, floor 0.55) | 146.1 / −106.3 | 109.3 |
| 3 | constants grid (damp removed) | see frontier below | |

Frontier grid (mean / signed): lat3·hold38 139.3/−99.0 · lat3·hold40
143.1/−103.9 · lat4·hold40 140.5/−100.5 · lat4·hold42 **144.7/−106.5** ·
lat5·hold40 **138.9/−97.4** · lat5·hold42 142.9/−102.7.

## Why 1a+1b jointly fail, and why lat5/hold40 ships anyway

1. **Dispersion floor.** `mean − |signed|` (a dispersion proxy) is 36–42 m in
   every v2 configuration measured vs **18.5 m** for the v1 baseline. Passing
   1a and 1b simultaneously requires v2's dispersion to be ≤ v1's.
2. **The v1 baseline is oracle-assisted on this harness.** v1's smooth target
   was `0.75·sObs + 0.25·sSched` with the observation projection bounded by
   the schedule slope — and this runner reconstructs the "schedule" from the
   ride's own observed at-stop epochs (baseline caveat (b)). On this harness
   v1's reference therefore contains 25 % of *truth itself*, which froze its
   target during every real stand. v2 removed the schedule pace reference **by
   design** (§1a — on the live feed that reference is the 2026-07-27 +1 km
   incident class), so it cannot exploit the oracle. This is the harness bias
   the core-stage report flagged; the gate numbers inherit it.
3. **Where v2's dispersion lives** (instrumented decomposition, 3 rides):
   85–88 % of |err| mass is *behind*, concentrated in a repeating cycle —
   stale at-stop pin-hold (≤ 40 s true age vs real dwell p50 ≈ 17 s) → the
   predictor departs late and cruises ~140 m behind truth (the smoother
   faithfully tracks it) → the next fresh fix forces a median +200…334 m
   forward reseed → the smoother pays a 30–60 s catch-up transit. ~30 % of
   all samples sit > 60 m behind the predictor mid-transit. The remaining
   ahead-mass (~15 %) is deep-but-rare stranding after backward reseeds
   (median −107…−115 m) when blind-gap overrun on slow stretches gets yanked
   back and the monotonic smoother must wait for reality.
4. **1b's letter vs its purpose.** The signed clause guards the
   ahead-regression class ("the trail/hold architecture exists for the
   asymmetric cost"). The grid contains letter-compliant points
   (lat4·hold42 = 144.7 / −106.5) — but their signed compliance is bought
   purely by ADDING systematic lag, with ahead-exposure identical to
   lat5·hold40 (%ahead 18.2 vs 18.5, same stranding episodes). Choosing that
   point would make every mode measurably worse on average to satisfy the
   letter of a clause whose guarded class is already better than baseline
   (%ahead 19.5 vs 24.9, ahead frequency down on every ride). lat5/hold40 is
   therefore shipped as the best configuration, with 1b reported failed.
5. **What genuinely passed:** live mode (the predictor) improved 11.8 % on
   mean with p90 down 48 m — on all three rides; the at-fix probe (the live
   fleet-check proxy) improved 12.3 %. The two clauses that fail are both
   about the smoother's mean vs an oracle-assisted bar.

## Known issues / follow-ups (out of this gate's envelope)

- **Curve caps on reconstructed shapes throttle catch-up.** The harness
  builds geometry from GPS at 8 m resample; the resulting curvature makes
  `CURVE_SLOW_FACTOR 0.85` bite harder than on production shapes (real moving
  p90 13.2 m/s vs predictor cruise p90 10.1). Affects both engines
  symmetrically here, but a proper per-curve calibration of
  `CURVE_SLOW_FACTOR` against ride `gpsSpeed` (its own comment's TODO) is the
  single biggest untapped lever for transit speed.
- **Phantom-terminal tails.** All three rides end 274–526 m past the last
  reconstructable at-stop cluster, so the engine's last-stop-is-terminal
  fallback latches early while truth cruises on (~8 % of |err| mass, ~11 m of
  the mean). Symmetric with the baseline (caveat (c)); do not "fix" the
  engine against it — production geometries have real terminals.
- **paceBias span-endpoint contamination.** A span ENDING at the first
  at-stop fix of a platform includes the pre-fix stand time but deducts
  neither that stand (pin arms only at the fix) nor the endpoint stop's dwell
  (only stops strictly inside are deducted) — biasing samples slow. R13's
  clip-not-drop could deduct the endpoint stop's dwell for standing-endpoint
  spans. Small (bias p50 measured 0.80, predictor cruise p50 7.4 vs truth
  7.2), but worth a calibration round.
- **TOD tables are still neutral.** Both 07-28 rides are PM peak; learned
  `TOD_DWELL_TABLE`/`TOD_PACE_TABLE` values (the Convex calibration program)
  will attack the same stale-hold cycle from the dwell side.
- Gate legs 2b (fresh fleet harvest) and 4 (simulator perf benchmark) still
  need a live simulator session — run them before the PR merges.
