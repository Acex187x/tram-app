// The physics-v3 trajectory bundle (GET /api/trajectories/v2).
//
// Implements docs/research/physics-v3-protocol.md — the FROZEN client/server
// contract — server-side. Two tracks per vehicle, both plain keyframe
// polylines the client lerps with ONE pure function:
//
//   opinion — the model's current belief: ml-gbdt target positions with the
//             MODAL STOP RULE applied. Re-anchors on every fix, may jump.
//   smooth  — the continuity track: starts exactly where the PREVIOUS smooth
//             track said the tram is at this emission instant, then drives
//             onto `opinion`.
//
// Both are now KINEMATIC CURVES (protocol §Kinematic limits): the ML output is
// a sequence of target POSITIONS, and this module fits the closest curve to
// them that a real tram could actually drive — V_MAX 16.7 m/s, acceleration
// ≤ 1.3 m/s², braking ≤ 1.4 m/s². That is the fix for the 2026-08-16 owner
// field report on build 13:
//
//   (a) «догоняет с невозможной скоростью» — the smooth track's convergence
//       was a purely temporal blend (gap × time-weight), so a 140 m seam gap
//       was closed in 30 s at whatever speed that implied. Convergence is now
//       DRIVEN: commanded speed = opinion's own speed + gap / time-left,
//       clamped to V_MAX and rate-limited to the accel caps. When a gap cannot
//       be closed legally in 30 s the WINDOW extends; the limits never bend.
//   (b) «трамваи не умеют резко тормозить» — a 10 s knot grid plus a modal
//       hold is a step function: full pace, then zero, at one knot. The
//       profile now sees every hold in the target curve and brakes into it
//       along the physical envelope √(2·A_BRK·Δs), then accelerates out of it
//       at ≤ A_ACC instead of departing at full learned pace instantly.
//
// Everything expensive is here; the client owns nothing but `evalTrack`.
//
// Modal stop rule (protocol §Modal stop rule): while the learned release model
// says P(departed) < TRAJ_MODAL_P the curve HOLDS at the platform; when the
// threshold crosses it departs (now: accelerates away) at full learned pace.
// This is the fix for the 2026-08-13 owner field report — the mean-optimal
// expectation floats off the platform while the real tram is still standing.

import { round2 } from './db';
import {
  TRAJ_A_ACC,
  TRAJ_A_BRK,
  TRAJ_CONVERGE_MIN_S,
  TRAJ_CONVERGE_MS,
  TRAJ_DISCONTINUITY_M,
  TRAJ_HOLD_MIN_MS,
  TRAJ_HOLD_V_MS,
  TRAJ_MAX_POINTS,
  TRAJ_MODAL_P,
  TRAJ_REANCHOR_TOL_M,
  TRAJ_SIM_STEP_MS,
  TRAJ_STAND_ASSERT_MS,
  TRAJ_V_MAX_MS,
} from './config';
import { normalCdf } from './learned';

export interface TrackPoint {
  t: number;
  s: number;
}

/** Which physics engine `GET /api/trajectories/v2?gen=…` serves:
 *
 *   current — the published generator; what every phone gets when `gen` is
 *             absent, and the ONLY bundle whose bytes are frozen by contract.
 *   v3      — the drive-v3 bundle (the /api/shadow-trajectories content) in the
 *             plain v2 wire shape.
 *   mix     — v3's opinion driven onto the current generator's smooth track.
 *
 * The engine choice is the phone's, so the bundle says which one answered:
 * `v3`/`mix` carry a `generator` field, `current` cannot (its bytes are
 * frozen), and absence therefore means "the published generator". */
export type TrajectoryGen = 'current' | 'v3' | 'mix';

export interface V2Vehicle {
  key: string;
  tripId: string;
  line: string;
  /** observedAtMs of the fix both tracks are anchored to. */
  anchorMs: number;
  /** Birth of THIS trajectory — the continuity/blend anchor. */
  emittedAtMs: number;
  /** true ⇒ `smooth` starts AT `opinion`; clients may fade-teleport once. */
  discontinuity: boolean;
  opinion: TrackPoint[];
  smooth: TrackPoint[];
}

