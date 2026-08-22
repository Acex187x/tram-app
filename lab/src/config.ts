// Lab configuration — env-driven so the same code runs on the host (smoke
// tests, CONVEX_URL=https://tram-api.acex.sh) and inside the compose network
// (CONVEX_URL=http://tram-convex-backend:3210).

export const CONVEX_URL = process.env.CONVEX_URL ?? 'https://tram-api.acex.sh';
/** Shared secret for `trajectories:publish` (convex/trajectories.ts). Empty ⇒
 * Convex publishing is disabled and the service serves HTTP only (lab mode). */
export const ENGINE_PUSH_TOKEN = process.env.ENGINE_PUSH_TOKEN ?? '';

/** Two-phase emission, pass-1 gate: the instant naive re-anchor is emitted
 * only when the old curve is MATERIALLY wrong about the new fix (further off
 * than this), overrun entirely, or gone. Below the gate the still-valid ML
 * curve keeps rendering until the pass-2 upgrade — an unconditional naive
 * middle step degraded every fix window with a worse model + two extra seams
 * (build-22 field report: «нестабильно, клоунада»). */
export const INSTANT_NAIVE_GAP_M = 25;

/** ── fused fix axis (2026-08-22) ─────────────────────────────────────────
 * The feed's two representations of one fix — coordinates vs shape_dist —
 * contradict each other by up to ±70 m, and the AXIS is the one that freezes
 * (it also snaps to stops) while the coordinates are the actual sensor. The
 * engine therefore re-derives the axis value from the coordinates whenever
 * the two disagree beyond FUSE_COORD_DISAGREE_M and the projection lands
 * within FUSE_OFFTRACK_MAX_M of the rail, with a monotone guard (trams do
 * not reverse; a backward projection is distrusted beyond
 * FUSE_BACKWARD_TOL_M). One axis for everything downstream: ML anchors and
 * features, jam evidence, seams, published anchorS. Kill switch:
 * FUSE_FIX_AXIS=0. */
export const FUSE_FIX_AXIS = (process.env.FUSE_FIX_AXIS ?? '1') === '1';
export const FUSE_COORD_DISAGREE_M = 30;
export const FUSE_OFFTRACK_MAX_M = 35;
export const FUSE_BACKWARD_TOL_M = 15;
/** A correction bigger than this is NOT a feed contradiction (those measure
 * ≤ ~150 m) — it is an ambiguous projection: loops and opposite-direction
 * rails sit within FUSE_OFFTRACK_MAX_M of each other, and the nearest-point
 * projection can land a lap/direction away (9383: −510 m). Distrust it. */
export const FUSE_MAX_CORRECTION_M = 250;

/** §14.3 jam cross-check: the axis (shape_dist) routinely freezes while the
 * same fixes' COORDINATES keep driving (feed self-contradiction, ±70 m —
 * measured 2026-08-22). A jam is asserted only when the coords' projected
 * advance between the two fixes is also under this bound; a bigger advance is
 * movement evidence and vetoes the phantom hold («трамвай стоит и ждёт далеко
 * от старого фикса» — owner field report, build 23). */
export const STUCK_COORD_EPS_M = 40;

/** Naive walker fallback: cap on how many seconds of feed latency it may
 * dead-reckon past the fix (a standing tram must not be inflated forward by
 * pace × fix-age — the build-22 backward-teleport source). */
export const NAIVE_LATENCY_CAP_S = 15;
export const SITE_URL = process.env.SITE_URL ?? 'https://tram-site.acex.sh';
export const ML_URL = process.env.ML_URL ?? 'http://tram-lab-ml:8092';
export const DB_PATH = process.env.LAB_DB ?? `${__dirname}/../data/lab.db`;
export const HTTP_PORT = Number(process.env.LAB_PORT ?? 8090);

/** Diff-stream poll cadence (the backend publishes batches at 2 s). */
export const POLL_MS = 2_000;
/** Shadow-engine tick cadence (engine contract allows dt up to 1000 ms). */
export const TICK_MS = 1_000;
/** Rollup cadence (one row per variant×bucket per minute). */
export const ROLLUP_MS = 60_000;
/** Learned-table flush + poller-health sample cadence. */
export const FLUSH_MS = 30_000;

/** Mirror of the engine's FEED_LATENCY_S: a fix is ~this much older than its
 * origin_timestamp claims by the time any consumer sees it. */
export const FEED_LATENCY_MS = 5_000;

/** Scoring gate: only score fix gaps inside this window (mirrors the
 * calibration program's usable-span window). */
export const SCORE_MIN_GAP_S = 4;
export const SCORE_MAX_GAP_S = 300;

/** Trajectory keyframe feed (GET /api/trajectories) — the experimental app ML
 * mode fetches these and dumb-lerps between the points, so the shape of the
 * feed IS the contract: TRAJ_POINTS samples spaced TRAJ_STEP_MS apart, the
 * first one at the computation instant (⇒ 120 s of horizon at 10 s spacing). */
