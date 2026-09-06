import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import { haversineM, pointAt } from '@/lib/geo/polyline';

export const GEOMETRY_AXIS_CONTRADICTION_M = 500;
export type GeometryCoherence = {
  status: 'valid' | 'invalid' | 'unknown';
  reason?:
    'missing-geometry' | 'missing-stop-ids' | 'nonfinite-position' | 'axis-and-stop-ids-disagree';
  axisCoordinateErrorM: number | null;
};
type Fix = Pick<TramSnapshot, 'coordinates' | 'shapeDistM' | 'lastStopId' | 'nextStopId'>;

/** Detect a strong contradiction, not proof that an otherwise accepted fix is
 * accurate. Never project onto a different direction/variant to repair it.
 * Call/cache at fix or geometry changes, not inside the render loop. */
export function assessGeometryCoherence(
  fix: Fix,
  geometry: RouteGeometry | undefined,
): GeometryCoherence {
  if (
    !geometry ||
    geometry.coordinates.length < 2 ||
    geometry.cumDistM.length !== geometry.coordinates.length
  )
    return { status: 'unknown', reason: 'missing-geometry', axisCoordinateErrorM: null };
  if (
    !Number.isFinite(fix.shapeDistM) ||
    !Array.isArray(fix.coordinates) ||
    fix.coordinates.length !== 2 ||
    !fix.coordinates.every(Number.isFinite)
  )
    return { status: 'unknown', reason: 'nonfinite-position', axisCoordinateErrorM: null };
  const axisCoordinateErrorM = haversineM(
    fix.coordinates,
    pointAt(geometry.coordinates, geometry.cumDistM, fix.shapeDistM),
  );
  if (!Number.isFinite(axisCoordinateErrorM))
    return { status: 'unknown', reason: 'nonfinite-position', axisCoordinateErrorM: null };
  if (!fix.lastStopId || !fix.nextStopId || geometry.stops.length === 0)
    return { status: 'unknown', reason: 'missing-stop-ids', axisCoordinateErrorM };
  const eitherStopPresent = geometry.stops.some(
    (stop) => stop.stopId === fix.lastStopId || stop.stopId === fix.nextStopId,
  );
  return axisCoordinateErrorM > GEOMETRY_AXIS_CONTRADICTION_M && !eitherStopPresent
    ? { status: 'invalid', reason: 'axis-and-stop-ids-disagree', axisCoordinateErrorM }
    : { status: 'valid', axisCoordinateErrorM };
}
