import { getModelSpec } from "@/lib/fleet/registry";
import { TramFleet } from "@/lib/physics/fleet";
import { TrajectoryStore } from "@/lib/physics/trajectoryStore";
import { pointAt } from "@/lib/geo/polyline";
import {
  T0,
  snapshot,
  straightGeometry,
  wireBundle,
  wireTrack,
  wireVehicle,
} from "./physicsFixtures";

function client() {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
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
  const frame = (at: number) => fleet.getStates(at, "smooth", true)[0];
  return { store, fleet, geo, emit, frame };
}

it("UI, diagnostics, calibration and future probes cannot change the next map frame", () => {
  const baseline = client();
  const inspected = client();
  baseline.frame(T0);
  inspected.frame(T0);
  baseline.emit(T0 + 1000, 900);
  inspected.emit(T0 + 1000, 900);
  // The previous getter advanced the guard into the future, after which the
  // real next frame bypassed the guard as an out-of-order instant.
  inspected.fleet.getState("9201", T0 + 4000);
  inspected.fleet.getStates(T0 + 4500);
  inspected.fleet.getDiagnostics("9201", T0 + 4900);
  expect(inspected.frame(T0 + 1033)).toEqual(baseline.frame(T0 + 1033));
});

it("same-instant readers see the same guarded frame instead of the raw target", () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 800);
  const drawn = c.frame(T0 + 1000);
  expect(drawn.simDistM).toBeGreaterThanOrEqual(1000);
  expect(c.fleet.getState("9201", T0 + 1000)?.simDistM).toBe(drawn.simDistM);
  expect(c.fleet.getDiagnostics("9201", T0 + 1000)?.simSpeedKmh).toBe(
    drawn.simSpeedKmh,
  );
});

it.each([10, 30, 60])(
  "a behind-target correction brakes continuously at %i Hz",
  (fps) => {
    const c = client();
    let previous = c.frame(T0);
    // A small jump back (closable: display ends < 60 m ahead) brakes and holds.
    c.emit(T0 + 1, 985, 0);
    // Tram service brake (1.4 m/s², 0.8 m/s³): 10 m/s needs ~9 s to stop.
    for (let i = 1; i <= fps * 10; i++) {
      const state = c.frame(T0 + (i * 1000) / fps);
      expect(state.simDistM).toBeGreaterThanOrEqual(previous.simDistM);
      expect(
        Math.abs(state.simSpeedKmh - previous.simSpeedKmh) / 3.6,
      ).toBeLessThanOrEqual(1.4 / fps + 1e-6);
      previous = state;
    }
    expect(previous.simSpeedKmh).toBeLessThan(0.01);
    const held = previous.simDistM;
    c.emit(T0 + 10000, held + 30, 10);
    expect(c.frame(T0 + 10100).simDistM).toBeGreaterThan(held);
  },
);

it("a server discontinuity never licenses a fully visible same-axis reset", () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 700, 10, true);
  c.fleet.getDiagnostics("9201", T0 + 1000);
  expect(c.frame(T0 + 1033).simDistM).toBeGreaterThanOrEqual(1000);
});

it("equivalent geometry replacement preserves presentation despite new object identity", () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 700);
  c.fleet.ingest([snapshot()], () => ({
    ...c.geo,
    shapeId: "authoritative-shape",
  }));
  expect(c.frame(T0 + 1033).simDistM).toBeGreaterThanOrEqual(1000);
  expect(c.fleet.hasPresentationTransitions()).toBe(false);
});

it("viewport culling uses the guarded location when the target moved outside the viewport", () => {
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
  expect(states[0].simDistM).toBeGreaterThanOrEqual(1000);
});

