// Ephemeral selection/follow state (not persisted): which tram is selected in
// the detail sheet, which tram the camera follows, which line is highlighted,
// and one-shot map fly-to requests from search/other sheets.

import { create } from 'zustand';

export interface FlyToTarget {
  coordinates: [number, number];
  zoom?: number;
}

export interface SelectionState {
  /**
   * Entity key of the tram whose OWNED detail sheet is presented on the map
   * screen. This is presentation state, not navigation state: the tram card is
   * no longer a router formSheet but a sibling of the home sheet on `/`, so
   * "which tram is open" is a store field rather than a route.
   *
   * Why it is separate from `selectedTramKey`: selection is the map's gold halo
   * and is also claimed by transient surfaces; PRESENTATION is what the map
   * screen swaps the home sheet out for, and what the chrome ride follows. They
   * move together today, but conflating them is exactly what made the old
   * `/tram/[key]` formSheet leave a stale halo when a push site forgot to set
   * one of them.
   */
  presentedTramKey: string | null;
  /** Entity key of the tram selected on the map (drives the gold halo). */
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
  /**
   * Present the tram card for `key`. ONE action for everything opening a tram
   * used to have to do by hand on the same tick as its `router.push`: claim the
   * halo, engage follow, and (now) present the sheet. Two of the six call sites
   * forgot the halo, which is what left the map with no selection ring when a
   * tram was opened from the line or stop sheets.
   *
   * Engaging follow here matches the old screen's mount effect exactly (and, as
   * there, follow deliberately SURVIVES the close — only the ✕ ends it).
   */
  openTram: (key: string) => void;
  /**
   * Dismiss the tram card. This is the ✕'s full semantics: the sheet goes away,
   * the halo is released AND the follow it engaged ends — the map returns to
   * exactly the state it was in before the tram was opened.
   */
  closeTram: () => void;
  setFollowTramKey: (key: string | null) => void;
  setFollowPaused: (paused: boolean) => void;
  setSelectedLineId: (line: string | null) => void;
  requestFlyTo: (target: FlyToTarget | null) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  presentedTramKey: null,
  selectedTramKey: null,
  followTramKey: null,
  followPaused: false,
  selectedLineId: null,
  flyToTarget: null,
  setSelectedTramKey: (selectedTramKey) => set({ selectedTramKey }),
  // One atomic write, so the map screen sees present + select + follow in a
  // single render: a two-step (select, then present) briefly showed the home
  // sheet's own hide animation racing the tram card's entrance.
  openTram: (key) =>
    set({
      presentedTramKey: key,
      selectedTramKey: key,
      followTramKey: key,
      followPaused: false,
    }),
  closeTram: () =>
    set({
      presentedTramKey: null,
      selectedTramKey: null,
      followTramKey: null,
      followPaused: false,
    }),
  // Switching (or clearing) the follow target always resets the paused flag:
  // a newly acquired/handed-off follow is live, and clearing follow hides both
  // follow chips.
  setFollowTramKey: (followTramKey) => set({ followTramKey, followPaused: false }),
  setFollowPaused: (followPaused) => set({ followPaused }),
  setSelectedLineId: (selectedLineId) => set({ selectedLineId }),
  requestFlyTo: (flyToTarget) => set({ flyToTarget }),
  clear: () =>
    set({
      presentedTramKey: null,
      selectedTramKey: null,
      followTramKey: null,
      followPaused: false,
      selectedLineId: null,
    }),
}));
