// The server owns prediction. This seam evaluates received curves and owns one
// bounded p/v/a presentation state per displayed vehicle. Only an actual map
// frame advances it; readers and recording predictions are independent. Axis
// changes/resume use native-acknowledged hidden transitions, never a silent seek.

import type {
  RouteGeometry,
  TramModelSpec,
  TramPublicState,
  TramSnapshot,
  PhysicsDebugInfo,
} from "@/lib/types";
import {
  assessGeometryCoherence,
  type GeometryCoherence,
} from "./geometryCoherence";
import { segmentIndexAt, pointAt, bearingAt } from "@/lib/geo/polyline";
import { projectDistanceOnPolyline } from "@/lib/golemio/gtfs";
import { adaptTram, naiveDistM, NAIVE_HORIZON_S } from "./adapter";
import { evalSpeedMs, evalTrajectory, trackEndMs } from "./evaluator";
import { fixForwardTauMs } from "./fixForward";
import {
  projectObservation,
  sameGeometryAxis,
  observationCorridor,
  projectInCorridor,
} from "./observationProjection";
import {
  advancePresentation,
  presentationBrakingDistance,
  advanceTransition,
  PRESENTATION_LIMITS,
  type PresentationTransition,
  type PresentationReason,
} from "./presentation";
import {
  catchupVMsFor,
  fixForwardAppliedM,
  renderDistM,
  renderSpeedMs,
  trackFor,
  type RenderMode,
} from "./render";
import type { TrajectoryStore } from "./trajectoryStore";
import {
  advanceWorld,
  initialWorld,
  worldPosition,
  worldDelta,
  offsetPosition,
  createAlignment,
  alignmentAt,
  type WorldState,
  type WorldAlignment,
} from "./worldPresentation";

