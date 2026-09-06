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

it('rejects a provisional opposite-direction seed even on nearby parallel tracks', () => {
  const provisional = { ...straightGeometry([
    { stopId: 'U269Z2P', distM: 0 }, { stopId: 'U508Z2P', distM: 500 },
  ]), provisional: true };
  const fix = snapshot({ lastStopId: 'U269Z1P', nextStopId: 'U508Z1P',
    shapeDistM: 200, coordinates: pointAt(provisional.coordinates, provisional.cumDistM, 200) });
  const result = assessGeometryCoherence(fix, provisional);
  expect(result.axisCoordinateErrorM).toBe(0);
  expect(result.reason).toBe('provisional-stop-order-disagrees');
  expect(result.status).toBe('invalid');
  const corrected = { ...provisional, provisional: false,
    stops: provisional.stops.map((stop, i) => ({ ...stop, stopId: i ? 'U508Z1P' : 'U269Z1P' })) };
  expect(assessGeometryCoherence(fix, corrected).status).toBe('valid');
});

it('requires ordered provisional platform occurrences, allowing repeated loop platforms', () => {
  const fix = snapshot({ lastStopId: 'B', nextStopId: 'A' });
  const provisional = { ...straightGeometry([
    { stopId: 'A', distM: 0 }, { stopId: 'B', distM: 500 },
  ]), provisional: true };
  expect(assessGeometryCoherence(fix, provisional).status).toBe('invalid');
  const loop = { ...provisional, stops: [...provisional.stops, { ...provisional.stops[0], sequence: 3, distM: 1000 }] };
  expect(assessGeometryCoherence(fix, loop).status).toBe('valid');
  expect(assessGeometryCoherence({ ...fix, nextStopId: null }, provisional).status).toBe('unknown');
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

it('quarantines an incomplete cached distance axis before the fleet can evaluate it', () => {
  const malformed = { ...geom, cumDistM: undefined } as unknown as typeof geom;
  expect(assessGeometryCoherence(bad, malformed).reason).toBe('malformed-geometry');
  const fleet = new TramFleet({ trajectories: new TrajectoryStore(), resolveModel: () => getModelSpec('15t') });
  expect(() => fleet.ingest([bad], () => malformed)).not.toThrow();
  expect(fleet.getPredictionState(bad.key, T0)?.hasGeometry).toBe(false);
});
