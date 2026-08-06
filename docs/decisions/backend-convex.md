# Backend on Convex — design record

Status: **DESIGN → scaffolding.** Concretizes `backend-plan.md` (which chose a
generic WS/HTTP sketch) onto Convex. The client-side seam (`TramFeed`,
`src/lib/feed/types.ts`) is unchanged — a `RemoteFeed` implements it 1:1;
`LocalGolemioFeed` remains the offline/outage fallback. The feed-contract
reference for everything the RemoteFeed must replicate is the 2026-08-01 recon
(`§6`: merged-full-array delivery, sync geometry mirror, abort-on-stop,
FeedStatus mapping, non-throwing calibration sink).

Why Convex (vs the hand-rolled WS server in backend-plan.md): the live-stream
fan-out, resume-after-disconnect, and reactive invalidation are the platform's
native primitives instead of custom protocol code; scheduled/cron functions
cover the 24/7 poller and aggregation; the Golemio key becomes a server-only
environment variable. Trade-off accepted: the wire protocol is Convex's sync
protocol, not our own WS framing — `backend-plan.md` §3's custom protocol is
superseded.

## 1. Topology

```
convex/
  schema.ts           # tables below
  poller.ts           # 24/7 self-rescheduling poll loop (internal action)
  ingest.ts           # normalize + diff + upsert (internal mutation)
  stream.ts           # public queries the RemoteFeed subscribes to
  geometry.ts         # trip-geometry fetch/cache/serve (action + query)
  calibration/
    fold.ts           # per-fix-pair streaming aggregation (internal mutation)
    bundle.ts         # hourly compaction into the client-facing bundle
  crons.ts            # watchdog + compaction + retention sweeps
  lib/                # SHARED pure code, imported from src/lib (see §5)
```

### Tables

| table | key/indexes | contents |
|---|---|---|
| `vehicles` | by `key` | latest normalized `TramSnapshot` per tram + `updatedSeq` |
| `batches` | by `seq` | one row per server poll **that changed anything**: `{seq, atMs, changed: TramSnapshot[]}` — the diff stream; retention ~10 min |
| `pollerState` | singleton | heartbeat (`lastPollAtMs`, generation, consecutive failures, auth state) |
| `geometries` | by `tripId`; by `shapeId` | preprocessed `RouteGeometry` (+ curvature/speed-profile fields, phase 2) with `serviceMidnightMs` for re-anchoring |
| `segmentStats` | by `(shapeId, bucket, hourBand, dayType)` | EWMA mean pace m/s, variance, sample count |
| `modelStats` / `vehicleStats` | by model id / vehicle key | pace factor EWMAs (fleet + per-vehicle priors) |
| `stopStats` | by `(stopId, hourBand, dayType)` | dwell-budget EWMA (R8-style zonal signal, learned continuously) |
| `bundles` | singleton (latest) | compact calibration bundle served to clients |

## 2. The 24/7 poller

- `internal.poller.pollLoop` (action): loop of `fetch /v2/vehiclepositions`
  every `SERVER_POLL_MS = 2000` (CDN `s-maxage=5` → each fresh object read
  within ~2 s; one key, ~4 starts/8 s — inside the 20/8 s budget with a wide
  margin, geometry fetches included). After ~8 min of looping the action
  reschedules itself via `ctx.scheduler.runAfter(0, …)` and exits (10-min
  action ceiling). Generation token in `pollerState` prevents double loops.
- Watchdog cron (1 min): if `pollerState.lastPollAtMs` is stale > 2 min,
  reschedule `pollLoop`. This is the liveness guarantee; deploys/crashes
  self-heal within a minute.
- Failure policy ported from `LocalGolemioFeed`: 401/403 → auth-failed state +
  60 s probes (visible in `FeedStatus` on every client); other errors →
  exponential backoff capped 60 s. `retries: 0` inside a cycle — the loop is
  the retry.
- Normalization = the **same shared pure code** as the client (§5): route_type
  filter, counted rejections, km-string→m, never coerce, never substitute
  delivery time for fix time.
- Diffing: a snapshot is *changed* iff `observedAtMs` advanced or
  `shapeDistM`/`tripId` changed. Unchanged vehicles are not rewritten (no
  subscription churn). Vehicles unseen for > 90 s (`STALE_AFTER_MS`) are
  deleted.

## 3. Streaming to clients (`RemoteFeed`)

Client dependency: `convex` (ConvexReactClient — plain client API, no React
binding needed inside the feed; native WebSocket, works on RN/Hermes).

- On `start()`: one-shot `stream.fullFleet` query → seed the local fleet map →
  emit the full array. Then subscribe to `stream.batchesSince(lastSeq)`;
  each update folds `changed` rows into the fleet map and **emits the merged
  full array** (the runtime contract — a diff-only emit would silently shrink
  the fleet, recon §6). Seq gap (retention outrun) → re-run `fullFleet`.
- End-to-end latency: fix age + ≤2 s server poll + Convex push (~100–300 ms)
  vs today's fix age + ≤5 s client poll. The engine is observation-primary —
  fresher fixes need zero engine changes and directly shrink the dominant
  error term (fix staleness, calibration recon §3).
- `FeedStatus` mapping: `lastBatchAtMs` = last update arrival; `pollIntervalMs`
  = negotiated server cadence; `inFlight` = WS reconnecting; `authFailed` =
  server-reported auth state; plus server poller health mirrored from
  `pollerState` (a client can show "feed degraded" when Golemio itself is
  down — impossible today).
