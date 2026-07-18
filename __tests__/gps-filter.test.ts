// Unit tests for the pure ride-GPS filter (src/lib/motionlog/gpsFilter.ts):
// accuracy gate, physically-impossible-jump gate, alpha-beta smoothing that
// reduces noise WITHOUT cutting real turns, coasted output while rejecting,
// and re-anchoring recovery after a persistent (real) jump.
import { GPS_FILTER_DEFAULTS, GpsFilter } from '@/lib/motionlog/gpsFilter';

const M_PER_DEG_LAT = 111_320;
const LAT0 = 50.08;
const LNG0 = 14.42;
const COS0 = Math.cos((LAT0 * Math.PI) / 180);

/** Local meter offsets → lat/lng around the Prague anchor. */
function geo(xM: number, yM: number): { lat: number; lng: number } {
  return { lat: LAT0 + yM / M_PER_DEG_LAT, lng: LNG0 + xM / (COS0 * M_PER_DEG_LAT) };
}

/** Distance in meters between two lat/lng points (small-offset approximation). */
function distM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dx = (aLng - bLng) * COS0 * M_PER_DEG_LAT;
  const dy = (aLat - bLat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Deterministic pseudo-random ±1 sequence (LCG) for repeatable "noise". */
function makeNoise(seed = 42): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

describe('GpsFilter gates', () => {
  it('rejects fixes with horizontal accuracy above the gate', () => {
    const f = new GpsFilter();
    const good = f.push({ t: 0, ...geo(0, 0), accuracy: 8 });
    expect(good.accepted).toBe(true);

    const bad = f.push({
      t: 1000,
      ...geo(5, 0),
      accuracy: GPS_FILTER_DEFAULTS.maxAccuracyM + 1,
    });
    expect(bad.accepted).toBe(false);
    expect(bad.reason).toBe('acc');
    expect(f.stats().rejectedAcc).toBe(1);
  });

  it('never anchors on a junk-accuracy fix (output stays null before anchoring)', () => {
    const f = new GpsFilter();
    const out = f.push({ t: 0, ...geo(0, 0), accuracy: 200 });
    expect(out.accepted).toBe(false);
    expect(out.lat).toBeNull();
    expect(out.lng).toBeNull();
  });

  it('rejects a physically impossible jump and coasts through it', () => {
    const f = new GpsFilter();
    // 1 Hz eastbound at 10 m/s.
    for (let i = 0; i < 10; i++) f.push({ t: i * 1000, ...geo(i * 10, 0), accuracy: 5 });

    // The classic "уехал в сторону" teleport: 500 m north for one fix.
    const jump = f.push({ t: 10_000, ...geo(100, 500), accuracy: 5 });
    expect(jump.accepted).toBe(false);
    expect(jump.reason).toBe('jump');
    // Coasted output continues the plausible track instead of teleporting.
    const truth = geo(100, 0);
    expect(distM(jump.lat!, jump.lng!, truth.lat, truth.lng)).toBeLessThan(15);

    // The next sane fix is accepted and the track is unharmed.
    const next = f.push({ t: 11_000, ...geo(110, 0), accuracy: 5 });
    expect(next.accepted).toBe(true);
    const truth2 = geo(110, 0);
    expect(distM(next.lat!, next.lng!, truth2.lat, truth2.lng)).toBeLessThan(10);
    expect(f.stats().rejectedJump).toBe(1);
  });

  it('allows a large displacement after a long GPS gap (gate scales with dt)', () => {
    const f = new GpsFilter();
    f.push({ t: 0, ...geo(0, 0), accuracy: 5 });
    // 60 s without fixes (tunnel), tram moved ~700 m at ~12 m/s — legitimate.
    const out = f.push({ t: 60_000, ...geo(700, 0), accuracy: 5 });
    expect(out.accepted).toBe(true);
  });
});

describe('GpsFilter smoothing', () => {
  it('reduces RMS error on a noisy straight track', () => {
    const f = new GpsFilter();
    const noise = makeNoise();
    let rawSq = 0;
    let filtSq = 0;
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const truth = geo(i * 10, 0); // 10 m/s eastbound, 1 Hz
      const nx = noise() * 12;
      const ny = noise() * 12;
      const noisy = geo(i * 10 + nx, ny);
      const out = f.push({ t: i * 1000, ...noisy, accuracy: 10 });
      expect(out.accepted).toBe(true);
      if (i >= 10) {
        // after convergence
        rawSq += distM(noisy.lat, noisy.lng, truth.lat, truth.lng) ** 2;
        filtSq += distM(out.lat!, out.lng!, truth.lat, truth.lng) ** 2;
        n += 1;
      }
    }
    const rawRms = Math.sqrt(rawSq / n);
    const filtRms = Math.sqrt(filtSq / n);
    expect(filtRms).toBeLessThan(rawRms * 0.85);
  });

  it('does not cut a real 90° turn (clean track, bounded lag)', () => {
    const f = new GpsFilter();
    const v = 8; // m/s, 1 Hz — brisk tram through a junction
    let maxErr = 0;
    for (let i = 0; i < 40; i++) {
      // 20 samples east, then 90° turn to north.
      const truth = i < 20 ? geo(i * v, 0) : geo(19 * v, (i - 19) * v);
      const out = f.push({ t: i * 1000, ...truth, accuracy: 5 });
      expect(out.accepted).toBe(true);
      maxErr = Math.max(maxErr, distM(out.lat!, out.lng!, truth.lat, truth.lng));
    }
    // Alpha-beta lag through the corner stays small vs. the 30 m gpsOffM gate.
    expect(maxErr).toBeLessThan(12);
    // And it converges back onto the northbound leg.
    const finalTruth = geo(19 * v, 20 * v);
    const final = f.push({ t: 40_000, ...finalTruth, accuracy: 5 });
    expect(distM(final.lat!, final.lng!, finalTruth.lat, finalTruth.lng)).toBeLessThan(5);
  });

  it('reports a plausible filtered speed', () => {
    const f = new GpsFilter();
    let out = f.push({ t: 0, ...geo(0, 0), accuracy: 5 });
    for (let i = 1; i < 30; i++) out = f.push({ t: i * 1000, ...geo(i * 10, 0), accuracy: 5 });
    expect(out.speedMs!).toBeGreaterThan(8);
    expect(out.speedMs!).toBeLessThan(12);
  });
});

