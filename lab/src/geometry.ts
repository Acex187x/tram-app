// Trip-geometry store: fetches RouteGeometry from the backend's public
// geometry endpoint (GET {SITE_URL}/geometry/:tripId — the same payload the
// app consumes), caches in SQLite + memory, and re-anchors stop epochs onto
// the current Prague service day with the app's own shared helper.

import type { RouteGeometry } from '@/lib/types';
import { GEOMETRY_404_TTL_MS, GEOMETRY_TTL_MS, SITE_URL } from './config';
import type { Store } from './db';

// Loaded lazily by run.ts AFTER __DEV__ is set (main.ts); safe here because
// gtfs.ts is pure and reads no globals at module scope besides Date/Intl.
import { geometryServiceMidnight, serviceDayShiftMs } from '@/lib/golemio/gtfs';
import { pointAt, bearingAt } from '@/lib/geo/polyline';

interface ServedGeometry extends RouteGeometry {
  serviceMidnightMs?: number;
  builtAtMs?: number;
}

function reanchor(geom: ServedGeometry, nowMs: number): ServedGeometry {
  const storedMid = geom.serviceMidnightMs ?? geometryServiceMidnight(geom);
  const shift = serviceDayShiftMs(geom, storedMid, nowMs);
  if (shift === 0) return geom;
  return {
    ...geom,
    // serviceMidnightMs MUST advance together with the stops: v0 kept the old
    // value, so every daily reanchorAll() re-applied the shift cumulatively
    // and schedules drifted ±whole days (km-scale `schedule` spikes after
    // Prague midnight — finding 2026-08-11, README §Findings).
    serviceMidnightMs: storedMid + shift,
    stops: geom.stops.map((s) => ({
      ...s,
      arrivalMs: s.arrivalMs + shift,
      departureMs: s.departureMs + shift,
    })),
  };
}

export class GeometryStore {
  private mem = new Map<string, RouteGeometry>();
  private fetchedAt = new Map<string, number>();
  private negative = new Map<string, number>(); // tripId → retry-after ms
  private inFlight = new Set<string>();
  private queue: string[] = [];
  private concurrency = 0;
  fetchOk = 0;
  fetchFail = 0;

  constructor(private store: Store) {
    const nowMs = Date.now();
    for (const row of store.loadGeometries()) {
      try {
        const parsed = JSON.parse(row.json) as ServedGeometry;
        this.mem.set(row.tripId, reanchor(parsed, nowMs));
        this.fetchedAt.set(row.tripId, row.fetchedAtMs);
      } catch {
        /* corrupt row — refetched on demand */
      }
    }
  }

  size(): number {
    return this.mem.size;
  }

  resolve = (tripId: string): RouteGeometry | undefined => this.mem.get(tripId);

  coordAt(geom: RouteGeometry, distM: number): [number, number] {
    return pointAt(geom.coordinates, geom.cumDistM, distM);
  }

  bearingAt(geom: RouteGeometry, distM: number): number {
    return bearingAt(geom.coordinates, geom.cumDistM, distM);
  }

  /** Queue any unknown/stale tripIds for background fetch. */
  ensure(tripIds: Iterable<string>): void {
    const nowMs = Date.now();
    for (const tripId of tripIds) {
      if (this.inFlight.has(tripId) || this.queue.includes(tripId)) continue;
      const neg = this.negative.get(tripId);
      if (neg !== undefined && nowMs < neg) continue;
      const at = this.fetchedAt.get(tripId);
      if (at !== undefined && nowMs - at < GEOMETRY_TTL_MS) continue;
      this.queue.push(tripId);
    }
    this.pump();
  }

  private pump(): void {
    while (this.concurrency < 2 && this.queue.length > 0) {
      const tripId = this.queue.shift()!;
      this.concurrency++;
      this.inFlight.add(tripId);
      void this.fetchOne(tripId).finally(() => {
        this.concurrency--;
        this.inFlight.delete(tripId);
        this.pump();
      });
    }
  }

  private async fetchOne(tripId: string): Promise<void> {
    const nowMs = Date.now();
    try {
      const res = await fetch(`${SITE_URL}/geometry/${encodeURIComponent(tripId)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) {
        this.negative.set(tripId, nowMs + GEOMETRY_404_TTL_MS);
        this.fetchFail++;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as ServedGeometry;
      this.mem.set(tripId, reanchor(raw, nowMs));
      this.fetchedAt.set(tripId, nowMs);
      this.store.saveGeometry(tripId, raw.shapeId, JSON.stringify(raw), nowMs);
      this.fetchOk++;
    } catch {
      this.fetchFail++;
      this.negative.set(tripId, nowMs + 60_000); // transient: retry in a minute
    }
  }

  /** Daily service-day rollover: re-anchor everything in memory. */
  reanchorAll(nowMs: number): void {
    for (const [tripId, geom] of this.mem) {
      this.mem.set(tripId, reanchor(geom as ServedGeometry, nowMs));
    }
  }
}
