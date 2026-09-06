import { DisplayAudit } from "../bench/src/displayAudit";
import { adaptTram } from "@/lib/physics/adapter";
import { pointAt } from "@/lib/geo/polyline";
import { snapshot, straightGeometry, T0 } from "./physicsFixtures";
import { getModelSpec } from "@/lib/fleet/registry";

const geometry = straightGeometry();
function state(s: number, tripId = "trip-a", opacity = 1) {
  return {
    ...adaptTram({
      snapshot: snapshot({ tripId, shapeDistM: s }),
      model: getModelSpec("15t"),
      geometry,
      vehicle: undefined,
      serverNowMs: T0,
      mode: "smooth",
    }),
    simDistM: s,
    position: pointAt(geometry.coordinates, geometry.cumDistM, s),
    presentationOpacity: opacity,
  };
}

it("keeps the outgoing display axis comparable when metadata changes before a hidden rebase", () => {
  const audit = new DisplayAudit();
  audit.sample(state(500), 0, geometry, undefined, true);
  audit.sample(state(510), 1000, geometry, undefined, true);
  audit.sample(state(520, "trip-b"), 2000, geometry, undefined, true);
  audit.sample(state(530, "trip-b"), 3000, geometry, undefined, true);
  const report = audit.report();
  expect(report.counts["trip-change"]).toBe(1);
  expect(report.fullyVisibleAbsoluteAccelerationMs2["1"]).toBe(0);
  expect(report.fullyVisibleAbsoluteJerkMs3["1"]).toBe(0);
});

it("records a hidden jump as a raw displacement and never as a visible teleport", () => {
  const audit = new DisplayAudit();
  audit.sample(state(500, "trip-a", 0), 0, geometry, undefined, true);
  audit.sample(state(1000, "trip-a", 0), 33, geometry, undefined, true);
  const report = audit.report();
  expect(report.counts["hidden-rebase-over-budget"]).toBe(1);
  expect(report.counts["raw-displacement-over-budget/ordinary"]).toBe(1);
  expect(report.counts["visible-or-partially-visible-over-budget"] ?? 0).toBe(
    0,
  );
  expect(report.maxWorldStepM).toBeGreaterThan(400);
});

it("records removal/reappearance separately without inventing motion while no feature existed", () => {
  const audit = new DisplayAudit();
  audit.sample(state(500), 0, geometry, undefined, true);
  audit.finishFrame(1000, new Set());
  audit.sample(state(1500), 2000, geometry, undefined, true);
  const report = audit.report();
  expect(report.counts["reappeared-identity"]).toBe(1);
  expect(report.maxWorldStepM).toBeGreaterThan(800);
  expect(report.maxFullyVisibleWorldStepM).toBe(0);
});

it("counts lateral world acceleration even when the route-axis distance is unchanged", () => {
  const audit = new DisplayAudit();
  for (let i = 0; i < 4; i++) {
    const sample = state(500);
    sample.position = [14.4, 50 + (i * i) / 111320];
    audit.sample(sample, i * 1000, geometry, undefined, true);
  }
  const report = audit.report();
  expect(report.fullyVisibleAbsoluteAccelerationMs2["1"]).toBe(0);
  expect(report.fullyVisibleWorldAccelerationMs2["1"]).toBeCloseTo(2, 2);
  expect(report.fullyVisibleWorldSpeedMs["1"]).toBeCloseTo(5, 2);
});
