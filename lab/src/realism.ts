// The realism gate, live side (protocol §Kinematic limits — a CONTRACT
// property). Every track the lab publishes is measured exactly the way a
// lerping client experiences it, and any violation of the kinematic limits is
// counted forever and surfaced in /api/summary → `realism`.
//
// This exists because "the builder guarantees it" is not a measurement. The
// same reading is asserted offline by lab/scripts/selftest-v2.ts and live by
// lab/scripts/check-v2.mjs against the served bytes; the counters here are the
// continuous version, so a regression shows up in a digest instead of waiting
// for someone to run a script.

import {
  TRAJ_A_ACC_GATE,
  TRAJ_A_BRK_GATE,
  TRAJ_CONV_TOL_M,
  TRAJ_FLIP_DEADBAND,
  TRAJ_J_GATE,
  TRAJ_REANCHOR_TOL_M,
  TRAJ_V_MAX_GATE_MS,
} from './config';
import type { CurveViolationDetail, DipDetail, RegimeStats } from './drive';
import { evalTrack, seamJustifiedM, type TrackPoint } from './trajectory';

export interface RealismReading {
  /** Per-segment mean speeds, m/s — what the client actually moves the marker at. */
  speeds: number[];
  /** Central-difference accelerations between consecutive segments, m/s². */
  accels: number[];
  maxSpeed: number;
  maxAccel: number;
  minAccel: number;
}

/** Measure a published track the way a lerping client experiences it.
 *
 *  A client only ever sees straight lines between knots, so the only physical
 *  quantities that exist for it are the per-segment mean speed and the change
 *  of that speed from one segment to the next. Acceleration is therefore the
 *  CENTRAL difference: segment i's mean speed is the instantaneous speed at
 *  its midpoint, so consecutive segment speeds are (Δt_i + Δt_{i+1})/2 apart. */
export function readRealism(track: TrackPoint[]): RealismReading {
  const speeds: number[] = [];
  const dts: number[] = [];
  for (let i = 1; i < track.length; i++) {
    const dtS = (track[i].t - track[i - 1].t) / 1000;
    dts.push(dtS);
    speeds.push(dtS > 0 ? (track[i].s - track[i - 1].s) / dtS : 0);
  }
  const accels: number[] = [];
  for (let i = 1; i < speeds.length; i++) {
    const span = (dts[i - 1] + dts[i]) / 2;
    accels.push(span > 0 ? (speeds[i] - speeds[i - 1]) / span : 0);
  }
  return {
    speeds,
    accels,
    maxSpeed: speeds.length > 0 ? Math.max(...speeds) : 0,
    maxAccel: accels.length > 0 ? Math.max(...accels) : 0,
    minAccel: accels.length > 0 ? Math.min(...accels) : 0,
  };
}

/** Fixed-width histogram — bounded memory for an unbounded 24/7 run, which a
 *  sample buffer would not give. Bin width is well below the quantities we
 *  quote, so the percentiles are exact to the bin. */
class Histogram {
  private bins: Int32Array;
  private under = 0;
  private over = 0;
  private count = 0;

  constructor(
    private lo: number,
    private hi: number,
    private width: number,
  ) {
    this.bins = new Int32Array(Math.ceil((hi - lo) / width));
  }

  add(x: number): void {
    this.count++;
    const i = Math.floor((x - this.lo) / this.width);
    if (i < 0) this.under++;
    else if (i >= this.bins.length) this.over++;
    else this.bins[i]++;
  }

  /** Value at percentile p (0–100), bin-centre resolution. */
  pct(p: number): number | null {
    if (this.count === 0) return null;
    const want = (p / 100) * this.count;
    let seen = this.under;
    if (seen >= want) return this.lo;
    for (let i = 0; i < this.bins.length; i++) {
      seen += this.bins[i];
      if (seen >= want) return round3(this.lo + (i + 0.5) * this.width);
    }
    return this.hi;
  }

  get n(): number {
    return this.count;
  }
}

export interface RealismViolation {
  key: string;
  track: 'opinion' | 'smooth';
  kind: 'speed' | 'accel';
  value: number;
  limit: number;
  atMs: number;
}

/** One G10 offender: an emitted opinion curve starting BEHIND the anchor fix. */
export interface BehindFixViolation {
  key: string;
  /** anchor fix position − opinion(emittedAtMs), m (> 0 = behind the fix). */
  behindM: number;
  atMs: number;
}

/** Lifetime counters over everything the lab has published. */
export class RealismCounters {
  tracksChecked = 0;
  segmentsChecked = 0;
  violations = 0;
  speedViolations = 0;
  accelViolations = 0;
  maxSpeed = 0;
  maxAccel = 0;
  minAccel = 0;
  /** G10 anchor-floor gate (owner field report 2026-08-17: the fixed track
   *  teleported BEHIND the latest fix — the fix is a hard floor, the tram was
   *  there and does not reverse). Target: literal 0. */
  behindFixViolations = 0;
  behindFixChecked = 0;
  maxBehindFixM = 0;
  worstBehindFix: BehindFixViolation[] = [];
  /** Worst offenders ever seen, by absolute excess over the limit. */
  worst: RealismViolation[] = [];

  private speedHist = new Histogram(0, 20, 0.1);
  private accelHist = new Histogram(-3, 3, 0.02);

