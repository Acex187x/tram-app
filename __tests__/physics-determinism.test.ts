/// <reference types="jest" />
//
// DETERMINISM ACROSS USERS (physics-v3-protocol goal #3, the owner's headline
// requirement): "two clients with the same physics version render
// pixel-identical trams at the same instant, regardless of when they
// opened/backgrounded the app."
//
// This suite builds several independent "clients" — separate TrajectoryStore +
// TramFleet pairs, with different device clocks, different join times and
// different fetch histories — and asserts they produce byte-identical rendered
// state for the same bundle at the same real-world instant.
//
// The three mechanisms that make it true are each exercised here:
//   (a) the client evaluator is STATELESS (nothing accumulates, so no client
//       can drift away from another);
//   (b) the curves are anchored to SERVER timestamps;
//   (c) every client corrects its own clock against `serverNowMs`.

import { getModelSpec, regNumberToModelId } from '@/lib/fleet/registry';
import { evalTrajectory } from '@/lib/physics/evaluator';
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import type { TramSnapshot } from '@/lib/types';
import { T0, snapshot, straightGeometry, wireBundle, wireVehicle } from './physicsFixtures';

const GEO = straightGeometry([
  { distM: 0, name: 'A' },
  { distM: 1_500, name: 'B' },
  { distM: 3_000, name: 'C', isTerminal: true },
]);

/**
 * One simulated client. `clockSkewMs` is how wrong its device clock is: its
 * Date.now() reads REAL time + skew.
 */
function makeClient(clockSkewMs: number) {
  const trajectories = new TrajectoryStore();
  const fleet = new TramFleet({
    resolveModel: (s: TramSnapshot) => getModelSpec(regNumberToModelId(s.registrationNumber)),
    trajectories,
  });
  fleet.ingest([snapshot()], () => GEO);
  return {
    trajectories,
    fleet,
    /** Deliver a bundle to this client at a REAL instant. */
    receive(body: unknown, realMs: number) {
      trajectories.ingest(body, realMs + clockSkewMs);
    },
    /** Render at a REAL instant (the device reads its own skewed clock). */
    render(realMs: number, mode: 'smooth' | 'fixed' = 'smooth') {
      return fleet.getState('9201', realMs + clockSkewMs, mode)!;
    },
  };
}

const BUNDLE = wireBundle({
  serverNowMs: T0,
  atMs: T0,
  vehicles: [wireVehicle({ emittedAtMs: T0 })],
});

describe('two devices with different clocks render identically', () => {
  it('a phone 8 s fast and a phone 45 s slow agree exactly', () => {
    const fast = makeClient(8_000);
    const slow = makeClient(-45_000);

    fast.receive(BUNDLE, T0);
    slow.receive(BUNDLE, T0);

    for (const dt of [0, 1_000, 17_500, 60_000, 119_000]) {
      const a = fast.render(T0 + dt);
      const b = slow.render(T0 + dt);
      expect(a.simDistM).toBe(b.simDistM);
      expect(a.position).toEqual(b.position);
      expect(a.bearing).toBe(b.bearing);
      expect(a.simSpeedKmh).toBe(b.simSpeedKmh);
      expect(a.nextStopName).toBe(b.nextStopName);
      expect(a.nextStopEtaS).toBe(b.nextStopEtaS);
      expect(a.deviationM).toBe(b.deviationM);
      expect(a.pastHorizon).toBe(b.pastHorizon);
    }
  });

  it('an UNCORRECTED clock would have been visibly wrong — the sync is load-bearing', () => {
    // A device running 45 s FAST. With the correction it draws the tram where
    // everyone else does; without it, it would read 45 s further along the
    // curve — at 10 m/s that is 450 m of tram, half a dozen city blocks.
    const SKEW = 45_000;
    const fastPhone = makeClient(SKEW);
    fastPhone.receive(BUNDLE, T0);

    const realMs = T0 + 10_000;
    const corrected = fastPhone.render(realMs).simDistM;
    expect(corrected).toBeCloseTo(1_090, 6); // smooth curve: 990 m + 10 s × 10 m/s

    const curve = fastPhone.trajectories.getVehicle('9201')!.smooth;
    const uncorrected = evalTrajectory(curve, realMs + SKEW); // its raw clock
    expect(uncorrected - corrected).toBeCloseTo((SKEW / 1_000) * 10, 6);
  });
});

