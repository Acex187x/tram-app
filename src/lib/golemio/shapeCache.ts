// Two-level cache for RouteGeometry keyed by tripId:
//   • in-memory Map (synchronous has()/getLoaded() for the render loop)
//   • disk via expo-file-system (survives app restarts, TTL 3 days)
// getTripGeometry single-flights concurrent requests for the same tripId.
//
// FAILURE MEMORY (2026-07-19, "roundel-forever" fix): a trip whose fetch FAILS
// (404 — trip absent from the GTFS static dataset, transient network/5xx after
// the client's own retries, or a degenerate payload with no usable shape) used
// to be re-requested by EVERY 5 s poll — each attempt burning a rate-limit
// slot in the visible lane, so a handful of doomed trips could eat most of the
// 16-starts/8 s window and starve the fetches that COULD succeed, while the
// doomed trams themselves sat as roundels with no diagnosis. Failures are now
// remembered per trip with an exponential re-check backoff (short for
// transient errors, long for "not in dataset"/degenerate — the daily GTFS
// refresh can legitimately make those appear later), surfaced via
// getGeometryFailure(), and NEVER cached as success. An urgent (priority 0,
// tapped-tram) request bypasses the backoff — a user poke is always allowed to
// try again right now.

import { Directory, File, Paths } from 'expo-file-system';

import type { RouteGeometry } from '@/lib/types';
import {
  fetchTripGeometry,
  geometryServiceMidnight,
  serviceDayShiftMs,
} from './gtfs';
import {
  GolemioAbortError,
  GolemioHttpError,
  demoteTag,
  promoteTag,
  type GolemioPriority,
} from './client';

const CACHE_DIR_NAME = 'tripgeo';
/**
 * Disk TTL: 3 days (service-day re-anchored on every read — see `reanchor`).
 * A trip_id is stable for the ~12-day life of a GTFS dataset and its timetable
 * (seconds-of-service-day) practically never changes within one, so a user
 * returning the next day (or after a weekend) re-opens on a WARM disk cache.
 * The previous 24 h TTL expired between daily sessions, making EVERY cold
 * start a whole-fleet geometry burst against the 16-starts/8 s rate limit —
 * visible trams sat as loading dots for minutes (red-dot recurrence,
 * 2026-07-18). Kept well under the dataset life so an upstream schedule
 * revision still converges within days; the sim itself is observation-anchored
 * either way, so a briefly stale timetable only nudges pacing, not position.
 */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;

interface DiskEntry {
  savedAt: number;
  /**
   * Prague-local-midnight epoch of the service day the geometry's stop epochs
   * were anchored to when written. Lets `readDisk` re-anchor an entry that is
   * still within TTL but was fetched on an earlier service day.
   */
  serviceMidnightMs: number;
  geometry: RouteGeometry;
}

// NOTE: in-memory entries are anchored to the service day they were fetched on
// and are NOT re-anchored while resident. A session running uninterrupted
// across a service-day rollover (~03:00 Prague) keeps replaying that day's
// timetable until the entry is evicted (app restart / cold start re-reads disk,
// which re-anchors via readDisk). Trip_ids roll over every ~12 days, so in
// practice a fresh trip_id forces a re-fetch well before this matters; a
// dedicated long-running app would need periodic memCache invalidation.
const memCache = new Map<string, RouteGeometry>();
const inFlight = new Map<string, Promise<RouteGeometry>>();

/**
 * Trips whose resident geometry came from the COLD-START PACK (see
 * lib/golemio/geometryPack), not from `GET /geometry/:tripId`.
 *
 * The pack dedups its shapes by shapeId, so a provisional entry carries the
 * right polyline (position, bearing and the 3D body are correct immediately —
 * that is the whole point: no "circles phase" on a cold start) but a SIBLING
 * trip's stop epochs. Arrival/departure times drive arrivals, spotter and
 * planner guidance, so a provisional entry is deliberately NOT treated as
 * final: it renders, it is never written to disk, and the ordinary per-trip
 * warm-up still fetches the authoritative geometry in the background and
 * replaces it. Honest by construction — we show the tram on its line at once
 * without ever quoting a timetable we only guessed.
 */
const provisional = new Set<string>();

// ── Failure memory (negative cache with re-check backoff) ────────────────────

