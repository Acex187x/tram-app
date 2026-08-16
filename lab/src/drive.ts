// Curve generation v3 — the virtual tram (docs/research/curvegen-v3-design.md).
//
// Replaces trajectory.ts's fitProfile/findHolds curve construction: instead of
// tracking the ML's noisy per-horizon positions, a server-side virtual tram is
// DRIVEN down the real geometry — the old engine's driver re-hosted at
// generation time (curvature speed limits, braking envelope, learned pace,
// modal holds, smoother regimes), with the ML demoted from position oracle to
// TIMETABLE: it times the legs, physics draws the motion (design §2).
//
// Descent map (§2): the constraint stack is lab/vendor/engine/speedProfile.ts
// verbatim minus zone caps (superseded by the learned pace surface) plus a
// jerk-onset margin; anchor hold + release is the unchanged modal stop rule;
// downstream dwells come from LearnedModel.dwellAt clamped like learned.walk;
// the smooth track is smoother.ts's regime table (track / catch-up / yield /
// hold-follow, hysteresis, observed-pace catch-up ceiling) transplanted to
// generation time against the opinion curve; the discontinuity trigger is
// tramSim's gap-aware teleportThresholdM rescaled (§7). The jerk limit is new
// (EN 13452-1 comfort band, §5).
//
// The wire is untouched: this module emits the same V2Vehicle two-track shape
// through the same ≤24-knot compression contract (§11 adds knot protection +
// near-term weighting). Ships SHADOW-FIRST behind TRAJ_V3_PUBLISH (§12).

import type { RouteGeometry } from '@/lib/types';
import { curvatureProfile, segmentIndexAt } from '@/lib/geo/polyline';
import {
  DEFAULT_PACE_MS,
  TRAJ_A_ACC,
  TRAJ_A_BRK,
  TRAJ_J_MAX,
  TRAJ_MAX_POINTS,
  TRAJ_SIM_STEP_MS,
  TRAJ_V_MAX_MS,
} from './config';
import { round2 } from './db';
import {
  accelAt,
  evalTrack,
  speedAt,
  type KinTrack,
  type PrevTrack,
  type TrackPoint,
  type V2Vehicle,
} from './trajectory';

// ── constants (design §10 parameter table) ───────────────────────────────────
// "port" = inherited from the vendored engine with its original evidence;
// "new" = introduced by the design, pre-registered for tuning by the gates.

/** Lateral comfort acceleration for curve caps, m/s² (port: speedProfile A_LAT). */
export const A_LAT = 0.98;
/** Measured p90 envelope vs ride GPS through curves (port, analysis-2026-07-20 §2). */
export const CURVE_SLOW_FACTOR = 0.85;
/** Lower clamp for curve caps, m/s (port). */
export const V_CURVE_MIN_MS = 1.4;
/** Profile clamp: 50 km/h network cap (port: speedProfile V_MAX_MS). The 16.7
 *  wire bound is never approached — this is the drive's own ceiling. */
export const V_LIMIT_MAX = 13.9;
/** Braking-envelope lookahead, m (port). */
export const DEFAULT_LOOKAHEAD_M = 400;
/** Vertex limits stay active this far BEHIND the head, m (port: the body is
 *  still on the curve when the head has passed its apex). */
export const TRAIL_LIMIT_M = 15;
/** Accel/brake build times under J_MAX, s (derived: A/J, design §5). */
export const T_ACC_BUILD_S = TRAJ_A_ACC / TRAJ_J_MAX; // ≈ 1.63
export const T_BRK_BUILD_S = TRAJ_A_BRK / TRAJ_J_MAX; // = 1.75
/** ML leg-pace trust region around the learned surface (new, tightened from
 *  the paceBias ratio clamp [0.4, 1.6]). */
export const PACE_CLAMP_LO = 0.5;
export const PACE_CLAMP_HI = 1.5;
/** ML positional trim gain, m (port: smoother PACE_GAIN_M). */
export const G_ML = 120;
/** Trim authority: the smoother's track clamp tightened to ±15 % (new). */
export const TRIM_AUTH = 0.15;
/** Downstream learned-dwell clamp, s (port: learned.walk's sticky-hold defense). */
export const DWELL_MIN_S = 5;
export const DWELL_CAP_S = 40;
/** Smooth-track regime constants (port: smoother.ts, verbatim). */
export const PACE_GAIN_M = 120;
export const TRACK_MIN_FACTOR = 0.7;
export const TRACK_MAX_FACTOR = 1.35;
export const CATCH_ENTER_M = 40; // smoother TRACK_BAND_M
export const YIELD_ENTER_M = -40;
export const YIELD_EXIT_M = -12;
export const YIELD_FACTOR = 0.5;
export const YIELD_MIN_V_MS = 3.0;
/** Catch-up ceiling anchor: measured p90/p50 free-running ratio (port). The
 *  ceiling is CATCH_HEADROOM × the learned pace surface — observed sprint
 *  pace, never the legal cap (the night-centre lesson). */
export const CATCH_HEADROOM = 1.9;
/** Catch-up demand: surplus = min(DV_CATCH_MAX, gap / T_CLOSE) (new — replaces
 *  the 30 s blend window as the *demand* constant; §6 math: 40 m → ~10 s).
 *  Both tuned to the decisive edge of their pre-registered bands (T_CLOSE
 *  8–15, DV 4–7) after the first live G5 window read p50 21.5 s / p90 42.5 s
 *  against the 12/28 gates — night seams often start from a standing smooth
 *  (jerk-limited spin-up eats ~8 s before any surplus exists), so the demand
 *  side gets no slack. The CATCH_HEADROOM ceiling still binds first on slow
 *  corridors, by design. */
export const T_CLOSE_S = 8;
export const DV_CATCH_MAX = 7.0;
/** Gap-aware discontinuity threshold (design §7; descends from tramSim's
 *  teleportThresholdM with floor/cap rescaled to the drive's close-out
 *  ability). Replaces the flat TRAJ_DISCONTINUITY_M = 150 for the v3 drive. */
