// Ephemeral selection/follow state (not persisted): which tram is selected in
// the detail sheet, which tram the camera follows, which line is highlighted,
// and one-shot map fly-to requests from search/other sheets.

import { create } from 'zustand';

export interface FlyToTarget {
  coordinates: [number, number];
  zoom?: number;
}

export interface SelectionState {
  /** Entity key of the tram whose detail sheet is open. */
  selectedTramKey: string | null;
  /** Entity key of the tram the camera is following. */
  followTramKey: string | null;
  /**
   * True while an active follow is PAUSED: the user grabbed the map with a
   * gesture (pan/zoom/rotate/tilt), so the follow camera yields the whole
   * camera to them. `followTramKey` is kept (we remember which tram) and the
   * "Return to follow" chip re-centers on it. Any `setFollowTramKey` (tap to
   * follow, spotter hop, stop) clears this — a fresh/switched follow target is
   * always live, never paused.
   */
  followPaused: boolean;
  /** Line highlighted on the map while its sheet is open (e.g. '22'). */
  selectedLineId: string | null;
  /** One-shot camera request; the map consumes it and resets to null. */
  flyToTarget: FlyToTarget | null;
  setSelectedTramKey: (key: string | null) => void;
  setFollowTramKey: (key: string | null) => void;
  setFollowPaused: (paused: boolean) => void;
  setSelectedLineId: (line: string | null) => void;
  requestFlyTo: (target: FlyToTarget | null) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedTramKey: null,
  followTramKey: null,
  followPaused: false,
  selectedLineId: null,
  flyToTarget: null,
  setSelectedTramKey: (selectedTramKey) => set({ selectedTramKey }),
  // Switching (or clearing) the follow target always resets the paused flag:
  // a newly acquired/handed-off follow is live, and clearing follow hides both
  // follow chips.
  setFollowTramKey: (followTramKey) => set({ followTramKey, followPaused: false }),
  setFollowPaused: (followPaused) => set({ followPaused }),
  setSelectedLineId: (selectedLineId) => set({ selectedLineId }),
  requestFlyTo: (flyToTarget) => set({ flyToTarget }),
  clear: () =>
    set({ selectedTramKey: null, followTramKey: null, followPaused: false, selectedLineId: null }),
}));
