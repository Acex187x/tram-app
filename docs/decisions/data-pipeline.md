# Data Pipeline — Golemio API decisions

Decision records for how Tram Spotter ingests live Prague tram data and turns it
into route geometry the interpolation engine can animate. Source of truth is the
code in `src/lib/golemio/*`; empirical API findings live in
`docs/research/golemio-api.md` (all verified with `curl` against production on
2026-07-11, since apiary/openapi HTML docs were down).

Modules:
- `client.ts` — rate-limited fetch wrapper + global scheduler.
- `vehicles.ts` — live snapshot poll (`/v2/vehiclepositions`).
- `gtfs.ts` — trip geometry + timetable normalization, Prague-time resolver.
- `shapeCache.ts` — two-level RouteGeometry cache keyed by tripId.
- `apiTypes.ts` — raw wire types, transcribed from the live API.

---

## 1. Vehicle feed: unfiltered `/v2/vehiclepositions?limit=10000` + client-side `route_type===0`

**Problem.** Get "all trams, now" with fix timing good enough to interpolate
smooth motion between sparse AVL pings.

**Options.**
1. `/v2/vehiclepositions?limit=10000`, filter `route_type === 0` in the client.
2. `/v2/public/vehiclepositions?routeType=tram` — real server-side tram filter,
   66 KB vs 886 KB.
3. 38 per-route requests (`routeId=L1…`) — one per tram line.
4. GTFS-RT protobuf feeds.

**Decision.** Option 1. `src/lib/golemio/vehicles.ts:27` — `fetchTramSnapshots`
requests `{ limit: 10000 }` (no route filter) and drops every feature whose
`properties.trip.gtfs.route_type !== 0` (`ROUTE_TYPE_TRAM = 0`, line 17,42).

**Why.**
- **No server-side tram filter exists on this endpoint.** `routeType=tram` →
  `400 Unknown field(s)`. `routeId`/`routeShortName` accept a *single* value only;
  `routeId=L1,L2` silently returns 0 results, `routeId[]=…` → 400. So filtering
  server-side means 38 requests per poll (option 3) — wasteful and blows the rate
  budget every cycle.
- **The `/v2/public` variant drops the fields the engine needs.** It has no
  `origin_timestamp` (AVL fix time), no `shape_dist_traveled`, no
  `last_stop`/`next_stop`, no `vehicle_registration_number`. Without
  `origin_timestamp` you only know "now" as the observation time and real fix age
  is hidden — you cannot drive honest interpolation. This was the deciding factor.
- **Cost is a non-issue.** Full citywide feed is ~886 KB in ~80 ms; ~172 trams of
  ~767 tracked vehicles at test time. One request per poll fits comfortably inside
  20 req/8 s.
- GTFS-RT protobuf (option 4) has a *staler* CDN cache (`s-maxage=40` vs `5`) and
  needs a protobuf decoder for no benefit. Skipped.

**Gotchas baked in.**
- Do **not** pass `includeNotTracking`/`includeNotPublic`. Defaults already
  exclude the ~1450 stale/ghost trips (2265 → 767 vehicles). `normalizeFeature`
  assumes every surviving feature has a live fix.
- `route_type` (extended GTFS: 0=tram) is the discriminator, **not**
  `trip.vehicle_type` — the latter is `null` for non-DPP vehicles.

---

## 2. Entity keying: registration number, trip_id fallback

**Problem.** The live map and interpolation engine need a stable per-vehicle key
across polls; a physical tram must stay the same entity as its position updates.

**Decision.** `src/lib/golemio/vehicles.ts:70-77` —
`key = registrationNumber != null ? String(registrationNumber) : gtfs.trip_id`.
`registrationNumber` is coerced to `null` unless it is actually a `number`
(line 71).

**Why.** `vehicle_registration_number` is DPP's physical fleet/inventory number
(the "evidenční" number, observed tram range ~7269–9516) — it identifies the
*railcar*, so it is the most stable identity and also what the fleet→3D-model
lookup keys on. It is `null` for non-DPP vehicles, so `trip_id` is the fallback.

**Caveat — two keyspaces.** Snapshots key by fleet/trip (`vehicles.ts`), but
geometry (`shapeCache.ts`) keys by **`trip_id`**. These are deliberately
different: a fleet number is the vehicle, a trip_id is the run it is currently
serving. The engine joins them via the snapshot's `tripId` field.

---

