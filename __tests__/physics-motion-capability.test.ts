import { parseVehicle } from "@/lib/physics/bundle";
import { renderDistM, renderSpeedMs, renderTram } from "@/lib/physics/render";
import { TramFleet } from "@/lib/physics/fleet";
import { TrajectoryStore } from "@/lib/physics/trajectoryStore";
import { getModelSpec } from "@/lib/fleet/registry";
import {
  T0,
  wireVehicle,
  wireTrack,
  wireBundle,
  snapshot,
  straightGeometry,
} from "./physicsFixtures";

function vehicle(policy?: unknown) {
  return parseVehicle({
    ...wireVehicle({
      anchorMs: T0,
      emittedAtMs: T0,
      smooth: wireTrack(T0, 1000, 10, 13),
      opinion: wireTrack(T0, 1000, 10, 13),
    }),
    motionPolicy: policy,
  })!;
}

it("only a recognized per-vehicle capability disables the smooth forward fix composition", () => {
  const at = T0 + 20000,
    fixAt = T0 + 10000,
    fixS = 1500;
  const legacy = vehicle();
  const known = vehicle("continuous-v1");
  expect(renderDistM(known, at, "smooth", fixS, fixAt)).toBe(1200);
  expect(renderDistM(legacy, at, "smooth", fixS, fixAt)).toBeGreaterThan(1200);
  for (const value of [null, "continuous-v2", true, {}, 1]) {
    const parsed = vehicle(value);
    expect(parsed.motionPolicy).toBeUndefined();
    expect(renderDistM(parsed, at, "smooth", fixS, fixAt)).toBe(
      renderDistM(legacy, at, "smooth", fixS, fixAt),
    );
  }
  expect(renderDistM(known, at, "fixed", fixS, fixAt)).toBe(
    renderDistM(legacy, at, "fixed", fixS, fixAt),
  );
});

it("uses the same capability in position, derivative and effective horizon", () => {
  const known = vehicle("continuous-v1");
  const at = T0 + 20000,
    fixAt = T0 + 10000,
    fixS = 5000;
  expect(renderTram(known, at, "smooth", fixS, fixAt)).toEqual({
    s: 1200,
    pastHorizon: false,
  });
  expect(renderSpeedMs(known, at, "smooth", fixS, fixAt)).toBe(10);
  expect(
    renderTram(known, T0 + 200000, "smooth", fixS, fixAt).pastHorizon,
  ).toBe(true);
});

it("retains presentation across continuous-to-legacy source recovery and reports the active capability", () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({
    trajectories: store,
    resolveModel: () => getModelSpec("15t"),
  });
  const geometry = straightGeometry();
  fleet.ingest([snapshot()], () => geometry);
  const emit = (at: number, s: number, policy?: string) =>
    store.ingest(
      wireBundle({
        serverNowMs: at,
        vehicles: [
          {
            ...wireVehicle({
              emittedAtMs: at,
              anchorMs: at,
              smooth: wireTrack(at, s, 10, 13),
            }),
            motionPolicy: policy,
          } as ReturnType<typeof wireVehicle>,
        ],
      }),
      at,
    );
  emit(T0, 1000, "continuous-v1");
  const first = fleet.getStates(T0, "smooth", true)[0];
  emit(T0 + 1, 700);
  const next = fleet.getStates(T0 + 100, "smooth", true)[0];
  expect(next.simDistM).toBeGreaterThanOrEqual(first.simDistM);
  expect(
    Math.abs(next.simSpeedKmh - first.simSpeedKmh) / 3.6,
  ).toBeLessThanOrEqual(0.25);
  expect(next.presentationOpacity).toBe(1);
  expect(fleet.getDiagnostics("9201", T0 + 100)?.motionPolicy).toBe("legacy");
});
