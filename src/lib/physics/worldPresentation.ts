import {
  advancePresentation,
  PRESENTATION_LIMITS,
  type PresentationLimits,
} from "./presentation";
export type Vec2 = [number, number];
export interface WorldState {
  origin: Vec2;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
}
const componentSpeed = PRESENTATION_LIMITS.speed / Math.SQRT2;
const rawLimits: PresentationLimits = {
  speed: 2 * componentSpeed,
  acceleration: 2.5 / Math.SQRT2,
  braking: 2.5 / Math.SQRT2,
  jerk: 4 / Math.SQRT2,
};
export const worldDelta = (from: Vec2, to: Vec2): Vec2 => [
  (to[0] - from[0]) * 111320 * Math.cos((from[1] * Math.PI) / 180),
  (to[1] - from[1]) * 111320,
];
export const offsetPosition = (base: Vec2, offset: Vec2): Vec2 => [
  base[0] + offset[0] / (111320 * Math.cos((base[1] * Math.PI) / 180)),
  base[1] + offset[1] / 111320,
];
export const initialWorld = (position: Vec2): WorldState => ({
  origin: [...position],
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  ax: 0,
  ay: 0,
});
export const worldPosition = (w: WorldState): Vec2 =>
  offsetPosition(w.origin, [w.x, w.y]);
/** Signed components reuse the same feasible jerk-limited integrator. A moving
 * coordinate origin maps [-V,V] to [0,2V]; V/sqrt2 component budgets guarantee
 * Euclidean correction speed/acceleration/jerk bounds. No route is invented. */
export function advanceWorld(w: WorldState, target: Vec2, dt: number): void {
  if (!(dt > 0) || dt > 5 || !target.every(Number.isFinite)) return;
  const goal = worldDelta(w.origin, target);
  const movingOrigin = componentSpeed * (dt - dt / Math.ceil(dt / 0.05));
  const x = { s: w.x, v: w.vx + componentSpeed, a: w.ax },
    y = { s: w.y, v: w.vy + componentSpeed, a: w.ay };
  advancePresentation(
    x,
    dt,
    goal[0] + movingOrigin,
    componentSpeed,
    0,
    null,
    rawLimits,
  );
  advancePresentation(
    y,
    dt,
    goal[1] + movingOrigin,
    componentSpeed,
    0,
    null,
    rawLimits,
  );
  w.x = x.s - componentSpeed * dt;
  w.y = y.s - componentSpeed * dt;
  w.vx = x.v - componentSpeed;
  w.vy = y.v - componentSpeed;
  w.ax = x.a;
  w.ay = y.a;
}
export interface WorldAlignment {
  atMs: number;
  durationS: number;
  coefficients: [number[], number[]];
  limits: PresentationLimits;
}
function controls(r: number, v: number, a: number, t: number): number[] {
  return [r, r + (v * t) / 5, r + (2 * v * t) / 5 + (a * t * t) / 20, 0, 0, 0];
}
function derivative(p: number[], t: number): number[] {
  return p.slice(1).map((v, i) => ((v - p[i]) * (p.length - 1)) / t);
}
function normBound(x: number[], y: number[]): number {
  return Math.max(...x.map((v, i) => Math.hypot(v, y[i])));
}
/** Quintic residual matches incoming world P/V/A and ends exactly on the rail
 * with zero residual velocity/acceleration. Bernstein convex-hull derivative
 * bounds reserve part of the existing correction budget for this alignment. */
export function createAlignment(
  offset: Vec2,
  velocity: Vec2,
  acceleration: Vec2,
  alongV: number,
  alongA: number,
  atMs: number,
): WorldAlignment | null {
  for (let t = 1; t <= 32; t *= 1.18) {
    const x = controls(offset[0], velocity[0], acceleration[0], t),
      y = controls(offset[1], velocity[1], acceleration[1], t);
    if (normBound(x, y) > 10.000001) continue;
    const vx = derivative(x, t),
      vy = derivative(y, t),
      ax = derivative(vx, t),
      ay = derivative(vy, t),
      jx = derivative(ax, t),
      jy = derivative(ay, t);
    const speed = 25 - normBound(vx, vy),
      a = 2.5 - normBound(ax, ay),
      j = 4 - normBound(jx, jy);
    if (
      speed < 20 ||
      a < 1.25 ||
      j < 2 ||
      alongV < 0 ||
      alongV > speed ||
      Math.abs(alongA) > a
    )
      continue;
    if (
      alongV < Math.min(0, alongA) ** 2 / (2 * j) ||
      speed - alongV < Math.max(0, alongA) ** 2 / (2 * j)
    )
      continue;
    const coeff = (r: number, v: number, a: number) => [
      r,
      v * t,
      (a * t * t) / 2,
      -10 * r - 6 * v * t - 1.5 * a * t * t,
      15 * r + 8 * v * t + 1.5 * a * t * t,
      -6 * r - 3 * v * t - 0.5 * a * t * t,
    ];
    return {
      atMs,
      durationS: t,
      coefficients: [
        coeff(offset[0], velocity[0], acceleration[0]),
        coeff(offset[1], velocity[1], acceleration[1]),
      ],
      limits: { speed, acceleration: a, braking: a, jerk: j },
    };
  }
  return null;
}
export function alignmentAt(
  a: WorldAlignment,
  atMs: number,
): { offset: Vec2; velocity: Vec2; acceleration: Vec2; done: boolean } {
  const u =
    atMs >= a.atMs + a.durationS * 1000
      ? 1
      : Math.max(0, Math.min(1, (atMs - a.atMs) / (a.durationS * 1000)));
  if (u >= 1 - 1e-10)
    return {
      offset: [0, 0],
      velocity: [0, 0],
      acceleration: [0, 0],
      done: true,
    };
  const values = a.coefficients.map((c) => ({
    p: c.reduceRight((v, k) => v * u + k, 0),
    v:
      (c[1] + u * (2 * c[2] + u * (3 * c[3] + u * (4 * c[4] + u * 5 * c[5])))) /
      a.durationS,
    a:
      (2 * c[2] + u * (6 * c[3] + u * (12 * c[4] + u * 20 * c[5]))) /
      (a.durationS * a.durationS),
  }));
  return {
    offset: [values[0].p, values[1].p],
    velocity: [values[0].v, values[1].v],
    acceleration: [values[0].a, values[1].a],
    done: u === 1,
  };
}
