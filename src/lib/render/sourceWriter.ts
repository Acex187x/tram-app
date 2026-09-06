/** Bounded native-delivery evidence; read by diagnostics at the existing1 Hz. */
export interface SourceDelivery {
  attempted: number;
  submitted: number;
  unchanged: number;
  coalesced: number;
  completed: number;
  acknowledged: number;
  pending: number;
  queued: number;
  payloadChars: number;
  lastLatencyMs: number | null;
  maxLatencyMs: number;
  failures: number;
  lastError: string | null;
  lastSubmittedAtMs: number | null;
  lastCompletedAtMs: number | null;
}
interface ShapeTarget { updateShape(shape: string): Promise<unknown> }
interface Request { payload: string; atMs: number; promise: Promise<boolean>; resolve: (accepted: boolean) => void }
interface Entry { target: ShapeTarget; latest: Request | null; active: Request | null; queued: Request | null; closed: boolean; stats: SourceDelivery }
const deliveries = new Map<string, SourceDelivery>();
export function getMapSourceDeliveries(): Record<string, SourceDelivery> {
  return Object.fromEntries([...deliveries].map(([key, value]) => [key, { ...value }]));
}

/** At most one native request and one latest unsent payload per source.
 * Superseded unsent requests resolve false, so they cannot acknowledge a hidden
 * transition. Its next phase is built only after the current hidden frame ack. */
export class SourceWriter {
  private entries = new Map<string, Entry>();
  isBusy(keys: readonly string[]): boolean {
    return keys.some((key) => { const entry = this.entries.get(key); return !!entry?.active || !!entry?.queued; });
  }
  send(key: string, target: ShapeTarget | null, payload: string, nowMs: number): Promise<boolean> | null {
    if (!target) return null;
    let entry = this.entries.get(key);
    if (!entry || entry.target !== target) {
      if (entry) this.close(entry);
      entry = { target, latest: null, active: null, queued: null, closed: false, stats: {
        attempted: 0, submitted: 0, unchanged: 0, coalesced: 0, completed: 0,
        acknowledged: 0, pending: 0, queued: 0, payloadChars: 0, lastLatencyMs: null, maxLatencyMs: 0, failures: 0,
        lastError: null, lastSubmittedAtMs: null, lastCompletedAtMs: null,
      } };
      this.entries.set(key, entry);
      deliveries.set(key, entry.stats);
    }
    entry.stats.attempted++;
    if (entry.latest?.payload === payload) { entry.stats.unchanged++; return entry.latest.promise; }
    let resolve!: (accepted: boolean) => void;
    const request: Request = { payload, atMs: nowMs, promise: new Promise<boolean>((done) => { resolve = done; }), resolve: (accepted) => resolve(accepted) };
    entry.latest = request;
    if (entry.active) {
      if (entry.queued) { entry.queued.resolve(false); entry.stats.coalesced++; }
      entry.queued = request;
      entry.stats.queued = 1;
    } else this.dispatch(entry, request);
    return request.promise;
  }
  private dispatch(entry: Entry, request: Request): void {
    const stats = entry.stats;
    entry.active = request;
    stats.submitted++;
    stats.pending = 1;
    stats.payloadChars += request.payload.length; // UTF-16 characters, not bytes.
    const submittedAtMs = Date.now();
    stats.lastSubmittedAtMs = submittedAtMs;
    const finish = (accepted: boolean, error?: unknown) => {
      stats.completed++;
      stats.pending = 0;
      stats.lastCompletedAtMs = Date.now();
      stats.lastLatencyMs = Math.max(0, stats.lastCompletedAtMs - submittedAtMs);
      stats.maxLatencyMs = Math.max(stats.maxLatencyMs, stats.lastLatencyMs);
      if (accepted) { stats.acknowledged++; stats.lastError = null; }
      else {
        stats.failures++;
        stats.lastError = error instanceof Error ? error.message : String(error ?? 'Native source did not accept this frame');
        if (entry.latest === request) entry.latest = null; // identical retry allowed
      }
      request.resolve(accepted && !entry.closed);
      entry.active = null;
      const queued = entry.queued;
      entry.queued = null;
      stats.queued = 0;
      if (queued && !entry.closed) this.dispatch(entry, queued);
    };
    try { void entry.target.updateShape(request.payload).then((accepted) => finish(accepted !== false), (error) => finish(false, error)); }
    catch (error) { finish(false, error); }
  }
  private close(entry: Entry): void {
    entry.closed = true;
    entry.queued?.resolve(false);
    entry.queued = null;
    entry.stats.queued = 0;
  }
  dispose(): void {
    for (const [key, entry] of this.entries) {
      this.close(entry);
      if (deliveries.get(key) === entry.stats) deliveries.delete(key);
    }
    this.entries.clear();
  }
}

/** Only explicit hidden transition frames wait for aggregate native acceptance.
 * One pending aggregate per vehicle/token; no history or per-frame React work. */
export class HiddenFrameAcks {
  private pending = new Map<string, number>();
  private generation = 0;
  wait(key: string, token: number, deliveries: (Promise<boolean> | null)[], acknowledge: (key: string, token: number) => void): void {
    if (this.pending.get(key) === token || deliveries.length === 0 || deliveries.some((d) => d === null)) return;
    this.pending.set(key, token);
    const generation = this.generation;
    void Promise.all(deliveries).then((accepted) => {
      if (this.generation !== generation || this.pending.get(key) !== token) return;
      this.pending.delete(key);
      if (accepted.every(Boolean)) acknowledge(key, token);
    }, () => { if (this.generation === generation && this.pending.get(key) === token) this.pending.delete(key); });
  }
  dispose(): void { this.generation++; this.pending.clear(); }
}