## 3. Geometry source: `/v2/gtfs/trips/{id}?includeShapes&includeStopTimes&includeStops`

**Problem.** The engine needs, per active trip: the ordered polyline, cumulative
distance along it, and every stop's coordinate + scheduled epoch time + dwell.

**Decision.** `src/lib/golemio/gtfs.ts:305` — `fetchTripGeometry` fetches the
single trip detail with all three enrichment flags on (line 312-316) and
`buildRouteGeometry` (line 325) normalizes it into `RouteGeometry`.

**Why one trip request instead of separate shape/stop calls.**
- `includeShapes` → `shapes[]` (GeoJSON Point features, sorted by
  `shape_pt_sequence`) — the polyline + per-point `shape_dist_traveled` (numeric km).
- `includeStopTimes` → `stop_times[]` with `stop_sequence`, GTFS clock strings,
  `computed_dwell_time_seconds`, and per-stop `shape_dist_traveled`.
- `includeStops` → each stop_time carries a nested `stop` Feature with coordinates
  + `stop_name`. Without this flag stops are id-only.
- There is **no bulk "all shapes for route X" endpoint** and `/v2/gtfs/trips` has
  **no `routeId` filter** (`400 Unknown field(s)`). The trip object is the only
  place that authoritatively says which `shape_id` a live trip is using, so
  fetching by the trip_id you already have from the live feed is the natural join.

**Normalization details (`buildRouteGeometry`).**
- Line derived by stripping the `L` prefix from `route_id` (`routeIdToLine`,
  line 296): `L91` → `"91"`.
- Terminal flagged by `stop_sequence === lastSequence` (line 343, 386).
- Dwell from `computed_dwell_time_seconds ?? 0` (line 385).

---

## 4. The km-string vs km-number parsing trap

**Problem.** `shape_dist_traveled` is the *same conceptual field* across three
endpoints but is typed inconsistently — a real cross-endpoint type mismatch in one
API family. Miss it and distances silently come out 1000× wrong or `NaN`.

**Facts (all in km, never meters — a 10.756 km line reads `10.756`):**
| source | type | code |
|---|---|---|
| `/v2/vehiclepositions` `last_position.shape_dist_traveled` | **STRING** `"5.871"` | `apiTypes.ts:39` |
| `shapes[].properties.shape_dist_traveled` | **NUMBER** `5.871` | `apiTypes.ts:134` |
| `stop_times[].shape_dist_traveled` | **NUMBER** (nullable) | `apiTypes.ts:147` |

**Decision.**
- Live snapshot: `kmStringToMeters` (`vehicles.ts:50`) does
  `Number.parseFloat(value) * 1000`, guarding `null`/`NaN` → `0`.
- Geometry: `buildRouteGeometry` multiplies numeric km by 1000 directly
  (`gtfs.ts:336`, `363`).
- Everything downstream is **meters**. `docs/research/golemio-api.md` states the
  standing rule: coerce `shape_dist_traveled` to a number everywhere.

---

## 5. Rate-limit scheduler (`client.ts`)

**Problem.** The API key is a shared, rate-limited resource (20 req/8 s per key,
per the OpenAPI `info.description` — no `X-RateLimit-*` headers, 429 behavior
never observed). Many callers hit several endpoints per poll cycle; a
tapped-tram's geometry request must jump ahead of background prefetch. A naive
`setInterval`-per-request-type would breach the limit.

**Decision.** One process-wide scheduler (`client.ts:59-206`) that every request
funnels through via `golemioFetch` (line 245). Design:

- **Concurrency + window caps.** `MAX_CONCURRENT = 4` in flight,
  `MAX_PER_WINDOW = 16` request *starts* per rolling `WINDOW_MS = 8000`
  (line 61-63). 16 is deliberately under the documented 20/8 s for headroom.
- **Priority queue.** 0=urgent, 1=normal, 2=background; ties broken by insertion
  order (`seq`). `pump` scans for the lowest `(priority, seq)` (line 122-130).
  Live poll defaults to **0** (`vehicles.ts:32` — "heartbeat of the live map");
  route inventory and prefetch default to **2**.
- **Tag / path promotion.** `promoteTag(tag, priority)` (line 197) raises the
  priority of a still-queued waiter when the user taps a tram whose geometry was
  enqueued at background priority. Matches by explicit `tag` **or** by the request
  *path* containing the tag (`waiterMatchesTag`, line 178) — so a trip_id embedded
  in `/v2/gtfs/trips/{id}` can be promoted without threading a tag through every
  intermediate module. Returns whether it matched, so the caller knows the request
  is already in flight and need not re-issue.
