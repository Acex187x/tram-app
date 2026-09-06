/** Availability for private review deployments. Public builds keep one socket. */
import { parseVehicle } from './bundle';
import {
  ConvexTrajectorySource,
  type TrajectorySink,
  type TrajectoryMetaWire,
  type ConvexTrajectorySourceOptions,
} from './convexSource';

export const SOURCE_SILENCE_MS = 15_000;
export const PRIMARY_PROBE_INTERVAL_MS = 120_000;
export const PRIMARY_PROBE_TIMEOUT_MS = 20_000;
export const PRIMARY_RECOVERY_PROGRESS_MS = 5_000;
const MAX_STAGED_VEHICLES = 2_000;

type Role = 'primary' | 'fallback';
export interface TrajectorySourceStatus {
  active: Role;
  url: string;
  reason: string | null;
  switches: number;
  probing: boolean;
  /** Attempted endpoint while the last accepted source still supplies aging curves. */
  connecting: Role | null;
}
interface Source { start(): void; stop(): void }
interface Endpoint {
  role: Role;
  source: Source;
  live: boolean;
  seeded: boolean;
  startedAt: number;
  progressAt: number;
  firstProgressAt: number | null;
  firstPublication: number;
  publication: number;
  seq: number;
  failureAt: number | null;
  advertisedSeq: number;
  advertisedAt: number;
  lagSince: number | null;
  rows: Map<string, unknown>;
  meta: TrajectoryMetaWire | null;
  clock: [number, number, number] | null;
}
interface Options {
  url: string;
  fallbackUrl?: string;
  createSource?: (sink: TrajectorySink, options: ConvexTrajectorySourceOptions) => Source;
}

export class ResilientTrajectorySource {
  private active: Endpoint | null = null;
  private probe: Endpoint | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextProbeAt = 0;
  private switches = 0;
  private reason: string | null = null;
  private acceptedRole: Role | null = null;
  private readonly fallbackUrl: string | undefined;
  private readonly create: NonNullable<Options['createSource']>;

  constructor(private readonly sink: TrajectorySink, private readonly options: Options) {
    this.fallbackUrl = options.fallbackUrl !== options.url ? options.fallbackUrl : undefined;
    this.create = options.createSource ?? ((sink, options) => new ConvexTrajectorySource(sink, options));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reason = null;
    this.active = this.endpoint('primary');
    this.publishStatus();
    this.startEndpoint(this.active);
    if (this.fallbackUrl) this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.close(this.probe);
    this.close(this.active);
    this.probe = this.active = null;
  }

  private close(endpoint: Endpoint | null): void {
    if (!endpoint) return;
    endpoint.live = false; // close can complete queued callbacks synchronously
    endpoint.rows.clear();
    endpoint.source.stop();
  }

  private startEndpoint(endpoint: Endpoint): void {
    try { endpoint.source.start(); }
    catch (error) {
      if (endpoint === this.active) this.sink.noteConvexFailure(`Trajectory connection failed: ${String(error)}`);
    }
  }

  private publishStatus(epoch = false): void {
    if (!this.active) return;
    this.sink.noteConvexSource?.({
      active: this.acceptedRole ?? this.active.role,
      url: (this.acceptedRole ?? this.active.role) === 'primary' ? this.options.url : this.fallbackUrl!,
      reason: this.reason,
      switches: this.switches,
      probing: this.probe !== null,
      connecting: this.active.seeded ? null : this.active.role,
    }, epoch);
  }

  private progress(endpoint: Endpoint, atMs: number, receivedAt: number): void {
    if (!Number.isFinite(atMs) || atMs <= endpoint.publication) return;
    endpoint.publication = atMs;
    endpoint.progressAt = receivedAt;
    if (endpoint.firstProgressAt === null) {
      endpoint.firstProgressAt = receivedAt;
      endpoint.firstPublication = atMs;
    }
  }

  private trackLag(endpoint: Endpoint, receivedAt: number): void {
    if (endpoint.seeded && endpoint.advertisedSeq > endpoint.seq)
      endpoint.lagSince ??= receivedAt;
    else endpoint.lagSince = null;
  }

