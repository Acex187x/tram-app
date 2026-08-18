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
  seamJustifiedM,
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
/** ML leg-pace trust region around the learned surface. v3.1 doctrine §14.1:
 *  tightened ±50 % → ±20 % — the driver absorbs timing pressure FIRST in
 *  dwell stretch (within the learned p10..p90 bounds), and only mildly in
 *  pace; the ±15 % trim still rides on top. Floors/caps always win. */
export const PACE_CLAMP_LO = 0.8;
export const PACE_CLAMP_HI = 1.2;
/** §14.1 dwell-quantile z for p10/p90 under the cell's Normal(mean, sd). */
export const DWELL_Z_1090 = 1.2816;
/** §14.2 request-stop (na znamení) skip: a stop is UNskippable only with
 *  trusted evidence of real boarding — dwell p50 above this, s. */
export const REQUEST_DWELL_P50_MAX_S = 10;
/** §14.2 active evidence: the ML curve's crossing-time excess through the
 *  stop (± REQUEST_SKIP_DELTA_M) must show less than this of dwell, s. */
export const REQUEST_SKIP_ML_DWELL_MAX_S = 5;
export const REQUEST_SKIP_DELTA_M = 15;
/** §14.2 trim blindness around a skipped stop's ML crossing τ: the
 *  expectation's dwell smear DEPRESSES the ML curve starting well BEFORE τ
 *  (the smear is what delays the crossing) and releases just after, so the
 *  neutral-trim core is asymmetric [τ−BEFORE, τ+AFTER], and the authority
 *  ramps linearly over FEATHER at both edges — a hard window boundary steps
 *  vCmd by up to ±15 % of pace and prints the very dip class it exists to
 *  kill (measured live 2026-08-17, second boot: dips at window entry). */
export const SKIP_TRIM_BLIND_BEFORE_MS = 40_000;
export const SKIP_TRIM_BLIND_AFTER_MS = 15_000;
export const SKIP_TRIM_FEATHER_MS = 10_000;
/** §14.5 innovation gate: an AGE re-emission's forward nowcast jitter at or
 *  below this continues the previous curve instead of hopping, m. Fix-driven
 *  re-anchors are NEVER gated — fresh evidence reaches the screen. */
export const AGE_INNOV_GATE_M = 25;
/** §14.3 jam holds (descend from tramSim stuck-hold, constants verbatim):
 *  two genuinely-new fixes within this are standing evidence, m. */
export const STUCK_FIX_EPS_M = 8;
/** ...suppressed within this of a platform (platform semantics win), m. */
export const STUCK_NEAR_STOP_M = 40;
/** §14.3 staleness release: an observed-stuck hold outlives the evidence by
 *  at most this much true fix age, s — a silent feed must not pin forever. */
export const STUCK_HOLD_MAX_AGE_S = 120;
/** G11 stop zone: stands within this of a platform / modal hold / shape end
 *  are platform semantics, not mid-segment stops, m. */
export const STOP_ZONE_M = 50;
/** G11 stand definition: v below this sustained longer than G11_STAND_MIN_S. */
export const G11_STAND_V_MS = 0.5;
export const G11_STAND_MIN_S = 3;
/** §14.1/§6 creep: ahead of a STANDING reality outside any stop zone the
 *  smooth track creeps (traffic-column pace) to the next planned stop and
 *  repays the lead there — never a phantom mid-street stand, m/s. */
export const CREEP_AHEAD_V_MS = 1.5;
/** §14.4 anti-collision (engine-verbatim): min clearance follower nose →
 *  leader tail, m; and the coupled-set trailer offset, m. */
export const QUEUE_GAP_M = 3;
export const COUPLED_TRAILER_OFFSET_M = 14.5;
/** G12 measurement grace over the enforced gap (integration + compression
 *  slop; the enforced clearance is QUEUE_GAP_M + leader length ≈ 17–32 m). */
export const G12_TOL_M = 1.0;
/** Extra clearance the SIM keeps under the leader cap beyond the measured
 *  gap, m: ≤24-knot compression can shift emitted positions by metres deep
 *  in budget-forced horizons (the G4 saga), and a fine sim riding the exact
 *  boundary then reads as penetration from bytes. The cushion is invisible
 *  product-wise and keeps the emitted curve clear of the measured gap. */
export const QUEUE_SIM_CUSHION_M = 3.0;
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
 *  pace, never the legal cap (the night-centre lesson). Since 2026-08-17 the
 *  pace reference spans BOTH ends of the gap corridor (the smooth's own bucket
 *  AND the reference's), and two observation-anchored floors apply — see the
 *  regime table. Measured live (12 h drill-down): paceAt at the smooth's own
 *  position is the dwell-contaminated stop-zone bucket at exactly the moments
 *  catch-up starts, and the lone-bucket ceiling bound 62 % of catch-up steps
 *  (mean 3.3 m/s of closing speed clipped; 5 % of bound steps commanded the
 *  smooth SLOWER than the reference it chases). */
export const CATCH_HEADROOM = 1.9;
/** Catch-up may always close at at least this surplus above the reference's
 *  own speed (envelope permitting): the reference (opinion) is itself
 *  ML-timed, learned-clamped and envelope-legal — an observed-pace quantity —
 *  so vO + a modest closing rate never sprints past what reality supports.
 *  Without a floor the ceiling can sit BELOW vO and the regime diverges. */
export const CATCH_DV_MIN = 2.5;
/** Hold-follow approach floor toward a STANDING reference, m/s: rolling into
 *  a platform where reality already stands is a normal tram roll-in at no
 *  less than the network default pace (= DEFAULT_PACE_MS); the brake parabola
 *  owns the last metres regardless. Measured live: 42 % of hold-follow
 *  approach steps were ceiling-bound below the brake envelope by the
 *  stop-zone bucket's own contaminated pace. */
export const HOLD_APPROACH_MIN_MS = DEFAULT_PACE_MS;
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
 *  ability). Replaces the flat TRAJ_DISCONTINUITY_M = 150 for the v3 drive.
 *  Tuning deviation 2026-08-17 (measured gap CDF at fix re-emissions: p50 83
 *  / p90 237 / p98 357 m; flag rate 1.10 % at floor 350): floor 350 → 300 and
 *  cap 1200 → 900 teleport the largest gap-carriers honestly within the
 *  coordinator's ≤ 3 % G8 budget (projected ~2–3 % with the pace scaling
 *  intact — the scaling still lifts thresholds for long-fix-gap vehicles, the
 *  feed-degradation lesson). The lever's measured ceiling: deleting the ~45 %
 *  of gap-carry that the smooth-accuracy flip bar implies would need a flat
 *  ~180–200 m threshold = 16–20 % teleports — dishonesty the design exists to
 *  prevent; the deeper fix is re-anchor noise, not the threshold. */
export const DISC_FLOOR_M = 300;
export const DISC_CAP_M = 900;
/** 1.25 → 1.1 in the same deviation: discThresholdM floors its pace at
 *  DEFAULT_PACE, so the minimum scaled threshold was 45·5.5·1.25 ≈ 309 m and
 *  the floor alone barely moved anything — the margin is the knob that
 *  rescales the whole gap-aware band (min becomes 272 → the 300 floor binds). */
export const DISC_MARGIN = 1.1;
export const DISC_GAP_MIN_S = 45;
export const DISC_GAP_MAX_S = 240;
/** A stop is "reached" within this of its distM, m (port: tramSim STOP_REACH_M). */
export const STOP_REACH_M = 2;
/** Hold entry zeroes the speed inside one sim step; with the S-curve landing
 *  floor the tram reaches the platform with |a| ≤ √(2·J·v), so entering from
 *  ≤ this keeps the entry's wire jerk under the gate (0.7 leaves 0.2 of
 *  headroom under J_GATE for adjacent-phase stacking — the 0.8 reading left a
 *  1.0x tail in the live G2 histogram). Above it the sim simply keeps
 *  integrating — the envelope + landing floor decay the speed and the entry
 *  fires a step or two later. */