export const TRAJ_STEP_MS = 10_000;
export const TRAJ_POINTS = 13;
/** Max feature rows per ML inference request (chunked vehicle-aligned). */
export const TRAJ_ML_MAX_ROWS = 2_000;
/** Serialized-response cache: hammering the endpoint must stay free. Both v1
 * and v2 freeze their whole payload (serverNowMs included) for this window, so
 * repeated fetches inside it are byte-identical — the cost is that a client's
 * clock offset can be up to this much stale. */
export const TRAJ_JSON_TTL_MS = 2_000;

/** ── physics v3 (docs/research/physics-v3-protocol.md), GET /api/trajectories/v2
 * The protocol is FROZEN; these are its numeric constants. */
/** The smooth track must reach the opinion track within this window — WHEN
 * the kinematic limits below allow it (protocol §Extended-convergence). */
export const TRAJ_CONVERGE_MS = 30_000;
/** Floor on the "time left to close the gap" divisor, seconds. Past the
 * convergence window the residual gap keeps closing with this time constant
 * instead of demanding an infinite (and then clamped) speed. */
export const TRAJ_CONVERGE_MIN_S = 3;
/** |rendered − opinion| above this at emission ⇒ honest teleport, not a blend. */
export const TRAJ_DISCONTINUITY_M = 150;
/** Modal stop rule: hold at the platform while P(departed) < this. */
export const TRAJ_MODAL_P = 0.6;
/** Hard per-track keyframe cap from the protocol. */
export const TRAJ_MAX_POINTS = 24;

/** ── Kinematic limits (protocol §Kinematic limits — a CONTRACT property).
 * Vehicle-capability ceiling, 60 km/h. Deliberately above the 50 km/h network
 * cap the old engine used (V_MAX_MS = 13.9): this is a never-lie bound, not a
 * pace target — the ML curve decides how fast a tram is actually drawn. */
export const TRAJ_V_MAX_MS = 16.7;
/** Service acceleration / braking, m/s² — the SAME constants the shipped
 * engine used (lab/vendor/engine/speedProfile.ts A_ACC / A_BRK, calibrated
 * against real stop exits, field feedback 2026-07-13). */
export const TRAJ_A_ACC = 1.3;
export const TRAJ_A_BRK = 1.4;

/** Gate tolerances: what check-v2.mjs and the live counters assert on the
 * WIRE values, i.e. after `s` is rounded to cm and `t` to whole ms. A segment
 * of duration Δt carries ≤ 0.01/Δt m/s of speed-rounding noise and ≤ 0.02/Δt
 * m/s² of acceleration noise; with TRAJ_MIN_SEG_MS ≥ 1000 that is ≤ 0.01 and
 * ≤ 0.02, comfortably inside this slack. */
export const TRAJ_V_MAX_GATE_MS = 17.0;
export const TRAJ_A_ACC_GATE = 1.35;
export const TRAJ_A_BRK_GATE = 1.45;

/** ── curvegen v3 (docs/research/curvegen-v3-design.md §5) ──
 * Comfort jerk cap of the virtual-tram drive, m/s³ — inside the 0.5–1.0
 * comfort band of the rail literature, half the EN 13452-1 jolt limit (1.5).
 * Wire-observable jerk (Δ of consecutive central-difference accels ÷ time
 * between their centres) is ≤ J_MAX by construction (averages of a
 * J-Lipschitz function over adjacent windows); the gate absorbs cm/ms
 * rounding, mirroring the +0.05 accel slack. */
export const TRAJ_J_MAX = 0.8;
export const TRAJ_J_GATE = 0.9;
/** G3 accel sign-flip deadband, m/s²: phases with |a| ≤ this neither count as
 * a sign nor reset the previous one (design §8 G3). */
export const TRAJ_FLIP_DEADBAND = 0.2;
/** G5 convergence target: |smooth − opinion| below this counts as converged,
 * m (≈ one tram length, design §10 CONV_TOL_M). */
export const TRAJ_CONV_TOL_M = 15;

/** ── §14.7 re-anchor seam rule (owner field report 2026-08-18) ──
 * A fix-driven re-anchor may step the rendered opinion BACKWARD only when the
 * newest fix actually justifies it: the previous curve's projection is beyond
 * `latestFixS + fixAge · vObs + TOL` (vObs = fix-over-fix observed speed —
 * evidence, not model). Inside that bound the old projection is consistent
 * with everything the feed knows, so the new opinion STARTS AT it
 * (continuity); a backward hop there is the swap-regression class the phone
 * renders as «маркер улетел назад за фикс» (G13). This constant is the
 * evidence slack of that bound, m — fix/shape-projection noise plus one
 * fix-gap of speed-estimate error, chosen from the measured 2026-08-18
 * pre-fix window (see lab/README.md Findings). */
export const TRAJ_REANCHOR_TOL_M = 20;
/** §14.7 standing-assertion floor, ms: a modal hold outranks the continuity
 * floor only when it actually RENDERS standing — release later than this
 * beyond the emission instant. A hold releasing within the sliver asserts no
 * standing evidence (the release model itself believes the tram is leaving),
 * yet it still yanked the seam back to the platform for a blink and printed
 * exactly the G13 class the rule exists to kill (measured live 2026-08-18
 * 00:34Z: 50–126 m backward swaps on both chains, byte-checker caught, the
 * too-broad generator exemption did not). 5 s = the byte checker's own
 * standing-observability window. */
