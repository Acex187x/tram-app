/// <reference types="jest" />
//
// parseBundle — the one-time decode. Two jobs: pack the wire into typed arrays
// so the frame path never touches JSON, and refuse to let a malformed payload
// become a confidently-wrong fleet.

import { EMPTY_TRACK, MAX_KNOTS, packTrack, parseBundle } from '@/lib/physics/bundle';
import { evalTrajectory } from '@/lib/physics/evaluator';
import { T0, v1ToV2, wireBundle, wireTrack, wireVehicle } from './physicsFixtures';

describe('packTrack', () => {
  it('interleaves [t,s,…] into a Float64Array', () => {
    const packed = packTrack([
      { t: 1, s: 10 },
      { t: 2, s: 20 },
    ]);
    expect(packed).toBeInstanceOf(Float64Array);
    expect(Array.from(packed)).toEqual([1, 10, 2, 20]);
  });

  it('drops non-finite knots rather than poisoning the curve', () => {
    const packed = packTrack([
      { t: 1, s: 10 },
      { t: NaN, s: 20 },
      { t: 3, s: Infinity },
      { t: 4, s: 40 },
    ]);
    expect(Array.from(packed)).toEqual([1, 10, 4, 40]);
  });

  it('drops knots whose time does not strictly advance (binary-search invariant)', () => {
    const packed = packTrack([
      { t: 1, s: 10 },
      { t: 1, s: 15 }, // duplicate stamp
      { t: 0, s: 5 }, // backwards
      { t: 2, s: 20 },
    ]);
    expect(Array.from(packed)).toEqual([1, 10, 2, 20]);
  });

  it('caps at the protocol maximum of 24 knots', () => {
    const packed = packTrack(wireTrack(0, 0, 10, 40));
    expect(packed.length / 2).toBe(MAX_KNOTS);
  });

  it('returns the shared empty track for empty/garbage input', () => {
    expect(packTrack([])).toBe(EMPTY_TRACK);
    expect(packTrack(null)).toBe(EMPTY_TRACK);
    expect(packTrack('nope')).toBe(EMPTY_TRACK);
    expect(packTrack([{ t: NaN, s: NaN }])).toBe(EMPTY_TRACK);
  });

  it('takes s verbatim — a non-monotone server curve is NOT silently repaired', () => {
    // Masking it here would hide exactly the regression the smooth↔fixed delta
    // exists to expose.
    const packed = packTrack([
      { t: 1, s: 100 },
      { t: 2, s: 90 },
    ]);
    expect(Array.from(packed)).toEqual([1, 100, 2, 90]);
  });
});

describe('parseBundle', () => {
  it('decodes a well-formed v2 body', () => {
    const parsed = parseBundle(wireBundle(), T0 + 120);
    expect(parsed).not.toBeNull();
    expect(parsed!.protocolVersion).toBe(2);
    expect(parsed!.serverNowMs).toBe(T0);
    expect(parsed!.atMs).toBe(T0);
    expect(parsed!.horizonS).toBe(120);
    expect(parsed!.receivedAtMs).toBe(T0 + 120);
    expect(parsed!.vehicles.size).toBe(1);

    const v = parsed!.vehicles.get('9201')!;
    expect(v.tripId).toBe('trip-test');
    expect(v.line).toBe('9');
    expect(v.discontinuity).toBe(false);
    expect(v.emittedAtMs).toBe(T0);
    expect(v.anchorMs).toBe(T0 - 8_000);
    // Both curves are usable typed arrays, and they differ (opinion 1000 m,
    // smooth 990 m at emission) — that gap IS the comparison metric.
    expect(evalTrajectory(v.opinion, T0)).toBe(1_000);
    expect(evalTrajectory(v.smooth, T0)).toBe(990);
  });

  it('rejects a body with no server clock — the whole point of the protocol', () => {
    expect(parseBundle({ vehicles: [] }, T0)).toBeNull();
    expect(parseBundle({ serverNowMs: 'soon', vehicles: [] }, T0)).toBeNull();
  });

  it('rejects a body that is not a bundle at all', () => {
    expect(parseBundle(null, T0)).toBeNull();
    expect(parseBundle('offline', T0)).toBeNull();
    expect(parseBundle({ serverNowMs: T0 }, T0)).toBeNull(); // no vehicles array
  });

  it('falls back to serverNowMs when atMs is missing', () => {
    const parsed = parseBundle({ serverNowMs: T0, vehicles: [] }, T0)!;
    expect(parsed.atMs).toBe(T0);
    expect(parsed.horizonS).toBe(0);
  });

  it('drops individual malformed vehicles, keeping the rest of the fleet', () => {
    const parsed = parseBundle(
      wireBundle({
        vehicles: [
          wireVehicle({ key: '9201' }),
          { ...wireVehicle({ key: '' }) }, // no key
          { ...wireVehicle({ key: '9300' }), tripId: 42 } as never, // bad trip
          { ...wireVehicle({ key: '9400' }), opinion: [], smooth: [] }, // no curves
          wireVehicle({ key: '9500' }),
        ],
      }),
      T0,
    )!;
    expect([...parsed.vehicles.keys()].sort()).toEqual(['9201', '9500']);
  });

  it('keeps a vehicle that has only one of the two curves', () => {
    const parsed = parseBundle(
      wireBundle({ vehicles: [wireVehicle({ smooth: [] })] }),
      T0,
    )!;
    const v = parsed.vehicles.get('9201')!;
    expect(v.smooth.length).toBe(0);
    expect(v.opinion.length).toBeGreaterThan(0);
  });

  it('carries the discontinuity flag through', () => {
    const parsed = parseBundle(
      wireBundle({ vehicles: [wireVehicle({ discontinuity: true })] }),
      T0,
    )!;
    expect(parsed.vehicles.get('9201')!.discontinuity).toBe(true);
  });

  it('removed vehicles simply vanish from the map (clients drop them)', () => {
    const first = parseBundle(
      wireBundle({ vehicles: [wireVehicle({ key: 'a' }), wireVehicle({ key: 'b' })] }),
      T0,
    )!;
    const second = parseBundle(wireBundle({ vehicles: [wireVehicle({ key: 'a' })] }), T0)!;
    expect(first.vehicles.has('b')).toBe(true);
    expect(second.vehicles.has('b')).toBe(false);
  });
});

// The compat shim exists only so the client can be smoke-tested against the v1
// payload shape while v2 is built in parallel. These assertions document what
// it CANNOT give us — which is why it never ships.
describe('v1 compat shim (tests only)', () => {
  it('produces a parseable bundle from a v1 body', () => {
    const parsed = parseBundle(
      v1ToV2(
        { vehicles: [{ key: '9201', tripId: 'trip-test', points: wireTrack(T0, 1_000, 10, 13) }] },
        T0,
      ),
      T0,
    )!;
    expect(parsed.vehicles.size).toBe(1);
    expect(evalTrajectory(parsed.vehicles.get('9201')!.smooth, T0 + 10_000)).toBeCloseTo(1_100, 6);
  });

  it('cannot distinguish smooth from fixed — both curves are the same series', () => {
    const parsed = parseBundle(
      v1ToV2(
        { vehicles: [{ key: '9201', tripId: 'trip-test', points: wireTrack(T0, 1_000, 10, 13) }] },
        T0,
      ),
      T0,
    )!;
    const v = parsed.vehicles.get('9201')!;
    expect(Array.from(v.smooth)).toEqual(Array.from(v.opinion));
  });
});
