// PREDICTOR sim (engine v2, docs/decisions/engine-v2.md §2.2): one physics sim
// per tram estimating where the REAL tram is right now. Pure TS, deterministic,
// no timers — the caller (TramEngine) drives ticks. This is layer 1 of the v2
// stack (fix → predictor → smoother): it reseeds on every genuinely-new AVL
// fix, dead-reckons at the vehicle's LEARNED pace between fixes, and owns every
// observation-pinned hold (arrival-fix pin, stuck-hold, staleness release).
// It chases NO target — there is no schedule-slope pace reference anywhere.
// "Live" mode renders it directly; the smoother (smoother.ts) chases it.
//
// The predictor's sM is NOT monotonic: a fresh fix reseeds it wherever the
// evidence says (forward or backward) — that jump is the accepted live-mode
// UX. Reseed jumps beyond the gap-aware teleport threshold (and the sanctioned
// terminal un-latch backward re-anchor) stamp lastTeleportMs so the renderer
// fades; the smoother is the layer that guarantees monotonic motion.

import type { RouteGeometry, RouteStop, TramSnapshot } from '@/lib/types';
import {
  A_ACC,
  A_BRK,
  brakeTowards,
  cruiseCapAt,
  DEFAULT_LOOKAHEAD_M,
  meanCruiseCapOver,
  todDwellFactor,
  todPaceFactor,
  V_CRUISE_REF_MS,
  vAllowedAt,
  type SpeedProfile,
} from './speedProfile';

export type SimPhase = 'cruise' | 'dwell' | 'terminal';

/** Hard-teleport threshold floor: |fresh fix − s| above this is desync. */
export const TELEPORT_THRESHOLD_M = 500;
/**
 * GAP-AWARE teleport threshold (feed-degradation defense, 2026-07-27).
 *
 * A teleport should mean "true desync", not "the feed got slow". With fixes
 * measured 65–134 s apart a tram legitimately covers 600–950 m, so the
 * threshold scales with the OBSERVED gap between consecutive fixes — the
 * error a correct estimate can honestly accumulate while blind — at
 * cruise-reference pace with margin, floored at the calibrated 500 and capped
 * at TELEPORT_THRESHOLD_MAX_M (beyond which it is desync no matter the gap).
 * v2 uses it two ways: to classify predictor reseed jumps (fade + no pace
 * sample) and as the smoother's snap threshold.
 */
export const TELEPORT_THRESHOLD_MAX_M = 1500;
/** Margin over cruise-reference pace when scaling the threshold by fix gap. */
export const TELEPORT_GAP_MARGIN = 1.25;
/** Fix-gap clamp for the threshold scale (s) — cold starts and dead feeds. */
export const TELEPORT_GAP_MIN_S = 45;
export const TELEPORT_GAP_MAX_S = 240;

/** The gap-aware threshold for one fix gap (see TELEPORT_THRESHOLD_MAX_M). */
export function teleportThresholdM(fixGapS: number): number {
  const gap = Math.min(TELEPORT_GAP_MAX_S, Math.max(TELEPORT_GAP_MIN_S, fixGapS));
  return Math.min(
    TELEPORT_THRESHOLD_MAX_M,
    Math.max(TELEPORT_THRESHOLD_M, gap * V_CRUISE_REF_MS * TELEPORT_GAP_MARGIN),
  );
}
/**
 * Physical bound on how far a fix may be advanced forward during a reseed:
 * the unseen tram cannot have travelled further than cruise-reference pace ×
 * the fix's TRUE age. The closed-form advance is a guess that must never
 * outrun physics (2026-07-27 feed degradation: uncapped anchors dragged sims
 * ~1 km ahead, then the next fix yanked them back).
 */
export function maxAdvanceM(fixAgeS: number): number {
  return Math.max(0, fixAgeS) * V_CRUISE_REF_MS;
}
/** A stop is "reached" when s is within this many meters of its distM. */
export const STOP_REACH_M = 2;
/** Fallback dwell when the feed gives none, seconds (jittered ±0..8 s). */
export const DEFAULT_DWELL_S = 18;
/** Max dt fed into one physics step, seconds. */
export const MAX_TICK_DT_S = 0.25;
/** Only stops MORE than this far behind s are seeded as already served. */
export const STOP_BEHIND_EPS_M = 0.5;
/**
 * Hidden feed latency, seconds (R12, docs/calibration/analysis-2026-07-20-
 * ride.md §2): the fix timestamp obsAt is NOT the moment the tram was at
 * obsDist — the ride decomposition shows the raw fix already trails reality
 * by +77 m at an apparent age of 0–15 s (≈ 8–14 s of pipeline latency beyond
 * obsAt). Every staleness clock AND the reseed advance therefore run on the
 * TRUE age `(now − obsAt) + FEED_LATENCY_S`. 3 → 5 at the v2 ship gate
 * (docs/calibration/baselines/gate-v2.md): the 3-ride decomposition shows the
 * dominant v2 error cycle is systematic behindness born at stale at-stop
 * holds; 5 s is the bottom of the ride-replay optimum band (~5–8 s), still
 * under the measured 8–14 s. TUNABLE — recalibrate on future ride recordings.
 */
