// TramRuntime — the single live-data spine of the app.
// Consumes an injected TramFeed (default LocalGolemioFeed — the "backend"
// running on the client): snapshot batches are PUSHED into the engine, trip
// geometries resolve through the feed, and calibration telemetry flows back
// out through it. The runtime itself owns the simulation: thermal-adaptive
// tick loop, engine ingest, and exposes:
//   • imperative frame access for the map (getRuntime().engine / subscribeFrame)
//   • React hooks (1 Hz) for screens/lists — useAllTramStates, useTramState, …
// The map screen renders frames imperatively via ShapeSource.setNativeProps;
// React re-renders are throttled to UI_NOTIFY_MS to keep the JS thread free.
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getModelSpec, isLikelyCoupledPair, regNumberToModelId } from '@/lib/fleet/registry';
import { TramEngine, type ProjectionCadence } from '@/lib/engine/engine';
import { toCalibrationRecords } from '@/lib/feed/calibration';
import { LocalGolemioFeed } from '@/lib/feed/localGolemioFeed';
import type { TramFeed } from '@/lib/feed/types';
import * as shapeCache from '@/lib/golemio/shapeCache';
import type { RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';
import { useSettingsStore, type PositionMode } from '@/stores/settings';

export { POLL_MS } from '@/lib/feed/localGolemioFeed';
export const TICK_MS = 16; // ~60 fps simulation while trams visibly glide (zoom ≥ 14)
/**
 * Idle tick (~10 Hz): at far zooms nothing on screen moves faster than
 * badge/dot updates, so full-rate simulation only burns CPU (thermal: iPad ran
 * hot after an hour). The map switches rates via setDetailZoom() from its
 * camera events.
 */
export const TICK_IDLE_MS = 100;
const UI_NOTIFY_MS = 1_000;
/** Re-ingest shortly after a prefetch so early geometries apply without waiting a poll. */
const GEOMETRY_NUDGE_MS = 2_500;

/**
 * Points FC (badges/dots, whole fleet) push cadence by zoom — at far zooms the
 * badges are near-static and re-pushing GeoJSON 15×/s forces Mapbox to
 * re-render constantly (GPU heat for zero visible change).
 */
export function pointsPushIntervalMs(zoom: number): number {
  if (zoom >= DETAIL_ENTER_ZOOM) return 66; // ~15 Hz — badges visibly glide
  if (zoom >= 12.5) return 1_000;
  return 5_000; // dots at city scale: one push per poll
}

/**
 * Detail-mode (60 Hz tick) zoom band, with hysteresis so hovering at the
 * boundary doesn't thrash the tick timer. ENTER is aligned with the fast
 * points cadence above: everywhere badges are pushed at ~15 Hz the engine also
 * ticks at 60 Hz — ticking at 10 Hz under 15 Hz pushes aliased badge motion
 * into visible 0-0-jump stutter (the iteration-4 smoothness regression).
 */
export const DETAIL_ENTER_ZOOM = 14.0;
export const DETAIL_EXIT_ZOOM = 13.7;

/** Pure hysteresis step: enter 60 Hz at ≥ 14.0, drop to 10 Hz only below 13.7. */
export function detailModeForZoom(zoom: number, current: boolean): boolean {
  if (zoom >= DETAIL_ENTER_ZOOM) return true;
  if (zoom < DETAIL_EXIT_ZOOM) return false;
  return current;
}

export type FrameListener = (nowMs: number) => void;

export class TramRuntime {
  readonly engine = new TramEngine({
    resolveModel: (snapshot: TramSnapshot) =>
      getModelSpec(regNumberToModelId(snapshot.registrationNumber)),
  });

  /** The data service. LocalGolemioFeed today; a RemoteFeed later — same contract. */
  private readonly feed: TramFeed;
  private refCount = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private uiNotifyTimer: ReturnType<typeof setInterval> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private feedUnsub: (() => void) | null = null;
  /**
   * Bumped whenever the runtime is paused/torn down. Deferred work (the 2.5 s
   * geometry nudge) captures the generation at schedule time and no-ops if it
   * changed — so stale completions can't mutate the engine after teardown.
   * (The feed keeps its own generation guard for in-flight polls.)
   */
  private generation = 0;
  private lastSnapshots: TramSnapshot[] = [];
  /** True while the map is in the glide band (see detailModeForZoom) → 60 Hz tick. */
  private detailMode = false;
  /** Unsubscribe from the settings store (projection cadence follows positionMode). */
  private settingsUnsub: (() => void) | null = null;

  private frameListeners = new Set<FrameListener>();
  private uiListeners = new Set<() => void>();
  private uiVersion = 0;
  private uiStatesCache: { version: number; states: TramPublicState[] } | null = null;

  constructor(feed: TramFeed = new LocalGolemioFeed()) {
    this.feed = feed;
  }

  /** Message of the last failed batch delivery, or null (status chip). */
  get lastError(): string | null {
    return this.feed.status().lastError;
  }

  /** Wall-clock ms of the last delivered snapshot batch, 0 = never (status chip). */
  get lastPollAtMs(): number {
    return this.feed.status().lastBatchAtMs;
  }

  /** Coupled-pair predicate for featureBuilder opts. */
  readonly coupledPairFn = (key: string): boolean => {
    const s = this.engine.getState(key);
    if (!s) return false;
    return isLikelyCoupledPair(s.model.id, s.snapshot.line);
  };

  retain(): void {
    this.refCount += 1;
    if (this.refCount === 1) {
      // The AppState subscription lives for the whole retained lifetime, so the
      // later 'active' transition is always observed (previously stop() removed
      // it, stranding the runtime dead after the first backgrounding).
      this.appStateSub = AppState.addEventListener('change', this.onAppState);
      // The feed subscription also spans the retained lifetime; pause/resume
      // only toggles feed.stop()/start() (a stopped feed emits nothing).
      this.feedUnsub = this.feed.subscribeSnapshots(this.onSnapshots);
      // Projection-sim cadence tracks the position-mode setting: full-rate
      // dead-reckoning is only needed while 'live' renders it every frame; in
      // 'smooth' it is consumed at ~1 Hz, so the engine coarsens it to 500 ms.
      this.applyPositionMode(useSettingsStore.getState().positionMode);
      this.settingsUnsub = useSettingsStore.subscribe((s) =>
        this.applyPositionMode(s.positionMode),
      );
      const state = AppState.currentState;
      if (state !== 'background' && state !== 'inactive') this.resume();
    }
  }

  release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) {
      this.pause();
      this.appStateSub?.remove();
      this.appStateSub = null;
      this.feedUnsub?.();
      this.feedUnsub = null;
      this.settingsUnsub?.();
      this.settingsUnsub = null;
    }
  }

  private applyPositionMode(mode: PositionMode): void {
    const cadence: ProjectionCadence = mode === 'live' ? 'full' : 'coarse';
    this.engine.setProjectionCadence(cadence);
  }

  /** Start the timer loops + the feed (which polls immediately). Idempotent. */
  private resume(): void {
    if (this.tickTimer) return;
    this.startTickTimer();
    this.uiNotifyTimer = setInterval(() => this.bumpUi(), UI_NOTIFY_MS);
    this.feed.start();
  }

  private startTickTimer(): void {
    this.tickTimer = setInterval(
      () => {
        const now = Date.now();
        this.engine.tick(now);
        this.frameListeners.forEach((l) => l(now));
      },
      this.detailMode ? TICK_MS : TICK_IDLE_MS,
    );
  }

  /**
   * Zoom-adaptive simulation rate (thermal): 60 Hz while zoomed into the glide
   * band (badges pushed at ~15 Hz and/or 3D models on screen), ~10 Hz at far
   * zooms — with hysteresis (enter ≥ 14.0, exit < 13.7) so camera drift at the
   * boundary can't thrash the timer. Called by the map screen from camera
   * events; restarts the tick timer only on an actual mode change and only
   * while running (a paused/backgrounded runtime stays fully idle).
   */
  setDetailZoom(zoom: number): void {
    const on = detailModeForZoom(zoom, this.detailMode);
    if (this.detailMode === on) return;
    this.detailMode = on;
    if (__DEV__) console.log(`[tram-runtime] tick rate → ${on ? '60 Hz (glide band)' : '10 Hz (idle)'}`);
    if (!this.tickTimer) return; // paused — resume() picks up the new rate
    clearInterval(this.tickTimer);
    this.startTickTimer();
  }

  /**
   * Halt timers, the feed, and all outstanding async work WITHOUT removing the
   * AppState/feed subscriptions (used on background). feed.stop() aborts the
   * in-flight poll; the pending nudge is cancelled and the generation bumped so
   * any late completions no-op.
   */
  private pause(): void {
    this.generation += 1;
    for (const t of [this.tickTimer, this.uiNotifyTimer]) {
      if (t) clearInterval(t);
    }
    this.tickTimer = this.uiNotifyTimer = null;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.feed.stop();
  }

  private readonly onAppState = (status: AppStateStatus): void => {
    if (this.refCount === 0) return;
    if (status === 'active') {
      if (!this.tickTimer) this.resume();
    } else if (this.tickTimer) {
      this.pause();
    }
  };

  /**
   * One fresh snapshot batch from the feed → engine ingest + calibration
   * report + geometry warm-up. This is the push-side replacement for the old
   * inline poll body (the fetch/abort/status plumbing now lives in the feed).
   */
  private readonly onSnapshots = (snapshots: TramSnapshot[], atMs: number): void => {
    const gen = this.generation;
    this.lastSnapshots = snapshots;
    this.engine.ingest(snapshots, (tripId) => this.feed.getGeometry(tripId), atMs);
    this.feed.reportCalibration(toCalibrationRecords(this.engine.getStates(atMs), atMs));
    // Warm geometries for trips we don't have yet (background priority).
    const missing = snapshots.filter((s) => !this.feed.getGeometry(s.tripId)).map((s) => s.tripId);
    if (missing.length > 0) {
      this.feed.requestGeometry(missing, 2);
      // As geometries arrive, they are adopted on the next ingest; nudge one
      // extra ingest shortly after so early geometries apply without waiting
      // a full poll cycle. Tracked so teardown can cancel it.
      this.nudgeTimer = setTimeout(() => {
        this.nudgeTimer = null;
        if (gen !== this.generation) return;
        this.engine.ingest(this.lastSnapshots, (tripId) => this.feed.getGeometry(tripId), Date.now());
        this.bumpUi();
      }, GEOMETRY_NUDGE_MS);
    }
    this.bumpUi();
  };

  /** Raise fetch priority for the selected/followed tram's geometry. */
  prioritizeTrip(tripId: string | null | undefined): void {
    if (!tripId) return;
    this.feed.promoteGeometry(tripId);
  }

  subscribeFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  // — React (1 Hz) subscriptions —

  private bumpUi(): void {
    // No UI subscriber → skip entirely; bumping the version would only
    // invalidate the states cache and force a full getStates() allocation
    // for nobody (1 Hz background churn, thermal).
    if (this.uiListeners.size === 0) return;
    this.uiVersion += 1;
    this.uiListeners.forEach((l) => l());
  }

  readonly subscribeUi = (listener: () => void): (() => void) => {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  };

  readonly getUiVersion = (): number => this.uiVersion;

  getStatesCached(): TramPublicState[] {
    if (!this.uiStatesCache || this.uiStatesCache.version !== this.uiVersion) {
      this.uiStatesCache = { version: this.uiVersion, states: this.engine.getStates(Date.now()) };
    }
    return this.uiStatesCache.states;
  }
}

let runtime: TramRuntime | null = null;

/** The app-wide runtime singleton (created lazily, on the default local feed). */
export function getRuntime(): TramRuntime {
  if (!runtime) runtime = new TramRuntime();
  return runtime;
}

/** Keep the runtime alive while the calling component is mounted. */
export function useTramRuntime(): TramRuntime {
  const rt = getRuntime();
  useEffect(() => {
    rt.retain();
    return () => rt.release();
  }, [rt]);
  return rt;
}

/** All tram states, refreshed ~1 Hz. Safe for lists/screens. */
export function useAllTramStates(): TramPublicState[] {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  return rt.getStatesCached();
}

/** One tram's state by key (registration number string), ~1 Hz. */
export function useTramState(key: string | null | undefined): TramPublicState | undefined {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  return key ? rt.engine.getState(key, Date.now()) : undefined;
}

/**
 * All loaded route geometries (grows as shapes stream in), ~1 Hz. NOTE: this
 * enumerates the local shape cache directly — bulk enumeration (planner graph)
 * is deliberately outside the TramFeed contract for now; a remote feed still
 * fills the same local cache, so this keeps working unchanged.
 */
export function useLoadedGeometries(): RouteGeometry[] {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  return shapeCache.getAllLoaded();
}
