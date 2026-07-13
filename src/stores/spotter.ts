// Ephemeral "spot this stop" session state (not persisted). The stop sheet
// starts it, SpotterController (mounted on the map screen) runs the 1 Hz
// target loop and mirrors the current target here for the SpotterChip, and
// the chip's ✕ — or any user camera takeover — stops it.

import { create } from 'zustand';

export interface SpotterStation {
  /** Normalized station key (same key space as /stop/[key]). */
  key: string;
  /** Display name for the chip. */
  name: string;
  /** Representative platform coordinate — fly-in + waiting camera. */
  coordinates: [number, number];
}

/** Chip mirror of the tram currently being spotted. */
export interface SpotterTargetDisplay {
  tramKey: string;
  line: string;
  /** Seconds until it reaches the spotted stop (0 while dwelling there). */
  etaS: number;
}

export interface SpotterState {
  /** Station being spotted; null = spotter off (the controller unmounts). */
  station: SpotterStation | null;
  /** Current target (written ~1 Hz by SpotterController; null = waiting). */
  target: SpotterTargetDisplay | null;
  start: (station: SpotterStation) => void;
  stop: () => void;
  setTarget: (target: SpotterTargetDisplay | null) => void;
}

export const useSpotterStore = create<SpotterState>((set) => ({
  station: null,
  target: null,
  start: (station) => set({ station, target: null }),
  stop: () => set({ station: null, target: null }),
  // Value-equal writes return the previous state object so zustand skips the
  // notify — the chip only re-renders when the displayed target/ETA changes.
  setTarget: (target) =>
    set((prev) =>
      prev.target === target ||
      (prev.target !== null &&
        target !== null &&
        prev.target.tramKey === target.tramKey &&
        prev.target.line === target.line &&
        prev.target.etaS === target.etaS)
        ? prev
        : { ...prev, target },
    ),
}));
