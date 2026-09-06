import { evalTrajectory, prepareHermiteTrack } from '../../src/lib/physics/evaluator';

interface Point { t: number; s: number; v?: number }
interface IssuedCurve {
  tripId: string;
  anchorMs: number;
  emittedAtMs: number;
  opinion: Point[];
  smooth: Point[];
}
const packed = new WeakMap<Point[], Float64Array>();
function at(points: Point[], atMs: number): number | null {
  if (!points.length || atMs < points[0].t || atMs > points[points.length - 1].t) return null;
  let data = packed.get(points);
  if (!data) {
    data = prepareHermiteTrack(new Float64Array(points.flatMap(p => [p.t, p.s])),
      new Float64Array(points.map(p => p.v ?? NaN)));
    packed.set(points, data);
  }
  const value = evalTrajectory(data, atMs);
  return Number.isFinite(value) ? value : null;
}

/** Score a prediction that actually existed before this observation. Receipt
 * time is retained by the caller as latency telemetry, never as truth time. */
export function observationPredictions(
  curve: IssuedCurve,
  fix: { tripId: string; observedAtMs: number },
  raw?: Point[],
): { opinion: number; smooth: number; raw: number | null } | null {
  const t = fix.observedAtMs;
  if (curve.tripId !== fix.tripId || curve.anchorMs >= t || curve.emittedAtMs > t) return null;
  const opinion = at(curve.opinion, t), smooth = at(curve.smooth, t);
  if (opinion === null || smooth === null) return null;
  return { opinion, smooth, raw: raw ? at(raw, t) : null };
}

interface HistoricalCurve {
  curve: IssuedCurve;
  raw?: Point[];
  /** Confirmed publication/HTTP availability time, not compute start. */
  availableAtMs: number;
}
/** Bounded history prevents a late observation from losing its eligible
 * prediction just because a newer revision arrived during ingest latency. */
export class ObservationHistory {
  private byKey = new Map<string, HistoricalCurve[]>();
  readonly counts = { eligible: 0, missing: 0, beyondHorizon: 0 };
  constructor(private readonly retentionMs = 360_000, private readonly perKeyLimit = 96) {}
  record(key: string, curve: IssuedCurve, availableAtMs: number, raw?: Point[]): void {
    let entries = this.byKey.get(key);
    if (!entries) this.byKey.set(key, entries = []);
    if (entries.some(e => e.curve.emittedAtMs === curve.emittedAtMs && e.curve.tripId === curve.tripId)) return;
    entries.push({curve, availableAtMs, raw});
    while (entries.length > this.perKeyLimit || entries[0].availableAtMs < availableAtMs - this.retentionMs) entries.shift();
  }
  predict(key: string, fix: {tripId: string; observedAtMs: number}):
    { prediction: NonNullable<ReturnType<typeof observationPredictions>>; anchorMs: number } | null {
    const entries = this.byKey.get(key);
    let selected: HistoricalCurve | undefined;
    for (let index = (entries?.length ?? 0) - 1; index >= 0; index--) {
      const entry = entries![index];
      if (entry.availableAtMs <= fix.observedAtMs && entry.curve.tripId === fix.tripId) { selected = entry; break; }
    }
    if (!selected) { this.counts.missing++; return null; }
    const prediction = observationPredictions(selected.curve, fix, selected.raw);
    if (!prediction) { this.counts.beyondHorizon++; return null; }
    this.counts.eligible++;
    return {prediction, anchorMs:selected.curve.anchorMs};
  }
  prune(nowMs: number): void {
    for (const [key, entries] of this.byKey) {
      while (entries.length && entries[0].availableAtMs < nowMs - this.retentionMs) entries.shift();
      if (!entries.length) this.byKey.delete(key);
    }
  }
  forget(key: string): void { this.byKey.delete(key); }
  get size(): number { return [...this.byKey.values()].reduce((sum, entries) => sum + entries.length, 0); }
}
