/** Complete visible-path audit. No discontinuity/reset is exempted from spatial metrics. */
import type { RouteGeometry, TramPublicState } from "../../src/lib/types";
import { sameGeometryAxis } from "../../src/lib/physics/observationProjection";
import type { ParsedVehicle } from "../../src/lib/physics/bundle";

type Prev = {
  at: number;
  s: number;
  position: [number, number];
  trip: string;
  geometry: RouteGeometry | undefined;
  emission: number;
  curve: boolean;
  v: number | null;
  heldS: number;
  opacity: number;
  reset: boolean;
  acceleration: number | null;
  active: boolean;
  worldV: [number, number] | null;
  worldA: [number, number] | null;
  hiddenRunS: number;
  transitionReason: string | null;
  dwellingStopM: number | null;
  servedThroughM: number;
};
export class DisplayAudit {
  private previous = new Map<string, Prev>();
  private counts: Record<string, number> = {};
  private worst: any[] = [];
  private stopCrossings: any[] = [];
  private maxWorldStepM = 0;
  private maxBackwardStepM = 0;
  private maxPositiveSpeedStepMs = 0;
  private maxNegativeSpeedStepMs = 0;
  private accelerationBuckets = new Map<number, number>();
  private jerkBuckets = new Map<number, number>();
  private jerkExamples: any[] = [];
  private accelerationOver25 = 0;
  private brakingOver25 = 0;
  private jerkOver4 = 0;
  private missingGeometryVehicleSeconds = 0;
  private rawGpsTargetDistance = new Map<number, number>();
  private rawGpsTargetLagOver100Seconds = 0;
  private endpointClampedMovingSeconds = 0;
  private endpointExamples: any[] = [];
  private worstWorldAcceleration: any[] = [];
  private worldSpeedBuckets = new Map<number, number>();
  private worldAccelerationBuckets = new Map<number, number>();
  private worldJerkBuckets = new Map<number, number>();
  private hiddenSeconds = 0;
  private activeVehicleSeconds = 0;
  private opacityWeightedVisibleSeconds = 0;
  private maxHiddenRunSeconds = 0;
  private fadingSeconds = 0;
  private histogram(map: Map<number, number>, value: number) {
    const bucket = Math.round(Math.min(10000, Math.abs(value)) * 100);
    map.set(bucket, (map.get(bucket) ?? 0) + 1);
  }
  private quantiles(map: Map<number, number>) {
    const sorted = [...map].sort((a, b) => a[0] - b[0]),
      total = sorted.reduce((a, b) => a + b[1], 0);
    return Object.fromEntries(
      [0.5, 0.9, 0.99, 1].map((q) => {
        let count = 0;
        for (const [v, n] of sorted) {
          count += n;
          if (count >= q * total) return [String(q), v / 100];
        }
        return [String(q), 0];
      }),
    );
  }
  private intervals = 0;
  private stationCrossings = 0;
  private crossingsAbove5Ms = 0;
  private visibleRequiredCrossingsAbove5Ms = 0;
  private visibleRequiredCrossingExamples: unknown[] = [];
  private visibleOffPlatformHeldSeconds = 0;
  private maxFullyVisibleWorldStepM = 0;
  private maxUnbrokenNegativeSpeedStepMs = 0;
  private physicalBraking: any[] = [];
  finishFrame(at: number, keys: Set<string>) {
    for (const [key, p] of this.previous) {
      if (!keys.has(key)) {
        p.active = false;
        if (at - p.at > 90000) this.previous.delete(key);
      }
    }
  }
  private count(k: string) {
    this.counts[k] = (this.counts[k] ?? 0) + 1;
  }
  sample(
    state: TramPublicState,
    at: number,
    geometry: RouteGeometry | undefined,
    vehicle: ParsedVehicle | undefined,
    measured: boolean,
  ) {
    const old = this.previous.get(state.key);
    let v: number | null = null,
      heldS = 0,
      reset = false,
      acceleration: number | null = null;
    const opacity = state.presentationOpacity ?? 1;
    let hiddenRunS = 0;
    let servedThroughM = -Infinity;
    let worldV: [number, number] | null = null,
      worldA: [number, number] | null = null;
    if (old) {
      const dt = (at - old.at) / 1000;
      const dx =
        (state.position[0] - old.position[0]) *
        111320 *
        Math.cos(((state.position[1] + old.position[1]) * Math.PI) / 360);
      const dy = (state.position[1] - old.position[1]) * 111320;
      const worldM = Math.hypot(dx, dy);
      const sameAxis =
        old.active &&
        old.geometry !== undefined &&
        geometry !== undefined &&
        (old.geometry === geometry || sameGeometryAxis(old.geometry, geometry));
      const ds = sameAxis ? state.simDistM - old.s : null;
      if (sameAxis) {
        servedThroughM = old.servedThroughM;
        if (
          old.dwellingStopM !== null &&
          state.phase !== "dwell" &&
          state.phase !== "terminal"
        )
          servedThroughM = Math.max(servedThroughM, old.dwellingStopM);
      }
      if (dt > 0) {
        v = old.active ? (ds ?? worldM) / dt : null;
        heldS = worldM / dt < 0.1 ? old.heldS + dt : 0;
      }
      if (
        measured &&
        old.active &&
        sameAxis &&
        geometry?.stops.length &&
        dt > 0 &&
        dt <= 5 &&
        opacity >= 0.99 &&
        old.opacity >= 0.99 &&
        worldM / dt < 0.1 &&
        !geometry.stops.some(
          (stop) => Math.abs(stop.distM - state.simDistM) <= 30,
        )
      )
        this.visibleOffPlatformHeldSeconds += dt;
      if (
        dt > 0 &&
        old.active &&
        dt <= 5 &&
        opacity >= 0.99 &&
        old.opacity >= 0.99
      ) {
        worldV = [dx / dt, dy / dt];
        if (old.worldV)
          worldA = [
            (worldV[0] - old.worldV[0]) / dt,
            (worldV[1] - old.worldV[1]) / dt,
          ];
        if (measured) {
          this.histogram(this.worldSpeedBuckets, Math.hypot(...worldV));
          if (worldA) {
            const magnitude = Math.hypot(...worldA);
            this.histogram(this.worldAccelerationBuckets, magnitude);
            if (
              magnitude > 5 &&
              (this.worstWorldAcceleration.length < 20 ||
                magnitude >
                  this.worstWorldAcceleration[
                    this.worstWorldAcceleration.length - 1
                  ].magnitude)
            ) {
              this.worstWorldAcceleration.push({
                key: state.key,
                atMs: at,
                magnitude,
                worldV,
                worldA,
                position: state.position,
                previousPosition: old.position,
                geometryChanged: old.geometry !== geometry,
                geometry: geometry?.shapeId,
                totalM: geometry?.totalM,
                s: state.simDistM,
                reportedSpeedMs: state.simSpeedKmh / 3.6,
                offset: state.presentationOffsetM,
                reason: state.presentationTransitionReason,
              });
              this.worstWorldAcceleration.sort(
                (a, b) => b.magnitude - a.magnitude,
              );
              this.worstWorldAcceleration.length = Math.min(
                20,
                this.worstWorldAcceleration.length,
              );
            }
          }
          if (
            geometry &&
            state.simDistM >= geometry.totalM - 0.001 &&
            Math.hypot(...worldV) < 0.1 &&
            state.simSpeedKmh / 3.6 > 0.5
          ) {
            this.endpointClampedMovingSeconds += dt;
            if (
              this.endpointExamples.length < 20 &&
              !this.endpointExamples.some((e) => e.key === state.key)
            )
              this.endpointExamples.push({
                key: state.key,
                atMs: at,
                s: state.simDistM,
                totalM: geometry.totalM,
                reportedSpeedMs: state.simSpeedKmh / 3.6,
              });
          }
          if (worldA && old.worldA)
            this.histogram(
              this.worldJerkBuckets,
              Math.hypot(worldA[0] - old.worldA[0], worldA[1] - old.worldA[1]) /
                dt,
            );
        }
      }
      if (old.active && dt > 0 && opacity <= 0.001)
        hiddenRunS = old.hiddenRunS + dt;
      if (measured && dt > 0) {
        this.activeVehicleSeconds += dt;
        this.opacityWeightedVisibleSeconds += dt * opacity;
        this.maxHiddenRunSeconds = Math.max(
          this.maxHiddenRunSeconds,
          hiddenRunS,
        );
        if (!geometry) {
          this.missingGeometryVehicleSeconds += dt;
          const target = state.snapshot.coordinates;
          const distance = Math.hypot(
            (target[0] - state.position[0]) *
              111320 *
              Math.cos((state.position[1] * Math.PI) / 180),
            (target[1] - state.position[1]) * 111320,
          );
          this.histogram(this.rawGpsTargetDistance, distance);
          if (distance > 100) this.rawGpsTargetLagOver100Seconds += dt;
        }
        this.intervals++;
        const reason = !old.active
          ? "reappeared-identity"
          : old.trip !== state.snapshot.tripId
            ? "trip-change"
            : old.geometry !== geometry
              ? "geometry-change"
              : old.curve !== !!vehicle
                ? vehicle
                  ? "curve-restored"
                  : "curve-lost"
                : vehicle?.discontinuity && old.emission !== vehicle.emittedAtMs
                  ? "server-discontinuity"
                  : dt > 5
                    ? "frame-gap"
                    : "ordinary";
        if (reason !== "ordinary") this.count(reason);
        this.maxWorldStepM = Math.max(this.maxWorldStepM, worldM);
        if (ds !== null)
          this.maxBackwardStepM = Math.min(this.maxBackwardStepM, ds);
        const dv = v !== null && old.v !== null ? v - old.v : null;
        acceleration = dv !== null ? dv / dt : null;
        if (opacity < 1) this.fadingSeconds += dt;
        if (opacity <= 0.001) this.hiddenSeconds += dt;
        if (
          old.active &&
          opacity >= 0.99 &&
          old.opacity >= 0.99 &&
          acceleration !== null
        ) {
          this.histogram(this.accelerationBuckets, acceleration);
          if (acceleration > 2.5001) this.accelerationOver25++;
          if (acceleration < -2.5001) this.brakingOver25++;
          if (old.acceleration !== null) {
            const jerk = (acceleration - old.acceleration) / dt;
            this.histogram(this.jerkBuckets, jerk);
            if (Math.abs(jerk) > 4.001) {
              this.jerkOver4++;
              if (this.jerkExamples.length < 30)
                this.jerkExamples.push({
                  key: state.key,
                  atMs: at,
                  jerkMs3: jerk,
                  accelerationMs2: acceleration,
                  previousAccelerationMs2: old.acceleration,
                  reason,
                  opacity,
                  previousOpacity: old.opacity,
                  axisStepM: ds,
                  speedMs: v,
                  previousSpeedMs: old.v,
                });
            }
          }
        }
        if (dv !== null) {
          this.maxPositiveSpeedStepMs = Math.max(
            this.maxPositiveSpeedStepMs,
            dv,
          );
          this.maxNegativeSpeedStepMs = Math.max(
            this.maxNegativeSpeedStepMs,
            -dv,
          );
        }
        const teleport = old.active && worldM > Math.max(3, 25 * dt + 0.05);
        const reversal = ds !== null && ds < -0.5;
        reset = teleport || reversal || reason !== "ordinary";
        const hidden = opacity <= 0.001 && old.opacity <= 0.001;
        if (old.active && opacity >= 0.99 && old.opacity >= 0.99)
          this.maxFullyVisibleWorldStepM = Math.max(
            this.maxFullyVisibleWorldStepM,
            worldM,
          );
        if (teleport)
          this.count(
            hidden
              ? "hidden-rebase-over-budget"
              : "visible-or-partially-visible-over-budget",
          );
        if (!reset && !old.reset && dv !== null && dv < 0) {
          this.maxUnbrokenNegativeSpeedStepMs = Math.max(
            this.maxUnbrokenNegativeSpeedStepMs,
            -dv,
          );
          if (dv < -1) {
            this.physicalBraking.push({
              key: state.key,
              atMs: at,
              speedStepMs: dv,
              previousSpeedMs: old.v,
              intervalSpeedMs: v,
              fixAtMs: state.snapshot.observedAtMs,
              emittedAtMs: vehicle?.emittedAtMs,
            });
            this.physicalBraking.sort((a, b) => a.speedStepMs - b.speedStepMs);
            if (this.physicalBraking.length > 30)
              this.physicalBraking.length = 30;
          }
        }
        if (teleport) this.count("raw-displacement-over-budget/" + reason);
        if (reversal) this.count("raw-backward/" + reason);
        if (dv !== null && dv < -1)
          this.count("negative-speed-step-over1/" + reason);
        if (dv !== null && dv > 1)
          this.count("positive-speed-step-over1/" + reason);
        if (teleport || reversal || (dv !== null && Math.abs(dv) > 2)) {
          const event = {
            key: state.key,
            atMs: at,
            reason,
            presentationReason: state.presentationTransitionReason ?? null,
            hasPresentationGeometry: !!geometry,
            opacity,
            previousOpacity: old.opacity,
            hidden,
            dtS: dt,
            worldStepM: worldM,
            axisStepM: ds,
            previousSpeedMs: old.v,
            intervalSpeedMs: v,
            speedStepMs: dv,
            reportedSpeedMs: state.simSpeedKmh / 3.6,
            previousHeldS: old.heldS,
            previousDistM: old.s,
            distM: state.simDistM,
            targetDistM: (state as any).renderTargetDistM,
            fixDistM: state.snapshot.shapeDistM,
            fixAtMs: state.snapshot.observedAtMs,
            fixState: state.snapshot.statePosition,
            lastStopId: state.snapshot.lastStopId,
            tripId: state.snapshot.tripId,
            emittedAtMs: vehicle?.emittedAtMs,
            previousEmissionMs: old.emission,
          };
          this.worst.push(event);
          this.worst.sort(
            (a, b) =>
              Math.max(b.worldStepM, Math.abs(b.speedStepMs ?? 0) / 30) -
              Math.max(a.worldStepM, Math.abs(a.speedStepMs ?? 0) / 30),
          );
          if (this.worst.length > 80) this.worst.length = 80;
        }
        if (sameAxis && geometry && ds !== null && ds > 0)
          for (const stop of geometry.stops) {
            if (stop.distM <= old.s || stop.distM > state.simDistM) continue;
            this.stationCrossings++;
            if ((v ?? 0) > 5) {
              this.crossingsAbove5Ms++;
              if (
                opacity >= 0.99 &&
                old.opacity >= 0.99 &&
                (!stop.requestOnly || stop.isTerminal)
              ) {
                this.visibleRequiredCrossingsAbove5Ms++;
                if (this.visibleRequiredCrossingExamples.length < 20)
                  this.visibleRequiredCrossingExamples.push({
                    key: state.key,
                    atMs: at,
                    stopId: stop.stopId,
                    sequence: stop.sequence,
                    stopDistM: stop.distM,
                    alreadyDisplayedService: servedThroughM >= stop.distM,
                    intervalSpeedMs: v,
                  });
              }
              if (this.stopCrossings.length < 80)
                this.stopCrossings.push({
                  key: state.key,
                  atMs: at,
                  stopId: stop.stopId,
                  stopSequence: stop.sequence,
                  stopName: stop.name,
                  stopDistM: stop.distM,
                  intervalSpeedMs: v,
                  reason,
                  fixState: state.snapshot.statePosition,
                  lastStopId: state.snapshot.lastStopId,
                  fixAgeS: (at - state.snapshot.observedAtMs) / 1000,
                  precedingHeldS: old.heldS,
                  opacity,
                  previousOpacity: old.opacity,
                  requestOnly: stop.requestOnly === true,
                });
            }
          }
      }
    }
    this.previous.set(state.key, {
      at,
      s: state.simDistM,
      position: state.position,
      trip: state.snapshot.tripId,
      geometry,
      emission: vehicle?.emittedAtMs ?? 0,
      curve: !!vehicle,
      v,
      heldS,
      opacity,
      reset,
      acceleration,
      active: true,
      worldV,
      worldA,
      hiddenRunS,
      transitionReason: state.presentationTransitionReason ?? null,
      dwellingStopM:
        state.phase === "dwell" || state.phase === "terminal"
          ? (geometry?.stops.find(
              (stop) => Math.abs(stop.distM - state.simDistM) <= 30,
            )?.distM ?? null)
          : null,
      servedThroughM,
    });
  }
  report() {
    return {
      note: "Every submitted replay state counted, including server-sanctioned resets. Displacement-derived speed around a reset describes visible teleport, not physical tram speed. Crossings are descriptive, not proof that a source-designated served/express/terminal stop should have held.",
      intervals: this.intervals,
      fullyVisibleWorldSpeedMs: this.quantiles(this.worldSpeedBuckets),
      fullyVisibleWorldAccelerationMs2: this.quantiles(
        this.worldAccelerationBuckets,
      ),
      fullyVisibleWorldJerkMs3: this.quantiles(this.worldJerkBuckets),
      missingGeometryVehicleSeconds: this.missingGeometryVehicleSeconds,
      rawGpsTargetDistanceM: this.quantiles(this.rawGpsTargetDistance),
      rawGpsTargetLagOver100Seconds: this.rawGpsTargetLagOver100Seconds,
      rawGpsTargetNote:
        "Receipt-time separation from the latest GPS target while no route axis is available, not timestamp-matched position accuracy. Includes stale input and fade stages.",
      endpointClampedMovingSeconds: this.endpointClampedMovingSeconds,
      endpointExamples: this.endpointExamples,
      worstWorldAcceleration: this.worstWorldAcceleration,
      worldVectorNote:
        "Finite differences of actual longitude/latitude positions, including raw GPS retargets, lateral alignment and route curvature. Route vertices can exceed correction-only acceleration/jerk bounds; no geometry-change exemption.",
      fullyVisibleAbsoluteAccelerationMs2: this.quantiles(
        this.accelerationBuckets,
      ),
      fullyVisibleAbsoluteJerkMs3: this.quantiles(this.jerkBuckets),
      fullyVisibleAccelerationOver2_5: this.accelerationOver25,
      fullyVisibleBrakingOver2_5: this.brakingOver25,
      fullyVisibleJerkOver4: this.jerkOver4,
      fullyVisibleJerkExamples: this.jerkExamples,
      activeVehicleSeconds: this.activeVehicleSeconds,
      opacityWeightedVisibleSeconds: this.opacityWeightedVisibleSeconds,
      visibleCoverage: this.activeVehicleSeconds
        ? this.opacityWeightedVisibleSeconds / this.activeVehicleSeconds
        : null,
      maxHiddenRunSeconds: this.maxHiddenRunSeconds,
      unrevealedTransitionsAtEnd: [...this.previous]
        .filter(([, p]) => p.active && p.transitionReason !== null)
        .map(([key, p]) => ({
          key,
          reason: p.transitionReason,
          opacity: p.opacity,
          hiddenRunS: p.hiddenRunS,
          atMs: p.at,
        })),
      hiddenVehicleSeconds: this.hiddenSeconds,
      fadingVehicleSeconds: this.fadingSeconds,
      counts: this.counts,
      maxWorldStepM: this.maxWorldStepM,
      maxFullyVisibleWorldStepM: this.maxFullyVisibleWorldStepM,
      maxUnbrokenNegativeSpeedStepMs: this.maxUnbrokenNegativeSpeedStepMs,
      physicalBrakingExamples: this.physicalBraking,
      maxBackwardStepM: this.maxBackwardStepM,
      maxPositiveSpeedStepMs: this.maxPositiveSpeedStepMs,
      maxNegativeSpeedStepMs: this.maxNegativeSpeedStepMs,
      stationCrossings: this.stationCrossings,
      crossingsAbove5Ms: this.crossingsAbove5Ms,
      visibleRequiredCrossingsAbove5Ms: this.visibleRequiredCrossingsAbove5Ms,
      visibleRequiredCrossingExamples: this.visibleRequiredCrossingExamples,
      visibleOffPlatformHeldSeconds: this.visibleOffPlatformHeldSeconds,
      worst: this.worst,
      stopCrossingExamples: this.stopCrossings,
    };
  }
}