export const HOLD_ENTRY_V_MAX = 0.7;
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
  return curveEnvMarginAt(profile, geom, sM, 0);
}

/** Curve envelope with the braking slack bitten by `marginM` metres — the
 *  runtime (§4.1/§5) view of the same constraint; margin 0 IS the gate. */
function curveEnvMarginAt(
  profile: DriveProfile,
  geom: RouteGeometry,
  sM: number,
  marginM: number,
): number {
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
    const cand =
      d <= s
        ? lim
        : Math.sqrt(lim * lim + 2 * TRAJ_A_BRK * Math.max(0, d - s - marginM));
    if (cand < v) v = cand;
  }
  return v;
}

/**
 * Largest seam speed the local curve envelope admits GIVEN the seam accel
 * state. The raw envelope assumes braking is ALREADY at full A_BRK; a seam
 * teleports state (v, a0) into the approach, and building that braking under
 * jerk J first costs the §5 onset margin v·((max(0,a0)+A_BRK)²/(2·J·A_BRK) +
 * dt). Importing a chord speed above THIS cap repaints a speed the fine
 * profile never drove and prints G4 violations decaying off the seam
 * (measured live 2026-08-17: capped-but-marginless opinion seams and uncapped
 * smooth seams were the seg#1–2 offender class). The admissible v solves
 * v ≤ env(s; margin(v, a0)) — the right side is non-increasing in v, so one
 * bisection finds the fixed point (deterministic, 25 iterations).
 */
export function seamSpeedCap(
  profile: DriveProfile,
  geom: RouteGeometry,
  sM: number,
  a0: number,
): number {
  // 2·DT_S where the sim margin uses DT_S: a seam lands mid-grid with no
  // preceding step that already honoured the margin, so it gets one extra
  // step of slack (the first live window's residual was a seam segment 0.02
  // m/s over the gate — exactly the half-step discretization slop).
  const marginOf = (v: number): number =>
    v * ((Math.max(0, a0) + TRAJ_A_BRK) ** 2 / (2 * TRAJ_J_MAX * TRAJ_A_BRK) + 2 * DT_S);
  const hi0 = curveEnvAt(profile, geom, sM);
  if (hi0 <= curveEnvMarginAt(profile, geom, sM, marginOf(hi0))) return hi0;
  let lo = 0;
  let hi = hi0;
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= curveEnvMarginAt(profile, geom, sM, marginOf(mid))) lo = mid;
    else hi = mid;
  }
  return lo;
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
  /** Learned per-stop dwell distribution (LearnedModel.dwellStats): mean/sd
   *  in seconds; `trusted` is the §14.2 skip-class permission bit (trusted
   *  long-dwell stops are unskippable). The drive derives clamped p10/p50/p90
   *  quantiles from these. */
  dwellStats(stopId: string, atMs: number): { mean: number; sd: number; trusted: boolean };
}

/** Clamped §14.1 dwell quantiles from a cell's (mean, sd). */
export function dwellQuantiles(stats: { mean: number; sd: number }): {
  p10: number;
  p50: number;
  p90: number;
} {
  const c = (x: number): number => Math.min(DWELL_CAP_S, Math.max(DWELL_MIN_S, x));
  return {
    p10: c(stats.mean - DWELL_Z_1090 * stats.sd),
    p50: c(stats.mean),
    p90: c(stats.mean + DWELL_Z_1090 * stats.sd),
  };
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
  /** Anchor-floor hotfix, age-refresh clause (same semantics as
   *  BuildV2Args.ageFloorS): on a same-anchor re-emission the opinion may not
   *  re-anchor BEHIND the previously rendered opinion position — a backward
   *  jump with no new fix is model jitter, not evidence. 0 = no floor. */
  ageFloorS?: number;
  /** The anchor fix's shapeDistM (the G10 floor), m — the §14.4 seam clamp
   *  may reduce the nowcast toward the leader curve but never below this. */
  anchorFixS?: number;
  /** §14.7 seam rule inputs, set on FIX-DRIVEN re-emissions only: the
   *  PREVIOUS emission's anchor fix position (with fixGapS above, the observed
   *  fix-over-fix speed). When the previous opinion's projection at t0 is
   *  within `seamJustifiedM` of the new fix, s0 is floored AT that projection
   *  — continuity instead of the backward swap hop (G13). Standing evidence
   *  (modal hold / jam hold) outranks continuity: the honest correction back
   *  to the platform / stuck point is emitted. */
  prevFixS?: number;
  /** §14.3 jam hold: evidence-backed stuck position (two-plus genuinely-new
   *  fixes flat within STUCK_FIX_EPS_M, away from platforms — run.ts detects,
   *  descending from tramSim.updateStuckHold), m along shape. null = moving. */
  stuckAtM?: number | null;
  /** §14.4 anti-collision: the immediate same-shape leader's CURRENT emitted
   *  curves + the clearance to keep behind them (QUEUE_GAP_M + leader length,
   *  coupled-aware). The follower's opinion clips against the leader's
   *  opinion, smooth against smooth. null = no leader / leader unknown. */
  leader?: { key: string; opinion: TrackPoint[]; smooth: TrackPoint[]; gapM: number } | null;
  /** True when this chain HAD an emission that was dropped (ML outage,
   *  geometry loss, build failure) — the re-appearance may land anywhere, so
   *  it must carry the honest discontinuity flag even though prev is null
   *  (measured live: a silent 21 km smooth jump on an ML-drop rebuild). */
  chainBroken?: boolean;
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
  /** G4 drill-down: one entry per violating segment (seg index, chord speed,
   *  cap at the positional midpoint, seconds from the emission instant). */
  curveDetail: CurveViolationDetail[];
  /** G7: emitted-knot local v-minima ≥1 m/s below both neighbours with no
   *  binding constraint tagged and not at a hold. */
  phantomDips: number;
  /** G7 drill-down: one entry per counted dip (knot index, seconds from the
   *  emission, position, the v triple) — the offender-class telemetry. */
  dipDetail: DipDetail[];
  /** Planned holds rolled through because the seam state made them
   *  kinematically unreachable (see HOLD_ENTRY_V_MAX). */
  infeasibleSkips: number;
  /** G11: stand episodes (v < G11_STAND_V_MS sustained > G11_STAND_MIN_S)
   *  outside stop zones with NO evidence backing — model-invented stops.
   *  Target literal 0. */
  midSegmentStops: number;
  /** G11 drill-down: position + duration of each counted stand. */
  midSegmentDetail: { sM: number; durS: number }[];
  /** §14.3 telemetry: evidence-backed jam-stand episodes (not violations). */
  jamHolds: number;
  /** §14.4 telemetry: stand episodes pressed against a standing leader. */
  queueHolds: number;
  /** G12: sampled instants where this emitted track penetrates the leader's
   *  clearance beyond G12_TOL_M. Target literal 0; 0 when no leader. */
  collisionViolations: number;
  /** G12 drill-down: deepest penetration of the measured gap, m (≤ 0 clear). */
  collisionMaxPenM: number;
  /** 'regimes' runs only: why the smooth track drove the speed it drove —
   *  the G5 latency drill-down (which limiter actually bound). */
  regime: RegimeStats | null;
}

export interface CurveViolationDetail {
  /** Emitted segment index (1 = the first segment after the seam knot). */
  seg: number;
  vSeg: number;
  cap: number;
  /** Segment start relative to emittedAtMs, s. */
  atS: number;
}

export interface DipDetail {
  seg: number;
  atS: number;
  sM: number;
  vPrev: number;
  vDip: number;
  vNext: number;
}

/** Per-step classification of the smooth run's speed limiters (G5 diagnosis —
 *  design §6 names the levers; this measures which one actually binds). */