/**
 * Why a fetch could not produce a usable geometry:
 *   • 'missing'    — non-retryable HTTP 4xx, dominated by 404: the trip_id the
 *                    vehicle feed reports is not (yet) in the GTFS static
 *                    dataset. Happens around the daily dataset refresh and for
 *                    diverted/extra services. May legitimately resolve later.
 *   • 'degenerate' — the endpoint answered 200 but the payload has no usable
 *                    shape (< 2 polyline points or zero total length). Caching
 *                    that as success would freeze the tram as a geometry-less
 *                    dot for the 3-day disk TTL.
 *   • 'transient'  — network/timeout/5xx/429 after the client's own retries.
 */
export type GeometryFailureKind = 'missing' | 'degenerate' | 'transient';

export interface GeometryFailure {
  kind: GeometryFailureKind;
  /** Consecutive failed fetch attempts (client-level retries count as one). */
  attempts: number;
  lastError: string;
  /** Wall-clock ms before which non-urgent requests are not re-issued. */
  nextRetryAtMs: number;
}

/** Transient failures re-check quickly — the next poll after the window. */
export const TRANSIENT_RETRY_BASE_MS = 10_000;
export const TRANSIENT_RETRY_CAP_MS = 120_000;
/** 'missing'/'degenerate' re-check slowly — only a dataset refresh can fix them. */
export const MISSING_RETRY_BASE_MS = 60_000;
export const MISSING_RETRY_CAP_MS = 15 * 60_000;

/** Prune trigger/floor so a long session's turned-over trips don't accumulate. */
const FAIL_CACHE_SWEEP_SIZE = 1024;
const FAIL_CACHE_STALE_MS = 30 * 60_000;

const failCache = new Map<string, GeometryFailure>();

/** Thrown (fast, no network) for a non-urgent request during a failure backoff,
 *  and by the fetch task itself when the payload is degenerate. */
