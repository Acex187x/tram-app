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

## Ride schema (rides/<ts>-<key>.jsonl, Record ride)

- **v1** (through 2026-07-13):
  `{t,gpsLat,gpsLng,gpsSpeed,gpsAcc,simDist,simLat,simLng,simKmh,obsDist,projDist,devM,model,line,phase}`
  — one line per GPS fix (~1 Hz), correlated with the sim state at write time.
- **v2** (device builds from 2026-07-13; new keys APPENDED, old parsers unaffected —
  detect by presence of `obsAt` on a line): appends the same raw-AVL context as the
  daily-log v2 plus ride-specific extras — `obsAt` (unix ms of the last real fix),
  `statePos` (raw `state_position`), `delayS` (schedule delay s), `nextSeq` (next stop
  sequence), `bias` (learned `paceBias`, 2 dp), `posMode` (active settings positionMode,
  `'smooth'`/`'live'` — which rendering the rider was visually judging). All sim-derived
  fields (incl. the new ones except `posMode`) are `null` when the tram has no state.
  Unlocks ground-truth calibration per ride: the rider's GPS vs `simDist` vs raw AVL
  (`obsDist`+`obsAt`) vs projection (`projDist`), real dwell windows (`statePos`
  `'at_stop'` + flat `obsDist` while the rider's `gpsSpeed`≈0 confirms the stand),
  dwell↔stop attribution via `nextSeq`, and inter-stop pace-factor fitting with `bias`
  recorded so the learned component can be factored out of the residual.
- **v3** (device builds from 2026-07-13, crash-safe rewrite): two changes, both
  backward-tolerant for parsers (reference parser: `src/lib/motionlog/rideFile.ts`).
  1. **Meta lines** — the file now opens with a header and closes with a footer; any
     line carrying a `type` field is meta, everything else is a point (skip unknown
     `type`s):
     - `{type:'ride-start', tramKey, model, line, t, schema:'v3'}` — written the INSTANT
       recording starts (the file exists on disk before the first GPS fix; model/line
       null when the tram had no state yet);
     - `{type:'ride-end', t, points}` — clean stop;
     - `{type:'ride-orphaned', t}` — appended by startup orphan recovery when the
       process died mid-ride (crash/jetsam). Every point written before the death is
       intact (points are appended to disk synchronously, never buffered); treat the
       file as a valid ride without a clean end. `t` is the RECOVERY time, not the ride
       end — use the last point's `t` for duration.
  2. **Appended point fields** (after `posMode`; old lines remain a strict prefix —
     detect by presence of `gpsDist`): the rider's GPS fix projected onto the tram's
     shape (`projectPointToPolyline` over the engine geometry):
     - `gpsDist` — distance along the shape of the projected GPS, m (1 dp);
     - `gpsOffM` — perpendicular GPS↔shape offset, m — gate on this (e.g. < 30 m)
       before trusting `gpsDist` (large offset = rider not on the route / GPS noise);
     - `lagM` — `simDist − gpsDist`, m; **positive = the simulation runs AHEAD of the
       real tram the rider is sitting in**. The headline ground-truth metric these
       recordings exist for. All three null without geometry.
  Also new in v3 device builds: recording continues while the app is backgrounded
  (expo-location background task); sim-side fields then tick at 1 Hz with 10 s polls
  (`rideBackground` mode, docs/performance.md) — expect slightly coarser `simDist`
  steps in backgrounded stretches.
- **v4** (device builds from 2026-07-18): high-rate IMU motion + in-app GPS
  filtering. Backward-tolerant: v3 point lines remain a strict prefix (detect v4 by
  presence of `tripId` on a point line); pre-v4 parsers skip the new meta lines by
  their unknown `type`.
  1. **Appended point fields** (after `lagM`):
     - `tripId` — trip the sim/AVL context belongs to (can change mid-ride; the
       header also carries the start-of-ride `tripId`);
     - `fLat`/`fLng` — FILTERED rider position (`src/lib/motionlog/gpsFilter.ts`:
       accuracy gate > 45 m → `rej:'acc'`; physically-impossible-jump gate
       (> 40 m/s·dt + slack + accuracy) → `rej:'jump'`; alpha-beta smoothing
       α=0.45 β=0.15 in a local meter frame; 5 consecutive jump-rejects re-anchor —
       the jump was real). On a rejected fix `fLat/fLng` is the coasted prediction;
       the RAW `gpsLat/gpsLng/gpsAcc` stay verbatim on every line;
     - `rej` — null (accepted) | `'acc'` | `'jump'`;
     - `fDist`/`fOffM`/`fLagM` — the filtered position projected onto the tram's
       shape; **`fLagM` (simDist − fDist) is the PREFERRED ground-truth lag** —
       `lagM` from the raw fix is kept for comparison. Same `fOffM` gating rule as
       `gpsOffM` (< 30 m before trusting `fDist`).
  2. **Motion meta lines** — `{type:'motion', t0, n, s:[[dt,ax,ay,az,ra,rb,rg,oa,ob,og],…]}`:
     ~25 Hz DeviceMotion batches (expo-sensors), flushed every ≤1 s / ≤25 samples
     (a crash loses at most ~1 s of motion; GPS points are still written per-fix,
     never buffered). Per sample: `dt` ms since `t0`; `ax..az` user acceleration
     (gravity removed) m/s² (null on gyro-less devices); `ra..rg` rotation rate
     deg/s; `oa..og` attitude rad (rotate accel into the world frame offline).
     Motion is guaranteed only while foregrounded; in background the location
     session usually keeps the process alive so batches often continue — gaps are
     visible in the `t0`/`dt` timeline itself (see docs/decisions/ride-recording.md).
  3. **Header/footer extras**: header adds `tripId`; footer (`ride-end`) adds
     `motionSamples` and `gpsRejects`.
  Per-point completeness contract (pinned by `__tests__/motionlog-ride-v4.test.ts`):
  time (`t`, `obsAt`) · line/trip/model (`line`, `tripId`, `model`, header `tramKey`) ·
  sim state (`simDist`, `simLat/simLng`, `simKmh`, `phase`, `bias`) · raw AVL
  (`obsDist`, `obsAt`, `projDist`, `devM`, `statePos`, `delayS`, `nextSeq`) · raw GPS
  (`gpsLat/gpsLng/gpsAcc/gpsSpeed`) · rider-on-shape (`gpsDist/gpsOffM/lagM` raw +
  `fLat/fLng/rej/fDist/fOffM/fLagM` filtered) · rendering context (`posMode`).

## Where things are

- Sessions: `docs/calibration/{session,sim-sessions}/*.jsonl` (schema in analysis doc)
- Scripts + reports: `docs/calibration/`
- Engine knobs: `src/lib/engine/speedProfile.ts` (caps), `tramSim.ts` (pace/dwell/bias),
  future `TOD_PACE_TABLE` in `speedProfile.ts`.
- **Ride ground-truth pipeline**: `docs/calibration/ride_replay.py <ride.jsonl>
  [--sweep]` — replays the smooth-sim controller over a ride's AVL fixes and
  scores vs the RIDER's GPS (`fDist`); the gate for every ride-evidenced
  constant (methodology + shrinkage rules: analysis-2026-07-20-ride.md §5;
  double gate = ride-replay improvement + no `replay.py` fleet regression).

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