export interface RegimeStats {
  /** Steps in the catch-up regime (g > CATCH_ENTER, reference moving). */
  catchSteps: number;
  /** ...where the observed-pace ceiling clipped the demanded surplus. */
  catchCeilBound: number;
  /** ...where the ceiling sat below the reference's OWN speed — the smooth was
   *  commanded slower than the thing it chases (divergence, not honesty). */
  catchCeilBelowRef: number;
  /** ...where the envelope (curve cap / hold) clipped below the regime demand. */
  catchEnvBound: number;
  /** ...where v still lagged the command by > 0.3 m/s (accel/jerk ramp-up). */
  catchRampBound: number;
  /** Σ max(0, demand − ceiling) over catch-up steps, m/s — closing speed the
   *  pace anchor took away. */
  ceilShortfallSum: number;
  /** Hold-follow steps with the stand point still ahead. */
  hfBehindSteps: number;
  /** ...where the pace ceiling (not the brake parabola) set the approach. */
  hfCeilBound: number;
  yieldSteps: number;
  /** Yield steps commanding MORE than the reference's own speed (outrunning
   *  the opinion while ahead — the ahead-divergence mechanism). */
  yieldOutrun: number;
}

const zeroRegimeStats = (): RegimeStats => ({
  catchSteps: 0,
  catchCeilBound: 0,
  catchCeilBelowRef: 0,
  catchEnvBound: 0,
  catchRampBound: 0,
  ceilShortfallSum: 0,
  hfBehindSteps: 0,
  hfCeilBound: 0,
  yieldSteps: 0,
  yieldOutrun: 0,
});

export interface DriveBuilt {
  vehicle: V2Vehicle;
  opinion: KinTrack;
  smooth: KinTrack;
  meta: {
    discKind: 'none' | 'trip' | 'gap' | 'break';
    /** The T_disc threshold applied at this emission, m (null: first emission). */
    tDiscM: number | null;
    /** |prev smooth(t_E) − new opinion(t_E)| before the decision, m. */
    seamGapM: number | null;
    /** Anchor-floor hotfix telemetry: the age-refresh floor lifted s0. */
    ageFloorApplied: boolean;
    /** §14.7 telemetry: the fix-driven seam floor (continuity) lifted s0. */
    seamFloorApplied: boolean;
    /** §14.2: request stops excluded from this emission's plan (telemetry). */
    requestSkips: { stopId: string; distM: number }[];
    /** §14.3: the emission holds at an evidence-backed jam position. */
    jamHolding: boolean;
    /** §14.4: the leader this emission was clipped against, if any. */
    leaderKey: string | null;
    opinion: TrackBuildMeta;
    smooth: TrackBuildMeta;
  };
}

/**
 * §14.2 request-stop (na znamení) skip decision. Two keys must both turn:
 * the learned dwell evidence does NOT prove real boarding (a stop is
 * unskippable only with a trusted cell whose mean dwell exceeds
 * REQUEST_DWELL_P50_MAX_S — rare holds never accumulate trust, short holds
 * fail the bar), AND the ML curve's own timing shows no dwell through the
 * stop: crossing-time excess over ±REQUEST_SKIP_DELTA_M at the learned pace
 * below REQUEST_SKIP_ML_DWELL_MAX_S. Beyond the ML horizon: always serve
 * (generic-tram degradation, §13). Terminals are excluded by the caller.
 */