/** A track plus the instantaneous speed at each of its knots.
 *
 *  `v` is NEVER serialized — the wire shape is frozen. It is kept in the lab's
 *  memory for two things the emitted knots alone cannot give exactly:
 *  (1) the next emission starts from the real velocity, so the seam is C¹ and
 *      not just C⁰ (a tram that was doing 9 m/s is still doing 9 m/s 2 s
 *      later, whatever the fresh model output says);
 *  (2) the /physics debug page can draw the true v(t) instead of a staircase.
 *
 *  Because knots sit at profile breakpoints, v is LINEAR between consecutive
 *  knots, so `speedAt` is exact rather than an approximation. */
export interface KinTrack {
  points: TrackPoint[];
  v: number[];
}

/** THE client physics engine, server-side copy — pure `(track, t) → s`:
 *  clamp before the first / after the last knot, binary search + lerp inside.
 *  Used by the lab to score exactly what a phone renders. */
export function evalTrack(track: TrackPoint[], tMs: number): number {
  const n = track.length;
  if (n === 0) return NaN;
  if (tMs <= track[0].t) return track[0].s;
  if (tMs >= track[n - 1].t) return track[n - 1].s;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const dt = b.t - a.t;
  if (dt <= 0) return b.s;
  return a.s + ((b.s - a.s) * (tMs - a.t)) / dt;
}

/** Inverse of `evalTrack`: when does the track reach `sTarget`? The track's
 *  own start time when the target is already behind it, NaN past its horizon.
 *  Mirrors the client's `crossingTimeMs` (src/lib/physics/evaluator.ts). */
export function crossTrack(track: TrackPoint[], sTarget: number): number {
  const n = track.length;
  if (n === 0) return NaN;
  if (sTarget <= track[0].s) return track[0].t;
  if (sTarget > track[n - 1].s) return NaN;
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].s >= sTarget) hi = mid;
    else lo = mid + 1;
  }
  const a = track[hi - 1];
  const b = track[hi];
  const ds = b.s - a.s;
  if (ds <= 0) return b.t;
  return a.t + ((b.t - a.t) * (sTarget - a.s)) / ds;
}

/**
 * Where a PHONE is drawing this curve at `atMs`, given the newest fix.
 *
 * The server's twin of the client's fix-forward shim
 * (src/lib/physics/fixForward.ts). The phone receives fixes over Convex in
 * ~2 s but the curve that accounts for one only ~7–11 s later, because every
 * emission waits on an ML round trip; in that window it winds the served curve
 * forward in TIME until the curve is where the fix proves the tram is, and
 * renders from there.
 *
 * The server has to model that, because §14.7 continuity is defined against
 * "where the client is already rendering". Measured against the live streams
 * (2026-08-19, 4 min, gen=v3), reading the UNSHIFTED previous curve instead
 * put the seam floor below the phone's marker on essentially every emission —
 * 796 of the shim's 809 backward steps happened at the bundle swap, and 0–1
 * anywhere else. This is that hole, closed on the side that can see both
 * curves.
 */
export function clientProjectionM(
  track: TrackPoint[],
  fixS: number,
  fixAtMs: number,
  atMs: number,
): number {
  const base = evalTrack(track, atMs);
  if (track.length === 0 || !(fixS > evalTrack(track, fixAtMs))) return base;
  const reach = crossTrack(track, fixS);
  // Past the whole curve: the phone holds at the fix (it has no more profile).
  if (!Number.isFinite(reach)) return Math.max(base, fixS);
  const tau = reach - fixAtMs;
  return tau > 0 ? evalTrack(track, atMs + tau) : base;
}

/** Instantaneous speed of a kinematic track at t, m/s — exact, because v is
 *  linear inside every emitted segment. Past the last knot the client freezes
 *  the marker, so the RENDERED speed there is 0, not the profile's. */
export function speedAt(track: KinTrack, tMs: number): number {
  const { points, v } = track;
  const n = points.length;
  if (n === 0 || v.length !== n) return 0;
  if (tMs <= points[0].t) return v[0];
  if (tMs >= points[n - 1].t) return 0;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const dt = points[hi].t - points[lo].t;
  if (dt <= 0) return v[hi];
  return v[lo] + ((v[hi] - v[lo]) * (tMs - points[lo].t)) / dt;
}

/** Piecewise-constant acceleration of a kinematic track at t, m/s² — exact,
 *  because v is linear inside every emitted segment (the phase accel is the
 *  slope of v(t)). Outside the knot span the marker stands ⇒ 0. Added for the
 *  curvegen-v3 C¹⁺ seam: the next emission inherits not only (s, v) but the
 *  seam ACCELERATION, so the new drive transitions from it under J_MAX
 *  instead of restarting its jerk state from zero. */
