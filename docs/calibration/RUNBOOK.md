# RUNBOOK — calibrate on a new ride recording

Audience: an orchestrator or a fresh agent handed "вот новая поездка, откалибруй".
Everything here is reproducible from the repo alone (python3, no app build needed).
Methodology background: `analysis-2026-07-20-ride.md` §5. Recording format:
`plan.md` (ride schema v1–v4) + `docs/decisions/ride-recording.md` (incl. the
recording data spec). Fleet-side (simulator AVL) calibration is the older loop in
`plan.md` §"Runbook for agents" — this document is the RIDE loop only.

## 0. Checklist (the whole loop)

1. Ingest the exported ride file → repo root (gitignored). Sanity-check it.
2. `python3 docs/calibration/ride_replay.py <ALL ride files> --sweep` → diagnose;
   candidates found there are VERDICTED with the TS runner (§2a), which drives
   the real engine.
3. Candidate constants: mechanistic story only, never free-fit.
4. **Double gate**: TS-runner ride replay (`npm run replay:v2 -- --dry`)
   improves vs `docs/calibration/baselines/` AND fleet `replay.py` does not
   regress; jest + tsc green.
5. **Shrinkage**: one ride moves a constant at most half-way; full moves need ≥2
   independent rides agreeing.
6. Apply to the engine + sync the two Python mirrors + append the round to an
   `analysis-<date>-ride.md` + commit with the gate numbers.

## 1. Ingest the ride file

- The user exports from the app (Recorded rides → share): a JSONL named
  `YYYYMMDD-HHMMSS-<tramKey>.jsonl` (e.g. `20260720-193029-9097.jsonl`).
- Put it in the **repo root**. Root `*.jsonl` is gitignored (`/*.jsonl`) — ride
  files are raw telemetry and are NEVER committed; keep the user's copy
  (~/Downloads) as backup. Older accumulated rides should already sit in the
  repo root — the aggregate gate needs all of them (ask the user if a ride named
  in an analysis doc is missing).
- Sanity checks before trusting it:
  - first line is `{"type":"ride-start",…,"schema":"v3"|"v4"}`; a
    `ride-orphaned` footer is fine (crash-recovered, points intact); v4 is
    detected per-point by `tripId`.
  - usable ride ≈ ≥15 min of points; a few-second aborted recording is unusable.
  - ride_replay prints `points / stops / fixes / span` per ride — a healthy
    1 Hz ride has points ≈ duration in seconds, fixes ≈ duration / 45 s,
    plausible span in meters.
  - ground-truth quality: most points should pass the `fOffM < 30` gate
    (2 219/2 240 on the reference ride). A ride where the rider was NOT on the
    tram's shape (wrong tram, walking) fails this gate en masse — discard.

## 2. Replay and diagnose

**Two replay paths exist; know which one your question needs.**

### 2a. TS runner — the REAL engine (authoritative for engine changes)

```
npm run replay:v2 -- --dry                        # default 3 rides, score only
npx tsx scripts/calibration/replay-v2.ts <ride.jsonl …> [--out=path] [--dry] [--engine=label]
```

`scripts/calibration/replay-v2.ts` reconstructs each ride exactly like
`ride_replay.py` (shape from filtered rider GPS, stops from at-stop clusters,
fixes from obsAt advances) but then drives the **actual TypeScript engine**
via `ingest`/`tick` — no Python physics mirror, no port drift, scores BOTH
the smoother (smooth mode) and the predictor (live mode) plus the at-fix
probe. This is the engine-v2 gate runner (`docs/decisions/engine-v2.md` §3);
committed reference scores live in `docs/calibration/baselines/`
(`pre-v2.json`, `post-v2.json`, verdicts in `gate-v2.md`). Any engine-code
change is judged by THIS runner against those baselines — same-runner
comparisons only (its reconstructed schedule/terminal semantics differ from
the Python harness; the deltas are documented in the script header and
`baselines/README.md`). It has no `--sweep`; sweep by editing the engine
constant and re-running `--dry` (the engine is the single source of truth —
nothing to keep in sync).

### 2b. Python harness — fast 1D sweeps (constants exploration)

```
python3 docs/calibration/ride_replay.py <new-ride.jsonl> <older-ride.jsonl> … --sweep
```

- **Always pass ALL accumulated rides** — metrics aggregate (equal weight per
  point) and the gate is over the aggregate, not the newest ride.
- Table columns: `mean|e| p50|e| p90|e| signed %ahead fid_mean` vs the rider's
  `fDist` ground truth. Rows: BASELINE (pre-change engine), prior configs, the
  sweep grid, SHIP (current engine constants).
- **`fid_mean` is the surrogate-fidelity self-check** (replay vs the ride's
  *logged* `simDist`). If it blows up far past the ground-truth error itself,
  the Python port has drifted from the engine — port the missing engine change
  into `ride_replay.py` (and its SHIP dict) before trusting any verdict.
- Diagnose beyond the table before proposing anything: per-minute lag profile,
  worst behind/ahead episodes and their mechanism (stale at-stop holds, bias
  contamination, unobserved standstills — see analysis-2026-07-20-ride.md §2
  for the established decomposition: `gpsDist−obsDist` fix lag,
  `projDist−gpsDist` projection, `simDist−gpsDist` sim).

