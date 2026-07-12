# Physics Calibration Program — time-of-day model

Goal: the sim should match real Prague tram behavior across the whole day. Real behavior is
strongly time-dependent (user observation, to be quantified): rush hours = long boarding +
car traffic slows trams; nights = they run fast ("хасанят как ебанутые"); midday in between.

## Pipeline (self-collecting, closed loop)

1. **Collection** — the app runs continuously on the simulator (foreground = the passive
   motion logger records every poll for the whole fleet: ~150–450 trams × 12 records/min).
   A detached harvester (`scratchpad/harvest.sh`, PID in session) copies
   `Documents/tramspotter-motion/motionlogs/*.jsonl` from the sim container into
   `docs/calibration/sim-sessions/sim-<date>.jsonl` every 10 min and relaunches the app if
   it died. Device sessions (user exports) land next to them as `session-<date>.jsonl`.
2. **Analysis rounds** — rerunnable scripts in `docs/calibration/` (first set authored by
   the analysis agent) compute, per **hour-of-day bucket × zone (center bbox / outskirts)
   × model family**: real speed distributions (Δobs/Δt), realized dwell times at stops,
   signed sim error drift, paceBias saturation. Each round appends findings to
   `analysis-<date>.md`.
3. **Physics updates** — findings map to engine knobs:
   - `TOD_PACE_TABLE` (new, engine core): per-hour cruise-pace multiplier, composing with
     zone caps and per-tram `paceBias` (bias then only learns the *residual* per vehicle).
   - Zone caps / default dwell / TRAIL_M / clamp bounds as evidenced.
   Every change ships with a replay estimate (devM reduction over logged sessions) + tests.
4. **Validation** — replay the previous day's logs against the new constants before
   committing; target: median |signed error| ↓ without teleport-rate ↑.

## Time-of-day model (engine core)

`todPaceFactor(hourPrague)` — 24-entry table (initially all 1.0), multiplied into the
cruise target alongside `paceBias`. Buckets get learned values from step 2, e.g. expected
shape: ~0.8 at 07–09 & 15–18 (peaks), ~1.0 midday, ~1.1–1.25 at 22–05 (night running).
Dwell defaults likewise get a per-bucket multiplier (peak boarding takes longer).
The existing daytime center-zone cap (07:00–19:00) folds into this table eventually.

## Schedule

- Day 0 (now): harvester running; TOD hook lands in engine with neutral table; first
  analysis of the 2026-07-11 device session + accumulated sim data.
- Day 1: 24 h of sim data → first learned TOD table + dwell multipliers, replay-validated.
- Ongoing: re-run analysis after any engine change; device sessions (real GPS rides via
  Record ride) take precedence over sim data when they disagree (sim data inherits AVL
  latency; rides are ground truth).

## Record schema (motionlog daily JSONL)

- **v1** (through 2026-07-12): `{t,key,model,line,obsDist,simDist,projDist,devM,kmh,bias,lat,lng,mode}`.
- **v2 — R7** (builds from 2026-07-12; new keys APPENDED, old parsers unaffected —
  detect by presence of `obsAt` on a line, not by file date: a session file can mix
  v1/v2 lines around the app reload): adds raw AVL context straight from the
  snapshot — `obsAt` (unix ms of the last real fix, `observedAtMs`), `statePos`
  (raw `state_position`: `'at_stop'`, `'on_track'`, …), `delayS` (schedule delay s),
  `nextSeq` (next stop sequence). Unlocks: real dwell detection (flat `obsDist`
  while `obsAt` advances + `statePos`), true feed speed `Δ(obsDist)/Δ(obsAt)`
  between FRESH fixes (instead of poll-quantized `Δt`; `kmh` is simSpeedKmh, not
  feed speed), and dwell↔stop attribution via `nextSeq`.

## Where things are

- Sessions: `docs/calibration/{session,sim-sessions}/*.jsonl` (schema in analysis doc)
- Scripts + reports: `docs/calibration/`
- Engine knobs: `src/lib/engine/speedProfile.ts` (caps), `tramSim.ts` (pace/dwell/bias),
  future `TOD_PACE_TABLE` in `speedProfile.ts`.

## Runbook for agents ("собирай данные и вноси изменения")

You are picking up the calibration loop. Everything you need:

1. **Ensure collection is running.**
   - Simulator UDID `2AB8E802-E82C-4020-957B-27ACD6D56D73` (iPhone 17 Pro), app
     `cz.zabolotny.tramspotter` (dev build; if missing: `npx expo run:ios`, Metro on 8081 —
     `npx expo start --dev-client`). The app collects motion logs whenever foregrounded.
   - Start the harvester if not running: `nohup scripts/calibration/harvest.sh &`
     (idempotent; copies sim logs → `docs/calibration/sim-sessions/` every 10 min,
     relaunches the app if it died; check `sim-sessions/harvest.log`).
2. **Accumulate** ≥1 h of new data per round (a full day before touching the TOD tables
   seriously; night hours 22–05 need real night collection).
3. **Analyze**: run/extend the scripts in `docs/calibration/` (see `analysis-*.md` for the
   established methodology + record schema). Split everything by hour-of-day × zone
   (center bbox lng 14.395–14.46, lat 50.068–50.096) × model.
4. **Apply**: learned values go into `TOD_PACE_TABLE` / `TOD_DWELL_TABLE`
   (`src/lib/engine/speedProfile.ts`) and, if evidenced, zone caps / default dwell /
   TRAIL_M / paceBias clamps (`tramSim.ts`). NEVER defeat the braking envelope.
5. **Validate before committing**: 1D replay of the newest session against old vs new
   constants (scripts show how) — median |signed error| must drop; full jest suite +
   `npx tsc --noEmit` green; note the replay numbers in the commit message and append a
   round summary to `analysis-<date>.md`.
6. Repeat. Device ride recordings (`session-*.jsonl`, exported by the user) outrank sim
   data on conflicts.
