// User settings store: map light preset, route-line visibility, heading lock,
// passive fleet logging. Persisted via the shared file-system storage adapter
// (favorites store).

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { DEFAULT_ICON_PACK, type IconPackId } from '@/lib/fleet/iconPacks';

import { fileSystemStorage } from './favorites';

export type LightPreset = 'auto' | 'day' | 'dusk' | 'night';
/**
 * Which of the server's two published curves the map draws
 * (docs/research/physics-v3-protocol.md §"Two render modes"):
 *   'smooth' — DEFAULT. The continuity track: the server bakes the join
 *              between consecutive predictions into the curve, so the tram
 *              never teleports except at a flagged discontinuity.
 *   'fixed'  — «Более точное положение». The raw model-opinion track, which
 *              re-anchors on every fix and is allowed to jump. It exists to be
 *              visibly beaten by smooth; `TramPublicState.deviationM` measures
 *              the gap between them.
 *
 * The old four-way engine-layer picker ('live'/'raw'/'ml') died with the
 * engine — see the persist migration below, which folds every retired value
 * into 'smooth'.
 */
export type PositionMode = 'smooth' | 'fixed';

/** Coerce any persisted/legacy value to a mode this build understands. */
export function normalizePositionMode(value: unknown): PositionMode {
  return value === 'fixed' ? 'fixed' : 'smooth';
}

/**
 * Which server-side physics GENERATION publishes the curves — a different axis
 * from `positionMode`, which picks between the two tracks inside whichever
 * bundle arrives:
 *   'current' — DEFAULT. Today's shipped predictor; sent as a bare request.
 *   'v3'      — the new drive-v3 physics (both tracks regenerated).
 *   'mix'     — fixed(opinion) from v3, smooth from current.
 *
 * INERT since 2026-08-21 (the promotion): the engine is chosen, the app rides
 * the one published Convex stream, and nothing reads this setting anymore —
 * the field and its setter survive only so persisted settings JSON from older
 * installs keeps round-tripping without a migration (same story as FeedSource).
 */
export type PhysicsEngine = 'current' | 'v3' | 'mix';

/** Coerce any persisted/unknown value to a generation this build can request. */
export function normalizePhysicsEngine(value: unknown): PhysicsEngine {
  return value === 'v3' || value === 'mix' ? value : 'current';
}
/**
 * Live-data source. INERT since 2026-08-08: the runtime constructs RemoteFeed
 * unconditionally (hooks/tramData.ts) and nothing reads this setting anymore —
 * the field and its setter survive only so persisted settings JSON from older
 * installs keeps round-tripping without a migration.
 */
export type FeedSource = 'local' | 'remote';

export interface SettingsState {
  lightPreset: LightPreset;
  positionMode: PositionMode;
  /** Server physics generation the trajectory bundle is fetched from. */
  physicsEngine: PhysicsEngine;
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
  setPhysicsEngine: (engine: PhysicsEngine) => void;
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
      physicsEngine: 'current',
      showRouteLines: true,
      followHeadingLock: false,
      passiveFleetLogging: true,
      feedSource: 'remote',
      iconPack: DEFAULT_ICON_PACK,
      debugMode: false,
      setLightPreset: (lightPreset) => set({ lightPreset }),
      setPositionMode: (positionMode) =>
        set({ positionMode: normalizePositionMode(positionMode) }),
      setPhysicsEngine: (physicsEngine) =>
        set({ physicsEngine: normalizePhysicsEngine(physicsEngine) }),
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
      /**
       * v2 = physics v3's two-mode picker. Installs persisted 'live' / 'raw' /
       * 'ml' against the deleted engine layers; rehydrating one of those
       * verbatim would leave the store holding a mode no code can render.
       * Every retired value folds into the default.
       */
      version: 2,
      migrate: (persisted, _version) => {
        const state = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...state,
          positionMode: normalizePositionMode(state.positionMode),
          physicsEngine: normalizePhysicsEngine(state.physicsEngine),
        } as SettingsState;
      },
    },
  ),
);
