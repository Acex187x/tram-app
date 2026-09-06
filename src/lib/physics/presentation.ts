/** The single display correction state. Prediction and stop selection stay on
 * the server; this only approaches an already supplied position/velocity. */
export interface PresentationKinematics {
  s: number;
  v: number;
  a: number;
}
export interface PresentationLimits {
  speed: number;
  acceleration: number;
  braking: number;
  jerk: number;
}
export const PRESENTATION_LIMITS = Object.freeze({
  speed: 25,
  acceleration: 2.5,
  braking: 2.5,
  jerk: 4,
});
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/** Exact distance of a jerk-limited brake, including the ramp back to a=0.
 * Input must be feasible: v >= min(a,0)^2/(2*j). */
export function presentationBrakingDistance(
  v: number,
  a: number,
  b: number = PRESENTATION_LIMITS.braking,
  j: number = PRESENTATION_LIMITS.jerk,
): number {
  if (v <= 0) return 0;
  let s = 0,
    speed = v,
    acceleration = a;
  const step = (t: number, jerk: number) => {
    s += speed * t + (acceleration * t * t) / 2 + (jerk * t * t * t) / 6;
    speed += acceleration * t + (jerk * t * t) / 2;
    acceleration += jerk * t;
  };
  const peak = Math.sqrt(Math.max(0, j * v + (a * a) / 2));
  const p = Math.min(b, peak);
  step(Math.max(0, (a + p) / j), -j);
  if (peak > b) step(Math.max(0, (speed - (p * p) / (2 * j)) / p), 0);
  step(p / j, j);
  return Math.max(0, s);
}

/** Mutate only a frame-owned state. Exact integration of a linear acceleration
 * ramp gives continuous p/v/a; no target clipping can introduce instant braking.
 * A bounded numerical step handles dropped frames without an unbounded loop. */
export function advancePresentation(
  p: PresentationKinematics,
  dt: number,
  targetS: number,
  targetV: number,
  targetA: number,
  stopS: number | null,
  limits: PresentationLimits = PRESENTATION_LIMITS,
): void {
  if (!(dt > 0) || dt > 5 || !Number.isFinite(targetS)) return;
  const count = Math.ceil(dt / 0.05);
  const h = dt / count;
  for (let n = 0; n < count; n++) {
    // The supplied sample is at the END of this frame. Interpolate backwards
    // for integration only; this adds no prediction horizon of our own.
    const target = targetS - Math.max(0, targetV) * (dt - (n + 1) * h);
    let desired = clamp(
      targetA + 0.1 * (target - p.s) + 0.65 * (targetV - p.v),
      -limits.braking,
      limits.acceleration,
    );
    if (
      stopS !== null &&
      stopS - p.s <=
        presentationBrakingDistance(p.v, p.a, limits.braking, limits.jerk) +
          p.v * h +
          0.05
    )
      desired = -limits.braking;
    const lower = Math.max(-limits.braking, p.a - limits.jerk * h);
    const upper = Math.min(limits.acceleration, p.a + limits.jerk * h);
    let nextA = clamp(desired, lower, upper);
    // Leave enough velocity room to return acceleration to zero before either
    // speed boundary. Simply clamping v after a step would violate C1/jerk.
    const lowRoom = (a: number) =>
      p.v + ((p.a + a) * h) / 2 - Math.min(0, a) ** 2 / (2 * limits.jerk);
    if (lowRoom(nextA) < 0) {
      let lo = nextA,
        hi = upper;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (lowRoom(mid) < 0) lo = mid;
        else hi = mid;
      }
      nextA = hi;
    }
    const highRoom = (a: number) =>
      limits.speed -
      p.v -
      ((p.a + a) * h) / 2 -
      Math.max(0, a) ** 2 / (2 * limits.jerk);
    if (highRoom(nextA) < 0) {
      let lo = lower,
        hi = nextA;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (highRoom(mid) < 0) hi = mid;
        else lo = mid;
      }
      nextA = lo;
    }
    p.s += Math.max(
      0,
      p.v * h + (p.a * h * h) / 2 + ((nextA - p.a) * h * h) / 6,
    );
    p.v = clamp(p.v + ((p.a + nextA) * h) / 2, 0, limits.speed);
    p.a = nextA;
  }
}

export type PresentationReason =
  | "trip-change"
  | "incompatible-geometry"
  | "unreachable-correction"
  | "resume-gap";
export interface PresentationTransition {
  id: number;
  reason: PresentationReason;
  stage: "out" | "old-zero" | "new-zero" | "in";
  atMs: number;
  hiddenFrameId: number | undefined;
  acknowledged: boolean;
  startOpacity?: number;
}

/** Native acknowledgements never move the model. These phases advance only on
 * an actual frame call, and require separate accepted zero frames on BOTH axes. */
export function advanceTransition(
  t: PresentationTransition,
  now: number,
  nextToken: () => number,
): { opacity: number; rebase: boolean; done: boolean } {
  if (t.stage === "out") {
    const opacity =
      (t.startOpacity ?? 1) * Math.max(0, 1 - (now - t.atMs) / 300);
    if (opacity === 0) {
      t.stage = "old-zero";
      t.hiddenFrameId = nextToken();
      t.acknowledged = false;
    }
    return { opacity, rebase: false, done: false };
  }
  if (t.stage === "old-zero") {
    if (!t.acknowledged) return { opacity: 0, rebase: false, done: false };
    t.stage = "new-zero";
    t.hiddenFrameId = nextToken();
    t.acknowledged = false;
    return { opacity: 0, rebase: true, done: false };
  }
  if (t.stage === "new-zero") {
    if (t.acknowledged) {
      t.stage = "in";
      t.atMs = now;
      t.hiddenFrameId = undefined;
    }
    return { opacity: 0, rebase: false, done: false };
  }
  const opacity = Math.min(1, Math.max(0, (now - t.atMs) / 400));
  return { opacity, rebase: false, done: opacity === 1 };
}
