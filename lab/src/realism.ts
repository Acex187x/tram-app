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
  TRAJ_V_MAX_GATE_MS,
} from './config';
import { evalTrack, type TrackPoint } from './trajectory';

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
  discKind: 'none' | 'trip' | 'gap';
  opinion: TrackPoint[];
  smooth: TrackPoint[];
  /** Previous emission's smooth track (same chain), for the G9 seam. */
  prevSmooth: TrackPoint[] | null;
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
  phantomDips: number;
  infeasibleSkips: number;
}

/** Lifetime perceptual counters over every SHADOW (later: published) emission. */
export class PerceptualCounters {
  emissions = 0;
  firstEmissions = 0;
  fixReemissions = 0;
  ageReemissions = 0;
  discFix = 0;
  discAge = 0;
  discByKind = { trip: 0, gap: 0 };
  /** G4 / G7 / plan feasibility, straight sums of the generator's own counts. */
  curveViolations = 0;
  phantomDips = 0;
  infeasibleSkips = 0;
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
  private convNearHist = new Histogram(0, 180, 1); // BEHIND, gap 20–120 m, s
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

    for (const name of ['opinion', 'smooth'] as const) {
      const track = e[name];
      const meta = e.perTrack[name];
      this.knotHist.add(meta.knots);
      this.knotPressureDrops += meta.pressureDrops;
      this.curveViolations += meta.curveViolations;
      this.phantomDips += meta.phantomDips;
      this.infeasibleSkips += meta.infeasibleSkips;
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
          if (convS === null) this.unconverged++;
          else if (gap > 120) this.convFarHist.add(convS);
          else this.convNearHist.add(convS);
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
      g4curve: { violations: this.curveViolations },
      g5catchup: {
        tolM: TRAJ_CONV_TOL_M,
        near: {
          n: this.convNearHist.n,
          p50s: this.convNearHist.pct(50),
          p90s: this.convNearHist.pct(90),
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
      },
      g6oscillation: {
        episodes: this.oscHist.n,
        p95: this.oscHist.pct(95),
        max: this.maxOscillations,
      },
      g7phantomDips: this.phantomDips,
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
