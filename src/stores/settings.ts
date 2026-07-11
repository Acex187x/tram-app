// User settings store: map light preset, route-line visibility, heading lock.
// Persisted via the shared file-system storage adapter (favorites store).

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { fileSystemStorage } from './favorites';

export type LightPreset = 'auto' | 'day' | 'dusk' | 'night';

export interface SettingsState {
  lightPreset: LightPreset;
  showRouteLines: boolean;
  followHeadingLock: boolean;
  setLightPreset: (preset: LightPreset) => void;
  setShowRouteLines: (show: boolean) => void;
  setFollowHeadingLock: (lock: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      lightPreset: 'auto',
      showRouteLines: true,
      followHeadingLock: false,
      setLightPreset: (lightPreset) => set({ lightPreset }),
      setShowRouteLines: (showRouteLines) => set({ showRouteLines }),
      setFollowHeadingLock: (followHeadingLock) => set({ followHeadingLock }),
    }),
    {
      name: 'settings',
      storage: createJSONStorage(() => fileSystemStorage),
    },
  ),
);