describe('different join times, same picture', () => {
  it('a client that has fetched three times matches one that just joined', () => {
    const veteran = makeClient(3_000);
    // Three earlier fetches (the clock EWMA has a full window of samples).
    veteran.receive(wireBundle({ serverNowMs: T0 - 10_000, atMs: T0 - 10_000 }), T0 - 10_000);
    veteran.receive(wireBundle({ serverNowMs: T0 - 5_000, atMs: T0 - 5_000 }), T0 - 5_000);
    veteran.receive(BUNDLE, T0);

    // A brand-new client whose very first fetch is the same bundle.
    const joiner = makeClient(-2_500);
    joiner.receive(BUNDLE, T0);

    for (const dt of [0, 500, 30_000, 90_000]) {
      expect(veteran.render(T0 + dt).simDistM).toBe(joiner.render(T0 + dt).simDistM);
      expect(veteran.render(T0 + dt).position).toEqual(joiner.render(T0 + dt).position);
    }
  });

  it('a client that was BACKGROUNDED across the whole horizon needs no resync', () => {
    // The stateless evaluator has nothing to catch up: it is simply asked
    // about a later instant. This is the invariant that deleted
    // resyncAfterSuspension.
    const suspended = makeClient(0);
    const awake = makeClient(0);
    suspended.receive(BUNDLE, T0);
    awake.receive(BUNDLE, T0);

    // One client "renders" continuously; the other renders nothing for 100 s.
    for (let dt = 0; dt <= 100_000; dt += 1_000) awake.render(T0 + dt);

    expect(suspended.render(T0 + 100_000).simDistM).toBe(awake.render(T0 + 100_000).simDistM);
    expect(suspended.render(T0 + 100_000).position).toEqual(awake.render(T0 + 100_000).position);
  });

  it('render order and repetition never change the answer (no hidden state)', () => {
    const c = makeClient(1_234);
    c.receive(BUNDLE, T0);
    const forwards = [0, 10_000, 20_000, 30_000].map((dt) => c.render(T0 + dt).simDistM);
    const backwards = [30_000, 20_000, 10_000, 0].map((dt) => c.render(T0 + dt).simDistM).reverse();
    const repeated = [0, 10_000, 20_000, 30_000].map((dt) => c.render(T0 + dt).simDistM);
    expect(backwards).toEqual(forwards);
    expect(repeated).toEqual(forwards);
  });
});

describe('both render modes are deterministic', () => {
  it('the fixed (opinion) curve agrees across devices too', () => {
    const a = makeClient(12_000);
    const b = makeClient(-7_000);
    a.receive(BUNDLE, T0);
    b.receive(BUNDLE, T0);
    for (const dt of [0, 25_000, 75_000]) {
      expect(a.render(T0 + dt, 'fixed').simDistM).toBe(b.render(T0 + dt, 'fixed').simDistM);
    }
  });

  it('one device watching smooth and another watching fixed report the SAME delta', () => {
    // The comparison metric must not depend on which curve you happen to be
    // looking at — otherwise "smooth beats fixed" would be unmeasurable.
    const a = makeClient(4_000);
    const b = makeClient(-11_000);
    a.receive(BUNDLE, T0);
    b.receive(BUNDLE, T0);
    expect(a.render(T0 + 40_000, 'smooth').deviationM).toBe(
      b.render(T0 + 40_000, 'fixed').deviationM,
    );
  });

  it('a frozen fleet freezes identically everywhere', () => {
    const a = makeClient(30_000);
    const b = makeClient(-30_000);
    a.receive(BUNDLE, T0);
    b.receive(BUNDLE, T0);
    // Long past the 120 s horizon: both must be frozen at the same last point.
    const late = T0 + 15 * 60_000;
    expect(a.render(late).pastHorizon).toBe(true);
    expect(b.render(late).pastHorizon).toBe(true);
    expect(a.render(late).simDistM).toBe(b.render(late).simDistM);
    expect(a.trajectories.connection(late + 30_000)).toBe(
      b.trajectories.connection(late - 30_000),
    );
  });
});