export class GeometryUnavailableError extends Error {
  readonly tripId: string;
  readonly kind: GeometryFailureKind;
  readonly retryAtMs: number;
  constructor(tripId: string, kind: GeometryFailureKind, retryAtMs: number, detail?: string) {
    super(
      `Geometry unavailable for trip ${tripId} (${kind})${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'GeometryUnavailableError';
    this.tripId = tripId;
    this.kind = kind;
    this.retryAtMs = retryAtMs;
  }
}

/** Diagnostics: why (and until when) a trip's geometry is known-unavailable. */
export function getGeometryFailure(tripId: string): GeometryFailure | undefined {
  const f = failCache.get(tripId);
  return f ? { ...f } : undefined;
}

/** A geometry the engine/renderer can actually place a tram on. */
function isUsableGeometry(g: RouteGeometry): boolean {
  return g.coordinates.length >= 2 && g.totalM > 0;
}

function classifyFailure(err: unknown): GeometryFailureKind {
  if (err instanceof GeometryUnavailableError) return err.kind;
  if (
    err instanceof GolemioHttpError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  ) {
    return 'missing';
  }
  return 'transient';
}

/** True while the trip is inside its failure backoff for a non-urgent request. */
function inFailureBackoff(tripId: string, priority: GolemioPriority): boolean {
  if (priority === 0) return false; // taps always get a fresh attempt
  const f = failCache.get(tripId);
  return f !== undefined && Date.now() < f.nextRetryAtMs;
}

function recordFailure(tripId: string, err: unknown): void {
  const kind = classifyFailure(err);
  const attempts = (failCache.get(tripId)?.attempts ?? 0) + 1;
  const base = kind === 'transient' ? TRANSIENT_RETRY_BASE_MS : MISSING_RETRY_BASE_MS;
  const cap = kind === 'transient' ? TRANSIENT_RETRY_CAP_MS : MISSING_RETRY_CAP_MS;
  const delay = Math.min(base * 2 ** (attempts - 1), cap);
  const now = Date.now();
  const message = err instanceof Error ? err.message : String(err);
  failCache.set(tripId, {
    kind,
    attempts,
    lastError: message,
    nextRetryAtMs: now + delay,
  });
  // Bound the map on long sessions: trips turn over at every terminus, so
  // entries long past their retry window are dead weight.
  if (failCache.size > FAIL_CACHE_SWEEP_SIZE) {
    for (const [id, f] of failCache) {
      if (now - f.nextRetryAtMs > FAIL_CACHE_STALE_MS) failCache.delete(id);
    }
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(
      `[shape-cache] trip ${tripId}: geometry ${kind} (attempt ${attempts}) — ${message}; ` +
        `re-check in ${Math.round(delay / 1000)} s`,
    );
  }
}

/**
 * Geometry-landed listeners (TramFeed.subscribeGeometry → the
 * runtime's debounced re-ingest): fired after every memCache.set, i.e. the
 * moment getLoaded()/has() starts returning the trip. Listener errors are
 * swallowed — a bad subscriber must never fail the fetch path.
 */
const loadedListeners = new Set<() => void>();

/** Subscribe to "a geometry became resolvable" notifications. */
export function subscribeLoaded(cb: () => void): () => void {
  loadedListeners.add(cb);
  return () => loadedListeners.delete(cb);
}

function notifyLoaded(): void {
  for (const l of loadedListeners) {
    try {
      l();
    } catch {
      // subscriber errors must not disturb the cache/fetch path
    }
  }
}

function cacheDir(): Directory {
  return new Directory(Paths.cache, CACHE_DIR_NAME);
}

function ensureDir(): void {
  const dir = cacheDir();
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
}

/** Turn a tripId into a filename-safe basename. */
function fileName(tripId: string): string {
  return `${tripId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

function tripFile(tripId: string): File {
  return new File(cacheDir(), fileName(tripId));
}

async function readDisk(tripId: string): Promise<RouteGeometry | null> {
  try {
    const file = tripFile(tripId);
    if (!file.exists) return null;
    const text = await file.text();
    const entry = JSON.parse(text) as DiskEntry;
    if (
      !entry ||
      typeof entry.savedAt !== 'number' ||
      Date.now() - entry.savedAt > TTL_MS ||
      // Degenerate entries written before the usable-geometry gate existed
      // (no polyline / zero length) must not resurrect as "loaded": evict and
      // let the network path re-fetch (and fail into the failure memory).
      !entry.geometry ||
      !isUsableGeometry(entry.geometry)
    ) {
      try {
        file.delete();
      } catch {
        // best-effort eviction
      }
      return null;
    }
    return reanchor(entry.geometry, entry.serviceMidnightMs);
  } catch {
    return null;
  }
}

/**
 * Re-anchor a cached geometry's stop epochs onto the current service day. The
 * timetable (seconds-of-service-day) is invariant; only which calendar service
 * day it applies to changes. Without this a within-TTL hit on a later day
 * replays a past-dated schedule, so the engine's schedule anchor runs off the
 * end of the trip and trams teleport or stick. `serviceMidnightMs` may be
 * absent on entries written before this field existed — fall back to deriving
 * it from the geometry.
 */
function reanchor(
  geometry: RouteGeometry,
  storedServiceMidnightMs: number | undefined,
): RouteGeometry {
  const stored =
    typeof storedServiceMidnightMs === 'number'
      ? storedServiceMidnightMs
      : geometryServiceMidnight(geometry);
  const shift = serviceDayShiftMs(geometry, stored, Date.now());
  if (shift === 0) return geometry;
  return {
    ...geometry,
    stops: geometry.stops.map((s) => ({
      ...s,
      arrivalMs: s.arrivalMs + shift,
      departureMs: s.departureMs + shift,
    })),
  };
}

function writeDisk(tripId: string, geometry: RouteGeometry): void {
  try {
    ensureDir();
    const entry: DiskEntry = {
      savedAt: Date.now(),
      serviceMidnightMs: geometryServiceMidnight(geometry),
      geometry,
    };
    tripFile(tripId).write(JSON.stringify(entry));
  } catch {
    // Disk persistence is best-effort; in-memory cache still serves the session.
  }
}

/**
 * Resolve a trip's geometry, using the in-memory cache, then disk, then the
 * network. Concurrent calls for the same tripId share one in-flight promise.
 *
 * `signal` is the caller's lifecycle signal (the feed session's abort). Abort
 * cancels the network fetch AND acts as a generation guard: a completion that
 * lands after the signal aborted must not mutate the memory cache or the disk
 * — a stale session's late result never pollutes a fresh session's cache.
 * A joiner whose own signal is still live retries once when the shared
 * in-flight task turns out to belong to an aborted session.
 *
 * Failure policy: a request landing inside the trip's failure backoff (see the
 * failure memory above) rejects IMMEDIATELY with GeometryUnavailableError — no
 * scheduler slot, no network. Priority 0 (tapped tram) bypasses the backoff.
 * A fetch that fails (or returns a degenerate payload) records/extends the
 * backoff; success clears it. Lifecycle aborts are never recorded as failures.
 */
export async function getTripGeometry(
  tripId: string,
  priority: GolemioPriority = 1,
  signal?: AbortSignal,
): Promise<RouteGeometry> {
  const mem = memCache.get(tripId);
  // A provisional (pack-seeded) entry renders, but is not the final answer —
  // fall through to the network so its real timetable replaces the sibling
  // trip's. Every other resident entry short-circuits as before.
  if (mem && !provisional.has(tripId)) return mem;
  if (signal?.aborted) throw new GolemioAbortError();

  const existing = inFlight.get(tripId);
  if (existing) {
    try {
      return await existing;
    } catch (err) {
      // The shared task was aborted by ANOTHER session's lifecycle signal.
      // If our caller is still alive, issue a fresh request instead of
      // failing an unrelated consumer (planner/route network).
      if (!(err instanceof GolemioAbortError) || signal?.aborted) throw err;
      if (inFlight.get(tripId) === existing) inFlight.delete(tripId);
      return getTripGeometry(tripId, priority, signal);
    }
  }

  const knownFail = failCache.get(tripId);
  if (knownFail && priority > 0 && Date.now() < knownFail.nextRetryAtMs) {
    throw new GeometryUnavailableError(
      tripId,
      knownFail.kind,
      knownFail.nextRetryAtMs,
      knownFail.lastError,
    );
  }

  const task = (async (): Promise<RouteGeometry> => {
    const disk = await readDisk(tripId);
    if (signal?.aborted) throw new GolemioAbortError(); // no cache writes after abort
    if (disk) {
      memCache.set(tripId, disk);
      // A disk entry is this trip's OWN geometry (written by a real per-trip
      // fetch), so it clears the pack-provisional mark just like a network
      // result — otherwise a refined trip stays flagged and every poll
      // re-queues it forever.
      provisional.delete(tripId);
      notifyLoaded();
      return disk;
    }
    const geometry = await fetchTripGeometry(tripId, { priority, signal });
    // Late-completion guard: even if the underlying fetch ignored the signal,
    // an aborted session must not write cache/disk.
    if (signal?.aborted) throw new GolemioAbortError();
    if (!isUsableGeometry(geometry)) {
      // 200 with no usable shape: MUST NOT be cached as success (has() would
      // stay true while nothing can render — a silent forever-dot). Treated as
      // a failure with the slow re-check schedule.
      throw new GeometryUnavailableError(
        tripId,
        'degenerate',
        Date.now(),
        `unusable payload: ${geometry.coordinates.length} shape points, totalM=${geometry.totalM}`,
      );
    }
    memCache.set(tripId, geometry);
    // Authoritative result: this trip is no longer pack-provisional.
    provisional.delete(tripId);
    writeDisk(tripId, geometry);
    notifyLoaded();
    return geometry;
  })();

  inFlight.set(tripId, task);
  try {
    const geometry = await task;
    failCache.delete(tripId);
    return geometry;
  } catch (err) {
    // Session aborts are lifecycle, not data: they must not open a backoff
    // window that outlives the abort and blocks the NEXT session's warm-up.
    if (!(err instanceof GolemioAbortError)) recordFailure(tripId, err);
    throw err;
  } finally {
    inFlight.delete(tripId);
  }
}

/**
 * Warm the cache for a batch of trips at (by default) background priority.
 * Errors are swallowed — prefetch is best-effort. `signal` (the feed session's
 * abort) cancels queued/in-flight fetches immediately on feed.stop().
 */
export function requestPrefetch(
  tripIds: Iterable<string>,
  priority: GolemioPriority = 2,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  for (const tripId of tripIds) {
    // Provisional entries stay in the warm-up queue until the authoritative
    // per-trip geometry lands (at background priority — they already render).
    if (memCache.has(tripId) && !provisional.has(tripId)) continue;
    if (inFlight.has(tripId)) {
      // Already queued or fetching. Re-assert the still-queued scheduler
      // waiter's priority from THIS (freshest) request, matched by the trip id
      // in its URL path: a higher-priority re-request PROMOTES it (a
      // background-warmed trip whose tram scrolled into the viewport jumps the
      // background lane), a background re-request DEMOTES a previously-raised
      // waiter whose tram left the viewport (demoteTag never touches urgent/
      // tapped waiters). The per-poll warm-up thereby continuously reorders a
      // deep queue to match what is on screen NOW — enqueue order stops
      // mattering on a cold-start burst.
      if (priority < 2) promoteTag(tripId, priority);
      else demoteTag(tripId, priority);
      continue;
    }
    // Failure backoff: a trip that just failed (404 / degenerate / transient)
    // is NOT re-issued by every 5 s poll — that burned a rate-limit slot per
    // poll per doomed trip and starved the fetches that could succeed. The
    // per-poll warm-up simply skips it until its re-check is due; priority 0
    // (tap) bypasses via inFailureBackoff.
    if (inFailureBackoff(tripId, priority)) continue;
    void getTripGeometry(tripId, priority, signal).catch(() => {
      // ignore: prefetch failures are non-fatal (recorded in the failure memory)
    });
  }
}

/**
 * Seed a trip's geometry from the cold-start pack without touching the network
 * or the disk. Returns true when it was actually stored (an already-resident
 * entry — memory or a real per-trip fetch in flight — always wins, so a late
 * pack can never overwrite better data).
 *
 * Callers pass an already re-anchored RouteGeometry (geometryPack does this via
 * the same servedToRouteGeometry the per-trip path uses).
 */
export function seedProvisional(tripId: string, geometry: RouteGeometry): boolean {
  if (!isUsableGeometry(geometry)) return false;
  // Only a RESOLVED entry outranks a seed. A merely in-flight per-trip fetch
  // holds no data yet — on a cold start it is a scheduler waiter that will not
  // land for up to ~140 s — and blocking on it made the pack seed ZERO trips
  // whenever the fullFleet seed beat the pack to the wire (it always does: 18 KB
  // over an already-opening socket vs 0.45 MiB of gzip). When that fetch does
  // land it overwrites this entry and clears the provisional mark, which is
  // exactly the convergence contract above.
  if (memCache.has(tripId)) return false;
  memCache.set(tripId, geometry);
  provisional.add(tripId);
  return true;
}

/** Fire the geometry-landed listeners once after a batch of seeds. */
export function notifySeeded(): void {
  notifyLoaded();
}

/** True while this trip's resident geometry is a pack seed, not a real fetch. */
export function isProvisional(tripId: string): boolean {
  return provisional.has(tripId);
}

/** Synchronously report whether a trip's geometry is loaded in memory. */
export function has(tripId: string): boolean {
  return memCache.has(tripId);
}

/** Synchronously return the in-memory geometry, or undefined on a miss. */
export function getLoaded(tripId: string): RouteGeometry | undefined {
  return memCache.get(tripId);
}

/**
 * All geometries resident in memory, INCLUDING pack-seeded provisional ones.
 * Right for consumers that only need the polyline — the route-network layer
 * draws lines sooner because of them.
 */
export function getAllLoaded(): RouteGeometry[] {
  return [...memCache.values()];
}

/**
 * Only geometries whose TIMETABLE is authoritative (per-trip fetch or disk).
 *
 * Provisional pack seeds borrow a sibling trip's stop epochs — fine for drawing
 * a tram on its line, useless for "when does it arrive". Every schedule surface
 * (arrivals, stop sheet, planner, spotter, nearby-stop) reads through here, so
 * a seeded trip is simply absent for them until its real geometry lands —
 * exactly the behavior they already have while a shape is still loading. Never
 * a wrong time; just not yet.
 */
export function getAllAuthoritative(): RouteGeometry[] {
  const out: RouteGeometry[] = [];
  for (const [tripId, geometry] of memCache) {
    if (!provisional.has(tripId)) out.push(geometry);
  }
  return out;
}

/** Drop the in-memory cache + failure memory (does not touch disk). Mainly for tests. */
export function clearMemoryCache(): void {
  memCache.clear();
  inFlight.clear();
  failCache.clear();
  provisional.clear();
}