  private endpoint(role: Role): Endpoint {
    const endpoint: Endpoint = {
      role, source: null!, live: true, seeded: false,
      startedAt: Date.now(), progressAt: Date.now(), firstProgressAt: null,
      firstPublication: 0, publication: 0, seq: 0, failureAt: null,
      advertisedSeq: 0, advertisedAt: 0, lagSince: null, rows: new Map(), meta: null, clock: null,
    };
    const valid = () => this.running && endpoint.live;
    const active = () => endpoint === this.active;
    const stage = (rows: unknown[]) => {
      for (const row of rows) {
        const parsed = parseVehicle(row);
        if (!parsed) continue;
        const previous = endpoint.rows.get(parsed.key);
        if (previous && (parseVehicle(previous)?.emittedAtMs ?? 0) > parsed.emittedAtMs) continue;
        if (previous || endpoint.rows.size < MAX_STAGED_VEHICLES) endpoint.rows.set(parsed.key, row);
      }
    };
    endpoint.source = this.create({
      seedConvex: (rows, meta, receivedAt) => {
        if (!valid()) return;
        const firstSeed = !endpoint.seeded;
        endpoint.seeded = true;
        endpoint.failureAt = null;
        endpoint.seq = meta?.lastSeq ?? 0;
        endpoint.meta = meta;
        endpoint.advertisedSeq = Math.max(endpoint.advertisedSeq, endpoint.seq);
        this.trackLag(endpoint, receivedAt);
        this.progress(endpoint, meta?.atMs ?? 0, receivedAt);
        if (active()) {
          this.acceptedRole = endpoint.role;
          this.publishStatus(firstSeed);
          if (firstSeed && endpoint.clock) this.sink.noteConvexClock(...endpoint.clock, receivedAt);
          this.sink.seedConvex(rows, meta, receivedAt);
        } else {
          endpoint.rows.clear();
          stage(rows);
        }
      },
      foldConvex: (batch, serverNowMs, receivedAt) => {
        if (!valid() || !endpoint.seeded || batch.seq <= endpoint.seq) return;
        endpoint.seq = batch.seq;
        this.trackLag(endpoint, receivedAt);
        this.progress(endpoint, batch.atMs, receivedAt);
        endpoint.failureAt = null;
        if (active()) this.sink.foldConvex(batch, serverNowMs, receivedAt);
        else {
          stage(batch.changed);
          for (const key of batch.removed ?? []) endpoint.rows.delete(key);
          endpoint.seq = batch.seq;
          if (endpoint.meta) endpoint.meta = {
            ...endpoint.meta, lastSeq: batch.seq,
            atMs: Math.max(batch.atMs, endpoint.meta.atMs), serverNowMs,
          };
        }
      },
      noteConvexMeta: (meta, receivedAt) => {
        if (!valid()) return;
        this.progress(endpoint, meta.atMs, receivedAt);
        if (meta.publishedAtMs >= endpoint.advertisedAt) {
          endpoint.advertisedAt = meta.publishedAtMs;
          endpoint.advertisedSeq = meta.lastSeq;
        }
        this.trackLag(endpoint, receivedAt);
        // Heartbeat cursor can lead applied diffs: keep the staged applied cursor.
        if (!endpoint.meta || meta.atMs >= endpoint.meta.atMs)
          endpoint.meta = { ...meta, lastSeq: endpoint.seq };
        if (active() && endpoint.seeded) this.sink.noteConvexMeta(meta, receivedAt);
      },
      noteConvexFailure: (message) => {
        if (!valid()) return;
        endpoint.failureAt ??= Date.now();
        if (active()) this.sink.noteConvexFailure(message);
      },
      noteConvexClock: (serverNow, sentAt, receivedAt) => {
        if (!valid() || receivedAt < sentAt || receivedAt - sentAt > 2_000 || !Number.isFinite(serverNow)) return;
        endpoint.clock = [serverNow, sentAt, receivedAt];
        if (active() && endpoint.seeded) this.sink.noteConvexClock(serverNow, sentAt, receivedAt);
      },
    }, { url: role === 'primary' ? this.options.url : this.fallbackUrl! });
    return endpoint;
  }

  private promote(probe: Endpoint): void {
    this.close(this.active);
    this.active = probe;
    this.acceptedRole = 'primary';
    this.probe = null;
    this.reason = 'Private predictor recovered after sustained publisher progress';
    this.switches += 1;
    this.publishStatus(true);
    if (probe.clock) this.sink.noteConvexClock(...probe.clock, Date.now());
    this.sink.seedConvex([...probe.rows.values()], probe.meta, Date.now());
    probe.rows.clear();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || !this.active) return;
      const now = Date.now();
      const active = this.active;
      if (active.role === 'primary' && (
        now - (active.seeded ? active.progressAt : active.startedAt) >= SOURCE_SILENCE_MS ||
        (active.failureAt !== null && now - active.failureAt >= SOURCE_SILENCE_MS) ||
        (active.lagSince !== null && now - active.lagSince >= SOURCE_SILENCE_MS)
      )) {
        this.close(active);
        this.reason = active.lagSince !== null ? 'Private vehicle rows lagged behind the advertised publisher head' : active.failureAt !== null ? 'Private trajectory delivery failed persistently' : active.seeded ? 'Private predictor stopped publishing' : 'Private predictor did not provide a seed within 15 seconds';
        this.switches += 1;
        this.active = this.endpoint('fallback');
        this.nextProbeAt = now + PRIMARY_PROBE_INTERVAL_MS;
        this.publishStatus();
        this.startEndpoint(this.active);
      }
      if (this.active.role === 'fallback' && !this.probe && now >= this.nextProbeAt) {
        this.probe = this.endpoint('primary');
        this.nextProbeAt = now + PRIMARY_PROBE_INTERVAL_MS;
        this.publishStatus();
        this.startEndpoint(this.probe);
      }
      const probe = this.probe;
      if (probe) {
        const offset = probe.clock ? probe.clock[0] - (probe.clock[1] + probe.clock[2]) / 2 : 0;
        const publicationAge = now + offset - probe.publication;
        const progressing = probe.seeded && probe.failureAt === null && probe.lagSince === null && probe.meta && probe.firstProgressAt !== null &&
          probe.progressAt - probe.firstProgressAt >= PRIMARY_RECOVERY_PROGRESS_MS &&
          probe.publication - probe.firstPublication >= PRIMARY_RECOVERY_PROGRESS_MS &&
          now - probe.progressAt < SOURCE_SILENCE_MS &&
          publicationAge >= -30_000 && publicationAge < 45_000;
        if (progressing) this.promote(probe);
        else if (now - probe.startedAt >= PRIMARY_PROBE_TIMEOUT_MS) {
          this.close(probe);
          this.probe = null;
          this.publishStatus();
        }
      }
      this.schedule();
    }, 1_000);
  }
}
