import {
  advanceWorld,
  initialWorld,
  worldPosition,
  worldDelta,
  offsetPosition,
  createAlignment,
  alignmentAt,
} from "@/lib/physics/worldPresentation";
import { advancePresentation } from "@/lib/physics/presentation";
import { TramFleet } from "@/lib/physics/fleet";
import { TrajectoryStore } from "@/lib/physics/trajectoryStore";
import { getModelSpec } from "@/lib/fleet/registry";
import { pointAt, cumulativeDistances } from "@/lib/geo/polyline";
import { T0, snapshot, straightGeometry, wireBundle } from "./physicsFixtures";

it.each([10, 30, 60])(
  "raw GPS retargets preserve signed world PVA and vector bounds at %iHz",
  (fps) => {
    const w = initialWorld([14.4, 50]);
    let prior = { ...w };
    const dt = 1 / fps;
    for (let i = 0; i < fps * 80; i++) {
      const target: [number, number] =
        i < fps * 20
          ? [14.406, 50.003]
          : i < fps * 45
            ? [14.397, 50.004]
            : [14.401, 49.999];
      advanceWorld(w, target, dt);
      expect(Math.hypot(w.vx, w.vy)).toBeLessThanOrEqual(25.000001);
      expect(Math.hypot(w.ax, w.ay)).toBeLessThanOrEqual(2.500001);
      expect(
        Math.hypot(w.ax - prior.ax, w.ay - prior.ay) / dt,
      ).toBeLessThanOrEqual(4.000001);
      expect(Math.hypot(w.x - prior.x, w.y - prior.y)).toBeLessThanOrEqual(
        25 * dt + 0.00001,
      );
      prior = { ...w };
    }
    expect(worldPosition(w).every(Number.isFinite)).toBe(true);
  },
);

it("a first-axis lateral residual is C2 and reserves the vector correction budget", () => {
  const a = createAlignment([0, 5], [0, 0.3], [0, 0], 6, 0, T0)!;
  expect(a).not.toBeNull();
  const p = { s: 0, v: 6, a: 0 };
  let oldA: [number, number] = [0, 0];
  expect(alignmentAt(a, T0)).toMatchObject({
    offset: [0, 5],
    velocity: [0, 0.3],
    acceleration: [0, 0],
  });
  for (let i = 1; i <= Math.ceil(a.durationS * 60); i++) {
    advancePresentation(p, 1 / 60, 200, 10, 0, null, a.limits);
    const r = alignmentAt(a, T0 + (i * 1000) / 60);
    expect(Math.hypot(p.v, r.velocity[1])).toBeLessThanOrEqual(25.00001);
    expect(Math.hypot(p.a, r.acceleration[1])).toBeLessThanOrEqual(2.50001);
    expect(
      Math.hypot(p.a - oldA[0], r.acceleration[1] - oldA[1]) * 60,
    ).toBeLessThanOrEqual(4.001);
    oldA = [p.a, r.acceleration[1]];
  }
  const end = alignmentAt(a, T0 + a.durationS * 1000);
  expect(Math.hypot(...end.offset)).toBeLessThan(1e-8);
  expect(Math.hypot(...end.velocity)).toBeLessThan(1e-8);
  expect(Math.hypot(...end.acceleration)).toBeLessThan(1e-8);
});

it("fresh raw GPS and first route adoption do not fade or seek to an ahead model", () => {
  const store = new TrajectoryStore();
  store.ingest(wireBundle(), T0);
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const g = straightGeometry([
    { stopId: "current", sequence: 1, distM: 900 },
    { stopId: "next", sequence: 2, distM: 1500 },
  ]);
  const pos = pointAt(g.coordinates, g.cumDistM, 950);
  const raw = snapshot({
    shapeDistM: 950,
    lastStopId: "current",
    lastStopSequence: 1,
    nextStopId: "next",
    nextStopSequence: 2,
    coordinates: [pos[0], pos[1] + 5 / 111320],
  });
  fleet.ingest([raw], () => undefined, T0);
  let state = fleet.getStates(T0, "smooth", true)[0];
  const start = state.position;
  fleet.ingest(
    [
      {
        ...raw,
        observedAtMs: T0 + 1000,
        coordinates: [
          pos[0] + 20 / (111320 * Math.cos((pos[1] * Math.PI) / 180)),
          raw.coordinates[1],
        ],
      },
    ],
    () => undefined,
    T0 + 1000,
  );
  state = fleet.getStates(T0 + 1000, "smooth", true)[0];
  expect(state.presentationTransitionReason).toBeNull();
  expect(Math.hypot(...worldDelta(start, state.position))).toBeLessThan(2);
  const before = state.position;
  // Return a route while raw-world correction is in progress.
  fleet.ingest([raw], () => g, T0 + 1010);
  state = fleet.getStates(T0 + 1033, "smooth", true)[0];
  expect(state.presentationTransitionReason).toBeNull();
  expect(state.presentationOpacity).toBe(1);
  expect(Math.hypot(...worldDelta(before, state.position))).toBeLessThan(0.2);
  expect(state.presentationOffsetM).toBeDefined();
  const shown = state.position;
  fleet.getState(raw.key, T0 + 3000);
  expect(fleet.getStates(T0 + 1033, "smooth", true)[0].position).toEqual(shown);
});

