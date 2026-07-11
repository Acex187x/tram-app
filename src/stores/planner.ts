// Planner result shared between the planner sheet and the map (route highlight).
import { create } from 'zustand';

import type { PlannerItinerary } from '@/lib/types';

interface PlannerState {
  /** Itinerary currently shown on the map, or null. */
  itinerary: PlannerItinerary | null;
  setItinerary: (itinerary: PlannerItinerary | null) => void;
}

export const usePlannerStore = create<PlannerState>((set) => ({
  itinerary: null,
  setItinerary: (itinerary) => set({ itinerary }),
}));