export function accelAt(track: KinTrack, tMs: number): number {
  const { points, v } = track;
  const n = points.length;
  if (n < 2 || v.length !== n) return 0;
  if (tMs <= points[0].t || tMs >= points[n - 1].t) return 0;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const dtS = (points[hi].t - points[lo].t) / 1000;
  return dtS > 0 ? (v[hi] - v[lo]) / dtS : 0;
}

/** Φ⁻¹(p) by bisection over the SAME normalCdf the learned model uses, so the
 *  modal threshold and the two-hypothesis variant can never drift apart. */
function normalQuantile(p: number): number {
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Quantile of the release distribution at which the modal hypothesis flips
 *  from "standing" to "departed" (computed once — TRAJ_MODAL_P is a const). */
const Z_MODAL = normalQuantile(TRAJ_MODAL_P);

/** Instant at which P(departed | elapsed since anchor + time ALREADY observed
 *  standing) crosses TRAJ_MODAL_P under Normal(mean, sd). May be in the past
 *  (⇒ the modal hypothesis is "it already left", and the curve departs from
 *  that instant at learned pace). */
export function modalReleaseMs(
  t0Ms: number,
  standingS: number,
  mean: number,
  sd: number,
): number {
  return Math.round(t0Ms + (mean + Z_MODAL * sd - standingS) * 1000);
}

export interface ModalHold {
  /** Platform position to hold at — the anchor fix's shapeDistM. */
  stopS: number;
  releaseAtMs: number;
  /** Full-learned-pace walk from (stopS, releaseAtMs) evaluated at t. */
  walk: (tMs: number) => number;
}

/** The vehicle's previous published emission, tracks + knot speeds. */
export interface PrevTrack {
  tripId: string;
  smooth: KinTrack;
  opinion: KinTrack;
}

/**
 * §14.7 seam rule: the farthest-ahead position the NEWEST fix cannot exclude,
 * m. The fix proves the tram was at `anchorFixS` at `anchorMs`; since then it
 * can plausibly have travelled `fixAge × vObs`, where vObs is the OBSERVED
 * fix-over-fix speed (evidence, never the model), plus TOL of fix/projection
 * noise. A previous opinion projecting AT OR UNDER this bound is consistent
 * with everything the feed knows — re-anchoring behind it is model
 * disagreement, not evidence, and the phone renders it as a backward teleport
 * at bundle swap (the G13 class). Beyond the bound the old curve provably
 * overshot and an honest backward correction (never below the fix, G10) is
 * exactly what must be shown.
 */
export function seamJustifiedM(args: {
  anchorFixS: number;
  anchorMs: number;
  emittedAtMs: number;
  /** Previous emission's anchor fix position, m (how far the fix moved). */
  prevFixS: number;
  /** Observed gap between the two fixes, s (0/unknown ⇒ vObs 0). */
  fixGapS: number;
}): number {
  const vObs =
    args.fixGapS > 0
      ? Math.min(Math.max((args.anchorFixS - args.prevFixS) / args.fixGapS, 0), TRAJ_V_MAX_MS)
      : 0;
  const fixAgeS = Math.max(0, (args.emittedAtMs - args.anchorMs) / 1000);
  return args.anchorFixS + fixAgeS * vObs + TRAJ_REANCHOR_TOL_M;
}

export interface BuildV2Args {
  key: string;
  tripId: string;
  line: string;
  anchorMs: number;
  emittedAtMs: number;
  /** ML target positions for this fix (already monotone-clamped + rounded,
   *  and — anchor-floor hotfix 2026-08-17 — floored at the anchor fix's
   *  shapeDistM by the caller: the fix is a hard floor, the tram was there
   *  and does not reverse). These are TARGETS, not the emitted curve: the
   *  profile tracks them as closely as the kinematic limits allow. */
  raw: TrackPoint[];
  /** null when the anchor fix is not at_stop (or the stop is unknown). */
  modal: ModalHold | null;
  /** The vehicle's PREVIOUS published emission, or null for a first emission. */
  prev: PrevTrack | null;
  /** Anchor-floor hotfix, age-refresh clause: on an AGE re-emission (same
   *  anchor fix as `prev`) the fresh ML nowcast may jitter BACKWARD with no
   *  new evidence, and the previously rendered opinion position would teleport
   *  back. The caller passes the previously rendered opinion position at
   *  `emittedAtMs`; the whole target curve is floored at it. 0 = no floor
   *  (fix-driven or first emission — a fix-driven re-anchor may honestly move
   *  back TO the fresh fix, never behind it, which the floored `raw` covers). */
  ageFloorS?: number;
  /** §14.7 seam rule inputs — set on FIX-DRIVEN re-emissions only (undefined
   *  otherwise): the new anchor fix position, the PREVIOUS emission's anchor
   *  fix position, and the observed gap between those fixes. When the previous
   *  opinion's projection at `emittedAtMs` is within `seamJustifiedM` of the
   *  new fix, the target curve is floored AT that projection: the phone is
   *  already rendering there and the newest fix cannot prove it wrong, so the
   *  re-anchor continues the curve instead of stepping backward to the nowcast
   *  (the G13 swap-regression class). A modal hold at the anchor (holdingNow)
   *  is CURRENT standing evidence and wins: the honest correction back to the
   *  platform is shown. */
  anchorFixS?: number;
  prevFixS?: number;
  fixGapS?: number;
}

export interface BuiltV2 {
  vehicle: V2Vehicle;
  /** Knot speeds for the two emitted tracks — memory only, never on the wire. */
  opinion: KinTrack;
  smooth: KinTrack;
  /** Anchor-floor hotfix telemetry: the age-refresh floor actually lifted at
   *  least one target sample (i.e. this emission's bytes differ from the
   *  pre-hotfix builder). False whenever ageFloorS is 0/absent. */
  ageFloorApplied: boolean;
  /** §14.7 telemetry: the fix-driven seam floor (continuity at the previous
   *  opinion's projection) actually lifted at least one target sample. */
  seamFloorApplied: boolean;
}

/** Build both tracks for one vehicle. Returns null if any sample is
 *  non-finite (caller drops the vehicle rather than serving a broken curve). */
export function buildV2Vehicle(args: BuildV2Args): BuiltV2 | null {
  const { raw, modal, prev, emittedAtMs: t0 } = args;
  if (raw.length < 2) return null;
  const tEnd = raw[raw.length - 1].t;
  if (!(tEnd > t0)) return null;

  // ── the model's target curve (modal stop rule applied) ───────────────────
  // Anchor-floor hotfix (age-refresh clause): the target never falls behind
  // the previously rendered opinion position on a same-anchor re-emission —
  // a backward jump there is pure model jitter, not evidence. The floor can
  // exceed a still-armed modal hold's stopS only when the release estimate
  // moved later across the refresh; the marker then stands where it was
  // already rendered instead of teleporting back to the platform.
  // §14.7 standing assertion: the hold outranks the continuity floor only
  // when it actually renders standing (release beyond the sliver) — a hold
  // releasing within TRAJ_STAND_ASSERT_MS asserts no standing evidence, and
  // exempting it yanked the seam back to the platform for a blink (the
  // measured 00:34Z G13 leak class).
  const holdingNow = modal !== null && modal.releaseAtMs > t0 + TRAJ_STAND_ASSERT_MS;
  // §14.7 seam floor (fix-driven re-emissions): when the previous opinion's
  // projection at t0 is within `seamJustifiedM` of the NEW fix — i.e. the
  // newest evidence cannot prove the rendered position wrong — the target is
  // floored AT that projection: continuity instead of the backward hop to
  // nowcast ≈ fix + ds(latency) (the measured M1/G13 class: p90 ≈ 75 m of
  // backward step at client swap, 2026-08-18 pre-fix window). Beyond the
  // bound the old curve provably overshot and the honest correction (down to
  // the floored `raw`, never below the fix) is emitted unchanged. A modal
  // hold at the anchor is CURRENT standing evidence and outranks continuity.
  let seamFloorS = 0;
  if (
    !holdingNow &&
    prev !== null &&
    prev.tripId === args.tripId &&
    args.anchorFixS !== undefined &&
    args.prevFixS !== undefined
  ) {
    // Where the PHONE is drawing the previous curve, not where the curve as
    // served sits: the client holds this fix already and winds the curve
    // forward to it (clientProjectionM / src/lib/physics/fixForward.ts).
    const prevO = clientProjectionM(prev.opinion.points, args.anchorFixS, args.anchorMs, t0);
    const justified = seamJustifiedM({
      anchorFixS: args.anchorFixS,
      anchorMs: args.anchorMs,
      emittedAtMs: t0,
      prevFixS: args.prevFixS,
      fixGapS: args.fixGapS ?? 0,
    });
    if (prevO <= justified) seamFloorS = prevO;
  }
  const floorS = Math.max(args.ageFloorS ?? 0, seamFloorS);
  const seamFloorWins = seamFloorS > (args.ageFloorS ?? 0);
  let floorApplied = false;
  const targetAt = (t: number): number => {
    const base =
      modal === null
        ? evalTrack(raw, t)
        : t <= modal.releaseAtMs
          ? modal.stopS
          : Math.max(modal.stopS, modal.walk(t));
    if (base < floorS) {
      floorApplied = true;
      return floorS;
    }
    return base;
  };

  const grid = makeGrid(t0, tEnd);
  const target = sampleMonotone(grid, targetAt);
  if (target === null) return null;
  const holds = findHolds(grid, target);

  // ── opinion ──────────────────────────────────────────────────────────────
  // Starts at the model's own belief for NOW; its velocity is inherited from
  // the previous opinion so a re-anchor cannot produce an instantaneous speed
  // jump either. A vehicle the modal rule says is STANDING starts at 0 —
  // otherwise a fresh at-stop fix would emit a curve that rolls through the
  // platform at the speed the tram had before it stopped.
  const v0Opinion = holdingNow
    ? 0
    : prev !== null && prev.tripId === args.tripId
      ? speedAt(prev.opinion, t0)
      : initialSlope(target, grid);
  const opinion = fitProfile({ grid, target, holds, s0: target[0], v0: v0Opinion });
  if (opinion === null) return null;

  // ── smooth: server-owned continuity ──────────────────────────────────────
  // Same fit, but anchored to where the phone is ALREADY drawing this tram —
  // in position AND in speed — and tracking the opinion instead of the raw
  // model curve. Convergence is therefore a driving manoeuvre subject to the
  // very same limits, not a blend weight (protocol §Extended-convergence).
  let discontinuity = false;
  let smooth = opinion;
  if (prev !== null) {
    const sStart = evalTrack(prev.smooth.points, t0);
    const s0 = opinion.points[0].s;
    if (prev.tripId !== args.tripId || Math.abs(sStart - s0) > TRAJ_DISCONTINUITY_M) {
      discontinuity = true; // honest teleport: trip change or model break
    } else {
      // Track the OPINION curve (already physical) rather than the raw target,
      // so the smooth track converges onto exactly what it is chasing.
      const opinionRef = sampleMonotone(grid, (t) => evalTrack(opinion.points, t));
      if (opinionRef === null) return null;
      const fitted = fitProfile({
        grid,
        target: opinionRef,
        holds: findHolds(grid, opinionRef),
        s0: sStart,
        v0: speedAt(prev.smooth, t0),
      });
      if (fitted === null) return null;
      smooth = fitted;
    }
  }

  return {
    vehicle: {
      key: args.key,
      tripId: args.tripId,
      line: args.line,
      anchorMs: args.anchorMs,
      emittedAtMs: t0,
      discontinuity,
      opinion: opinion.points,
      smooth: smooth.points,
    },
    opinion,
    smooth,
    ageFloorApplied: floorApplied && !seamFloorWins,
    seamFloorApplied: floorApplied && seamFloorWins,
  };
}

// ── kinematic fitting ────────────────────────────────────────────────────────

/** Uniform fine grid [t0 … ≥tEnd] with TRAJ_SIM_STEP_MS spacing. Ceil, so the
 *  emitted horizon can only ever be ≥ the model's own horizon. */
function makeGrid(t0: number, tEnd: number): number[] {
  const n = Math.max(2, Math.ceil((tEnd - t0) / TRAJ_SIM_STEP_MS));
  return Array.from({ length: n + 1 }, (_, i) => t0 + i * TRAJ_SIM_STEP_MS);
}

/** Sample f on the grid, clamped monotone non-decreasing. */
function sampleMonotone(grid: number[], f: (t: number) => number): number[] | null {
  const out: number[] = [];
  let maxS = -Infinity;
  for (const t of grid) {
    const s = f(t);
    if (!Number.isFinite(s)) return null;
    maxS = out.length === 0 ? s : Math.max(maxS, s);
    out.push(maxS);
  }
  return out;
}

function initialSlope(target: number[], grid: number[]): number {
  const dt = (grid[1] - grid[0]) / 1000;
  return clamp((target[1] - target[0]) / dt, 0, TRAJ_V_MAX_MS);
}

/** A stretch of the target curve where the tram is STANDING: a stop (or a
 *  jam, which is kinematically the same thing). `sM` is where it stands,
 *  `endMs` when it is free to leave again. */
interface Hold {
  sM: number;
  endMs: number;
}

/** Maximal runs of near-zero reference speed, ≥ TRAJ_HOLD_MIN_MS long. These
 *  are the things the profile must brake INTO rather than step onto. */
function findHolds(grid: number[], target: number[]): Hold[] {
  const holds: Hold[] = [];
  const dt = (grid[1] - grid[0]) / 1000;
  let runStart = -1;
  for (let i = 0; i < target.length - 1; i++) {
    const standing = (target[i + 1] - target[i]) / dt < TRAJ_HOLD_V_MS;
    if (standing) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      pushHold(holds, grid, target, runStart, i);
      runStart = -1;
    }
  }
  if (runStart >= 0) pushHold(holds, grid, target, runStart, target.length - 1);
  return holds;
}

