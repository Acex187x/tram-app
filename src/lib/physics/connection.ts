// The whole client physics engine, part 4: connection honesty.
//
// Protocol §"Connection honesty" (docs/research/physics-v3-protocol.md):
//
//   live      fresh bundle < 15 s          normal UI
//   degraded  15–45 s                      subtle indicator; trams keep going
//   offline   > 45 s, or fetch failing     explicit banner; trams follow their
//                                          curves to the horizon end and then
//                                          FREEZE dimmed — never animated
//                                          beyond data.
//
// The rule this file enforces is the one the old client broke: staleness is
// derived from the DATA's age (server clock − bundle build time), not from
// "did our last fetch throw". A server that keeps answering 200 OK with a
// twenty-minute-old bundle is offline, and the UI says so.

export type ConnectionState = 'live' | 'degraded' | 'offline';

/** Bundle age (s) at which the subtle degraded indicator appears. */
export const DEGRADED_AFTER_S = 15;
/** Bundle age (s) at which the app declares itself offline. */
export const OFFLINE_AFTER_S = 45;
/**
 * Consecutive failed fetches that mean "fetch failing" on their own. At the
 * 5 s poll cadence three misses ≈ 15 s of silence — enough that the bundle is
 * heading for `degraded` anyway, so this only ever makes the verdict EARLIER
 * (more honest), never later.
 */
export const OFFLINE_AFTER_FAILURES = 3;

export interface ConnectionInput {
  /** Age of the newest bundle in seconds, or null when none was ever decoded. */
  bundleAgeS: number | null;
  /** Consecutive failed fetch attempts (0 after any success). */
  consecutiveFailures: number;
}

/**
 * The 3-state verdict. Pure — the same inputs always give the same answer, so
 * the banner is testable without a network.
 *
 * Cold start (no bundle yet, nothing failed yet) reports `degraded`: we are
 * not live — there is no data — but calling a first fetch in flight "offline"
 * would flash the banner on every launch. `degraded` is exactly the honest
 * "connecting…" middle. One failure with no bundle at all IS offline: nothing
 * has ever arrived and the attempt to get it failed.
 */
export function connectionState(input: ConnectionInput): ConnectionState {
  const { bundleAgeS, consecutiveFailures } = input;
  if (bundleAgeS === null) return consecutiveFailures > 0 ? 'offline' : 'degraded';
  if (consecutiveFailures >= OFFLINE_AFTER_FAILURES) return 'offline';
  if (bundleAgeS > OFFLINE_AFTER_S) return 'offline';
  if (bundleAgeS >= DEGRADED_AFTER_S) return 'degraded';
  return 'live';
}

/** Banner copy for the offline state (the only state with an explicit banner). */
export const OFFLINE_BANNER_TEXT = 'Нет связи с сервером — данные устарели';
