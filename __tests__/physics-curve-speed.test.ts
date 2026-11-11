import { curveSpeedCap } from "@/lib/physics/curveSpeed";
import { advancePresentation, TRAM_PRESENTATION_LIMITS } from "@/lib/physics/presentation";
import { cumulativeDistances } from "@/lib/geo/polyline";
import type { RouteGeometry } from "@/lib/types";

/** 1 km east, then a ~25 m radius quarter turn north, then 1 km north. */
function bentGeometry(): RouteGeometry {
  const lat0 = 50.08;
  const mLng = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const mLat = 1 / 111320;
  const coordinates: [number, number][] = [[14.4, lat0]];
  coordinates.push([14.4 + 1000 * mLng, lat0]);
  for (let i = 1; i <= 9; i++) {
    const t = (i / 9) * (Math.PI / 2);
    coordinates.push([
      14.4 + (1000 + 25 * Math.sin(t)) * mLng,
      lat0 + 25 * (1 - Math.cos(t)) * mLat,
    ]);
  }
  coordinates.push([14.4 + 1025 * mLng, lat0 + 1025 * mLat]);
  const cumDistM = cumulativeDistances(coordinates);
  return {
    shapeId: "bent",
    tripId: "bent",
    routeId: "L9",
    line: "9",
    headsign: "Test",
    coordinates,
    cumDistM,
    totalM: cumDistM[cumDistM.length - 1],
    stops: [],
  } as unknown as RouteGeometry;
}

const ceiling = TRAM_PRESENTATION_LIMITS.speed;

it("keeps the ceiling on a straight far from any curve", () => {
  expect(curveSpeedCap(bentGeometry(), 100, 10, ceiling)).toBe(ceiling);
});

it("caps speed in a tight curve and ramps the cap down ahead of it", () => {
  const g = bentGeometry();
  const inCurve = curveSpeedCap(g, 1015, 5, ceiling);
  // 0.85·sqrt(0.98·25) ≈ 4.2 m/s on a 25 m radius.
  expect(inCurve).toBeLessThan(6);
  const approaching = curveSpeedCap(g, 850, 10, ceiling);
  expect(approaching).toBeGreaterThan(inCurve);
  expect(approaching).toBeLessThan(ceiling);
});

it("a lowered soft cap slows the display without a velocity step", () => {
  const p = { s: 0, v: 15, a: 0 };
  let previousV = p.v;
  for (let i = 0; i < 300; i++) {
    advancePresentation(p, 1 / 30, p.s + 15 / 30, 15, 0, null, TRAM_PRESENTATION_LIMITS, 8);
    expect(Math.abs(p.v - previousV)).toBeLessThanOrEqual(1.4 / 30 + 1e-9);
    previousV = p.v;
  }
  expect(p.v).toBeLessThan(8.3);
});
