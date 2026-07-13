// Ephemeral "show a recorded ride on the map" state (not persisted). The rides
// sheet parses a ride file and sets it here; the map's RideOverlay draws the
// GPS + sim tracks once (static overlay — no ticking), and the RideChip in
// MapChrome clears it.

import { create } from 'zustand';

import type { ParsedRide } from '@/lib/motionlog/rideFile';

export interface RidePreview {
  /** relPath of the source file (identity — reopening the same ride is a no-op). */
  relPath: string;
  /** Basename for the chip label. */
  name: string;
  ride: ParsedRide;
}

export interface RidePreviewState {
  preview: RidePreview | null;
  setPreview: (preview: RidePreview | null) => void;
}

export const useRidePreviewStore = create<RidePreviewState>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
}));
