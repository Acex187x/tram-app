// The TramFeed boundary — the service contract a future backend implements 1:1.
//
// Everything the interpolation engine + UI need from "the outside world" flows
// through this interface: fresh vehicle snapshots (push semantics), trip
// geometry resolution, calibration telemetry (deviation records), and feed
// health. Today the only implementation is LocalGolemioFeed (the "backend"
// runs on the client: a 5 s Golemio poll loop + on-device shape cache +
// on-device motion log). A future RemoteFeed talks WebSocket/HTTP to a real
// server that polls Golemio at ~1–2 s and aggregates calibration fleet-wide —
// see docs/decisions/backend-plan.md. The engine and hooks must never care
// which one is behind the interface.

import type { RouteGeometry, TramSnapshot } from '@/lib/types';

/** Geometry fetch priority: 0 = urgent (tapped tram), 1 = normal, 2 = background. */
export type FeedPriority = 0 | 1 | 2;

/** Feed health for the status chip ("stale data" banner). */
export interface FeedStatus {
  /** Wall-clock ms of the last successfully delivered snapshot batch (0 = never). */
  lastBatchAtMs: number;
  /** Message of the most recent delivery failure, or null after a success. */
  lastError: string | null;
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
 * The tram data service. Implemented today by LocalGolemioFeed (client-side),
 * later by RemoteFeed (thin client over the backend). Lifecycle: subscribe,
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