export function requestStopSkippable(
  raw: TrackPoint[],
  surfaces: DriveSurfaces,
  stopId: string,
  distM: number,
): boolean {
  const tauA = mlCrossingMs(raw, distM - REQUEST_SKIP_DELTA_M);
  const tauB = mlCrossingMs(raw, distM + REQUEST_SKIP_DELTA_M);
  if (tauA === null || tauB === null) return false;
  const ds = surfaces.dwellStats(stopId, tauA);
  if (ds.trusted && ds.mean > REQUEST_DWELL_P50_MAX_S) return false;
  const paceRef = Math.max(1, surfaces.paceAt(distM, tauA));
  const mlDwellS = (tauB - tauA) / 1000 - (2 * REQUEST_SKIP_DELTA_M) / paceRef;
  return mlDwellS < REQUEST_SKIP_ML_DWELL_MAX_S;
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
  /** Which constraint bound each step: envelope terms ('curve'/'hold'), the
   *  §14.4 leader clearance ('queue'), a commanded regime reduction ('regime'
   *  — yield / hold-follow braking, a documented manoeuvre, not noise), or
   *  'none' = plain guidance. */
  binding: ('none' | 'curve' | 'hold' | 'regime' | 'queue')[];
  /** Per-step stand evidence class for the G11 scan: 0 = none (a stand here
   *  outside a stop zone is model-invented), 1 = jam (observed-stuck hold or
   *  standing with/behind a jam-holding reference), 2 = queue (pressed
   *  against a standing leader). */
  standKind: (0 | 1 | 2)[];
  /** Per plan-stop index: sim ms the drive DEPARTS it (Infinity = not reached
   *  within the horizon; 0 = not part of this run's plan / already behind). */
  departMs: number[];
  /** Modal-release / dwell-exit / hold-entry steps — protected knots (§11). */
  protectedSteps: Set<number>;
  infeasibleSkips: number;
  /** 'regimes' runs: which limiter actually bound (all-zero for 'ladder'). */
  regime: RegimeStats;
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
  /** Initial hold (modal anchor / §14.3 jam): stand at s0 until this ms. */
  initialHoldEndMs: number | null;
  /** §14.3: the initial hold is an evidence-backed JAM hold (not a platform). */
  initialHoldJam?: boolean;
  /** Modal anchor stop position (stop-zone semantics for the G11 scan and the
   *  §6 creep rule), or null. */
  modalS: number | null;
  /** §14.2: ML crossing instants of SKIPPED request stops. Within
   *  ±SKIP_TRIM_BLIND_MS of one, the ML positional trim goes NEUTRAL: the
   *  expectation there is smeared by the counterfactual hold the skip decision
   *  just rejected — chasing it prints a phantom mid-segment brake dip (G7,
   *  measured live 2026-08-17: 49 dips / 1 949 emissions on the first v3.1
   *  boot, all at skipped-stop smears). The driver ignores known-wrong
   *  dispatcher noise. */
  skipTauMs?: number[];
  /** §14.4: the same-track leader curve this run must stay behind. */
  leader?: { track: TrackPoint[]; gapM: number } | null;
  s0: number;
  v0: number;
  a0: number;
  mode: 'ladder' | 'regimes';
  /** 'regimes' only: the opinion run + per-stop gates. */
  ref?: OpinionRef;
}): FineRun | null {
  const { grid, geom, profile, surfaces, raw, plan, mode, ref, leader, modalS } = args;
  const n = grid.length - 1;
  const cum = geom.cumDistM;
  const total = geom.totalM;
  const t0 = grid[0];

  const s = new Array<number>(n + 1);
  const v = new Array<number>(n + 1);
  const holdPos = new Array<number>(n + 1).fill(NaN);
  const binding = new Array<'none' | 'curve' | 'hold' | 'regime' | 'queue'>(n + 1).fill('none');
  const standKind = new Array<0 | 1 | 2>(n + 1).fill(0);
  const departMs = new Array<number>(plan.length).fill(mode === 'ladder' ? Infinity : 0);
  const protectedSteps = new Set<number>();
  let infeasibleSkips = 0;
  const regime = zeroRegimeStats();

  /** Stop-zone test (G11 / §6 creep): platforms, the modal hold, shape end. */
  const inStopZone = (sPos: number): boolean => {
    if (total - sPos <= STOP_ZONE_M) return true;
    if (modalS !== null && Math.abs(sPos - modalS) <= STOP_ZONE_M) return true;
    for (const st of geom.stops) {
      if (st.distM > sPos + STOP_ZONE_M) break;
      if (Math.abs(st.distM - sPos) <= STOP_ZONE_M) return true;
    }
    return false;
  };
  /** Leader speed at t — chord over the next second of its emitted curve. */
  const leaderSpeedAt = (tMs: number): number =>
    leader ? Math.max(0, evalTrack(leader.track, tMs + 1000) - evalTrack(leader.track, tMs)) / 1 : 0;

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
  let holdIsJam = args.initialHoldJam === true && mode2 === 'hold';
  if (mode2 === 'hold') {
    v[0] = 0;
    a = 0;
    holdPos[0] = holdAtM;
    if (holdIsJam) standKind[0] = 1;
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
    const dq = dwellQuantiles(surfaces.dwellStats(target.stopId, tau ?? tDepMs));
    if (legLen < 1) {
      legPace = paceRef;
      legDwellS = dq.p50;
      return;
    }
    if (tau === null) {
      // Past the last ML-crossed stop: the tail carries the pace, the learned
      // p50 carries the dwell.
      legDwellS = dq.p50;
      legPace = clamp(tailPace, PACE_CLAMP_LO * paceRef, PACE_CLAMP_HI * paceRef);
      return;
    }
    // §14.1 time-absorption hierarchy: schedule pressure vs the ML crossing
    // time τ is absorbed FIRST by the dwell budget within [p10, p90] (0.5·D:
    // the ML expectation crosses a platform mid-dwell on average, so half the
    // dwell belongs to the crossing itself), and only the residual by the
    // ±20 % pace band. Kinematic floors and the envelope always win in-sim.
    const tKin = legKinFloorS(legLen, vAtDep, 0);
    const tLegS = (tau - tDepMs) / 1000;
    const nominalTravelS = Math.max(tKin, legLen / Math.max(0.5, paceRef));
    legDwellS = clamp(2 * (tLegS - nominalTravelS), dq.p10, dq.p90);
    const tAvail = Math.max(tKin, tLegS - 0.5 * legDwellS);
    legPace = clamp(legLen / Math.max(1e-3, tAvail), PACE_CLAMP_LO * paceRef, PACE_CLAMP_HI * paceRef);
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
        holdIsJam = false;
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
        if (holdIsJam) standKind[i + 1] = 1;
        continue;
      }
    }

    const sI = s[i];
    const vI = v[i];

    // ── guidance: commanded speed before constraints ─────────────────────────
    let vCmd: number;
    let inCatch = false; // this step is a catch-up step (G5 drill-down)
    if (mode === 'ladder') {
      const m = evalTrack(raw, tMs);
      let trim = clamp(1 + (m - sI) / G_ML, 1 - TRIM_AUTH, 1 + TRIM_AUTH);
      // §14.2 trim blindness: the ML curve is known-wrong (dwell-smeared)
      // while it approaches and crosses a stop the drive decided to SKIP —
      // neutral trim there (feathered, see SKIP_TRIM_BLIND_*), or the driver
      // brakes for a hold that will not happen (G7).
      if (args.skipTauMs !== undefined && args.skipTauMs.length > 0) {
        let w = 1; // 1 = full trim authority, 0 = neutral
        for (const tau of args.skipTauMs) {
          const out = Math.max(tau - SKIP_TRIM_BLIND_BEFORE_MS - tMs, tMs - tau - SKIP_TRIM_BLIND_AFTER_MS);
          const wk = clamp(out / SKIP_TRIM_FEATHER_MS, 0, 1);
          if (wk < w) w = wk;
        }
        trim = 1 + (trim - 1) * w;
      }
      // Horizon-end decay: past the last ML knot evalTrack freezes M, so
      // (M − s) collapses and the trim starves the final segments — a twin
      // end-of-horizon dip on both tracks (G7 drill-down class, measured
      // live). Authority ramps to neutral over the last 20 s of the raw
      // horizon; the ladder pace carries the tail.
      trim = 1 + (trim - 1) * clamp((raw[raw.length - 1].t - tMs) / 20_000, 0, 1);
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
        // The reference's stand class carries over: a smooth standing at/near
        // a jam or queue tail is the same evidence-backed column, not a
        // model-invented stop (G11 drill-down 2026-08-17: 56 s smooth stands
        // at a jam point were counted as violations).
        if (rf.fine.standKind[i] > 0) standKind[i + 1] = rf.fine.standKind[i];
        const d = oHold - sI;
        if (d > 0) {
          // Approach ceiling: observed sprint pace over the corridor being
          // closed (BOTH ends — the smooth's own bucket is the dwell-
          // contaminated stop zone exactly when this fires), floored at the
          // network default roll-in pace. The brake parabola owns the last
          // metres; the envelope stack still clamps below all of this.
          const paceCeil = Math.max(surfaces.paceAt(sI, tMs), surfaces.paceAt(oHold, tMs));
          const ceil = Math.min(
            Math.max(CATCH_HEADROOM * paceCeil, HOLD_APPROACH_MIN_MS),
            TRAJ_V_MAX_MS,
          );
          const brake = Math.sqrt(2 * TRAJ_A_BRK * Math.max(0, d));
          vCmd = Math.min(brake, ceil);
          regime.hfBehindSteps++;
          if (ceil < brake) regime.hfCeilBound++;
        } else {
          // At/ahead of a standing reality. Standing is honest only where a
          // tram may stand (v3.1 doctrine): at/near the hold point or inside
          // any stop zone (platform semantics), or when the reality's stand
          // is itself evidence-backed (jam — the street is a traffic column).
          const refJam = rf.fine.standKind[i] === 1;
          if (refJam || d > -STOP_ZONE_M || inStopZone(sI)) {
            vCmd = 0;
            if (refJam) standKind[i + 1] = 1;
          } else {
            // §6/§14.1 creep: never a phantom mid-street stand — roll at
            // traffic-column pace to the NEXT planned (gated) stop and repay
            // the lead by dwelling there; the envelope owns the brake-in.
            vCmd = CREEP_AHEAD_V_MS;
          }
        }
      } else {
        if (yielding) {
          if (g > YIELD_EXIT_M) yielding = false;
        } else if (g < YIELD_ENTER_M) {
          yielding = true;
        }
        if (yielding) {
          // Never pedestrian, never reverse, never a phantom mid-street stand
          // — and never OUTRUN the reference: the 3.0 floor is honest only
          // while reality itself does at least 3.0 (measured live: 21 % of
          // yield steps commanded more than vO — the lead GREW while ahead).
          binding[i] = 'regime';
          vCmd = Math.max(YIELD_FACTOR * vO, Math.min(YIELD_MIN_V_MS, vO));
          regime.yieldSteps++;
          if (vCmd > vO + 1e-9) regime.yieldOutrun++;
        } else if (g > CATCH_ENTER_M) {
          // Catch-up ceiling: observed sprint pace over the gap corridor
          // (both ends), never below the reference's own already-credible
          // speed plus a modest closing rate — commanded-slower-than-the-
          // reference is divergence, not honesty.
          const paceCeil = Math.max(surfaces.paceAt(sI, tMs), surfaces.paceAt(o, tMs));
          const ceil = Math.min(
            Math.max(CATCH_HEADROOM * paceCeil, vO + CATCH_DV_MIN),
            TRAJ_V_MAX_MS,
          );
          const demand = vO + Math.min(DV_CATCH_MAX, g / T_CLOSE_S);
          vCmd = Math.min(demand, ceil);
          inCatch = true;
          regime.catchSteps++;
          if (ceil < demand) {
            regime.catchCeilBound++;
            regime.ceilShortfallSum += demand - ceil;
            if (ceil < vO) regime.catchCeilBelowRef++;
          }
        } else {
          vCmd = vO * clamp(1 + g / PACE_GAIN_M, TRACK_MIN_FACTOR, TRACK_MAX_FACTOR);
          // Departure-transient guard (G7, measured live 2026-08-17: the
          // whole counted dip class was smooth-track): while a plan stop the
          // smooth has NOT yet served lies between it and the reference, the
          // reference's own speed — braking into / ramping out of THAT stop —
          // describes the wrong stretch of track. The smooth keeps its own
          // approach pace toward the stop; the envelope + the per-stop gate
          // own the stop itself (brake-in when the gate is closed, roll
          // through when it opened). Without this the track regime yanks the
          // smooth down to the reference's departure ramp mid-segment — a
          // phantom brake with no binding constraint.
          const stopBetween =
            nextStop < plan.length &&
            plan[nextStop].distM > sI + STOP_REACH_M &&
            plan[nextStop].distM <= o + STOP_REACH_M;
          // Same wrong-stretch logic for the reference's OWN envelope: while
          // the opinion brakes for a curve/hold/queue at ITS position well
          // ahead (g > 25 m), its speed describes track the smooth has not
          // reached — the smooth keeps pace; its own envelope owns its own
          // curves (G7 drill-down: the mirrored-curve-dip class).
          const refBound = rf.fine.binding[i] !== 'none' && g > 25;
          if (stopBetween || refBound) {
            // Floor at the normal cruise pace over the corridor (never the
            // sprint ceiling — this is a roll, not a catch-up), with the
            // dwell-contamination floor HOLD_APPROACH_MIN.
            const floor = Math.min(
              Math.max(
                Math.max(surfaces.paceAt(sI, tMs), surfaces.paceAt(o, tMs)),
                HOLD_APPROACH_MIN_MS,
              ),
              TRAJ_V_MAX_MS,
            );
            if (floor > vCmd) vCmd = floor;
          }
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
    // §14.4 leader clearance: never drive into the same-rail leader's curve.
    // Same shape ⇒ same s-axis; the cap is the leader's own speed plus the
    // braking envelope onto the clearance boundary (with the §5 jerk-onset
    // margin via slack()), i.e. classic car-following re-hosted onto the
    // leader's EMITTED curve. At/past the boundary (inherited seam overlap)
    // the follower may at most match the leader's speed — the overlap decays,
    // never grows.
    let envQueue = Infinity;
    if (leader) {
      const lim = evalTrack(leader.track, tMs) - leader.gapM - QUEUE_SIM_CUSHION_M;
      const vLead = leaderSpeedAt(tMs);
      envQueue = lim - sI <= 0 ? vLead : vLead + Math.sqrt(2 * TRAJ_A_BRK * slack(lim));
      if (envQueue < 0.5 && vLead < 0.5) standKind[i + 1] = 2; // queue stand
    }
    const env = Math.min(envCurve, envHold, envQueue);
    if (env < vCmd) {
      binding[i] = envQueue <= envCurve && envQueue <= envHold
        ? 'queue'
        : envHold <= envCurve
          ? 'hold'
          : 'curve';
      vCmd = env;
      if (inCatch) regime.catchEnvBound++;
    }

    // ── accel: rate-, jerk- and landing-limited; integrate (exact, linear v) ─
    let aDes = clamp((vCmd - vI) / DT_S, -TRAJ_A_BRK, TRAJ_A_ACC);
    // S-curve landing floor: the deepest decel that still reaches v = 0 with
    // a → 0 under jerk J is a = −√(2·J·v) (da/dt along it is exactly −J). It
    // binds only below ~A_BRK²/2J ≈ 1.2 m/s, shaping every stop's last metre
    // into the S-tail — without it the demand pins a at full brake while v
    // crosses zero and the release prints a >J wire jerk at every platform.
    aDes = Math.max(aDes, -Math.sqrt(2 * TRAJ_J_MAX * Math.max(0, vI)));
    // S-curve approach ceiling — the accel-side mirror: the steepest accel
    // from which jerk-J decay still reaches vCmd with a → 0 is +√(2·J·Δv).
    // Without it a full-throttle ramp arriving at a demand PLATEAU (a curve
    // cap, the catch-up ceiling) overshoots by up to A_ACC²/2J ≈ 1.06 m/s —
    // measured live 2026-08-17 as marginal G4 excess when the plateau was a
    // curve dip (4.40 across a 3.89 cap, seam cool at 1.95).
    aDes = Math.min(aDes, Math.sqrt(2 * TRAJ_J_MAX * Math.max(0, vCmd - vI)));
    aDes = clamp(aDes, a - TRAJ_J_MAX * DT_S, a + TRAJ_J_MAX * DT_S);
    let vN = vI + aDes * DT_S;
    if (vN < 0) {
      // v crossed zero mid-step. Stay jerk-legal: relax a within the jerk
      // window toward −v/dt; if the window cannot reach it yet, keep the
      // legal maximum and creep — never snap a to an out-of-window value
      // (the old snap was the last pointwise-J break and printed the 1.0x
      // wire-jerk tail).
      aDes = clamp(-vI / DT_S, a - TRAJ_J_MAX * DT_S, a + TRAJ_J_MAX * DT_S);
      vN = Math.max(0, vI + aDes * DT_S);
    } else if (vN > TRAJ_V_MAX_MS) {
      aDes = (TRAJ_V_MAX_MS - vI) / DT_S;
      vN = TRAJ_V_MAX_MS;
    }
    // One-step-ahead feasibility: the envelope margin is a-DEPENDENT, so a
    // hard ramp can collapse its own demand — a vertex that looked far at
    // a = 0 suddenly bites at a = +1.3, AFTER jerk can no longer comply
    // (measured live 2026-08-17: 3-consecutive-step overshoots up to +1.3
    // m/s entering dips during ceiling-unlocked catch-up). Test the POST
    // state (vN, aDes) against its own margin; if it fails, bisect aDes down
    // within the jerk window — the discrete form of "never enter a state you
    // cannot brake out of". The jerk floor stays absolute: if even it fails
    // (pre-existing infeasible seam), physics does its best and the gate
    // counts the residue.
    {
      const post = (aC: number): boolean => {
        const vP = Math.max(0, vI + aC * DT_S);
        const mP = vP * ((Math.max(0, aC) + TRAJ_A_BRK) ** 2 / (2 * TRAJ_J_MAX * TRAJ_A_BRK) + DT_S);
        let envP = Math.min(V_LIMIT_MAX, cruiseCapAt(profile, geom, sI));
        const horizon = sI + DEFAULT_LOOKAHEAD_M;
        const nV = cum.length;
        for (let j = segmentIndexAt(cum, Math.max(0, sI - TRAIL_LIMIT_M)); j < nV; j++) {
          const d = cum[j];
          if (d < sI - TRAIL_LIMIT_M) continue;
          if (d > horizon) break;
          const lim = profile.vLimit[j];
          if (lim >= envP) continue;
          const cand = d <= sI ? lim : Math.sqrt(lim * lim + 2 * TRAJ_A_BRK * Math.max(0, d - sI - mP));
          if (cand < envP) envP = cand;
        }
        return vP <= envP + 1e-9;
      };
      // The fallback floor is the jerk window's lower edge BOUNDED BY −A_BRK:
      // an unbounded a − J·dt printed one −1.467 m/s² wire accel in 578 k
      // segments (2026-08-17) — the brake cap is a frozen contract limit and
      // outranks the feasibility heuristic.
      const aFloor = Math.max(a - TRAJ_J_MAX * DT_S, -TRAJ_A_BRK);
      if (aDes > aFloor && !post(aDes)) {
        let lo = aFloor;
        let hi = aDes;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          if (post(mid)) lo = mid;
          else hi = mid;
        }
        aDes = post(lo) ? lo : aFloor;
        vN = Math.max(0, vI + aDes * DT_S);
      }
    }
    a = aDes;
    if (inCatch && vCmd - vN > 0.3) regime.catchRampBound++;
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

  return { s, v, holdPos, binding, standKind, departMs, protectedSteps, infeasibleSkips, regime };
}

