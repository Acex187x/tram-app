import { TramFleet } from "@/lib/physics/fleet";
import { TrajectoryStore } from "@/lib/physics/trajectoryStore";
import { getModelSpec } from "@/lib/fleet/registry";
import { toCalibrationRecords } from "@/lib/feed/calibration";
import { rideRecord } from "@/lib/motionlog/core";
import {
  T0,
  snapshot,
  straightGeometry,
  wireBundle,
  wireTrack,
  wireVehicle,
} from "./physicsFixtures";

it("records current predictions through a hidden-map interval without advancing a display frame", () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const geometry = straightGeometry();
  fleet.ingest([snapshot()], () => geometry);
  const emit = (at: number, s: number) =>
    store.ingest(
      wireBundle({
        serverNowMs: at,
        vehicles: [
          wireVehicle({
            emittedAtMs: at,
            anchorMs: at,
            smooth: wireTrack(at, s, 10, 13),
          }),
        ],
      }),
      at,
    );
  emit(T0, 1000);
  const drawn = fleet.getStates(T0, "smooth", true)[0];
  // Background location can keep receiving observations and publications for
  // a ride, while there is deliberately no native Mapbox frame producer.
  for (let second = 60; second <= 600; second += 60) {
    const at = T0 + second * 1000;
    emit(at, 1000 + second * 2);
    const expected = 1000 + second * 2 + 200;
    const states = fleet.getPredictionStates(at + 20000);
    expect(toCalibrationRecords(states, at + 20000)[0].simDist).toBe(expected);
    const sample = {
      t: at + 20000,
      lat: 50.08,
      lng: 14.42,
      speed: 10,
      accuracy: 4,
    };
    expect(
      JSON.parse(rideRecord(sample, fleet.getPredictionState("9201", sample.t)))
        .simDist,
    ).toBe(expected);
    expect(fleet.hasPresentationTransitions()).toBe(false);
  }
  // Returning to the visible map still requires its own transition from the
  // last genuinely displayed location. Pure recordings did not consume it.
  const resumed = fleet.getStates(T0 + 621000, "smooth", true)[0];
  expect(resumed.position).toEqual(drawn.position);
  expect(resumed.presentationTransitionReason).toBe("resume-gap");
});

it("prediction geometry follows a new trip while the displayed outgoing axis is retained", () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const old = straightGeometry();
  fleet.ingest([snapshot()], () => old);
  fleet.getStates(T0, "smooth", true);
  const next = { ...old, tripId: "return-trip" };
  fleet.ingest(
    [
      snapshot({
        tripId: "return-trip",
        shapeDistM: 500,
        observedAtMs: T0 + 60000,
      }),
    ],
    () => next,
  );
  expect(fleet.getGeometry("9201")).toBe(old);
  expect(fleet.getPredictionGeometry("9201")).toBe(next);
  expect(fleet.getPredictionState("9201", T0 + 60000)?.simDistM).toBe(500);
  expect(
    fleet.getStates(T0 + 60000, "smooth", true)[0].presentationTransitionReason,
  ).toBe("trip-change");
});
