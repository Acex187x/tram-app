/// <reference types="jest" />
//
// The UI-compatibility adapter: curves → TramPublicState. Everything the sheets,
// lists, timelines, planner and feature builder read is derived here, purely,
// so this suite is where "the app still means what it says" is enforced.

import { adaptTram, nearestStopIndex, nextStopIndex, DWELL_NEAR_STOP_M } from '@/lib/physics/adapter';
import { parseBundle, type ParsedVehicle } from '@/lib/physics/bundle';
import { pointAt } from '@/lib/geo/polyline';
import { getModelSpec } from '@/lib/fleet/registry';
import type { RouteGeometry } from '@/lib/types';
import { T0, snapshot, straightGeometry, wireBundle, wireTrack, wireVehicle } from './physicsFixtures';

const MODEL = getModelSpec('15t');

function vehicleFrom(over: Parameters<typeof wireVehicle>[0] = {}): ParsedVehicle {
  const parsed = parseBundle(wireBundle({ vehicles: [wireVehicle(over)] }), T0)!;
  return parsed.vehicles.get(over.key ?? '9201')!;
}

function adapt(
  vehicle: ParsedVehicle | undefined,
  serverNowMs: number,
  geometry: RouteGeometry = straightGeometry(),
  mode: 'smooth' | 'fixed' = 'smooth',
  snap = snapshot(),
) {
  return adaptTram({ snapshot: snap, model: MODEL, geometry, vehicle, serverNowMs, mode });
}

/** Same, but with NO trip geometry (the shape is still streaming in). */
function adaptNoGeo(vehicle: ParsedVehicle | undefined, serverNowMs: number) {
  return adaptTram({
    snapshot: snapshot(),
    model: MODEL,
    geometry: undefined,
    vehicle,
    serverNowMs,
    mode: 'smooth',
  });
}

describe('stop index helpers', () => {
  const stops = [{ distM: 0 }, { distM: 500 }, { distM: 1_200 }, { distM: 3_000 }];
  const geo = straightGeometry(stops);

  it('nextStopIndex finds the first stop strictly ahead', () => {
    expect(nextStopIndex(geo.stops, -10)).toBe(0);
    expect(nextStopIndex(geo.stops, 0)).toBe(1); // standing AT stop 0 → next is 1
    expect(nextStopIndex(geo.stops, 499)).toBe(1);
    expect(nextStopIndex(geo.stops, 500)).toBe(2);
    expect(nextStopIndex(geo.stops, 2_999)).toBe(3);
    expect(nextStopIndex(geo.stops, 3_000)).toBe(-1); // past the last one
  });

  it('nearestStopIndex picks the closest either side', () => {
    expect(nearestStopIndex(geo.stops, 0)).toBe(0);
    expect(nearestStopIndex(geo.stops, 240)).toBe(0);
    expect(nearestStopIndex(geo.stops, 260)).toBe(1);
    expect(nearestStopIndex(geo.stops, 99_999)).toBe(3);
    expect(nearestStopIndex([], 10)).toBe(-1);
  });
});