it("viewport culling includes the no-curve fallback at its moving position", () => {
  const c = client();
  c.store.ingest(wireBundle({ serverNowMs: T0, vehicles: [] }), T0);
  c.fleet.ingest(
    [snapshot({ shapeDistM: 1000, observedAtMs: T0 })],
    () => c.geo,
  );
  c.fleet.ingest(
    [snapshot({ shapeDistM: 1100, observedAtMs: T0 + 10000 })],
    () => c.geo,
  );
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

it("2-second fix updates learn a fallback pace rather than resetting the 4-second baseline forever", () => {
  const c = client();
  c.store.ingest(wireBundle({ serverNowMs: T0, vehicles: [] }), T0);
  c.fleet.ingest(
    [snapshot({ shapeDistM: 1000, observedAtMs: T0 })],
    () => c.geo,
  );
  for (let t = 2000; t <= 12000; t += 2000) {
    c.fleet.ingest(
      [snapshot({ shapeDistM: 1000 + t / 100, observedAtMs: T0 + t })],
      () => c.geo,
    );
  }
  expect(c.fleet.getState("9201", T0 + 13000)?.simSpeedKmh).toBe(36);
  expect(c.fleet.getState("9201", T0 + 13000)?.simDistM).toBe(1130);
});

it("a source at_stop anchor announcement does not clear a moving fallback pace", () => {
  const c = client();
  c.store.ingest(wireBundle({ serverNowMs: T0, vehicles: [] }), T0);
  c.fleet.ingest(
    [snapshot({ shapeDistM: 1000, observedAtMs: T0 })],
    () => c.geo,
  );
  c.fleet.ingest(
    [
      snapshot({
        shapeDistM: 1100,
        observedAtMs: T0 + 10000,
        statePosition: "at_stop",
      }),
    ],
    () => c.geo,
  );
  expect(c.fleet.getState("9201", T0 + 15000)?.simDistM).toBe(1150);
});

it("a delayed same-trip fix cannot rewind the newest observation or fallback pace", () => {
  const c = client();
  c.fleet.ingest(
    [snapshot({ shapeDistM: 1100, observedAtMs: T0 + 10000 })],
    () => c.geo,
  );
  c.fleet.ingest(
    [snapshot({ shapeDistM: 1000, observedAtMs: T0 })],
    () => c.geo,
  );
  expect(c.fleet.getSnapshot("9201")?.shapeDistM).toBe(1100);
});

it("counts explicit user mode changes separately from automatic continuity corrections", () => {
  const c = client();
  c.frame(T0);
  c.fleet.setMode("fixed");
  c.fleet.setMode("fixed");
  c.fleet.setMode("smooth");
  expect(c.fleet.getDiagnostics("9201", T0)?.presentationModeChanges).toBe(2);
  expect(c.fleet.hasPresentationTransitions()).toBe(false);
});

it.each([10, 30, 60])(
  "forward catch-up launches continuously at %i Hz despite UI probes",
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
      b.fleet.getState("9201", at + 4000);
      b.fleet.getDiagnostics("9201", at + 4500);
      const actual = a.frame(at);
      expect(b.frame(at)).toEqual(actual);
      const dt = (at - previousAt) / 1000;
      const speed = (actual.simDistM - previousS) / dt;
      expect(speed).toBeGreaterThanOrEqual(0);
      // Tram traction envelope: 1.3 m/s² (jerk-limited launch).
      expect(speed - previousSpeed).toBeLessThanOrEqual(1.3 * dt + 0.000001);
      expect(Math.abs(actual.simSpeedKmh / 3.6 - speed)).toBeLessThanOrEqual(
        1.3 * dt + 1e-6,
      );
      expect(actual.simDistM).toBeLessThanOrEqual(
        a.fleet.getState("9201", at, "fixed")!.simDistM,
      );
      previousS = actual.simDistM;
      previousAt = at;
      previousSpeed = speed;
    }
    // 8 s from rest at 1.3 m/s² with a 0.8 m/s³ ramp covers ~34 m.
    expect(previousS).toBeGreaterThan(1030);
  },
);


it("a target far behind a display it cannot meet fades and rebases instead of standing mid-route", () => {
  const c = client();
  c.frame(T0);
  // Display runs at 10 m/s; the server now says the tram is standing 100 m back.
  c.emit(T0 + 1, 900, 0);
  const reasons = new Set<string | null | undefined>();
  let last = c.frame(T0 + 33);
  for (let at = T0 + 66; at <= T0 + 6000; at += 33) {
    if (last.presentationHiddenFrameId !== undefined)
      c.fleet.acknowledgePresentationHidden("9201", last.presentationHiddenFrameId);
    last = c.frame(at);
    reasons.add(last.presentationTransitionReason);
  }
  expect(reasons.has("unreachable-correction")).toBe(true);
  expect(last.presentationOpacity).toBe(1);
  expect(Math.abs(last.simDistM - 900)).toBeLessThan(1);
});

