import type { RouteGeometry, TramSnapshot } from "@/lib/types";
import { segmentIndexAt } from "@/lib/geo/polyline";

export interface ObservationProjection {
  s: number;
  offsetM: number;
  corridorLoM: number;
  corridorHiM: number;
}
export interface StopCorridor {
  lo: number;
  hi: number;
}
/** Source state_position names an anchor type, not motion. Identity narrows the
 * GPS projection to this visit's corridor; never choose a different route/lap. */
export function observationCorridor(
  fix: TramSnapshot,
  geometry: RouteGeometry,
): StopCorridor | null {
  if (
    !fix.lastStopId ||
    !fix.nextStopId ||
    !Number.isFinite(fix.lastStopSequence) ||
    !Number.isFinite(fix.nextStopSequence)
  )
    return null;
  const current = geometry.stops.filter(
    (s) => s.stopId === fix.lastStopId && s.sequence === fix.lastStopSequence,
  );
  const next = geometry.stops.filter(
    (s) => s.stopId === fix.nextStopId && s.sequence === fix.nextStopSequence,
  );
  if (
    current.length !== 1 ||
    next.length !== 1 ||
    next[0].sequence <= current[0].sequence ||
    next[0].distM <= current[0].distM
  )
    return null;
  const currentIndex = geometry.stops.indexOf(current[0]);
  const previous =
    currentIndex > 0 ? geometry.stops[currentIndex - 1].distM : 0;
  return {
    lo: Math.max(previous, current[0].distM - 150),
    hi: Math.min(geometry.totalM, next[0].distM),
  };
}

/** Project once on ingest/axis replacement, not per frame. Reject an equally
 * plausible distant visit/parallel segment instead of picking it arbitrarily. */
export function projectInCorridor(
  point: [number, number],
  geometry: RouteGeometry,
  corridor: StopCorridor,
  maxOffsetM: number,
): ObservationProjection | null {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !point.every(Number.isFinite) ||
    geometry.coordinates.length < 2 ||
    geometry.cumDistM.length !== geometry.coordinates.length ||
    !(corridor.hi > corridor.lo)
  )
    return null;
  const kx = 111320 * Math.cos((point[1] * Math.PI) / 180),
    ky = 111320;
  const lo = Math.max(0, corridor.lo),
    hi = Math.min(geometry.totalM, corridor.hi);
  if (!(hi > lo)) return null;
  const first = segmentIndexAt(geometry.cumDistM, lo),
    last = segmentIndexAt(geometry.cumDistM, hi);
  const candidates: { s: number; d: number }[] = [];
  let bestS = 0,
    bestD = Infinity;
  for (let i = first; i <= last && i < geometry.coordinates.length - 1; i++) {
    const ds = geometry.cumDistM[i + 1] - geometry.cumDistM[i];
    if (!(ds > 0)) continue;
    const a = geometry.coordinates[i],
      b = geometry.coordinates[i + 1];
    const ax = (a[0] - point[0]) * kx,
      ay = (a[1] - point[1]) * ky;
    const dx = (b[0] - a[0]) * kx,
      dy = (b[1] - a[1]) * ky;
    const len = dx * dx + dy * dy;
    if (!(len > 0)) continue;
    const t = Math.max(
      Math.max(0, (lo - geometry.cumDistM[i]) / ds),
      Math.min(
        Math.min(1, (hi - geometry.cumDistM[i]) / ds),
        -(ax * dx + ay * dy) / len,
      ),
    );
    const d = Math.hypot(ax + t * dx, ay + t * dy),
      s = geometry.cumDistM[i] + t * ds;
    candidates.push({ s, d });
    if (d < bestD) {
      bestD = d;
      bestS = s;
    }
  }
  if (!Number.isFinite(bestD) || bestD > maxOffsetM) return null;
  if (candidates.some((c) => Math.abs(c.s - bestS) > 30 && c.d <= bestD + 3))
    return null;
  return { s: bestS, offsetM: bestD, corridorLoM: lo, corridorHiM: hi };
}
export function projectObservation(
  fix: TramSnapshot,
  geometry: RouteGeometry | undefined,
): ObservationProjection | null {
  if (!geometry) return null;
  const corridor = observationCorridor(fix, geometry);
  return corridor
    ? projectInCorridor(fix.coordinates, geometry, corridor, 30)
    : null;
}
/** Timetable/metadata refreshes do not change the along-route coordinate axis. */
export function sameGeometryAxis(a: RouteGeometry, b: RouteGeometry): boolean {
  if (a === b) return true;
  if (
    a.totalM !== b.totalM ||
    a.coordinates.length !== b.coordinates.length ||
    a.cumDistM.length !== b.cumDistM.length
  )
    return false;
  for (let i = 0; i < a.coordinates.length; i++)
    if (
      a.cumDistM[i] !== b.cumDistM[i] ||
      a.coordinates[i][0] !== b.coordinates[i][0] ||
      a.coordinates[i][1] !== b.coordinates[i][1]
    )
      return false;
  return true;
}
