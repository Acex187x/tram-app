// Cold-start geometry pack — one request that ends the "circles phase".
//
// THE PROBLEM IT SOLVES: on a cold start with an expired disk cache the app
// needs ~180 shapes. The per-trip path fetches them one at a time through a
// 16-starts/8 s scheduler, so the last visible tram can wait a minute or more
// as a bare dot. That is the "long circles phase on cold start" the owner
// reported after the Convex migration.
//
// THE DEAL: `GET /api/geometry-pack` returns every shape currently in service
// in ONE gzip response, deduped by geometryKey (legacy: shapeId). We
// seed all of them at once, then let the ordinary per-trip warm-up refine.
//
// FEATURE DETECTION: the endpoint is served by the predictor service and may
// be unavailable. Every failure mode — 404, non-JSON, malformed,
// timeout, offline — returns null and the app simply behaves exactly as it
// does now. This module can never make loading worse than not having it.
//
// HONESTY (why seeds are PROVISIONAL): legacy packs dedup by provider shapeId,
// which can be reused across GTFS generations and opposite directions. New
// packs reference content-derived geometryKey values. Even those are provisional
// until this trip is fetched: current stop identities can contradict a seed,
// and sibling stop epochs never establish this trip's timetable. These entries
// render, they are never written to disk, and the per-trip warm-up still
// replaces them with the authoritative geometry in the background.

import type { RouteGeometry } from "@/lib/types";
import { servedToRouteGeometry, type ServedGeometry } from "./gtfs";
import * as shapeCache from "./shapeCache";
import { fetchGeometryPackSources } from "./geometryPackFetch";

/**
 * Served by the app's own backend since 2026-08-21 (Convex http action,
 * convex/geometryPack.ts — the predictor uploads the pack there). Same origin
 * as per-trip geometry. Candidate builds may prefer the private Lab pack and
 * supplement missing trips from this public pack; both remain provisional.
 */
const SITE_ENV = process.env.EXPO_PUBLIC_CONVEX_SITE_URL;
export const GEOMETRY_PACK_URL = `${
  typeof SITE_ENV === "string" && SITE_ENV.length > 0
    ? SITE_ENV
    : "https://tram-site.acex.sh"
}/geometry-pack`;

/**
 * Hard timeout for the one pack request. Generous (it is a large gzip body)
 * but bounded: a hung pack must never delay the per-trip path behind it.
 */
export const PACK_TIMEOUT_MS = 20_000;

/** Wire shape of the pack (see the module header for the contract). */
export interface GeometryPack {
  /** Server wall clock when the pack was built. */
  atMs: number;
  /** One entry per geometryKey (legacy: shapeId) in service. */
  shapes: ServedGeometry[];
  /** tripId → geometryKey (legacy: shapeId) for every trip currently running. */
  trips: Record<string, string>;
}

/** A parsed JSON object is not necessarily a usable distance axis. Validate
 * before exposing it to the fleet, which indexes both parallel arrays. */
function hasUsablePackAxis(shape: ServedGeometry): boolean {
  return (
    Array.isArray(shape.coordinates) &&
    shape.coordinates.length >= 2 &&
    shape.coordinates.every(
      (c) =>
        Array.isArray(c) &&
        c.length >= 2 &&
        Number.isFinite(c[0]) &&
        Number.isFinite(c[1]),
    ) &&
    Array.isArray(shape.cumDistM) &&
    shape.cumDistM.length === shape.coordinates.length &&
    shape.cumDistM.every(
      (d, i, ds) => Number.isFinite(d) && d >= 0 && (i === 0 || d >= ds[i - 1]),
    ) &&
    Number.isFinite(shape.totalM) &&
    shape.totalM > 0 &&
    Array.isArray(shape.stops)
  );
}

/** Structural validation — a malformed pack is treated as "no pack at all". */
function parsePack(payload: unknown): GeometryPack | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Partial<GeometryPack>;
  if (
    !Array.isArray(p.shapes) ||
    typeof p.trips !== "object" ||
    p.trips === null
  )
    return null;
  const shapes = p.shapes.filter(
    (s): s is ServedGeometry =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as ServedGeometry).shapeId === "string" &&
      hasUsablePackAxis(s as ServedGeometry),
  );
  if (shapes.length === 0) return null;
  return {
    atMs: typeof p.atMs === "number" ? p.atMs : Date.now(),
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
  return fetchGeometryPackSources({
    publicUrl: url,
    publicTimeoutMs: timeoutMs,
    signal,
    parse: parsePack,
  });
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
export function seedFromPack(
  pack: GeometryPack,
  nowMs: number = Date.now(),
): number {
  const byShape = new Map<string, ServedGeometry | null>();
  const axis = (shape: ServedGeometry) =>
    JSON.stringify([
      shape.coordinates,
      shape.cumDistM,
      shape.totalM,
      shape.stops.map((s) => [s.stopId, s.sequence, s.distM]),
    ]);
  for (const shape of pack.shapes) {
    if (!hasUsablePackAxis(shape)) continue;
    const key = shape.geometryKey ?? shape.shapeId;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!byShape.has(key)) byShape.set(key, shape);
    else {
      const prior = byShape.get(key);
      // Never choose whichever conflicting entry happened to arrive last.
      try {
        if (!prior || axis(prior) !== axis(shape)) byShape.set(key, null);
      } catch {
        byShape.set(key, null);
      }
    }
  }

  let seeded = 0;
  for (const [tripId, shapeId] of Object.entries(pack.trips)) {
    if (typeof tripId !== "string" || typeof shapeId !== "string") continue;
    if (shapeCache.has(tripId)) continue; // resident already — never downgrade
    const served = byShape.get(shapeId);
    if (!served) continue;
    let geometry: RouteGeometry;
    try {
      // The served entry names its representative trip; this trip borrows the
      // shape, so re-label it or every consumer keyed by tripId disagrees.
      geometry = {
        ...servedToRouteGeometry(served, nowMs),
        tripId,
        geometryKey: served.geometryKey,
        provisional: true,
      };
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
  url?: string,
): Promise<number> {
  let seeded = 0;
  const preferred = process.env.EXPO_PUBLIC_GEOMETRY_PACK_URL;
  await fetchGeometryPackSources({
    publicUrl: url ?? GEOMETRY_PACK_URL,
    // An explicit argument keeps the existing single-source caller contract.
    preferredUrl:
      url === undefined && typeof preferred === "string"
        ? preferred
        : undefined,
    supplementPublic: url === undefined,
    signal,
    parse: parsePack,
    onPack: (pack) => {
      if (!signal?.aborted) seeded += seedFromPack(pack, Date.now());
    },
  });
  return signal?.aborted ? 0 : seeded;
}
