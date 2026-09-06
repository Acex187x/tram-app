/** Version-4 append-only features. Numerical authority:
 * lab/ml/research_motion_features.py; common goldens cover both languages.
 * Receipt ordering is a caller obligation: never feed a future target pair. */
import type { RouteGeometry, TramSnapshot } from '@/lib/types';

export const MOTION_FEATURE_NAMES = [
  'lastLegPace', 'motionTrust', 'motionAgeS', 'tripPaceRatio',
  'currentPlatformOffsetM', 'platformKnown', 'stationaryEvidenceS',
] as const;
export type MotionFeatures = [number, number, number, number, number, number, number];
export const MOTION_HALF_LIFE_MS = 180_000;
export const unknownMotionFeatures = (): MotionFeatures => [0, 0, 300, 1, 0, 0, 0];
type MotionFix = Pick<TramSnapshot, 'key' | 'tripId' | 'routeId' | 'observedAtMs' |
  'shapeDistM' | 'coordinates' | 'statePosition' | 'nextStopId' | 'lastStopId'>;
type MotionGeometry = Pick<RouteGeometry, 'shapeId' | 'stops'>;
export type MotionPaceAt = (shapeId: string, routeId: string, distM: number, observedAtMs: number) => number;
export interface MotionFeatureEvidence {
  receivedAtMs: number;
  observedAtMs: number;
  freshObservation: boolean;
  platformProvenance: 'unique-next-predecessor' | 'unknown';
  inferredPlatformId: string | null;
  /** Richer live identity is diagnostic only; it cannot alter the seven columns. */
  exactPlatformRelation: 'matches' | 'contradicts' | 'unknown';
}
interface History {
  tripId: string;
  prev: MotionFix | null;
  pace: number;
  weight: number;
  ratio: number;
  at: number;
  standing: number | null;
  offset: number;
  known: number;
  stationary: number;
  evidence: MotionFeatureEvidence;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const decay = (ms: number) => 0.5 ** (Math.max(0, ms) / MOTION_HALF_LIFE_MS);
const radians = (degrees: number) => degrees * Math.PI / 180;

export class MotionFeatureHistory {
  private readonly histories = new Map<string, History>();
  private readonly platforms = new WeakMap<MotionGeometry, Map<string, { distM: number; stopId: string }>>();
  private lastReceiptMs = -Infinity;
  constructor(private readonly maxVehicles = 2048) {
    if (!Number.isInteger(maxVehicles) || maxVehicles < 1) throw new Error('maxVehicles must be a positive integer');
  }
  get size(): number { return this.histories.size; }