export const TRAJ_STAND_ASSERT_MS = 5_000;

/** ── curvegen-v3 flip flag (design §12 phase B) ──
 * OFF: /api/trajectories/v2 serves the CURRENT generator unchanged and the v3
 * drive runs shadow-only (/api/shadow-trajectories, variants ml-drive /
 * ml-drive-smooth). ON: the published bundle is built by the v3 drive (the
 * shadow chain keeps running for the overlap week). Flip = set the env var
 * (or this default) and restart tram-lab — one line either way. */
export const TRAJ_V3_PUBLISH = (process.env.TRAJ_V3_PUBLISH ?? '0') === '1';

/** Fine grid the kinematic profile is simulated on before being compressed
 * onto ≤ TRAJ_MAX_POINTS breakpoints. */
export const TRAJ_SIM_STEP_MS = 1_000;
/** No emitted segment shorter than this (keeps wire-rounding noise ≪ gate).
 * Enforced structurally: knots are a SUBSET of the TRAJ_SIM_STEP_MS grid, so
 * segments are multiples of it — keep TRAJ_SIM_STEP_MS ≥ TRAJ_MIN_SEG_MS. */
export const TRAJ_MIN_SEG_MS = 1_000;
/** Reference speed below which the target curve counts as STANDING. */
export const TRAJ_HOLD_V_MS = 0.3;
/** A standing run must last at least this long to be treated as a stop the
 * profile has to brake into (shorter flats are model jitter). */
export const TRAJ_HOLD_MIN_MS = 4_000;

/** Horizon buckets for rollups (fix gap seconds → label). */
export function horizonBucket(gapS: number): string {
  if (gapS < 30) return '<30s';
  if (gapS < 60) return '30-60s';
  if (gapS < 120) return '60-120s';
  return '120s+';
}
export const HORIZON_BUCKETS = ['<30s', '30-60s', '60-120s', '120s+'];

/** Learned-surface geometry bucketing (mirrors convex/calibration/keys.ts). */
export const SEG_BUCKET_M = 250;

/** Learning gates (mirrors convex/calibration/fold.ts R13 semantics). */
export const SPAN_MIN_GAP_S = 8;
export const SPAN_MAX_GAP_S = 240;
export const SPAN_MIN_DIST_M = 15;
export const SPAN_MAX_SPEED_MS = 22;
export const DWELL_FLAT_M = 15;
export const DWELL_MIN_S = 5;
export const DWELL_MAX_S = 300;
export const RELEASE_MIN_S = 4;
export const RELEASE_MAX_S = 180;

/** EWMA half-life (parity with the server calibration). */
export const EWMA_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Learned predictor fallbacks (used until cells accumulate weight). */
export const DEFAULT_PACE_MS = 5.5; // m/s ≈ 19.8 km/h fleet-wide moving pace
export const DEFAULT_DWELL_S = 18;
export const DEFAULT_RELEASE_S = 20;
/** Minimum decayed weight before a cell is trusted over its parent. */
export const MIN_CELL_WEIGHT = 3;

/** Geometry negative-cache TTL after a 404 (trip not in GTFS yet). */
export const GEOMETRY_404_TTL_MS = 10 * 60 * 1000;
/** Re-fetch geometry after this age (server rebuilds daily). */
export const GEOMETRY_TTL_MS = 26 * 60 * 60 * 1000;
/** GET /api/geometry-pack: how long a gzipped cold-start pack is reused.
 * The active fleet's shape set barely moves minute to minute, and gzipping
 * megabytes is the most expensive thing the lab would otherwise do. */
export const GEOMETRY_PACK_TTL_MS = 60_000;

const HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  hour: '2-digit',
  hour12: false,
});
const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  weekday: 'short',
});

let hourCacheMin = -1;
let hourCacheVal = 0;
let dayCacheVal: 'weekday' | 'weekend' = 'weekday';

/** Prague local hour (0–23) + weekday/weekend, cached per wall minute. */
export function pragueContext(ms: number): { hour: number; dayType: 'weekday' | 'weekend' } {
  const min = Math.floor(ms / 60_000);
  if (min !== hourCacheMin) {
    hourCacheMin = min;
    hourCacheVal = Number(HOUR_FMT.format(new Date(ms)));
    const wd = DAY_FMT.format(new Date(ms));
    dayCacheVal = wd === 'Sat' || wd === 'Sun' ? 'weekend' : 'weekday';
  }
  return { hour: hourCacheVal, dayType: dayCacheVal };
}

/** 4-hour band 0..5 (parity with convex hourBandAt). */
export function hourBand(ms: number): number {
  return Math.floor(pragueContext(ms).hour / 4);
}
export function dayType(ms: number): 'weekday' | 'weekend' {
  return pragueContext(ms).dayType;
}
