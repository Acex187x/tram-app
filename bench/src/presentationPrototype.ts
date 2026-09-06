/** Offline-only study of one bounded presentation state. Never runs in the app. */
import type { TramPublicState, RouteGeometry } from "../../src/lib/types";
import { pointAt, bearingAt } from "../../src/lib/geo/polyline";
import type { ParsedVehicle } from "../../src/lib/physics/bundle";
import { renderDistM, renderSpeedMs } from "../../src/lib/physics/render";

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
export interface PrototypeConfig {
  hardM: number;
  behindS: number;
  vmax: number;
  accel: number;
  brake: number;
  jerk: number;
}
type P = {
  s: number;
  v: number;
  a: number;
  at: number;
  trip: string;
  geom: RouteGeometry | undefined;
  position: [number, number];
  behindAt: number | null;
  badAt: number | null;
  fade: null | {
    stage: "out" | "hidden-old" | "hidden-new" | "in";
    at: number;
    reason: string;
    distance: number;
  };
  opacity: number;
  lookAt: number;
  stopS: number | null;
};
/** Exact distance of a maximum-jerk brake ramp, optionally holding max deceleration. */
export function brakingDistance(
  v: number,
  a: number,
  b: number,
  j: number,
): number {
  if (v <= 0) return 0;
  let s = 0,
    speed = v,
    acc = a;
  const step = (t: number, jerk: number) => {
    s += speed * t + (acc * t * t) / 2 + (jerk * t * t * t) / 6;
    speed += acc * t + (jerk * t * t) / 2;
    acc += jerk * t;
  };
  const peak = Math.sqrt(Math.max(0, j * v + (a * a) / 2));
  const p = Math.min(b, peak);
  step(Math.max(0, (a + p) / j), -j);
  if (peak > b) step(Math.max(0, (speed - (p * p) / (2 * j)) / p), 0);
  step(p / j, j);
  return Math.max(0, s);
}
export class PresentationPrototype {
  private states = new Map<string, P>();
  private transitions: any[] = [];
  private hiddenS = 0;
  private fadingS = 0;
  private measuredFrames = 0;
  constructor(private c: PrototypeConfig) {}
  transform(
    s: TramPublicState,
    now: number,
    serverNow: number,
    g: RouteGeometry | undefined,
    vehicle: ParsedVehicle | undefined,
    measured: boolean,
  ): TramPublicState {
    const target = (s as any).renderTargetDistM ?? s.simDistM;
    const sample = (t: number) =>
      vehicle
        ? renderDistM(
            vehicle,
            t,
            "smooth",
            s.snapshot.shapeDistM,
            s.snapshot.observedAtMs,
          )
        : target;
    const rv = vehicle
      ? renderSpeedMs(
          vehicle,
          serverNow,
          "smooth",
          s.snapshot.shapeDistM,
          s.snapshot.observedAtMs,
        )
      : s.simSpeedKmh / 3.6;
    const ra = vehicle
      ? (renderSpeedMs(
          vehicle,
          serverNow + 500,
          "smooth",
          s.snapshot.shapeDistM,
          s.snapshot.observedAtMs,
        ) -
          rv) *
        2
      : 0;
    let p = this.states.get(s.key);
    if (!p) {
      p = {
        s: target,
        v: clamp(rv, 0, this.c.vmax),
        a: 0,
        at: now,
        trip: s.snapshot.tripId,
        geom: g,
        position: s.position,
        behindAt: null,
        badAt: null,
        fade: null,
        opacity: 1,
        lookAt: 0,
        stopS: null,
      };
      this.states.set(s.key, p);
      return s;
    }
    const dt = Math.max(0, (now - p.at) / 1000);
    const error = target - p.s;
    const forced =
      p.trip !== s.snapshot.tripId
        ? "trip-change"
        : p.geom !== g
          ? "incompatible-geometry"
          : dt > 5
            ? "resume-gap"
            : null;
    if (error < -30) {
      p.behindAt ??= now;
    } else p.behindAt = null;
    if (Math.abs(error) > this.c.hardM) {
      p.badAt ??= now;
    } else p.badAt = null;
    const reason =
      forced ??
      (p.badAt !== null && now - p.badAt > 1000
        ? "unreachable-correction"
        : p.behindAt !== null && now - p.behindAt > this.c.behindS * 1000
          ? "unreachable-correction"
          : null);
    if (reason && !p.fade) {
      p.fade = { stage: "out", at: now, reason, distance: error };
      if (measured)
        this.transitions.push({
          key: s.key,
          atMs: now,
          reason,
          distanceM: error,
        });
    }
    let freeze = !!forced;
    if (p.fade) {
      const f = p.fade;
      if (f.stage === "out") {
        p.opacity = Math.max(0, 1 - (now - f.at) / 300);
        if (p.opacity === 0) f.stage = "hidden-old";
      } else if (f.stage === "hidden-old") {
        p.s = target;
        p.v = clamp(rv, 0, this.c.vmax);
        p.a = 0;
        p.trip = s.snapshot.tripId;
        p.geom = g;
        p.badAt = null;
        p.behindAt = null;
        p.opacity = 0;
        f.stage = "hidden-new";
        freeze = true;
      } else if (f.stage === "hidden-new") {
        f.stage = "in";
        f.at = now;
        p.opacity = 0;
      } else {
        p.opacity = Math.min(1, (now - f.at) / 400);
        if (p.opacity === 1) p.fade = null;
      }
    }
    if (now - p.lookAt >= 1000) {
      p.lookAt = now;
      p.stopS = null;
      let before = target;
      for (let i = 1; i <= 16; i++) {
        const next = sample(serverNow + i * 1000);
        if (Math.abs(next - before) < 0.03) {
          p.stopS = next;
          break;
        }
        before = next;
      }
    }
    if (!freeze && dt > 0) {
      let desired = clamp(
        ra + 0.1 * (target - p.s) + 0.65 * (rv - p.v),
        -this.c.brake,
        this.c.accel,
      );
      if (
        p.stopS !== null &&
        p.stopS - p.s <=
          brakingDistance(p.v, p.a, this.c.brake, this.c.jerk) + 0.3
      )
        desired = -this.c.brake;
      const lower = Math.max(-this.c.brake, p.a - this.c.jerk * dt),
        upper = Math.min(this.c.accel, p.a + this.c.jerk * dt);
      let nextA = clamp(desired, lower, upper);
      const viable = (a: number) =>
        p!.v + ((p!.a + a) * dt) / 2 - Math.min(0, a) ** 2 / (2 * this.c.jerk);
      if (viable(nextA) < 0) {
        let lo = nextA,
          hi = upper;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          if (viable(mid) < 0) lo = mid;
          else hi = mid;
        }
        nextA = hi;
      }
      const room = (a: number) =>
        this.c.vmax -
        (p!.v + ((p!.a + a) * dt) / 2) -
        Math.max(0, a) ** 2 / (2 * this.c.jerk);
      if (room(nextA) < 0) {
        let lo = lower,
          hi = nextA;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          if (room(mid) < 0) hi = mid;
          else lo = mid;
        }
        nextA = lo;
      }
      const ds = p.v * dt + (p.a * dt * dt) / 2 + ((nextA - p.a) * dt * dt) / 6;
      p.s += Math.max(0, ds);
      p.v = clamp(p.v + ((p.a + nextA) * dt) / 2, 0, this.c.vmax);
      p.a = nextA;
      if (g && p.s > g.totalM) {
        p.s = g.totalM;
        p.v = 0;
        p.a = 0;
      }
    }
    p.at = now;
    if (measured) {
      this.measuredFrames++;
      if (p.opacity < 1) this.fadingS += dt;
      if (p.opacity <= 0.001) this.hiddenS += dt;
    }
    if (p.geom) p.position = pointAt(p.geom.coordinates, p.geom.cumDistM, p.s);
    else if (!p.fade) p.position = s.position;
    return {
      ...s,
      simDistM: p.s,
      simSpeedKmh: p.v * 3.6,
      renderGuardActive: Math.abs(target - p.s) > 1e-6,
      position: p.position,
      bearing: p.geom
        ? bearingAt(p.geom.coordinates, p.geom.cumDistM, p.s)
        : s.bearing,
      presentationOpacity: p.opacity,
      presentationTransitionReason: p.fade?.reason ?? null,
      presentationCorrectionM: p.fade?.distance ?? null,
    } as TramPublicState;
  }
  report() {
    return {
      config: this.c,
      transitionCount: this.transitions.length,
      transitions: this.transitions,
      hiddenVehicleSeconds: this.hiddenS,
      fadingVehicleSeconds: this.fadingS,
      measuredFrames: this.measuredFrames,
    };
  }
}
