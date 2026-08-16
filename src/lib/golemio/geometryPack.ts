// Cold-start geometry pack — one request that ends the "circles phase".
//
// THE PROBLEM IT SOLVES: on a cold start with an expired disk cache the app
// needs ~180 shapes. The per-trip path fetches them one at a time through a
// 16-starts/8 s scheduler, so the last visible tram can wait a minute or more
// as a bare dot. That is the "long circles phase on cold start" the owner
// reported after the Convex migration.
//
// THE DEAL: `GET /api/geometry-pack` returns every shape currently in service
// in ONE gzip response, deduped by shapeId, plus a tripId → shapeId map. We
// seed all of them at once, then let the ordinary per-trip warm-up refine.
//
// FEATURE DETECTION: the endpoint is served by the predictor service and may
// not exist (it 404s today). Every failure mode — 404, non-JSON, malformed,
// timeout, offline — returns null and the app simply behaves exactly as it
// does now. This module can never make loading worse than not having it.
//
// HONESTY (why seeds are PROVISIONAL): the pack dedups by shapeId, so a seeded
// trip gets the correct polyline but a sibling trip's stop epochs. Position,
// bearing and the 3D body are therefore exactly right immediately, while
// arrival/departure times — which drive arrivals, spotter and planner guidance
// — are not to be trusted. shapeCache marks these entries provisional: they
// render, they are never written to disk, and the per-trip warm-up still
// replaces them with the authoritative geometry in the background.

import type { RouteGeometry } from '@/lib/types';
import { servedToRouteGeometry, type ServedGeometry } from './gtfs';
import * as shapeCache from './shapeCache';

/** Predictor-service endpoint (same origin as /api/trajectories/v2). */
export const GEOMETRY_PACK_URL = 'https://tram-lab.acex.sh/api/geometry-pack';

/**
 * Hard timeout for the one pack request. Generous (it is a large gzip body)
 * but bounded: a hung pack must never delay the per-trip path behind it.
 */
export const PACK_TIMEOUT_MS = 20_000;

/** Wire shape of the pack (see the module header for the contract). */
export interface GeometryPack {
  /** Server wall clock when the pack was built. */
  atMs: number;
  /** One entry per shapeId in service. */
  shapes: ServedGeometry[];
  /** tripId → shapeId for every trip currently running. */
  trips: Record<string, string>;
}

/** Structural validation — a malformed pack is treated as "no pack at all". */
function parsePack(payload: unknown): GeometryPack | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Partial<GeometryPack>;
  if (!Array.isArray(p.shapes) || typeof p.trips !== 'object' || p.trips === null) return null;
  const shapes = p.shapes.filter(
    (s): s is ServedGeometry =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as ServedGeometry).shapeId === 'string' &&
      Array.isArray((s as ServedGeometry).coordinates),
  );
  if (shapes.length === 0) return null;
  return {
    atMs: typeof p.atMs === 'number' ? p.atMs : Date.now(),
    shapes,
    trips: p.trips as Record<string, string>,
  };
}

/**
 * Fetch the pack once. Returns null on ANY failure (including 404 — the
 * endpoint not existing is an expected, silent outcome, not an error worth
 * surfacing). Never throws.
 */
export async function fetchGeometryPack(
  url: string = GEOMETRY_PACK_URL,
  signal?: AbortSignal,
  timeoutMs: number = PACK_TIMEOUT_MS,
): Promise<GeometryPack | null> {
  if (signal?.aborted) return null;
  // Own controller so a slow pack cannot outlive its usefulness, linked to the
  // session signal so teardown cancels it immediately.
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: ctl.signal,
      // Accept-Encoding is EXPLICIT on purpose: the pack is ~340 KB gzipped but
      // 1.18 MiB raw, and the edge proxy only compresses when the client asks.
      // Omitting it costs a mobile user ~850 KB on every cold start. CFNetwork
      // still decodes the body transparently, and if a proxy ever handed back
      // an undecoded body, response.json() throws and this whole function
      // returns null — i.e. the silent per-trip fallback, never a broken app.
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' },
    });
    if (!response.ok) return null; // 404 = not deployed yet; anything else = no pack
    return parsePack((await response.json()) as unknown);
  } catch {
    return null; // offline, aborted, timed out, non-JSON — all mean "no pack"
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Seed the shape cache from a pack. Returns how many trips were newly seeded.
 *
 * Each trip is re-anchored onto the CURRENT service day through the very same
 * `servedToRouteGeometry` the per-trip path uses, so a pack built earlier today
 * (or yesterday) lands with the same epochs a live fetch would produce. Trips
 * already resident (disk hit, or a per-trip fetch that already landed) are left
 * alone — better data always wins.
 */
export function seedFromPack(pack: GeometryPack, nowMs: number = Date.now()): number {
  const byShape = new Map<string, ServedGeometry>();
  for (const shape of pack.shapes) byShape.set(shape.shapeId, shape);

  let seeded = 0;
  for (const [tripId, shapeId] of Object.entries(pack.trips)) {
    if (typeof tripId !== 'string' || typeof shapeId !== 'string') continue;
    if (shapeCache.has(tripId)) continue; // resident already — never downgrade
    const served = byShape.get(shapeId);
    if (!served) continue;
    let geometry: RouteGeometry;
    try {
      // The served entry names its representative trip; this trip borrows the
      // shape, so re-label it or every consumer keyed by tripId disagrees.
      geometry = { ...servedToRouteGeometry(served, nowMs), tripId };
    } catch {
      continue; // one bad shape must not abort the whole seed
    }
    if (shapeCache.seedProvisional(tripId, geometry)) seeded += 1;
  }
  if (seeded > 0) shapeCache.notifySeeded();
  return seeded;
}

/**
 * The whole cold-start step: fetch + seed, best effort. Returns the number of
 * trips seeded (0 when the endpoint is absent — the silent fallback).
 */
export async function warmFromGeometryPack(
  signal?: AbortSignal,
  url: string = GEOMETRY_PACK_URL,
): Promise<number> {
  const pack = await fetchGeometryPack(url, signal);
  if (!pack || signal?.aborted) return 0;
  return seedFromPack(pack, Date.now());
}
