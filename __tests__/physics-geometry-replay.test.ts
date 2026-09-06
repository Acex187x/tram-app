import { applyGeometryEvent } from '../bench/src/geometryReplay';
import { straightGeometry, T0 } from './physicsFixtures';
import type { RouteGeometry } from '@/lib/types';

it('replays only arrived seeds, rejects colliding aliases, then refines without later seed downgrade', () => {
  const states = new Map<string, RouteGeometry>();
  const a = { ...straightGeometry(), shapeId: 'shared', geometryKey: 'content-a' };
  const b = { ...a, geometryKey: 'content-b', coordinates: a.coordinates.map(([x,y]) => [x + .01,y]) };
  const pack = { shapes: [a,b], trips: { tripA: 'content-a', tripB: 'content-b' } };
  expect(states.size).toBe(0);
  expect(applyGeometryEvent(states, 'geometry:pack', pack, T0)).toBe(2);
  expect(states.get('tripA')?.provisional).toBe(true);
  expect(states.get('tripB')?.coordinates).toEqual(b.coordinates);
  expect(applyGeometryEvent(states, 'geometry:trip', { tripId: 'tripA', geometry: b }, T0 + 5000)).toBe(1);
  const authoritative = states.get('tripA');
  expect(authoritative?.provisional).toBe(false);
  expect(applyGeometryEvent(states, 'geometry:pack', pack, T0 + 60000)).toBe(0);
  expect(states.get('tripA')).toBe(authoritative);
  const legacy = new Map<string, RouteGeometry>();
  expect(applyGeometryEvent(legacy, 'geometry:pack', { shapes: [{...a,geometryKey:undefined},{...b,geometryKey:undefined}], trips: { ambiguous: 'shared' } }, T0)).toBe(0);
});