it.each([10, 30, 60])(
  "unchanged raw GPS remains exactly still for 100s at %iHz",
  (fps) => {
    const position: [number, number] = [14.4, 50];
    const w = initialWorld(position);
    for (let i = 0; i < fps * 100; i++) advanceWorld(w, position, 1 / fps);
    expect(Math.hypot(w.x, w.y)).toBeLessThan(1e-9);
    expect(Math.hypot(w.vx, w.vy, w.ax, w.ay)).toBeLessThan(1e-9);
  },
);

it("late first-axis arrival after background retains the outgoing raw pose until hidden acknowledgement", () => {
  const store = new TrajectoryStore();
  store.ingest(wireBundle(), T0);
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const g = straightGeometry([
    { stopId: "current", distM: 900 },
    { stopId: "next", distM: 1500 },
  ]);
  const raw = snapshot({
    coordinates: pointAt(g.coordinates, g.cumDistM, 950),
    shapeDistM: 950,
    lastStopId: "current",
    lastStopSequence: 1,
    nextStopId: "next",
    nextStopSequence: 2,
  });
  fleet.ingest([raw], () => undefined, T0);
  const before = fleet.getStates(T0, "smooth", true)[0].position;
  fleet.ingest([raw], () => g, T0 + 10000);
  const returning = fleet.getStates(T0 + 10000, "smooth", true)[0];
  expect(returning.presentationTransitionReason).toBe("resume-gap");
  expect(returning.position).toEqual(before);
  expect(returning.presentationOpacity).toBe(1);
  expect(fleet.getGeometry(raw.key)).toBeUndefined();
});

it("an incompatible first axis does not brake raw-world motion instantaneously on its first fade frame", () => {
  const store = new TrajectoryStore();
  store.ingest(wireBundle(), T0);
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const raw = snapshot();
  fleet.ingest([raw], () => undefined, T0);
  fleet.getStates(T0, "smooth", true);
  fleet.ingest(
    [
      {
        ...raw,
        observedAtMs: T0,
        coordinates: [raw.coordinates[0] + 0.01, raw.coordinates[1]],
      },
    ],
    () => undefined,
    T0 + 1,
  );
  let last = fleet.getStates(T0 + 33, "smooth", true)[0];
  for (let t = 66; t <= 6000; t += 33)
    last = fleet.getStates(T0 + t, "smooth", true)[0];
  expect(last.simSpeedKmh).toBeGreaterThan(10);
  fleet.ingest(
    [
      {
        ...raw,
        observedAtMs: T0,
        coordinates: [raw.coordinates[0] + 0.01, raw.coordinates[1]],
      },
    ],
    () => straightGeometry(),
    T0 + 6001,
  );
  const faded = fleet.getStates(T0 + 6033, "smooth", true)[0];
  expect(faded.presentationOpacity).toBe(1);
  expect(faded.presentationTransitionReason).toBe("incompatible-geometry");
  expect(Math.abs(faded.simSpeedKmh - last.simSpeedKmh) / 3.6).toBeLessThan(
    0.17,
  );
  expect(
    Math.hypot(...worldDelta(last.position, faded.position)),
  ).toBeGreaterThan(0.1);
});

