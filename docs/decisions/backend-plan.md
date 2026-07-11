# Backend Plan — moving the feed off the client

Design record for the future Tram Spotter backend. Nothing in this document is
built yet; what IS built is the client-side seam that makes it a drop-in: the
`TramFeed` interface (`src/lib/feed/types.ts`) and its on-client implementation
`LocalGolemioFeed` (`src/lib/feed/localGolemioFeed.ts`). Today "the backend
runs on the client"; this doc is the contract for the day it doesn't.

---

## 1. Motivation — what the client-only architecture cannot do

- **Poll cadence is capped at ≥ 5 s per client, foreground only.** Every app
  instance burns its own slice of the shared Golemio budget (20 req/8 s per
  key; we self-cap at 16 starts/8 s — `client.ts`). The citywide
  vehiclepositions payload is ~886 KB per poll *per client*, and polling stops
  entirely while backgrounded — every foreground return starts cold. AVL fixes
  land at Golemio every ~15–50 s per vehicle with a CDN cache of `s-maxage=5`;
  a 5 s client poll adds up to 5 s of extra latency on top and cannot be
  shortened without multiplying key usage by the install base.
- **Per-client calibration is wasted work.** Each device independently
  re-learns the same physical truth — how fast tram 9243 actually takes the
  Ječná grade at 8 am — via its local `paceBias` EWMA, then throws it away at
  session end. Deviation telemetry (`CalibrationRecord`) is already collected
  per poll (motionlog), but it aggregates nowhere. The fleet-wide signal (one
  observation stream per tram per line segment, 24/7) only exists server-side.
- **One API key per app is a scaling wall.** N clients ≙ N pollers against a
  rate-limited shared resource. A backend collapses this to exactly one
  poller, independent of installs, and turns per-key rate limits into a
  non-issue for the app's growth.
- **Heavy preprocessing repeats on every device.** Shape → curvature →
  speed-profile → stop-projection normalization is deterministic per
  `shape_id` yet recomputed (and disk-cached) per client.

## 2. Server responsibilities

1. **Poll Golemio at ~1–2 s with a single key** (the CDN caches at
   `s-maxage=5`, so ~1–2 s polling reads each fresh CDN object almost as soon
   as it exists; requests beyond that only re-read cache). One poller fans out
   to all connected clients.
2. **Diff + push, not rebroadcast.** Keep the last snapshot per vehicle key;
   on each poll emit only vehicles whose `origin_timestamp` or
   `shape_dist_traveled` advanced. Clients receive fresh fixes the moment the
   feed exposes them — end-to-end latency drops from "fix age + ≤5 s client
   poll" to "fix age + ~1 s server poll + push". A full snapshot is sent once
   on connect/resume, diffs after.
3. **Serve PRE-PROCESSED `RouteGeometry`.** The server runs the equivalent of
   `gtfs.ts` + `speedProfile.ts` once per `shape_id`: polyline + cumulative
   meters, per-vertex curvature, **precomputed speed-limit profile** (day and
   night variants), and monotonic stop projections with resolved epoch times.
   Clients stop computing curvature/speed profiles on device — the client-side
   `speedProfile.ts` can eventually be dropped, or kept as an offline fallback
   for `LocalGolemioFeed` (recommended: keep as fallback; it is pure, tested,
   and small).
4. **Aggregate `CalibrationRecord`s fleet-wide.** Ingest every client's
   deviation records (the exact shape already defined in
   `src/lib/feed/types.ts`) and learn **pace priors per (tram model, line
   segment, time-of-day bucket)** — e.g. "15T between Karlovo náměstí and
   Moráň, weekday 07–09: 0.92× profile pace". Ship them back as a small
   **calibration bundle** (see §3) so every client starts with the fleet's
   knowledge instead of a cold EWMA.
5. **Serve arrivals/departures queries** (per stop, per line) from the same
   in-memory live state + timetable, replacing client-side derivation for the
   stop/line sheets where convenient.

## 3. API sketch (v1)

Transport recommendation: **WebSocket** for the live stream, plain HTTPS for
everything else.

*Why WebSocket over SSE:* React Native has first-class native WebSocket
support but no built-in `EventSource` (SSE needs a polyfill over fetch
streaming); WS gives us a duplex channel — subscription scoping (viewport /
followed-tram filters), resume negotiation, and explicit ping/pong keepalive
that directly feeds the client's `FeedStatus.lastBatchAtMs` health signal —
plus `permessage-deflate` compression of the highly repetitive JSON batches.
SSE's advantages (plain HTTP, proxy friendliness, built-in `Last-Event-ID`)
matter most in browsers; this is a native app. SSE remains the documented
fallback if WS proves hostile to some mobile networks.

