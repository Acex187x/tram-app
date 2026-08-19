// The whole client physics engine, part 8: the fleet seam.
//
// This class occupies exactly the seam the old `TramEngine` did — `ingest()`
// per poll, `getState(s)` per push — so the map, sheets, lists, follow camera
// and motion log kept their call sites. What is GONE is everything in between:
// no tick(), no substeps, no per-tram sims, no smoother, no speed profile, no
// queue/junction constraints, no clock to reset, nothing to resync after a
// suspension. A frame is: look up a vehicle's curves, evaluate them at the
// server-corrected instant, place the result on the trip polyline.
//
// Snapshots (identity, line, headsign, delay, AVL fix) still come from the
// TramFeed; geometry still comes from the shape cache. Only MOTION moved to
// the server.

import type {
  RouteGeometry,
  TramModelSpec,
  TramPublicState,
  TramSnapshot,
  PhysicsDebugInfo,
} from '@/lib/types';
import { segmentIndexAt } from '@/lib/geo/polyline';
import { adaptTram } from './adapter';
import { evalSpeedMs, evalTrajectory, trackEndMs } from './evaluator';
import { catchupVMsFor, fixForwardAppliedM, renderDistM, trackFor, type RenderMode } from './render';
import type { TrajectoryStore } from './trajectoryStore';

export interface TramFleetOptions {
  resolveModel: (snapshot: TramSnapshot) => TramModelSpec;
  trajectories: TrajectoryStore;
}

/**
 * True when the point `d` meters along the shape lies inside `bbox`.
 * Allocation-free (no [lng,lat] tuple) — this runs over the WHOLE fleet on
 * close-zoom pushes to cull before any public state is built (perf #5/#8).
 */
