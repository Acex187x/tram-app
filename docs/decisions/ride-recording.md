# Ride recording: sensors, GPS filtering, and staying alive in the background

Status: implemented (schema v4) + researched plans. Owner modules:
`src/lib/motionlog/**` (core, gpsFilter, sensors, location, rideFile),
`src/components/tram/RideRecorder.tsx`. Schema reference:
`docs/calibration/plan.md` (ride schema v4).

## What a ride recording is for

Ground truth for physics recalibration: the rider's phone GPS (where the real
tram IS) vs the simulation (`simDist`) vs the raw AVL feed (`obsDist`/`obsAt`).
Every improvement here is judged by one question: does it make the offline
analysis more trustworthy without endangering the recording itself?

## Decisions taken (v4)

### 1. DeviceMotion at 25 Hz, batched to disk

- expo-sensors `DeviceMotion` (SDK 57), `setUpdateInterval(40)` → ~25 Hz.
  Recorded channels per sample: user acceleration (gravity removed, m/s²),
  rotation rate (deg/s), attitude (rad — lets analysis rotate acceleration into
  the world frame). Devices without a gyro yield nulls for accel/attitude.
- 25 Hz is deliberate: tram dynamics (accel/brake transients, dwell detection)
  live well under 2 Hz; 25 Hz gives 10× oversampling for clean integration
  while costing ~1.4 KB/s on disk (~8 MB per 90 min ride) and negligible power
  next to the GPS already running. 50–100 Hz would only serve track-vibration
  analysis, which is not a goal.
- Batching: samples buffer in memory and append as ONE compact
  `{type:'motion', t0, n, s:[[dt,…],…]}` line every ≤1 s or ≤25 samples,
  whichever first, with a backstop flush inside every GPS callback (GPS
  callbacks are the ticks that provably keep firing in background). A crash
  loses at most ~1 s of motion. GPS points keep the stricter v3 contract:
  appended synchronously per fix, never buffered.
- The motion permission (iOS `NSMotionUsageDescription`) is requested at ride
  start via the expo-sensors config plugin (`motionPermission` in app.json —
  **requires a native rebuild**). Denied/unavailable → the ride records
  GPS-only and the UI says so; a motion failure can never fail a ride.
- MotionLog `notify()` fires per BATCH (≤1 Hz), never per sample — perf
  invariant #1 (docs/performance.md) holds.

### 2. In-app GPS filtering (`gpsFilter.ts`)

Raw fixes "уезжают в сторону" (urban canyon multipath, Wi-Fi relocations).
The filter is pure and unit-tested (`__tests__/gps-filter.test.ts`):

- accuracy gate (reject > 45 m horizontalAccuracy, `rej:'acc'`),
- jump gate (reject displacement > 40 m/s·dt + 15 m + accuracy from the
  predicted position, `rej:'jump'` — scales with dt, so tunnel gaps pass),
- alpha-beta smoother (α=0.45, β=0.15) in a local meter frame — ~0.76× noise
  RMS on straights, < ~10 m lag through a 90° corner at tram speed,
- recovery: 5 consecutive jump-rejects re-anchor (the jump was real).

Both positions are recorded on every line: raw (`gpsLat/gpsLng/gpsAcc`,
verbatim, always) and filtered (`fLat/fLng` + `rej`), each projected onto the
tram's shape (`gpsDist/lagM` raw, `fDist/fLagM` filtered). Offline analysis
should prefer `fLagM` and can re-derive anything from the raw stream.

### 3. Completeness

Every point now carries the full correlation context — time (`t`, `obsAt`),
line/trip/model (`line`, `tripId`, `model`), sim (`simDist/simLat/simLng/
simKmh/phase/bias`), raw AVL (`obsDist/projDist/devM/statePos/delayS/nextSeq`),
raw + filtered rider position and both shape projections, `posMode`. Pinned by
`__tests__/motionlog-ride-v4.test.ts` ("completeness contract").

## Background recording: what actually works

### Current, verified mechanism (keep)

`startLocationUpdatesAsync` + expo-task-manager + `UIBackgroundModes:
["location"]` (see `src/lib/motionlog/location.ts` header for the native-source
verification: when-in-use permission suffices; the task consumer sets
`allowsBackgroundLocationUpdates`). While the location session is active, iOS
keeps the **whole process** running (this is how nav apps work), the blue
indicator shows, and the runtime drops to the sanctioned `rideBackground`
budget (10 s polls, 1 Hz engine tick — docs/performance.md). GPS in background
is the guaranteed stream; the honest-UI contract (mode()==='background'
reported only after `hasStartedLocationUpdatesAsync` confirms) stays.