export const DISC_FLOOR_M = 350;
export const DISC_CAP_M = 1200;
export const DISC_MARGIN = 1.25;
export const DISC_GAP_MIN_S = 45;
export const DISC_GAP_MAX_S = 240;
/** A stop is "reached" within this of its distM, m (port: tramSim STOP_REACH_M). */
export const STOP_REACH_M = 2;
/** Hold entry zeroes the speed inside one sim step; with the S-curve landing
 *  floor the tram reaches the platform with |a| ≤ √(2·J·v), so entering from
 *  ≤ this keeps the entry's wire jerk under the gate. Above it the sim simply
 *  keeps integrating — the envelope + landing floor decay the speed and the
 *  entry fires a step or two later. */
export const HOLD_ENTRY_V_MAX = 0.8;
/** Arriving at a planned hold faster than this means the plan was infeasible
 *  from the seam state (e.g. a backward re-anchor placed a stop inside the
 *  braking distance) — the stop is rolled through and counted, never slammed
 *  into. */
export const SKIP_V_MAX = 3.0;
/** Near-term compression weight half-point, s: w(t) = 1/(1 + (t−t_E)/45)
 *  (new, §11 — the far half of the horizon is repainted by the next emission). */
export const COMPRESS_W_HALF_S = 45;
/** Free-merge threshold on the WEIGHTED cost (kept from emit(): below the
 *  wire's centimetre rounding; the weight can stretch it to ~7 cm at +120 s). */
const FREE_M = 0.02;

const DT_S = TRAJ_SIM_STEP_MS / 1000;

// ── per-shape speed profile (curve caps only — zone caps are DEAD, §4.1) ─────

export interface DriveProfile {
  /** Per-vertex curve cap, m/s (same length as geometry.coordinates). */
  vLimit: number[];
}

/** curveCap(κ) — speedProfile.ts verbatim: CURVE_SLOW_FACTOR·√(A_LAT/κ),
 *  clamped to [V_CURVE_MIN_MS, V_LIMIT_MAX]. */
export function curveCap(kappa: number): number {
  if (kappa <= 1e-9) return V_LIMIT_MAX;
  const v = CURVE_SLOW_FACTOR * Math.sqrt(A_LAT / kappa);
  return Math.min(V_LIMIT_MAX, Math.max(V_CURVE_MIN_MS, v));
}

/** Build the per-vertex profile for a geometry (no zone caps — the daytime
 *  centre bbox was a hand proxy for what paceAt now measures). */
export function buildDriveProfile(geom: RouteGeometry): DriveProfile {
  const kappa = curvatureProfile(geom.coordinates, geom.cumDistM);
  const vLimit = new Array<number>(geom.coordinates.length);
  for (let i = 0; i < geom.coordinates.length; i++) vLimit[i] = curveCap(kappa[i]);
  return { vLimit };
}

/** Cached beside the geometry object itself: a geometry refresh replaces the
 *  object in GeometryStore.mem, so the profile is rebuilt exactly then. */
const profileCache = new WeakMap<RouteGeometry, DriveProfile>();

export function driveProfileFor(geom: RouteGeometry): DriveProfile {
  let p = profileCache.get(geom);
  if (!p) {
    p = buildDriveProfile(geom);
    profileCache.set(geom, p);
  }
  return p;
}

/** Cruise reference cap at s: max of the segment's endpoint limits, so a low
 *  vertex acts as a *point* constraint via the envelope (port semantics). */
export function cruiseCapAt(profile: DriveProfile, geom: RouteGeometry, sM: number): number {
  const cum = geom.cumDistM;
  const n = cum.length;
  if (n === 0) return V_LIMIT_MAX;
  const s = Math.min(Math.max(sM, 0), geom.totalM);
  const i = segmentIndexAt(cum, s);
  return n > 1
    ? Math.max(profile.vLimit[i], profile.vLimit[Math.min(i + 1, n - 1)])
    : profile.vLimit[0];
}

/**
 * CURVE-ONLY envelope at s (no stops, no jerk margin): the checker's version
 * of §4.1 — min over vertices in [s − TRAIL, s + LOOKAHEAD] of
 * (d ≤ s ? vLimit : √(vLimit² + 2·A_BRK·(d−s))), ∧ cruiseCap ∧ V_LIMIT_MAX.
 * Used by the G4 gate: an emitted segment's mean speed is the instantaneous
 * speed at its midpoint, so it is compared against THIS at the segment's
 * positional midpoint. The builder's runtime envelope additionally bites the
 * jerk-onset margin out of the distance — conservatism, not the gate.
 */
export function curveEnvAt(profile: DriveProfile, geom: RouteGeometry, sM: number): number {
  const cum = geom.cumDistM;
  const n = cum.length;
  if (n === 0) return V_LIMIT_MAX;
  const s = Math.min(Math.max(sM, 0), geom.totalM);
  let v = Math.min(V_LIMIT_MAX, cruiseCapAt(profile, geom, s));
  const horizon = s + DEFAULT_LOOKAHEAD_M;
  for (let j = segmentIndexAt(cum, Math.max(0, s - TRAIL_LIMIT_M)); j < n; j++) {
    const d = cum[j];
    if (d < s - TRAIL_LIMIT_M) continue;
    if (d > horizon) break;
    const lim = profile.vLimit[j];
    if (lim >= v) continue;
    const cand = d <= s ? lim : Math.sqrt(lim * lim + 2 * TRAJ_A_BRK * (d - s));
    if (cand < v) v = cand;
  }
  return v;
}

// ── ML-as-timetable adapter (design §3, §4.3) ────────────────────────────────

/** First instant the monotone ML curve reaches sTarget, ms — crossing times
 *  integrate over many knots, so they are stable where finite-difference
 *  slopes are regression noise. null when never reached within the horizon. */
