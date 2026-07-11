// Ephemeral selection/follow state (not persisted): which tram is selected in
// the detail sheet, and which tram the camera is following.

import { create } from 'zustand';

export interface SelectionState {
  /** Entity key of the tram whose detail sheet is open. */
  selectedTramKey: string | null;
  /** Entity key of the tram the camera is following. */
  followTramKey: string | null;
  setSelectedTramKey: (key: string | null) => void;
  setFollowTramKey: (key: string | null) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedTramKey: null,
  followTramKey: null,
  setSelectedTramKey: (selectedTramKey) => set({ selectedTramKey }),
  setFollowTramKey: (followTramKey) => set({ followTramKey }),
  clear: () => set({ selectedTramKey: null, followTramKey: null }),
}));