On-device verification runbook (repeat after any related change):
1. Start a ride, lock the phone for ≥5 min, unlock, stop.
2. The saved file must show continuous point `t` through the locked window
   (no > ~15 s gaps) — the RideRecorder's "last fix" readout live-verifies too.
3. Check motion coverage in the same window (see below) via `t0` gaps.

### Motion sensors in background — honest assessment

`DeviceMotion` (CMMotionManager) has **no background mode of its own**: samples
stop the moment iOS suspends the app. BUT during a ride the active background
location session keeps the process unsuspended, so in practice the 25 Hz stream
usually keeps flowing with the screen locked. This is a side effect, not a
contract — iOS may still throttle. We therefore: (a) never promise motion
coverage in the UI ("Motion … @ 25 Hz" is a live counter, not a pledge),
(b) encode gaps observably (batch `t0`/`dt` timelines make any hole visible to
the analysis), (c) treat GPS as the only guaranteed background stream. Do NOT
build analysis that assumes contiguous background motion.

### Researched options (plans, not implemented)

**(a) iOS Live Activity — realistic later, not in this pass.** ActivityKit
needs a WidgetKit extension target with SwiftUI — not expressible in pure JS,
but NOT an eject either: community config plugins (e.g.
software-mansion-labs/expo-live-activity, or an `@bacons/apple-targets` target)
generate the extension at prebuild; SDK 57 supports this fine. Crucially a
Live Activity grants **zero background execution** — it is lock-screen UI. Its
real value for us: visible recording status + elapsed/points on the lock
screen, a Stop button via App Intents, and user trust (fewer manual
force-quits, which are what actually kill recordings). Updates would come from
the already-alive process (we run in background during rides anyway).
Verdict: nice-to-have UX layer; ~1–2 days incl. a Swift widget; do it when the
recording UX matters more than it does today. Risk to the build: contained to
prebuild config — but do NOT add it casually; every new target complicates EAS
signing.

**(b) CMSensorRecorder — the correct long-term answer for guaranteed motion
coverage; needs a small native module.** Hardware-buffered accelerometer
recording (`recordAccelerometer(forDuration:)`, up to ~12 h at 50 Hz) that runs
in the sensor coprocessor **independent of app suspension or even termination**;
data is fetched later in batch (`accelerometerData(from:to:)`). Not exposed by
expo-sensors (verified 57.0.2 — only live CMMotionManager streams). Plan: a
~100-line local Expo Module (Expo Modules API, Swift; no eject, no config
fork): `startRecording(hours)`, `fetchRange(fromMs, toMs) → [[t,x,y,z],…]`,
gated on `CMSensorRecorder.isAccelerometerRecordingAvailable()` + Motion &
Fitness permission (NSMotionUsageDescription already ships with v4). On
stopRide (or next launch — survives crashes!), drain the range into
`{type:'motion-rec'}` lines. Caveats: accelerometer ONLY (no gyro/attitude —
world-frame rotation must come from the live stream or be estimated), 50 Hz
fixed, retrieval can lag minutes for long windows. This closes the only real
gap left (motion during suspension) AND doubles as crash recovery for motion.

**(c) Silent-audio background trick — rejected, do not revisit.** Playing
inaudible audio with `UIBackgroundModes: audio` to stay alive: App Review
rejection material (audio mode must serve genuine audible playback — 2.5.4),
burns battery continuously, breaks the user's actual audio session, and is
strictly inferior to the location session we already legitimately hold during
rides (which keeps the process alive with an honest blue indicator). There is
no scenario where audio adds anything the location mode doesn't already give.

### Non-goals

- "Always" location permission: not needed — the background task route works
  with when-in-use (verified against expo-location native source).
- Recording without an active ride: out of scope by design (battery, honesty).

## Disk budget

v4 raised `DIR_CAP_BYTES` 8 → 24 MB: a 90 min ride with motion is ~8 MB and
ride files are never eviction victims — under the old cap one long ride would
have force-evicted every passive-log archive. Rides remain excluded from
eviction; the active daily log keeps its own rotation ceiling (R9).

## Data-volume audit (2026-07-20, first full v4 ride) & recording data spec

Measured on `20260720-193029-9097.jsonl` (40 min, 2 240 points, 59 881 IMU
samples): **4.87 MB total = 1.13 MB points (23 %, ~506 B/point @1 Hz) +
3.74 MB motion (77 %, ~62 B/sample @25 Hz)**. Extrapolated: ~7.3 MB/h, so a
90 min ride is ~11 MB (revises the ~8 MB estimate above) and the 24 MB cap
holds barely 3 h of accumulated rides — and rides are non-evictable by design.

### What the analysis actually consumes