export function mlCrossingMs(raw: TrackPoint[], sTarget: number): number | null {
  if (raw.length === 0) return null;
  if (raw[0].s >= sTarget) return raw[0].t;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].s >= sTarget) {
      const a = raw[i - 1];
      const b = raw[i];
      const ds = b.s - a.s;
      if (ds <= 1e-9) return b.t;
      return a.t + ((sTarget - a.s) / ds) * (b.t - a.t);
    }
  }
  return null;
}

/** Mean slope of the last 30 s of the ML curve, m/s — the pace for the
 *  stretch past the last crossed stop (§3.3). */
export function mlTailPace(raw: TrackPoint[]): number {
  const n = raw.length;
  if (n < 2) return 0;
  const tEnd = raw[n - 1].t;
  const t0 = Math.max(raw[0].t, tEnd - 30_000);
  const dtS = (tEnd - t0) / 1000;
  if (dtS <= 0) return 0;
  return Math.max(0, (raw[n - 1].s - evalTrack(raw, t0)) / dtS);
}

/**
 * Kinematic floor on one leg's travel time, s (design §4.3 T_kin): the time at
 * full A_ACC/A_BRK with symmetric jerk-limited S-ramps between the boundary
 * speeds, capped at vCap. Under the symmetric-S model a ramp of Δv takes
 * Δv/A + A/J and covers mean-speed × duration, so the peak speed solves by
 * bisection (deterministic, ~40 iterations, once per leg). An impossible ML τ
 * extends the leg to this floor — it never speeds the drive beyond physics.
 */
export function legKinFloorS(legLenM: number, vStartMs: number, vEndMs: number, vCap: number = V_LIMIT_MAX): number {
  const L = Math.max(0, legLenM);
  if (L <= 1e-6) return 0;
  const v0 = Math.max(0, Math.min(vStartMs, TRAJ_V_MAX_MS));
  const v1 = Math.max(0, Math.min(vEndMs, TRAJ_V_MAX_MS));
  const lo0 = Math.max(v0, v1);
  const hi0 = Math.max(lo0, vCap);
  const ramps = (vp: number): { t: number; d: number } => {
    const dvA = Math.max(0, vp - v0);
    const dvB = Math.max(0, vp - v1);
    const tA = dvA > 1e-9 ? dvA / TRAJ_A_ACC + T_ACC_BUILD_S : 0;
    const tB = dvB > 1e-9 ? dvB / TRAJ_A_BRK + T_BRK_BUILD_S : 0;
    return { t: tA + tB, d: ((v0 + vp) / 2) * tA + ((vp + v1) / 2) * tB };
  };
  // Even the lowest legal peak may overshoot L (seam faster than the leg can
  // absorb): the floor is then the plain traversal at the boundary mean.
  if (ramps(lo0).d >= L) return L / Math.max(1, (v0 + v1) / 2 || 1);
  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ramps(mid).d <= L) lo = mid;
    else hi = mid;
  }
  const r = ramps(lo);
  const cruise = lo > 0.1 ? Math.max(0, L - r.d) / lo : 0;
  return r.t + cruise;
}

// ── the drive ────────────────────────────────────────────────────────────────

export interface DriveSurfaces {
  /** Learned pace surface at (s, wall time), m/s (LearnedModel.paceAt). */
  paceAt(sM: number, atMs: number): number;
  /** Learned per-stop dwell at wall time, s, UNclamped (LearnedModel.dwellAt). */
  dwellAt(stopId: string, atMs: number): number;
}

export interface DriveArgs {
  key: string;
  tripId: string;
  line: string;
  anchorMs: number;
  emittedAtMs: number;
  /** ML target positions (monotone-clamped) — consumed as TIMING, not as a
   *  position reference (§3): nowcast anchor, leg crossing times, tail pace,
   *  ±TRIM_AUTH positional trim. */
  raw: TrackPoint[];
  /** Modal anchor hold (unchanged rule); the drive needs only stopS + release. */
  modal: { stopS: number; releaseAtMs: number } | null;
  geom: RouteGeometry;
  surfaces: DriveSurfaces;
  /** Previous emission of the SAME chain (published or shadow), for seams. */
  prev: PrevTrack | null;
  /** Observed gap between the last two fixes, s (0 when unknown) — T_disc. */
  fixGapS: number;
}

export interface TrackBuildMeta {
  knots: number;
  /** §11: protected knots dropped farthest-first because the protected set
   *  alone exceeded the budget (pathological; the pressure gauge). */
  pressureDrops: number;
  /** Budget-forced merges happened (fine breakpoints exceeded 24 with real
   *  position cost — i.e. compression actually bit, not just free merges). */
  budgetForced: boolean;
  /** G4, generator-exact: emitted segments whose mean speed exceeds the curve
   *  envelope at the segment midpoint by more than cap·1.05 + 0.3. */
  curveViolations: number;
  /** G7: emitted-knot local v-minima ≥1 m/s below both neighbours with no
   *  binding constraint tagged and not at a hold. */
  phantomDips: number;
  /** Planned holds rolled through because the seam state made them
   *  kinematically unreachable (see HOLD_ENTRY_V_MAX). */
  infeasibleSkips: number;
}

export interface DriveBuilt {
  vehicle: V2Vehicle;
  opinion: KinTrack;
  smooth: KinTrack;
  meta: {
    discKind: 'none' | 'trip' | 'gap';
    /** The T_disc threshold applied at this emission, m (null: first emission). */
    tDiscM: number | null;
    /** |prev smooth(t_E) − new opinion(t_E)| before the decision, m. */
    seamGapM: number | null;
    opinion: TrackBuildMeta;
    smooth: TrackBuildMeta;
  };
}

/** Gap-aware discontinuity threshold (§7), re-anchored on the learned surface. */
export function discThresholdM(fixGapS: number, paceMs: number): number {
  const gap = Math.min(DISC_GAP_MAX_S, Math.max(DISC_GAP_MIN_S, fixGapS));
  const pace = Math.max(paceMs, DEFAULT_PACE_MS);
  return Math.min(DISC_CAP_M, Math.max(DISC_FLOOR_M, gap * pace * DISC_MARGIN));
}

