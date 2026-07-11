// User settings store: map light preset, route-line visibility, heading lock.
// Persisted via the shared file-system storage adapter (favorites store).

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { fileSystemStorage } from './favorites';

export type LightPreset = 'auto' | 'day' | 'dusk' | 'night';
/** Tram positioning: physics-interpolated vs raw last-reported AVL fixes. */
export type PositionMode = 'smooth' | 'live';

export interface SettingsState {
  lightPreset: LightPreset;
  positionMode: PositionMode;
  showRouteLines: boolean;
  followHeadingLock: boolean;
  setLightPreset: (preset: LightPreset) => void;
  setPositionMode: (mode: PositionMode) => void;
  setShowRouteLines: (show: boolean) => void;
  setFollowHeadingLock: (lock: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      lightPreset: 'auto',
      positionMode: 'smooth',
      showRouteLines: true,
      followHeadingLock: false,
      setLightPreset: (lightPreset) => set({ lightPreset }),
      setPositionMode: (positionMode) => set({ positionMode }),
      setShowRouteLines: (showRouteLines) => set({ showRouteLines }),
      setFollowHeadingLock: (followHeadingLock) => set({ followHeadingLock }),
    }),
    {
      name: 'settings',
      storage: createJSONStorage(() => fileSystemStorage),
    },
  ),
);