- **Anti-starvation aging — floored at priority 1.** A background waiter older
  than `AGING_MS = 30_000` is bumped up one level and its aging clock reset, so a
  sustained urgent/normal stream cannot keep background work queued forever. Aging
  **never lifts a waiter into the urgent lane** (`AGING_FLOOR = 1`): 0 is reserved
  for the live poll and tapped-tram promotions. Unbounded aging marched a
  cold-start geometry backlog (hundreds of waiters) 2→1→0 within two windows,
  where its older `seq` numbers outranked every fresh poll/tap — the fleet froze
  and visible trams sat as loading dots for minutes (red-dot recurrence,
  2026-07-18).
- **Tag / path demotion.** `demoteTag(tag, priority)` mirrors `promoteTag`: the
  per-poll geometry warm-up demotes a queued shape whose tram left the viewport
  (never urgent waiters; a demotion restarts the aging clock). Promote + demote
  together re-assert queue priorities from the freshest poll + viewport every
  cycle, so a deep backlog keeps tracking what is on screen NOW instead of its
  enqueue order.
- **Wake scheduling.** `pump` computes the soonest instant it must re-run (window
  slot freeing, or next aging deadline) and arms a single `pumpTimer`
  (line 142-151) rather than polling.

**Error taxonomy** (`client.ts:29-57`): `GolemioHttpError` (non-2xx, carries
status+body), `GolemioNetworkError` (transport/JSON-parse failure),
`GolemioAbortError` (signal aborted). Callers can distinguish "server said no"
from "offline" from "cancelled".

Added/hardened in the fix wave (commit `77e193f`: "queue promotion+aging");
covered by `__tests__/golemio-client.test.ts`.

---

## 6. Shape cache: memory + disk, TTL, service-day re-anchoring on read

**Problem.** Geometry is expensive (~40 KB/trip) and the render loop needs
synchronous access. But `trip_id` encodes the service date and rotates ~daily, and
a cache entry read on a *later* service day than it was written replays a
past-dated timetable → schedule anchors run off the end of the trip → trams
teleport/stick. (This is the "day-stale timetable bug", fix wave `77e193f`:
"day-stale cache re-anchoring".)

**Decision.** Two-level cache in `src/lib/golemio/shapeCache.ts`, keyed by
`trip_id`:

- **Memory** — `memCache: Map<tripId, RouteGeometry>` (line 37). Synchronous
  `has()`/`getLoaded()`/`getAllLoaded()` for the render loop and planner graph
  (line 178-190).
- **Disk** — one JSON file per trip under `Paths.cache/tripgeo/`
  (`<sanitized-tripId>.json`); survives restarts. `TTL_MS = 3 days` — raised from
  24 h (red-dot recurrence, 2026-07-18): trip_ids live ~12 days and every read is
  service-day re-anchored anyway, but the 24 h TTL expired between daily sessions,
  so EVERY cold start re-fetched the whole visible fleet through the 16-starts/8 s
  rate limit. (Not a single JSONL file — one file per trip, best-effort writes that
  swallow errors so the in-memory cache still serves the session.)
- **Single-flight** — `getTripGeometry` (line 131) dedupes concurrent requests for
  the same trip_id through an `inFlight` promise map. Lookup order: memory → disk →
  network; a disk/network hit populates memory.
- **Prefetch** — `requestPrefetch` warms a batch at the caller's priority,
  skipping already-cached/in-flight ids (a re-request for an in-flight id
  promotes/demotes its queued scheduler waiter instead — priorities re-asserted
  each poll), swallowing errors.

**Service-day re-anchoring (the fix).** On every disk read, `reanchor`
(line 93) shifts stop epochs onto the *current* service day. The timetable
(seconds-of-service-day) is invariant; only which calendar day it applies to
changes. `serviceDayShiftMs` (`gtfs.ts:193`) recovers the trip's
`[firstDepSec, lastArrSec]` window relative to the stored midnight, re-picks the
current service midnight via the same `computeServiceMidnightMs` candidate logic as
the initial build, and returns the delta (0 if unchanged). The disk entry stores
`serviceMidnightMs` (`geometryServiceMidnight`, `gtfs.ts:177`) written at save
time; entries predating that field fall back to deriving it from the geometry
(line 97-100).

