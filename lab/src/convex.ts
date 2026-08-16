// Minimal Convex self-hosted HTTP client: POST /api/query {path, args, format}.
// The lab reads the SAME public queries the app's RemoteFeed uses
// (convex/stream.ts) — it never touches Golemio and adds zero load to the
// city API.

import { CONVEX_URL } from './config';
import type { TramSnapshot } from '@/lib/types';

export interface PollerHealth {
  running: boolean;
  lastPollAtMs: number;
  lastOkAtMs: number;
  lastSeq: number;
  consecutiveFailures: number;
  authFailed: boolean;
  fleetSize: number;
  pollIntervalMs: number;
}

export interface Batch {
  seq: number;
  atMs: number;
  changed: TramSnapshot[];
  removed?: string[];
}

async function convexQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`convex ${path}: HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; value?: T; errorMessage?: string };
  if (body.status !== 'success') throw new Error(`convex ${path}: ${body.errorMessage ?? body.status}`);
  return body.value as T;
}

export function fetchFullFleet(): Promise<{ seq: number; atMs: number; vehicles: TramSnapshot[]; poller: PollerHealth }> {
  return convexQuery('stream:fullFleet', {});
}

export function fetchBatchesSince(sinceSeq: number): Promise<{ batches: Batch[]; oldestSeq: number; latestSeq: number }> {
  return convexQuery('stream:batchesSince', { sinceSeq });
}

export function fetchHealth(): Promise<PollerHealth> {
  return convexQuery('stream:health', {});
}
