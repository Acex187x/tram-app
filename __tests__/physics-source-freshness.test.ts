import { sourceFreshness } from "@/lib/physics/sourceFreshness";
import { TramFleet } from "@/lib/physics/fleet";
import { TrajectoryStore } from "@/lib/physics/trajectoryStore";
import { getModelSpec } from "@/lib/fleet/registry";
import {
  T0,
  snapshot,
  straightGeometry,
  wireBundle,
  wireVehicle,
  wireTrack,
} from "./physicsFixtures";

it("ages from the observation clock, fading gently without becoming invisible", () => {
  expect(sourceFreshness(T0, T0 + 60000, true)).toEqual({
    sourceFreshness: "fresh",
    sourceAgeS: 60,
    sourceOpacity: 1,
  });
  expect(sourceFreshness(T0, T0 + 90000, true)).toEqual({
    sourceFreshness: "aging",
    sourceAgeS: 90,
    sourceOpacity: 0.775,
  });
  expect(sourceFreshness(T0, T0 + 120000, true)).toEqual({
    sourceFreshness: "aging",
    sourceAgeS: 120,
    sourceOpacity: 0.55,
  });
  expect(sourceFreshness(T0, T0 + 600000, true)).toEqual({
    sourceFreshness: "stale",
    sourceAgeS: 600,
    sourceOpacity: 0.55,
  });
});
it("does not manufacture freshness from an untrusted clock or invalid observation", () => {
  for (const [observed, now, trusted] of [
    [T0, T0, false],
    [NaN, T0, true],
    [T0, NaN, true],
    [T0 + 5001, T0, true],
  ] as Array<[number, number, boolean]>)
    expect(sourceFreshness(observed, now, trusted)).toEqual({
      sourceFreshness: "unknown",
      sourceAgeS: null,
      sourceOpacity: 0.55,
    });
  expect(sourceFreshness(T0 + 5000, T0, true).sourceAgeS).toBe(0);
});
it("fresh publications cannot renew old observation trust or consume presentation transitions", () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const geometry = straightGeometry();
  fleet.ingest([snapshot({ observedAtMs: T0 })], () => geometry, T0);
  store.ingest(wireBundle(), T0);
  fleet.getStates(T0, "smooth", true);
  for (let second = 1; second <= 130; second++) {
    if (second % 10 === 0)
      store.ingest(
        wireBundle({
          serverNowMs: T0 + second * 1000,
          vehicles: [
            wireVehicle({
              emittedAtMs: T0 + second * 1000,
              opinion: wireTrack(T0 + second * 1000, 1000 + second * 5, 5, 13),
              smooth: wireTrack(T0 + second * 1000, 990 + second * 5, 5, 13),
            }),
          ],
        }),
        T0 + second * 1000,
      );
    const state = fleet.getStates(T0 + second * 1000, "smooth", true)[0];
    expect(state.presentationOpacity).toBe(1);
    expect(state.presentationTransitionReason).toBeNull();
    expect(state.pastHorizon).toBe(false);
  }
  const end = fleet.getState("9201", T0 + 130000)!;
  expect(end.sourceAgeS).toBe(130);
  expect(end.sourceFreshness).toBe("stale");
  expect(end.sourceOpacity).toBe(0.55);
  expect(end.simSpeedKmh).toBeGreaterThan(1);
});
