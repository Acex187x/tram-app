/** Research transport adapter for captured app geometry arrivals. The lifecycle
 * mirrors seedFromPack/shapeCache: provisional seeds never replace residents;
 * authoritative trip responses replace seeds at their actual receipt time. */
import { servedToRouteGeometry, type ServedGeometry } from '@/lib/golemio/gtfs';
import type { RouteGeometry } from '@/lib/types';
export function applyGeometryEvent(
  geometries: Map<string, RouteGeometry>,
  path: string,
  value: any,
  receivedAtMs: number,
): number {
  if (path === 'geometry:trip') {
    if (!value?.tripId || !value?.geometry) return 0;
    try {
      geometries.set(value.tripId, { ...servedToRouteGeometry(value.geometry, receivedAtMs), tripId: value.tripId, provisional: false });
      return 1;
    } catch { return 0; }
  }
  if (path !== 'geometry:pack' || !Array.isArray(value?.shapes) || !value?.trips) return 0;
  const byKey = new Map<string, ServedGeometry | null>();
  const axis = (s: ServedGeometry) => JSON.stringify([s.coordinates, s.cumDistM, s.totalM, s.stops.map(x => [x.stopId, x.sequence, x.distM])]);
  for (const s of value.shapes) {
    const key = s?.geometryKey ?? s?.shapeId;
    if (typeof key !== 'string' || !key) continue;
    if (!byKey.has(key)) byKey.set(key, s);
    else {
      const prior = byKey.get(key);
      try { if (!prior || axis(prior) !== axis(s)) byKey.set(key, null); }
      catch { byKey.set(key, null); }
    }
  }
  let changed = 0;
  for (const [tripId, key] of Object.entries(value.trips)) {
    if (geometries.has(tripId) || typeof key !== 'string') continue;
    const s = byKey.get(key);
    if (!s) continue;
    try {
      geometries.set(tripId, { ...servedToRouteGeometry(s, receivedAtMs), tripId, geometryKey: s.geometryKey, provisional: true });
      changed++;
    } catch { /* reject only malformed member */ }
  }
  return changed;
}