  check(key: string, track: 'opinion' | 'smooth', points: TrackPoint[], atMs: number): void {
    const r = readRealism(points);
    this.tracksChecked++;
    this.segmentsChecked += r.speeds.length;
    for (const v of r.speeds) {
      this.speedHist.add(v);
      if (v > TRAJ_V_MAX_GATE_MS) {
        this.speedViolations++;
        this.violations++;
        this.note({ key, track, kind: 'speed', value: v, limit: TRAJ_V_MAX_GATE_MS, atMs });
      }
    }
    for (const a of r.accels) {
      this.accelHist.add(a);
      if (a > TRAJ_A_ACC_GATE) {
        this.accelViolations++;
        this.violations++;
        this.note({ key, track, kind: 'accel', value: a, limit: TRAJ_A_ACC_GATE, atMs });
      } else if (a < -TRAJ_A_BRK_GATE) {
        this.accelViolations++;
        this.violations++;
        this.note({ key, track, kind: 'accel', value: a, limit: -TRAJ_A_BRK_GATE, atMs });
      }
    }
    if (r.maxSpeed > this.maxSpeed) this.maxSpeed = r.maxSpeed;
    if (r.maxAccel > this.maxAccel) this.maxAccel = r.maxAccel;
    if (r.minAccel < this.minAccel) this.minAccel = r.minAccel;
  }

  /** G10: the emitted OPINION curve must satisfy s(t) ≥ s_anchorFix for all
   *  t ≥ anchor time. The curve is monotone non-decreasing, so checking its
   *  first knot checks every instant. 0.05 m slack absorbs cm wire rounding. */
  checkAnchorFloor(key: string, opinion: TrackPoint[], anchorFixS: number, atMs: number): void {
    if (opinion.length === 0) return;
    this.behindFixChecked++;
    const behindM = anchorFixS - opinion[0].s;
    if (behindM > 0.05) {
      this.behindFixViolations++;
      if (behindM > this.maxBehindFixM) this.maxBehindFixM = behindM;
      this.worstBehindFix.push({ key, behindM: round3(behindM), atMs });
      this.worstBehindFix.sort((a, b) => b.behindM - a.behindM);
      if (this.worstBehindFix.length > 5) this.worstBehindFix.length = 5;
    }
  }

  private note(v: RealismViolation): void {
    this.worst.push(v);
    this.worst.sort((a, b) => Math.abs(b.value - b.limit) - Math.abs(a.value - a.limit));
    if (this.worst.length > 5) this.worst.length = 5;
  }