/**
 * G11 / §14.3 / §14.4 stand-episode scan over one fine run: episodes of
 * v < G11_STAND_V_MS sustained > G11_STAND_MIN_S are classified as platform
 * stands (inside a stop zone — not counted), jam holds (evidence-backed,
 * standKind 1), queue holds (pressed against a standing leader, standKind 2),
 * or — the G11 violation class — model-invented mid-segment stops.
 */
function scanStands(
  fine: FineRun,
  geom: RouteGeometry,
  modalS: number | null,
): {
  midSegmentStops: number;
  jamHolds: number;
  queueHolds: number;
  midSegmentDetail: { sM: number; durS: number }[];
} {
  const total = geom.totalM;
  const inZone = (sPos: number): boolean => {
    if (total - sPos <= STOP_ZONE_M) return true;
    if (modalS !== null && Math.abs(sPos - modalS) <= STOP_ZONE_M) return true;
    for (const st of geom.stops) {
      if (st.distM > sPos + STOP_ZONE_M) break;
      if (Math.abs(st.distM - sPos) <= STOP_ZONE_M) return true;
    }
    return false;
  };
  let midSegmentStops = 0;
  let jamHolds = 0;
  let queueHolds = 0;
  const midSegmentDetail: { sM: number; durS: number }[] = [];
  const n = fine.v.length;
  let runStart = -1;
  let runKind: 0 | 1 | 2 = 0;
  const flush = (endIdx: number): void => {
    if (runStart < 0) return;
    const durS = (endIdx - runStart) * DT_S;
    if (durS > G11_STAND_MIN_S) {
      if (runKind === 1) jamHolds++;
      else if (runKind === 2) queueHolds++;
      else if (!inZone(fine.s[runStart])) {
        midSegmentStops++;
        midSegmentDetail.push({ sM: round2(fine.s[runStart]), durS });
      }
    }
    runStart = -1;
    runKind = 0;
  };
  for (let i = 0; i < n; i++) {
    if (fine.v[i] < G11_STAND_V_MS) {
      if (runStart < 0) runStart = i;
      if (fine.standKind[i] > runKind) runKind = fine.standKind[i];
    } else {
      flush(i);
    }
  }
  flush(n);
  return { midSegmentStops, jamHolds, queueHolds, midSegmentDetail };
}

