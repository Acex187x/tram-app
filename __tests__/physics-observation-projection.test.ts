import {
  projectObservation,
  sameGeometryAxis,
} from "@/lib/physics/observationProjection";
import { pointAt, cumulativeDistances } from "@/lib/geo/polyline";
import { TramFleet } from "@/lib/physics/fleet";
import { TrajectoryStore } from "@/lib/physics/trajectoryStore";
import { getModelSpec } from "@/lib/fleet/registry";
import { snapshot, straightGeometry, T0 } from "./physicsFixtures";

const geometry = () =>
  straightGeometry([{ distM: 0 }, { distM: 1000 }, { distM: 2000 }]);
function fix(s: number, at: number, g = geometry()) {
  return snapshot({
    coordinates: pointAt(g.coordinates, g.cumDistM, s),
    observedAtMs: at,
    shapeDistM: 900,
    statePosition: "at_stop",
    lastStopId: "stop-1",
    lastStopSequence: 2,
    nextStopId: "stop-2",
    nextStopSequence: 3,
  });
}
it("projects moving approach GPS while preserving source anchor semantics", () => {
  const g = geometry();
  const f = fix(960, T0, g);
  expect(projectObservation(f, g)?.s).toBeCloseTo(960, 5);
  expect(f.shapeDistM).toBe(900);
});
it("rejects off-route GPS and mismatched stop visits", () => {
  const g = geometry();
  expect(
    projectObservation({ ...fix(960, T0, g), coordinates: [14.4, 51] }, g),
  ).toBeNull();
  expect(
    projectObservation({ ...fix(960, T0, g), lastStopSequence: 99 }, g),
  ).toBeNull();
  expect(
    projectObservation({ ...fix(960, T0, g), nextStopSequence: 1 }, g),
  ).toBeNull();
});
it("does not choose arbitrarily between nearby parallel legs in a corridor", () => {
  const g = geometry();
  g.coordinates = [
    [14.4, 50.08],
    [14.402, 50.08],
    [14.402, 50.08004],
    [14.4, 50.08004],
  ];
  g.cumDistM = cumulativeDistances(g.coordinates);
  g.totalM = g.cumDistM.at(-1)!;
  g.stops = [
    { ...g.stops[0], distM: 0 },
    { ...g.stops[1], distM: g.totalM },
  ];
  const f = snapshot({
    coordinates: [14.401, 50.08002],
    lastStopId: "stop-0",
    lastStopSequence: 1,
    nextStopId: "stop-1",
    nextStopSequence: 2,
  });
  expect(projectObservation(f, g)).toBeNull();
});
it("no-curve fallback moves on causal GPS despite flat anchor distance and at_stop label, then stops on a flat GPS pair", () => {
  const g = geometry(),
    store = new TrajectoryStore(),
    fleet = new TramFleet({
      trajectories: store,
      resolveModel: () => getModelSpec("15t"),
    });
  fleet.ingest([fix(950, T0, g)], () => g);
  fleet.ingest([fix(990, T0 + 10000, g)], () => g);
  expect(fleet.getState("9201", T0 + 15000)?.simDistM).toBeCloseTo(1010, 4);
  expect(fleet.getState("9201", T0 + 15000)?.simSpeedKmh).toBeCloseTo(14.4, 4);
  fleet.ingest([fix(990, T0 + 20000, g)], () => g);
  expect(fleet.getState("9201", T0 + 25000)?.simDistM).toBeCloseTo(990, 4);
  expect(fleet.getState("9201", T0 + 25000)?.simSpeedKmh).toBe(0);
});
it("identifies an equivalent axis despite metadata and tuple allocation changes", () => {
  const g = geometry();
  expect(
    sameGeometryAxis(g, {
      ...g,
      shapeId: "new-cache-object",
      coordinates: g.coordinates.map((p) => [...p]),
      cumDistM: [...g.cumDistM],
      stops: [],
    }),
  ).toBe(true);
  expect(
    sameGeometryAxis(g, { ...g, cumDistM: g.cumDistM.map((s, i) => s + i) }),
  ).toBe(false);
});