  gauges(): unknown {
    return {
      tracksChecked: this.tracksChecked,
      segmentsChecked: this.segmentsChecked,
      violations: this.violations,
      speedViolations: this.speedViolations,
      accelViolations: this.accelViolations,
      limits: {
        vMaxMs: TRAJ_V_MAX_GATE_MS,
        aAccMs2: TRAJ_A_ACC_GATE,
        aBrkMs2: -TRAJ_A_BRK_GATE,
      },
      g10behindFix: {
        checked: this.behindFixChecked,
        violations: this.behindFixViolations,
        maxBehindM: round3(this.maxBehindFixM),
        worst: this.worstBehindFix,
      },
      observed: {
        maxSpeedMs: round3(this.maxSpeed),
        maxAccelMs2: round3(this.maxAccel),
        minAccelMs2: round3(this.minAccel),
        speedP50: this.speedHist.pct(50),
        speedP90: this.speedHist.pct(90),
        speedP99: this.speedHist.pct(99),
        accelP01: this.accelHist.pct(1),
        accelP50: this.accelHist.pct(50),
        accelP99: this.accelHist.pct(99),
      },
      worst: this.worst,
    };
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ── re-anchor seam telemetry (owner field report 2026-08-18) ─────────────────
// Symptom on build 15: a fresh fix arrives, the tram follows it, then ~5–10 s
// later the «fixed» marker FLIES BACKWARD past the fix and stands. The G10
// anchor floor (per-track, intra-emission) cannot see this class: it is a
// CROSS-EMISSION regression — the NEW opinion curve, at the instant the phone
// swaps bundles (up to ~9 s after emission: 5 s client poll + 2 s server
// cache + fetch), renders BEHIND where the PREVIOUS opinion curve was already
// rendering. Candidate mechanisms, each measured here before any fix ships:
//   M1 swap regression — fix-driven re-anchor lands at nowcast ≈ fix + ds
//     (latency), which is behind the old curve's projection;
//   M2 behind-the-newest-fix — by swap time the phone holds a NEWER raw fix
//     (RemoteFeed, ~2 s) than the bundle's anchor, so the rendered marker sits
//     behind the dot the user sees (measured at fix arrival, server-side);
//   M3 modal mis-fire — the new emission STANDS (modal/jam hold) while the
//     fix evidence says the tram is rolling, so late swaps read as "jumped
//     back and тупо стоит".
// G13 «swapRegression» (armed with the §14.7 seam rule): a fix re-emission
// stepping BACKWARD at the server-controllable swap instants (t_E, t_E + 2 s)
// while the newest fix cannot exclude the previous projection
// (prevOpinion(t_E) ≤ seamJustifiedM = fix + fixAge·vObs + TOL). Standing
// evidence (modal/jam start) is exempt — its floor is the anchor itself
// (G10). Target 0.

/** The §14.7 evidence slack, m (config: TRAJ_REANCHOR_TOL_M). */
export const SEAM_REANCHOR_TOL_M = TRAJ_REANCHOR_TOL_M;
/** Wire slack for G13 at the seam instant (cm rounding + eval interpolation). */
export const SEAM_SLACK_M = 2;
/** Extra slack at t_E + 2 s: from a continuity-correct seam the new curve may
 *  legitimately BRAKE (envelope / curve cap / hold ahead) while the old one
 *  was still accelerating — the physical worst-case divergence over 2 s is
 *  ½·(A_ACC + A_BRK)·2² = 5.4 m (measured live 2026-08-18 00:40Z as a ≤ 10 m
 *  +2 s-only residual). 6.5 = that bound + wire rounding; anything above it
 *  is a genuine backward step, not physics. */
export const SEAM_SLACK_LATE_M = 6.5;
/** Client swap-lag instants the seam is evaluated at, s after emission. */
export const SEAM_EVAL_DT_S = [0, 2, 5, 9] as const;

export interface SeamEvent {
  key: string;
  emittedAtMs: number;
  /** The NEW emission's anchor fix, m along shape. */
  latestFixS: number;
  /** The previous emission's anchor fix (null: unknown — pre-restart entry). */
  prevFixS: number | null;
  /** latestFixS − prevFixS: how far the fix itself advanced. */
  movedM: number | null;
  /** prevOpinion(t_E) − latestFixS: how far ahead of the newest fix the old
   *  curve was projecting at the seam. */
  prevAheadM: number;
  /** §14.7 justified overhang (seamJustifiedM − latestFixS): prevAheadM at or
   *  under this ⇒ continuity was owed (M1 class); above ⇒ honest overshoot
   *  correction. */
  justifiedAheadM: number;
  /** prevOpinion(t) − newOpinion(t) at t_E + SEAM_EVAL_DT_S (backward step a
   *  client swapping at that lag renders; > 0 = the marker jumps back). */
  backM: number[];
  /** The new emission begins STANDING (modal hold / jam hold). */
  standingStart: boolean;
  discontinuity: boolean;
}

/** Per-chain (published / shadow) counters over fix-driven re-emissions. */
export class SeamCounters {
  /** Fix-driven, non-discontinuity re-emissions with a same-trip prev curve. */
  n = 0;
  /** Seam regressions by size, at swap lag 0 (the seam itself). */
  back0Over2 = 0;
  back0Over10 = 0;
  back0Over25 = 0;
  back0Over50 = 0;
  back0Over100 = 0;
  /** …and at the worst client swap lag in the window (max over dt). */
  backMaxOver10 = 0;
  backMaxOver25 = 0;
  backMaxOver50 = 0;
  backMaxOver100 = 0;
  /** M3 signature: the regressing emission starts standing. */
  standingBackOver10 = 0;
  /** …while the fix itself had MOVED (> 8 m — rolling evidence). */
  movingFixStandingBackOver10 = 0;
  /** G13 swapRegression (provisional until the seam rule ships): backward step
   *  beyond what the newest fix justifies, at t_E or t_E + 2 s. Target 0. */
  g13Violations = 0;
  /** Honest-correction population: regression at the seam, but the old curve
   *  had overshot beyond the §14.7 justified bound (fix + fixAge·vObs + TOL)
   *  — correcting down IS the evidence speaking. */
  overshootCorrections = 0;
  private back0Hist = new Histogram(-50, 300, 1);
  private backMaxHist = new Histogram(-50, 300, 1);
  private prevAheadHist = new Histogram(-100, 500, 2);
  /** What the §14.7 rule would do at other TOLs (choose REANCHOR_TOL_M from
   *  data, not taste): per TOL — regressions > 2 m the floor would kill
   *  (prevAhead ≤ TOL) vs keep as honest corrections (prevAhead > TOL). */
  tolTable = [15, 25, 40, 60, 80, 120].map((tol) => ({ tol, killed: 0, kept: 0 }));
  worst: SeamEvent[] = [];
  recent: SeamEvent[] = [];

  record(e: {
    key: string;
    emittedAtMs: number;
    prevOpinion: TrackPoint[];
    newOpinion: TrackPoint[];
    latestFixS: number;
    prevFixS: number | null;
    /** observedAtMs of the NEW anchor fix (for the fix-age term of §14.7). */
    anchorMs: number;
    /** Observed gap between the last two fixes, s (vObs denominator). */
    fixGapS: number;
    standingStart: boolean;
    discontinuity: boolean;
  }): void {
    if (e.prevOpinion.length === 0 || e.newOpinion.length === 0) return;
    const t0 = e.emittedAtMs;
    const backM = SEAM_EVAL_DT_S.map((dt) =>
      round3(evalTrack(e.prevOpinion, t0 + dt * 1000) - evalTrack(e.newOpinion, t0 + dt * 1000)),
    );
    const prevAheadM = round3(evalTrack(e.prevOpinion, t0) - e.latestFixS);
    const justified = seamJustifiedM({
      anchorFixS: e.latestFixS,
      anchorMs: e.anchorMs,
      emittedAtMs: t0,
      prevFixS: e.prevFixS ?? e.latestFixS,
      fixGapS: e.fixGapS,
    });
    const ev: SeamEvent = {
      key: e.key,
      emittedAtMs: t0,
      latestFixS: round3(e.latestFixS),
      prevFixS: e.prevFixS === null ? null : round3(e.prevFixS),
      movedM: e.prevFixS === null ? null : round3(e.latestFixS - e.prevFixS),
      prevAheadM,
      justifiedAheadM: round3(justified - e.latestFixS),
      backM,
      standingStart: e.standingStart,
      discontinuity: e.discontinuity,
    };
    if (e.discontinuity) return this.push(ev); // honest teleport: ring only
    this.n++;
    const back0 = backM[0];
    const backMax = Math.max(...backM);
    this.back0Hist.add(back0);
    this.backMaxHist.add(backMax);
    this.prevAheadHist.add(prevAheadM);
    if (back0 > 2) this.back0Over2++;
    if (back0 > 10) this.back0Over10++;
    if (back0 > 25) this.back0Over25++;
    if (back0 > 50) this.back0Over50++;
    if (back0 > 100) this.back0Over100++;
    if (backMax > 10) this.backMaxOver10++;
    if (backMax > 25) this.backMaxOver25++;
    if (backMax > 50) this.backMaxOver50++;
    if (backMax > 100) this.backMaxOver100++;
    if (backMax > 10 && e.standingStart) {
      this.standingBackOver10++;
      if (ev.movedM !== null && ev.movedM > 8) this.movingFixStandingBackOver10++;
    }
    if (back0 > 2) {
      for (const row of this.tolTable) {
        if (prevAheadM <= row.tol) row.killed++;
        else row.kept++;
      }
      if (evalTrack(e.prevOpinion, t0) > justified) this.overshootCorrections++;
    }
    // G13 «swapRegression» (§14.7 exact): a backward step at the server-
    // controllable swap instants (t_E, t_E + 2 s of bundle cache) while the
    // newest fix cannot exclude the previous projection (prevO ≤ justified).
    // Standing evidence (modal/jam start) is exempt: its floor is the anchor
    // itself, which G10 already gates.
    if (!e.standingStart) {
      if (evalTrack(e.prevOpinion, t0) <= justified) {
        for (const dt of [0, 2]) {
          const t = t0 + dt * 1000;
          const slack = dt === 0 ? SEAM_SLACK_M : SEAM_SLACK_LATE_M;
          if (evalTrack(e.newOpinion, t) < evalTrack(e.prevOpinion, t) - slack) {
            this.g13Violations++;
            break;
          }
        }
      }
    }
    if (backMax > 10) this.push(ev);
  }

  private push(ev: SeamEvent): void {
    this.recent.unshift(ev);
    if (this.recent.length > 24) this.recent.length = 24;
    if (ev.discontinuity) return;
    this.worst.push(ev);
    this.worst.sort((a, b) => Math.max(...b.backM) - Math.max(...a.backM));
    if (this.worst.length > 12) this.worst.length = 12;
  }

  gauges(): unknown {
    return {
      tolM: SEAM_REANCHOR_TOL_M,
      n: this.n,
      g13swapRegression: { violations: this.g13Violations, target: 0 },
      backAtSeam: {
        over2: this.back0Over2,
        over10: this.back0Over10,
        over25: this.back0Over25,
        over50: this.back0Over50,
        over100: this.back0Over100,
        p50: this.back0Hist.pct(50),
        p90: this.back0Hist.pct(90),
        p99: this.back0Hist.pct(99),
      },
      backAtWorstSwapLag: {
        over10: this.backMaxOver10,
        over25: this.backMaxOver25,
        over50: this.backMaxOver50,
        over100: this.backMaxOver100,
        p50: this.backMaxHist.pct(50),
        p90: this.backMaxHist.pct(90),
        p99: this.backMaxHist.pct(99),
      },
      prevAheadOfFix: {
        p50: this.prevAheadHist.pct(50),
        p90: this.prevAheadHist.pct(90),
        p99: this.prevAheadHist.pct(99),
      },
      m3standing: {
        backOver10: this.standingBackOver10,
        movingFix: this.movingFixStandingBackOver10,
      },
      overshootCorrections: this.overshootCorrections,
      tolTable: this.tolTable,
      worst: this.worst,
      recent: this.recent,
    };
  }
}

// ── M2: rendered-behind-the-newest-fix, measured at fix arrival ──────────────
// The instant a genuinely-new fix lands in the lab (≈ the instant the phone's
// RemoteFeed dot moves), evaluate the CURRENTLY SERVED opinion curve at that
// wall instant: `fixS − rendered` > 0 means every client already sees the dot
// AHEAD of the marker — and the phone keeps rendering that stale curve for up
// to another ~7–9 s of poll + cache lag on top of what is measured here.

export interface FreshnessEvent {
  key: string;
  atMs: number;
  behindM: number;
  fixS: number;
  /** The served curve was STANDING (< 0.3 m/s over the last 3 s) while the
   *  newest fix contradicts it from ahead — the M3 end-to-end signature. */
  standing: boolean;
}

export class FreshnessCounters {
  arrivals = 0;
  behindOver2 = 0;
  behindOver10 = 0;
  behindOver25 = 0;
  behindOver50 = 0;
  behindOver100 = 0;
  /** Standing curve contradicted from ahead by > 25 m (M3 end-to-end). */
  standingContradicted = 0;
  maxBehindM = 0;
  private behindHist = new Histogram(0, 400, 1);
  recent: FreshnessEvent[] = [];

  note(key: string, opinion: TrackPoint[], fixS: number, atMs: number): void {
    if (opinion.length === 0) return;
    this.arrivals++;
    const rendered = evalTrack(opinion, atMs);
    const behindM = fixS - rendered;
    this.behindHist.add(Math.max(0, behindM));
    if (behindM <= 2) return;
    const standing =
      Math.abs(rendered - evalTrack(opinion, atMs - 3000)) < 0.9; // < 0.3 m/s
    this.behindOver2++;
    if (behindM > 10) this.behindOver10++;
    if (behindM > 25) this.behindOver25++;
    if (behindM > 50) this.behindOver50++;
    if (behindM > 100) this.behindOver100++;
    if (standing && behindM > 25) this.standingContradicted++;
    if (behindM > this.maxBehindM) this.maxBehindM = behindM;
    if (behindM > 10) {
      this.recent.unshift({
        key,
        atMs,
        behindM: round3(behindM),
        fixS: round3(fixS),
        standing,
      });
      if (this.recent.length > 16) this.recent.length = 16;
    }
  }

  gauges(): unknown {
    return {
      arrivals: this.arrivals,
      behind: {
        over2: this.behindOver2,
        over10: this.behindOver10,
        over25: this.behindOver25,
        over50: this.behindOver50,
        over100: this.behindOver100,
        p50: this.behindHist.pct(50),
        p90: this.behindHist.pct(90),
        p99: this.behindHist.pct(99),
        maxM: round3(this.maxBehindM),
      },
      standingContradicted: this.standingContradicted,
      recent: this.recent,
    };
  }
}

// ── curvegen-v3 perceptual gate, generator side (design §8) ──────────────────
// The builder guaranteeing a property is not a measurement: everything below
// is ALSO computed independently from served bytes by lab/scripts/check-v2.mjs
// (wire math only) and offline by selftest-v2.ts. These counters are the
// continuous version, fed per shadow emission and surfaced in /api/summary →
// `perceptual` for Grafana and the digests.

/** Wire-observable JERK samples of a published track, m/s³ (G2): Δ of
 *  consecutive central-difference accelerations ÷ the time between their
 *  centres. An accel reading between segments j and j+1 is centred at the
 *  mean of the two segment midpoints; averages of a J-Lipschitz profile over
 *  adjacent windows keep this ≤ J_MAX by construction (design §5). */
export function readJerk(track: TrackPoint[]): number[] {
  const speeds: number[] = [];
  const mids: number[] = [];
  for (let i = 1; i < track.length; i++) {
    const dtS = (track[i].t - track[i - 1].t) / 1000;
    speeds.push(dtS > 0 ? (track[i].s - track[i - 1].s) / dtS : 0);
    mids.push((track[i].t + track[i - 1].t) / 2);
  }
  const accels: number[] = [];
  const centres: number[] = [];
  for (let i = 1; i < speeds.length; i++) {
    const spanS = (mids[i] - mids[i - 1]) / 1000;
    if (spanS <= 0) continue;
    accels.push((speeds[i] - speeds[i - 1]) / spanS);
    centres.push((mids[i] + mids[i - 1]) / 2);
  }
  const jerks: number[] = [];
  for (let i = 1; i < accels.length; i++) {
    const dtS = (centres[i] - centres[i - 1]) / 1000;
    if (dtS <= 0) continue;
    jerks.push((accels[i] - accels[i - 1]) / dtS);
  }
  return jerks;
}

/** Accel sign flips of a track (G3): transitions between accel phases
 *  > +deadband and < −deadband; intervening |a| ≤ deadband phases do not
 *  reset the armed sign. Returns flips + the track's wall-clock minutes. */
export function readFlips(track: TrackPoint[]): { flips: number; minutes: number } {
  const r = readRealism(track);
  let flips = 0;
  let sign = 0;
  for (const a of r.accels) {
    if (a > TRAJ_FLIP_DEADBAND) {
      if (sign < 0) flips++;
      sign = 1;
    } else if (a < -TRAJ_FLIP_DEADBAND) {
      if (sign > 0) flips++;
      sign = -1;
    }
  }
  const minutes = track.length >= 2 ? (track[track.length - 1].t - track[0].t) / 60_000 : 0;
  return { flips, minutes };
}

/** One emission's build facts, as the drive reports them (drive.ts meta). */
export interface PerceptualEmission {
  key: string;
  emittedAtMs: number;
  /** 'first' = no previous emission in this chain; 'fix' = anchor advanced;
   *  'age' = same anchor re-emitted on the 60 s age trigger. */
  kind: 'first' | 'fix' | 'age';
  discontinuity: boolean;
  discKind: 'none' | 'trip' | 'gap' | 'break';
  opinion: TrackPoint[];
  smooth: TrackPoint[];
  /** Previous emission's smooth track (same chain), for the G9 seam. */
  prevSmooth: TrackPoint[] | null;
  /** §14.2: request stops excluded from this emission's plan (telemetry). */
  requestSkips: { stopId: string; distM: number }[];
  /** §14.3: this emission holds at an evidence-backed jam position. */
  jamHolding: boolean;
  /** §14.4: the same-shape leader this emission was clipped against. */
  leaderKey: string | null;
  perTrack: {
    opinion: PerceptualTrackMeta;
    smooth: PerceptualTrackMeta;
  };
}

export interface PerceptualTrackMeta {
  knots: number;
  pressureDrops: number;
  budgetForced: boolean;
  curveViolations: number;
  curveDetail: CurveViolationDetail[];
  phantomDips: number;
  dipDetail: DipDetail[];
  infeasibleSkips: number;
  /** G11 (model-invented mid-segment stands) + evidence-backed stand telemetry. */
  midSegmentStops: number;
  midSegmentDetail: { sM: number; durS: number }[];
  jamHolds: number;
  queueHolds: number;
  /** G12 leader-clearance penetrations of the emitted track. */
  collisionViolations: number;
  collisionMaxPenM: number;
  regime: RegimeStats | null;
}

/** One G4 offender, kept for drill-down (worst by excess over the gate). */
interface CurveOffender extends CurveViolationDetail {
  key: string;
  track: 'opinion' | 'smooth';
  emittedAtMs: number;
}

/** Lifetime perceptual counters over every SHADOW (later: published) emission. */
export class PerceptualCounters {
  emissions = 0;
  firstEmissions = 0;
  fixReemissions = 0;
  ageReemissions = 0;
  discFix = 0;
  discAge = 0;
  discByKind = { trip: 0, gap: 0, break: 0 };
  /** G4 / G7 / plan feasibility, straight sums of the generator's own counts. */
  curveViolations = 0;
  phantomDips = 0;
  infeasibleSkips = 0;
  /** G11 (target 0) + evidence-backed stand telemetry (§14.3/§14.4). */
  midSegmentStops = 0;
  jamHolds = 0;
  queueHolds = 0;
  /** G12 (target 0). */
  collisionViolations = 0;
  /** G7 drill-down: the most recent counted dips, with context. */
  g7Recent: (DipDetail & { key: string; track: 'opinion' | 'smooth'; emittedAtMs: number })[] = [];
  /** G11/G12 drill-downs: recent violations with context. */
  g11Recent: { key: string; track: 'opinion' | 'smooth'; emittedAtMs: number; sM: number; durS: number }[] = [];
  g12Recent: { key: string; leaderKey: string | null; track: 'opinion' | 'smooth'; emittedAtMs: number; maxPenM: number }[] = [];
  /** §14.2 request-stop skips (telemetry, not violations). */
  requestSkipsTotal = 0;
  /** Emissions holding at an observed jam / clipped behind a leader. */
  jamEmissions = 0;
  leaderClippedEmissions = 0;
  /** Recent examples for /physics spot-checks (most recent first, capped). */
  recentRequestSkips: { key: string; stopId: string; emittedAtMs: number }[] = [];
  recentJamHolds: { key: string; emittedAtMs: number }[] = [];
  recentLeaderClips: { key: string; leaderKey: string; emittedAtMs: number }[] = [];
  /** G4 drill-down: where the violating segments sit (seg ≤ 2 = right at the
   *  seam — inherited-state mechanism) + the worst offenders. */
  private g4Seg12 = 0;
  private g4Later = 0;
  private g4ByTrack = { opinion: 0, smooth: 0 };
  private g4Worst: CurveOffender[] = [];
  /** G5 drill-down: lifetime sums of the smooth run's limiter classification. */
  private regimeSum = {
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
  };
  /** §11 gauges. */
  knotPressureDrops = 0;
  budgetForcedEmissions = 0;
  /** G9, generator side (check-v2 asserts the same from bytes). */
  seamViolations = 0;
  maxSeamM = 0;
  /** G2 hard clause: samples over 1.0 m/s³ (must stay 0). */
  jerkOver1 = 0;
  jerkMax = 0;
  /** G5: fix-driven episodes that never converge within the horizon. */
  unconverged = 0;
  /** G6 worst episode. */
  maxOscillations = 0;

  private jerkHist = new Histogram(0, 2, 0.01);
  private flipRateHist = new Histogram(0, 12, 0.05);
  private knotHist = new Histogram(0, 26, 1);
  /** BEHIND, gap 20–120 m, split by start state (G5 re-spec 2026-08-17): a
   *  standing smooth pays the jerk spin-up, so its latency gate differs. */
  private convNearMovingHist = new Histogram(0, 180, 1);
  private convNearStandingHist = new Histogram(0, 180, 1);
  private convFarHist = new Histogram(0, 300, 1); // BEHIND, gap 120 m–T_disc, s
  /** AHEAD episodes (smooth ahead of the fresh opinion): §6 doctrine says the
   *  lead is repaid where it is natural — at the next platform hold — so the
   *  wait is DESIGNED, not latency; measured separately and not gated. */
  private aheadRepaidHist = new Histogram(0, 300, 1);
  private oscHist = new Histogram(0, 20, 1);
  private flipsTotal = 0;
  private flipMinutesTotal = 0;
  aheadUnconverged = 0;

  record(e: PerceptualEmission): void {
    this.emissions++;
    if (e.kind === 'first') this.firstEmissions++;
    else if (e.kind === 'fix') this.fixReemissions++;
    else this.ageReemissions++;
    if (e.discontinuity) {
      if (e.kind === 'fix') this.discFix++;
      else if (e.kind === 'age') this.discAge++;
      if (e.discKind !== 'none') this.discByKind[e.discKind]++;
    }

    // §14 doctrine telemetry + recent examples for /physics spot-checks.
    this.requestSkipsTotal += e.requestSkips.length;
    for (const rs of e.requestSkips) {
      this.recentRequestSkips.unshift({ key: e.key, stopId: rs.stopId, emittedAtMs: e.emittedAtMs });
    }
    if (this.recentRequestSkips.length > 8) this.recentRequestSkips.length = 8;
    if (e.jamHolding) {
      this.jamEmissions++;
      this.recentJamHolds.unshift({ key: e.key, emittedAtMs: e.emittedAtMs });
      if (this.recentJamHolds.length > 8) this.recentJamHolds.length = 8;
    }
    if (e.leaderKey !== null) {
      this.leaderClippedEmissions++;
      this.recentLeaderClips.unshift({ key: e.key, leaderKey: e.leaderKey, emittedAtMs: e.emittedAtMs });
      if (this.recentLeaderClips.length > 8) this.recentLeaderClips.length = 8;
    }

    for (const name of ['opinion', 'smooth'] as const) {
      const track = e[name];
      const meta = e.perTrack[name];
      this.knotHist.add(meta.knots);
      this.knotPressureDrops += meta.pressureDrops;
      this.curveViolations += meta.curveViolations;
      this.phantomDips += meta.phantomDips;
      for (const dd of meta.dipDetail) {
        this.g7Recent.unshift({ ...dd, key: e.key, track: name, emittedAtMs: e.emittedAtMs });
      }
      if (this.g7Recent.length > 10) this.g7Recent.length = 10;
      this.infeasibleSkips += meta.infeasibleSkips;
      this.midSegmentStops += meta.midSegmentStops;
      this.jamHolds += meta.jamHolds;
      this.queueHolds += meta.queueHolds;
      this.collisionViolations += meta.collisionViolations;
      for (const md of meta.midSegmentDetail) {
        this.g11Recent.unshift({ key: e.key, track: name, emittedAtMs: e.emittedAtMs, ...md });
      }
      if (this.g11Recent.length > 8) this.g11Recent.length = 8;
      if (meta.collisionViolations > 0) {
        this.g12Recent.unshift({
          key: e.key,
          leaderKey: e.leaderKey,
          track: name,
          emittedAtMs: e.emittedAtMs,
          maxPenM: meta.collisionMaxPenM,
        });
        if (this.g12Recent.length > 8) this.g12Recent.length = 8;
      }
      for (const d of meta.curveDetail) {
        if (d.seg <= 2) this.g4Seg12++;
        else this.g4Later++;
        this.g4ByTrack[name]++;
        this.g4Worst.push({ ...d, key: e.key, track: name, emittedAtMs: e.emittedAtMs });
        this.g4Worst.sort((a, b) => b.vSeg - b.cap * 1.05 - (a.vSeg - a.cap * 1.05));
        if (this.g4Worst.length > 10) this.g4Worst.length = 10;
      }
      if (meta.regime !== null) {
        const r = this.regimeSum;
        r.catchSteps += meta.regime.catchSteps;
        r.catchCeilBound += meta.regime.catchCeilBound;
        r.catchCeilBelowRef += meta.regime.catchCeilBelowRef;
        r.catchEnvBound += meta.regime.catchEnvBound;
        r.catchRampBound += meta.regime.catchRampBound;
        r.ceilShortfallSum += meta.regime.ceilShortfallSum;
        r.hfBehindSteps += meta.regime.hfBehindSteps;
        r.hfCeilBound += meta.regime.hfCeilBound;
        r.yieldSteps += meta.regime.yieldSteps;
        r.yieldOutrun += meta.regime.yieldOutrun;
      }
      if (meta.budgetForced) this.budgetForcedEmissions++;
      for (const j of readJerk(track)) {
        const aj = Math.abs(j);
        this.jerkHist.add(aj);
        if (aj > 1.0) this.jerkOver1++;
        if (aj > this.jerkMax) this.jerkMax = aj;
      }
      const f = readFlips(track);
      this.flipsTotal += f.flips;
      this.flipMinutesTotal += f.minutes;
      if (f.minutes > 0.5) this.flipRateHist.add(f.flips / f.minutes);
    }

    // G9 seam (non-discontinuity re-emissions only).
    if (!e.discontinuity && e.prevSmooth !== null) {
      const d = Math.abs(evalTrack(e.smooth, e.emittedAtMs) - evalTrack(e.prevSmooth, e.emittedAtMs));
      if (d > this.maxSeamM) this.maxSeamM = d;
      if (d > 2) this.seamViolations++;
    }

    // G5 + G6: convergence latency and post-convergence hunting, measured on
    // the emitted curves exactly as a client would render them. Split by
    // DIRECTION: gSigned > 0 = smooth BEHIND the fresh opinion — the catch-up
    // mechanism the G5 gates target («вяло догоняет»). gSigned < 0 = smooth
    // AHEAD: §6 repays the lead at the next platform hold by construction, so
    // the wait is the design working, tracked separately and not gated.
    if (e.kind === 'fix' && !e.discontinuity) {
      const E = e.emittedAtMs;
      const gSigned = evalTrack(e.opinion, E) - evalTrack(e.smooth, E);
      const gap = Math.abs(gSigned);
      if (gap >= 20) {
        const horizonS = Math.round((e.opinion[e.opinion.length - 1].t - E) / 1000);
        let convS: number | null = null;
        for (let dt = 0; dt <= horizonS; dt++) {
          const t = E + dt * 1000;
          if (Math.abs(evalTrack(e.smooth, t) - evalTrack(e.opinion, t)) < TRAJ_CONV_TOL_M) {
            convS = dt;
            break;
          }
        }
        if (gSigned < 0) {
          if (convS === null) this.aheadUnconverged++;
          else this.aheadRepaidHist.add(convS);
        } else {
          // Start-state split: standing = first emitted smooth segment's
          // chord < 1 m/s (byte-identical to the check-v2 classification).
          const sdt = (e.smooth[1].t - e.smooth[0].t) / 1000;
          const sv0 = sdt > 0 ? (e.smooth[1].s - e.smooth[0].s) / sdt : 0;
          if (convS === null) this.unconverged++;
          else if (gap > 120) this.convFarHist.add(convS);
          else if (sv0 < 1.0) this.convNearStandingHist.add(convS);
          else this.convNearMovingHist.add(convS);
          if (convS !== null) {
            // G6: sign changes of (smooth − opinion) after first convergence,
            // 2 m deadband so cm-rounding noise never counts as hunting.
            let sign = 0;
            let osc = 0;
            for (let dt = convS; dt <= horizonS; dt++) {
              const d = evalTrack(e.smooth, E + dt * 1000) - evalTrack(e.opinion, E + dt * 1000);
              if (d > 2) {
                if (sign < 0) osc++;
                sign = 1;
              } else if (d < -2) {
                if (sign > 0) osc++;
                sign = -1;
              }
            }
            this.oscHist.add(osc);
            if (osc > this.maxOscillations) this.maxOscillations = osc;
          }
        }
      }
    }
  }

  gauges(): unknown {
    return {
      emissions: this.emissions,
      kinds: { first: this.firstEmissions, fix: this.fixReemissions, age: this.ageReemissions },
      g2jerk: {
        gate: TRAJ_J_GATE,
        n: this.jerkHist.n,
        p50: this.jerkHist.pct(50),
        p90: this.jerkHist.pct(90),
        p99: this.jerkHist.pct(99),
        max: round3(this.jerkMax),
        over1: this.jerkOver1,
      },
      g3flips: {
        deadband: TRAJ_FLIP_DEADBAND,
        fleetPerMin:
          this.flipMinutesTotal > 0 ? round3(this.flipsTotal / this.flipMinutesTotal) : null,
        trackP95: this.flipRateHist.pct(95),
        n: this.flipRateHist.n,
      },
      g4curve: {
        violations: this.curveViolations,
        seg12: this.g4Seg12,
        later: this.g4Later,
        byTrack: this.g4ByTrack,
        worst: this.g4Worst,
      },
      g5catchup: {
        tolM: TRAJ_CONV_TOL_M,
        nearMoving: {
          n: this.convNearMovingHist.n,
          p50s: this.convNearMovingHist.pct(50),
          p90s: this.convNearMovingHist.pct(90),
        },
        nearStanding: {
          n: this.convNearStandingHist.n,
          p50s: this.convNearStandingHist.pct(50),
          p90s: this.convNearStandingHist.pct(90),
        },
        far: {
          n: this.convFarHist.n,
          p50s: this.convFarHist.pct(50),
          p90s: this.convFarHist.pct(90),
        },
        unconverged: this.unconverged,
        aheadRepaid: {
          n: this.aheadRepaidHist.n,
          p50s: this.aheadRepaidHist.pct(50),
          p90s: this.aheadRepaidHist.pct(90),
          unconverged: this.aheadUnconverged,
        },
        limiter: { ...this.regimeSum, ceilShortfallSum: round3(this.regimeSum.ceilShortfallSum) },
      },
      g6oscillation: {
        episodes: this.oscHist.n,
        p95: this.oscHist.pct(95),
        max: this.maxOscillations,
      },
      g7phantomDips: this.phantomDips,
      g7recent: this.g7Recent,
      g11midSegmentStops: {
        violations: this.midSegmentStops,
        jamHolds: this.jamHolds,
        queueHolds: this.queueHolds,
        recent: this.g11Recent,
      },
      g12collision: {
        violations: this.collisionViolations,
        leaderClippedEmissions: this.leaderClippedEmissions,
        recent: this.g12Recent,
      },
      doctrine: {
        requestSkips: this.requestSkipsTotal,
        jamEmissions: this.jamEmissions,
        recentRequestSkips: this.recentRequestSkips,
        recentJamHolds: this.recentJamHolds,
        recentLeaderClips: this.recentLeaderClips,
      },
      g8discontinuity: {
        fix: { n: this.fixReemissions, flagged: this.discFix },
        age: { n: this.ageReemissions, flagged: this.discAge },
        byKind: this.discByKind,
        fixRatePct:
          this.fixReemissions > 0 ? round3((100 * this.discFix) / this.fixReemissions) : null,
      },
      g9seam: { violations: this.seamViolations, maxM: round3(this.maxSeamM) },
      knots: {
        p50: this.knotHist.pct(50),
        p99: this.knotHist.pct(99),
        pressureDrops: this.knotPressureDrops,
        budgetForcedEmissions: this.budgetForcedEmissions,
        infeasibleSkips: this.infeasibleSkips,
      },
    };
  }
}
