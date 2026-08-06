/// <reference types="jest" />

import {
  A_BRK,
  buildSpeedProfile,
  cruiseCapAt,
  curveCap,
  CURVE_SLOW_FACTOR,
  DEFAULT_LOOKAHEAD_M,
  V_CENTER_MS,
  V_CURVE_MIN_MS,
  V_MAX_MS,
  vAllowedAt,
  zoneCapAt,
} from '@/lib/engine/speedProfile';
import { CENTER_ORIGIN, makeGeometry } from './helpers';

describe('zoneCapAt', () => {
  it('caps to 8.6 m/s inside the center bbox during daytime', () => {
    expect(zoneCapAt([14.42, 50.08], true)).toBe(V_CENTER_MS);
  });
  it('is 13.9 m/s inside the center at night', () => {
    expect(zoneCapAt([14.42, 50.08], false)).toBe(V_MAX_MS);
  });
  it('is 13.9 m/s outside the center regardless of time', () => {
    expect(zoneCapAt([14.6, 50.05], true)).toBe(V_MAX_MS);
    expect(zoneCapAt([14.6, 50.05], false)).toBe(V_MAX_MS);
  });
});

describe('curveCap', () => {
  it('is unbounded (vmax) on straights', () => {
    expect(curveCap(0)).toBe(V_MAX_MS);
  });
  it('follows CURVE_SLOW_FACTOR · sqrt(A_LAT/κ) in the mid range', () => {
    expect(curveCap(0.0785)).toBeCloseTo(CURVE_SLOW_FACTOR * Math.sqrt(0.98 / 0.0785), 3);
  });
  it('clamps to [1.4, 13.9]', () => {
    expect(curveCap(100)).toBe(V_CURVE_MIN_MS);
    expect(curveCap(1e-9)).toBe(V_MAX_MS);
  });
});

describe('buildSpeedProfile', () => {
  it('gives vmax everywhere on a straight line outside the center', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [1000, 0],
      ],
      [],
    );
    const profile = buildSpeedProfile(geo, { daytime: true });
    for (const v of profile.vLimit) expect(v).toBeCloseTo(V_MAX_MS, 1);
  });

  it('applies the center zone cap by daytime flag', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [500, 0],
      ],
      [],
      CENTER_ORIGIN,
    );
    const day = buildSpeedProfile(geo, { daytime: true });
    const night = buildSpeedProfile(geo, { daytime: false });
    expect(day.vLimit[0]).toBeCloseTo(V_CENTER_MS, 5);
    expect(night.vLimit[0]).toBeCloseTo(V_MAX_MS, 5);
    expect(day.daytime).toBe(true);
    expect(night.daytime).toBe(false);
  });

  it('drops the limit hard at a sharp 90° corner', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [500, 500],
      ],
      [],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    expect(profile.vLimit[1]).toBeGreaterThan(2.5);
    expect(profile.vLimit[1]).toBeLessThan(4.2); // < 30% of vmax
    expect(profile.vLimit[0]).toBeCloseTo(V_MAX_MS, 1);
    expect(profile.vLimit[2]).toBeCloseTo(V_MAX_MS, 1);
  });
});

describe('cruiseCapAt (cruise reference, no envelope)', () => {
  it('ignores stops entirely — they are envelope constraints, not cruise caps', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [{ atM: 500, arrivalMs: 0 }],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    expect(cruiseCapAt(profile, geo, 499)).toBeCloseTo(V_MAX_MS, 1);
    expect(vAllowedAt(profile, geo, 499)).toBeLessThan(2); // envelope DOES brake
  });

  it('uses the point-constraint segment cap (max of endpoints) at a corner', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [500, 500],
      ],
      [],
    );
    const profile = buildSpeedProfile(geo, { daytime: false });
    // On the straight leading to the corner the cruise cap stays vmax…
    expect(cruiseCapAt(profile, geo, 100)).toBeCloseTo(V_MAX_MS, 1);
    // …and matches the envelope's base cap semantics far from limits.
    expect(cruiseCapAt(profile, geo, 100)).toBeCloseTo(vAllowedAt(profile, geo, 100), 1);
  });
});