/** Spread helper: measureCollision result → the two TrackBuildMeta fields. */
function collisionMeta(m: { violations: number; maxPenM: number }): {
  collisionViolations: number;
  collisionMaxPenM: number;
} {
  return { collisionViolations: m.violations, collisionMaxPenM: m.maxPenM };
}

/** G12: sampled 1 s instants where an emitted track penetrates the leader's
 *  clearance beyond G12_TOL_M. The builder's cap makes this structurally
 *  zero; the count is the measurement, not the guarantee. */
function measureCollision(
  track: TrackPoint[],
  leader: { track: TrackPoint[]; gapM: number } | null | undefined,
): { violations: number; maxPenM: number } {
  if (!leader || track.length === 0) return { violations: 0, maxPenM: 0 };
  let violations = 0;
  let maxPenM = 0;
  const tEnd = track[track.length - 1].t;
  for (let t = track[0].t; t <= tEnd; t += 1000) {
    const pen = evalTrack(track, t) - (evalTrack(leader.track, t) - leader.gapM);
    if (pen > G12_TOL_M) violations++;
    if (pen > maxPenM) maxPenM = pen;
  }
  return { violations, maxPenM: round2(maxPenM) };
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
  bindingSteps: ('none' | 'curve' | 'hold' | 'regime' | 'queue')[],
  profile: DriveProfile,
  geom: RouteGeometry,
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
  // Merges whose RESULTING chord would cross the curve envelope at its own
  // positional midpoint (the G4 inequality, pre-checked with a slightly
  // tighter guard and a ±2 m probe against compression position drift) are
  // FORBIDDEN: the §11 corner protection alone provably misses monotone
  // descents THROUGH a dip — braking into a hold across a curve zone has no
  // local v-minimum to protect, yet the merged chord's midpoint lands in the
  // dip with a mean above its cap (measured live 2026-08-17: the interior
  // offender class, e.g. 6.05 m/s across a 3.91 cap at t+63 s). The emitted
  // chord speed IS (vFine[l]+vFine[r])/2 exactly, so the check is exact in
  // speed. Rejections re-evaluate after every merge (neighbours changed).
  const forbidden = new Set<number>();
  // The guard evaluates the cap at the EMITTED positional midpoint — the
  // accumulated endpoint-trapezoid position, exactly what measureTrack and
  // the wire will see. Fine-position approximations drifted metres apart deep
  // in budget-forced horizons and let a far-horizon chord slip the guard yet
  // fail the gate (measured live 2026-08-17: opinion seg#21 at t+99 s).
  const capGuardOk = (jBound: number): boolean => {
    const l = bounds[jBound - 1];
    const r = bounds[jBound + 1];
    const chord = (vFine[l] + vFine[r]) / 2;
    let sEmL = sFine[0];
    for (let k = 1; k < jBound; k++) {
      sEmL += ((vFine[bounds[k - 1]] + vFine[bounds[k]]) / 2) * (bounds[k] - bounds[k - 1]) * DT_S;
    }
    const mid = sEmL + (chord * (r - l) * DT_S) / 2;
    return chord <= curveEnvAt(profile, geom, mid) * 1.05 + 0.25;
  };
  while (bounds.length > 2) {
    let best = -1;
    let bestCost = Infinity;
    for (let j = 1; j < bounds.length - 1; j++) {
      if (prot.has(bounds[j]) || forbidden.has(bounds[j])) continue;
      const c = cost(j);
      if (c < bestCost) {
        bestCost = c;
        best = j;
      }
    }
    if (best === -1) {
      // Every interior knot is protected or forbidden. Over budget ⇒ merge
      // the farthest such knot anyway — directly, so the guard cannot
      // re-reject it forever (pathological, counted; far-horizon fidelity is
      // repainted by the next emission). Forbidden marks go first: they are
      // the weaker guarantee. At/under budget ⇒ done.
      if (bounds.length <= TRAJ_MAX_POINTS) break;
      let fj = -1;
      for (let j = bounds.length - 2; j >= 1; j--) {
        if (forbidden.has(bounds[j])) {
          fj = j;
          break;
        }
      }
      if (fj < 0) {
        for (let j = bounds.length - 2; j >= 1; j--) {
          if (prot.has(bounds[j])) {
            fj = j;
            break;
          }
        }
      }
      if (fj < 0) break; // only endpoints left — cannot happen over budget
      forbidden.delete(bounds[fj]);
      prot.delete(bounds[fj]);
      bounds.splice(fj, 1);
      pressureDrops++;
      budgetForced = true;
      if (forbidden.size > 0) forbidden.clear();
      continue;
    }
    if (bounds.length <= TRAJ_MAX_POINTS && bestCost > FREE_M) break;
    if (!capGuardOk(best)) {
      forbidden.add(bounds[best]);
      continue;
    }
    if (bounds.length > TRAJ_MAX_POINTS && bestCost > FREE_M) budgetForced = true;
    bounds.splice(best, 1);
    if (forbidden.size > 0) forbidden.clear();
  }

  // Post-compression repair (G4 literal zero): upstream merges shift
  // downstream EMITTED positions AFTER those segments passed their own guard
  // check — the last live offender class (10 per 578 k segments, all at
  // t+84…116 s where prefix drift is largest, 2026-08-17). Re-verify every
  // segment against its FINAL emitted midpoint; split any violator at the
  // fine step sitting deepest in the envelope dip (protected), then re-merge
  // the cheapest guard-passing knot if over budget. Rounds are bounded: each
  // inserts one knot and the violating population is ~1–2 per affected track.
  for (let round = 0; round < 6; round++) {
    const sEm = new Array<number>(bounds.length);
    sEm[0] = sFine[0];
    for (let k = 1; k < bounds.length; k++) {
      sEm[k] =
        sEm[k - 1] + ((vFine[bounds[k - 1]] + vFine[bounds[k]]) / 2) * (bounds[k] - bounds[k - 1]) * DT_S;
    }
    let worstK = -1;
    let worstExcess = 0;
    for (let k = 1; k < bounds.length; k++) {
      const chord = (vFine[bounds[k - 1]] + vFine[bounds[k]]) / 2;
      const cap = curveEnvAt(profile, geom, (sEm[k - 1] + sEm[k]) / 2);
      const excess = chord - (cap * 1.05 + 0.25);
      if (excess > worstExcess) {
        worstExcess = excess;
        worstK = k;
      }
    }
    if (worstK < 0) break;
    const l = bounds[worstK - 1];
    const r = bounds[worstK];
    if (r - l < 2) break; // single fine step — pointwise, not a chord artefact
    let ins = -1;
    let insEnv = Infinity;
    let acc = sEm[worstK - 1];
    for (let k2 = l + 1; k2 < r; k2++) {
      acc += ((vFine[k2 - 1] + vFine[k2]) / 2) * DT_S;
      const e = curveEnvAt(profile, geom, acc);
      if (e < insEnv) {
        insEnv = e;
        ins = k2;
      }
    }
    if (ins < 0) break;
    bounds.splice(worstK, 0, ins);
    prot.add(ins);
    while (bounds.length > TRAJ_MAX_POINTS) {
      let best = -1;
      let bestCost = Infinity;
      for (let j = 1; j < bounds.length - 1; j++) {
        if (prot.has(bounds[j])) continue;
        if (!capGuardOk(j)) continue;
        const c = cost(j);
        if (c < bestCost) {
          bestCost = c;
          best = j;
        }
      }
      if (best === -1) {
        let fj = -1;
        for (let j = bounds.length - 2; j >= 1; j--) {
          if (bounds[j] !== ins && prot.has(bounds[j])) {
            fj = j;
            break;
          }
        }
        if (fj < 0) break;
        prot.delete(bounds[fj]);
        bounds.splice(fj, 1);
        pressureDrops++;
        budgetForced = true;
        continue;
      }
      if (bestCost > FREE_M) budgetForced = true;
      bounds.splice(best, 1);
    }
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
): {
  curveViolations: number;
  curveDetail: CurveViolationDetail[];
  phantomDips: number;
  dipDetail: DipDetail[];
} {
  const { points, v } = emitted.track;
  let curveViolations = 0;
  const curveDetail: CurveViolationDetail[] = [];
  for (let i = 1; i < points.length; i++) {
    const dtS = (points[i].t - points[i - 1].t) / 1000;
    if (dtS <= 0) continue;
    const vSeg = (points[i].s - points[i - 1].s) / dtS;
    const cap = curveEnvAt(profile, geom, (points[i].s + points[i - 1].s) / 2);
    if (vSeg > cap * 1.05 + 0.3) {
      curveViolations++;
      curveDetail.push({
        seg: i,
        vSeg: round2(vSeg),
        cap: round2(cap),
        atS: Math.round((points[i - 1].t - points[0].t) / 1000),
      });
    }
  }
  let phantomDips = 0;
  const dipDetail: DipDetail[] = [];
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
      dipDetail.push({
        seg: k,
        atS: Math.round((points[k].t - points[0].t) / 1000),
        sM: round2(points[k].s),
        vPrev: round2(v[k - 1]),
        vDip: round2(v[k]),
        vNext: round2(v[k + 1]),
      });
    }
  }
  return { curveViolations, curveDetail, phantomDips, dipDetail };
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
  // Anchor-floor hotfix: `raw` arrives floored at the anchor fix (the fix is
  // a hard floor), and on age re-emissions s0 is additionally floored at the
  // previously rendered opinion position (ageFloorS) — the drive integrates
  // forward-only, so flooring s0 floors the whole curve.
  const ageFloor = clamp(args.ageFloorS ?? 0, 0, geom.totalM);
  const holdingNow = modal !== null && modal.releaseAtMs > t0;
  // §14.3 jam hold: evidence-backed stuck position wins over the ML nowcast
  // (the dispatcher yields to reality) — hold there until movement evidence
  // (which arrives as a fix-driven re-emission) or the staleness release.
  const stuckHoldEndMs =
    !holdingNow && args.stuckAtM != null ? args.anchorMs + STUCK_HOLD_MAX_AGE_S * 1000 : 0;
  const jamHolding = stuckHoldEndMs > t0;
  const s0Base = holdingNow
    ? clamp(modal.stopS, 0, geom.totalM)
    : jamHolding
      ? clamp(args.stuckAtM!, 0, geom.totalM)
      : modal !== null
        ? clamp(Math.max(modal.stopS, raw[0].s), 0, geom.totalM)
        : clamp(raw[0].s, 0, geom.totalM);
  const ageFloorApplied = ageFloor > s0Base;
  let s0 = ageFloorApplied ? ageFloor : s0Base;
  // §14.5 innovation gate (asymmetric by design): only an AGE re-emission's
  // small FORWARD nowcast jitter is held back — it continues the previous
  // curve instead of hopping. Backward is already floored above; fix-driven
  // re-anchors never reach this branch (ageFloor = 0), so fresh evidence —
  // including a jam-exit departure — is never dampened.
  if (!holdingNow && !jamHolding && ageFloor > 0 && s0 > ageFloor && s0 - ageFloor <= AGE_INNOV_GATE_M) {
    s0 = ageFloor;
  }
  // §14.7 seam rule (fix-driven re-anchors): the nowcast lands at
  // fix + ds(latency), which is routinely BEHIND where the previous curve was
  // already rendering — the phone swaps bundles up to ~9 s after emission and
  // draws the difference as a backward teleport (measured 2026-08-18: p90
  // ≈ 75 m of backward step on the published chain). When the newest fix
  // cannot exclude the previous projection (prevO ≤ seamJustifiedM: fix +
  // fixAge·vObs + TOL, vObs from the fixes themselves), CONTINUITY wins: the
  // new opinion starts AT the previous projection. Beyond the bound the old
  // curve provably overshot (e.g. it rolled while the fixes stood) and the
  // honest backward correction — never below the fix (G10) — is emitted
  // unchanged. Standing evidence (modal/jam hold) skips this floor entirely.
  let seamFloorApplied = false;
  if (
    !holdingNow &&
    !jamHolding &&
    prev !== null &&
    prev.tripId === args.tripId &&
    args.prevFixS !== undefined &&
    args.anchorFixS !== undefined
  ) {
    const prevO = evalTrack(prev.opinion.points, t0);
    const justified = seamJustifiedM({
      anchorFixS: args.anchorFixS,
      anchorMs: args.anchorMs,
      emittedAtMs: t0,
      prevFixS: args.prevFixS,
      fixGapS: args.fixGapS,
    });
    if (prevO <= justified && s0 < prevO) {
      s0 = clamp(prevO, 0, geom.totalM);
      seamFloorApplied = true;
    }
  }
  // §14.4 seam clamp: the opinion may never re-anchor THROUGH its leader's
  // curve. When the ML nowcast claims an overtake the fix ordering denies
  // (measured live 2026-08-17: a curve "overtaking" a real leader by 289 m),
  // physical consistency wins — beauty constraints are hard, accuracy adapts.
  // Floored at the own anchor fix (G10): if the fixes themselves sit closer
  // than the nominal gap, the residual overlap is frozen by the queue cap.
  if (args.leader && !holdingNow && !jamHolding) {
    const cap = Math.max(
      clamp(args.anchorFixS ?? 0, 0, geom.totalM),
      evalTrack(args.leader.opinion, t0) - args.leader.gapM,
    );
    if (s0 > cap) s0 = cap;
  }
  const standingStart = holdingNow || jamHolding;
  const samePrevTrip = prev !== null && prev.tripId === args.tripId;
  // The opinion RE-ANCHORS its position on every fix (protocol), so inheriting
  // the previous speed is a smoothness nicety, not a continuity contract — and
  // a re-anchor INTO a curve zone must not import a speed above the local cap.
  // The cap is the MARGIN-AWARE seam cap, not the raw envelope: the raw value
  // assumes braking already at full A_BRK, while the inherited accel still has
  // to build under jerk — a raw-capped seam kept printing G4 violations one to
  // two segments in (measured live 2026-08-17, age-seam prevChord 9.99 capped
  // to raw 9.56 and still 7.37 across a 6.72 cap). If the cap bites, the
  // inherited accel must not stay positive (it would push v back over).
  const a0Raw = standingStart ? 0 : samePrevTrip ? accelAt(prev.opinion, t0) : 0;
  const vSeamCap = seamSpeedCap(profile, geom, s0, a0Raw);
  const vInherit = samePrevTrip
    ? speedAt(prev.opinion, t0)
    : Math.max(0, Math.min(TRAJ_V_MAX_MS, (evalTrack(raw, t0 + TRAJ_SIM_STEP_MS) - raw[0].s) / DT_S));
  const v0 = standingStart ? 0 : Math.min(vSeamCap, vInherit);
  const a0 = standingStart ? 0 : vInherit > vSeamCap ? Math.min(a0Raw, 0) : a0Raw;
  const modalS = modal !== null ? clamp(modal.stopS, 0, geom.totalM) : null;

  // ── stop plan: every platform ahead is SERVED (§4.2) — except §14.2
  // request stops the evidence says the real tram passes without holding.
  // s0 ≥ modal.stopS in every branch (incl. the age-floored hold), so the
  // plan starts from wherever the drive actually stands.
  const planFrom = s0;
  const plan: PlanStop[] = [];
  const requestSkips: { stopId: string; distM: number }[] = [];
  const skipTauMs: number[] = [];
  const lastStop = geom.stops.length > 0 ? geom.stops[geom.stops.length - 1] : null;
  for (const st of geom.stops) {
    if (st.distM <= planFrom + STOP_REACH_M) continue;
    const distM = Math.min(st.distM, geom.totalM);
    const isTerminal = st.isTerminal || st === lastStop;
    if (!isTerminal && requestStopSkippable(raw, surfaces, st.stopId, distM)) {
      requestSkips.push({ stopId: st.stopId, distM });
      const tauSkip = mlCrossingMs(raw, distM);
      if (tauSkip !== null) skipTauMs.push(tauSkip);
      continue;
    }
    plan.push({ distM, stopId: st.stopId });
  }

  // §14.4 effective gap: never demand more clearance than actually existed at
  // the seam — reality sometimes runs tighter than the registry length (fix
  // noise, uncoupled sets, stale leader curves), and charging that inherited
  // spacing as a violation every sampled second is measurement error, not a
  // collision (measured live 2026-08-17: 254 "violations" in 4 min, all
  // pre-existing-overlap class). The constraint prevents CROSSING and never
  // lets an inherited overlap grow; it does not teleport followers backward.
  const effLeader = (
    track: TrackPoint[],
    sStart: number,
  ): { track: TrackPoint[]; gapM: number } | null => {
    if (!args.leader) return null;
    const clear0 = evalTrack(track, t0) - sStart;
    // Inverted pair: the "follower" already sits well past this leader curve —
    // an ordering artifact (stale fixes / just-overtaken), not a queue. A cap
    // here would chain the vehicle to a phantom behind it (measured live
    // 2026-08-17: one inverted pair printed 202 m of "penetration" per
    // emission and stood the follower mid-street).
    if (clear0 < -5) return null;
    return { track, gapM: Math.min(args.leader.gapM, Math.max(0, clear0 - 0.5)) };
  };
  const leaderO = args.leader ? effLeader(args.leader.opinion, s0) : null;

  // ── opinion: the drive ───────────────────────────────────────────────────
  const oFine = runDrive({
    grid,
    geom,
    profile,
    surfaces,
    raw,
    plan,
    initialHoldEndMs: holdingNow ? modal.releaseAtMs : jamHolding ? stuckHoldEndMs : null,
    initialHoldJam: jamHolding,
    modalS,
    skipTauMs,
    leader: leaderO,
    s0,
    v0,
    a0,
    mode: 'ladder',
  });
  if (oFine === null) return null;
  const oEmit = emitCompressed(grid, oFine.v, oFine.s, oFine.protectedSteps, oFine.binding, profile, geom);
  if (oEmit === null) return null;
  const oMeasure = measureTrack(oEmit, oFine, profile, geom);
  const oStands = scanStands(oFine, geom, modalS);
  const opinionMeta: TrackBuildMeta = {
    knots: oEmit.track.points.length,
    pressureDrops: oEmit.pressureDrops,
    budgetForced: oEmit.budgetForced,
    ...oMeasure,
    ...oStands,
    ...collisionMeta(measureCollision(oEmit.track.points, leaderO)),
    infeasibleSkips: oFine.infeasibleSkips,
    regime: null,
  };

  // ── smooth: same drive re-run from the C¹⁺ seam under the regime table ───
  let discKind: 'none' | 'trip' | 'gap' | 'break' = 'none';
  let tDiscM: number | null = null;
  let seamGapM: number | null = null;
  let sEmit = oEmit;
  let smoothMeta = opinionMeta;
  if (prev === null && args.chainBroken === true) {
    discKind = 'break'; // honest re-appearance: clients may fade once
  }
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
      // The smooth seam keeps POSITION exactly (G9 ≤ 2 m, untouched); its
      // inherited speed is a C¹ nicety with the same trap as the opinion's:
      // the previous emission's CHORD speed at t_E can exceed the local curve
      // envelope when that chord spans a dip (legal on the wire at its own
      // midpoint), and importing it prints G4 violations decaying off the
      // seam (measured live 2026-08-17: the seg#1–4 smooth offender class).
      // Cap by the margin-aware seam cap; if it bites, the inherited accel
      // must not stay positive.
      const sSm = clamp(sStart, 0, geom.totalM);
      const leaderS = args.leader ? effLeader(args.leader.smooth, sSm) : null;
      const aSmRaw = accelAt(prev.smooth, t0);
      const vSmCap = seamSpeedCap(profile, geom, sSm, aSmRaw);
      const vSmInherit = speedAt(prev.smooth, t0);
      const fitted = runDrive({
        grid,
        geom,
        profile,
        surfaces,
        raw,
        plan,
        initialHoldEndMs: null,
        modalS,
        leader: leaderS,
        s0: sSm,
        v0: Math.min(vSmCap, vSmInherit),
        a0: vSmInherit > vSmCap ? Math.min(aSmRaw, 0) : aSmRaw,
        mode: 'regimes',
        ref: { fine: oFine, gateMs },
      });
      if (fitted === null) return null;
      const fittedEmit = emitCompressed(grid, fitted.v, fitted.s, fitted.protectedSteps, fitted.binding, profile, geom);
      if (fittedEmit === null) return null;
      sEmit = fittedEmit;
      const sMeasure = measureTrack(fittedEmit, fitted, profile, geom);
      smoothMeta = {
        knots: fittedEmit.track.points.length,
        pressureDrops: fittedEmit.pressureDrops,
        budgetForced: fittedEmit.budgetForced,
        ...sMeasure,
        ...scanStands(fitted, geom, modalS),
        ...collisionMeta(measureCollision(fittedEmit.track.points, leaderS)),
        infeasibleSkips: fitted.infeasibleSkips,
        regime: fitted.regime,
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
    meta: {
      discKind,
      tDiscM,
      seamGapM,
      ageFloorApplied,
      seamFloorApplied,
      requestSkips,
      jamHolding,
      leaderKey: args.leader?.key ?? null,
      opinion: opinionMeta,
      smooth: smoothMeta,
    },
  };
}
