import type {RouteGeometry, RouteStop} from '@/lib/types';

/** Captured AT_STOP identity, scoped to one anchor; never carried across fixes. */
export interface ServedPlatformEvidence {
  stopId: string | null;
  sequence: number | null;
  nextStopId: string | null;
  nextSequence: number | null;
}
export const SERVED_PLATFORM_APPROACH_M = 150;

/** The modal anchor already serves this exact platform occurrence. Unknown or
 * contradictory station-zone evidence retains the ordinary distance plan. */
export function consumedPlatform(
  evidence: ServedPlatformEvidence | null | undefined,
  modal: {stopS: number; releaseAtMs: number} | null,
  geom: RouteGeometry,
): RouteStop | null {
  if (!modal || !Number.isFinite(modal.stopS) || !Number.isFinite(modal.releaseAtMs) ||
      !evidence?.stopId || !evidence.nextStopId ||
      !Number.isFinite(evidence.sequence) || !Number.isFinite(evidence.nextSequence) ||
      evidence.nextSequence! <= evidence.sequence!) return null;
  // Initial rollout excludes repeated platform IDs even when a sequence could
  // distinguish them. None of the measured cases requires loop ambiguity.
  const current = geom.stops.filter(s => s.stopId === evidence.stopId);
  if (current.length !== 1 || current[0].sequence !== evidence.sequence) return null;
  const st = current[0];
  if (st.isTerminal || st === geom.stops[geom.stops.length - 1]) return null;
  const ahead = st.distM - modal.stopS;
  if (!(ahead > 0 && ahead <= SERVED_PLATFORM_APPROACH_M)) return null;
  const next = geom.stops.filter(s => s.stopId === evidence.nextStopId && s.sequence === evidence.nextSequence);
  if (next.length !== 1 || !(next[0].distM > st.distM)) return null;
  if (geom.stops.some(s => s.distM > modal.stopS && s.distM < st.distM && s.stopId !== st.stopId)) return null;
  return st;
}
