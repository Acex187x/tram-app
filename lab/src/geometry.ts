// Trip-geometry store: fetches RouteGeometry from the backend's public
// geometry endpoint (GET {SITE_URL}/geometry/:tripId — the same payload the
// app consumes), caches in SQLite + memory, and re-anchors stop epochs onto
// the current Prague service day with the app's own shared helper.

import {createHash} from 'node:crypto';
import {StopServiceMetadata} from './stopService';
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
  private active = new Set<string>();
  readonly stopService = new StopServiceMetadata(process.env.STOP_SERVICE_METADATA_FILE, process.env.STOP_SERVICE_REFRESH_SCRIPT);
  fetchOk = 0;
  fetchFail = 0;

  // SQLite is the historical cache. Loading every archived trip into memory
  // retained 26,279 geometries for a 171-vehicle fleet in the live service.
  // Hydrate only the active set, which also releases drive WeakMap profiles.
  constructor(private store: Store) { this.stopService.start(); }

  size(): number {
    return this.mem.size;
  }

  resolve = (tripId: string): RouteGeometry | undefined => { const g=this.mem.get(tripId); return g ? this.stopService.apply(g) : undefined; };

  coordAt(geom: RouteGeometry, distM: number): [number, number] {
    return pointAt(geom.coordinates, geom.cumDistM, distM);
  }

  bearingAt(geom: RouteGeometry, distM: number): number {
    return bearingAt(geom.coordinates, geom.cumDistM, distM);
  }

  /** Queue any unknown/stale tripIds for background fetch. */
  ensure(tripIds: Iterable<string>): void {
    const nowMs = Date.now();
    this.active = new Set(tripIds);
    this.stopService.retain(this.active);
    for (const tripId of this.mem.keys()) {
      if (!this.active.has(tripId)) {
        this.mem.delete(tripId);
        this.fetchedAt.delete(tripId);
      }
    }
    for (const tripId of this.negative.keys()) {
      if (!this.active.has(tripId)) this.negative.delete(tripId);
    }
    this.queue = this.queue.filter((tripId) => this.active.has(tripId));
    for (const tripId of this.active) {
      if (this.inFlight.has(tripId) || this.queue.includes(tripId)) continue;
      const neg = this.negative.get(tripId);
      if (neg !== undefined && nowMs < neg) continue;
      if (!this.mem.has(tripId)) {
        const row = this.store.loadGeometry(tripId);
        if (row) {
          try {
            this.mem.set(tripId, reanchor(JSON.parse(row.json) as ServedGeometry, nowMs));
            this.fetchedAt.set(tripId, row.fetchedAtMs);
          } catch { /* corrupt row — refetch below */ }
        }
      }
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
      if (this.active.has(tripId)) {
        this.mem.set(tripId, reanchor(raw, nowMs));
        this.fetchedAt.set(tripId, nowMs);
      }
      this.store.saveGeometry(tripId, raw.shapeId, JSON.stringify(raw), nowMs);
      this.fetchOk++;
    } catch {
      this.fetchFail++;
      this.negative.set(tripId, nowMs + 60_000); // transient: retry in a minute
    }
  }

  /** Content-addressed cold-start axes. Provider IDs are reused across GTFS
   * generations, including opposite directions; sibling schedules are excluded. */
  pack(tripIds: Iterable<string>): { shapes: PackedGeometry[]; trips: Record<string, string> } {
    const shapes = new Map<string, PackedGeometry>();
    const trips: Record<string, string> = {};
    for (const tripId of tripIds) {
      const geom = this.resolve(tripId);
      if (!geom) continue;
      const geometryKey = geometryContentKey(geom);
      trips[tripId] = geometryKey;
      if (!shapes.has(geometryKey)) shapes.set(geometryKey, {...geom, geometryKey});
    }
    return { shapes: [...shapes.values()], trips };
  }

  /** Daily service-day rollover: re-anchor everything in memory. */
  reanchorAll(nowMs: number): void {
    for (const [tripId, geom] of this.mem) {
      this.mem.set(tripId, reanchor(geom as ServedGeometry, nowMs));
    }
  }
}

export type PackedGeometry = RouteGeometry & {geometryKey:string};
/** Preserve provider identity for learned-cell references while distinguishing
 * every spatial/platform axis. Timetable/headsign are explicitly provisional. */
export function geometryContentKey(g:RouteGeometry):string {
  const axis = [g.shapeId,g.coordinates,g.cumDistM,g.totalM,g.stops.map(s=>[
    s.stopId,s.sequence,s.distM,s.coordinates,s.isTerminal??false,s.requestOnly??false,
  ])];
  return 'axis-v1-'+createHash('sha256').update(JSON.stringify(axis)).digest('hex');
}
