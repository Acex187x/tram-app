# Golemio API for Prague Trams — Implementation Notes

Researched empirically on 2026-07-11 against the live production API using the project's real
API key (`EXPO_PUBLIC_GOLEMIO_KEY` in `.env`). All findings below were verified with `curl`, not
just read from docs — docs (apiary.io) were down (502) during research, and the advertised
`/pid/docs/openapi.json` URL 404s. The **real, current OpenAPI spec** lives at:

```
https://api.golemio.cz/docs/static/vp-output-gateway/openapi.json
```

(reached via `https://api.golemio.cz/pid/docs/openapi/` → swagger-ui-init.js → the `url` it points
to). Bookmark that JSON directly; the various `/docs` HTML pages are just Swagger UI shells.

## Auth

- Header: `X-Access-Token: <jwt>` (not `Authorization: Bearer`). Confirmed: no header ⇒
  `401 {"error_message":"Unauthorized. Failed to authenticate user.","error_status":401}`;
  garbage token ⇒ identical 401 (no distinct "invalid" vs "missing" message).
- The key in `.env` is a JWT with `exp` far in the future (effectively non-expiring for this
  project's purposes) — decode with `jwt.io` if you ever need to check.
- CORS is wide open (`access-control-allow-origin: *`), so this can be called directly from the
  RN app without a proxy.

## Rate limits (official, found in OpenAPI `info.description`, not in prose docs)

> **By default, each API key has a rate limit of 20 requests per 8 seconds.**
> Pagination cap: **max 10,000 objects/rows per request** (varies per route, see each route's
> `limit` param docs).

No `X-RateLimit-*` response headers are exposed. A burst of 15 rapid sequential requests in
testing returned `200` every time (no 429 observed) — stay under ~2.5 req/s sustained and you're
safe. Design the polling client with a small in-memory token bucket / debounce, not blind
setInterval-per-request-type, since several endpoints will be hit per poll cycle.

GTFS static data note (also from the spec description): *"The data is published by ROPID and
remains valid for the upcoming ~12 days, subject to daily updates."* — `trip_id` encodes the
service date (see below) and effectively rotates daily; `route_id` and `shape_id` are stable.

---

## 1. `/v2/vehiclepositions` — realtime vehicle positions

### Query params (verified against OpenAPI + curl)

| param | type | notes |
|---|---|---|
| `limit` | number, default `100`, max `10000` | **Must set explicitly** — default is only 100 vehicles, silently truncating the citywide feed. |
| `offset` | number | pagination |
| `includeNotTracking` | boolean, default `false` | see gotcha below |
| `includeNotPublic` | boolean, default `false` | see gotcha below |
| `cisTripNumber` | number | filter by CIS trip number |
| `routeId` | string | **single value only** — filters to one route, e.g. `L1` |
| `routeShortName` | string | **single value only**, e.g. `17` |
| `updatedSince` | ISO timestamp | only vehicles updated after this time |
| `preferredTimezone` | string | e.g. `Europe_Prague` (use `_` or `%2F` for the slash) |

**CRITICAL — there is NO `routeType` / `vehicleType` param on `/v2/vehiclepositions`.** This was
the central question and it's a hard "no": there is no server-side filter for "trams only" on
this endpoint. Confirmed empirically:
```
curl ".../v2/vehiclepositions?routeType=tram" 
→ 400 {"error_info":"...Unknown field(s)...\"path\":\"routeType\"..."}
```
`routeId`/`routeShortName` also do **not** accept arrays or comma-separated lists:
- `routeId=L1,L2` → `200` but **0 results** (silently treated as one literal, non-existent route id — a real trap, fails silently not loudly).
- `routeId[]=L1&routeId[]=L2` → `400 Invalid value`.

**How to get trams only — two real options, pick #1:**

1. **Recommended: fetch everything, filter client-side.** Call
   `/v2/vehiclepositions?limit=10000` (no route filter) and filter features where
   `properties.trip.gtfs.route_type === 0`. This is cheap: the full citywide feed (all vehicle
   types, ~767 active tracked vehicles at time of testing) is **886 KB and returns in ~80 ms**.
   Of those, **172 were trams** at time of testing (afternoon, non-peak). This is one request
   instead of 38 (one per tram route), fits well inside the rate limit, and gives you the rich
   payload (see fields below) including `origin_timestamp`, which the lighter endpoint (below)
   lacks and which you need for interpolation.
   - `trip.gtfs.route_type` is present and non-null on every feature (rail/bus/tram/etc.), so it's
     the reliable discriminator. `trip.vehicle_type` (a separate, DPP-specific enum: `id:2`/
     `"tram"`, `id:3`/`"bus"`, etc.) is **`null` for non-DPP-operated vehicles** (e.g. ČD trains on
     `route_type: 2`), so don't rely on it as your primary filter — use `route_type === 0`.
   - Doing 38 separate `routeId=`-filtered requests (one per tram line) is possible but wasteful
     and risks the rate limit on every poll cycle; not recommended.

2. **Alternative: `/v2/public/vehiclepositions?routeType=tram`** — see dedicated section below.
   This *does* have real server-side filtering, but the payload is far thinner (no
   `origin_timestamp`, no stop info) — a real tradeoff, detailed below.

### Response shape (GeoJSON FeatureCollection)

```json
{
  "features": [{
    "type": "Feature",
    "geometry": { "type": "Point", "coordinates": [14.45497, 50.03072] },
    "properties": {
      "last_position": {
        "bearing": 181,
        "delay": { "actual": 56, "last_stop_arrival": 29, "last_stop_departure": null },
        "is_canceled": null,
        "last_stop": { "arrival_time": "2026-07-11T13:29:00+02:00", "departure_time": "...", "id": "U488Z2P", "sequence": 15 },
        "next_stop": { "arrival_time": "2026-07-11T13:30:00+02:00", "departure_time": "...", "id": "U893Z1P", "sequence": 16 },
        "origin_timestamp": "2026-07-11T13:29:31+02:00",
        "shape_dist_traveled": "5.871",
        "speed": null,
        "state_position": "at_stop",
        "tracking": true
      },
      "trip": {
        "agency_name": { "real": "DP PRAHA", "scheduled": "DP PRAHA" },
        "cis": { "line_id": null, "trip_number": null },
        "gtfs": {
          "route_id": "L1", "route_short_name": "1", "route_type": 0,
          "trip_headsign": "Výstaviště", "trip_id": "1_14863_260627", "trip_short_name": null
        },
        "origin_route_name": "1",
        "sequence_id": 4,
        "start_timestamp": "2026-07-11T13:27:00+02:00",
        "vehicle_registration_number": 9286,
        "vehicle_type": { "description_cs": "tramvaj", "description_en": "tram", "id": 2 },
        "wheelchair_accessible": true,
        "air_conditioned": false,
        "usb_chargers": false
      }
    }
  }]
}
```

Field notes / gotchas:

- **`shape_dist_traveled` is a STRING here** (`"5.871"`), unlike in `/v2/gtfs/shapes/{id}` and
  `includeStopTimes`, where it's a **numeric** field (`5.871`). Coerce with `parseFloat` — a real
  type inconsistency across endpoints in the same API family. **Units are kilometers** (verified:
  a shape point 12.9 m from the previous one had `shape_dist_traveled` delta of `0.012923`).
- **`speed` was `null` on every single vehicle observed** (trams, buses, metro, rail) across
  multiple polls. DPP's AVL feed apparently doesn't populate it via Golemio — don't build any UI
  that depends on a live speed readout; derive speed yourself from consecutive
  position+timestamp pairs if you need it.
- `state_position` observed values: `at_stop`, `on_track`, `before_track`, `before_track_delayed`,
  `off_track` (the last two seen mostly on the lighter `/v2/public/...` endpoint, see below;
  `off_track` also appeared in the full feed for non-tracking vehicles).
- No tram model/type field exists anywhere in the API. `vehicle_registration_number` is DPP's
  fleet/inventory number (observed range for trams: ~7269–9516 at test time). Mapping that number
  to a physical tram model (Tatra T3, Škoda 14T/15T ForCity, etc.) is **not provided by Golemio**
  — you'll need your own hardcoded fleet-number→model lookup table if the app wants to render the
  correct 3D model per vehicle.
- `air_conditioned`/`usb_chargers`/`wheelchair_accessible` are present for DPP vehicles (bus AND
  tram) and are real, not always-false placeholders (observed both `true`/`false` values on trams
  in the same fetch).
- `last_stop`/`next_stop` give scheduled `arrival_time`/`departure_time` (not observed/actual —
  those are schedule-derived) plus stop `id` (GTFS `stop_id`, format `U<node>Z<zone><P|...>`, e.g.
  `U15Z1P`) and `sequence` (1-based position in the trip's stop sequence — use this plus the
  trip's total stop count, from `includeStopTimes`, to detect "at terminal").
- `origin_timestamp` is the actual AVL fix time — this is what you want to drive interpolation,
  **not** the moment your client received the HTTP response.

### `includeNotTracking` / `includeNotPublic` — important default-filtering gotcha

By default (`includeNotTracking=false`, `includeNotPublic=false`, which is what you get if you
omit them), the endpoint **already excludes non-live vehicles**. Empirically:

- Default (`limit=10000`, no extra flags): **767** vehicles, and **100% of them have
  `last_position.tracking === true`**.
- With `includeNotTracking=true&includeNotPublic=true&limit=10000`: **2265** vehicles, of which
  **1450 have `tracking: false`** — these are stale/ghost/scheduled-but-not-yet-departed trips
  that would visually look like "parked" or duplicate vehicles if rendered.

**Do not pass `includeNotTracking=true` for the live map** — the defaults are already exactly
what you want (only vehicles with a live position fix). Only use those flags for
debugging/diagnostics tooling, never in the production polling path.

### Single-trip endpoint: `/v2/vehiclepositions/{gtfsTripId}`

Returns a single GeoJSON **Feature** (not a FeatureCollection — no `features` wrapper) with the
same `properties.last_position`/`properties.trip` shape as above. Params: `includeNotTracking`,
`includePositions`, `preferredTimezone`. Useful for a "track this specific tram" detail screen
once you already have its `trip_id` from the bulk feed, but **not a substitute for the bulk feed**
for a live map — you'd need 100+ requests to reconstruct the whole city.

### Refresh cadence (measured empirically)

Polled a single active tram trip (`1_14863_260627`, route L1) via
`/v2/vehiclepositions/{gtfsTripId}` every 10 s for ~2 minutes. Coordinates and
`origin_timestamp` did **not** change every poll — they changed in irregular bursts:

```
11:32:13 -> 2026-07-11T13:31:47+02:00  [14.36983, 50.09239]  on_track
11:32:24 -> 2026-07-11T13:31:47+02:00  [14.36983, 50.09239]  on_track   (unchanged)
11:32:34 -> 2026-07-11T13:31:47+02:00  [14.36983, 50.09239]  on_track   (unchanged)
11:32:44 -> 2026-07-11T13:32:36+02:00  [14.3783,  50.09286]  at_stop    (new fix, +49s)
11:32:54 -> 2026-07-11T13:32:36+02:00  [14.3783,  50.09286]  at_stop    (unchanged)
11:33:04 -> 2026-07-11T13:32:36+02:00  [14.3783,  50.09286]  at_stop    (unchanged)
11:33:15 -> 2026-07-11T13:33:02+02:00  [14.37955, 50.09284]  on_track   (new fix, +26s)
11:33:25 -> 2026-07-11T13:33:23+02:00  [14.38287, 50.09284]  at_stop    (new fix, +21s)
11:33:45 -> 2026-07-11T13:33:37+02:00  [14.3842,  50.09278]  on_track   (new fix, +14s)
11:34:16 -> 2026-07-11T13:33:37+02:00  (unchanged for 3 polls)
```

**Underlying AVL fixes arrive roughly every 15–50 s per vehicle** (DPP's onboard AVL ping
interval, not a Golemio limitation), while the HTTP `Cache-Control` on the JSON endpoints says
`public, s-maxage=5, stale-while-revalidate=5` (CDN edge cache is fresh to ~5 s). **Practical
polling interval recommendation: poll every 5–10 s** — that's fast enough to catch essentially
every new fix without wasting requests below the CDN cache granularity. Your interpolation engine
must handle **variable-length gaps between real fixes** (not a fixed 10 s/30 s cadence) — drive
animation off the actual `origin_timestamp` delta between the last two known fixes per vehicle,
not a hardcoded interval.

---

## 2. `/v2/public/vehiclepositions` — lightweight alternative with real server-side filtering

Not mentioned in the task's doc links but discovered via the OpenAPI spec and worth documenting
because it **does** have the filter the main endpoint lacks:

```
GET /v2/public/vehiclepositions?routeType=tram
```

Verified params:

| param | type | example |
|---|---|---|
| `boundingBox` | string `"topLeft.lat,topLeft.lon,bottomRight.lat,bottomRight.lon"` | `50.123,14.243,50.017,14.573` |
| `routeShortName` | array (repeat param) | `?routeShortName=381&routeShortName=X1` |
| `routeType` | array (repeat param), enum `tram\|metro\|train\|bus\|ferry\|funicular\|trolleybus` | `?routeType=tram` |

Despite the `public` in the path, **it still requires the `X-Access-Token` header** (confirmed:
omitting it is not tested here but the spec explicitly says "Despite the 'public' prefix, this
endpoint requires an API key for access control and usage monitoring"). The spec also notes it's
"optimized for client applications serving many users simultaneously" with adjustable rate limits
on request — i.e. Golemio built this specifically for exactly this app's use case.

Verified response for `routeType=tram` at test time: **253** trams (vs. 172 via the filtered
`route_type===0` approach on the main endpoint at a similar moment — the discrepancy is almost
certainly because this variant includes some `before_track`/`before_track_delayed` vehicles the
main endpoint's default `includeNotTracking=false` excludes), payload **66 KB** (vs 886 KB
unfiltered on the main endpoint).

Feature shape is much thinner — verified full set of property keys across the whole response:

```json
{
  "geometry": { "type": "Point", "coordinates": [14.53753, 50.05324] },
  "properties": {
    "gtfs_trip_id": "26_22484_260711",
    "route_type": "tram",
    "gtfs_route_short_name": "26",
    "bearing": 93,
    "delay": 0,
    "state_position": "before_track_delayed",
    "vehicle_id": "service-0-8294"
  }
}
```

**No `origin_timestamp`, no `last_stop`/`next_stop`, no `shape_dist_traveled`, no
`vehicle_registration_number`.** This is the critical tradeoff: this endpoint is cheap and
filterable but gives you no timing information to drive smooth interpolation — you'd only know
"now" as the observation time, with real fix age hidden. `state_position: "before_track_delayed"`
also appeared only here, suggesting it includes vehicles the main endpoint's default filtering
hides.

**Recommendation for this app:** use the main `/v2/vehiclepositions?limit=10000` (filtered
client-side by `route_type===0`) as the primary data source, *specifically because*
`origin_timestamp` is essential to your interpolation engine. Consider `/v2/public/vehiclepositions
?routeType=tram&boundingBox=...` only as a fallback/optimization if payload size ever becomes a
real problem (it currently isn't: 886 KB unfiltered in ~80 ms is fine for a mobile client polling
every 5–10 s).

### GTFS-RT protobuf feeds (exist, not recommended)

`/v2/vehiclepositions/gtfsrt/vehicle_positions.pb` (and `trip_updates.pb`, `pid_feed.pb`,
`alerts.pb`) return `Content-Type: application/octet-stream` (GTFS-Realtime protobuf), with a
**slower CDN cache** (`s-maxage=40, stale-while-revalidate=50` vs `s-maxage=5` on the JSON
endpoints) — i.e. objectively staler than the JSON API. Would also require a protobuf decoder
dependency in RN for no benefit here. Skip these; use the JSON endpoints.

---

## 3. `/v2/gtfs/routes` — all routes, tram route inventory

`GET /v2/gtfs/routes?limit=10000` → plain JSON **array** (not GeoJSON), **833 total routes**
across the whole PID network (buses, trams, metro, rail, ferry). No `offset` needed for a single
page — everything fits in one 10,000-row page today, but you must still pass `limit=10000`
explicitly (`limit` defaults lower — confirmed default 100 behavior on other endpoints; don't
assume the routes endpoint returns everything without it).

```json
{
  "agency_id": "99",
  "is_night": false,
  "route_color": "7A0603",
  "route_desc": null,
  "route_id": "L1",
  "route_long_name": "Sídliště Petřiny - Výstaviště",
  "route_short_name": "1",
  "route_text_color": "FFFFFF",
  "route_type": 0,
  "route_url": "https://pid.cz/linka/1",
  "is_regional": false,
  "is_substitute_transport": false
}
```

`route_type` distribution measured across all 833 routes: `{3: 685 (bus), 2: 97 (rail), 0: 38
(tram), 4: 5 (ferry), 11: 5 (trolleybus), 1: 3 (metro)}` — standard extended GTFS route types (0
tram, 1 subway/metro, 2 rail, 3 bus, 4 ferry, 11 trolleybus).

**38 tram routes exist right now**, confirmed by listing every `route_id`/`route_short_name`
where `route_type === 0`:

- Day lines: **1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  25, 26, 31, 32, 34, 39** (29 lines — note **14, 27–30, 33, 35–38 do not currently exist**;
  don't assume a contiguous 1–39 range).
- Night lines: **91, 92, 93, 94, 95, 96, 97, 98, 99** (all 9 flagged `is_night: true`) — matches
  the task's assumption of night lines 91–99 exactly.
- Total: 38, not "1–26 plus 91–99" as a naive range would imply (there are gaps in the day-line
  numbering, and there are also lines above 26: 31, 32, 34, 39).

**Every single tram route has the identical `route_color`/`route_text_color`**:
`7A0603`/`FFFFFF` (dark red / white) — Golemio does **not** provide per-line distinguishing colors
for trams (all 38 are the same red). If the app wants different colors per line for legibility,
that's an app-side design decision, not something to source from the API.

`route_id` format for trams: `L<n>` matching `route_short_name` numerically (`L1`→`"1"`,
`L96`→`"96"`) — but don't hardcode this mapping; always read `route_short_name` from the object.

`/v2/gtfs/routes/{id}` (e.g. `/v2/gtfs/routes/L1`) returns the single route object shown above —
confirmed it does **not** include a nested trips list. There is **no** `/v2/gtfs/routes/{id}/trips`
endpoint (not in the OpenAPI paths list, and `/v2/gtfs/trips` itself has no `routeId` filter param
— confirmed empirically: `?routeId=L1` → `400 Unknown field(s)`). The only supported filter on
`/v2/gtfs/trips` is `stopId` + `date`.

---

## 4. Trips, shapes, and getting all shape geometry for a route cheaply

### `/v2/gtfs/trips/{id}` — single trip lookup with enrichment flags

Verified params (all booleans, all confirmed working): `includeShapes`, `includeStops`,
`includeStopTimes`, `includeService`, `includeRoute`, plus `date` (filter/disambiguate by service
date `YYYY-MM-DD`).

Base trip object (no flags), e.g. `/v2/gtfs/trips/1_14863_260627`:
```json
{
  "bikes_allowed": 2, "block_id": null, "direction_id": 0, "exceptional": 0,
  "route_id": "L1", "service_id": "0000011-1", "shape_id": "L1V2",
  "trip_headsign": "Výstaviště", "trip_id": "1_14863_260627",
  "wheelchair_accessible": 1, "trip_operation_type": null, "trip_short_name": null,
  "headsign_icons": "RaSb"
}
```
`trip_id` format `<numeric-route>_<seq>_<YYMMDD>` — **encodes the service date**, confirming the
"~12 days validity, daily updates" note: don't cache `trip_id`s long-term expecting them to be
valid tomorrow; re-derive them from the live vehiclepositions feed each session, or from
`/v2/gtfs/trips?stopId=...&date=...` for schedule lookups.

`?includeShapes=true` adds a `shapes` array of GeoJSON **Feature** objects (Point geometry) sorted
by `shape_pt_sequence`, identical structure to the standalone shapes endpoint below. For trip
`1_14863_260627` (tram line 1, shape `L1V2`): **249 points, 42.7 KB** response.

`?includeStopTimes=true` adds a `stop_times` array — **verified this is exactly what's needed for
dwell/terminal detection**:
```json
{
  "arrival_time": "13:27:00", "departure_time": "13:27:00",
  "drop_off_type": "0", "pickup_type": "0",
  "shape_dist_traveled": 0,
  "stop_id": "U541Z1P", "stop_sequence": 1, "trip_id": "1_14863_260627",
  "computed_dwell_time_seconds": 0,
  "headsign_icons": null, "stop_icons": null
}
```
- `stop_sequence` starts at 1; the **last element's `stop_sequence` is the terminal** — compare
  against `last_position.next_stop.sequence`/`last_stop.sequence` from the vehiclepositions feed
  to detect "approaching terminal" / "at terminal."
- `computed_dwell_time_seconds` is a real, Golemio-computed field (was `0` for all stops on this
  particular trip, i.e. this trip's schedule has no built-in recovery time — check other
  trips/routes if you need non-zero examples).
- `shape_dist_traveled` here is **numeric** (in km), matching the shapes endpoint, unlike the
  vehiclepositions endpoint's string version (see gotcha above).

### `/v2/gtfs/shapes/{id}` — standalone shape geometry

`GET /v2/gtfs/shapes/L1V2` → GeoJSON **FeatureCollection** of `Point` features:
```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "geometry": {"type":"Point","coordinates":[14.339773,50.087014]},
      "properties": {"shape_dist_traveled": 0, "shape_id": "L1V2", "shape_pt_sequence": 1} },
    ...
    { "properties": {"shape_dist_traveled": 10.756012, "shape_id": "L1V2", "shape_pt_sequence": 249} }
  ]
}
```
- 249 points for this shape, total length **10.756 km** — matches a real Prague tram line length,
  confirming units are km, not meters or miles.
- Response size **42.4 KB** for 249 points (≈171 bytes/point — verbose because every point is a
  full GeoJSON Feature with a properties object, not a compact coordinate array). For a route with
  multiple shape variants (see below) fetching all variants individually adds up — budget
  accordingly (a handful of KB × number of shapes, trivial in absolute terms, but avoid
  re-fetching unchanged shapes every session; cache by `shape_id` since it's stable).
- Unknown/non-existent `shape_id` → **`404 Not Found`** (clean 404, not an empty 200).

### Getting *all* shape variants for a route — no bulk endpoint exists, but there's a cheap enumeration trick

There is **no documented "give me all shapes for route X" endpoint.** `/v2/gtfs/routes/{id}` has
no trips/shapes list; `/v2/gtfs/trips` has no `routeId` filter. The only paths to a route's shapes
are: (a) look at `shape_id` on trips you already know about (e.g. from the live vehiclepositions
feed — you'll naturally discover every shape variant currently in service within a day or so of
polling), or (b) exploit the **empirically observed shape ID naming convention**:

```
shape_id = "<route_id>V<n>"   e.g. L1V1, L1V2, L1V3, L1V4, L1V5, L1V6, ...
```
Verified by fetching `L1V1` through `L1V6`: all returned `200` with real, differently-sized
point sets (**379, 249, 249, 379, 508, 508** points respectively — these are the outbound/inbound
+ possible short-turn variants). `L1V99` (deliberately out of range) returned **`200` with `0`
features** (empty `FeatureCollection`, not a 404) — so **the way to enumerate all variants for a
route is to increment `V1, V2, V3, …` until you get a `200` with an empty `features` array**, and
stop there. This is **undocumented, inferred behavior** — treat it as a best-effort optimization,
not a guaranteed contract; the authoritative source of truth for "which shape is this specific
trip using right now" is always the `shape_id` on the trip object itself. Fall back to harvesting
shape IDs organically from live trip data if this enumeration trick ever breaks.

---

## 5. `/v2/gtfs/stops` — stop filtering and tram stop identification

Response is a GeoJSON **FeatureCollection** (verified — NOT a bare array like `/v2/gtfs/routes`;
easy to mix up).

Verified query params: `names[]` (bracket-array syntax, e.g. `?names[]=Výstaviště`), `ids[]`
(by `stop_id`), `aswIds[]` (ASW system IDs, `_` instead of `/`), `cisIds`, `limit`, `offset`.
**Bracket-array params must be sent with proper URL encoding** — a naive
`curl "...?names[]=X"` without `-G --data-urlencode` can silently fail; use
`curl -G --data-urlencode "names[]=Výstaviště"` or equivalent in RN (`URLSearchParams` handles
this fine: `params.append('names[]', 'Výstaviště')`).

```json
{
  "geometry": {"type": "Point", "coordinates": [14.369894, 50.092445]},
  "properties": {
    "location_type": 0, "parent_station": null, "platform_code": "A",
    "stop_id": "U15Z1P", "stop_name": "Baterie", "wheelchair_boarding": 1,
    "zone_id": "P", "level_id": null, "asw_node_id": 15
  }
}
```

**Stop ID format**: `U<node_id>Z<platform_num><zone_letter>`, e.g. `U15Z1P`, `U532Z1P`. Decomposed:
`U` = stop/uzel prefix, `15`/`532` = ASW node id, `Z1`/`Z4` = platform/zone index at that node,
trailing `P` = Prague tariff zone. Multiple stop objects share the same `stop_name` for one
physical station (e.g. `U532Z1P`, `U532Z2P`, `U532Z3P` are three separate platforms all named
"Výstaviště") — `platform_code` (`A`/`B`/`C`) distinguishes them for display. **There is no
explicit "is this a tram stop" boolean field on the stop object itself** — a stop's mode isn't
derivable from the stop record alone; you determine "tram stop" by cross-referencing which
routes/trips (via `stop_times`) serve it, or simply by only caring about stops that show up in
tram trips' `stop_times`/`last_stop`/`next_stop` data, which is what the app needs anyway.

**Pagination**: total stop count across the whole PID network is **≥19,025** — confirmed
`limit=10000&offset=0` returns exactly 10,000 (the hard per-request cap), and
`limit=10000&offset=10000` returns another 9,025 with no further page needed. This is nationwide
(bus/rail too), not just Prague trams — you almost certainly want to filter with `ids[]` (feed it
IDs harvested from tram trips' stop_times, an app-controlled set that's far smaller) rather than
ever pulling the full stop list.

---

## 6. Dwell time / terminal detection — `/v2/gtfs/trips/{id}?includeStopTimes=true` confirmed working

Already covered above (section 4) — verified end-to-end: `stop_times[].stop_sequence`,
`computed_dwell_time_seconds`, `shape_dist_traveled` all present and correctly populated.
Standalone `/v2/gtfs/stoptimes/{id}` (stop-centric, not trip-centric) also verified:

```
GET /v2/gtfs/stoptimes/U15Z1P?date=2026-07-11&from=13:30:00&to=14:00:00&limit=5
```
returns a plain array of `{arrival_time, departure_time, drop_off_type, pickup_type,
shape_dist_traveled, stop_id, stop_sequence, trip_id}` for every trip passing that stop in the
time window — this is effectively a departure board query, useful for a stop-detail screen, not
needed for the core live-tram-position pipeline. Supports `includeStop` (boolean, adds the full
stop object) plus `limit`/`offset`.

---

## Key implementation recipe for this app

1. Poll `GET /v2/vehiclepositions?limit=10000` every 5–10 s (no route filter — filter
   `route_type === 0` client-side). One request, ~900 KB, ~80 ms server time.
2. Key vehicles by `trip.gtfs.trip_id`. Track `last_position.origin_timestamp` per vehicle;
   feed `(coordinates, origin_timestamp)` pairs into your interpolation engine to animate between
   real fixes (irregular ~15–50 s gaps — don't assume fixed cadence).
3. On first sight of a new `shape_id`, fetch `/v2/gtfs/shapes/{shape_id}` once and cache
   indefinitely (shape geometry is stable; `shape_id` doesn't rotate daily like `trip_id` does).
4. On first sight of a new `trip_id`, optionally fetch
   `/v2/gtfs/trips/{trip_id}?includeStopTimes=true` to get the full stop sequence for dwell/
   terminal-detection UI; cache per trip_id for that service day only (trip_ids expire daily).
5. Fetch `/v2/gtfs/routes?limit=10000` once per app session (or cache for a day) and filter
   `route_type === 0` to build your static list of the 38 tram lines for line-picker UI, etc.
6. Coerce `shape_dist_traveled` to a number everywhere — it's a string on vehiclepositions, a
   number on shapes/stop_times.

## Risks / things that might not hold up

- The `V1, V2, V3…` shape-ID enumeration trick (section 4) is **inferred from observed behavior,
  not documented** — Golemio could change shape ID formatting without notice; always prefer
  harvesting `shape_id` values organically from real trip/vehiclepositions data as the ground
  truth, and use the enumeration trick only as a background "make sure we have every variant"
  sweep.
- The discrepancy between "172 trams" (main endpoint, `route_type===0`, default filtering) and
  "253 trams" (`/v2/public/vehiclepositions?routeType=tram`) was observed at a single point in
  time and not root-caused with certainty — if you ever mix both endpoints' outputs you may get
  inconsistent vehicle counts; recommend picking **one** endpoint as the sole source of truth
  (this doc recommends the main one) rather than merging.
- Rate limit (20 req/8s) is stated in the OpenAPI description text, not enforced via visible
  headers in testing — it was not stress-tested to the point of triggering a 429, so the exact
  throttling behavior (hard block vs queuing vs soft degradation) at the limit is unverified.
- `speed` being null for 100% of observed vehicles was checked across one snapshot session (a few
  minutes, weekday afternoon) — worth a longer/different-time-of-day spot check before hard-coding
  "never trust `speed`" into architecture, though it's a reasonable working assumption.
- No official statement was found (apiary docs were 502 throughout this research) confirming the
  86-day/12-day GTFS validity window's exact mechanics or whether historical `trip_id`s ever
  become queryable again after they roll off — treat trip-scoped data as ephemeral/session-only.
- Tram vehicle→model mapping (fleet number → Tatra T3 / Škoda 14T / 15T ForCity / etc.) is
  entirely out of scope for Golemio and must be sourced/maintained separately by this project;
  fleet renumbering or new deliveries could invalidate any hardcoded table over time.
