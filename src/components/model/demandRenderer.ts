import { INDICATOR_PERIOD_MS, type DoorTransition, type IndicatorDirection } from './mechanismMath';

/** No polling while the scene is stationary. A running mechanism returns its
 * next visible change, not a display-refresh heartbeat. */
export function nextMechanismFrame(
  now: number, door: DoorTransition, direction: IndicatorDirection,
  signalStartedAt: number, reduceMotion: boolean, frameMs: number,
): number | null {
  if (reduceMotion) return null;
  if (now < door.startedAtMs + door.durationMs) return frameMs;
  if (direction === 'off') return null;
  const halfPeriod = INDICATOR_PERIOD_MS / 2;
  return halfPeriod - Math.max(0, now - signalStartedAt) % halfPeriod;
}

/** Coalesces input updates and owns exactly one timeout. Rendering schedules
 * its successor only after the GL flush barrier has completed. */
export function createDemandRenderer(render: () => number | null, frameMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = Infinity;
  let lastFrame = -Infinity;
  let active = true;
  let disposed = false;
  function cancel() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    due = Infinity;
  }
  function request(delay = 0) {
    if (!active || disposed) return;
    const now = Date.now();
    const next = Math.max(now + delay, lastFrame + frameMs);
    if (next >= due) return;
    cancel();
    due = next;
    timer = setTimeout(() => {
      timer = undefined;
      due = Infinity;
      if (!active || disposed) return;
      lastFrame = Date.now();
      const nextDelay = render();
      if (nextDelay !== null) request(nextDelay);
    }, Math.max(0, next - now));
  }
  return {
    request,
    setActive(value: boolean) {
      active = value;
      cancel();
      if (active) request();
    },
    dispose() { disposed = true; cancel(); },
  };
}
