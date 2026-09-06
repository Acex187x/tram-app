import { MotionFeatureHistory, MOTION_FEATURE_NAMES, unknownMotionFeatures } from '../lab/src/motionFeatures';
import { pragueContext } from '../lab/src/config';
import fixture from '../lab/ml/fixtures/motion-features-v4.json';
import type { RouteGeometry, TramSnapshot } from '../src/lib/types';

function geometry(value: { shapeId: string; stops: (number | string)[][] }) {
  return { shapeId: value.shapeId, stops: value.stops.map(([distM, stopId]) => ({
    distM: Number(distM), stopId: String(stopId),
  })) } as RouteGeometry;
}
function snapshot(value: object): TramSnapshot { return value as TramSnapshot; }

describe('version-4 motion features: common Python golden sequences', () => {
  test('append-only column ordering is identical', () => {
    expect(MOTION_FEATURE_NAMES).toEqual(fixture.featureNames);
    expect(fixture.featureVersion).toBe(4);
  });
  for (const scenario of fixture.scenarios) test(scenario.name, () => {
    const history = new MotionFeatureHistory();
    const geometries = new Map(Object.entries(scenario.geometries).filter(([, value]) => value != null)
      .map(([trip, value]) => [trip, geometry(value!)]));
    const calls: object[] = [];
    const paceAt = (shapeId: string, routeId: string, distM: number, observedAtMs: number) => {
      const { hour, dayType } = pragueContext(observedAtMs);
      const hourBand = Math.floor(hour / 4);
      calls.push({ shapeId, routeId, distM, hourBand, dayType, observedAtMs });
      return 5 + hourBand + (dayType === 'weekend' ? 2 : 0);
    };
    const ordered = scenario.rows.map((row, index) => ({ row, index }))
      .sort((a, b) => a.row.receivedAtMs - b.row.receivedAtMs || a.index - b.index);
    for (const { row, index } of ordered) {
      const evidence = history.observe(snapshot(row), geometries.get(row.tripId), paceAt, row.receivedAtMs);
      const expected = scenario.expected.rows[index];
      expect(evidence.freshObservation).toBe(expected.fresh);
      for (const query of expected.queries) {
        const actual = history.features(row.key, row.tripId, query.atMs);
        expect(actual).toHaveLength(7);
        actual.forEach((value, column) => expect(value).toBeCloseTo(query.values[column], 10));
      }
    }
    expect(calls).toEqual(scenario.expected.paceCalls);
  });
});

const base = snapshot(fixture.scenarios[0].rows[0]);
const geo = geometry(fixture.scenarios[0].geometries.trip!);
describe('causal and bounded history ownership', () => {
  test('unknown trip, missing key and historical pre-receipt query never leak latest information', () => {
    const history = new MotionFeatureHistory();
    history.observe(base, geo, () => 8, 105000);
    history.observe({ ...base, observedAtMs: 130000, shapeDistM: 400 }, geo, () => 8, 135000);
    expect(history.features(base.key, base.tripId, 134999)).toEqual(unknownMotionFeatures());
    expect(history.features(base.key, 'different', 140000)).toEqual(unknownMotionFeatures());
    expect(history.features('absent', base.tripId, 140000)).toEqual(unknownMotionFeatures());
    expect(history.features(base.key, base.tripId, 140000)[0]).toBe(10);
  });
  test('receipt regression is rejected before changing the existing state', () => {
    const history = new MotionFeatureHistory();
    history.observe(base, geo, () => 8, 105000);
    const before = history.features(base.key, base.tripId, 110000);
    expect(() => history.observe(base, geo, () => 8, 104999)).toThrow('receipt epochs');
    expect(history.features(base.key, base.tripId, 110000)).toEqual(before);
  });
  test('history retains decayed memory beyond 180 s and has independent departure and capacity bounds', () => {
    const history = new MotionFeatureHistory(2);
    history.observe(base, geo, () => 8, 105000);
    history.observe({ ...base, observedAtMs: 130000, shapeDistM: 400 }, geo, () => 8, 135000);
    const decayed = history.features(base.key, base.tripId, 490000);
    expect(decayed[0]).toBe(10); // exactly two half-lives: threshold is inclusive.
    expect(decayed[1]).toBeCloseTo(0.25);
    expect(history.features(base.key, base.tripId, 490001)[0]).toBe(0);
    expect(history.features(base.key, base.tripId, 850000)[3]).toBeGreaterThan(1);
    history.observe({ ...base, key: 'b' }, geo, () => 8, 900000);
    history.observe({ ...base, key: 'c' }, geo, () => 8, 900001);
    expect(history.size).toBe(2);
    expect(history.evidence(base.key)).toBeNull();
    history.prune(new Set(['c']));
    expect(history.size).toBe(1);
    expect(history.evidence('b')).toBeNull();
    expect(() => new MotionFeatureHistory(0)).toThrow('positive integer');
  });
  test('exact platform contradiction is explicit metadata and never changes numerical features', () => {
    const a = new MotionFeatureHistory(); const b = new MotionFeatureHistory();
    const match = a.observe({ ...base, lastStopId: 'current' }, geo, () => 8, 105000);
    const mismatch = b.observe({ ...base, lastStopId: 'wrong' }, geo, () => 8, 105000);
    expect(match.exactPlatformRelation).toBe('matches');
    expect(mismatch.exactPlatformRelation).toBe('contradicts');
    expect(mismatch.platformProvenance).toBe('unique-next-predecessor');
    expect(a.features(base.key, base.tripId, 110000)).toEqual(b.features(base.key, base.tripId, 110000));
  });
  test('quarantining one raw vehicle forgets its pace without affecting another vehicle', () => {
    const history = new MotionFeatureHistory();
    history.observe(base, geo, () => 8, 105000);
    history.observe({ ...base, key: 'other' }, geo, () => 8, 105000);
    history.observe({ ...base, observedAtMs: 130000, shapeDistM: 400 }, geo, () => 8, 135000);
    history.forget(base.key);
    expect(history.features(base.key, base.tripId, 140000)).toEqual(unknownMotionFeatures());
    expect(history.evidence('other')).not.toBeNull();
    history.observe({ ...base, observedAtMs: 150000, shapeDistM: 600 }, geo, () => 8, 155000);
    expect(history.features(base.key, base.tripId, 155000)[0]).toBe(0);
  });
  test('a source reset discards all vehicles and permits its new receipt clock origin', () => {
    const history = new MotionFeatureHistory();
    history.observe(base, geo, () => 8, 105000);
    history.observe({ ...base, observedAtMs: 130000, shapeDistM: 400 }, geo, () => 8, 135000);
    history.clear();
    expect(history.size).toBe(0);
    expect(history.features(base.key, base.tripId, 140000)).toEqual(unknownMotionFeatures());
    expect(() => history.observe(base, geo, () => 8, 105000)).not.toThrow();
    expect(history.features(base.key, base.tripId, 105000)[0]).toBe(0);
  });
  test('caller mutation and returned diagnostics cannot overwrite prior observations', () => {
    const history = new MotionFeatureHistory();
    const first = { ...base, coordinates: [...base.coordinates] as [number, number] };
    const evidence = history.observe(first, geo, () => 8, 105000);
    first.shapeDistM = 9999;
    first.coordinates[0] = 0;
    evidence.receivedAtMs = 999999;
    history.observe({ ...base, observedAtMs: 130000, shapeDistM: 400 }, geo, () => 8, 135000);
    expect(history.features(base.key, base.tripId, 135000)[0]).toBe(10);
  });
});
