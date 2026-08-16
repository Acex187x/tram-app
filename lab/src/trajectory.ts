// The physics-v3 trajectory bundle (GET /api/trajectories/v2).
//
// Implements docs/research/physics-v3-protocol.md — the FROZEN client/server
// contract — server-side. Two tracks per vehicle, both plain keyframe
// polylines the client lerps with ONE pure function:
//
//   opinion — the model's current belief: v1-style ml-gbdt keyframes with the
//             MODAL STOP RULE applied. Re-anchors on every fix, may jump.
//   smooth  — the continuity track: starts exactly where the PREVIOUS smooth
//             track said the tram is at this emission instant, then converges
//             onto `opinion` within TRAJ_CONVERGE_MS, monotonically.
//
// Everything expensive is here; the client owns nothing but `evalTrack`.
//
// Modal stop rule (protocol §Modal stop rule): while the learned release model
// says P(departed) < TRAJ_MODAL_P the curve HOLDS at the platform; when the
// threshold crosses it departs at FULL LEARNED PACE. This is the fix for the
// 2026-08-13 owner field report — the mean-optimal expectation floats off the
// platform while the real tram is still standing (README §Findings).

import { round2 } from './db';
import {
  TRAJ_CONVERGE_MS,
  TRAJ_DISCONTINUITY_M,
  TRAJ_MAX_POINTS,
  TRAJ_MODAL_KICK_MS,
  TRAJ_MODAL_P,
} from './config';
import { normalCdf } from './learned';

export interface TrackPoint {
  t: number;
  s: number;
}

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

export interface PrevTrack {
  tripId: string;
  smooth: TrackPoint[];
}

export interface BuildV2Args {
  key: string;
  tripId: string;
  line: string;
  anchorMs: number;
  emittedAtMs: number;
  /** v1 keyframes for this fix (already monotone-clamped + rounded). */
  raw: TrackPoint[];
  /** null when the anchor fix is not at_stop (or the stop is unknown). */
  modal: ModalHold | null;
  /** The vehicle's PREVIOUS published emission, or null for a first emission. */
  prev: PrevTrack | null;
}

/** Build both tracks for one vehicle. Returns null if any sample is
 *  non-finite (caller drops the vehicle rather than serving a broken curve). */
export function buildV2Vehicle(args: BuildV2Args): V2Vehicle | null {
  const { raw, modal, prev, emittedAtMs: t0 } = args;
  if (raw.length < 2) return null;
  const tEnd = raw[raw.length - 1].t;

  // ── time grid: the v1 base grid + knots at the modal kink ────────────────
  const times = raw.map((p) => Math.round(p.t));
  if (modal) {
    insertTime(times, modal.releaseAtMs, t0, tEnd);
    insertTime(times, modal.releaseAtMs + TRAJ_MODAL_KICK_MS, t0, tEnd);
  }

  // ── opinion ──────────────────────────────────────────────────────────────
  const opinionAt = (t: number): number =>
    modal === null
      ? evalTrack(raw, t)
      : t <= modal.releaseAtMs
        ? modal.stopS
        : Math.max(modal.stopS, modal.walk(t));
  const opinion = sampleMonotone(times, opinionAt);
  if (opinion === null) return null;

  // ── smooth: server-owned continuity ──────────────────────────────────────
  let discontinuity = false;
  let smooth: TrackPoint[] = opinion;
  if (prev !== null) {
    // Where the phone is drawing this tram RIGHT NOW, from the curve it holds.
    const sStart = evalTrack(prev.smooth, t0);
    const s0 = opinion[0].s;
    if (prev.tripId !== args.tripId || Math.abs(sStart - s0) > TRAJ_DISCONTINUITY_M) {
      discontinuity = true; // honest teleport: trip change or model break
    } else if (sStart <= s0) {
      // Rendered position is BEHIND the opinion — converge forward over
      // TRAJ_CONVERGE_MS. S = opinion − δ·(1−w) is monotone for δ ≥ 0 and w↑,
      // and S(t0) = sStart, S(t0 + converge) = opinion exactly.
      const delta = s0 - sStart;
      const blended = sampleMonotone(times, (t) => {
        const w = Math.min(1, Math.max(0, (t - t0) / TRAJ_CONVERGE_MS));
        return evalTrack(opinion, t) - delta * (1 - w);
      });
      if (blended === null) return null;
      smooth = blended;
    } else {
      // Rendered position is AHEAD of the opinion. Trams don't drive
      // backwards: HOLD until the opinion catches up (the protocol's explicit
      // exception to the ≤30 s convergence bound).
      const held = times.slice();
      const cross = crossingTime(opinion, sStart);
      if (cross !== null) insertTime(held, cross, t0, tEnd);
      const blended = sampleMonotone(held, (t) => Math.max(sStart, evalTrack(opinion, t)));
      if (blended === null) return null;
      smooth = blended;
    }
  }

  return {
    key: args.key,
    tripId: args.tripId,
    line: args.line,
    anchorMs: args.anchorMs,
    emittedAtMs: t0,
    discontinuity,
    opinion,
    smooth,
  };
}

/** Insert a kink knot in sorted position (strictly inside the horizon, never
 *  within 250 ms of an existing knot, never past the ≤24-point cap). */
function insertTime(times: number[], t: number, loMs: number, hiMs: number): void {
  const v = Math.round(t);
  if (!(v > loMs && v < hiMs)) return;
  if (times.length >= TRAJ_MAX_POINTS) return;
  let i = 0;
  while (i < times.length && times[i] < v) i++;
  if (i < times.length && times[i] - v < 250) return;
  if (i > 0 && v - times[i - 1] < 250) return;
  times.splice(i, 0, v);
}

/** Sample f on the grid, clamped monotone non-decreasing (the client lerps
 *  blindly, so the emitted curve — not the generator — must be monotone). */
function sampleMonotone(times: number[], f: (t: number) => number): TrackPoint[] | null {
  const out: TrackPoint[] = [];
  let maxS = -Infinity;
  for (const t of times) {
    const s = f(t);
    if (!Number.isFinite(s)) return null;
    maxS = out.length === 0 ? s : Math.max(maxS, s);
    out.push({ t, s: round2(maxS) });
  }
  return out;
}

/** First instant at which a keyframe track reaches `target` (linear inside
 *  the segment), or null if it never does within the horizon. */
function crossingTime(track: TrackPoint[], target: number): number | null {
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    if (a.s < target && b.s >= target) {
      const dS = b.s - a.s;
      if (dS <= 0) return b.t;
      return Math.round(a.t + ((target - a.s) / dS) * (b.t - a.t));
    }
  }
  return null;
}