```
WS  /v1/stream?token=<auth>&resume=<resumeToken>
  server → client:
    {type:'hello', resumeToken, fullSnapshot: TramSnapshot[], atMs}
    {type:'batch', snapshots: TramSnapshot[], atMs, seq}     # diffs, ~1–2 s
    {type:'ping', atMs}                                       # every 15 s
  client → server:
    {type:'pong', atMs}
    {type:'scope', viewportBbox?, followKeys?}                # optional filter
  Resume: on reconnect the client presents the last `resumeToken` (opaque,
  encodes seq); the server replays missed diffs if within its ~60 s buffer,
  else sends a fresh fullSnapshot. Either way the client's TramFeed contract
  (subscribeSnapshots batches) is unchanged.

GET /v1/geometry/{tripId}
  → preprocessed RouteGeometry + speed profile (+ curvature), immutable per
    (shape_id, service-day anchor); ETag = shape_id + timetable version;
    Cache-Control: max-age=86400. Client keeps disk-caching exactly as today.

GET /v1/calibration-bundle
  → { version, generatedAt, priors: [{model, shapeId, fromDistM, toDistM,
      dayBucket, paceFactor, confidence}, …] } — small (tens of KB), fetched
    on launch + every few hours, ETag-cached.

POST /v1/calibration
  ← gzip JSONL of CalibrationRecord, batched (e.g. ≤500 records / ≥60 s
    apart). Fire-and-forget from the client's perspective; server dedupes on
    (key, t).

Auth: per-install anonymous token (signed, revocable) in the `Authorization`
header / WS query param — the Golemio key never ships in the app anymore
(today it is EXPO_PUBLIC_*, i.e. extractable).
Versioning: URL-versioned (/v1/); the WS hello carries a protocol version so
old clients can be told to fall back to LocalGolemioFeed gracefully.
```

## 4. Client migration — why this is cheap now

- **`RemoteFeed implements TramFeed` 1:1.** `subscribeSnapshots` ← WS batches;
  `getGeometry`/`requestGeometry`/`promoteGeometry` ← the same two-level disk
  cache backed by `GET /v1/geometry` instead of Golemio GTFS;
  `reportCalibration` ← the batched gzip POST; `status()` ← last batch/ping
  time + socket errors. `TramRuntime` already consumes the interface and never
  sees the difference (`src/hooks/tramData.ts` takes an injected `TramFeed`).
- **Feature-flag feed selection.** `getRuntime()` picks the feed at
  construction: remote when the flag is on and the endpoint is reachable,
  `LocalGolemioFeed` otherwise. The flag can be a settings toggle during
  rollout.
- **Offline / outage fallback.** If the WS cannot (re)establish within a
  budget, swap to `LocalGolemioFeed` (it still ships, unchanged) — same
  interface, so the swap is a stop()/start() of two feed objects behind the
  runtime.
- **Engine unchanged.** The interpolation engine keeps its physics and its
  local `paceBias` EWMA; the calibration bundle only changes the EWMA's
  *starting point*: seed per-segment pace from the fleet prior, then fine-tune
  locally exactly as today ("prior from bundle + local fine-tune"). No engine
  API changes required — seeding happens where sims are created.
- **Bonus already banked:** faster batches (1–2 s) need zero client changes —
  the pace controller is observation-primary and simply gets fresher
  observations; teleports and catch-up sprints become rarer.

## 5. Ops notes

- **Golemio ToS / rate limits.** One backend key polling at 1–2 s is ~4–8
  starts/8 s — inside the documented 20/8 s, but a persistent single-tenant
  consumer should be cleared with Golemio (they offer partner arrangements);
  keep the per-request `User-Agent`/contact header honest. Respect
  `s-maxage=5` — polling faster than ~1 s only re-reads cache.
- **Caching.** Geometry and calibration-bundle responses are CDN-cacheable
  (immutable by ETag); the WS layer is the only stateful part. Live state fits
  trivially in memory (~800 vehicles × ~1 KB).
- **Cost envelope.** One poller + one small always-on process; the dominant
  cost is WS fan-out egress: ~170 trams × diff rate — a compressed diff batch
  is a few KB/s per client worst case, less with viewport scoping. A single
  small instance + CDN serves the realistic install base; no per-client
  Golemio cost at all.
- **Rollout steps.**
  1. Ship `POST /v1/calibration` + start collecting (clients keep
     LocalGolemioFeed; `reportCalibration` gains the remote sink behind a
     flag, motionlog stays as local mirror).
  2. Ship `GET /v1/geometry` and point the shape cache's network layer at it.
  3. Ship `WS /v1/stream`; enable `RemoteFeed` for internal users; compare
     `FeedStatus` health + deviation stats against local-feed users.
  4. Ship the calibration bundle + prior seeding; A/B deviation metrics.
  5. Default RemoteFeed on; LocalGolemioFeed remains the offline fallback;
     rotate the Golemio key out of the app bundle.

## 6. What already exists in the client (the seam)

| piece | file | status |
|---|---|---|
| `TramFeed` interface + `CalibrationRecord` | `src/lib/feed/types.ts` | shipped |
| `LocalGolemioFeed` (5 s poll loop, cache + motionlog delegation) | `src/lib/feed/localGolemioFeed.ts` | shipped |
| Record building (field order/rounding = wire + JSONL contract) | `src/lib/feed/calibration.ts` | shipped |
| Runtime consumes injected feed | `src/hooks/tramData.ts` | shipped |
| Storage split: feed owns *when*, motionlog owns *how/where* | `src/lib/motionlog/core.ts` (`onCalibration`) | shipped |
| `RemoteFeed`, flags, bundle seeding | — | this plan |
