import { assessGeometryCoherence } from '@/lib/physics/geometryCoherence';
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { getModelSpec } from '@/lib/fleet/registry';
import { pointAt } from '@/lib/geo/polyline';
import { T0, snapshot, straightGeometry, wireBundle } from './physicsFixtures';

const geom = straightGeometry([{ stopId: 'U567Z1P', distM: 0 }]);
const bad = snapshot({
  coordinates: [14.48744, 50.0763],
  shapeDistM: 0,
  lastStopId: 'U848Z1P',
  nextStopId: 'U713Z1P',
});

it('detects the captured contradictory IDs and distant reported axis without projecting GPS', () => {
  const captured = {
    ...geom,
    coordinates: [
      [14.346666, 50.068066],
      [14.351854, 50.068242],
    ] as [number, number][],
    cumDistM: [0, 400],
  };
  const result = assessGeometryCoherence(bad, captured);
  expect(result.status).toBe('invalid');
  expect(result.axisCoordinateErrorM).toBeCloseTo(10088.313, 1);
  expect(result.reason).toBe('axis-and-stop-ids-disagree');
  expect(bad.shapeDistM).toBe(0);
});

it('requires both independent contradictions and does not reject missing evidence', () => {
  expect(
    assessGeometryCoherence(
      { ...bad, coordinates: pointAt(geom.coordinates, geom.cumDistM, 0) },
      geom,
    ).status,
  ).toBe('valid');
  expect(assessGeometryCoherence({ ...bad, lastStopId: geom.stops[0].stopId }, geom).status).toBe(
    'valid',
  );
  expect(assessGeometryCoherence({ ...bad, lastStopId: null }, geom).status).toBe('unknown');
  expect(assessGeometryCoherence(bad, undefined).status).toBe('unknown');
  expect(assessGeometryCoherence({ ...bad, coordinates: [NaN, 50] }, geom).status).toBe('unknown');
});

it('quarantines invalid geometry and curves at raw GPS, culls there, and recovers on a coherent fix', () => {
  const store = new TrajectoryStore();
  store.ingest(wireBundle(), T0);
  const fleet = new TramFleet({ trajectories: store, resolveModel: () => getModelSpec('15t') });
  fleet.ingest([bad], () => geom);
  const state = fleet.getStates(T0, 'smooth', true)[0];
  expect(state.position).toEqual(bad.coordinates);
  expect(state.hasGeometry).toBe(false);
  expect(state.pastHorizon).toBe(true);
  expect(state.simSpeedKmh).toBe(0);
  expect(fleet.getGeometry(bad.key)).toBeUndefined();
  expect(fleet.getDiagnostics(bad.key, T0)?.geometryCoherence).toBe('invalid');
  expect(fleet.getStatesInBounds(T0, [14.48, 50.07, 14.5, 50.08], null, null)).toHaveLength(1);
  expect(fleet.getStatesInBounds(T0, [14.3, 49.9, 14.31, 50.0], null, null)).toHaveLength(0);
  const recovered = {
    ...bad,
    coordinates: pointAt(geom.coordinates, geom.cumDistM, 1000),
    shapeDistM: 1000,
    observedAtMs: T0 + 1000,
  };
  fleet.ingest([recovered], () => geom);
  expect(fleet.getState(bad.key, T0 + 1000)?.hasGeometry).toBe(true);
  expect(fleet.getDiagnostics(bad.key, T0 + 1000)?.geometryCoherence).toBe('valid');
});

it('rechecks unchanged fixes after geometry arrives or is replaced', () => {
  const store = new TrajectoryStore();
  store.ingest(wireBundle(), T0);
  const fleet = new TramFleet({ trajectories: store, resolveModel: () => getModelSpec('15t') });
  fleet.ingest([bad], () => undefined);
  expect(fleet.getDiagnostics(bad.key, T0)?.geometryCoherence).toBe('unknown');
  fleet.ingest([bad], () => geom);
  expect(fleet.getDiagnostics(bad.key, T0)?.geometryCoherence).toBe('invalid');
  const replacement = {
    ...geom,
    stops: geom.stops.map((s, i) => (i === 0 ? { ...s, stopId: bad.lastStopId! } : s)),
  };
  fleet.ingest([bad], () => replacement);
  expect(fleet.getDiagnostics(bad.key, T0)?.geometryCoherence).toBe('valid');
  expect(fleet.getGeometry(bad.key)).toBe(replacement);
});

it.each([undefined, null, [], [14], [Infinity, 50]])(
  'handles malformed runtime coordinates %s as unknown',
  (coordinates) => {
    expect(assessGeometryCoherence({ ...bad, coordinates } as typeof bad, geom).status).toBe(
      'unknown',
    );
  },
);
