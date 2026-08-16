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
  TRAJ_V_MAX_GATE_MS,
} from './config';
import type { TrackPoint } from './trajectory';

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
