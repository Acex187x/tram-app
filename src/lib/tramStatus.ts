// One-line LIVE status for a tram, as prose — "At Karlovo náměstí",
// "Next Lehovec · 2 min", "Not in service". Pure, no React, no IO, so it is
// unit-testable and can be recomputed on the shared 1 Hz UI tick like every
// other live string in the app (mirrors src/lib/arrivals.ts).
//
// WHY THE DWELL STOP COMES FROM THE GEOMETRY. `state.nextStopName` is the stop
// AHEAD of the tram: while a tram is dwelling AT a platform, the engine has
// already advanced it to the following stop (same convention StopsTimeline
// documents). So "at X" cannot be read off the state at all — the standing stop
// is the first stop of the tram's own trip geometry at or past `simDistM`,
// within the engine's 2 m dwell tolerance.

import { formatEtaMinutes } from '@/lib/arrivals';
import type { RouteGeometry, TramPublicState } from '@/lib/types';

/**
 * Matches the engine's dwell tolerance (and `arrivals.ts`'s STOP_SLACK_M): a
 * tram parked at a platform reports a `simDistM` a hair short of the stop's own
 * `distM`, so the "first stop still ahead" scan has to allow for it.
 */
const STOP_SLACK_M = 2;

/**
 * Live status line for a favourited/listed tram.
 *
 * @param state       ~1 Hz public state (`useTramState`), or undefined when the
 *                    car is not in the current feed (garage, off shift).
 * @param geometries  loaded route geometries (`useLoadedGeometries`). Lift this
 *                    read to the LIST, not the row: N rows share one array.
 */
export function tramStatusLine(
  state: TramPublicState | undefined,
  geometries: RouteGeometry[],
): string {
  if (!state) return 'Not in service';
  // The tram is in the feed but has no shape yet (geometry still streaming in),
  // so there is no route to place it on — say so instead of guessing.
  if (!state.hasGeometry) return 'Locating on route…';

  const geo = geometries.find((g) => g.tripId === state.snapshot.tripId);
  if (!geo) return 'Locating on route…';

  const here = geo.stops.find((s) => s.distM >= state.simDistM - STOP_SLACK_M);

  if (state.phase === 'terminal') return `At ${here?.name ?? 'terminus'} · terminus`;
  if (state.phase === 'dwell' && here) return `At ${here.name}`;
  if (state.nextStopName != null) {
    return state.nextStopEtaS != null
      ? `Next ${state.nextStopName} · ${formatEtaMinutes(state.nextStopEtaS)}`
      : `Next ${state.nextStopName}`;
  }
  return `→ ${state.snapshot.headsign}`;
}
