// Follow-camera pure math: target leading + the stationary-target deadband
// (project-review P2 — the retarget loop must not restart native camera
// animations while the followed tram dwells at a stop).

import {
  CAMERA_DEADBAND_DEG,
  CAMERA_DEADBAND_M,
  CAMERA_GLIDE_MS,
  CAMERA_RETARGET_MS,
  JUMP_GLIDE_MS,
  JUMP_MIN_M,
  isJumpTarget,
  leadTarget,
  M_PER_DEG_LAT,
  withinDeadband,
  type FollowCameraTarget,
} from '@/components/map/followCamera';

/** Prague-ish reference point. */
const LNG = 14.42;
const LAT = 50.08;

const target = (over: Partial<FollowCameraTarget> = {}): FollowCameraTarget => ({
  center: [LNG, LAT],
  heading: 90,
  zoom: 17.5,
  pitch: 60,
  ...over,
});

/** Shift a target's center `north`/`east` meters (small-offset math). */
const shifted = (northM: number, eastM: number): FollowCameraTarget =>
  target({
    center: [
      LNG + eastM / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180)),
      LAT + northM / M_PER_DEG_LAT,
    ],
  });

describe('withinDeadband', () => {
  it('suppresses an identical target (dwell: nothing changed)', () => {
    expect(withinDeadband(target(), target())).toBe(true);
  });

  it('suppresses sub-deadband drift and sub-deadband heading wobble', () => {
    expect(withinDeadband(target(), shifted(0.3, 0.2))).toBe(true);
    expect(withinDeadband(target(), target({ heading: 90 + CAMERA_DEADBAND_DEG * 0.6 }))).toBe(
      true,
    );
  });

  it('sends once movement crosses the deadband (any axis)', () => {
    expect(withinDeadband(target(), shifted(CAMERA_DEADBAND_M * 1.2, 0))).toBe(false);
    expect(withinDeadband(target(), shifted(0, CAMERA_DEADBAND_M * 1.2))).toBe(false);
    // Diagonal: 0.4 m N + 0.4 m E = 0.57 m > 0.5 m.
    expect(withinDeadband(target(), shifted(0.4, 0.4))).toBe(false);
  });

  it('sends on a teleport (far jump is trivially outside the deadband)', () => {
    expect(withinDeadband(target(), target({ center: [LNG + 0.01, LAT] }))).toBe(false);
  });

  it('measures heading the shortest way around the circle', () => {
    // 359.9° → 0.2° is a 0.3° turn, not 359.7°.
    expect(withinDeadband(target({ heading: 359.9 }), target({ heading: 0.2 }))).toBe(true);
    expect(withinDeadband(target({ heading: 359.9 }), target({ heading: 1.5 }))).toBe(false);
  });

  it('sends on any zoom/pitch override change, however small', () => {
    expect(withinDeadband(target(), target({ zoom: 17.5001 }))).toBe(false);
    expect(withinDeadband(target(), target({ pitch: 60.0001 }))).toBe(false);
  });
});

describe('leadTarget', () => {
  it('returns the anchor unchanged at zero speed (dwell)', () => {
    expect(leadTarget([LNG, LAT], 45, 0)).toEqual([LNG, LAT]);
  });

  it('leads along the bearing by one retarget interval of travel', () => {
    const speedKmh = 36; // 10 m/s → 0.8 m per 80 ms retarget
    const expectedM = (speedKmh / 3.6) * (CAMERA_RETARGET_MS / 1000);

    const north = leadTarget([LNG, LAT], 0, speedKmh);
    expect((north[1] - LAT) * M_PER_DEG_LAT).toBeCloseTo(expectedM, 6);
    expect(north[0]).toBe(LNG);

    const east = leadTarget([LNG, LAT], 90, speedKmh);
    const eastM = (east[0] - LNG) * M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
    expect(eastM).toBeCloseTo(expectedM, 6);
    expect(east[1]).toBeCloseTo(LAT, 12);
  });

  it('a lead step at driving speed exceeds the deadband (moving trams always retarget)', () => {
    const from = target();
    const to = target({ center: leadTarget([LNG, LAT], 30, 25) }); // 25 km/h → 0.56 m
    expect(withinDeadband(from, to)).toBe(false);
  });
});

// Discontinuity glide (physics-v3-protocol §"Two render modes"): the «fixed»
// curve re-anchors on every fix and the smooth one may fade-teleport once at a
// server-flagged discontinuity. Either way the followed tram LEAPS, and a hard
// 170 ms snap across hundreds of meters at follow zoom reads as a cut. The
// decision is keyed on how far the target actually moved, not on the mode, so
// a smooth-mode discontinuity is eased exactly like a fixed-mode re-anchor.
describe('discontinuity glide', () => {
  it('is meaningfully longer than the steady-state glide, bounded by the return ease ballpark', () => {
    expect(JUMP_GLIDE_MS).toBeGreaterThan(CAMERA_GLIDE_MS * 2);
    expect(JUMP_GLIDE_MS).toBeLessThanOrEqual(1_500);
  });

  it('does not fire without a previous send (follow just engaged)', () => {
    expect(isJumpTarget(null, target())).toBe(false);
  });

  it('ordinary motion between retargets is not a jump', () => {
    // ~2.2 m north — a tram at 100 km/h covers that in one 80 ms retarget.
    const from = target();
    const to = target({ center: [LNG, LAT + 2 / M_PER_DEG_LAT] });
    expect(isJumpTarget(from, to)).toBe(false);
  });

  it('a re-anchor beyond JUMP_MIN_M is a jump', () => {
    const from = target();
    const to = target({ center: [LNG, LAT + (JUMP_MIN_M + 5) / M_PER_DEG_LAT] });
    expect(isJumpTarget(from, to)).toBe(true);
  });
});
