import { TramRuntime } from '@/hooks/tramData';
import { NullFeed } from '@/lib/feed/nullFeed';
import * as shapeCache from '@/lib/golemio/shapeCache';
import type { TramSnapshot } from '@/lib/types';
import { pointAt } from '@/lib/geo/polyline';
import { T0, snapshot, straightGeometry } from './physicsFixtures';

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(T0); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); shapeCache.clearMemoryCache(); });

it.each([true, false])('refines visible provisional geometry urgently only when contradicted: %s', rejected => {
  const geometry = { ...straightGeometry([
    { stopId: 'A', distM: 0 }, { stopId: 'B', distM: 500 },
  ]), provisional: true };
  const fix = snapshot({ tripId: geometry.tripId, lastStopId: rejected ? 'opposite-A' : 'A',
    nextStopId: rejected ? 'opposite-B' : 'B', shapeDistM: 200,
    coordinates: pointAt(geometry.coordinates, geometry.cumDistM, 200) });
  shapeCache.seedProvisional(fix.tripId, geometry);
  const feed = new NullFeed();
  feed.getGeometry = () => geometry;
  feed.requestGeometry = jest.fn();
  const runtime = new TramRuntime(feed);
  const [lng, lat] = fix.coordinates;
  runtime.setViewportProvider(() => ({ bbox: [lng - .01, lat - .01, lng + .01, lat + .01], zoom: 15 }));
  // Exercise the intake/priority integration without opening real sockets.
  (runtime as unknown as { onSnapshots(s: TramSnapshot[], atMs: number): void }).onSnapshots([fix], T0);
  expect(feed.requestGeometry).toHaveBeenCalledWith([fix.tripId], rejected ? 1 : 2);
  expect(feed.requestGeometry).toHaveBeenCalledTimes(1);
  expect(runtime.fleet.getPredictionState(fix.key, T0)?.hasGeometry).toBe(!rejected);
});
