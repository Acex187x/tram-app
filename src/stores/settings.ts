// User settings store: map light preset, route-line visibility, heading lock,
// passive fleet logging. Persisted via the shared file-system storage adapter
// (favorites store).

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
  /**
   * Passive fleet logging: every snapshot batch's full-fleet sim-vs-reality
   * deviation records are buffered and written to the daily JSONL for physics
   * calibration (~25 MB/h before disk caps). DEFAULT ON — a deliberate choice
   * while the app is in its single-user calibration phase; ride recording is
   * an independent stream and ignores this switch.
   */
  passiveFleetLogging: boolean;
  setLightPreset: (preset: LightPreset) => void;
  setPositionMode: (mode: PositionMode) => void;
  setShowRouteLines: (show: boolean) => void;
  setFollowHeadingLock: (lock: boolean) => void;
  setPassiveFleetLogging: (on: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      lightPreset: 'auto',
      positionMode: 'smooth',
      showRouteLines: true,
      followHeadingLock: false,
      passiveFleetLogging: true,
      setLightPreset: (lightPreset) => set({ lightPreset }),
      setPositionMode: (positionMode) => set({ positionMode }),
      setShowRouteLines: (showRouteLines) => set({ showRouteLines }),
      setFollowHeadingLock: (followHeadingLock) => set({ followHeadingLock }),
      setPassiveFleetLogging: (passiveFleetLogging) => set({ passiveFleetLogging }),
    }),
    {
      name: 'settings',
      storage: createJSONStorage(() => fileSystemStorage),
    },
  ),
);
