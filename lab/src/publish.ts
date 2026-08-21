// The promotion seam: push the published trajectory chain into Convex.
//
// Until 2026-08-21 the phones fetched curves straight from this service over
// HTTP (5 s poll against a 2 s JSON freeze) while fixes arrived over the
// Convex WebSocket — two asynchronous streams, and the 7–11 s freshness race
// between them is where the fix-forward shim's worst windows came from
// (docs/research/physics-v3-protocol.md §Fix-forward). Now every re-emission
// is ALSO pushed to `trajectories:publish` (convex/trajectories.ts), and the
// client folds the same diff-stream shape the fix feed uses. The HTTP
// endpoints stay for the lab pages, the gates and the research generators.
//
// Delta discipline mirrors the backend's `batches` table: a vehicle is pushed
// only when its `emittedAtMs` moved, removals are pushed once, and an empty
// cycle still pushes a heartbeat (meta.atMs) so clients can tell "predictor
// alive, fleet quiet" from "predictor dead" honestly. A failed push leaves
// `lastPublished` untouched, so the next cycle retries exactly the missed
// delta — an engine restart republishes the whole chain by construction.

import { CONVEX_URL, ENGINE_PUSH_TOKEN, TRAJ_POINTS, TRAJ_STEP_MS } from './config';
import type { V2Vehicle } from './trajectory';

/** Vehicles per mutation call — keeps a full-fleet republish inside Convex's
 *  per-transaction budgets (each chunk becomes its own batch row). */
const PUSH_CHUNK = 100;

export interface PublishableEntry {
  v2: V2Vehicle;
  source: 'ml' | 'naive';
}

export interface PublishGauges {
  enabled: boolean;
  pushes: number;
  vehiclesPushed: number;
  removalsPushed: number;
  heartbeats: number;
  failures: number;
  lastError: string | null;
  lastOkAtMs: number;
}

export class ConvexPublisher {
  readonly enabled = ENGINE_PUSH_TOKEN.length > 0;
  private lastPublished = new Map<string, number>();
  private inFlight = false;
  private pushes = 0;
  private vehiclesPushed = 0;
  private removalsPushed = 0;
  private heartbeats = 0;
  private failures = 0;
  private lastError: string | null = null;
  private lastOkAtMs = 0;

  /**
   * One publication cycle, called after every `refreshTrajectories`. Never
   * throws; a cycle that overlaps a still-running push is skipped (the next
   * one re-diffs against `lastPublished`, so nothing is lost).
   */
  async publishCycle(
    entries: ReadonlyMap<string, PublishableEntry>,
    atMs: number,
    generator: string,
  ): Promise<void> {
    if (!this.enabled || this.inFlight) return;
    this.inFlight = true;
    try {
      const changed: Array<V2Vehicle & { source: 'ml' | 'naive' }> = [];
      for (const [key, e] of entries) {
        if (this.lastPublished.get(key) !== e.v2.emittedAtMs) {
          changed.push({ ...e.v2, source: e.source });
        }
      }
      const removed: string[] = [];
      for (const key of this.lastPublished.keys()) {
        if (!entries.has(key)) removed.push(key);
      }
      const horizonS = ((TRAJ_POINTS - 1) * TRAJ_STEP_MS) / 1000;
      let idx = 0;
      do {
        const chunk = changed.slice(idx, idx + PUSH_CHUNK);
        const rm = idx === 0 ? removed : [];
        await this.mutate({
          token: ENGINE_PUSH_TOKEN,
          atMs,
          horizonS,
          generator,
          changed: chunk,
          removed: rm,
        });
        for (const vehicle of chunk) this.lastPublished.set(vehicle.key, vehicle.emittedAtMs);
        for (const key of rm) this.lastPublished.delete(key);
        this.pushes++;
        this.vehiclesPushed += chunk.length;
        this.removalsPushed += rm.length;
        if (chunk.length === 0 && rm.length === 0) this.heartbeats++;
        idx += PUSH_CHUNK;
      } while (idx < changed.length);
      this.lastOkAtMs = Date.now();
      this.lastError = null;
    } catch (e) {
      this.failures++;
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.inFlight = false;
    }
  }

  gauges(): PublishGauges {
    return {
      enabled: this.enabled,
      pushes: this.pushes,
      vehiclesPushed: this.vehiclesPushed,
      removalsPushed: this.removalsPushed,
      heartbeats: this.heartbeats,
      failures: this.failures,
      lastError: this.lastError,
      lastOkAtMs: this.lastOkAtMs,
    };
  }

  private async mutate(args: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${CONVEX_URL}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'trajectories:publish', args, format: 'json' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`trajectories:publish HTTP ${res.status}`);
    const body = (await res.json()) as { status: string; errorMessage?: string };
    if (body.status !== 'success') {
      throw new Error(`trajectories:publish: ${body.errorMessage ?? body.status}`);
    }
  }
}