/** One planned stop of the drive (downstream platform to SERVE, §4.2). */
interface PlanStop {
  distM: number;
  stopId: string;
}

/** Everything one forward sim produces (fine arrays feed the smooth re-run
 *  and the compressor; nothing here reaches the wire directly). */
interface FineRun {
  s: number[];
  v: number[];
  /** Standing position per step (NaN = moving) — the smooth run's hold-follow
   *  reference and the compressor's hold knots. */
  holdPos: number[];
  /** Which constraint bound each step: envelope terms ('curve'/'hold'), a
   *  commanded regime reduction ('regime' — yield / hold-follow braking, a
   *  documented manoeuvre, not noise), or 'none' = plain guidance. */
  binding: ('none' | 'curve' | 'hold' | 'regime')[];
  /** Per plan-stop index: sim ms the drive DEPARTS it (Infinity = not reached
   *  within the horizon; 0 = not part of this run's plan / already behind). */
  departMs: number[];
  /** Modal-release / dwell-exit / hold-entry steps — protected knots (§11). */
  protectedSteps: Set<number>;
  infeasibleSkips: number;
}

interface OpinionRef {
  fine: FineRun;
  /** Gate per plan stop for the smooth run: the smooth may pass stop i freely
   *  once grid[t] ≥ gateMs[i]; before that the stop is a live hold. */
  gateMs: number[];
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Uniform fine grid [t0 … ≥tEnd], TRAJ_SIM_STEP_MS spacing (ceil ⇒ horizon
 *  can only ever be ≥ the ML's own). Same semantics as trajectory.makeGrid. */
function makeGrid(t0: number, tEnd: number): number[] {
  const n = Math.max(2, Math.ceil((tEnd - t0) / TRAJ_SIM_STEP_MS));
  return Array.from({ length: n + 1 }, (_, i) => t0 + i * TRAJ_SIM_STEP_MS);
}

/**
 * THE forward sim (design §4): 1 s grid, state (s, v, a); guidance commands a
 * speed, the constraint stack clamps it, acceleration is rate- and
 * jerk-limited, integration is exact for linear v. Two guidance modes share
 * every constraint:
 *   'ladder'  — opinion: leg-pace ladder timed by ML crossings + bounded trim;
 *   'regimes' — smooth: smoother.ts regime table against the opinion run.
 */
function runDrive(args: {
  grid: number[];
  geom: RouteGeometry;
  profile: DriveProfile;
  surfaces: DriveSurfaces;
  raw: TrackPoint[];
  plan: PlanStop[];
  /** Initial hold (modal anchor): stand at s0 until this ms (null = moving). */
  initialHoldEndMs: number | null;
  s0: number;
  v0: number;
  a0: number;
  mode: 'ladder' | 'regimes';
  /** 'regimes' only: the opinion run + per-stop gates. */
  ref?: OpinionRef;
}): FineRun | null {
  const { grid, geom, profile, surfaces, raw, plan, mode, ref } = args;
  const n = grid.length - 1;
  const cum = geom.cumDistM;
  const total = geom.totalM;
  const t0 = grid[0];

  const s = new Array<number>(n + 1);
  const v = new Array<number>(n + 1);
  const holdPos = new Array<number>(n + 1).fill(NaN);
  const binding = new Array<'none' | 'curve' | 'hold' | 'regime'>(n + 1).fill('none');
  const departMs = new Array<number>(plan.length).fill(mode === 'ladder' ? Infinity : 0);
  const protectedSteps = new Set<number>();
  let infeasibleSkips = 0;

  s[0] = clamp(args.s0, 0, total);
  v[0] = clamp(args.v0, 0, TRAJ_V_MAX_MS);
  let a = clamp(args.a0, -TRAJ_A_BRK, TRAJ_A_ACC);

  // Skip plan stops already at/behind the start (the anchor stop after a
  // released modal hold, or everything behind a fresh seam position).
  let nextStop = 0;
  while (nextStop < plan.length && plan[nextStop].distM <= s[0] + STOP_REACH_M) nextStop++;

  let mode2: 'drive' | 'hold' = args.initialHoldEndMs !== null ? 'hold' : 'drive';
  let holdEndMs = args.initialHoldEndMs ?? 0;
  let holdAtM = s[0];
  if (mode2 === 'hold') {
    v[0] = 0;
    a = 0;
    holdPos[0] = holdAtM;
    protectedSteps.add(0);
  }
  /** Which plan stop the current hold belongs to (−1 = modal anchor hold). */
  let holdStopIdx = -1;

  // Ladder leg state, recomputed at each departure event (§4.3: depart_k is
  // the sim's OWN departure instant).
  let legPace = 0;
  let legDwellS = 0; // budgeted dwell at the current leg's END stop
  const tailPace = mlTailPace(raw);
  const startLeg = (sFrom: number, tDepMs: number, vAtDep: number): void => {
    if (mode !== 'ladder') return;
    const target = nextStop < plan.length ? plan[nextStop] : null;
    if (target === null) {
      const paceRef = surfaces.paceAt(sFrom + 100, tDepMs);
      legPace = clamp(tailPace, PACE_CLAMP_LO * paceRef, PACE_CLAMP_HI * paceRef);
      legDwellS = 0;
      return;
    }
    const legLen = Math.max(0, target.distM - sFrom);
    const paceRef = surfaces.paceAt(sFrom + legLen / 2, tDepMs);
    const tau = mlCrossingMs(raw, target.distM);
    legDwellS = clamp(surfaces.dwellAt(target.stopId, tau ?? tDepMs), DWELL_MIN_S, DWELL_CAP_S);
    if (legLen < 1) {
      legPace = paceRef;
      return;
    }
    let p: number;
    if (tau === null) {
      p = tailPace; // past the last ML-crossed stop: the tail carries the pace
    } else {
      // 0.5·D: the ML expectation crosses a platform mid-dwell on average, so
      // half the budgeted dwell belongs to the crossing itself (§4.3).
      const tKin = legKinFloorS(legLen, vAtDep, 0);
      const tAvail = Math.max(tKin, (tau - tDepMs) / 1000 - 0.5 * legDwellS);
      p = legLen / Math.max(1e-3, tAvail);
    }
    legPace = clamp(p, PACE_CLAMP_LO * paceRef, PACE_CLAMP_HI * paceRef);
  };
  if (mode2 === 'drive') startLeg(s[0], t0, v[0]);

  // 'regimes': yield hysteresis latch (smoother.ts verbatim semantics).
  let yielding = false;

  for (let i = 0; i < n; i++) {
    const tMs = grid[i];

    // ── hold: stand; release when the hold's end passes ──────────────────────
    if (mode2 === 'hold') {
      if (tMs >= holdEndMs) {
        mode2 = 'drive';
        protectedSteps.add(i);
        if (holdStopIdx >= 0 && mode === 'ladder') departMs[holdStopIdx] = tMs;
        holdStopIdx = -1;
        startLeg(s[i], tMs, 0);
        // fall through into the drive step — departure accelerates from here
      } else {
        s[i + 1] = s[i];
        v[i + 1] = 0;
        a = 0;
        holdPos[i + 1] = holdAtM;
        continue;
      }
    }

    const sI = s[i];
    const vI = v[i];

    // ── guidance: commanded speed before constraints ─────────────────────────
    let vCmd: number;
    if (mode === 'ladder') {
      const m = evalTrack(raw, tMs);
      const trim = clamp(1 + (m - sI) / G_ML, 1 - TRIM_AUTH, 1 + TRIM_AUTH);
      vCmd = legPace * trim;
    } else {
      const rf = ref!;
      const o = rf.fine.s[i];
      const vO = rf.fine.v[i];
      const oHold = rf.fine.holdPos[i];
      const g = o - sI;
      if (!Number.isNaN(oHold)) {
        // hold-follow: the reference is the POINT the opinion stands at.
        // Tagged 'regime': braking onto a standing reality is a commanded
        // manoeuvre — its release transient must never read as a phantom dip.
        yielding = false;
        binding[i] = 'regime';
        const d = oHold - sI;
        if (d > 0) {
          const ceil = Math.min(
            CATCH_HEADROOM * surfaces.paceAt(sI, tMs),
            TRAJ_V_MAX_MS,
          );
          vCmd = Math.min(Math.sqrt(2 * TRAJ_A_BRK * Math.max(0, d)), ceil);
        } else {
          vCmd = 0; // at/ahead of a standing reality: stand (honest)
        }
      } else {
        if (yielding) {
          if (g > YIELD_EXIT_M) yielding = false;
        } else if (g < YIELD_ENTER_M) {
          yielding = true;
        }
        if (yielding) {
          // never pedestrian, never reverse, never a phantom mid-street stand
          binding[i] = 'regime';
          vCmd = Math.max(YIELD_MIN_V_MS, YIELD_FACTOR * vO);
        } else if (g > CATCH_ENTER_M) {
          const ceil = Math.min(CATCH_HEADROOM * surfaces.paceAt(sI, tMs), TRAJ_V_MAX_MS);
          vCmd = Math.min(vO + Math.min(DV_CATCH_MAX, g / T_CLOSE_S), ceil);
        } else {
          vCmd = vO * clamp(1 + g / PACE_GAIN_M, TRACK_MIN_FACTOR, TRACK_MAX_FACTOR);
        }
      }
    }
    vCmd = clamp(vCmd, 0, TRAJ_V_MAX_MS);

    // ── constraint stack (§4.1) — never violated ─────────────────────────────
    // Jerk-onset margin, generalized to the CURRENT accel state: a stop from
    // (v, a) under jerk J costs ≈ v²/(2·A_BRK) + v·(max(0,a)+A_BRK)²/(2·J·A_BRK)
    // — at a = 0 the second term is exactly the design's v·T_BRK_BUILD/2 (§5);
    // at a = +A_ACC the full −reversal takes (A_ACC+A_BRK)/J = 3.4 s (§5's own
    // number) and the margin must carry it, or a catch-up tram sails into a
    // curve dip above its cap (measured live 2026-08-16: 9 m/s across a
    // 3.9 m/s junction). The extra v·dt bites one sim step of travel out of
    // the distance — following an exact envelope with a one-step lag
    // guarantees an overshoot (the previous generator documented the same
    // bite). Within `margin` of a limit point the vertex term degrades to the
    // bare cap, so the demand flattens at `lim` before the apex and the
    // one-step follow lag decays on the flat, not inside the dip.
    const margin =
      vI * ((Math.max(0, a) + TRAJ_A_BRK) ** 2 / (2 * TRAJ_J_MAX * TRAJ_A_BRK) + DT_S);
    const slack = (d: number): number => Math.max(0, d - sI - margin);
    let envCurve = Math.min(V_LIMIT_MAX, cruiseCapAt(profile, geom, sI));
    {
      const horizon = sI + DEFAULT_LOOKAHEAD_M;
      const nV = cum.length;
      for (let j = segmentIndexAt(cum, Math.max(0, sI - TRAIL_LIMIT_M)); j < nV; j++) {
        const d = cum[j];
        if (d < sI - TRAIL_LIMIT_M) continue;
        if (d > horizon) break;
        const lim = profile.vLimit[j];
        if (lim >= envCurve) continue;
        const cand = d <= sI ? lim : Math.sqrt(lim * lim + 2 * TRAJ_A_BRK * slack(d));
        if (cand < envCurve) envCurve = cand;
      }
    }
    let envHold = Infinity;
    {
      const horizon = sI + DEFAULT_LOOKAHEAD_M;
      for (let k = nextStop; k < plan.length; k++) {
        const d = plan[k].distM;
        if (d > horizon) break;
        if (d < sI) continue;
        // 'regimes': a stop the opinion has already departed is no live hold —
        // the smooth rolls through (dwell-sync semantics; no re-dwelling).
        if (mode === 'regimes' && tMs >= ref!.gateMs[k]) continue;
        const cand = Math.sqrt(2 * TRAJ_A_BRK * slack(d));
        if (cand < envHold) envHold = cand;
      }
      if (total <= horizon) {
        const cand = Math.sqrt(2 * TRAJ_A_BRK * slack(total));
        if (cand < envHold) envHold = cand;
      }
      if (mode === 'regimes') {
        // "envelope captures the platform": the opinion's standing point is a
        // live 0-limit for the smooth — hold-follow's brake-onto-the-point
        // must not rely on the guidance term alone (one-step lag overshoots).
        const oh = ref!.fine.holdPos[i];
        if (!Number.isNaN(oh) && oh >= sI) {
          const cand = Math.sqrt(2 * TRAJ_A_BRK * slack(oh));
          if (cand < envHold) envHold = cand;
        }
      }
    }
    const env = Math.min(envCurve, envHold);
    if (env < vCmd) {
      binding[i] = envHold <= envCurve ? 'hold' : 'curve';
      vCmd = env;
    }

    // ── accel: rate-, jerk- and landing-limited; integrate (exact, linear v) ─
    let aDes = clamp((vCmd - vI) / DT_S, -TRAJ_A_BRK, TRAJ_A_ACC);
    // S-curve landing floor: the deepest decel that still reaches v = 0 with
    // a → 0 under jerk J is a = −√(2·J·v) (da/dt along it is exactly −J). It
    // binds only below ~A_BRK²/2J ≈ 1.2 m/s, shaping every stop's last metre
    // into the S-tail — without it the demand pins a at full brake while v
    // crosses zero and the release prints a >J wire jerk at every platform.
    aDes = Math.max(aDes, -Math.sqrt(2 * TRAJ_J_MAX * Math.max(0, vI)));
    aDes = clamp(aDes, a - TRAJ_J_MAX * DT_S, a + TRAJ_J_MAX * DT_S);
    let vN = vI + aDes * DT_S;
    if (vN < 0) {
      aDes = -vI / DT_S;
      vN = 0;
    } else if (vN > TRAJ_V_MAX_MS) {
      aDes = (TRAJ_V_MAX_MS - vI) / DT_S;
      vN = TRAJ_V_MAX_MS;
    }
    a = aDes;
    const sN = sI + ((vI + vN) / 2) * DT_S;
    if (!Number.isFinite(sN) || !Number.isFinite(vN)) return null;

    // ── stop service (§4.2): brake in on the envelope, stand, depart ─────────
    // POSITION IS NEVER CLAMPED: emit() re-integrates s from the trapezoids of
    // vFine, so any clamp here would silently shift the emitted curve along
    // the geometry — the first live window showed exactly that (braking drawn
    // ~10–20 m past the real curve, phantom G4). The envelope + landing floor
    // bring v to ≈0 AT the platform; the entry then latches wherever the
    // integration actually stands (within ~2 m of the sign, occasionally a
    // metre past it — physical and honest).
    const enterHold = (endMs: number, stopIdx: number): void => {
      s[i + 1] = sN;
      v[i + 1] = 0;
      a = 0;
      holdAtM = sN;
      holdPos[i + 1] = sN;
      protectedSteps.add(i + 1);
      mode2 = 'hold';
      holdEndMs = endMs;
      holdStopIdx = stopIdx;
    };
    const target = nextStop < plan.length ? plan[nextStop] : null;
    const gated =
      mode === 'regimes' && target !== null && grid[i + 1] >= ref!.gateMs[nextStop];
    if (target !== null && sN >= target.distM - STOP_REACH_M && !gated) {
      // Entry gates on vI — the speed the entry ZEROES across this one step.
      if (vI > SKIP_V_MAX) {
        // Kinematically unreachable from the seam state: roll through, count.
        // The gate opens NOW so the smooth run never waits on a service that
        // will not happen.
        infeasibleSkips++;
        if (mode === 'ladder') departMs[nextStop] = grid[i + 1];
        nextStop++;
      } else if (vI <= HOLD_ENTRY_V_MAX) {
        // Dwell budgeted at leg start (deterministic); regimes: stand until
        // the opinion departs this stop (its gate) — never before.
        enterHold(
          mode === 'ladder' ? grid[i + 1] + legDwellS * 1000 : ref!.gateMs[nextStop],
          nextStop,
        );
        nextStop++;
        continue;
      }
      // else: still landing — the envelope + S-floor decay v; enter shortly.
    } else if (target !== null && sN > target.distM + STOP_REACH_M) {
      if (gated || vN > HOLD_ENTRY_V_MAX) {
        // A gated-open stop the smooth rolls through, or (ladder, numeric
        // edge only) a genuinely missed service — either way the gate opens.
        if (mode === 'ladder') departMs[nextStop] = grid[i + 1];
        nextStop++;
      }
      // else: landing overshoot past the sign — keep the pointer; the entry
      // grabs it on the next step at ≤ HOLD_ENTRY_V_MAX.
    }

    // ── terminal latch: geometry end is a permanent hold ─────────────────────
    if (mode2 === 'drive' && sN >= total - STOP_REACH_M && nextStop >= plan.length) {
      if (vI <= HOLD_ENTRY_V_MAX) {
        enterHold(Infinity, -1);
        continue;
      }
      // else: the end-of-shape envelope term is already decaying v.
    }

    if (mode2 === 'drive') {
      s[i + 1] = sN;
      v[i + 1] = vN;
    }
  }

  return { s, v, holdPos, binding, departMs, protectedSteps, infeasibleSkips };
}

// ── constraint-aware compression (§11) ───────────────────────────────────────

/**
 * Compress the fine profile onto ≤ TRAJ_MAX_POINTS breakpoints — the existing
 * greedy position-error-minimal merge with two changes:
 *  1. PROTECTED knots (hold entry/exit, modal release, seam, binding-curve
 *     local minima) are never merged while any unprotected knot remains;
 *     merging across a curve dip would re-lerp the client's speed OVER the
 *     dip — a wire-level G4 violation the fine profile never committed.
 *  2. NEAR-TERM weighting w(t) = 1/(1 + (t−t_E)/45 s) on the merge cost: the
 *     far half of the horizon is repainted by the next emission anyway.
 * If the protected set alone exceeds the budget, protection is dropped
 * farthest-first — and counted (the knotBudgetPressure gauge).
 */
function emitCompressed(
  grid: number[],
  vFine: number[],
  sFine: number[],
  protectedSteps: Set<number>,
  bindingSteps: ('none' | 'curve' | 'hold' | 'regime')[],
): { track: KinTrack; pressureDrops: number; budgetForced: boolean; knotStep: number[] } | null {
  const n = grid.length - 1;
  const t0 = grid[0];

  // Protect binding-curve local speed minima (the dip the client must not
  // lerp over) in addition to the hold/seam/release knots the sim marked.
  // STRICT corners only: a run riding a constant cap is v-flat, and its
  // interior steps merge at zero cost — protecting them (the ≤/≤ reading)
  // saturated the 24-knot budget on real winding shapes and triggered the
  // §11 pressure path on ~10 % of emissions, which then re-lerped ACROSS
  // dips (measured live 2026-08-16: G4 62, accel spikes to −1.84). A dip or
  // plateau keeps exactly its entry and exit corners.
  const prot = new Set<number>(protectedSteps);
  for (let i = 1; i < n; i++) {
    if (bindingSteps[i] !== 'curve') continue;
    const dl = vFine[i - 1] - vFine[i];
    const dr = vFine[i + 1] - vFine[i];
    if (dl >= -1e-9 && dr >= -1e-9 && (dl > 1e-9 || dr > 1e-9)) prot.add(i);
  }
  prot.add(0);
  prot.add(n);

  const err = (l: number, r: number): number =>
    Math.abs(((vFine[l] + vFine[r]) / 2) * (r - l) * DT_S - (sFine[r] - sFine[l]));
  const w = (i: number): number => 1 / (1 + (grid[i] - t0) / (COMPRESS_W_HALF_S * 1000));

  const bounds: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  const cost = (j: number): number =>
    (err(bounds[j - 1], bounds[j + 1]) -
      err(bounds[j - 1], bounds[j]) -
      err(bounds[j], bounds[j + 1])) *
    w(bounds[j]);

  let pressureDrops = 0;
  let budgetForced = false;
  while (bounds.length > 2) {
    let best = -1;
    let bestCost = Infinity;
    for (let j = 1; j < bounds.length - 1; j++) {
      if (prot.has(bounds[j])) continue;
      const c = cost(j);
      if (c < bestCost) {
        bestCost = c;
        best = j;
      }
    }
    if (best === -1) {
      // Every interior knot is protected. Over budget ⇒ drop protection
      // farthest-first (pathological, counted); at/under budget ⇒ done.
      if (bounds.length <= TRAJ_MAX_POINTS) break;
      let farthest = -1;
      for (let j = bounds.length - 2; j >= 1; j--) {
        if (prot.has(bounds[j])) {
          farthest = bounds[j];
          break;
        }
      }
      if (farthest < 0) break; // only endpoints left — cannot happen over budget
      prot.delete(farthest);
      pressureDrops++;
      continue;
    }
    if (bounds.length <= TRAJ_MAX_POINTS && bestCost > FREE_M) break;
    if (bounds.length > TRAJ_MAX_POINTS && bestCost > FREE_M) budgetForced = true;
    bounds.splice(best, 1);
  }

  const points: TrackPoint[] = [];
  const v: number[] = [];
  let s = sFine[0];
  for (let k = 0; k < bounds.length; k++) {
    const i = bounds[k];
    if (k > 0) {
      const prev = bounds[k - 1];
      s += ((vFine[prev] + vFine[i]) / 2) * (i - prev) * DT_S;
    }
    if (!Number.isFinite(s)) return null;
    points.push({ t: grid[i], s: round2(s) });
    v.push(vFine[i]);
  }
  for (let k = 1; k < points.length; k++) {
    if (points[k].s < points[k - 1].s) points[k].s = points[k - 1].s;
  }
  if (points.length < 2) return null;
  return { track: { points, v }, pressureDrops, budgetForced, knotStep: bounds };
}

/** Generator-exact G4 + G7 readings for one emitted track (design §8). */
function measureTrack(
  emitted: { track: KinTrack; knotStep: number[] },
  fine: FineRun,
  profile: DriveProfile,
  geom: RouteGeometry,
): { curveViolations: number; phantomDips: number } {
  const { points, v } = emitted.track;
  let curveViolations = 0;
  for (let i = 1; i < points.length; i++) {
    const dtS = (points[i].t - points[i - 1].t) / 1000;
    if (dtS <= 0) continue;
    const vSeg = (points[i].s - points[i - 1].s) / dtS;
    const cap = curveEnvAt(profile, geom, (points[i].s + points[i - 1].s) / 2);
    if (vSeg > cap * 1.05 + 0.3) curveViolations++;
  }
  let phantomDips = 0;
  // A dip knot is phantom only when NO constraint or regime was active at the
  // knot or its neighbouring sim steps: the minimum of a commanded dip lands
  // one step after the constraint releases (hold-release / yield-exit
  // transients), which is the constraint working, not a phantom brake.
  const unconstrained = (k: number): boolean =>
    k < 0 || k >= fine.binding.length || fine.binding[k] === 'none';
  for (let k = 1; k < v.length - 1; k++) {
    const step = emitted.knotStep[k];
    const standing = !Number.isNaN(fine.holdPos[step]);
    if (standing || v[k] <= 0.05) continue;
    if (
      v[k] <= v[k - 1] - 1.0 &&
      v[k] <= v[k + 1] - 1.0 &&
      unconstrained(step) &&
      unconstrained(step - 1) &&
      unconstrained(step + 1)
    ) {
      phantomDips++;
    }
  }
  return { curveViolations, phantomDips };
}

// ── the builder ──────────────────────────────────────────────────────────────

/** Build both v3 tracks for one vehicle. Null ⇒ the caller drops the vehicle
 *  rather than serving a broken curve (same contract as buildV2Vehicle). */
export function buildDriveVehicle(args: DriveArgs): DriveBuilt | null {
  const { raw, modal, prev, geom, surfaces, emittedAtMs: t0 } = args;
  if (raw.length < 2) return null;
  const tEnd = raw[raw.length - 1].t;
  if (!(tEnd > t0)) return null;
  const profile = driveProfileFor(geom);
  const grid = makeGrid(t0, tEnd);

  // ── anchor state (§4.2 / §4.3 v0/a0-at-the-seam) ─────────────────────────
  const holdingNow = modal !== null && modal.releaseAtMs > t0;
  const s0 = holdingNow
    ? clamp(modal.stopS, 0, geom.totalM)
    : modal !== null
      ? clamp(Math.max(modal.stopS, raw[0].s), 0, geom.totalM)
      : clamp(raw[0].s, 0, geom.totalM);
  const samePrevTrip = prev !== null && prev.tripId === args.tripId;
  // The opinion RE-ANCHORS its position on every fix (protocol), so inheriting
  // the previous speed is a smoothness nicety, not a continuity contract — and
  // a re-anchor INTO a curve zone must not import a speed above the local cap
  // (live G4 probe: every residual violation was seg#1/2 of a fresh seam).
  // The smooth track's position IS continuous, so its seam speed was already
  // legal at its own position and stays exactly C¹.
  const vSeamCap = curveEnvAt(profile, geom, s0);
  const v0 = holdingNow
    ? 0
    : Math.min(
        vSeamCap,
        samePrevTrip
          ? speedAt(prev.opinion, t0)
          : Math.max(0, Math.min(TRAJ_V_MAX_MS, (evalTrack(raw, t0 + TRAJ_SIM_STEP_MS) - raw[0].s) / DT_S)),
      );
  const a0 = holdingNow ? 0 : samePrevTrip ? accelAt(prev.opinion, t0) : 0;

  // ── stop plan: every platform ahead is SERVED (§4.2) ─────────────────────
  const planFrom = holdingNow ? modal.stopS : s0;
  const plan: PlanStop[] = [];
  for (const st of geom.stops) {
    if (st.distM <= planFrom + STOP_REACH_M) continue;
    plan.push({ distM: Math.min(st.distM, geom.totalM), stopId: st.stopId });
  }

  // ── opinion: the drive ───────────────────────────────────────────────────
  const oFine = runDrive({
    grid,
    geom,
    profile,
    surfaces,
    raw,
    plan,
    initialHoldEndMs: holdingNow ? modal.releaseAtMs : null,
    s0,
    v0,
    a0,
    mode: 'ladder',
  });
  if (oFine === null) return null;
  const oEmit = emitCompressed(grid, oFine.v, oFine.s, oFine.protectedSteps, oFine.binding);
  if (oEmit === null) return null;
  const oMeasure = measureTrack(oEmit, oFine, profile, geom);
  const opinionMeta: TrackBuildMeta = {
    knots: oEmit.track.points.length,
    pressureDrops: oEmit.pressureDrops,
    budgetForced: oEmit.budgetForced,
    ...oMeasure,
    infeasibleSkips: oFine.infeasibleSkips,
  };

  // ── smooth: same drive re-run from the C¹⁺ seam under the regime table ───
  let discKind: 'none' | 'trip' | 'gap' = 'none';
  let tDiscM: number | null = null;
  let seamGapM: number | null = null;
  let sEmit = oEmit;
  let smoothMeta = opinionMeta;
  if (prev !== null) {
    const sStart = evalTrack(prev.smooth.points, t0);
    seamGapM = Math.abs(sStart - s0);
    if (prev.tripId !== args.tripId) {
      discKind = 'trip';
    } else {
      tDiscM = discThresholdM(args.fixGapS, surfaces.paceAt(sStart, t0));
      if (seamGapM > tDiscM) discKind = 'gap';
    }
    if (discKind === 'none') {
      // Per-stop gates: the instant the OPINION departs each planned stop
      // (Infinity = it never gets there within the horizon — an early smooth
      // simply dwells until the horizon; behind-smooth passes freely once the
      // gate opened). The modal hold is stop −1 of the plan by construction:
      // its release gates nothing here because the anchor stop is not in
      // `plan` — the hold-follow regime handles it via holdPos.
      const gateMs = oFine.departMs.slice();
      const fitted = runDrive({
        grid,
        geom,
        profile,
        surfaces,
        raw,
        plan,
        initialHoldEndMs: null,
        s0: clamp(sStart, 0, geom.totalM),
        v0: speedAt(prev.smooth, t0),
        a0: accelAt(prev.smooth, t0),
        mode: 'regimes',
        ref: { fine: oFine, gateMs },
      });
      if (fitted === null) return null;
      const fittedEmit = emitCompressed(grid, fitted.v, fitted.s, fitted.protectedSteps, fitted.binding);
      if (fittedEmit === null) return null;
      sEmit = fittedEmit;
      const sMeasure = measureTrack(fittedEmit, fitted, profile, geom);
      smoothMeta = {
        knots: fittedEmit.track.points.length,
        pressureDrops: fittedEmit.pressureDrops,
        budgetForced: fittedEmit.budgetForced,
        ...sMeasure,
        infeasibleSkips: fitted.infeasibleSkips,
      };
    }
  }

  return {
    vehicle: {
      key: args.key,
      tripId: args.tripId,
      line: args.line,
      anchorMs: args.anchorMs,
      emittedAtMs: t0,
      discontinuity: discKind !== 'none',
      opinion: oEmit.track.points,
      smooth: sEmit.track.points,
    },
    opinion: oEmit.track,
    smooth: sEmit.track,
    meta: { discKind, tDiscM, seamGapM, opinion: opinionMeta, smooth: smoothMeta },
  };
}
