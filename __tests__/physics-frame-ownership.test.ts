import { getModelSpec } from '@/lib/fleet/registry';
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { pointAt } from '@/lib/geo/polyline';
import {
  T0,
  snapshot,
  straightGeometry,
  wireBundle,
  wireTrack,
  wireVehicle,
} from './physicsFixtures';

function client() {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec('15t'),
  });
  const geo = straightGeometry();
  fleet.ingest([snapshot()], () => geo);
  const emit = (at: number, s: number, speed = 10, discontinuity = false) =>
    store.ingest(
      wireBundle({
        serverNowMs: at,
        vehicles: [
          wireVehicle({
            emittedAtMs: at,
            anchorMs: at,
            smooth: wireTrack(at, s, speed, 13),
            opinion: wireTrack(at, s, speed, 13),
            discontinuity,
          }),
        ],
      }),
      at,
    );
  emit(T0, 1000);
  const frame = (at: number) => fleet.getStates(at, 'smooth', true)[0];
  return { store, fleet, geo, emit, frame };
}

it('UI, diagnostics, calibration and future probes cannot change the next map frame', () => {
  const baseline = client();
  const inspected = client();
  baseline.frame(T0);
  inspected.frame(T0);
  baseline.emit(T0 + 1000, 900);
  inspected.emit(T0 + 1000, 900);
  // The previous getter advanced the guard into the future, after which the
  // real next frame bypassed the guard as an out-of-order instant.
  inspected.fleet.getState('9201', T0 + 4000);
  inspected.fleet.getStates(T0 + 4500);
  inspected.fleet.getDiagnostics('9201', T0 + 4900);
  expect(inspected.frame(T0 + 1033)).toEqual(baseline.frame(T0 + 1033));
});

it('same-instant readers see the same guarded frame instead of the raw target', () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 800);
  const drawn = c.frame(T0 + 1000);
  expect(drawn.simDistM).toBe(1000);
  expect(c.fleet.getState('9201', T0 + 1000)?.simDistM).toBe(drawn.simDistM);
  expect(c.fleet.getDiagnostics('9201', T0 + 1000)?.simSpeedKmh).toBe(0);
});

it.each([10, 30, 60])(
  'a correction never drives backwards at %i frames/s and reports the real hold',
  (fps) => {
    const c = client();
    c.frame(T0);
    c.emit(T0 + 1000, 950);
    for (let i = 1; i <= fps * 3; i++) {
      const state = c.frame(T0 + 1000 + (i * 1000) / fps);
      expect(state.simDistM).toBe(1000);
      expect(state.simSpeedKmh).toBe(0);
    }
    // The hold ends when the server's advancing target reaches the marker.
    expect(c.frame(T0 + 6500).simDistM).toBeGreaterThan(1000);
  },
);

it('read-only probes do not consume a server-sanctioned discontinuity', () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 700, 10, true);
  c.fleet.getDiagnostics('9201', T0 + 1000);
  expect(c.frame(T0 + 1033).simDistM).toBeCloseTo(700.33, 2);
});

it('geometry replacement resets the presentation limit rather than mixing distance axes', () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 700);
  c.fleet.ingest([snapshot()], () => ({
    ...c.geo,
    shapeId: 'authoritative-shape',
  }));
  expect(c.frame(T0 + 1033).simDistM).toBeCloseTo(700.33, 2);
});

it('viewport culling uses the guarded location when the target moved outside the viewport', () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 100);
  const [lng, lat] = pointAt(c.geo.coordinates, c.geo.cumDistM, 1000);
  const states = c.fleet.getStatesInBounds(
    T0 + 1033,
    [lng - 0.0001, lat - 0.0001, lng + 0.0001, lat + 0.0001],
    null,
    null,
  );
  expect(states).toHaveLength(1);
  expect(states[0].simDistM).toBe(1000);
});

it('viewport culling includes the no-curve fallback at its moving position', () => {
  const c = client();
  c.store.ingest(wireBundle({ serverNowMs: T0, vehicles: [] }), T0);
  c.fleet.ingest([snapshot({ shapeDistM: 1000, observedAtMs: T0 })], () => c.geo);
  c.fleet.ingest([snapshot({ shapeDistM: 1100, observedAtMs: T0 + 10000 })], () => c.geo);
  const [lng, lat] = pointAt(c.geo.coordinates, c.geo.cumDistM, 1400);
  const states = c.fleet.getStatesInBounds(
    T0 + 40000,
    [lng - 0.0001, lat - 0.0001, lng + 0.0001, lat + 0.0001],
    null,
    null,
  );
  expect(states).toHaveLength(1);
  expect(states[0].simDistM).toBe(1400);
});

it('2-second fix updates learn a fallback pace rather than resetting the 4-second baseline forever', () => {
  const c = client();
  c.store.ingest(wireBundle({ serverNowMs: T0, vehicles: [] }), T0);
  c.fleet.ingest([snapshot({ shapeDistM: 1000, observedAtMs: T0 })], () => c.geo);
  for (let t = 2000; t <= 12000; t += 2000) {
    c.fleet.ingest([snapshot({ shapeDistM: 1000 + t / 100, observedAtMs: T0 + t })], () => c.geo);
  }
  expect(c.fleet.getState('9201', T0 + 13000)?.simSpeedKmh).toBe(36);
  expect(c.fleet.getState('9201', T0 + 13000)?.simDistM).toBe(1130);
});

