import type { TrackPoint } from './trajectory';
import { evalTrack } from './trajectory';
import { INSTANT_NAIVE_GAP_M } from './config';

/** An outage may retain a good curve only while it still covers the present.
 * Agreement at the historical anchor alone says nothing about a horizon
 * exhausted minutes ago — retaining that curve makes a silent permanent stop.
 */
export function needsTrajectoryFallback(
  previous: { tripId: string; opinion: TrackPoint[] } | undefined,
  fix: { tripId: string; shapeDistM: number; observedAtMs: number },
  nowMs: number,
): boolean {
  if (!previous || previous.tripId !== fix.tripId || previous.opinion.length === 0) return true;
  const track = previous.opinion;
  const last = track[track.length - 1];
  return last.t <= nowMs || fix.shapeDistM > last.s + 1 ||
    Math.abs(fix.shapeDistM - evalTrack(track, fix.observedAtMs)) > INSTANT_NAIVE_GAP_M;
}

/** ML resolves asynchronously while public fixes keep arriving. An old
 * response must not borrow a newer stop's standing credit or republish a
 * vehicle after removal/trip change. The next refresh uses the newest fix. */
export function isCurrentTrajectoryFix(
  current: { tripId: string; observedAtMs: number } | undefined,
  captured: { tripId: string; observedAtMs: number },
): boolean {
  return current !== undefined && current.tripId === captured.tripId
    && current.observedAtMs === captured.observedAtMs;
}