- `ride_replay.py` (the gate for every ride-evidenced constant) reads ONLY
  per-point fields: `t`, `fLat/fLng/fDist/fOffM` (shape reconstruction +
  ground truth), `obsAt/obsDist/statePos/nextSeq` (fix sequence + stop table),
  `simDist` (surrogate-fidelity check), header meta. **Zero IMU.**
- The one-off analysis (analysis-2026-07-20-ride.md) additionally used
  `gpsSpeed` (stop windows, junction speeds), `gpsAcc` (quality), `projDist/
  devM` (error decomposition), `bias` (contamination diagnosis), `phase`,
  `lagM` vs `fLagM` (filter transparency check, one-time: differed 0.2 m),
  and the IMU — but only as **2 s-window accel/decel percentiles** (< 2 Hz
  bandwidth). The envisioned future IMU use (per-stop jerk signatures to
  split platform dwells from signal stops) also lives well under ~3 Hz.

### Verdict: points OK as-is; IMU rate is the one cut worth making

- **Per-point (1 Hz, ~0.5 KB/s): keep everything.** Every field either feeds
  the pipeline or is cheap insurance; 98 % of points repeat the previous
  AVL context (`obsAt` unchanged) and could be deduped for ~15 % of point
  bytes, but that is ~3 % of the file — not worth the schema/parser churn.
- **IMU 25 → 10 Hz** (`MOTION_UPDATE_INTERVAL_MS` 40 → 100) is the
  recommended change when the implementer next touches sensors.ts: tram
  dynamics live under 2 Hz, 10 Hz still gives 5× oversampling for every
  current and planned analysis, and the file drops 4.87 → ~2.6 MB per 40 min
  (~3.9 MB/h — the cap then holds ~6 h of rides). 25 Hz only serves
  track-vibration analysis, an explicit non-goal. Keep all 10 channels
  (attitude is required to rotate acceleration into the world frame).
- Do NOT drop the raw GPS in favor of the projected position (next section):
  it is ~3 % of the file and is the only recovery path when the projection
  context was wrong at record time.

### The projected on-line position IS the recorded ground truth (confirmed)

The idea "записывать сразу положение реального трамвая на линии (GPS+fitness,
спроецированный на shape в момент записи)" is **already implemented since v4**:
`fLat/fLng` (filtered rider fix) → projected onto the tram's shape at write
time → `fDist/fOffM/fLagM`. `fDist` is exactly the ground truth
`ride_replay.py` scores against; `fLagM = simDist − fDist` is the headline
metric. No new recording work is needed for it. It is *sufficient* for the
whole current analysis **only together with** the raw fixes: the projection
depends on the engine's shape/trip at record time (a wrong trip or shape
variant would silently poison `fDist` for the whole ride), so the verbatim
`gpsLat/gpsLng/gpsAcc` stay the re-derivation path. "Fitness"-style motion
data contributes via the IMU batches (accel/decel envelopes, future
dwell-vs-signal separation), not via the projection.

### Recording data spec v5-min (for the implementer; = v4 minus IMU rate)

Everything below is the minimal set that keeps the FULL analysis reproducible.
Fields marked *(derivable)* may be dropped if a byte budget ever demands it —
nothing else may.

- **Meta**: `ride-start` {tramKey, model, line, tripId, t, schema};
  `ride-end` {t, points, motionSamples, gpsRejects} / `ride-orphaned` {t}.
- **Point @1 Hz per GPS fix** (synchronous append, never buffered):
  - time/identity: `t`, `line`, `tripId`, `model`, `posMode`;
  - raw GPS (verbatim, always): `gpsLat`, `gpsLng`, `gpsAcc`, `gpsSpeed`;
  - filtered rider: `fLat`, `fLng`, `rej`;
  - rider-on-shape (ground truth): `fDist`, `fOffM`, `fLagM`;
  - raw-on-shape *(derivable from raw GPS + shape)*: `gpsDist`, `gpsOffM`,
    `lagM`;
  - sim: `simDist`, `simKmh`, `phase`, `bias`; `simLat/simLng` *(derivable,
    kept for the in-app ride preview which reads tracks without geometry)*;
  - raw AVL: `obsDist`, `obsAt`, `statePos`, `delayS`, `nextSeq`, `projDist`,
    `devM`.
- **Motion batches @10 Hz** (was 25 Hz — the only spec change): same
  `{type:'motion', t0, n, s:[[dt,ax,ay,az,ra,rb,rg,oa,ob,og],…]}` encoding,
  ≤1 s / ≤25-sample flush, all 10 channels, gaps observable via `t0`/`dt`.

Parsers stay untouched: rate is not part of the schema, and every consumer
(`rideFile.ts`, `ride_replay.py`) already handles arbitrary batch cadence.