**Known limitation (documented, not fixed).** In-memory entries are **not**
re-anchored while resident (`shapeCache.ts:30-36`). A session running uninterrupted
across the ~03:00 service-day rollover keeps replaying that day's timetable until
eviction (cold start re-reads disk → re-anchors). Accepted because trip_ids rotate
~every 12 days so a fresh trip_id forces a re-fetch well before this bites; a
dedicated long-running app would need periodic `memCache` invalidation.

Covered by `serviceDayShiftMs` tests in
`__tests__/gtfs-time.test.ts:204-261` ("TIME-2 re-anchoring").

**Failure memory (2026-07-19, "roundel-forever" fix).** A trip whose geometry
fetch FAILS was previously re-issued by EVERY 5 s poll: the per-poll warm-up
found it neither cached nor in flight and started a fresh request. Three trip
classes never converged and each burned a visible-lane rate-limit slot per poll
— a handful of doomed trips could eat most of the 16-starts/8 s window and
starve the fetches that COULD succeed (so *other* trams stalled as roundels
too):

1. **`missing`** — non-retryable 4xx, dominated by 404: the vehicle feed
   reports a `trip_id` that is not (yet) in the GTFS static dataset (daily
   dataset changeover, diverted/extra services). Can legitimately appear after
   the next dataset refresh.
2. **`degenerate`** — HTTP 200 whose payload has no usable shape (< 2 polyline
   points or `totalM == 0`). Worse than a failure: `buildRouteGeometry`
   happily built it and the cache stored it as SUCCESS in memory **and on disk
   (3-day TTL)** — `has()` true, nothing renderable, a silent forever-dot.
3. **`transient`** — timeout/network/5xx/429 after the client's own retries.

Fixes, all in `shapeCache.ts`:

- **Never cache non-usable geometry.** `isUsableGeometry` gates both the fetch
  path (degenerate 200 → throws `GeometryUnavailableError`, nothing cached) and
  `readDisk` (old degenerate disk entries are evicted, not resurrected).
- **Per-trip failure memory with re-check backoff** (`failCache`): a recorded
  failure makes non-urgent requests reject fast (no scheduler slot, no
  network) until `nextRetryAtMs`. Exponential per class: transient
  10 s → cap 2 min; missing/degenerate 60 s → cap 15 min (only a dataset
  refresh can fix those). The 5 s poll's warm-up remains the retry driver —
  `requestPrefetch` simply skips trips inside their window, so a failed fetch
  IS retried (first due poll after the backoff) and a visible tram cannot
  stay a roundel forever because of one bad response. Success clears the entry;
  lifecycle aborts are never recorded (a backgrounded session must not open a
  backoff window against the next one).
- **Taps bypass** — priority 0 requests ignore the backoff: a user poke always
  gets a fresh attempt (`promoteGeometry` → `requestPrefetch([id], 0)`).
- **Diagnosis** — `getGeometryFailure(tripId)` exposes `{kind, attempts,
  lastError, nextRetryAtMs}`; `__DEV__` logs every recorded failure with its
  re-check delay.
- Related fix in `client.ts`: `promoteTag`/`demoteTag` path matching now
  requires the id to be a complete trailing path segment — the old substring
  `includes` let a tap on trip `…_104` "match" a queued `…_1040…` waiter, so
  the urgent fetch for the actually-tapped tram was silently skipped.

Covered by `__tests__/shape-cache-failure.test.ts` (backoff + retry-resolves,
missing vs transient schedules, degenerate-not-cached, tap bypass, abort not
recorded), `golemio-client.test.ts` (segment-boundary matching) and
`tram-feed.test.ts` (per-poll re-request of a still-missing visible trip).

---

## 7. Prague-local time resolution — hand-rolled DST resolver

