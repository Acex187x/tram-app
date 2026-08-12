// User settings store: map light preset, route-line visibility, heading lock,
// passive fleet logging. Persisted via the shared file-system storage adapter
// (favorites store).

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { DEFAULT_ICON_PACK, type IconPackId } from '@/lib/fleet/iconPacks';

import { fileSystemStorage } from './favorites';

export type LightPreset = 'auto' | 'day' | 'dusk' | 'night';
/**
 * Tram positioning (engine v2 render anchors, docs/decisions/engine-v2.md §2):
 *   'smooth' — the cinematic smoother (layer 2);
 *   'live'   — the predictor's best estimate of the real tram now (layer 1);
 *   'raw'    — the last reported AVL fix, jumping on every update (layer 0);
 *   'ml'     — EXPERIMENTAL: the research lab's published trajectory keyframes,
 *              dumb-lerped (src/lib/feed/mlTrajectories.ts). Not an engine
 *              layer at all — the engine keeps ticking underneath exactly as in
 *              'raw', and a vehicle without a trajectory renders its raw fix.
 * Persisted as a plain string; older installs stored only 'smooth' | 'live',
 * which remain valid members — no migration needed.
 */
export type PositionMode = 'smooth' | 'live' | 'raw' | 'ml';
/**
 * Live-data source (backend rollout, docs/decisions/backend-convex.md §7):
 *   'local'  — LocalGolemioFeed, the on-client 5 s Golemio poll loop (default);
 *   'remote' — RemoteFeed over the Convex backend (requires
 *              EXPO_PUBLIC_CONVEX_URL; silently falls back to local without it).
 * Read once at runtime construction — changing it takes effect on next launch.
 */
export type FeedSource = 'local' | 'remote';

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
  /** Live-data source; see FeedSource. */
  feedSource: FeedSource;
  /** Selected tram icon pack (face art on badges, sheets, settings). */
  iconPack: IconPackId;
  /**
   * Developer debug mode: mounts the live physics/GPS debug overlay over the
   * map (utilitarian, 10 Hz while expanded, followed-tram only). Off by default; when off the
   * overlay is never mounted and costs nothing.
   */
  debugMode: boolean;
  setLightPreset: (preset: LightPreset) => void;
  setPositionMode: (mode: PositionMode) => void;
  setShowRouteLines: (show: boolean) => void;
  setFollowHeadingLock: (lock: boolean) => void;
  setPassiveFleetLogging: (on: boolean) => void;
  setFeedSource: (source: FeedSource) => void;
  setIconPack: (pack: IconPackId) => void;
  setDebugMode: (on: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      lightPreset: 'auto',
      positionMode: 'smooth',
      showRouteLines: true,
      followHeadingLock: false,
      passiveFleetLogging: true,
      feedSource: 'local',
      iconPack: DEFAULT_ICON_PACK,
      debugMode: false,
      setLightPreset: (lightPreset) => set({ lightPreset }),
      setPositionMode: (positionMode) => set({ positionMode }),
      setShowRouteLines: (showRouteLines) => set({ showRouteLines }),
      setFollowHeadingLock: (followHeadingLock) => set({ followHeadingLock }),
      setPassiveFleetLogging: (passiveFleetLogging) => set({ passiveFleetLogging }),
      setFeedSource: (feedSource) => set({ feedSource }),
      setIconPack: (iconPack) => set({ iconPack }),
      setDebugMode: (debugMode) => set({ debugMode }),
    }),
    {
      name: 'settings',
      storage: createJSONStorage(() => fileSystemStorage),
    },
  ),
);
