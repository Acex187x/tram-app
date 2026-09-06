/** Pure timing for the viewer's explicitly selected mechanism demonstration. */
export type IndicatorDirection = 'off' | 'left' | 'right';
export interface DoorTransition {
  from: number;
  to: number;
  startedAtMs: number;
  durationMs: number;
}
export const DOOR_TRAVEL_MS = 1600;
export const INDICATOR_PERIOD_MS = 800;
export const CLOSED_DOORS: DoorTransition = {
  from: 0,
  to: 0,
  startedAtMs: 0,
  durationMs: 0,
};

export function doorProgress(
  transition: DoorTransition,
  nowMs: number,
  reduceMotion = false,
): number {
  if (reduceMotion || transition.durationMs <= 0) return transition.to;
  const u = Math.max(0, Math.min(1, (nowMs - transition.startedAtMs) / transition.durationMs));
  const eased = u * u * (3 - 2 * u);
  return transition.from + (transition.to - transition.from) * eased;
}

/** Reversing mid-travel starts at the current pose, never teleports a leaf. */
export function changeDoorTarget(
  previous: DoorTransition,
  open: boolean,
  nowMs: number,
  reduceMotion = false,
): DoorTransition {
  const from = doorProgress(previous, nowMs, reduceMotion);
  const to = open ? 1 : 0;
  return {
    from,
    to,
    startedAtMs: nowMs,
    durationMs: reduceMotion ? 0 : DOOR_TRAVEL_MS * Math.abs(to - from),
  };
}

/** Reduce Motion keeps the selected amber lamps steady rather than flashing. */
export function indicatorLit(
  direction: IndicatorDirection,
  side: 'left' | 'right',
  nowMs: number,
  startedAtMs: number,
  reduceMotion = false,
): boolean {
  return (
    direction === side &&
    (reduceMotion ||
      Math.max(0, nowMs - startedAtMs) % INDICATOR_PERIOD_MS < INDICATOR_PERIOD_MS / 2)
  );
}