export const FEED_LATENCY_S = 5;
/**
 * Staleness bound on observation-pinned stands, seconds of TRUE fix age
 * (see FEED_LATENCY_S): past it an unseen departure is likelier than a
 * record stand — the at-stop pin stops being authoritative and the dwell
 * fix-hold releases. 60 → 45 at the first ground-truth ride (2026-07-20):
 * the feed reports at_stop for 50–75 s while the real platform dwell is
 * 15–20 s (worst observed −374 m with a 60 s hold). 45 → 40 at the v2 ship
 * gate (docs/calibration/baselines/gate-v2.md) — the 2026-07-20 analysis
 * pre-registered 35–40 s (−33…−42% on that ride) but demanded ≥2 more rides
 * before going below one cadence p50; the 3-ride corpus now exists and the
 * v2 decomposition confirms the stale-hold tail as the dominant behind-mass
 * source. With FEED_LATENCY_S 5 the wall-clock release lands at ~35 s.
 */
export const STOP_HOLD_MAX_FIX_AGE_S = 40;
/**
 * ONE tolerance table for "the fix says the tram is STANDING at a platform"
 * (engine-v2.md §2.6 — v1 had two overlapping detectors with five distance
 * tolerances; v2 has exactly this table + STOP_HOLD_MAX_FIX_AGE_S above).
 */
export const STANDING_FIX = {
  /** Explicit at_stop feed state → platform match radius, m. */
  atStopMatchM: 50,
  /** Positional pin: fix rests within this of a platform, m. */
  positionalTolM: 20,
  /**
   * Inter-fix advance at or below this is standing evidence / AVL scatter;
   * above it is movement (releases pins and dwell holds), m.
   */
  moveEpsM: 8,
  /** A fix this far behind the dwell position still pins the dwell, m. */
  nearBehindM: 30,
} as const;
/**
 * Two genuinely new fixes within this many meters of each other mean the tram
 * is physically stuck (red light / jam / incident) — not moving at any pace.
 * The predictor holds AT the fix until a moving fix arrives.
 */
export const STUCK_FIX_EPS_M = 8;
/**
 * Stuck detection is suppressed when the fix lies within this of a stop —
 * standing at a platform is a dwell (the arrival pin owns it), not a jam, m.
 */
export const STUCK_NEAR_STOP_M = 40;
/**
 * Pace-bias EWMA half-life, seconds: a fix stream at a new pace dominates the
 * bias within ~2–3 min — drivers swap mid-route, and central districts without
 * dedicated tracks run persistently slower than outskirts with them.
 */
export const PACE_BIAS_HALF_LIFE_S = 150;
/** Clamp on one inter-fix real/expected speed ratio sample. */
export const PACE_BIAS_MIN_RATIO = 0.4;
export const PACE_BIAS_MAX_RATIO = 1.6;
/**
 * paceBias prior for a genuinely NEW vehicle (calibration round 1): the
 * fleet's converged bias median is ~0.58–0.63; starting at 1.0 simulated a
 * fresh tram ~1.7× too fast for its first ~4–5 min (cold-start sprint).
 */
export const PACE_BIAS_PRIOR = 0.62;
/**
 * Terminal un-latch tolerance, meters: while phase === 'terminal', a FRESH
 * observation placing the real tram more than this far BEHIND the latched
 * position re-anchors the predictor to the observation (calibration round 1
 * R2 — terminal was the worst per-mode error: signed p50 +324 m, because
 * 'terminal' is absorbing and sub-threshold errors never teleport). This is a
 * sanctioned BACKWARD re-anchor: it stamps lastTeleportMs and the engine
 * propagates it to the smoother as a fade-teleport (engine-v2.md §2.3).
 */
export const TERMINAL_UNLATCH_BEHIND_M = 150;
/** Inter-fix intervals shorter than this are too noisy to calibrate on, s. */
export const PACE_BIAS_MIN_DT_S = 8;
/** Inter-fix advances shorter than this are too noisy to calibrate on, m
 *  (R13: "no confident moving remainder" → the span is dropped). */
export const PACE_BIAS_MIN_DS_M = 15;
/** Fallback physical tram length when the caller passes none (T3-sized), m. */
export const DEFAULT_TRAM_LENGTH_M = 14.1;

