// Geometry serving (backend-convex.md §7 step 4; schema table `geometries`).
//
// `GET /geometry/:tripId` (routed in convex/http.ts, public at the site
// origin — https://tram-site.acex.sh) returns the preprocessed RouteGeometry
// for one trip. It is built server-side from Golemio's GTFS trip detail with
// the SAME shared builder the app used when it still fetched directly
// (src/lib/golemio/gtfs.ts → buildRouteGeometry), so the payload the client
// re-anchors is byte-compatible with what it used to compute itself.
//
// The `geometries` table is the city-wide shared cache: each trip costs one
// Golemio request per GEOMETRY_TTL_MS no matter how many clients ask, which
// is what keeps the whole system inside the key's ~20-req/8 s budget next to
// the 2 s vehicle poller (4/8 s).
//
// Freshness/failure contract (the client's failure memory depends on it):
//   • row fresher than GEOMETRY_TTL_MS  → served as-is; the CLIENT re-anchors
//     stop epochs onto the current service day (serviceDayShiftMs), exactly
//     like its own disk-cache hits.
//   • miss or stale row                 → fetch Golemio, rebuild, upsert, serve.
//   • Golemio non-retryable 4xx (404 = trip not in the GTFS dataset yet)
//     → status passthrough, so the client classifies it 'missing' as before.
//   • transient Golemio failure with a stale row on hand → serve the stale row
//     (an hours-old timetable only nudges pacing; the sim is observation-
//     anchored) — strictly better than the hole in the map the direct path had.

import { v } from 'convex/values';
import { httpAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { routeStopValidator } from './schema';
import { buildRouteGeometry, geometryServiceMidnight } from '../src/lib/golemio/gtfs';

/** Rebuild a trip from Golemio after this long. The GTFS dataset refreshes
 * daily and a trip_id's timetable is static within a dataset, so 24 h tracks
 * upstream revisions with at most one extra fetch per trip per day. */
export const GEOMETRY_TTL_MS = 24 * 60 * 60 * 1000;

export const FETCH_TIMEOUT_MS = 15_000;

/** Convex documents cap at 1 MiB — a pathological shape is served, not stored. */
const MAX_STORED_JSON_BYTES = 900_000;

const DEFAULT_ENDPOINT = 'https://api.golemio.cz';

/** The served/stored document — RouteGeometry plus its anchoring metadata. */
const servedGeometryFields = {
  tripId: v.string(),
  shapeId: v.string(),
  routeId: v.string(),
  line: v.string(),
  headsign: v.string(),
  serviceMidnightMs: v.number(),
  coordinates: v.array(v.array(v.number())),
  cumDistM: v.array(v.number()),
  totalM: v.number(),
  stops: v.array(routeStopValidator),
  builtAtMs: v.number(),
};

const servedGeometryValidator = v.object(servedGeometryFields);

interface ServedGeometry {
  tripId: string;
  shapeId: string;
  routeId: string;
  line: string;
  headsign: string;
  serviceMidnightMs: number;
  coordinates: number[][];
  cumDistM: number[];
  totalM: number;
  stops: {
    stopId: string;
    name: string;
    sequence: number;
    coordinates: number[];
    distM: number;
    arrivalMs: number;
    departureMs: number;
    dwellSeconds: number;
    isTerminal: boolean;
  }[];
  builtAtMs: number;
}

/** Cached row for a trip, stripped of Convex metadata (or null). */
export const byTrip = internalQuery({
  args: { tripId: v.string() },
  returns: v.union(v.null(), servedGeometryValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('geometries')
      .withIndex('by_trip', (q) => q.eq('tripId', args.tripId))
      .first();
    if (!row) return null;
    const { _id, _creationTime, ...doc } = row;
    return doc;
  },
});

/** Upsert the (single) cached row for a trip. */
export const store = internalMutation({
  args: servedGeometryFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('geometries')
      .withIndex('by_trip', (q) => q.eq('tripId', args.tripId))
      .first();
    if (existing) {
      await ctx.db.replace(existing._id, args);
    } else {
      await ctx.db.insert('geometries', args);
    }
    return null;
  },
});

class UpstreamHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Golemio HTTP ${status}`);
    this.status = status;
  }
}

/** One GTFS trip detail from Golemio, with the server-only key. */
async function fetchTripDetail(tripId: string): Promise<unknown> {
  const key = process.env.GOLEMIO_KEY;
  if (!key) throw new Error('GOLEMIO_KEY is not set on this deployment');
  const base = (process.env.GOLEMIO_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const url =
    `${base}/v2/gtfs/trips/${encodeURIComponent(tripId)}` +
    '?includeShapes=true&includeStopTimes=true&includeStops=true';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-Access-Token': key, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new UpstreamHttpError(res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function json(doc: ServedGeometry, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/**
 * The HTTP handler behind `GET /geometry/:tripId`. Public and unauthenticated
 * on purpose: it serves derived open transit data, never the key.
 */
export const serve = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const rawId = url.pathname.slice('/geometry/'.length);
  const tripId = decodeURIComponent(rawId);
  if (!tripId || rawId.includes('/')) {
    return new Response('missing or malformed trip id', { status: 400 });
  }

  const cached = await ctx.runQuery(internal.geometry.byTrip, { tripId });
  const now = Date.now();
  if (cached && now - cached.builtAtMs < GEOMETRY_TTL_MS) {
    return json(cached);
  }

  try {
    const detail = await fetchTripDetail(tripId);
    // The shared builder throws on a shape it cannot make sense of; a payload
    // that builds but is degenerate (no polyline) is still served — the
    // client's usable-geometry gate classifies it, same as the direct path.
    const geometry = buildRouteGeometry(
      detail as Parameters<typeof buildRouteGeometry>[0],
      now,
    );
    const doc: ServedGeometry = {
      tripId: geometry.tripId,
      shapeId: geometry.shapeId,
      routeId: geometry.routeId,
      line: geometry.line,
      headsign: geometry.headsign,
      serviceMidnightMs: geometryServiceMidnight(geometry),
      coordinates: geometry.coordinates,
      cumDistM: geometry.cumDistM,
      totalM: geometry.totalM,
      stops: geometry.stops,
      builtAtMs: now,
    };
    if (JSON.stringify(doc).length <= MAX_STORED_JSON_BYTES) {
      await ctx.runMutation(internal.geometry.store, doc);
    }
    return json(doc);
  } catch (err) {
    if (err instanceof UpstreamHttpError) {
      // Upstream auth trouble is OUR outage, not the client's — surface as a
      // retryable 502 rather than teaching every client the key is bad.
      if (err.status === 401 || err.status === 403) {
        return new Response('upstream auth failure', { status: 502 });
      }
      if (err.status >= 400 && err.status < 500) {
        // 404 and friends pass through: the client's failure memory needs the
        // real status to classify 'missing' vs 'transient'.
        return new Response(`upstream ${err.status}`, { status: err.status });
      }
    }
    if (cached) {
      // Transient upstream failure but we hold a (stale) build: serve it.
      return json(cached, { 'X-Served-Stale': '1' });
    }
    return new Response('upstream unavailable', { status: 502 });
  }
});