function pushHold(holds: Hold[], grid: number[], target: number[], from: number, to: number): void {
  if (grid[to] - grid[from] < TRAJ_HOLD_MIN_MS) return;
  holds.push({ sM: target[from], endMs: grid[to] });
}

interface FitArgs {
  grid: number[];
  /** Position the profile should be at, per grid instant. */
  target: number[];
  holds: Hold[];
  s0: number;
  v0: number;
}

/** Fit the closest curve to `target` that a tram could actually drive.
 *
 *  Forward simulation on the fine grid — the only place any control law
 *  lives — then compression of the resulting acceleration signal onto
 *  ≤ TRAJ_MAX_POINTS breakpoints.
 *
 *  Commanded speed at each step:
 *
 *    v* = target's own slope  +  (target − s) / time-left-to-converge
 *    v* = min(v*, √(2·A_BRK·Δs) for every upcoming hold)      [brake envelope]
 *    v* = clamp(v*, 0, V_MAX)
 *    a  = clamp((v* − v)/dt, −A_BRK, +A_ACC)                  [rate limit]
 *
 *  The gap term is what makes this a TRACKER rather than an open-loop replay:
 *  whenever the limits force the curve to fall behind the model (braking early
 *  into a stop, ramping out of one) it catches back up as soon as physics
 *  allows. The brake envelope is what makes catch-up safe — a tram closing a
 *  seam gap can never blast through the platform it is about to stop at.
 *  v ≥ 0 always, so the curve is monotone and never reverses to converge. */
