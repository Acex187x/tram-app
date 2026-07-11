// Planner result shared between the planner sheet and the map (route highlight),
// plus persisted recent from→to searches and a one-shot prefill handoff used by
// the stop sheet's "Route here" action to open the planner pre-filled + auto-plan.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { PlannerItinerary } from '@/lib/types';
import { normalizeName } from '@/lib/planner/network';
import { fileSystemStorage } from './favorites';

/** Max remembered from→to pairs (most-recent first). */
export const MAX_RECENTS = 8;

/** A remembered journey search — display names + when it was last planned. */
export interface RecentRoute {
  from: string;
  to: string;
  /** Unix ms of the last time this pair was planned. */
  ts: number;
}

/** One-shot instruction to open the planner pre-filled and auto-plan. */
export interface PlannerPrefill {
  from: string;
  to: string;
}

interface PlannerState {
  /** Itinerary currently shown on the map, or null. */
  itinerary: PlannerItinerary | null;
  setItinerary: (itinerary: PlannerItinerary | null) => void;

  /** Persisted recent searches, most-recent first (≤ MAX_RECENTS). */
  recents: RecentRoute[];
  /** Record a successful plan; dedupes on the normalized pair and moves it to front. */
  addRecent: (from: string, to: string) => void;
  /** Drop a remembered pair (matched by normalized from+to). */
  removeRecent: (from: string, to: string) => void;

  /**
   * Pending prefill for the planner screen. Set by the stop sheet's "Route
   * here" button (nearest stop → this stop); the planner consumes it on mount,
   * fills the fields and auto-plans, then clears it via clearPrefill().
   */
  prefill: PlannerPrefill | null;
  requestPrefill: (from: string, to: string) => void;
  clearPrefill: () => void;
}

function samePair(a: RecentRoute, from: string, to: string): boolean {
  return (
    normalizeName(a.from) === normalizeName(from) &&
    normalizeName(a.to) === normalizeName(to)
  );
}

export const usePlannerStore = create<PlannerState>()(
  persist(
    (set) => ({
      itinerary: null,
      setItinerary: (itinerary) => set({ itinerary }),

      recents: [],
      addRecent: (from, to) =>
        set((state) => {
          const f = from.trim();
          const t = to.trim();
          if (f.length === 0 || t.length === 0) return {};
          const filtered = state.recents.filter((r) => !samePair(r, f, t));
          return {
            recents: [{ from: f, to: t, ts: Date.now() }, ...filtered].slice(0, MAX_RECENTS),
          };
        }),
      removeRecent: (from, to) =>
        set((state) => ({
          recents: state.recents.filter((r) => !samePair(r, from, to)),
        })),

      prefill: null,
      requestPrefill: (from, to) => set({ prefill: { from, to } }),
      clearPrefill: () => set({ prefill: null }),
    }),
    {
      name: 'planner',
      storage: createJSONStorage(() => fileSystemStorage),
      // Only the recent searches persist; the drawn itinerary and the one-shot
      // prefill handoff are ephemeral session state.
      partialize: (state) => ({ recents: state.recents }),
    },
  ),
);