describe('GpsFilter recovery', () => {
  it('re-anchors after resetAfterRejects consecutive jump rejects (the jump was real)', () => {
    const f = new GpsFilter();
    for (let i = 0; i < 5; i++) f.push({ t: i * 1000, ...geo(i * 10, 0), accuracy: 5 });

    // GPS reacquires 2 km away (e.g. it had been stuck on a stale fix).
    const far = (i: number) => geo(2000 + i * 10, 0);
    let out = f.push({ t: 5000, ...far(0), accuracy: 5 });
    for (let i = 1; i < GPS_FILTER_DEFAULTS.resetAfterRejects; i++) {
      expect(out.accepted).toBe(false);
      out = f.push({ t: (5 + i) * 1000, ...far(i), accuracy: 5 });
    }
    // The Nth persistent "outlier" re-anchors the filter.
    expect(out.accepted).toBe(true);
    expect(out.reset).toBe(true);
    const truth = far(GPS_FILTER_DEFAULTS.resetAfterRejects - 1);
    expect(distM(out.lat!, out.lng!, truth.lat, truth.lng)).toBeLessThan(1);
    expect(f.stats().resets).toBe(1);

    // Tracking continues normally at the new location.
    const next = f.push({ t: 10_000, ...far(5), accuracy: 5 });
    expect(next.accepted).toBe(true);
  });

  it('accuracy rejects do NOT trigger a re-anchor', () => {
    const f = new GpsFilter();
    f.push({ t: 0, ...geo(0, 0), accuracy: 5 });
    for (let i = 1; i <= GPS_FILTER_DEFAULTS.resetAfterRejects + 2; i++) {
      const out = f.push({ t: i * 1000, ...geo(1000, 1000), accuracy: 120 });
      expect(out.accepted).toBe(false);
      expect(out.reason).toBe('acc');
    }
    expect(f.stats().resets).toBe(0);
  });

  it('counts accepted samples in stats', () => {
    const f = new GpsFilter();
    for (let i = 0; i < 4; i++) f.push({ t: i * 1000, ...geo(i * 10, 0), accuracy: 5 });
    expect(f.stats().accepted).toBe(4);
  });
});