function fitProfile(args: FitArgs): KinTrack | null {
  const { grid, target, holds, s0, v0 } = args;
  const n = grid.length - 1;
  const dt = (grid[1] - grid[0]) / 1000;
  const convergeS = TRAJ_CONVERGE_MS / 1000;

  const sFine = new Array<number>(n + 1);
  const vFine = new Array<number>(n + 1);
  sFine[0] = s0;
  vFine[0] = clamp(v0, 0, TRAJ_V_MAX_MS);

  for (let i = 0; i < n; i++) {
    const s = sFine[i];
    const v = vFine[i];
    const slope = (target[i + 1] - target[i]) / dt;
    // Time left in the convergence window, floored so the demand stays finite;
    // past the window the residual keeps closing on that shorter constant.
    const leftS = Math.max(convergeS - i * dt, TRAJ_CONVERGE_MIN_S);
    let want = slope + (target[i] - s) / leftS;

    for (const h of holds) {
      if (h.endMs <= grid[i]) continue; // the hold is over — free to leave
      if (h.sM <= s) continue; // already past it (or standing in it)
      // √(2·A_BRK·Δs) is the "can still just stop" curve, so following it with
      // a one-step lag guarantees an overshoot. Bite one step of travel out of
      // the distance first: the brake then starts with margin, which is what a
      // driver does anyway.
      const envelope = Math.sqrt(2 * TRAJ_A_BRK * Math.max(0, h.sM - s - v * dt));
      if (envelope < want) want = envelope;
    }
    want = clamp(want, 0, TRAJ_V_MAX_MS);

    let a = clamp((want - v) / dt, -TRAJ_A_BRK, TRAJ_A_ACC);
    let vNext = v + a * dt;
    // Never reverse, never exceed the ceiling: shave `a` instead of clipping
    // v, so the phase stays exactly constant-acceleration.
    if (vNext < 0) {
      a = -v / dt;
      vNext = 0;
    } else if (vNext > TRAJ_V_MAX_MS) {
      a = (TRAJ_V_MAX_MS - v) / dt;
      vNext = TRAJ_V_MAX_MS;
    }
    if (!Number.isFinite(vNext)) return null;
    vFine[i + 1] = vNext;
    sFine[i + 1] = s + ((v + vNext) / 2) * dt; // exact for linear v
  }

  return emit(grid, vFine, sFine);
}