**Problem.** GTFS gives wall-clock strings on the Prague service day. Converting
them to epoch ms correctly requires the Europe/Prague UTC offset at each instant,
including DST transitions (a local day is 23 h spring-forward / 25 h fall-back).
Two extra wrinkles: GTFS hours exceed 24 for after-midnight runs, and Hermes
(RN's JS engine) has unreliable `Intl` timezone support.

**Decision.** A self-contained EU-DST resolver in `gtfs.ts`, no `Intl` dependency:

- `pragueOffsetSeconds(utcMs)` (line 57) — CEST (+7200) from the last Sunday of
  March 01:00 UTC to the last Sunday of October 01:00 UTC, else CET (+3600),
  computed from the EU rule directly.
- `pragueMidnightEpoch` (line 70) / `pragueLocalToEpoch` (line 95) — resolve a
  Prague wall clock to epoch, handling overflowing components (day 32, hour 25).
- `gtfsSecondsToEpoch(serviceMidnightMs, sec)` (line 122) — splits GTFS
  seconds-of-service-day into a day offset (for >24:00) + in-day wall clock, then
  routes through `pragueLocalToEpoch` so DST is correct.

**Ambiguity policy** (line 88-93, 106-110): the repeated fall-back hour resolves to
its **first** (earlier, CEST) occurrence; a nonexistent spring-forward hour rolls
**forward** using CET. It tries CEST (+2h) before CET (+1h) to get this ordering.

**Why not `Intl`-only.** `Intl.DateTimeFormat` timezone handling is unreliable on
Hermes (stated at `gtfs.ts:55-56`), so the app cannot trust
`timeZone: 'Europe/Prague'`. The EU rule is simple and stable enough to hand-roll,
and it makes the resolver pure and unit-testable.

**Service-day selection.** `computeServiceMidnightMs(firstDep, lastArr, now)`
(line 149) picks yesterday/today/tomorrow's Prague midnight whose resolved trip
window sits closest to `now` — because an after-midnight run belongs to the
*previous* calendar day's service day.

Exhaustively tested in `__tests__/gtfs-time.test.ts` — both DST boundaries
(2026-03-29, 2026-10-25), >24:00 overflow across each transition, and service-day
picking for daytime vs after-midnight trips. Introduced/hardened in fix wave
`77e193f` ("DST-safe GTFS times").

---

## 8. Sequential monotonic stop projection fallback

**Problem.** Some stops lack `shape_dist_traveled` (nullable in the feed). To place
such a stop on the polyline you must project its coordinate onto the shape — but on
loops/crossings the nearest segment can be an *earlier* leg the stop happens to sit
close to, producing a non-monotonic stop series that breaks distance-based
animation.

**Decision.** `projectDistanceOnPolyline` (`gtfs.ts:230`) projects the stop
coordinate onto the nearest polyline segment (local equirectangular meters around
the stop latitude), but constrained by a **lower bound** = the previous stop's
distance:

- It keeps two candidates: the nearest segment whose projected distance is
  ≥ `minDistM − PROJECTION_BACK_TOL_M` (5 m tolerance, line 215), and an
  unconstrained globally-nearest fallback for degenerate geometry (line 248-279).
- Prefers the constrained (forward) candidate; falls back to global nearest only
  when no forward candidate exists (line 281-285). Result clamped to `minDistM`.

`buildRouteGeometry` drives this sequentially, threading `prevDistM` and clamping
the whole series monotonic — guarding both projected stops **and** any
non-monotonic `shape_dist_traveled` the feed itself emits (`gtfs.ts:357-368`).

Tested in `__tests__/gtfs-time.test.ts:161-201` — including the loop case where an
unbounded projection snaps backward (~715 m) but the lower-bounded call correctly
projects forward onto the inbound leg.

---

## Cross-cutting API facts worth keeping (from `docs/research/golemio-api.md`)

- **Auth** — header `X-Access-Token: <jwt>` (not `Authorization: Bearer`).
  `client.ts:230` reads `EXPO_PUBLIC_GOLEMIO_KEY`. CORS is `*`, so no proxy needed.
- **`speed` is always `null`** in the feed — DPP does not populate it. Derive speed
  from consecutive fix pairs; never build UI on a live speed readout.
- **trip_id format** `<route>_<seq>_<YYMMDD>` encodes the service date and rotates
  ~daily; `route_id`/`shape_id` are stable. GTFS static data valid ~12 days.
- **38 tram routes** today (`route_type === 0`): day lines with gaps (no 14, 27–30,
  33, 35–38; includes 31/32/34/39) + night 91–99. Don't assume a contiguous range.
  Every tram route shares `route_color` `7A0603` — per-line colors are an app
  decision, not from the API.
- **AVL fixes arrive every ~15–50 s per vehicle**, irregular. CDN cache
  `s-maxage=5`. Poll every 5–10 s; the engine must handle variable gaps, driven off
  `origin_timestamp` deltas, not a fixed cadence.
</content>
</invoke>
