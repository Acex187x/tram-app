// The "schedule" variant: pure timetable-following shifted by the reported
// delay — what OneBusAway/TRAVIC-class systems render (see
// docs/research/prediction-architecture.md §4). No learning, no physics; the
// classical control line every smarter variant must beat.

import type { RouteGeometry } from '@/lib/types';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Where the schedule says the tram is at wall time tMs, given the last
 * reported delay (from the PREVIOUS fix — predictions must not peek at the
 * fix they are scored against).
 *
 * `s0Hint` (the previous fix's along-shape position) makes the variant
 * SELF-LOCATING across service-day ambiguity: the timetable is evaluated at
 * shifts {−1, 0, +1} day and the branch nearest the hint wins. This guards
 * against any residual stop-epoch anchoring error (a mis-anchored day places
 * the tram at a terminal, km away from the hint) without letting the variant
 * peek at the answer — the hint is information every variant already has.
 */
export function schedulePosition(
  geom: RouteGeometry,
  delayS: number,
  tMs: number,
  s0Hint: number,
): number | null {
  const stops = geom.stops;
  if (stops.length < 2) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (const shift of [0, -DAY_MS, DAY_MS]) {
    const p = evalAt(geom, tMs - delayS * 1000 - shift);
    if (p === null) continue;
    const d = Math.abs(p - s0Hint);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function evalAt(geom: RouteGeometry, t: number): number | null {
  const stops = geom.stops;
  if (t <= stops[0].departureMs) return stops[0].distM;
  const last = stops[stops.length - 1];
  if (t >= last.arrivalMs) return last.distM;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t <= a.departureMs) return a.distM; // dwelling at stop i
    if (t < b.arrivalMs) {
      const span = b.arrivalMs - a.departureMs;
      if (span <= 0) return a.distM;
      const f = (t - a.departureMs) / span;
      return a.distM + f * (b.distM - a.distM);
    }
  }
  return last.distM;
}