- Fallback: if the WS cannot establish within a budget (or the feature flag is
  off), construct `LocalGolemioFeed` instead — same interface, swapped behind
  `getRuntime()`. Settings gains a `feedSource: 'auto' | 'remote' | 'local'`
  developer toggle during rollout.
- `stop()`: unsubscribe + close; generation counter guarantees no post-stop
  callbacks (same discipline as LocalGolemioFeed).

## 4. Server-side 24/7 calibration (the point of the backend)

The server sees **every fix of every tram around the clock** — no client
sessions needed. Per fresh fix pair (prev → new, per vehicle), an internal
mutation folds into aggregates **immediately; raw fixes are never stored**:

- **Moving-span gate (R13 semantics):** spans are excluded when either
  endpoint is `at_stop`, the span is flat (`Δdist < 15 m`), the gap is
  outside [8 s, 240 s], or the span is physically impossible (`Δdist < 0` or
  implied speed > 22 m/s ≈ 79 km/h — a *teleport-threshold* gate was wrong
  here: a legitimate 240 s moving span covers ~2.8 km and would have been
  rejected, discarding the cleanest pace signal; amended 2026-08-01 after
  scaffold verification). Only
  confidently-moving spans update pace stats — signal standstills stop
  polluting pace, by construction, fleet-wide.
- **Pace aggregation:** span speed `Δdist/Δ(obsAt)` folded (time-decayed EWMA,
  half-life ~14 days) into `segmentStats[(shapeId, 250 m bucket, hourBand(4h),
  dayType)]`, `modelStats[model]`, `vehicleStats[key]`. `shape_id` is stable
  across days (recon §4) — segments accumulate history indefinitely.
- **Dwell aggregation:** `at_stop` runs (obsAt advancing, obsDist flat)
  attributed via `nextStopSequence` → `stopStats` dwell budgets. This turns
  the R8 zonal-dwell finding into a continuously-learned per-stop table
  instead of a two-zone constant.
- **Bundle:** hourly cron compacts into `bundles`: 
  `{version, generatedAtMs, vehicleBias: {key → factor}, modelBias, segments:
  [{shapeId, fromM, toM, hourBand, dayType, paceMs, n}], stops: [{stopId,
  hourBand, dwellS, n}]}` with minimum-sample floors and shrinkage toward the
  parent level (vehicle → model → fleet), honoring the calibration program's
  discipline (RUNBOOK §5). Size target: tens of KB.
- **Client seeding:** engine v2 accepts an optional `CalibrationPriors`
  provider; sim creation seeds `paceBias` from
  `vehicleStats → modelStats → PACE_BIAS_PRIOR` and dwell fallbacks from
  `stopStats` instead of flat 18 s. Local EWMA fine-tunes from there,
  exactly as designed in `backend-plan.md` §4. The TOD/zonal *hooks* in
  `speedProfile.ts` stay; their values now have a data source that never
  sleeps.
- Client `reportCalibration` (sim-vs-reality error telemetry) becomes an
  optional batched mutation later — **not required** for pace/dwell learning,
  which is pure AVL. Phase 1 ships without it; motionlog keeps the local
  mirror.

## 5. Code sharing (one normalization, one geometry builder)

Convex bundles imports from outside `convex/` (esbuild), so pure modules are
imported directly from `src/lib` — **no forks**:

- `src/lib/golemio/normalize.ts` (extracted from `vehicles.ts`): raw feature →
  `TramSnapshot` + rejection taxonomy. Client keeps re-exporting; server
  imports the same function. RN-specific bits (rate-limit scheduler, expo
  fetch wrapper) stay client-only.
- `src/lib/golemio/gtfs.ts` build path (`buildRouteGeometry`,
  `projectDistanceOnPolyline`, Prague DST resolver): already pure — the
  hand-rolled DST resolver runs identically on the server, so client-cached
  and server-served geometry epochs agree at DST boundaries by construction.
- `src/lib/engine/speedProfile.ts` (pure): phase 2 — server precomputes
  per-shape curvature + day/night speed profiles into `geometries`.

## 6. Secrets, auth, ops

- `GOLEMIO_KEY` — Convex env var, server-only. The `EXPO_PUBLIC_GOLEMIO_KEY`
  ships only while `LocalGolemioFeed` remains the fallback; rotation out of
  the bundle is the last rollout step (backend-plan.md §5 step 5).
- Client auth v1: Convex public functions (read-only stream + geometry).
  Abuse surface is read-only public transit data; per-install tokens can come
  later without protocol changes.
- Cost envelope: one poll loop (~43k function calls/day) + one mutation per
  changed batch + subscriptions fan-out; `batches` retention sweep keeps the
  table tiny. Fits Convex free/starter tiers for a single-city deployment.
- Deploy prerequisite (manual, once): `npx convex dev` login + project
  creation — interactive, owner-performed.

## 7. Rollout

1. **Scaffold** `convex/` + shared-code extraction + `RemoteFeed` behind
   `feedSource` flag (default `local`). Engine untouched.
2. Deploy poller + stream; internal testing with `feedSource: 'remote'`;
   compare `FeedStatus` health + deviation stats vs local.
3. Calibration folding + bundle + engine-v2 prior seeding.
4. Geometry serving (`geometries` + precomputed profiles); client shape cache
   points at Convex with Golemio fallback.
5. `feedSource` default `auto` (remote with local fallback); key rotation.