function distInBbox(
  geometry: RouteGeometry,
  d: number,
  bbox: [number, number, number, number],
): boolean {
  const { coordinates, cumDistM } = geometry;
  const n = coordinates.length;
  if (n === 0) return false;
  const total = cumDistM[n - 1];
  const clamped = d < 0 ? 0 : d > total ? total : d;
  const i = segmentIndexAt(cumDistM, clamped);
  const a = coordinates[i];
  let lng = a[0];
  let lat = a[1];
  if (i + 1 < n) {
    const segLen = cumDistM[i + 1] - cumDistM[i];
    if (segLen > 1e-9) {
      const t = (clamped - cumDistM[i]) / segLen;
      const b = coordinates[i + 1];
      lng = a[0] + (b[0] - a[0]) * t;
      lat = a[1] + (b[1] - a[1]) * t;
    }
  }
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

export class TramFleet {
  private readonly resolveModel: (snapshot: TramSnapshot) => TramModelSpec;
  private readonly trajectories: TrajectoryStore;

  /** Live fleet, rebuilt each ingest — departed vehicles drop out by construction. */
  private snapshots = new Map<string, TramSnapshot>();
  private geometries = new Map<string, RouteGeometry>();
  private models = new Map<string, TramModelSpec>();
  /** Render mode mirrored from the settings store by the runtime. */
  private mode: RenderMode = 'smooth';

  constructor(opts: TramFleetOptions) {
    this.resolveModel = opts.resolveModel;
    this.trajectories = opts.trajectories;
  }

  /** Selected render mode (settings). Affects every getter that omits one. */
  setMode(mode: RenderMode): void {
    this.mode = mode;
  }

  get renderMode(): RenderMode {
    return this.mode;
  }

  /** Live vehicle count (status tile). */
  get size(): number {
    return this.snapshots.size;
  }

  /**
   * One fresh snapshot batch. Pure bookkeeping: identity, model and the trip
   * geometry currently resolvable for each key. No physics happens here — the
   * curves arrive on their own 5 s cadence and are read at render time.
   */
  ingest(
    snapshots: readonly TramSnapshot[],
    getGeometry: (tripId: string) => RouteGeometry | undefined,
  ): void {
    const nextSnapshots = new Map<string, TramSnapshot>();
    const nextGeometries = new Map<string, RouteGeometry>();
    const nextModels = new Map<string, TramModelSpec>();
    for (const s of snapshots) {
      nextSnapshots.set(s.key, s);
      const geometry = getGeometry(s.tripId);
      if (geometry) nextGeometries.set(s.key, geometry);
      const known = this.models.get(s.key);
      nextModels.set(s.key, known ?? this.resolveModel(s));
    }
    this.snapshots = nextSnapshots;
    this.geometries = nextGeometries;
    this.models = nextModels;
  }

  /** Trip geometry currently driving a tram's rendering. */
  getGeometry(key: string): RouteGeometry | undefined {
    return this.geometries.get(key);
  }

  /** Raw snapshot for a key (identity/AVL context without building a state). */
  getSnapshot(key: string): TramSnapshot | undefined {
    return this.snapshots.get(key);
  }

  /**
   * One tram's public state at `localNowMs` (device clock in, server-corrected
   * inside). Undefined when the key is not in the live fleet.
   */
  getState(
    key: string,
    localNowMs: number = Date.now(),
    mode: RenderMode = this.mode,
  ): TramPublicState | undefined {
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return undefined;
    return this.build(snapshot, this.trajectories.nowMs(localNowMs), mode);
  }

  /** The whole live fleet (calibration + far-zoom pushes + 1 Hz UI hooks). */
  getStates(localNowMs: number = Date.now(), mode: RenderMode = this.mode): TramPublicState[] {
    const serverNow = this.trajectories.nowMs(localNowMs);
    const out: TramPublicState[] = [];
    for (const snapshot of this.snapshots.values()) {
      out.push(this.build(snapshot, serverNow, mode));
    }
    return out;
  }

  /**
   * Viewport-culled states for close-zoom pushes: every tram is evaluated
   * (arithmetic only) but only those inside `bbox` — plus the selected and
   * followed trams, which overlays need wherever they are — become full public
   * state objects. This is the "cull before you allocate" rule of perf #5.
   */
  getStatesInBounds(
    localNowMs: number,
    bbox: [number, number, number, number],
    selectedKey: string | null,
    followKey: string | null,
    mode: RenderMode = this.mode,
  ): TramPublicState[] {
    const serverNow = this.trajectories.nowMs(localNowMs);
    const out: TramPublicState[] = [];
    for (const snapshot of this.snapshots.values()) {
      const key = snapshot.key;
      if (key !== selectedKey && key !== followKey) {
        const geometry = this.geometries.get(key);
        if (geometry) {
          const vehicle = this.vehicleFor(snapshot);
          // Same fix-forward composition the adapter renders with — culling on
          // the raw curve would test a position up to hundreds of meters away
          // from the marker (fixForward.ts) and pop trams at the bbox edge.
          const d = vehicle
            ? renderDistM(vehicle, serverNow, mode, snapshot.shapeDistM, snapshot.observedAtMs)
            : snapshot.shapeDistM;
          if (!distInBbox(geometry, d, bbox)) continue;
        } else {
          const c = snapshot.coordinates;
          if (c[0] < bbox[0] || c[0] > bbox[2] || c[1] < bbox[1] || c[1] > bbox[3]) continue;
        }
      }
      out.push(this.build(snapshot, serverNow, mode));
    }
    return out;
  }

  /** Curves for a snapshot, or undefined when none apply to its current trip. */
  private vehicleFor(snapshot: TramSnapshot) {
    const v = this.trajectories.getVehicle(snapshot.key);
    return v !== undefined && v.tripId === snapshot.tripId ? v : undefined;
  }

  private build(
    snapshot: TramSnapshot,
    serverNowMs: number,
    mode: RenderMode,
  ): TramPublicState {
    return adaptTram({
      snapshot,
      model: this.models.get(snapshot.key) ?? this.resolveModel(snapshot),
      geometry: this.geometries.get(snapshot.key),
      vehicle: this.trajectories.getVehicle(snapshot.key),
      serverNowMs,
      mode,
    });
  }

  /**
   * Additive, on-demand devtools view of ONE tram (debug overlay only). Nothing
   * here feeds rendering. Replaces the old SimDebugInfo's 30 controller
   * internals with what a trajectory client can actually be wrong about:
   * which curve, how far apart the two curves are, how much horizon is left,
   * and how stale everything is.
   */
  getDiagnostics(
    key: string,
    localNowMs: number = Date.now(),
    mode: RenderMode = this.mode,
  ): PhysicsDebugInfo | undefined {
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return undefined;
    const serverNowMs = this.trajectories.nowMs(localNowMs);
    const vehicle = this.vehicleFor(snapshot);
    const state = this.build(snapshot, serverNowMs, mode);
    const health = this.trajectories.health(localNowMs);

    let smoothDistM: number | null = null;
    let fixedDistM: number | null = null;
    let horizonLeftS: number | null = null;
    let fixForwardM: number | null = null;
    if (vehicle) {
      // The two curves RAW — deviationM and the smooth-vs-fixed comparison are
      // about what the server published, so the shim stays out of them.
      if (vehicle.smooth.length > 0) smoothDistM = evalTrajectory(vehicle.smooth, serverNowMs);
      if (vehicle.opinion.length > 0) fixedDistM = evalTrajectory(vehicle.opinion, serverNowMs);
      horizonLeftS = (trackEndMs(trackFor(vehicle, mode)) - serverNowMs) / 1000;
      // …and the meters the shim is currently adding on top, which is the one
      // number that says "the served curve is this far behind the newest fix".
      // Reading it in the field is how a complaint becomes a measurement.
      fixForwardM = fixForwardAppliedM(
        trackFor(vehicle, mode),
        serverNowMs,
        catchupVMsFor(mode),
        snapshot.shapeDistM,
        snapshot.observedAtMs,
        vehicle.anchorMs,
      );
    }

    return {
      hasTrajectory: vehicle !== undefined,
      hasGeometry: state.hasGeometry,
      mode,
      simDistM: state.simDistM,
      smoothDistM,
      fixedDistM,
      deltaM: smoothDistM !== null && fixedDistM !== null ? smoothDistM - fixedDistM : null,
      fixForwardM,
      simSpeedKmh: state.simSpeedKmh,
      smoothSpeedKmh:
        vehicle && vehicle.smooth.length > 0
          ? evalSpeedMs(vehicle.smooth, serverNowMs) * 3.6
          : null,
      phase: state.phase,
      pastHorizon: state.pastHorizon,
      horizonLeftS,
      anchorAgeS: vehicle && Number.isFinite(vehicle.anchorMs)
        ? (serverNowMs - vehicle.anchorMs) / 1000
        : null,
      emissionAgeS: vehicle && Number.isFinite(vehicle.emittedAtMs)
        ? (serverNowMs - vehicle.emittedAtMs) / 1000
        : null,
      discontinuity: vehicle?.discontinuity ?? false,
      obsDistM: snapshot.shapeDistM,
      obsAtMs: snapshot.observedAtMs,
      fixAgeS: (serverNowMs - snapshot.observedAtMs) / 1000,
      nextStopName: state.nextStopName,
      nextStopEtaS: state.nextStopEtaS,
      delaySeconds: snapshot.delaySeconds,
      statePosition: snapshot.statePosition,
      bundleAgeS: health.bundleAgeS,
      clockOffsetMs: health.clockOffsetMs,
      connection: health.connection,
      discontinuitiesTotal: health.discontinuities,
    };
  }
}
