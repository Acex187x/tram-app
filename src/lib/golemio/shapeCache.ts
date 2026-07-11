// Two-level cache for RouteGeometry keyed by tripId:
//   • in-memory Map (synchronous has()/getLoaded() for the render loop)
//   • disk via expo-file-system (survives app restarts, TTL 24h)
// getTripGeometry single-flights concurrent requests for the same tripId.

import { Directory, File, Paths } from 'expo-file-system';

import type { RouteGeometry } from '@/lib/types';
import { fetchTripGeometry } from './gtfs';
import type { GolemioPriority } from './client';

const CACHE_DIR_NAME = 'tripgeo';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface DiskEntry {
  savedAt: number;
  geometry: RouteGeometry;
}

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
    return entry.geometry;
  } catch {
    return null;
  }
}

function writeDisk(tripId: string, geometry: RouteGeometry): void {
  try {
    ensureDir();
    const entry: DiskEntry = { savedAt: Date.now(), geometry };
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