describe('rendered position + speed', () => {
  it('renders the SMOOTH curve in smooth mode and the OPINION curve in fixed mode', () => {
    const v = vehicleFrom();
    expect(adapt(v, T0, straightGeometry(), 'smooth').simDistM).toBe(990);
    expect(adapt(v, T0, straightGeometry(), 'fixed').simDistM).toBe(1_000);
  });

  it('places the head on the polyline at that distance', () => {
    const geo = straightGeometry();
    const state = adapt(vehicleFrom(), T0, geo);
    expect(state.position).toEqual(pointAt(geo.coordinates, geo.cumDistM, 990));
    expect(state.hasGeometry).toBe(true);
  });

  it('derives speed from the curve itself (±0.5 s finite difference)', () => {
    // Both fixture curves advance at 10 m/s → 36 km/h.
    const state = adapt(vehicleFrom(), T0 + 30_000);
    expect(state.simSpeedKmh).toBeCloseTo(36, 6);
  });

  it('reports zero speed while the curve holds at a stop', () => {
    const held = [
      { t: T0, s: 500 },
      { t: T0 + 40_000, s: 500 },
      { t: T0 + 60_000, s: 700 },
    ];
    const v = vehicleFrom({ smooth: held, opinion: held });
    expect(adapt(v, T0 + 20_000).simSpeedKmh).toBe(0);
  });

  it('clamps the head into the geometry (a curve running past the shape end)', () => {
    const geo = straightGeometry();
    const runaway = wireTrack(T0, geo.totalM - 10, 500, 5);
    const state = adapt(vehicleFrom({ smooth: runaway, opinion: runaway }), T0 + 40_000, geo);
    expect(state.simDistM).toBe(geo.totalM);
  });

  it('without geometry it falls back to the raw AVL coordinate and bearing', () => {
    const state = adaptNoGeo(vehicleFrom(), T0);
    expect(state.hasGeometry).toBe(false);
    expect(state.position).toEqual([14.4, 50.08]);
    expect(state.bearing).toBe(90);
  });
});

describe('the smooth↔fixed comparison metric', () => {
  it('deviationM is |smooth − fixed| at the evaluated instant', () => {
    const state = adapt(vehicleFrom(), T0);
    expect(state.deviationM).toBeCloseTo(10, 6); // 1000 vs 990 at emission
    expect(state.fixedDistM).toBe(1_000);
  });

  it('is IDENTICAL in both render modes — it measures the curves, not the choice', () => {
    const v = vehicleFrom();
    const smooth = adapt(v, T0 + 20_000, straightGeometry(), 'smooth');
    const fixed = adapt(v, T0 + 20_000, straightGeometry(), 'fixed');
    expect(smooth.deviationM).toBeCloseTo(fixed.deviationM!, 9);
  });

  it('is null when the vehicle has only one curve', () => {
    expect(adapt(vehicleFrom({ smooth: [] }), T0).deviationM).toBeNull();
  });
});

describe('pastHorizon — never animate beyond the data', () => {
  it('is false inside the published horizon', () => {
    expect(adapt(vehicleFrom(), T0 + 60_000).pastHorizon).toBe(false);
  });

  it('freezes at the last keyframe past the horizon, with zero speed', () => {
    const v = vehicleFrom();
    const beyond = adapt(v, T0 + 10 * 60_000);
    const atEnd = adapt(v, T0 + 120_000);
    expect(beyond.pastHorizon).toBe(true);
    expect(beyond.simDistM).toBe(atEnd.simDistM);
    expect(beyond.simSpeedKmh).toBe(0);
  });

  it('a vehicle with NO curves stands on its raw fix, marked frozen', () => {
    const state = adapt(undefined, T0);
    expect(state.pastHorizon).toBe(true);
    expect(state.simDistM).toBe(1_000); // snapshot.shapeDistM
    expect(state.simSpeedKmh).toBe(0);
    expect(state.deviationM).toBeNull();
    expect(state.fixedDistM).toBeNull();
  });

  it('a trajectory computed for a DIFFERENT trip is ignored (endpoint turn)', () => {
    const stale = vehicleFrom({ tripId: 'trip-previous' });
    const state = adapt(stale, T0);
    expect(state.pastHorizon).toBe(true);
    expect(state.simDistM).toBe(1_000); // the fix, not the stale curve
  });
});