it('a confirmed stop clears the no-curve fallback pace', () => {
  const c = client();
  c.store.ingest(wireBundle({ serverNowMs: T0, vehicles: [] }), T0);
  c.fleet.ingest([snapshot({ shapeDistM: 1000, observedAtMs: T0 })], () => c.geo);
  c.fleet.ingest(
    [
      snapshot({
        shapeDistM: 1100,
        observedAtMs: T0 + 10000,
        statePosition: 'at_stop',
      }),
    ],
    () => c.geo,
  );
  expect(c.fleet.getState('9201', T0 + 15000)?.simDistM).toBe(1100);
});

it('a delayed same-trip fix cannot rewind the newest observation or fallback pace', () => {
  const c = client();
  c.fleet.ingest([snapshot({ shapeDistM: 1100, observedAtMs: T0 + 10000 })], () => c.geo);
  c.fleet.ingest([snapshot({ shapeDistM: 1000, observedAtMs: T0 })], () => c.geo);
  expect(c.fleet.getSnapshot('9201')?.shapeDistM).toBe(1100);
});

it.each([10, 30, 60])(
  'forward catch-up launches continuously at %i Hz despite UI probes',
  (fps) => {
    const a = client();
    const b = client();
    for (const c of [a, b]) {
      c.emit(T0, 1000, 0);
      c.frame(T0);
      c.emit(T0 + 1, 1100, 10);
    }
    let previousSpeed = 0;
    let previousS = 1000;
    let previousAt = T0;
    for (let i = 1; i <= fps * 8; i++) {
      const at = T0 + (i * 1000) / fps;
      b.fleet.getState('9201', at + 4000);
      b.fleet.getDiagnostics('9201', at + 4500);
      const actual = a.frame(at);
      expect(b.frame(at)).toEqual(actual);
      const dt = (at - previousAt) / 1000;
      const speed = (actual.simDistM - previousS) / dt;
      expect(speed).toBeGreaterThanOrEqual(0);
      expect(speed - previousSpeed).toBeLessThanOrEqual(2.5 * dt + 0.000001);
      expect(actual.simSpeedKmh / 3.6).toBeCloseTo(speed, 3);
      expect(actual.simDistM).toBeLessThanOrEqual(a.fleet.getState('9201', at, 'fixed')!.simDistM);
      previousS = actual.simDistM;
      previousAt = at;
      previousSpeed = speed;
    }
    expect(previousS).toBeGreaterThan(1060);
  },
);

it('a target revised behind a moving marker stops without inventing braking overshoot, then resumes', () => {
  const c = client();
  let drawn = c.frame(T0);
  for (let i = 1; i <= 30; i++) drawn = c.frame(T0 + (i * 1000) / 30);
  const stoppedAt = drawn.simDistM;
  c.emit(T0 + 1000, stoppedAt - 20, 0);
  for (let i = 1; i <= 90; i++) {
    const state = c.frame(T0 + 1000 + (i * 1000) / 30);
    expect(state.simDistM).toBe(stoppedAt);
    expect(state.simSpeedKmh).toBe(0);
  }
  c.emit(T0 + 4000, stoppedAt + 10, 10);
  const resumed = c.frame(T0 + 4033);
  expect(resumed.simDistM).toBeGreaterThan(stoppedAt);
  expect(resumed.simSpeedKmh / 3.6).toBeLessThan(0.1);
});

it('a long resume initializes at the current target, independently of an old held velocity', () => {
  const resumed = client();
  resumed.emit(T0, 1000, 0);
  resumed.frame(T0);
  resumed.emit(T0 + 1000, 1100, 10);
  const joined = client();
  joined.emit(T0 + 1000, 1100, 10);
  expect(resumed.frame(T0 + 10000).simDistM).toBe(joined.frame(T0 + 10000).simDistM);
});

it('a new trip initializes on its own axis and does not inherit catch-up speed', () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 900, 0);
  c.frame(T0 + 1000);
  c.fleet.ingest(
    [snapshot({ tripId: 'return-trip', shapeDistM: 300, observedAtMs: T0 + 2000 })],
    () => ({ ...c.geo, tripId: 'return-trip' }),
  );
  c.store.ingest(
    wireBundle({
      serverNowMs: T0 + 2000,
      vehicles: [
        wireVehicle({
          tripId: 'return-trip',
          anchorMs: T0 + 2000,
          emittedAtMs: T0 + 2000,
          smooth: wireTrack(T0 + 2000, 300, 10, 13),
        }),
      ],
    }),
    T0 + 2000,
  );
  expect(c.frame(T0 + 2033).simDistM).toBeCloseTo(300.33, 2);
});

it.each([10, 30, 60])('clock correction cannot change the catch-up interval at %i Hz', (fps) => {
  const c = client();
  let previous = c.frame(T0),
    previousAt = T0,
    previousSpeed = 10;
  for (let i = 1; i <= fps * 8; i++) {
    const at = T0 + (i * 1000) / fps;
    if (i === fps) c.store.noteConvexClock(at + 150, at - 200, at);
    c.fleet.getDiagnostics('9201', at + 3000);
    const state = c.frame(at);
    const dt = (at - previousAt) / 1000;
    const speed = (state.simDistM - previous.simDistM) / dt;
    expect(speed - previousSpeed).toBeLessThanOrEqual(2.5 * dt + 1e-6);
    expect(state.simSpeedKmh / 3.6).toBeCloseTo(speed, 5);
    previous = state;
    previousAt = at;
    previousSpeed = speed;
  }
});
