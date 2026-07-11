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
  /** Line highlighted on the map while its sheet is open (e.g. '22'). */
  selectedLineId: string | null;
  /** One-shot camera request; the map consumes it and resets to null. */
  flyToTarget: FlyToTarget | null;
  setSelectedTramKey: (key: string | null) => void;
  setFollowTramKey: (key: string | null) => void;
  setSelectedLineId: (line: string | null) => void;
  requestFlyTo: (target: FlyToTarget | null) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedTramKey: null,
  followTramKey: null,
  selectedLineId: null,
  flyToTarget: null,
  setSelectedTramKey: (selectedTramKey) => set({ selectedTramKey }),
  setFollowTramKey: (followTramKey) => set({ followTramKey }),
  setSelectedLineId: (selectedLineId) => set({ selectedLineId }),
  requestFlyTo: (flyToTarget) => set({ flyToTarget }),
  clear: () => set({ selectedTramKey: null, followTramKey: null, selectedLineId: null }),
}));