export interface TramSim {
  /** snapshot.key duplicated for the engine's fleet-generic constraint passes. */
  key: string;
  geometry: RouteGeometry;
  profile: SpeedProfile;
  snapshot: TramSnapshot;
  /** Estimated distance of the REAL tram along shape, m. Jumps on reseeds. */
  sM: number;
  /** Estimated speed, m/s. Always ≥ 0. */
  vMs: number;
  phase: SimPhase;
  /** When the current dwell's base duration ends (ms epoch); 'dwell' only. */
  dwellUntilMs: number;
  /** Stop index (into geometry.stops) of the current dwell, or null. */
  dwellStopIdx: number | null;
  /**
   * THE stops-ahead representation (engine-v2.md §2.6): index of the first
   * stop not yet served. Stops[0..nextStopIdx) are behind/served — a prefix,
   * because serving is sequential. minStopDist is DERIVED (minStopDistOf).
   */
  nextStopIdx: number;
  /** Latest observed distance along shape (clamped to geometry), m. */
  obsDistM: number;
  /** ms epoch of that observation (snapshot.observedAtMs). */
  obsAtMs: number;
  /** Observed gap between the last two genuinely-new fixes, s (0 = only one). */
  lastFixGapS: number;
  /** Total physical length incl. any coupled trailer, m (tail at sM − lengthM). */
  lengthM: number;
  /** ms of the last SANCTIONED discontinuity (renderer fades); 0 if never. */
  lastTeleportMs: number;
  /**
   * Learned per-tram pace multiplier (1 = exactly the cruise-reference pace):
   * recency-weighted EWMA of real inter-fix average MOTION speed ÷ profile-
   * expected speed over the same span. Scales the cruise product so a tram
   * that runs at 70% of reference pace is predicted at ~70% between fixes.
   * Survives teleports and (via TramEngine's per-key memory) trip changes.
   */
  paceBias: number;
  /** Junction-yield hold point, m along shape (engine-written), or null. */
  yieldHoldM: number | null;
  /**
   * Stuck-hold anchor, m along shape (null = none): consecutive genuinely-new
   * fixes at one mid-segment point. Brake-to-a-stand target; released ONLY by
   * a fix that moved > STUCK_FIX_EPS_M (never by staleness — a jam outlasting
   * the fix cadence is still a jam).
   */
  stuckAtM: number | null;
  /**
   * Platform distM the LATEST fix pins the tram at (null = none). While set
   * and fresh (STOP_HOLD_MAX_FIX_AGE_S on the TRUE age) the fix is
   * authoritative that the tram is standing AT this stop right now.
   */
  fixStopDistM: number | null;
  /** Observed fix distance seen when the current/last dwell began, m. */
  dwellObsDistM: number;
  /**
   * R13 clip-not-drop bookkeeping: wall-clock ms the predictor spent in an
   * observation-pinned stand (fix-pin fresh or stuck-hold armed) since the
   * last pace sample. Deducted from the next inter-fix span so the sample
   * measures MOTION pace; reset on every genuinely-new fix.
   */
  holdAccumMs: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clampS(geometry: RouteGeometry, s: number): number {
  return Math.min(Math.max(s, 0), geometry.totalM);
}

function hashString(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Dwell duration for a stop: feed value (scheduled computed dwell — NEVER
 * time-of-day scaled), else the 18 s ± deterministic 0–8 s jitter default,
 * multiplied by todDwellFactor(nowMs) when a wall clock is provided (peak
 * boarding takes longer). Deterministic per stop so re-renders agree.
 */
export function dwellDurationMs(stop: RouteStop, nowMs?: number): number {
  if (stop.dwellSeconds > 0) return stop.dwellSeconds * 1000;
  const jitter = (hashString(stop.stopId) % 17) - 8; // deterministic, in [-8, 8]
  const baseMs = (DEFAULT_DWELL_S + jitter) * 1000;
  if (nowMs === undefined) return baseMs;
  return baseMs * todDwellFactor(nowMs);
}

export function isTerminalStop(geometry: RouteGeometry, stop: RouteStop): boolean {
  const stops = geometry.stops;
  return stop.isTerminal || (stops.length > 0 && stop === stops[stops.length - 1]);
}

/** Derived "stops below this are never 0-limits" bound (§2.6: ONE stops-ahead
 *  representation — nextStopIdx is primary, this is computed from it). */
export function minStopDistOf(sim: { geometry: RouteGeometry; nextStopIdx: number }): number {
  const i = sim.nextStopIdx;
  return i > 0 ? sim.geometry.stops[i - 1].distM + 0.01 : 0;
}

/** First stop not yet served, or null (stops[nextStopIdx]). */
export function nextUndwelledStop(sim: {
  geometry: RouteGeometry;
  nextStopIdx: number;
}): RouteStop | null {
  const stops = sim.geometry.stops;
  return sim.nextStopIdx < stops.length ? stops[sim.nextStopIdx] : null;
}

/**
 * True age of the latest fix, ms: wall time since obsAt PLUS the hidden feed
 * latency (FEED_LATENCY_S) — the fix was actually last-seen that much earlier
 * than its obsAt timestamp claims (R12).
 */
export function staleFixAgeMs(sim: TramSim, nowMs: number): number {
  return nowMs - sim.obsAtMs + FEED_LATENCY_S * 1000;
}

/** Whether the fix-pinned platform is still authoritative (fresh on TRUE age). */
export function fixPinActive(sim: TramSim, nowMs: number): boolean {
  return sim.fixStopDistM !== null && staleFixAgeMs(sim, nowMs) <= STOP_HOLD_MAX_FIX_AGE_S * 1000;
}

/**
 * Where the predictor is STANDING (the smoother's hold-follow reference,
 * engine-v2.md §2.3 — "predictor standing (dwell / stuck / pin / terminal),
 * i.e. vPred ≈ 0"): the platform/terminal it dwells at, the jam point it is
 * stuck-held on, or wherever a constraint (queue/junction) braked it to a
 * stand — a stationary reality estimate is a stand regardless of cause, and
 * a vPred≈0 track regime would otherwise strand the smoother TRAIL_M short
 * of it with no rule to close the gap. Null while the predictor is moving.
 */
export function holdPointOf(sim: TramSim): number | null {
  if (sim.phase === 'dwell' || sim.phase === 'terminal') return sim.sM;
  if (sim.vMs <= 0.1) return sim.sM;
  return null;
}

/**
 * Whether the predictor has served AND left the stop at `stopIdx` — the
 * smoother's per-stop dwell-sync predicate (engine-v2.md §2.3 stop rules).
 */
export function predictorPastStop(sim: TramSim, stopIdx: number): boolean {
  if (sim.nextStopIdx <= stopIdx) return false;
  return !(sim.phase === 'dwell' && sim.dwellStopIdx === stopIdx);
}

/** The predictor's cruise speed product (§2.6: ONE site computes this). */
export function cruiseProduct(sim: TramSim, nowMs: number): number {
  return (
    Math.min(cruiseCapAt(sim.profile, sim.geometry, sim.sM), V_CRUISE_REF_MS) *
    sim.paceBias *
    todPaceFactor(nowMs)
  );
}

/**
 * THE standing-fix detector (engine-v2.md §2.6 — one detector, one tolerance
 * table): which stop, if any, the latest fix pins the tram AT.
 *  - explicit `at_stop` feed state: the feed-declared stop (lastStopSequence)
 *    when it matches the geometry near the fix, else the nearest platform
 *    within atStopMatchM;
 *  - positional: the fix rests within positionalTolM of a platform AND has
 *    not moved more than moveEpsM since the previous fix (standing evidence —
 *    a tram sweeping past a platform shows a large inter-fix advance and is
 *    never pinned). Requires a previous fix; callers without one (a brand-new
 *    vehicle) pass null and get the explicit branch only.
 */
export function standingFix(sim: TramSim, prevObsDistM: number | null): RouteStop | null {
  const stops = sim.geometry.stops;
  const obs = sim.obsDistM;
  const snap = sim.snapshot;
  if (snap.statePosition === 'at_stop') {
    const seq = snap.lastStopSequence;
    if (seq !== null) {
      for (const st of stops) {
        if (st.sequence === seq && Math.abs(st.distM - obs) <= STANDING_FIX.atStopMatchM) {
          return st;
        }
      }
    }
    return nearestStopWithin(stops, obs, STANDING_FIX.atStopMatchM);
  }
  if (prevObsDistM === null || Math.abs(obs - prevObsDistM) > STANDING_FIX.moveEpsM) return null;
  return nearestStopWithin(stops, obs, STANDING_FIX.positionalTolM);
}

/** Nearest stop within `tolM` of the along-shape position, or null. */
function nearestStopWithin(stops: RouteStop[], obs: number, tolM: number): RouteStop | null {
  let best: RouteStop | null = null;
  let bestD = tolM;
  for (const st of stops) {
    if (st.distM > obs + tolM) break; // stops are ordered by distM
    const d = Math.abs(st.distM - obs);
    if (d <= bestD) {
      best = st;
      bestD = d;
    }
  }
  return best;
}

/**
 * Fix-hold on a running dwell: while the LATEST fix still shows the tram
 * standing at the dwell position, the dwell continues past its base duration —
 * the predictor must never depart a stop ahead of an at-stop fix (field
 * feedback #1). Releases when a fresh fix advances past the fix seen at dwell
 * entry (movement evidence) or when the pinning fix goes stale on the TRUE
 * age (the feed has latency; never wait forever).
 */
function fixPinsDwell(sim: TramSim, nowMs: number): boolean {
  if (staleFixAgeMs(sim, nowMs) > STOP_HOLD_MAX_FIX_AGE_S * 1000) return false;
  if (sim.obsDistM - sim.dwellObsDistM > STANDING_FIX.moveEpsM) return false; // fix moved on
  const behind = sim.sM - sim.obsDistM; // fix relative to the dwell position
  if (behind < -STANDING_FIX.moveEpsM) return false; // fix ahead beyond scatter
  if (behind <= STANDING_FIX.nearBehindM) return true;
  // Further behind: only an explicit at_stop feed state still counts.
  return sim.snapshot.statePosition === 'at_stop' && behind <= STANDING_FIX.atStopMatchM;
}

/**
 * ONE transient-reset with explicit opt-outs (engine-v2.md §2.6): clears the
 * motion/dwell/hold state a re-anchor invalidates. Observation state
 * (obsDistM/obsAtMs/paceBias/holdAccumMs) is never touched here.
 */
function resetTransients(
  sim: TramSim,
  opts: { keepStuck?: boolean; keepPin?: boolean; keepYield?: boolean } = {},
): void {
  sim.phase = 'cruise';
  sim.dwellUntilMs = 0;
  sim.dwellStopIdx = null;
  if (!opts.keepStuck) sim.stuckAtM = null;
  if (!opts.keepPin) sim.fixStopDistM = null;
  if (!opts.keepYield) sim.yieldHoldM = null;
}

/**
 * Served-stop prefix at an observed position: stops strictly behind the fix
 * (> STOP_BEHIND_EPS_M) and stops at/before the feed's last-stop sequence
 * (when it matches the geometry) are served. Returns the first UNSERVED index.
 */
function servedPrefixAt(sim: TramSim, atM: number): number {
  const stops = sim.geometry.stops;
  const snap = sim.snapshot;
  const atStop = snap.statePosition === 'at_stop';
  const lastSeq = snap.lastStopSequence;
  let hasSeq = false;
  if (lastSeq !== null) {
    for (const st of stops) {
      if (st.sequence === lastSeq) {
        hasSeq = true;
        break;
      }
    }
  }
  let idx = 0;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const seqBehind = hasSeq && (atStop ? stop.sequence < lastSeq! : stop.sequence <= lastSeq!);
    const distBehind = stop.distM < atM - STOP_BEHIND_EPS_M;
    if (seqBehind || distBehind) idx = i + 1;
  }
  return idx;
}

// ── reseed: closed-form segmented advance ────────────────────────────────────

/**
 * Mean pace over one inter-stop leg for the closed-form advance: the learned
 * cruise product evaluated against the leg's mean profile cap (never above
 * the leg's uncapped mean — a fast bias cannot defeat track limits in the
 * closed form any more than it can in tick()).
 */
function legPaceMs(sim: TramSim, aM: number, bM: number, wallMs: number): number {
  const capped = meanCruiseCapOver(sim.profile, sim.geometry, aM, bM, V_CRUISE_REF_MS);
  const uncapped = meanCruiseCapOver(sim.profile, sim.geometry, aM, bM);
  const p = capped * sim.paceBias * todPaceFactor(wallMs);
  return Math.max(0.5, Math.min(p, uncapped));
}

/**
 * Reseed the predictor from its CURRENT fix (obsDistM @ obsAtMs) and advance
 * to nowMs — the heart of §2.2. The advance is CLOSED-FORM, not replayed
 * physics: the span `(now − obsAt) + FEED_LATENCY_S` (the fix is OLDER than
 * obsAt claims — R12) is segmented by the stops ahead of the fix, moving at
 * the learned cruise pace between stops and spending scheduled/default dwell
 * at each — O(stops crossed), never hundreds of substeps inside ingest. The
 * advanced DISTANCE is additionally bounded by maxAdvanceM on the same true
 * age (the guess must never outrun physics).
 *
 * Observation-pinned holds short-circuit the advance:
 *  - standing fix (arrival pin): the tram IS at that platform — seed dwelling
 *    ON it, no advance;
 *  - stuck-hold: the tram IS at the jam point — seed standing AT the fix.
 *
 * `allowPin` is false only on the resync path, where the fix may already be
 * STALE — a stale at_stop state must advance past the platform, not re-pin it.
 */
function reseedFromFix(
  sim: TramSim,
  prevObsDistM: number | null,
  nowMs: number,
  allowPin = true,
): void {
  const geo = sim.geometry;
  const stops = geo.stops;
  const snap = sim.snapshot;
  const obs = sim.obsDistM;

  resetTransients(sim, { keepStuck: true, keepYield: true });
  sim.nextStopIdx = servedPrefixAt(sim, obs);

  // Arrival-fix pin: a fresh fix standing AT a platform is authoritative.
  const pin = allowPin ? standingFix(sim, prevObsDistM) : null;
  sim.fixStopDistM = pin ? pin.distM : null;
  if (pin) {
    sim.stuckAtM = null; // a platform stand is a dwell, not a jam
    sim.sM = clampS(geo, pin.distM);
    sim.vMs = 0;
    // The pinned stop and everything before it is at/behind the tram.
    let idx = sim.nextStopIdx;
    while (idx < stops.length && stops[idx].distM <= pin.distM + STOP_REACH_M) idx++;
    sim.nextStopIdx = Math.max(sim.nextStopIdx, idx);
    sim.dwellObsDistM = obs;
    if (isTerminalStop(geo, pin)) {
      sim.phase = 'terminal';
      return;
    }
    sim.phase = 'dwell';
    sim.dwellStopIdx = sim.nextStopIdx - 1;
    const departMs = pin.departureMs + snap.delaySeconds * 1000;
    sim.dwellUntilMs = departMs > nowMs ? departMs : nowMs + dwellDurationMs(pin, nowMs);
    return;
  }

  // Stuck-hold: the repeated fix IS where the tram stands.
  if (sim.stuckAtM !== null) {
    sim.stuckAtM = obs;
    sim.sM = clampS(geo, obs);
    sim.vMs = 0;
    return;
  }

  // Closed-form segmented advance over the true age of the fix.
  const trueAgeS = Math.max(0, (nowMs - sim.obsAtMs) / 1000) + FEED_LATENCY_S;
  const startWallMs = nowMs - trueAgeS * 1000;
  let s = clampS(geo, obs);
  let tLeftS = trueAgeS;
  let dLeftM = maxAdvanceM(trueAgeS);
  let idx = sim.nextStopIdx;

  // v1-preserved seed rule: a fix resting within reach of a stop whose
  // scheduled departure already passed (and that is NOT a standing fix) is
  // treated as served — the tram is about to leave / just leaving.
  if (idx < stops.length) {
    const first = stops[idx];
    if (
      first.distM - s <= STOP_REACH_M &&
      first.departureMs + snap.delaySeconds * 1000 <= nowMs &&
      !isTerminalStop(geo, first)
    ) {
      idx++;
    }
  }

  for (;;) {
    const next = idx < stops.length ? stops[idx] : null;
    const legEnd = next ? Math.min(next.distM, geo.totalM) : geo.totalM;
    const legLen = Math.max(0, legEnd - s);
    const wallMs = startWallMs + (trueAgeS - tLeftS) * 1000;
    const pace = legPaceMs(sim, s, legEnd, wallMs);
    const reachable = Math.min(legLen, dLeftM, pace * tLeftS);
    if (reachable < legLen - 1e-9) {
      // Budget (time or physics cap) ends mid-leg: cruising there.
      s += reachable;
      sim.sM = clampS(geo, s);
      sim.nextStopIdx = idx;
      sim.phase = 'cruise';
      seedCruiseSpeed(sim, nowMs);
      return;
    }
    // Reached the stop / geometry end.
    s = legEnd;
    tLeftS -= pace > 0 ? legLen / pace : 0;
    dLeftM -= legLen;
    if (!next) {
      sim.sM = clampS(geo, s);
      sim.nextStopIdx = idx;
      sim.phase = 'terminal';
      sim.vMs = 0;
      return;
    }
    idx++;
    if (isTerminalStop(geo, next)) {
      sim.sM = clampS(geo, s);
      sim.nextStopIdx = idx;
      sim.phase = 'terminal';
      sim.vMs = 0;
      return;
    }
    const wallAtStopMs = startWallMs + (trueAgeS - tLeftS) * 1000;
    const dwellS = dwellDurationMs(next, wallAtStopMs) / 1000;
    if (dwellS >= tLeftS) {
      // The blind window ends inside this dwell: standing at the platform.
      sim.sM = clampS(geo, s);
      sim.nextStopIdx = idx;
      sim.phase = 'dwell';
      sim.dwellStopIdx = idx - 1;
      sim.vMs = 0;
      sim.dwellObsDistM = obs;
      const remainMs = (dwellS - tLeftS) * 1000;
      const departMs = next.departureMs + snap.delaySeconds * 1000;
      // Scheduled departure still ahead → honour it (timing point); else the
      // remaining share of the default/scheduled dwell.
      sim.dwellUntilMs = departMs > nowMs ? departMs : nowMs + remainMs;
      return;
    }
    tLeftS -= dwellS;
  }
}

/** Seed the speed of a cruising predictor: its own pace, envelope-bounded
 *  (field feedback #2 — a tram observed mid-segment is already moving). */
function seedCruiseSpeed(sim: TramSim, nowMs: number): void {
  if (sim.phase !== 'cruise' || sim.stuckAtM !== null) return;
  sim.vMs = Math.min(
    vAllowedAt(
      sim.profile,
      sim.geometry,
      sim.sM,
      minStopDistOf(sim),
      DEFAULT_LOOKAHEAD_M,
      A_BRK,
      sim.nextStopIdx,
    ),
    cruiseProduct(sim, nowMs),
  );
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export interface CreateSimOptions {
  /**
   * Seed paceBias from a previously learned value (TramEngine's per-key
   * memory: same vehicle, new trip/sim — the driver didn't change). Clamped
   * to [PACE_BIAS_MIN_RATIO, PACE_BIAS_MAX_RATIO]. Defaults to
   * PACE_BIAS_PRIOR for genuinely new vehicles.
   */
  initialPaceBias?: number;
}

/** Result of applying one snapshot — the engine reads these to sync layer 2. */
export interface ApplySnapshotResult {
  /** A genuinely-new fix arrived (the predictor reseeded). */
  freshFix: boolean;
  /** The reseed jump exceeded the gap-aware threshold (fade; no pace sample). */
  teleported: boolean;
  /** The sanctioned terminal un-latch backward re-anchor fired (§2.3:
   *  propagates to the smoother as a fade-teleport). */
  terminalUnlatched: boolean;
}

/** Create a predictor from a live snapshot (reseed at the fix + closed-form
 *  advance over its true age). */
export function createSim(
  geometry: RouteGeometry,
  profile: SpeedProfile,
  snapshot: TramSnapshot,
  nowMs: number,
  lengthM: number = DEFAULT_TRAM_LENGTH_M,
  opts: CreateSimOptions = {},
): TramSim {
  const sim: TramSim = {
    key: snapshot.key,
    geometry,
    profile,
    snapshot,
    sM: clampS(geometry, snapshot.shapeDistM),
    vMs: 0,
    phase: 'cruise',
    dwellUntilMs: 0,
    dwellStopIdx: null,
    nextStopIdx: 0,
    obsDistM: clampS(geometry, snapshot.shapeDistM),
    obsAtMs: snapshot.observedAtMs,
    lastFixGapS: 0,
    lengthM,
    lastTeleportMs: 0,
    paceBias: Math.min(
      PACE_BIAS_MAX_RATIO,
      Math.max(PACE_BIAS_MIN_RATIO, opts.initialPaceBias ?? PACE_BIAS_PRIOR),
    ),
    yieldHoldM: null,
    stuckAtM: null,
    fixStopDistM: null,
    dwellObsDistM: clampS(geometry, snapshot.shapeDistM),
    holdAccumMs: 0,
  };
  reseedFromFix(sim, null, nowMs);
  return sim;
}

/**
 * Ingest a snapshot for the same trip. A repeated poll (same observedAtMs AND
 * shapeDistM) changes nothing — the predictor keeps integrating smoothly. A
 * genuinely-new fix RESEEDS the predictor at the fix (closed-form advance) —
 * the accepted live-mode jump — after feeding the per-tram pace calibration
 * (except across a teleport-classified jump, which is a re-anchor artifact,
 * not motion; paceBias itself always survives — same vehicle, same driver).
 *
 * Terminal un-latch (R2): 'terminal' is otherwise absorbing, so a fresh fix
 * placing the real tram > TERMINAL_UNLATCH_BEHIND_M behind the latched
 * position re-anchors backward (sanctioned, fade-stamped, propagated to the
 * smoother by the engine); closer fixes are end-of-trip scatter and keep the
 * latch.
 */
export function applySnapshot(
  sim: TramSim,
  snapshot: TramSnapshot,
  nowMs: number,
): ApplySnapshotResult {
  const prevObsDistM = sim.obsDistM;
  const prevObsAtMs = sim.obsAtMs;
  sim.snapshot = snapshot;
  const newObs = clampS(sim.geometry, snapshot.shapeDistM);
  const freshFix = snapshot.observedAtMs > prevObsAtMs || newObs !== prevObsDistM;
  if (!freshFix) return { freshFix: false, teleported: false, terminalUnlatched: false };

  // Stuck detection needs the PREVIOUS fix; run before committing the new one.
  updateStuckHold(sim, prevObsDistM, prevObsAtMs, snapshot, newObs);
  const fixGapS = prevObsAtMs > 0 ? Math.max(0, (snapshot.observedAtMs - prevObsAtMs) / 1000) : 0;
  sim.obsDistM = newObs;
  sim.obsAtMs = snapshot.observedAtMs;
  sim.lastFixGapS = fixGapS;

  const jumpM = Math.abs(newObs - sim.sM);
  const teleported = jumpM > teleportThresholdM(fixGapS);

  // Terminal latch: absorbing except for the un-latch and true desync.
  if (sim.phase === 'terminal' && !teleported) {
    const behindM = sim.sM - newObs;
    if (behindM <= TERMINAL_UNLATCH_BEHIND_M) {
      // End-of-trip fix scatter — keep the latch; the sample still counts.
      updatePaceBias(sim, prevObsDistM, prevObsAtMs, snapshot);
      sim.holdAccumMs = 0;
      return { freshFix: true, teleported: false, terminalUnlatched: false };
    }
    updatePaceBias(sim, prevObsDistM, prevObsAtMs, snapshot);
    sim.holdAccumMs = 0;
    reseedFromFix(sim, prevObsDistM, nowMs);
    sim.lastTeleportMs = nowMs; // sanctioned backward re-anchor renders as a fade
    return { freshFix: true, teleported: false, terminalUnlatched: true };
  }

  if (!teleported) updatePaceBias(sim, prevObsDistM, prevObsAtMs, snapshot);
  sim.holdAccumMs = 0;
  reseedFromFix(sim, prevObsDistM, nowMs);
  if (teleported) sim.lastTeleportMs = nowMs;
  return { freshFix: true, teleported, terminalUnlatched: false };
}

/**
 * Forward-only closed-form re-anchor for resyncAfterSuspension (engine-v2.md
 * §2.2 last bullet): recompute the reseed estimate from the LAST fix at the
 * current wall clock and apply it only when it lies ahead of the current
 * position. Stuck-holds are respected (a jam is movement-released only);
 * a fresh at-stop pin re-derives the platform stand; a stale one advances.
 */
export function resyncPredictor(sim: TramSim, nowMs: number): void {
  if (sim.stuckAtM !== null) return; // explicit stand — no invented movement
  if (fixPinActive(sim, nowMs)) {
    // Fresh platform pin: the tram is still standing there. Nothing to seek.
    return;
  }
  const before = sim.sM;
  const beforeV = sim.vMs;
  const beforePhase = sim.phase;
  const beforeDwellUntil = sim.dwellUntilMs;
  const beforeDwellIdx = sim.dwellStopIdx;
  const beforeNextIdx = sim.nextStopIdx;
  const beforePin = sim.fixStopDistM;
  const beforeDwellObs = sim.dwellObsDistM;
  // allowPin=false: the fix may be stale here — a stale at_stop state must
  // advance past the platform (its dwell is spent inside the walk), not re-pin.
  reseedFromFix(sim, null, nowMs, false);
  if (sim.sM < before) {
    // Backward estimate (stale data) — monotonicity wins on a resync.
    sim.sM = before;
    sim.vMs = beforeV;
    sim.phase = beforePhase;
    sim.dwellUntilMs = beforeDwellUntil;
    sim.dwellStopIdx = beforeDwellIdx;
    sim.nextStopIdx = beforeNextIdx;
    sim.fixStopDistM = beforePin;
    sim.dwellObsDistM = beforeDwellObs;
  }
}

/**
 * Stuck detection (field feedback #3): two-plus genuinely new fixes at the
 * same mid-segment point mean the tram is physically stuck — the reseed then
 * lands AT the fix and holds (v1's separate rewind-to-fix path is subsumed by
 * the reseed itself). A fresh fix that moved > STUCK_FIX_EPS_M clears the
 * hold. Standing at/near a stop is a dwell, not a jam. at_stop states and
 * repeated polls of one fix are never stuck evidence.
 */
function updateStuckHold(
  sim: TramSim,
  prevObsDistM: number,
  prevObsAtMs: number,
  snapshot: TramSnapshot,
  newObsM: number,
): void {
  if (Math.abs(newObsM - prevObsDistM) > STUCK_FIX_EPS_M) {
    sim.stuckAtM = null; // moving fix — release
    return;
  }
  // Same position: only a TIME-advanced repeat is evidence of standing still.
  if (snapshot.observedAtMs <= prevObsAtMs || prevObsAtMs <= 0) return;
  if (snapshot.statePosition === 'at_stop') return;
  for (const stop of sim.geometry.stops) {
    if (stop.distM > newObsM + STUCK_NEAR_STOP_M) break;
    if (Math.abs(stop.distM - newObsM) <= STUCK_NEAR_STOP_M) return;
  }
  sim.stuckAtM = newObsM;
}

/**
 * Per-tram adaptive calibration with R13 clip-not-drop (engine-v2.md §2.2):
 * on a genuinely NEW fix, compare the real average MOTION speed over the
 * inter-fix span against the profile-expected cruise speed and fold the
 * clamped ratio into the EWMA. The STANDING portion of the span is deducted:
 * scheduled/default dwells of stops strictly inside it (as v1) PLUS the
 * observed pin/stuck-active time (holdAccumMs), bounded so the deduction
 * never eats more than 3/4 of the interval. The span is dropped only when no
 * confident moving remainder survives (Δt < 8 s or Δs < 15 m).
 */
function updatePaceBias(
  sim: TramSim,
  prevObsDistM: number,
  prevObsAtMs: number,
  snapshot: TramSnapshot,
): void {
  if (prevObsAtMs <= 0 || snapshot.observedAtMs <= prevObsAtMs) return;
  const dtObsS = (snapshot.observedAtMs - prevObsAtMs) / 1000;
  const obsDistM = clampS(sim.geometry, snapshot.shapeDistM);
  const dsObsM = obsDistM - prevObsDistM;
  if (dtObsS < PACE_BIAS_MIN_DT_S || dsObsM < PACE_BIAS_MIN_DS_M) return;

  // Standing time inside the span: scheduled dwells of stops strictly inside
  // (estimated, as v1) + observed pin/stuck-active time (R13). Bounded: the
  // deduction may never eat more than 3/4 of the interval — both parts are
  // estimates, not measurements.
  let standS = 0;
  for (const stop of sim.geometry.stops) {
    if (stop.distM > obsDistM - 1) break;
    if (stop.distM > prevObsDistM + 1) {
      standS += dwellDurationMs(stop, snapshot.observedAtMs) / 1000;
    }
  }
  standS += Math.min(sim.holdAccumMs / 1000, dtObsS);
  const effDtS = Math.max(dtObsS - standS, dtObsS * 0.25);

  // Expected speed against the CRUISE REFERENCE times the TOD pace factor —
  // the exact product tick() multiplies paceBias into, so the bias learns
  // only the per-vehicle RESIDUAL (TOD never applies twice).
  const expected =
    meanCruiseCapOver(sim.profile, sim.geometry, prevObsDistM, obsDistM, V_CRUISE_REF_MS) *
    todPaceFactor((prevObsAtMs + snapshot.observedAtMs) / 2);
  if (expected < 0.1) return;
  const ratio = Math.min(
    PACE_BIAS_MAX_RATIO,
    Math.max(PACE_BIAS_MIN_RATIO, dsObsM / effDtS / expected),
  );
  const alpha = 1 - Math.pow(0.5, dtObsS / PACE_BIAS_HALF_LIFE_S);
  sim.paceBias += alpha * (ratio - sim.paceBias);
}

// ── physics tick ─────────────────────────────────────────────────────────────

/**
 * Advance the predictor by dtS seconds: cruise at the learned pace under the
 * braking envelope, stop at un-served stops for fixed dwells, hold where the
 * observation pins it (dwell fix-hold, stuck-hold), latch at terminals. No
 * target chasing of any kind — the predictor IS the estimate of reality.
 */
export function tick(sim: TramSim, nowMs: number, dtS: number): void {
  const dt = Math.min(Math.max(dtS, 0), MAX_TICK_DT_S);

  // R13 bookkeeping: time spent in an observation-pinned stand.
  if (dt > 0 && (sim.stuckAtM !== null || fixPinActive(sim, nowMs))) {
    sim.holdAccumMs += dt * 1000;
  }

  if (sim.phase === 'terminal') {
    sim.vMs = 0;
    return;
  }
  if (sim.phase === 'dwell') {
    sim.vMs = 0;
    if (nowMs >= sim.dwellUntilMs && !fixPinsDwell(sim, nowMs)) {
      sim.phase = 'cruise';
      sim.dwellStopIdx = null;
    }
    return;
  }
  if (dt <= 0) return;

  const vAllowed = vAllowedAt(
    sim.profile,
    sim.geometry,
    sim.sM,
    minStopDistOf(sim),
    DEFAULT_LOOKAHEAD_M,
    A_BRK,
    sim.nextStopIdx,
  );
  let vTarget = Math.min(vAllowed, cruiseProduct(sim, nowMs));

  // Stuck-hold: brake to a stand AT the pinned fix and hold (movement-released).
  if (sim.stuckAtM !== null) {
    vTarget = Math.min(vTarget, brakeTowards(sim.stuckAtM - sim.sM));
  }
  // Junction yield (engine-written): brake toward the hold point. Speed-only.
  if (sim.yieldHoldM !== null) {
    vTarget = Math.min(vTarget, brakeTowards(sim.yieldHoldM - sim.sM));
  }

  const a = Math.min(A_ACC, Math.max(-A_BRK, (vTarget - sim.vMs) / dt));
  sim.vMs = Math.max(0, sim.vMs + a * dt);

  const sNew = sim.sM + sim.vMs * dt;
  const next = sim.nextStopIdx < sim.geometry.stops.length
    ? sim.geometry.stops[sim.nextStopIdx]
    : null;

  if (next && sNew >= next.distM - STOP_REACH_M) {
    // Reached the stop (never slide past an un-served stop).
    sim.sM = Math.max(sim.sM, Math.min(sNew, next.distM));
    sim.vMs = 0;
    const idx = sim.nextStopIdx;
    sim.nextStopIdx = idx + 1;
    if (isTerminalStop(sim.geometry, next)) {
      sim.phase = 'terminal';
    } else {
      sim.phase = 'dwell';
      sim.dwellStopIdx = idx;
      sim.dwellObsDistM = sim.obsDistM;
      sim.dwellUntilMs = nowMs + dwellDurationMs(next, nowMs);
    }
    return;
  }

  sim.sM = Math.min(sNew, sim.geometry.totalM);
  if (sim.sM >= sim.geometry.totalM - 1e-6 && !next) {
    // Ran off the end with no stops left — hold as terminal.
    sim.phase = 'terminal';
    sim.vMs = 0;
  }
}
