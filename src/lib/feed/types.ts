// The TramFeed boundary — the service contract a future backend implements 1:1.
//
// Everything the interpolation engine + UI need from "the outside world" flows
// through this interface: fresh vehicle snapshots (push semantics), trip
// geometry resolution, calibration telemetry (deviation records), and feed
// health. The sole implementation is RemoteFeed, a thin client over the
// Convex backend, which polls Golemio server-side and aggregates calibration
// fleet-wide. The on-client LocalGolemioFeed was deleted with physics v3: it
// existed to keep the app "working" offline by simulating locally, which is
// exactly the dishonesty the protocol forbids (see feed/nullFeed.ts). Note
// this feed supplies IDENTITY only — motion comes from src/lib/physics.

import type { RouteGeometry, TramSnapshot } from '@/lib/types';

/** Geometry fetch priority: 0 = urgent (tapped tram), 1 = normal, 2 = background. */
export type FeedPriority = 0 | 1 | 2;

/** Feed health for the status chip ("stale data" banner) + the poll indicator. */
export interface FeedStatus {
  /** Wall-clock ms of the last successfully delivered snapshot batch (0 = never). */
  lastBatchAtMs: number;
  /** Message of the most recent delivery failure, or null after a success. */
  lastError: string | null;
  /** Wall-clock ms when the most recent fetch attempt STARTED (0 = never). */
  lastFetchAtMs: number;
  /** Projected wall-clock ms of the next fetch start (0 = feed stopped). */
  nextFetchAtMs: number;
  /** True while a fetch is currently in flight. */
  inFlight: boolean;
  /** Active poll cadence in ms (0 = feed stopped). */
  pollIntervalMs: number;
  // — Optional health extensions (2026-07 review; additive so simple/fake
  //   feeds keep compiling). —
  /** True while the feed is halted on an auth failure (401/403) and probing
   * at a slow cadence instead of hammering the normal poll. */
  authFailed?: boolean;
  /** Consecutive failed polls (0 after a success) — drives failure backoff. */
  consecutiveFailures?: number;
  /** Cumulative count of records dropped by input validation since the feed
   * was created (see SnapshotRejectReason in golemio/vehicles). */
  rejectedTotal?: number;
  /** Cumulative dropped-record counts keyed by rejection reason. */
  rejectedByReason?: Record<string, number>;
}

/**
 * One sim-vs-reality telemetry record, produced once per snapshot batch per
 * tram-with-geometry. Superset of the motionlog daily poll record — field
 * names and rounding are the on-disk JSONL contract (`toCalibrationRecord`),
 * and the same shape is what a future backend ingests via
 * `POST /v1/calibration` to learn fleet-wide pace priors.
 *
 * All numeric fields are pre-rounded (see feed/calibration.ts) and `null` when
 * the underlying value is unavailable/non-finite.
 */
export interface CalibrationRecord {
  /** Batch wall-clock ms (the ingest time all records in a batch share). */
  t: number;
  /** Stable tram key (registration number string, fallback trip id). */
  key: string;
  /** Tram model id, e.g. '15t'. */
  model: string;
  /** Line as displayed, e.g. '9'. */
  line: string;
  /** Raw AVL fix distance along shape, m. */
  obsDist: number | null;
  /** Smoothed sim distance along shape, m. */
  simDist: number | null;
  /** Dead-reckoned observation distance along shape, m. */
  projDist: number | null;
  /** |sim − observed| deviation, m (1 decimal). */
  devM: number | null;
  /** Simulated speed, km/h (1 decimal). */
  kmh: number | null;
  /** Learned per-tram pace multiplier (2 decimals), when the sim exposes one. */
  bias: number | null;
  /** Rendered sim position (6 decimals). */
  lat: number | null;
  lng: number | null;
  /** Sim phase at record time. */
  mode: 'cruise' | 'dwell' | 'terminal' | 'unknown';
  // — R7 additions (schema v2) — raw AVL context so real dwells and true feed
  // speed become measurable. A repeated obsAt across polls = no fresh fix
  // (stale), so real feed speed is Δ(obsDist)/Δ(obsAt) between CHANGED obsAt
  // values, and a growing obsAt with flat obsDist + statePos 'at_stop' is a
  // real stop dwell (attributable to a stop via nextSeq).
  /** Unix ms of the last real AVL fix (snapshot.observedAtMs). */
  obsAt: number | null;
  /** Raw AVL state_position, e.g. 'on_track' | 'at_stop'. */
  statePos: string | null;
  /** Schedule delay in seconds (raw AVL). */
  delayS: number | null;
  /** Sequence number of the next stop on the trip. */
  nextSeq: number | null;
}

/**
 * The tram data service. Implemented by RemoteFeed (thin client over the
 * Convex backend); NullFeed is the inert no-backend case. Lifecycle: subscribe,
 * then start(); stop() must abort all in-flight work so no callback fires
 * afterwards (implementations use a generation guard for late completions).
 */
export interface TramFeed {
  /** Push semantics: emits a batch of fresh TramSnapshots as soon as available. */
  subscribeSnapshots(cb: (snapshots: TramSnapshot[], atMs: number) => void): () => void;
  /** Resolve trip geometry (may be remote-precomputed later). */
  getGeometry(tripId: string): RouteGeometry | undefined; // sync cache view
  /** Async warm-up of trip geometries at the given priority. */
  requestGeometry(tripIds: string[], priority: FeedPriority): void;
  /** Urgent geometry promotion (tapped/followed tram). */
  promoteGeometry(tripId: string): void;
  /**
   * Optional capability: notifies when a requested geometry has landed in the
   * local cache (getGeometry now returns it). The runtime uses it to re-ingest
   * promptly so a geometry-less tram starts simulating without waiting for the
   * next poll (or a tap). Feeds without it still work — the runtime falls back
   * to its post-poll nudge + the regular poll cadence.
   */
  subscribeGeometry?(cb: () => void): () => void;
  /**
   * Telemetry sink: deviation/calibration records (server-side aggregation
   * later). Must never throw into the caller — the render/ingest path calls it.
   */
  reportCalibration(records: CalibrationRecord[]): void;
  /** Feed health for the status chip. */
  status(): FeedStatus;
  /**
   * Begin emitting batches. `pollMs` optionally overrides the poll cadence
   * (implementation default otherwise) — the runtime's rideBackground mode
   * polls slower while a ride records with the app backgrounded.
   */
  start(pollMs?: number): void;
  stop(): void;
}
