// Pure GPS outlier rejection + smoothing for ride recordings. Phone GPS on a
// tram is noisy and occasionally teleports sideways (urban canyons, tunnels,
// Wi-Fi-assisted fixes); the calibration analysis needs BOTH the raw fixes
// (preserved verbatim in the ride file) and a physically-plausible filtered
// track to project onto the tram's shape (fDist/fLagM ride fields).
//
// Design — deliberately simple and fully unit-testable (no deps, no clocks):
//   1. Accuracy gate: fixes with horizontalAccuracy above `maxAccuracyM` are
//      rejected outright ('acc') — they carry almost no positional signal.
//   2. Jump gate: a fix farther from the predicted position than the tram
//      could physically travel since the last ACCEPTED fix
//      (maxSpeedMs·dt + jumpSlackM + accuracy) is rejected ('jump').
//   3. Alpha-beta smoother over a local equirectangular meter frame anchored
//      at the first accepted fix: position+velocity state, fixed gains. Cheap,
//      lag-bounded, and it does not cut real corners at tram speeds (tested).
//   4. Recovery: `resetAfterRejects` consecutive JUMP rejects mean the jump
//      was real (GPS reacquired after a tunnel, filter mis-anchored) — the
//      filter re-anchors on the current fix instead of rejecting forever.
//      Accuracy rejects do NOT count toward recovery (re-anchoring onto a
//      100 m-accuracy fix would be worse than coasting).
//
// While rejecting, the filter still emits a COASTED prediction (last state
// extrapolated to the sample's time) so consumers always have a best-guess
// position; `reason` tells them how much to trust it.

const M_PER_DEG_LAT = 111_320;
const DEG2RAD = Math.PI / 180;
/** Assumed accuracy (m) when the sample carries none. */
const DEFAULT_ACCURACY_M = 30;

export type GpsRejectReason = 'acc' | 'jump';

export interface GpsFilterInput {
  /** Sample wall-clock ms. */
  t: number;
  lat: number;
  lng: number;
  /** Horizontal accuracy in meters; null when the platform withholds it. */
  accuracy: number | null;
}

export interface GpsFilterOutput {
  /** False when the fix was rejected as an outlier (see `reason`). */
  accepted: boolean;
  reason: GpsRejectReason | null;
  /**
   * Filtered position: the smoothed estimate when accepted, a coasted
   * prediction when rejected, null only before the filter has ever anchored.
   */
  lat: number | null;
  lng: number | null;
  /** Filtered ground speed, m/s (null before anchoring). */
  speedMs: number | null;
  /** True when this sample re-anchored the filter (recovery after a real jump). */
  reset: boolean;
}

export interface GpsFilterStats {
  accepted: number;
  rejectedAcc: number;
  rejectedJump: number;
  resets: number;
}

export interface GpsFilterOptions {
  /** Reject fixes with horizontalAccuracy above this, m. */
  maxAccuracyM?: number;
  /** Fastest physically-plausible travel, m/s (Prague trams top out ~18 m/s). */
  maxSpeedMs?: number;
  /** Additive slack on the jump gate, m (absorbs fix-to-fix jitter). */
  jumpSlackM?: number;
  /** Consecutive jump-rejects that re-anchor the filter (the jump was real). */
  resetAfterRejects?: number;
  /** Alpha-beta position gain (0..1, higher = trust measurements more). */
  alpha?: number;
  /** Alpha-beta velocity gain (0..1). */
  beta?: number;
}

export const GPS_FILTER_DEFAULTS: Required<GpsFilterOptions> = {
  maxAccuracyM: 45,
  // Generous vs. real tram speeds (~60 km/h max): the gate must never reject
  // legitimate motion, only teleports. 40 m/s ≈ 144 km/h.
  maxSpeedMs: 40,
  jumpSlackM: 15,
  resetAfterRejects: 5,
  // Steady-state noise-variance ratio ≈ 0.58 (≈ 0.76× RMS) at these gains,
  // while the corner lag at tram speeds stays under ~10 m (see gps-filter
  // tests: smoothing + 90°-turn bounds).
  alpha: 0.45,
  beta: 0.15,
};

export class GpsFilter {
  private readonly opt: Required<GpsFilterOptions>;

  /** Local frame anchor (first accepted fix); null before anchoring. */
  private lat0 = 0;
  private lng0 = 0;
  private cosLat0 = 1;
  private anchored = false;

  /** State in the local meter frame, at time `lastT` (last ACCEPTED sample). */
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private lastT = 0;