describe('phase', () => {
  const stops = [{ distM: 0 }, { distM: 1_000 }, { distM: 3_000, isTerminal: true }];
  const geo = straightGeometry(stops);
  const heldAt = (s: number) => {
    const held = [
      { t: T0, s },
      { t: T0 + 60_000, s },
    ];
    return vehicleFrom({ smooth: held, opinion: held });
  };

  it("is 'dwell' when standing within 30 m of a stop", () => {
    expect(adapt(heldAt(1_000), T0 + 20_000, geo).phase).toBe('dwell');
    expect(adapt(heldAt(1_000 + DWELL_NEAR_STOP_M - 1), T0 + 20_000, geo).phase).toBe('dwell');
  });

  it("is 'cruise' when standing far from any stop (a jam, not a boarding)", () => {
    expect(adapt(heldAt(2_000), T0 + 20_000, geo).phase).toBe('cruise');
  });

  it("is 'cruise' while moving, even right next to a stop", () => {
    const moving = vehicleFrom({
      smooth: wireTrack(T0, 995, 10, 5),
      opinion: wireTrack(T0, 995, 10, 5),
    });
    expect(adapt(moving, T0, geo).phase).toBe('cruise');
  });

  it("is 'terminal' when standing at the last stop", () => {
    expect(adapt(heldAt(3_000), T0 + 20_000, geo).phase).toBe('terminal');
  });

  it("is 'unknown' without geometry or without curves", () => {
    expect(adaptNoGeo(vehicleFrom(), T0).phase).toBe('unknown');
    expect(adapt(undefined, T0, geo).phase).toBe('unknown');
  });
});

describe('next stop + ETA', () => {
  const stops = [{ distM: 0, name: 'A' }, { distM: 1_200, name: 'B' }, { distM: 2_000, name: 'C' }];
  const geo = straightGeometry(stops);

  it('names the first stop ahead of the RENDERED position', () => {
    // Smooth curve is at 990 m at T0 → next stop is B (1200 m).
    expect(adapt(vehicleFrom(), T0, geo).nextStopName).toBe('B');
  });

  it('ETA is the SMOOTH curve crossing that distance', () => {
    // Smooth: 990 m at T0, +10 m/s → 1200 m at T0 + 21 s.
    const state = adapt(vehicleFrom(), T0, geo);
    expect(state.nextStopEtaS).toBeCloseTo(21, 3);
  });

  it('uses the smooth ETA even while rendering the fixed curve', () => {
    // "When" is a property of the prediction, not of which curve you watch.
    const smooth = adapt(vehicleFrom(), T0, geo, 'smooth');
    const fixed = adapt(vehicleFrom(), T0, geo, 'fixed');
    expect(fixed.nextStopName).toBe(smooth.nextStopName);
    expect(fixed.nextStopEtaS).toBeCloseTo(smooth.nextStopEtaS!, 6);
  });

  it('ETA is NULL for a stop beyond the published horizon', () => {
    // Stop at 4 km is far past the 13-knot / 120 s curve.
    const far = straightGeometry([{ distM: 4_000, name: 'Far' }]);
    const state = adapt(vehicleFrom(), T0, far);
    expect(state.nextStopName).toBe('Far');
    expect(state.nextStopEtaS).toBeNull();
  });

  it('ETA never goes negative', () => {
    const state = adapt(vehicleFrom(), T0 + 25_000, geo);
    expect(state.nextStopEtaS === null || state.nextStopEtaS >= 0).toBe(true);
  });

  it('past the last stop there is no next stop', () => {
    const state = adapt(vehicleFrom(), T0 + 115_000, straightGeometry([{ distM: 100 }]));
    expect(state.nextStopName).toBeNull();
    expect(state.nextStopEtaS).toBeNull();
  });

  it('without curves the next stop is still knowable but the ETA is not', () => {
    const state = adapt(undefined, T0, geo);
    expect(state.nextStopName).toBe('B'); // fix at 1000 m
    expect(state.nextStopEtaS).toBeNull();
  });
});

describe('observed (raw fix) fields survive for the fix overlay', () => {
  it('projects the AVL fix onto the shape when geometry is known', () => {
    const geo = straightGeometry();
    const state = adapt(vehicleFrom(), T0, geo);
    expect(state.observedPosition).toEqual(pointAt(geo.coordinates, geo.cumDistM, 1_000));
    expect(state.observedBearing).toBeCloseTo(90, 0);
  });

  it('falls back to the raw AVL coordinate without geometry', () => {
    const state = adaptNoGeo(vehicleFrom(), T0);
    expect(state.observedPosition).toEqual([14.4, 50.08]);
    expect(state.observedBearing).toBe(90);
  });
});
