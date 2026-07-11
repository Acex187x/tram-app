// Two-level cache for RouteGeometry keyed by tripId:
//   • in-memory Map (synchronous has()/getLoaded() for the render loop)
//   • disk via expo-file-system (survives app restarts, TTL 24h)
// getTripGeometry single-flights concurrent requests for the same tripId.

import { Directory, File, Paths } from 'expo-file-system';

import type { RouteGeometry } from '@/lib/types';
import {
  fetchTripGeometry,
  geometryServiceMidnight,
  serviceDayShiftMs,
} from './gtfs';
import type { GolemioPriority } from './client';

const CACHE_DIR_NAME = 'tripgeo';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

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
      Date.now() - entry.savedAt > TTL_MS
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
 */
export async function getTripGeometry(
  tripId: string,
  priority: GolemioPriority = 1,
): Promise<RouteGeometry> {
  const mem = memCache.get(tripId);
  if (mem) return mem;

  const existing = inFlight.get(tripId);
  if (existing) return existing;

  const task = (async (): Promise<RouteGeometry> => {
    const disk = await readDisk(tripId);
    if (disk) {
      memCache.set(tripId, disk);
      return disk;
    }
    const geometry = await fetchTripGeometry(tripId, { priority });
    memCache.set(tripId, geometry);
    writeDisk(tripId, geometry);
    return geometry;
  })();

  inFlight.set(tripId, task);
  try {
    return await task;
  } finally {
    inFlight.delete(tripId);
  }
}

/**
 * Warm the cache for a batch of trips at (by default) background priority.
 * Errors are swallowed — prefetch is best-effort.
 */
export function requestPrefetch(
  tripIds: Iterable<string>,
  priority: GolemioPriority = 2,
): void {
  for (const tripId of tripIds) {
    if (memCache.has(tripId) || inFlight.has(tripId)) continue;
    void getTripGeometry(tripId, priority).catch(() => {
      // ignore: prefetch failures are non-fatal
    });
  }
}

/** Synchronously report whether a trip's geometry is loaded in memory. */
export function has(tripId: string): boolean {
  return memCache.has(tripId);
}

/** Synchronously return the in-memory geometry, or undefined on a miss. */
export function getLoaded(tripId: string): RouteGeometry | undefined {
  return memCache.get(tripId);
}

/** All geometries currently resident in memory (e.g. for the planner graph). */
export function getAllLoaded(): RouteGeometry[] {
  return [...memCache.values()];
}

/** Drop the in-memory cache (does not touch disk). Mainly for tests. */
export function clearMemoryCache(): void {
  memCache.clear();
  inFlight.clear();
}