it("first-axis adoption requires enough terminal runway to preserve world velocity", () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const raw = snapshot({
    lastStopId: "current",
    lastStopSequence: 1,
    nextStopId: "next",
    nextStopSequence: 2,
  });
  fleet.ingest([raw], () => undefined, T0);
  fleet.getStates(T0, "smooth", true);
  const newer = {
    ...raw,
    observedAtMs: T0,
    coordinates: offsetPosition(raw.coordinates, [100, 0]),
  };
  fleet.ingest([newer], () => undefined, T0 + 1);
  let last = fleet.getStates(T0 + 33, "smooth", true)[0];
  for (let t = 66; t <= 6000; t += 33)
    last = fleet.getStates(T0 + t, "smooth", true)[0];
  const geometry = straightGeometry([
    { stopId: "current", distM: 0 },
    { stopId: "next", distM: 100 },
  ]);
  geometry.coordinates = [
    raw.coordinates,
    offsetPosition(last.position, [1, 0]),
  ];
  geometry.cumDistM = cumulativeDistances(geometry.coordinates);
  geometry.totalM = geometry.cumDistM[1];
  geometry.stops[1].distM = geometry.totalM;
  fleet.ingest([newer], () => geometry, T0 + 6001);
  const next = fleet.getStates(T0 + 6033, "smooth", true)[0];
  expect(next.presentationTransitionReason).toBe("incompatible-geometry");
  expect(fleet.getGeometry(raw.key)).toBeUndefined();
  expect(next.simSpeedKmh).toBeGreaterThan(10);
  expect(Math.abs(next.simSpeedKmh - last.simSpeedKmh) / 3.6).toBeLessThan(
    0.17,
  );
});

it("a trip change to a missing axis completes both hidden acknowledgements and fades back in", () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const raw = snapshot();
  fleet.ingest([raw], () => undefined, T0);
  fleet.getStates(T0, "smooth", true);
  fleet.ingest(
    [
      {
        ...raw,
        tripId: "next-trip",
        coordinates: offsetPosition(raw.coordinates, [100, 0]),
      },
    ],
    () => undefined,
    T0 + 1000,
  );
  let state = fleet.getStates(T0 + 1000, "smooth", true)[0];
  expect(state.presentationTransitionReason).toBe("trip-change");
  const tokens = new Set<number>();
  for (let i = 1; i <= 60; i++) {
    state = fleet.getStates(T0 + 1000 + (i * 1000) / 30, "smooth", true)[0];
    if (
      state.presentationOpacity === 0 &&
      state.presentationHiddenFrameId !== undefined
    ) {
      tokens.add(state.presentationHiddenFrameId);
      fleet.acknowledgePresentationHidden(
        state.key,
        state.presentationHiddenFrameId,
      );
    }
  }
  expect(tokens.size).toBe(2);
  expect(state.presentationTransitionReason).toBeNull();
  expect(state.presentationOpacity).toBe(1);
  expect(state.presentationCorrectionComparable).toBe(false);
});

it("geometry arriving during new-zero requires a fresh acknowledgement before revealing that axis", () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const raw = snapshot();
  fleet.ingest([raw], () => undefined, T0);
  fleet.getStates(T0, "smooth", true);
  const nextRaw = {
    ...raw,
    tripId: "next-trip",
    coordinates: offsetPosition(raw.coordinates, [100, 0]),
  };
  fleet.ingest([nextRaw], () => undefined, T0 + 1000);
  fleet.getStates(T0 + 1000, "smooth", true);
  const oldZero = fleet.getStates(T0 + 1300, "smooth", true)[0];
  fleet.acknowledgePresentationHidden(
    raw.key,
    oldZero.presentationHiddenFrameId!,
  );
  const rawZero = fleet.getStates(T0 + 1333, "smooth", true)[0];
  const geometry = { ...straightGeometry(), tripId: "next-trip" };
  fleet.ingest([nextRaw], () => geometry, T0 + 1340);
  const axisZero = fleet.getStates(T0 + 1366, "smooth", true)[0];
  expect(axisZero.presentationOpacity).toBe(0);
  expect(axisZero.presentationHiddenFrameId).not.toBe(
    rawZero.presentationHiddenFrameId,
  );
  expect(fleet.getGeometry(raw.key)).toBe(geometry);
  fleet.acknowledgePresentationHidden(
    raw.key,
    rawZero.presentationHiddenFrameId!,
  );
  const held = fleet.getStates(T0 + 1400, "smooth", true)[0];
  expect(held.presentationOpacity).toBe(0);
  expect(held.presentationHiddenFrameId).toBe(
    axisZero.presentationHiddenFrameId,
  );
  fleet.acknowledgePresentationHidden(
    raw.key,
    axisZero.presentationHiddenFrameId!,
  );
  fleet.getStates(T0 + 1433, "smooth", true);
  expect(
    fleet.getStates(T0 + 1833, "smooth", true)[0].presentationOpacity,
  ).toBe(1);
});
