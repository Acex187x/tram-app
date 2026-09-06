/// <reference types="jest" />
import { GeometryStore } from '../lab/src/geometry';
import { straightGeometry } from './physicsFixtures';
import type { Store } from '../lab/src/db';

it('hydrates only active trips from SQLite and releases retired geometries/profiles', () => {
  const now=Date.now();
  const loadGeometry=jest.fn((tripId:string)=>({tripId,fetchedAtMs:now,json:JSON.stringify({...straightGeometry(),tripId,serviceMidnightMs:now})}));
  const loadGeometries=jest.fn(()=>{throw Error('must not hydrate whole archive');});
  const store=new GeometryStore({loadGeometry,loadGeometries} as unknown as Store);
  expect(store.size()).toBe(0);
  store.ensure(['a','b']);
  expect(store.size()).toBe(2);
  expect(loadGeometry).toHaveBeenCalledTimes(2);
  const b=store.resolve('b');
  store.ensure(['b','c']);
  expect(store.size()).toBe(2);
  expect(store.resolve('a')).toBeUndefined();
  expect(store.resolve('b')).toBe(b);
  expect(loadGeometry).toHaveBeenCalledTimes(3);
  expect(loadGeometries).not.toHaveBeenCalled();
});