interface DisplayState {
  s: number;
  v: number;
  a: number;
  atMs: number;
  tripId: string;
  geometry: RouteGeometry | undefined;
  position: [number, number];
  bearing: number;
  comparable: boolean;
  transition: PresentationTransition | null;
  opacity: number;
  lookAtMs: number;
  lookEmissionMs: number;
  stopS: number | null;
  rebaseCount: number;
  lastWorldJumpM: number | null;
  lastRebaseAtMs: number | null;
  world: WorldState | null;
  alignment: WorldAlignment | null;
  offsetM: [number, number];
  worldSpeed: number;
}
function worldDistance(a: [number, number], b: [number, number]): number {
  return Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos(((a[1] + b[1]) * Math.PI) / 360),
    (a[1] - b[1]) * 111320,
  );
}

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
  private coherence = new Map<
    string,
    {
      fix: TramSnapshot;
      geometry: RouteGeometry | undefined;
      result: GeometryCoherence;
    }
  >();
  private models = new Map<string, TramModelSpec>();
  /**
   * Observed pace per vehicle, from consecutive AVL fixes — the input of the
   * client's NAIVE fallback (adapter.ts): when a tram has no curves at all,
   * it dead-reckons from its last fix at this speed instead of freezing.
   * Bookkeeping only (fix pairs, like the old calibration fold) — not physics.
   */
  private paces = new Map<
    string,
    {
      tripId: string;
      s: number;
      atMs: number;
      vMs: number;
      projected?: boolean;
    }
  >();
  private fallbackFixes = new Map<string, { s: number; projected: boolean }>();
  private inputAvailability = new Map<
    string,
    { fixAtMs: number; geometryAtMs: number }
  >();
  private displays = new Map<string, DisplayState>();
  private transitionSerial = 0;
  private hiddenFrameSerial = 0;
  private modeChanges = 0;
  /**
   * Teleport watch: last rendered position per vehicle (in the active render
   * mode) + the last jump that no plausible motion explains. Updated in-place
   * only for explicit displayed frames. UI/diagnostics reads do not advance it.
   * Mode switches and trip changes legitimately move the marker, so both
   * reset the tracking instead of recording a phantom teleport.
   */
  private jumps = new Map<
    string,
    {
      tripId: string;
      geometry: RouteGeometry | undefined;
      emissionMs: number;
      speedKmh: number;
      s: number;
      atMs: number;
      frameAtMs: number;
      jumpM: number;
      jumpAtMs: number;
    }
  >();
  /**
   * Profile-emission log per vehicle (devtools): which source produced each
   * adopted emission and when. The naive→ml switch lives ~1–3 s — far too
   * brief for a human watching a 10 Hz readout — so the overlay renders this
   * ring instead of the instantaneous value alone.
   */
  private profileLog = new Map<
    string,
    { lastEmittedAtMs: number; log: { source: "ml" | "naive"; atMs: number }[] }
  >();
  /**
   * ЖУРНАЛ (девтулсы): состояние переходов + кольцо событий на трамвай.
   * Живёт только для ключей, которые читают через getDiagnostics; ключи, не
   * читанные 5 минут, выметаются на ingest.
   */
  private eventLogs = new Map<
    string,
    {
      lastQueryMs: number;
      ring: { atMs: number; kind: string; text: string; warn: boolean }[];
      prevSource: PhysicsDebugInfo["renderSource"] | null;
      sourceSinceMs: number;
      prevShim: PhysicsDebugInfo["shimBranch"] | null;
      shimSinceMs: number;
      prevEmittedAtMs: number;
      prevObsAtMs: number;
      prevObsS: number;
      prevTripId: string;
      standSinceMs: number;
      standAtM: number;
      lastJumpSeenAtMs: number;
    }
  >();
  /** Render mode mirrored from the settings store by the runtime. */
  private mode: RenderMode = "smooth";

  constructor(opts: TramFleetOptions) {
    this.resolveModel = opts.resolveModel;
    this.trajectories = opts.trajectories;
  }

  /** Selected render mode (settings). Affects every getter that omits one. */
  setMode(mode: RenderMode): void {
    if (this.mode !== mode) {
      this.modeChanges++;
      this.jumps.clear();
      this.displays.clear();
    } // explicitly user-requested
    this.mode = mode;
  }

  get renderMode(): RenderMode {
    return this.mode;
  }

  /** Map cadence hook; the bounded transition state is integrated below. */
  hasPresentationTransitions(keys?: Iterable<string>): boolean {
    if (keys) {
      for (const key of keys)
        if (this.displays.get(key)?.transition) return true;
      return false;
    }
    for (const state of this.displays.values())
      if (state.transition) return true;
    return false;
  }

  acknowledgePresentationHidden(key: string, hiddenFrameId: number): void {
    const t = this.displays.get(key)?.transition;
    if (
      t &&
      t.hiddenFrameId === hiddenFrameId &&
      (t.stage === "old-zero" || t.stage === "new-zero")
    )
      t.acknowledged = true;
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
    receivedAtMs = Date.now(),
  ): void {
    const nextSnapshots = new Map<string, TramSnapshot>();
    const nextGeometries = new Map<string, RouteGeometry>();
    const nextCoherence = new Map<
      string,
      {
        fix: TramSnapshot;
        geometry: RouteGeometry | undefined;
        result: GeometryCoherence;
      }
    >();
    const nextModels = new Map<string, TramModelSpec>();
    const nextPaces = new Map<
      string,
      {
        tripId: string;
        s: number;
        atMs: number;
        vMs: number;
        projected?: boolean;
      }
    >();
    const nextFallbackFixes = new Map<
      string,
      { s: number; projected: boolean }
    >();
    for (const incoming of snapshots) {
      const prior = this.snapshots.get(incoming.key);
      const s =
        prior &&
        prior.tripId === incoming.tripId &&
        incoming.observedAtMs < prior.observedAtMs
          ? prior
          : incoming;
      nextSnapshots.set(s.key, s);
      const geometry = getGeometry(s.tripId);
      const cached = this.coherence.get(s.key);
      const old = cached?.fix;
      const unchanged =
        old &&
        cached?.geometry === geometry &&
        old.tripId === s.tripId &&
        old.observedAtMs === s.observedAtMs &&
        old.shapeDistM === s.shapeDistM &&
        old.coordinates[0] === s.coordinates[0] &&
        old.coordinates[1] === s.coordinates[1] &&
        old.lastStopId === s.lastStopId &&
        old.nextStopId === s.nextStopId &&
        old.lastStopSequence === s.lastStopSequence &&
        old.nextStopSequence === s.nextStopSequence;
      const coherence = unchanged
        ? cached.result
        : assessGeometryCoherence(s, geometry);
      const available = this.inputAvailability.get(s.key);
      this.inputAvailability.set(s.key, {
        fixAtMs: unchanged && available ? available.fixAtMs : receivedAtMs,
        geometryAtMs:
          cached?.geometry === geometry && available
            ? available.geometryAtMs
            : receivedAtMs,
      });
      nextCoherence.set(s.key, { fix: s, geometry, result: coherence });
      if (geometry && coherence.status !== "invalid")
        nextGeometries.set(s.key, geometry);
      const displayed = this.jumps.get(s.key);
      if (
        displayed?.geometry &&
        geometry &&
        displayed.tripId === s.tripId &&
        coherence.status !== "invalid" &&
        displayed.geometry !== geometry &&
        sameGeometryAxis(displayed.geometry, geometry)
      ) {
        // Cache/timetable replacement is not a new coordinate axis. Preserve
        // position and velocity; object identity alone cannot license a jump.
        displayed.geometry = geometry;
      }
      const priorFallback = this.fallbackFixes.get(s.key);
      const reuseProjection =
        unchanged &&
        old?.lastStopSequence === s.lastStopSequence &&
        old?.nextStopSequence === s.nextStopSequence &&
        priorFallback;
      const projection = reuseProjection
        ? null
        : coherence.status !== "invalid"
          ? projectObservation(s, geometry)
          : null;
      const fallback = reuseProjection || {
        s: projection?.s ?? s.shapeDistM,
        projected: projection !== null,
      };
      nextFallbackFixes.set(s.key, fallback);
      const known = this.models.get(s.key);
      nextModels.set(s.key, known ?? this.resolveModel(s));
      // Fold the fix pair into the observed pace. A trip change moves the
      // s-axis under the pair, so it resets rather than producing a garbage Δ.
      const prevPace = this.paces.get(s.key);
      if (
        !prevPace ||
        prevPace.tripId !== s.tripId ||
        !!prevPace.projected !== fallback.projected ||
        coherence.status === "invalid" ||
        cached?.result.status === "invalid"
      ) {
        nextPaces.set(s.key, {
          tripId: s.tripId,
          s: fallback.s,
          atMs: s.observedAtMs,
          vMs: 0,
          projected: fallback.projected,
        });
      } else if (s.observedAtMs > prevPace.atMs) {
        const dtS = (s.observedAtMs - prevPace.atMs) / 1000;
        const dsM = fallback.s - prevPace.s;
        if (dtS < 4 && dsM >= 0) {
          // Accumulate short fix intervals: replacing the baseline every 2 s
          // while requiring dt>=4 meant a fresh high-rate feed never learned
          // any pace and no-curve trams stayed frozen forever.
          nextPaces.set(s.key, prevPace);
        } else {
          const vMs =
            dtS <= 300 && dsM >= 0 && !(fallback.projected && dsM < 1.5)
              ? Math.min(16.7, dsM / dtS)
              : 0;
          nextPaces.set(s.key, {
            tripId: s.tripId,
            s: fallback.s,
            atMs: s.observedAtMs,
            vMs,
            projected: fallback.projected,
          });
        }
      } else {
        nextPaces.set(s.key, prevPace);
      }
    }
    this.snapshots = nextSnapshots;
    this.geometries = nextGeometries;
    this.coherence = nextCoherence;
    this.models = nextModels;
    this.paces = nextPaces;
    this.fallbackFixes = nextFallbackFixes;
    for (const key of this.inputAvailability.keys())
      if (!nextSnapshots.has(key)) this.inputAvailability.delete(key);
    for (const key of this.jumps.keys()) {
      if (!nextSnapshots.has(key)) this.jumps.delete(key); // departed vehicles
    }
    for (const key of this.displays.keys())
      if (!nextSnapshots.has(key)) this.displays.delete(key);
    for (const key of this.profileLog.keys()) {
      if (!nextSnapshots.has(key)) this.profileLog.delete(key);
    }
    const staleLogMs = Date.now() - 5 * 60_000;
    for (const [key, log] of this.eventLogs) {
      if (!nextSnapshots.has(key) || log.lastQueryMs < staleLogMs)
        this.eventLogs.delete(key);
    }
  }

  /** Trip geometry currently driving a tram's rendering. */
  getGeometry(key: string): RouteGeometry | undefined {
    if (this.mode === "smooth" && this.displays.has(key))
      return this.displays.get(key)!.geometry;
    return this.geometries.get(key);
  }

  /** Raw snapshot for a key (identity/AVL context without building a state). */
  getSnapshot(key: string): TramSnapshot | undefined {
    return this.snapshots.get(key);
  }

  /** Current source geometry, independent of an outgoing displayed axis. */
  getPredictionGeometry(key: string): RouteGeometry | undefined {
    return this.geometries.get(key);
  }

  /** Pure source prediction for recording while the map is hidden. A record
   * timestamp must never be paired with an old, no-longer-visible frame. */
  getPredictionState(
    key: string,
    localNowMs = Date.now(),
    mode: RenderMode = this.mode,
  ): TramPublicState | undefined {
    const snapshot = this.snapshots.get(key);
    return snapshot
      ? this.prediction(
          snapshot,
          this.trajectories.nowMs(localNowMs),
          mode,
          localNowMs,
        )
      : undefined;
  }

  getPredictionStates(
    localNowMs = Date.now(),
    mode: RenderMode = this.mode,
  ): TramPublicState[] {
    const serverNow = this.trajectories.nowMs(localNowMs);
    const out: TramPublicState[] = [];
    for (const snapshot of this.snapshots.values())
      out.push(this.prediction(snapshot, serverNow, mode, localNowMs));
    return out;
  }

  private prediction(
    snapshot: TramSnapshot,
    serverNowMs: number,
    mode: RenderMode,
    localNowMs: number,
  ) {
    const vehicle = this.vehicleFor(snapshot);
    const state = adaptTram({
      snapshot,
      model: this.models.get(snapshot.key) ?? this.resolveModel(snapshot),
      geometry: this.geometries.get(snapshot.key),
      vehicle,
      serverNowMs,
      clockTrusted: this.trajectories.clock.synced,
      mode,
      observedPaceMs: this.paces.get(snapshot.key)?.vMs ?? 0,
      fallbackFixDistM: this.fallbackFixes.get(snapshot.key)?.s,
    });
    const inputs = this.inputAvailability.get(snapshot.key);
    const receipt = this.trajectories.getVehicleReceivedAtMs(snapshot.key);
    const needsFix =
      !vehicle || mode !== "smooth" || vehicle.motionPolicy !== "continuous-v1";
    state.predictionEvaluatedAtMs = localNowMs;
    state.predictionInputsAvailableAtMs =
      inputs && (!vehicle || Number.isFinite(receipt))
        ? Math.max(
            this.trajectories.clock.inputsAvailableAtMs,
            inputs.geometryAtMs,
            needsFix ? inputs.fixAtMs : -Infinity,
            vehicle ? receipt! : -Infinity,
          )
        : null;
    return state;
  }

  /**
   * One tram's public state at `localNowMs` (device clock in, server-corrected
   * inside). Undefined when the key is not in the live fleet.
   */
  getState(
    key: string,
    localNowMs: number = Date.now(),
    mode: RenderMode = this.mode,
    recordFrame = false,
  ): TramPublicState | undefined {
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return undefined;
    return this.build(
      snapshot,
      this.trajectories.nowMs(localNowMs),
      mode,
      recordFrame,
      localNowMs,
    );
  }

  /** The whole fleet. Only Mapbox/bench frame producers pass recordFrame=true;
   * UI, calibration and future probes keep the default read-only behavior. */
  getStates(
    localNowMs: number = Date.now(),
    mode: RenderMode = this.mode,
    recordFrame = false,
  ): TramPublicState[] {
    const serverNow = this.trajectories.nowMs(localNowMs);
    const out: TramPublicState[] = [];
    for (const snapshot of this.snapshots.values()) {
      out.push(this.build(snapshot, serverNow, mode, recordFrame, localNowMs));
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
        const displayed =
          mode === this.mode && mode === "smooth"
            ? this.displays.get(key)
            : undefined;
        if (displayed) {
          const c = displayed.position;
          if (
            c[0] >= bbox[0] &&
            c[0] <= bbox[2] &&
            c[1] >= bbox[1] &&
            c[1] <= bbox[3]
          ) {
            out.push(this.build(snapshot, serverNow, mode, true, localNowMs));
            continue;
          }
        }
        const geometry = this.geometries.get(key);
        if (geometry) {
          const vehicle = this.vehicleFor(snapshot);
          // Same fix-forward composition the adapter renders with — culling on
          // the raw curve would test a position up to hundreds of meters away
          // from the marker (fixForward.ts) and pop trams at the bbox edge.
          const target = vehicle
            ? renderDistM(
                vehicle,
                serverNow,
                mode,
                snapshot.shapeDistM,
                snapshot.observedAtMs,
              )
            : naiveDistM(
                this.fallbackFixes.get(key)?.s ?? snapshot.shapeDistM,
                snapshot.observedAtMs,
                serverNow,
                this.paces.get(key)?.vMs ?? 0,
              );
          const d = displayed
            ? target
            : this.guardedDistance(snapshot, mode, localNowMs, target);
          if (!distInBbox(geometry, d, bbox)) continue;
        } else {
          const c = snapshot.coordinates;
          if (
            c[0] < bbox[0] ||
            c[0] > bbox[2] ||
            c[1] < bbox[1] ||
            c[1] > bbox[3]
          )
            continue;
        }
      }
      out.push(this.build(snapshot, serverNow, mode, true, localNowMs));
    }
    return out;
  }

  /** Curves for a snapshot, or undefined when none apply to its current trip. */
  private vehicleFor(snapshot: TramSnapshot) {
    if (this.coherence.get(snapshot.key)?.result.status === "invalid")
      return undefined;
    const v = this.trajectories.getVehicle(snapshot.key);
    return v !== undefined && v.tripId === snapshot.tripId ? v : undefined;
  }

  /** Culling follows the committed world position, even while an old axis is
   * fading out. It must never advance presentation just to test visibility. */
  private guardedDistance(
    snapshot: TramSnapshot,
    mode: RenderMode,
    _nowMs: number,
    target: number,
  ): number {
    const p =
      mode === this.mode && mode === "smooth"
        ? this.displays.get(snapshot.key)
        : undefined;
    return p?.comparable ? p.s : target;
  }

  private axisDirection(geometry: RouteGeometry, s: number): [number, number] {
    const i = Math.min(
      geometry.coordinates.length - 2,
      segmentIndexAt(geometry.cumDistM, s),
    );
    const d = worldDelta(
      geometry.coordinates[Math.max(0, i)],
      geometry.coordinates[Math.max(0, i) + 1],
    );
    const n =
      geometry.cumDistM[Math.max(0, i) + 1] - geometry.cumDistM[Math.max(0, i)];
    // Derivative of pointAt in the same world-meter convention as raw PVA.
    // Normalizing this vector would introduce a velocity step at adoption.
    return n > 0 ? [d[0] / n, d[1] / n] : [0, 0];
  }

  private present(
    snapshot: TramSnapshot,
    now: number,
    serverNow: number,
    target: number,
    targetSpeedKmh: number,
    record: boolean,
  ): DisplayState {
    const geometry = this.geometries.get(snapshot.key);
    const vehicle = this.vehicleFor(snapshot);
    const position = () =>
      geometry
        ? pointAt(geometry.coordinates, geometry.cumDistM, target)
        : ([...snapshot.coordinates] as [number, number]);
    const velocity = Math.max(
      0,
      Math.min(PRESENTATION_LIMITS.speed, targetSpeedKmh / 3.6),
    );
    const existing = this.displays.get(snapshot.key);
    if (!existing) {
      const p: DisplayState = {
        s: target,
        v: geometry ? velocity : 0,
        a: 0,
        atMs: now,
        tripId: snapshot.tripId,
        geometry,
        position: position(),
        bearing: geometry
          ? bearingAt(geometry.coordinates, geometry.cumDistM, target)
          : (snapshot.bearing ?? 0),
        comparable: !!geometry,
        transition: null,
        opacity: 1,
        lookAtMs: -Infinity,
        lookEmissionMs: -1,
        stopS: null,
        rebaseCount: 0,
        lastWorldJumpM: null,
        lastRebaseAtMs: null,
        world: geometry ? null : initialWorld(snapshot.coordinates),
        alignment: null,
        offsetM: [0, 0],
        worldSpeed: geometry ? velocity : 0,
      };
      if (record) this.displays.set(snapshot.key, p);
      return p;
    }
    // Read-only UI/future probes may preview kinematics on the same axis, but
    // cannot discover/consume transitions, acknowledgements or geometry changes.
    const p = record
      ? existing
      : { ...existing, world: existing.world ? { ...existing.world } : null };
    const dt = (now - p.atMs) / 1000;
    if (dt <= 0) return p;
    let forced: PresentationReason | null =
      p.tripId !== snapshot.tripId
        ? "trip-change"
        : dt > 5
          ? "resume-gap"
          : null;
    if (p.tripId === snapshot.tripId && p.geometry !== geometry) {
      if (p.geometry && geometry && sameGeometryAxis(p.geometry, geometry)) {
        p.geometry = geometry;
      } else if (record && geometry && !p.transition && !forced) {
        const corridor = observationCorridor(snapshot, geometry);
        const projection = corridor
          ? projectInCorridor(p.position, geometry, corridor, 10)
          : null;
        let adopted = false;
        if (projection) {
          const base = pointAt(
            geometry.coordinates,
            geometry.cumDistM,
            projection.s,
          );
          const newDirection = this.axisDirection(geometry, projection.s);
          const oldDirection = p.geometry
            ? this.axisDirection(p.geometry, p.s)
            : [0, 0];
          const residual = p.alignment
            ? alignmentAt(p.alignment, p.atMs)
            : null;
          const worldV = p.world
            ? [p.world.vx, p.world.vy]
            : [
                oldDirection[0] * p.v + (residual?.velocity[0] ?? 0),
                oldDirection[1] * p.v + (residual?.velocity[1] ?? 0),
              ];
          const worldA = p.world
            ? [p.world.ax, p.world.ay]
            : [
                oldDirection[0] * p.a + (residual?.acceleration[0] ?? 0),
                oldDirection[1] * p.a + (residual?.acceleration[1] ?? 0),
              ];
          const scale = Math.hypot(...newDirection);
          const scale2 = scale * scale;
          const v =
            (worldV[0] * newDirection[0] + worldV[1] * newDirection[1]) /
            scale2;
          const a =
            (worldA[0] * newDirection[0] + worldA[1] * newDirection[1]) /
            scale2;
          const alignment = createAlignment(
            worldDelta(base, p.position),
            [worldV[0] - newDirection[0] * v, worldV[1] - newDirection[1] * v],
            [worldA[0] - newDirection[0] * a, worldA[1] - newDirection[1] * a],
            v * scale,
            a * scale,
            p.atMs,
          );
          if (alignment) {
            alignment.limits = {
              speed: alignment.limits.speed / scale,
              acceleration: alignment.limits.acceleration / scale,
              braking: alignment.limits.braking / scale,
              jerk: alignment.limits.jerk / scale,
            };
            if (
              presentationBrakingDistance(
                v,
                a,
                alignment.limits.braking,
                alignment.limits.jerk,
              ) >
              geometry.totalM - projection.s
            ) {
              // A geometrically close projection is not kinematically compatible
              // when the endpoint would clamp a still-moving world pose.
              forced = "incompatible-geometry";
            } else {
              p.s = projection.s;
              p.v = v;
              p.a = a;
              p.geometry = geometry;
              p.world = null;
              p.alignment = alignment;
              p.lookAtMs = -Infinity;
              adopted = true;
            }
          }
        }
        if (!adopted) forced = "incompatible-geometry";
      } else if (!forced) forced = "incompatible-geometry";
    }
    p.comparable =
      !!geometry && p.tripId === snapshot.tripId && p.geometry === geometry;
    if (forced && (!p.transition || p.transition.stage === "in") && record)
      p.transition = {
        id: ++this.transitionSerial,
        reason: forced,
        stage: "out",
        atMs: now,
        hiddenFrameId: undefined,
        acknowledged: false,
        startOpacity: p.opacity,
      };
    if (
      (p.tripId !== snapshot.tripId || p.geometry !== geometry) &&
      p.transition?.stage === "new-zero" &&
      record
    ) {
      // Another identity/axis arrived while the rebased frame was still hidden.
      // Keep it hidden and require acceptance of a fresh zero token; an older
      // in-flight acknowledgement cannot reveal this replacement geometry.
      const nextPosition = position();
      p.lastWorldJumpM = worldDistance(p.position, nextPosition);
      p.lastRebaseAtMs = now;
      p.rebaseCount++;
      p.s = target;
      p.v = velocity;
      p.a = 0;
      p.position = nextPosition;
      p.tripId = snapshot.tripId;
      p.geometry = geometry;
      p.world = geometry ? null : initialWorld(nextPosition);
      p.alignment = null;
      p.offsetM = [0, 0];
      p.comparable = !!geometry;
      p.lookAtMs = -Infinity;
      p.transition.hiddenFrameId = ++this.hiddenFrameSerial;
      p.transition.acknowledged = false;
    }
    let rebase = false;
    if (p.transition) {
      if (!record) return p;
      const phase = advanceTransition(
        p.transition,
        now,
        () => ++this.hiddenFrameSerial,
      );
      p.opacity = phase.opacity;
      rebase = phase.rebase;
      if (rebase) {
        const nextPosition = position();
        p.lastWorldJumpM = worldDistance(p.position, nextPosition);
        p.lastRebaseAtMs = now;
        p.rebaseCount++;
        p.s = target;
        p.v = velocity;
        p.a = 0;
        p.position = nextPosition;
        p.tripId = snapshot.tripId;
        p.geometry = geometry;
        p.world = geometry ? null : initialWorld(nextPosition);
        p.alignment = null;
        p.offsetM = [0, 0];
        p.comparable = !!geometry;
        p.lookAtMs = -Infinity;
      }
      if (phase.done) p.transition = null;
    }
    const sample = (at: number) =>
      vehicle
        ? renderDistM(
            vehicle,
            at,
            "smooth",
            snapshot.shapeDistM,
            snapshot.observedAtMs,
          )
        : naiveDistM(
            this.fallbackFixes.get(snapshot.key)?.s ?? snapshot.shapeDistM,
            snapshot.observedAtMs,
            at,
            this.paces.get(snapshot.key)?.vMs ?? 0,
          );
    if (
      p.comparable &&
      !rebase &&
      dt <= 5 &&
      (!p.transition || p.transition.stage === "in")
    ) {
      if (
        now - p.lookAtMs >= 1000 ||
        p.lookEmissionMs !== (vehicle?.emittedAtMs ?? 0)
      ) {
        p.lookAtMs = now;
        p.lookEmissionMs = vehicle?.emittedAtMs ?? 0;
        p.stopS = geometry?.totalM ?? null;
        let before = target;
        for (let second = 1; second <= 16; second++) {
          const next = sample(serverNow + second * 1000);
          if (Math.abs(next - before) < 0.03) {
            p.stopS = Math.min(p.stopS ?? Infinity, next);
            break;
          }
          before = next;
        }
      }
      const acceleration = vehicle
        ? (renderSpeedMs(
            vehicle,
            serverNow + 500,
            "smooth",
            snapshot.shapeDistM,
            snapshot.observedAtMs,
          ) -
            velocity) *
          2
        : 0;
      advancePresentation(
        p,
        dt,
        target,
        velocity,
        acceleration,
        p.stopS,
        p.alignment?.limits,
      );
    } else if (dt <= 5 && p.transition?.stage === "out" && p.geometry) {
      // Keep the outgoing model moving continuously during its short fade.
      // It must not suddenly stop at full opacity merely because its axis changed.
      advancePresentation(p, dt, p.s + p.v * dt, p.v, 0, p.geometry.totalM);
    }
    // A background interval is not an evaluated alignment interval. Freeze the
    // residual at the last visible pose while its outgoing fade begins.
    if (dt > 5 && p.alignment)
      p.alignment = { ...p.alignment, atMs: p.alignment.atMs + dt * 1000 };
    p.atMs = now;
    if (
      p.geometry &&
      (!p.transition ||
        p.transition.stage === "in" ||
        p.transition.stage === "out" ||
        rebase)
    ) {
      const base = pointAt(p.geometry.coordinates, p.geometry.cumDistM, p.s);
      const residual = p.alignment ? alignmentAt(p.alignment, now) : null;
      p.offsetM = residual?.offset ?? [0, 0];
      p.position = offsetPosition(base, p.offsetM);
      const direction = this.axisDirection(p.geometry, p.s);
      p.worldSpeed = Math.hypot(
        direction[0] * p.v + (residual?.velocity[0] ?? 0),
        direction[1] * p.v + (residual?.velocity[1] ?? 0),
      );
      p.bearing = bearingAt(p.geometry.coordinates, p.geometry.cumDistM, p.s);
      if (residual?.done) p.alignment = null;
    } else if (
      !p.geometry &&
      (!p.transition ||
        p.transition.stage === "in" ||
        p.transition.stage === "out")
    ) {
      p.world ??= initialWorld(p.position);
      if (!rebase)
        advanceWorld(
          p.world,
          p.transition?.stage === "out" ? p.position : snapshot.coordinates,
          dt,
        );
      p.position = worldPosition(p.world);
      p.v = p.worldSpeed = Math.hypot(p.world.vx, p.world.vy);
      p.a =
        p.v > 0.01
          ? (p.world.vx * p.world.ax + p.world.vy * p.world.ay) / p.v
          : 0;
      p.s = snapshot.shapeDistM;
      p.offsetM = [0, 0];
      if (p.v > 0.1)
        p.bearing =
          ((Math.atan2(p.world.vx, p.world.vy) * 180) / Math.PI + 360) % 360;
    }
    return p;
  }

  private build(
    snapshot: TramSnapshot,
    serverNowMs: number,
    mode: RenderMode,
    recordFrame = false,
    localNowMs = serverNowMs,
  ) {
    const vehicle = this.vehicleFor(snapshot);
    let display: DisplayState | undefined;
    const state = adaptTram({
      snapshot,
      model: this.models.get(snapshot.key) ?? this.resolveModel(snapshot),
      geometry: this.geometries.get(snapshot.key),
      vehicle,
      serverNowMs,
      clockTrusted: this.trajectories.clock.synced,
      presentationNowMs: localNowMs,
      mode,
      observedPaceMs: this.paces.get(snapshot.key)?.vMs ?? 0,
      fallbackFixDistM: this.fallbackFixes.get(snapshot.key)?.s,
      present:
        mode === this.mode && mode === "smooth"
          ? (s, v) => {
              display = this.present(
                snapshot,
                localNowMs,
                serverNowMs,
                s,
                v,
                recordFrame,
              );
              return {
                s: display.s,
                v: display.v,
                position: display.position,
                bearing: display.bearing,
                comparable: display.comparable,
              };
            }
          : undefined,
    });
    // Teleport watch — active render mode only, so a diagnostics read in the
    // other mode cannot record a phantom jump.
    if (recordFrame && mode === this.mode)
      this.watchJump(
        snapshot,
        state.simDistM,
        state.simSpeedKmh,
        serverNowMs,
        localNowMs,
        false,
      );
    if (display) {
      state.presentationOpacity = display.opacity;
      state.presentationOffsetM = display.offsetM;
      state.presentationTransitionId = display.transition?.id;
      state.presentationHiddenFrameId = display.transition?.hiddenFrameId;
      state.presentationTransitionReason = display.transition?.reason ?? null;
      state.presentationCorrectionComparable = display.comparable;
      state.presentationCorrectionM = display.comparable
        ? state.renderTargetDistM - display.s
        : null;
      if (!display.comparable) {
        state.phase = "unknown";
        state.nextStopEtaS = null;
      }
    }
    // Profile-emission log: one entry per adopted emission (emittedAtMs edge).
    if (vehicle && Number.isFinite(vehicle.emittedAtMs)) {
      const entry = this.profileLog.get(snapshot.key);
      if (!entry) {
        this.profileLog.set(snapshot.key, {
          lastEmittedAtMs: vehicle.emittedAtMs,
          log: [{ source: vehicle.source ?? "ml", atMs: vehicle.emittedAtMs }],
        });
      } else if (entry.lastEmittedAtMs !== vehicle.emittedAtMs) {
        entry.lastEmittedAtMs = vehicle.emittedAtMs;
        entry.log.push({
          source: vehicle.source ?? "ml",
          atMs: vehicle.emittedAtMs,
        });
        if (entry.log.length > 5) entry.log.shift();
      }
    }
    return state;
  }

  /**
   * Record a frame-over-frame displacement no plausible motion explains.
   * Forward allowance: 20 m/s (above V_MAX pace) plus 25 m of slack for the
   * licensed fixed-mode re-anchor jitter; backward allowance 10 m (rendering
   * is monotone by construction — anything bigger IS the backward-teleport
   * bug class). Gaps over 5 s (background, culled stretch) reset instead of
   * judging — across a long gap any displacement is legitimate motion.
   */
  private watchJump(
    snapshot: TramSnapshot,
    s: number,
    speedKmh: number,
    atMs: number,
    frameAtMs: number,
    allowJump = false,
  ): void {
    const j = this.jumps.get(snapshot.key);
    const geometry = this.geometries.get(snapshot.key);
    const emissionMs = this.vehicleFor(snapshot)?.emittedAtMs ?? 0;
    if (!j || j.tripId !== snapshot.tripId || j.geometry !== geometry) {
      this.jumps.set(snapshot.key, {
        tripId: snapshot.tripId,
        geometry,
        emissionMs,
        speedKmh,
        s,
        atMs,
        frameAtMs,
        jumpM: 0,
        jumpAtMs: 0,
      });
      return;
    }
    j.emissionMs = emissionMs;
    j.speedKmh = speedKmh;
    if (allowJump) {
      // Sanctioned discontinuity: rebase without judging (amnesty).
      j.s = s;
      j.atMs = atMs;
      j.frameAtMs = frameAtMs;
      return;
    }
    const dtMs = frameAtMs - j.frameAtMs;
    if (dtMs <= 0) return; // same or out-of-order instant — nothing to judge
    if (dtMs <= 5_000) {
      const ds = s - j.s;
      if (ds > 25 + 0.02 * dtMs || ds < -10) {
        j.jumpM = ds;
        j.jumpAtMs = atMs;
      }
    }
    j.s = s;
    j.atMs = atMs;
    j.frameAtMs = frameAtMs;
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
    const state = this.build(snapshot, serverNowMs, mode, false, localNowMs);
    const health = this.trajectories.health(localNowMs);

    let smoothDistM: number | null = null;
    let fixedDistM: number | null = null;
    let horizonLeftS: number | null = null;
    let effectiveHorizonLeftS: number | null = null;
    let fixForwardM: number | null = null;
    // — the shim's own state, read off the RENDERED track (devtools truth) —
    let shimBranch: PhysicsDebugInfo["shimBranch"] = "off";
    let tauS: number | null = null;
    let fixVsCurveM: number | null = null;
    let walkRemainingM: number | null = null;
    if (vehicle) {
      // The two curves RAW — deviationM and the smooth-vs-fixed comparison are
      // about what the server published, so the shim stays out of them.
      if (vehicle.smooth.length > 0)
        smoothDistM = evalTrajectory(vehicle.smooth, serverNowMs);
      if (vehicle.opinion.length > 0)
        fixedDistM = evalTrajectory(vehicle.opinion, serverNowMs);
      const track = trackFor(vehicle, mode);
      const shimFixS =
        mode === "smooth" && vehicle.motionPolicy === "continuous-v1"
          ? Number.NaN
          : snapshot.shapeDistM;
      horizonLeftS = (trackEndMs(track) - serverNowMs) / 1000;
      effectiveHorizonLeftS =
        horizonLeftS -
        fixForwardTauMs(
          track,
          shimFixS,
          snapshot.observedAtMs,
          vehicle.anchorMs,
        ) /
          1000;
      // …and the meters the shim is currently adding on top, which is the one
      // number that says "the served curve is this far behind the newest fix".
      // Reading it in the field is how a complaint becomes a measurement.
      fixForwardM = fixForwardAppliedM(
        track,
        serverNowMs,
        catchupVMsFor(mode),
        shimFixS,
        snapshot.observedAtMs,
        vehicle.anchorMs,
      );
      // Which branch of fixForward.ts is deciding this marker right now, and
      // the raw gap it is closing — the numbers that separate «кривая отстала»
      // from «фикс обогнал всю кривую» from «шим спит» at a glance.
      const fixS = shimFixS;
      const fixAtMs = snapshot.observedAtMs;
      const newerFix =
        !Number.isFinite(vehicle.anchorMs) || fixAtMs > vehicle.anchorMs;
      if (track.length > 0 && newerFix && Number.isFinite(fixS)) {
        fixVsCurveM = fixS - evalTrajectory(track, fixAtMs);
        const tau = fixForwardTauMs(track, fixS, fixAtMs, vehicle.anchorMs);
        if (tau === 0) {
          shimBranch = fixVsCurveM <= 0 ? "ahead" : "off";
        } else if (tau === Number.POSITIVE_INFINITY) {
          shimBranch = "walk";
          tauS = Number.POSITIVE_INFINITY;
          walkRemainingM = Math.max(0, fixS - state.simDistM);
        } else {
          shimBranch = "wind";
          tauS = tau / 1000;
        }
      }
    }

    // What is actually driving the marker (see PhysicsDebugInfo.renderSource).
    const observedPaceMs = this.paces.get(key)?.vMs ?? 0;
    const fixAheadS = (serverNowMs - snapshot.observedAtMs) / 1000;
    const renderSource: PhysicsDebugInfo["renderSource"] = vehicle
      ? vehicle.source === "naive"
        ? "curve-naive"
        : "curve-ml"
      : observedPaceMs > 0 && state.hasGeometry && fixAheadS < NAIVE_HORIZON_S
        ? "client-naive"
        : "raw-fix";

    const jump = this.jumps.get(key);
    const hasJump = jump !== undefined && jump.jumpAtMs > 0;
    const geometry = this.geometries.get(key);
    const fixCoordVsAxisM = geometry
      ? projectDistanceOnPolyline(
          [snapshot.coordinates[0], snapshot.coordinates[1]],
          geometry.coordinates,
          geometry.cumDistM,
        ) - snapshot.shapeDistM
      : null;
    const profileLog = this.profileLog.get(key)?.log ?? [];
    const profileHistory = profileLog
      .map((e) => ({ source: e.source, ageS: (serverNowMs - e.atMs) / 1000 }))
      .reverse();

    // ── ЖУРНАЛ: переходы состояний с длительностями (только для читаемых) ──
    let elog = this.eventLogs.get(key);
    if (!elog) {
      elog = {
        lastQueryMs: 0,
        ring: [],
        prevSource: renderSource,
        sourceSinceMs: serverNowMs,
        prevShim: shimBranch,
        shimSinceMs: serverNowMs,
        prevEmittedAtMs: vehicle?.emittedAtMs ?? 0,
        prevObsAtMs: snapshot.observedAtMs,
        prevObsS: snapshot.shapeDistM,
        prevTripId: snapshot.tripId,
        standSinceMs: 0,
        standAtM: 0,
        lastJumpSeenAtMs: 0,
      };
      this.eventLogs.set(key, elog);
    }
    elog.lastQueryMs = Date.now();
    const push = (kind: string, text: string, warn = false): void => {
      elog!.ring.push({ atMs: serverNowMs, kind, text, warn });
      if (elog!.ring.length > 40) elog!.ring.shift();
    };
    const SRC_RU: Record<PhysicsDebugInfo["renderSource"], string> = {
      "curve-ml": "ML-профиль",
      "curve-naive": "наивный профиль",
      "client-naive": "клиентская протяжка",
      "raw-fix": "замер на фиксе",
    };
    const SHIM_RU: Record<PhysicsDebugInfo["shimBranch"], string> = {
      off: "спит",
      ahead: "профиль⩾фикса",
      wind: "промотка",
      walk: "ФИКС ЗА ГОРИЗОНТОМ",
    };
    // Телепорт (jump-watch зафиксировал новый скачок).
    if (hasJump && jump.jumpAtMs !== elog.lastJumpSeenAtMs) {
      elog.lastJumpSeenAtMs = jump.jumpAtMs;
      push(
        "ТЕЛЕПОРТ",
        `${jump.jumpM >= 0 ? "+" : ""}${jump.jumpM.toFixed(0)}м (поправка: ${SHIM_RU[shimBranch]}, ехал по: ${SRC_RU[renderSource]})`,
        true,
      );
    }
    // Смена рейса.
    if (snapshot.tripId !== elog.prevTripId) {
      push(
        "рейс",
        `новый рейс (${elog.prevTripId.slice(0, 12)}… → ${snapshot.tripId.slice(0, 12)}…)`,
      );
      elog.prevTripId = snapshot.tripId;
    }
    // Пересчёт прогноза (принята новая эмиссия).
    if (
      vehicle &&
      Number.isFinite(vehicle.emittedAtMs) &&
      vehicle.emittedAtMs !== elog.prevEmittedAtMs
    ) {
      elog.prevEmittedAtMs = vehicle.emittedAtMs;
      const anchorAge = Number.isFinite(vehicle.anchorMs)
        ? ((serverNowMs - vehicle.anchorMs) / 1000).toFixed(0)
        : "?";
      push(
        "пересчёт",
        `${vehicle.source === "naive" ? "наивный" : "ml"} · опоре ${anchorAge}с${vehicle.discontinuity ? " · СКАЧОК РАЗРЕШЁН" : ""}`,
        vehicle.discontinuity,
      );
    }
    // Новый фикс: сдвиг по оси + лаг доставки.
    if (snapshot.observedAtMs !== elog.prevObsAtMs) {
      const dS = snapshot.shapeDistM - elog.prevObsS;
      const lagS = ((serverNowMs - snapshot.observedAtMs) / 1000).toFixed(0);
      push(
        "фикс",
        `${dS >= 0 ? "+" : ""}${dS.toFixed(0)}м по оси · лаг ${lagS}с${fixCoordVsAxisM != null && Math.abs(fixCoordVsAxisM) > 30 ? ` · коорд−ось ${fixCoordVsAxisM >= 0 ? "+" : ""}${fixCoordVsAxisM.toFixed(0)}м` : ""}`,
        fixCoordVsAxisM != null && Math.abs(fixCoordVsAxisM) > 60,
      );
      elog.prevObsAtMs = snapshot.observedAtMs;
      elog.prevObsS = snapshot.shapeDistM;
    }
    // Смена источника движения (с длительностью прежнего).
    if (renderSource !== elog.prevSource) {
      const durS = ((serverNowMs - elog.sourceSinceMs) / 1000).toFixed(1);
      push(
        "источник",
        `${SRC_RU[elog.prevSource ?? renderSource]} → ${SRC_RU[renderSource]} (было ${durS}с)`,
        renderSource !== "curve-ml",
      );
      elog.prevSource = renderSource;
      elog.sourceSinceMs = serverNowMs;
    }
    // Смена режима поправки (сколько длился прежний — в т.ч. walk-эпизоды).
    if (shimBranch !== elog.prevShim) {
      const durS = ((serverNowMs - elog.shimSinceMs) / 1000).toFixed(1);
      push(
        "поправка",
        `${SHIM_RU[elog.prevShim ?? shimBranch]} → ${SHIM_RU[shimBranch]} (${SHIM_RU[elog.prevShim ?? shimBranch]} длился ${durS}с)`,
        shimBranch === "walk" || elog.prevShim === "walk",
      );
      elog.prevShim = shimBranch;
      elog.shimSinceMs = serverNowMs;
    }
    // Стоянки: событие на ОКОНЧАНИИ (сколько простоял и где).
    const standingNow = state.simSpeedKmh <= 1;
    if (standingNow && elog.standSinceMs === 0) {
      elog.standSinceMs = serverNowMs;
      elog.standAtM = state.simDistM;
    } else if (!standingNow && elog.standSinceMs > 0) {
      const durS = (serverNowMs - elog.standSinceMs) / 1000;
      if (durS >= 3) {
        let nearest = Infinity;
        let nearestName = "";
        for (const st of geometry?.stops ?? []) {
          const d = Math.abs(st.distM - elog.standAtM);
          if (d < nearest) {
            nearest = d;
            nearestName = st.name;
          }
        }
        const where =
          nearest <= 40
            ? `у ${nearestName}`
            : `посреди перегона (${nearest.toFixed(0)}м от остановки)`;
        push(
          "стоянка",
          `стоял ${durS.toFixed(0)}с ${where}`,
          nearest > 40 && durS >= 10,
        );
      }
      elog.standSinceMs = 0;
    }
    const events = elog.ring
      .slice(-30)
      .reverse()
      .map((e) => ({ ...e, ageS: (serverNowMs - e.atMs) / 1000 }));

    return {
      events,
      motionPolicy: vehicle ? (vehicle.motionPolicy ?? "legacy") : null,
      presentationModeChanges: this.modeChanges,
      presentationRebaseCount: this.displays.get(key)?.rebaseCount ?? 0,
      presentationLastWorldJumpM:
        this.displays.get(key)?.lastWorldJumpM ?? null,
      presentationLastRebaseAtMs:
        this.displays.get(key)?.lastRebaseAtMs ?? null,
      presentationAccelerationMs2: this.displays.get(key)?.a ?? null,
      profileHistory,
      fixCoordVsAxisM,
      geometryCoherence: this.coherence.get(key)?.result.status ?? "unknown",
      geometryCoherenceReason: this.coherence.get(key)?.result.reason ?? null,
      geometryAxisCoordinateErrorM:
        this.coherence.get(key)?.result.axisCoordinateErrorM ?? null,
      hasTrajectory: vehicle !== undefined,
      hasGeometry: state.hasGeometry,
      mode,
      renderSource,
      lastJumpM: hasJump ? jump.jumpM : null,
      lastJumpAgoS: hasJump ? (serverNowMs - jump.jumpAtMs) / 1000 : null,
      anchorFixS:
        vehicle && Number.isFinite(vehicle.anchorS) ? vehicle.anchorS : null,
      anchorLagS:
        vehicle && Number.isFinite(vehicle.anchorMs)
          ? (snapshot.observedAtMs - vehicle.anchorMs) / 1000
          : null,
      observedPaceMs,
      shimBranch,
      tauS,
      fixVsCurveM,
      walkRemainingM,
      simDistM: state.simDistM,
      smoothDistM,
      fixedDistM,
      deltaM:
        smoothDistM !== null && fixedDistM !== null
          ? smoothDistM - fixedDistM
          : null,
      fixForwardM,
      simSpeedKmh: state.simSpeedKmh,
      smoothSpeedKmh:
        vehicle && vehicle.smooth.length > 0
          ? evalSpeedMs(vehicle.smooth, serverNowMs) * 3.6
          : null,
      phase: state.phase,
      pastHorizon: state.pastHorizon,
      horizonLeftS,
      effectiveHorizonLeftS,
      renderTargetDistM: state.renderTargetDistM,
      renderGuardGapM: state.renderTargetDistM - state.simDistM,
      renderGuardActive: state.renderGuardActive,
      anchorAgeS:
        vehicle && Number.isFinite(vehicle.anchorMs)
          ? (serverNowMs - vehicle.anchorMs) / 1000
          : null,
      emissionAgeS:
        vehicle && Number.isFinite(vehicle.emittedAtMs)
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
      feedSeq: health.lastSeq,
      serverGen: health.serverGen,
      clockOffsetMs: health.clockOffsetMs,
      connection: health.connection,
      discontinuitiesTotal: health.discontinuities,
    };
  }
}
