// The feed of last resort: nothing.
//
// This replaces the old LocalGolemioFeed escape hatch, and the replacement is
// the point. LocalGolemioFeed existed so the app could "keep working" by
// polling Golemio from the device and simulating physics locally — which, once
// the server owns physics (docs/research/physics-v3-protocol.md), means
// inventing motion nobody predicted and showing it as if it were real.
//
// Physics v3 says: without the server there is NO physics. So when the backend
// client cannot even be constructed, the honest feed is an empty one — zero
// vehicles, a permanent error in `status()`, and the connection UI telling the
// user the truth. Nothing here polls, allocates or retries.

import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import type { CalibrationRecord, FeedPriority, FeedStatus, TramFeed } from './types';

const NO_BACKEND = 'no backend client available';

export class NullFeed implements TramFeed {
  subscribeSnapshots(_cb: (snapshots: TramSnapshot[], atMs: number) => void): () => void {
    return () => {};
  }

  getGeometry(_tripId: string): RouteGeometry | undefined {
    return undefined;
  }

  requestGeometry(_tripIds: string[], _priority: FeedPriority): void {}

  promoteGeometry(_tripId: string): void {}

  reportCalibration(_records: CalibrationRecord[]): void {}

  status(): FeedStatus {
    return {
      lastBatchAtMs: 0,
      lastError: NO_BACKEND,
      lastFetchAtMs: 0,
      nextFetchAtMs: 0,
      inFlight: false,
      pollIntervalMs: 0,
      consecutiveFailures: 1,
    };
  }

  start(_pollMs?: number): void {}

  stop(): void {}
}