  /** Input is already in receipt order. Equal receipt epochs preserve call order.
   * An out-of-order receipt is rejected, not silently learned from the future. */
  observe(fix: MotionFix, geometry: MotionGeometry | null | undefined,
    paceAt: MotionPaceAt, receivedAtMs: number): MotionFeatureEvidence {
    if (!Number.isFinite(receivedAtMs) || receivedAtMs < this.lastReceiptMs) {
      throw new Error('MotionFeatureHistory.observe requires nondecreasing receipt epochs');
    }
    this.lastReceiptMs = receivedAtMs;
    let h = this.histories.get(fix.key);
    if (!h || h.tripId !== fix.tripId) {
      h = { tripId: fix.tripId, prev: null, pace: 0, weight: 0, ratio: 1, at: 0,
        standing: null, offset: 0, known: 0, stationary: 0,
        evidence: { receivedAtMs, observedAtMs: fix.observedAtMs, freshObservation: true,
          platformProvenance: 'unknown', inferredPlatformId: null, exactPlatformRelation: 'unknown' } };
    }
    const prev = h.prev;
    const fresh = prev === null || fix.observedAtMs > prev.observedAtMs;
    if (fresh) {
      if (prev) {
        const dt = (fix.observedAtMs - prev.observedAtMs) / 1000;
        const ds = fix.shapeDistM - prev.shapeDistM;
        const sameLeg = fix.nextStopId !== null && fix.nextStopId === prev.nextStopId;
        if (dt >= 5 && dt <= 120 && sameLeg && fix.statePosition === 'on_track' &&
          prev.statePosition === 'on_track' && ds >= 15 && ds / dt >= 0.5 && ds / dt <= 22 && geometry) {
          const expected = paceAt(geometry.shapeId, fix.routeId, prev.shapeDistM + ds / 2, fix.observedAtMs);
          const weight = h.at ? h.weight * decay(fix.observedAtMs - h.at) : 0;
          h.pace = (h.pace * weight + ds / dt) / (weight + 1);
          h.ratio = (h.ratio * weight + clamp((ds / dt) / Math.max(0.5, expected), 0.4, 2)) / (weight + 1);
          h.weight = weight + 1;
          h.at = fix.observedAtMs;
        }
        const gpsM = 6371000 * Math.hypot(
          radians(fix.coordinates[0] - prev.coordinates[0]) * Math.cos(radians((fix.coordinates[1] + prev.coordinates[1]) / 2)),
          radians(fix.coordinates[1] - prev.coordinates[1]));
        if (dt >= 5 && dt <= 120 && sameLeg && fix.statePosition === 'at_stop' &&
          prev.statePosition === 'at_stop' && Math.abs(ds) <= 8 && gpsM <= 12) {
          if (h.standing === null) h.standing = prev.observedAtMs;
        } else h.standing = null;
      }
      // Snapshot primitive fields and coordinates; subsequent caller mutation cannot rewrite evidence.
      h.prev = { ...fix, coordinates: [...fix.coordinates] };
    }
    const platform = geometry && fix.nextStopId !== null
      ? this.platformIndex(geometry).get(fix.nextStopId) : undefined;
    h.offset = platform ? clamp(platform.distM - fix.shapeDistM, -200, 200) : 0;
    h.known = platform ? 1 : 0;
    // For a stale incoming row Python preserves history but evaluates this row's platform/standing fields.
    h.stationary = h.standing === null ? 0 : clamp((fix.observedAtMs - h.standing) / 1000, 0, 120);
    h.evidence = { receivedAtMs, observedAtMs: fix.observedAtMs, freshObservation: fresh,
      platformProvenance: platform ? 'unique-next-predecessor' : 'unknown',
      inferredPlatformId: platform?.stopId ?? null,
      exactPlatformRelation: !platform || fix.lastStopId === null ? 'unknown' :
        fix.lastStopId === platform.stopId ? 'matches' : 'contradicts' };
    this.histories.delete(fix.key);
    this.histories.set(fix.key, h);
    while (this.histories.size > this.maxVehicles) this.histories.delete(this.histories.keys().next().value!);
    return { ...h.evidence };
  }

  /** Evaluate an issued/future horizon. This read never advances history.
   * Historical queries preceding the latest receipt cannot reconstruct an older
   * information set, so return unknown rather than leaking the current row. */
  features(key: string, tripId: string, issueMs: number): MotionFeatures {
    const h = this.histories.get(key);
    if (!h || h.tripId !== tripId || !Number.isFinite(issueMs) || issueMs < h.evidence.receivedAtMs) return unknownMotionFeatures();
    const age = h.at ? Math.max(0, (issueMs - h.at) / 1000) : 300;
    const weight = h.at ? h.weight * decay(issueMs - h.at) : 0;
    const ratio = (1 + h.ratio * weight) / (1 + weight);
    return [weight >= 0.25 ? h.pace : 0, Math.min(5, weight), Math.min(300, age),
      clamp(ratio, 0.5, 1.6), h.offset, h.known, h.stationary];
  }
  evidence(key: string): MotionFeatureEvidence | null {
    const evidence = this.histories.get(key)?.evidence;
    return evidence ? { ...evidence } : null;
  }
  /** Departure cleanup; 180 s is a half-life, never a history expiration timer. */
  prune(activeKeys: ReadonlySet<string>): void {
    for (const key of this.histories.keys()) if (!activeKeys.has(key)) this.histories.delete(key);
  }
  /** Geometry quarantine must discard learned state even if the raw key remains in the fleet. */
  forget(key: string): void { this.histories.delete(key); }
  /** A replaced source starts a new receipt stream as well as a new information set. */
  clear(): void {
    this.histories.clear();
    this.lastReceiptMs = -Infinity;
  }
  private platformIndex(geometry: MotionGeometry): Map<string, { distM: number; stopId: string }> {
    const cached = this.platforms.get(geometry);
    if (cached) return cached;
    const occurrences = new Map<string, number[]>();
    geometry.stops.forEach((stop, index) => {
      const indices = occurrences.get(stop.stopId) ?? [];
      indices.push(index);
      occurrences.set(stop.stopId, indices);
    });
    const result = new Map<string, { distM: number; stopId: string }>();
    for (const [id, indices] of occurrences) if (indices.length === 1 && indices[0] > 0) {
      const prev = geometry.stops[indices[0] - 1];
      result.set(id, { distM: prev.distM, stopId: prev.stopId });
    }
    this.platforms.set(geometry, result);
    return result;
  }
}