/** Compress the fine acceleration signal onto ≤ TRAJ_MAX_POINTS breakpoints
 *  and re-integrate exactly.
 *
 *  The knots are chosen as a SUBSET of the fine grid, and each emitted phase
 *  takes the constant acceleration that reproduces the fine profile's speed at
 *  both of its ends: a_k = (v[b_{k+1}] − v[b_k]) / Δt_k. That choice is what
 *  makes the contract hold exactly rather than approximately:
 *
 *   • every knot speed is a fine-profile speed ⇒ already in [0, V_MAX], and v
 *     inside a phase is a linear interpolation of two in-range values ⇒ the
 *     segment's mean speed (v_k + v_{k+1})/2 ≤ V_MAX;
 *   • a_k is a time-average of fine accelerations, all of which are inside the
 *     caps ⇒ |a_k| is too, and the client-observable central difference
 *     between two segments is a convex combination of a_k and a_{k+1}.
 *
 *  So the realism gate cannot fail by construction — only by wire rounding,
 *  which the tolerances cover. */
function emit(grid: number[], vFine: number[], sFine: number[]): KinTrack | null {
  const n = grid.length - 1;
  const dtS = (grid[1] - grid[0]) / 1000;

  // Emitting [l, r] as ONE segment renders it as a straight line, i.e. the
  // trapezoid of the two endpoint speeds. The error that introduces — and it
  // is a POSITION error, which then offsets everything downstream — is the
  // difference from what the fine profile actually travelled. Minimising that
  // directly is the whole objective; per-step it is exactly zero, so start
  // from every fine index and greedily drop the cheapest boundary.
  const err = (l: number, r: number): number =>
    Math.abs(((vFine[l] + vFine[r]) / 2) * (r - l) * dtS - (sFine[r] - sFine[l]));

  const bounds: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  const cost = (j: number): number =>
    err(bounds[j - 1], bounds[j + 1]) - err(bounds[j - 1], bounds[j]) - err(bounds[j], bounds[j + 1]);

  // Drop while over budget, and keep dropping while a merge is free — a
  // constant-speed run must collapse to two knots, not pad out to 24.
  const FREE_M = 0.02; // below the wire's own centimetre rounding
  while (bounds.length > 2) {
    let best = 1;
    let bestCost = Infinity;
    for (let j = 1; j < bounds.length - 1; j++) {
      const c = cost(j);
      if (c < bestCost) {
        bestCost = c;
        best = j;
      }
    }
    if (bounds.length <= TRAJ_MAX_POINTS && bestCost > FREE_M) break;
    bounds.splice(best, 1);
  }

  const points: TrackPoint[] = [];
  const v: number[] = [];
  let s = sFine[0];
  for (let k = 0; k < bounds.length; k++) {
    const i = bounds[k];
    if (k > 0) {
      const prev = bounds[k - 1];
      s += ((vFine[prev] + vFine[i]) / 2) * (i - prev) * dtS;
    }
    if (!Number.isFinite(s)) return null;
    points.push({ t: grid[i], s: round2(s) });
    v.push(vFine[i]);
  }
  // round2 is monotone, so `s` cannot decrease; assert cheaply anyway.
  for (let k = 1; k < points.length; k++) {
    if (points[k].s < points[k - 1].s) points[k].s = points[k - 1].s;
  }
  return points.length >= 2 ? { points, v } : null;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
