// PollIndicator — the poll-cycle ring inside the top-left status chip.
//
// A discrete 5-segment countdown ring for the 5 s positions poll: one segment
// lights per second of the cycle, all five light while a fetch is in flight,
// and the tint switches to the warning palette on stale data / errors.
//
// PERF INVARIANT-FRIENDLY BY CONSTRUCTION (docs/performance.md #1/#2): the
// component owns NO timers and NO Animated loops. It re-renders only when the
// parent chip re-renders on the runtime's shared 1 Hz UI notification
// (useFeedStatus rides subscribeUi), and each render merely recolors five
// static Views. Nothing here can tick faster than 1 Hz or touch the map.

import { StyleSheet, View } from 'react-native';

import { Tram } from '@/constants/theme';
import { POLL_MS, useFeedStatus } from '@/hooks/tramData';

export const POLL_RING_SEGMENTS = 5;

/** Data older than this (or an errored poll) renders the warning palette. */
export const STALE_AFTER_MS = 30_000;

export type PollState = 'ok' | 'fetching' | 'stale' | 'error' | 'off';

export interface PollModel {
  state: PollState;
  /** Ring segments lit, 0..POLL_RING_SEGMENTS (elapsed fraction of the cycle). */
  filled: number;
  /** Seconds since the last successful batch, null = never synced. */
  ageSeconds: number | null;
  /** Short human detail for the expanded chip, e.g. "updated 3 s ago". */
  detail: string;
}

/**
 * Derive the indicator model from feed health, at the shared ~1 Hz UI cadence.
 * The ring FILLS as the next fetch approaches and resets when a poll starts;
 * with a 5 s cycle and 1 Hz updates that is one new segment per second.
 */
export function usePollModel(): PollModel {
  const status = useFeedStatus(); // ~1 Hz via the runtime's subscribeUi
  // The wall clock IS the datum here (elapsed fraction of the poll cycle),
  // sampled once per 1 Hz notification — same sanctioned pattern as
  // useTramState(key, Date.now()) in hooks/tramData.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const ageMs = status.lastBatchAtMs > 0 ? now - status.lastBatchAtMs : null;
  const stale = ageMs == null || ageMs > STALE_AFTER_MS;

  let state: PollState;
  if (status.pollIntervalMs === 0) state = 'off';
  else if (status.lastError != null) state = 'error';
  else if (stale) state = 'stale';
  else if (status.inFlight) state = 'fetching';
  else state = 'ok';

  const interval = status.pollIntervalMs || POLL_MS;
  const elapsed = status.lastFetchAtMs > 0 ? now - status.lastFetchAtMs : 0;
  const frac = Math.min(1, Math.max(0, elapsed / interval));
  const filled =
    state === 'fetching'
      ? POLL_RING_SEGMENTS
      : Math.min(POLL_RING_SEGMENTS, Math.round(frac * POLL_RING_SEGMENTS));

  const ageSeconds = ageMs != null ? Math.max(0, Math.round(ageMs / 1000)) : null;
  const agoText = ageSeconds != null ? `${ageSeconds} s ago` : 'never';
  let detail: string;
  switch (state) {
    case 'off':
      detail = 'paused';
      break;
    case 'error':
      detail = `offline · synced ${agoText}`;
      break;
    case 'stale':
      detail = `stale · synced ${agoText}`;
      break;
    case 'fetching':
      detail = 'updating…';
      break;
    default:
      detail = ageSeconds != null ? `updated ${agoText}` : 'connecting…';
  }

  return { state, filled, ageSeconds, detail };
}

export interface PollRingProps {
  model: PollModel;
  /** Filled-segment color for the healthy state (adaptive chrome label color). */
  color: string;
  /** Unfilled-segment color (adaptive faint label color). */
  dimColor: string;
  /** Outer diameter, pt. */
  size?: number;
}

/** State → center-dot / warning-ring tint. */
function stateAccent(state: PollState): string | null {
  switch (state) {
    case 'error':
      return Tram.veryLate;
    case 'stale':
      return Tram.late;
    case 'ok':
    case 'fetching':
      return Tram.onTime;
    default:
      return null; // off — dot rendered in dimColor
  }
}

/**
 * The ring itself: 5 tick segments around a center status dot, pure static
 * Views (see the header note — deliberately no animation).
 */
export function PollRing({ model, color, dimColor, size = 22 }: PollRingProps) {
  const accent = stateAccent(model.state);
  const warning = model.state === 'error' || model.state === 'stale';
  const litColor = warning ? (accent as string) : color;
  const segments: React.JSX.Element[] = [];
  for (let i = 0; i < POLL_RING_SEGMENTS; i++) {
    segments.push(
      <View
        key={i}
        style={[
          styles.segment,
          {
            backgroundColor: i < model.filled ? litColor : dimColor,
            transform: [
              { rotate: `${(i * 360) / POLL_RING_SEGMENTS}deg` },
              { translateY: -(size / 2 - SEG_H / 2) },
            ],
          },
        ]}
      />,
    );
  }
  return (
    <View style={[styles.ring, { width: size, height: size }]} pointerEvents="none">
      {segments}
      <View style={[styles.dot, { backgroundColor: accent ?? dimColor }]} />
    </View>
  );
}

const SEG_W = 2.5;
const SEG_H = 6;

const styles = StyleSheet.create({
  ring: { alignItems: 'center', justifyContent: 'center' },
  segment: {
    position: 'absolute',
    width: SEG_W,
    height: SEG_H,
    borderRadius: SEG_W / 2,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
});