  private jumpRejectRun = 0;
  private readonly counts: GpsFilterStats = {
    accepted: 0,
    rejectedAcc: 0,
    rejectedJump: 0,
    resets: 0,
  };

  constructor(options: GpsFilterOptions = {}) {
    this.opt = { ...GPS_FILTER_DEFAULTS, ...options };
  }

  stats(): GpsFilterStats {
    return { ...this.counts };
  }

  push(s: GpsFilterInput): GpsFilterOutput {
    const acc = s.accuracy != null && Number.isFinite(s.accuracy) ? s.accuracy : DEFAULT_ACCURACY_M;

    // 1. Accuracy gate — applies even before anchoring (never anchor on junk).
    if (acc > this.opt.maxAccuracyM) {
      this.counts.rejectedAcc += 1;
      return this.rejected('acc', s.t);
    }

    if (!this.anchored) {
      this.anchor(s);
      this.counts.accepted += 1;
      return { accepted: true, reason: null, lat: s.lat, lng: s.lng, speedMs: 0, reset: false };
    }

    const dt = Math.max((s.t - this.lastT) / 1000, 0.05);
    const [zx, zy] = this.toLocal(s.lat, s.lng);
    // Prediction from the last accepted state.
    const px = this.x + this.vx * dt;
    const py = this.y + this.vy * dt;
    const jump = Math.hypot(zx - px, zy - py);

    // 2. Jump gate — scales with the time since the last accepted fix, so a
    // long GPS gap legitimately allows a long displacement.
    if (jump > this.opt.maxSpeedMs * dt + this.opt.jumpSlackM + acc) {
      this.counts.rejectedJump += 1;
      this.jumpRejectRun += 1;
      if (this.jumpRejectRun >= this.opt.resetAfterRejects) {
        // The "jump" persisted — it was real. Re-anchor on this fix.
        this.anchor(s);
        this.counts.resets += 1;
        this.counts.accepted += 1;
        return { accepted: true, reason: null, lat: s.lat, lng: s.lng, speedMs: 0, reset: true };
      }
      return this.rejected('jump', s.t);
    }

    // 3. Alpha-beta update.
    this.jumpRejectRun = 0;
    const rx = zx - px;
    const ry = zy - py;
    this.x = px + this.opt.alpha * rx;
    this.y = py + this.opt.alpha * ry;
    this.vx += (this.opt.beta / dt) * rx;
    this.vy += (this.opt.beta / dt) * ry;
    // Velocity clamp: the state must stay physically plausible even after an
    // in-gate glitch, or the next prediction would overshoot.
    const v = Math.hypot(this.vx, this.vy);
    if (v > this.opt.maxSpeedMs) {
      const k = this.opt.maxSpeedMs / v;
      this.vx *= k;
      this.vy *= k;
    }
    this.lastT = s.t;
    this.counts.accepted += 1;
    const [lat, lng] = this.toGeo(this.x, this.y);
    return { accepted: true, reason: null, lat, lng, speedMs: Math.hypot(this.vx, this.vy), reset: false };
  }

  /** Re-anchor the local frame + state on a fix (first fix or recovery). */
  private anchor(s: GpsFilterInput): void {
    this.lat0 = s.lat;
    this.lng0 = s.lng;
    this.cosLat0 = Math.cos(s.lat * DEG2RAD);
    this.anchored = true;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.lastT = s.t;
    this.jumpRejectRun = 0;
  }

  /** Coasted output for a rejected sample: predict, but do NOT commit state. */
  private rejected(reason: GpsRejectReason, t: number): GpsFilterOutput {
    if (!this.anchored) {
      return { accepted: false, reason, lat: null, lng: null, speedMs: null, reset: false };
    }
    const dt = Math.max((t - this.lastT) / 1000, 0);
    const [lat, lng] = this.toGeo(this.x + this.vx * dt, this.y + this.vy * dt);
    return {
      accepted: false,
      reason,
      lat,
      lng,
      speedMs: Math.hypot(this.vx, this.vy),
      reset: false,
    };
  }

  private toLocal(lat: number, lng: number): [number, number] {
    return [(lng - this.lng0) * this.cosLat0 * M_PER_DEG_LAT, (lat - this.lat0) * M_PER_DEG_LAT];
  }

  private toGeo(x: number, y: number): [number, number] {
    return [this.lat0 + y / M_PER_DEG_LAT, this.lng0 + x / (this.cosLat0 * M_PER_DEG_LAT)];
  }
}