it("a target far ahead is faded onto, not raced at line speed", () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1, 1600, 10);
  let maxSpeed = 0;
  let last = c.frame(T0 + 33);
  for (let at = T0 + 66; at <= T0 + 6000; at += 33) {
    if (last.presentationHiddenFrameId !== undefined)
      c.fleet.acknowledgePresentationHidden("9201", last.presentationHiddenFrameId);
    last = c.frame(at);
    if (last.presentationOpacity === 1) maxSpeed = Math.max(maxSpeed, last.simSpeedKmh / 3.6);
  }
  expect(c.fleet.getDiagnostics("9201", T0 + 6000)?.presentationRebaseCount).toBe(1);
  expect(maxSpeed).toBeLessThan(19.6);
  expect(Math.abs(last.simDistM - (1600 + 10 * 6))).toBeLessThan(5);
});

it("a long resume stays on the old point until TWO native zero-frame acknowledgements", () => {
  const c = client();
  c.emit(T0, 1000, 0);
  c.frame(T0);
  c.emit(T0 + 1000, 1100, 10);
  const first = c.frame(T0 + 10000);
  expect(first.simDistM).toBe(1000);
  expect(first.presentationTransitionReason).toBe("resume-gap");
  const zero = c.frame(T0 + 10300);
  expect(zero.presentationOpacity).toBe(0);
  expect(zero.presentationHiddenFrameId).toBeDefined();
  c.fleet.getState("9201", T0 + 20000); // a future read cannot consume hidden phase
  expect(c.frame(T0 + 10400).simDistM).toBe(1000);
  c.fleet.acknowledgePresentationHidden(
    "9201",
    zero.presentationHiddenFrameId!,
  );
  const rebased = c.frame(T0 + 10433);
  expect(rebased.simDistM).toBeGreaterThan(1100);
  expect(rebased.presentationOpacity).toBe(0);
  expect(rebased.presentationHiddenFrameId).not.toBe(
    zero.presentationHiddenFrameId,
  );
  c.fleet.acknowledgePresentationHidden(
    "9201",
    zero.presentationHiddenFrameId!,
  ); // stale token
  expect(c.frame(T0 + 10500).presentationOpacity).toBe(0);
  c.fleet.acknowledgePresentationHidden(
    "9201",
    rebased.presentationHiddenFrameId!,
  );
  c.frame(T0 + 10533);
  expect(c.frame(T0 + 11000).presentationOpacity).toBe(1);
  expect(
    c.fleet.getDiagnostics("9201", T0 + 11000)?.presentationRebaseCount,
  ).toBe(1);
});

it("a new trip begins an explicit transition retaining the old displayed geometry", () => {
  const c = client();
  c.frame(T0);
  c.emit(T0 + 1000, 900, 0);
  c.frame(T0 + 1000);
  c.fleet.ingest(
    [
      snapshot({
        tripId: "return-trip",
        shapeDistM: 300,
        observedAtMs: T0 + 2000,
      }),
    ],
    () => ({ ...c.geo, tripId: "return-trip" }),
  );
  c.store.ingest(
    wireBundle({
      serverNowMs: T0 + 2000,
      vehicles: [
        wireVehicle({
          tripId: "return-trip",
          anchorMs: T0 + 2000,
          emittedAtMs: T0 + 2000,
          smooth: wireTrack(T0 + 2000, 300, 10, 13),
        }),
      ],
    }),
    T0 + 2000,
  );
  const state = c.frame(T0 + 2033);
  expect(state.simDistM).toBeGreaterThan(1000);
  expect(state.presentationTransitionReason).toBe("trip-change");
  expect(state.presentationCorrectionComparable).toBe(false);
  expect(c.fleet.getGeometry("9201")).toBe(c.geo);
});

it.each([10, 30, 60])(
  "clock correction cannot change the catch-up interval at %i Hz",
  (fps) => {
    const c = client();
    let previous = c.frame(T0),
      previousAt = T0,
      previousSpeed = 10;
    for (let i = 1; i <= fps * 8; i++) {
      const at = T0 + (i * 1000) / fps;
      if (i === fps) c.store.noteConvexClock(at + 150, at - 200, at);
      c.fleet.getDiagnostics("9201", at + 3000);
      const state = c.frame(at);
      const dt = (at - previousAt) / 1000;
      const speed = (state.simDistM - previous.simDistM) / dt;
      expect(speed - previousSpeed).toBeLessThanOrEqual(2.5 * dt + 1e-6);
      expect(Math.abs(state.simSpeedKmh / 3.6 - speed)).toBeLessThanOrEqual(
        2.5 * dt + 1e-6,
      );
      previous = state;
      previousAt = at;
      previousSpeed = speed;
    }
  },
);