describe('vAllowedAt (braking envelope)', () => {
  const geoWithStop = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [{ atM: 500, arrivalMs: 0 }],
  );
  const profile = buildSpeedProfile(geoWithStop, { daytime: false });

  it('is vmax far from any limit', () => {
    expect(vAllowedAt(profile, geoWithStop, 100)).toBeCloseTo(V_MAX_MS, 1);
  });

  it('shrinks as sqrt(2·aBrk·d) approaching a stop', () => {
    expect(vAllowedAt(profile, geoWithStop, 450)).toBeCloseTo(Math.sqrt(2 * A_BRK * 50), 1);
    expect(vAllowedAt(profile, geoWithStop, 499)).toBeCloseTo(Math.sqrt(2 * A_BRK * 1), 1);
    expect(vAllowedAt(profile, geoWithStop, 500)).toBeCloseTo(0, 3);
  });

  it('is monotonically non-increasing on the approach', () => {
    let prev = Infinity;
    for (let s = 350; s <= 500; s += 10) {
      const v = vAllowedAt(profile, geoWithStop, s);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('ignores stops behind minStopDist (already dwelled)', () => {
    expect(vAllowedAt(profile, geoWithStop, 450, 500.01)).toBeCloseTo(V_MAX_MS, 1);
  });

  it('the monotonic stop hint preserves the full-scan braking envelope', () => {
    const manyStops = makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      Array.from({ length: 20 }, (_, i) => ({ atM: (i + 1) * 100, arrivalMs: i * 10_000 })),
    );
    const manyProfile = buildSpeedProfile(manyStops, { daytime: false });
    // stops[0..11] are permanently served; index 12 is the first candidate.
    for (const s of [1201, 1250, 1299, 1350]) {
      const fullScan = vAllowedAt(manyProfile, manyStops, s, 1200.01);
      const hinted = vAllowedAt(
        manyProfile,
        manyStops,
        s,
        1200.01,
        DEFAULT_LOOKAHEAD_M,
        A_BRK,
        12,
      );
      expect(hinted).toBeCloseTo(fullScan, 10);
    }
  });

  it('ignores limits beyond the 400 m lookahead', () => {
    const longGeo = makeGeometry(
      [
        [0, 0],
        [2000, 0],
      ],
      [{ atM: 1000, arrivalMs: 0 }],
    );
    const longProfile = buildSpeedProfile(longGeo, { daytime: false });
    expect(vAllowedAt(longProfile, longGeo, 400)).toBeCloseTo(V_MAX_MS, 1); // stop 600 m away
    expect(vAllowedAt(longProfile, longGeo, 950)).toBeCloseTo(Math.sqrt(2 * A_BRK * 50), 1);
  });

  it('brakes for a sharp corner ahead', () => {
    const lGeo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [500, 500],
      ],
      [],
    );
    const lProfile = buildSpeedProfile(lGeo, { daytime: false });
    const cornerLimit = lProfile.vLimit[1];
    const at490 = vAllowedAt(lProfile, lGeo, 490);
    expect(at490).toBeCloseTo(Math.sqrt(cornerLimit * cornerLimit + 2 * A_BRK * 10), 1);
    expect(at490).toBeLessThan(7);
    // A long straight leading to the corner is NOT blanket-limited.
    expect(vAllowedAt(lProfile, lGeo, 100)).toBeCloseTo(V_MAX_MS, 1);
  });

  it('keeps the curve cap active for a trailing tram-length past the apex', () => {
    const lGeo = makeGeometry(
      [
        [0, 0],
        [500, 0],
        [500, 500],
      ],
      [],
    );
    const lProfile = buildSpeedProfile(lGeo, { daytime: false });
    const cornerLimit = lProfile.vLimit[1];
    // 10 m past the corner the body is still on the curve → capped.
    expect(vAllowedAt(lProfile, lGeo, 510)).toBeCloseTo(cornerLimit, 1);
    // 30 m past, the body has cleared it → back to vmax.
    expect(vAllowedAt(lProfile, lGeo, 530)).toBeCloseTo(V_MAX_MS, 1);
  });

  it('treats the geometry end as a hard 0-limit', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [600, 0],
      ],
      [],
    );
    const p = buildSpeedProfile(geo, { daytime: false });
    expect(vAllowedAt(p, geo, 600)).toBeCloseTo(0, 3);
    expect(vAllowedAt(p, geo, 550)).toBeCloseTo(Math.sqrt(2 * A_BRK * 50), 1);
  });
});
