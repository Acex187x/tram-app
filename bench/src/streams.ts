// Живые Convex-потоки для рекордера: те же public-запросы, что читает телефон.

import type { TramSnapshot } from '@/lib/types';
import type { TrajectoryBatchWire, TrajectoryMetaWire } from '@/lib/physics/convexSource';

const CONVEX_URL = process.env.CONVEX_URL ?? 'https://tram-api.acex.sh';
const SITE_URL = process.env.SITE_URL ?? 'https://tram-site.acex.sh';

async function q<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; value?: T; errorMessage?: string };
  if (body.status !== 'success') throw new Error(`${path}: ${body.errorMessage ?? body.status}`);
  return body.value as T;
}

export const fixes = {
  fullFleet: () => q<{ seq: number; vehicles: TramSnapshot[] }>('stream:fullFleet', {}),
  since: (sinceSeq: number) =>
    q<{
      batches: { seq: number; atMs: number; changed: TramSnapshot[]; removed?: string[] }[];
      oldestSeq: number;
      latestSeq: number;
    }>('stream:batchesSince', { sinceSeq }),
};

export const traj = {
  fullSet: () =>
    q<{ vehicles: unknown[]; meta: TrajectoryMetaWire | null; seq: number }>(
      'trajectories:fullSet',
      {},
    ),
  since: (sinceSeq: number) =>
    q<{
      batches: TrajectoryBatchWire[];
      oldestSeq: number | null;
      latestSeq: number | null;
      serverNowMs: number;
    }>('trajectories:batchesSince', { sinceSeq }),
  meta: () => q<TrajectoryMetaWire | null>('trajectories:meta', {}),
};

export async function fetchServedGeometry(tripId: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${SITE_URL}/geometry/${encodeURIComponent(tripId)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
