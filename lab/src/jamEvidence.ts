import { STUCK_COORD_EPS_M } from './config';

export const STUCK_FIX_EPS_M = 8;

/** A platform departure is movement evidence, even when the first on-track
 * coordinate is still next to the stopped coordinate. Calling that transition
 * a jam fabricated a 111-second hold for 9402 on 2026-09-05; its next fix
 * was already 1.5 km farther along the route.
 */
export function isJamEvidence(args: {
  previousState: string;
  currentState: string;
  axisAdvanceM: number;
  coordinateAdvanceM: number;
  nearStop: boolean;
}): boolean {
  return args.previousState === 'on_track' && args.currentState === 'on_track' &&
    !args.nearStop && Math.abs(args.axisAdvanceM) <= STUCK_FIX_EPS_M &&
    Math.abs(args.coordinateAdvanceM) <= STUCK_COORD_EPS_M;
}