## 3. Candidate constants

- Engine knobs: `src/lib/engine/tramSim.ts` (holds, dwell, bias, catch-up,
  latency) and `src/lib/engine/speedProfile.ts` (caps, TOD tables). The replay
  mirrors: `ride_replay.py` `SHIP` dict and `replay.py`'s constants — a
  candidate is tested by overriding the mirror value (add a sweep row).
- **Every candidate needs a mechanistic anchor** — a measured quantity it is
  tied to (fix cadence p50 → hold ages, hidden pipeline latency → FEED_LATENCY,
  IMU accel percentiles → A_ACC/A_BRK, real platform dwell p50 → dwell). Free
  values that merely win the sweep are overfit by construction; do not ship.
- Check the pre-registered queue first — the next rounds are already designed
  (analysis-2026-07-20-ride.md §5): hold 35–40 confirmation, R13 bias
  decontamination, R14 free-running catch-up ceiling, R15 adaptive hold age.
- NEVER defeat the braking envelope (A_BRK/curve caps are safety envelopes,
  validated at real p90 — see §2 physics validation of the same doc).

## 4. Double gate (all three, mandatory)

1. **Ride gate**: mean |err| drops on `ride_replay.py` **across all accumulated
   rides** (ideally p90 too). For a single new ride also check the
   contiguous-half split: both halves must agree in direction (freeze-and-score;
   the halves are printed by scoring each half-file, or trivially by the
   per-episode diagnosis). Wins < ~10 % on a single ride are noise.
2. **Fleet gate**: `python3 docs/calibration/replay.py
   docs/calibration/session-<newest>.jsonl` (defaults to session-2026-07-11) —
   at-fix p50 and frs metrics must NOT regress vs the shipped row.
   Bit-identical is the common healthy outcome (ride-evidenced hold/latency
   bounds rarely bind at fleet cadence). Remember `replay.py` mirrors some
   engine constants internally — sync the candidate there for the test.
3. **Repo gate**: full jest suite + `npx tsc --noEmit` green (engine tests
   reference constants symbolically, so a pure constant change should not need
   test edits).

If the ride gate and the fleet gate cannot improve together (one trades against
the other, as R12's rejected forward-projection variant did), the candidate is
attacking the wrong mechanism — do not ship either direction; document it.

## 5. Shrinkage — accumulate vs act

A ride's effective sample size is its **independent episodes** (~50 fixes, ~25
stop events per 40 min) — not its 2 000+ rows. Rules (Codex-consulted,
2026-07-20):

| change class | evidence required |
|---|---|
| half-step toward a replay-optimal value of an existing constant | 1 ride (this is the max a single ride can justify — e.g. hold 60→45, not →40; latency 0→3, not →6) |
| full move / second half-step | ≥2 independent rides agreeing in direction |
| new mechanism (controller change, new constant) | 1 ride to design + replay-gate it, shipped conservatively; confirmation pre-registered for the next ride |
| pace/dwell/TOD distribution values | fleet AVL data keeps authority (rides can't match its sample size); a ride can only *confirm* (e.g. TOD h19/h20 = 1.0) |
| per-route / per-model / per-junction split | ≥3 rides of the relevant class; lands as an L2-shrunk factor toward the fleet value, never a hardcoded exception |

Deliberate non-shipping is a first-class outcome — record what won the sweep
but was NOT shipped and why (see §4 of analysis-2026-07-20-ride.md for the
pattern). Pre-register the confirmation test for the next ride.

## 6. Apply, document, commit

1. Change the engine constant(s) in `tramSim.ts` / `speedProfile.ts` with a
   comment carrying the mechanistic anchor + date.
2. Sync mirrors: `ride_replay.py` `SHIP` (and keep a BASELINE/prior row
   reproducing the pre-change engine for future gate tables), `replay.py` if it
   mirrors the constant.
3. Append the round to the ride analysis doc (`analysis-<date>-ride.md`; new
   file per new ride date): headline metrics, decomposition, gate record
   (ride + fleet numbers), shipped vs deliberately-not-shipped.
4. Update `plan.md` only if the schema or the pipeline itself changed.
5. Commit code + docs together; the commit message carries the constant, the
   mechanism, the ride-replay delta and the fleet-replay confirmation
   (pattern: commits `5d88ca1`, `4de00bc`).

## 7. Ride wish-list & future structure

Prioritized recordings wanted (each unlocks a pre-registered dimension):

- a centre-crossing line — zonal dwell ground truth;
- a street-running line (line 17 was dedicated-ROW riverside) — per-ROUTE pace
  residual;
- an AM-peak ride — TOD peak ground truth;
- any non-kt8d5 model — per-MODEL accel/decel from IMU;
- repeated rides over the same junctions — per-JUNCTION switch-slow (gpsSpeed
  over contested junctions).

What exists today: global constants + per-vehicle `paceBias` (live in-engine) +
TOD tables (fleet-learned). Per-route/per-model/per-junction do NOT exist yet —
each becomes a small multiplicative factor, L2-shrunk toward the fleet value,
once its ride class has ≥3 independent recordings.
