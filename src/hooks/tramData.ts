// TramRuntime — the single live-data spine of the app.
// Polls Golemio every POLL_MS, feeds TramEngine, drives simulation ticks at
// TICK_MS (~60 Hz), prefetches trip geometries, and exposes:
//   • imperative frame access for the map (getRuntime().engine / subscribeFrame)
//   • React hooks (1 Hz) for screens/lists — useAllTramStates, useTramState, …
// The map screen renders frames imperatively via ShapeSource.setNativeProps;
// React re-renders are throttled to UI_NOTIFY_MS to keep the JS thread free.
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getModelSpec, isLikelyCoupledPair, regNumberToModelId } from '@/lib/fleet/registry';
import { TramEngine } from '@/lib/engine/engine';
import { promoteTag } from '@/lib/golemio/client';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { fetchTramSnapshots } from '@/lib/golemio/vehicles';
import type { RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';

export const POLL_MS = 5_000;
export const TICK_MS = 16; // ~60 fps simulation while the 3D model band is on screen
/**
 * Idle tick (~10 Hz): below the sections zoom band nothing on screen moves
 * faster than badge/dot updates, so full-rate simulation only burns CPU
 * (thermal: iPad ran hot after an hour). The map switches rates via
 * setDetailMode() from its camera events.
 */
export const TICK_IDLE_MS = 100;
const UI_NOTIFY_MS = 1_000;

/**
 * Points FC (badges/dots, whole fleet) push cadence by zoom — at far zooms the
 * badges are near-static and re-pushing GeoJSON 15×/s forces Mapbox to
 * re-render constantly (GPU heat for zero visible change).
 */
export function pointsPushIntervalMs(zoom: number): number {
  if (zoom >= 14) return 66; // ~15 Hz — badges visibly glide
  if (zoom >= 12.5) return 1_000;
  return 5_000; // dots at city scale: one push per poll
}

export type FrameListener = (nowMs: number) => void;

/** Contract with src/lib/motionlog (ships in a parallel workstream). */
interface MotionLogModule {
  getMotionLog(): { onPoll(states: TramPublicState[], nowMs: number): void };
}

let motionLogModule: MotionLogModule | null | undefined;

/**
 * Feed each successful poll ingest to the motion logger. Defensive by
 * contract: the module may not exist until integration, and logging must
 * never break the poll loop.
 */
function notifyMotionLog(states: TramPublicState[], nowMs: number): void {
  if (motionLogModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      motionLogModule = require('@/lib/motionlog') as MotionLogModule;
    } catch {
      motionLogModule = null;
    }
  }
  if (!motionLogModule?.getMotionLog) return;
  try {
    motionLogModule.getMotionLog().onPoll(states, nowMs);
  } catch {
    // Logger errors must never disturb the runtime.
  }
}

class TramRuntime {
  readonly engine = new TramEngine({
    resolveModel: (snapshot: TramSnapshot) =>
      getModelSpec(regNumberToModelId(snapshot.registrationNumber)),
  });

  private refCount = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private uiNotifyTimer: ReturnType<typeof setInterval> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private pollInFlight = false;
  private pollAbort: AbortController | null = null;
  /**
   * Bumped whenever the runtime is paused/torn down. Async work (in-flight
   * poll, the 2.5s nudge) captures the generation at start and no-ops if it
   * changed — so stale completions can't mutate the engine after teardown.
   */
  private generation = 0;
  private lastSnapshots: TramSnapshot[] = [];
  /** True while the map shows the 3D sections band (zoom ≥ band) → 60 Hz tick. */
  private detailMode = false;

  private frameListeners = new Set<FrameListener>();
  private uiListeners = new Set<() => void>();
  private uiVersion = 0;
  private uiStatesCache: { version: number; states: TramPublicState[] } | null = null;

  lastError: string | null = null;
  lastPollAtMs = 0;

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
    }
  }

  /** Start the timer loops + an immediate poll. Idempotent. */
  private resume(): void {
    if (this.tickTimer) return;
    this.startTickTimer();
    this.uiNotifyTimer = setInterval(() => this.bumpUi(), UI_NOTIFY_MS);
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
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
   * Zoom-adaptive simulation rate (thermal): 60 Hz only while the map is in
   * the 3D sections band; ~10 Hz otherwise. Called by the map screen from
   * camera events; restarts the tick timer only on an actual mode change and
   * only while running (a paused/backgrounded runtime stays fully idle).
   */
  setDetailMode(on: boolean): void {
    if (this.detailMode === on) return;
    this.detailMode = on;
    if (__DEV__) console.log(`[tram-runtime] tick rate → ${on ? '60 Hz (model band)' : '10 Hz (idle)'}`);
    if (!this.tickTimer) return; // paused — resume() picks up the new rate
    clearInterval(this.tickTimer);
    this.startTickTimer();
  }

  /**
   * Halt timers and all outstanding async work WITHOUT removing the AppState
   * subscription (used on background). Aborts the in-flight poll, cancels the
   * pending nudge, and bumps the generation so any late completions no-op.
   */
  private pause(): void {
    this.generation += 1;
    for (const t of [this.pollTimer, this.tickTimer, this.uiNotifyTimer]) {
      if (t) clearInterval(t);
    }
    this.pollTimer = this.tickTimer = this.uiNotifyTimer = null;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.pollInFlight = false;
  }

  private readonly onAppState = (status: AppStateStatus): void => {
    if (this.refCount === 0) return;
    if (status === 'active') {
      if (!this.tickTimer) this.resume();
    } else if (this.tickTimer) {
      this.pause();
    }
  };

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    const gen = this.generation;
    const abort = new AbortController();
    this.pollAbort = abort;
    try {
      const snapshots = await fetchTramSnapshots({ signal: abort.signal });
      if (gen !== this.generation) return; // paused/torn down mid-flight
      this.lastSnapshots = snapshots;
      this.lastPollAtMs = Date.now();
      this.lastError = null;
      const now = Date.now();
      this.engine.ingest(snapshots, (tripId) => shapeCache.getLoaded(tripId), now);
      notifyMotionLog(this.engine.getStates(now), now);
      // Prefetch geometries for trips we don't have yet (background priority).
      const missing = snapshots.filter((s) => !shapeCache.has(s.tripId)).map((s) => s.tripId);
      if (missing.length > 0) {
        shapeCache.requestPrefetch(missing, 2);
        // As geometries arrive, they are adopted on the next ingest; nudge one
        // extra ingest shortly after so early geometries apply without waiting
        // a full poll cycle. Tracked so teardown can cancel it.
        this.nudgeTimer = setTimeout(() => {
          this.nudgeTimer = null;
          if (gen !== this.generation) return;
          this.engine.ingest(this.lastSnapshots, (tripId) => shapeCache.getLoaded(tripId), Date.now());
          this.bumpUi();
        }, 2_500);
      }
      this.bumpUi();
    } catch (e) {
      if (gen !== this.generation) return; // aborted by pause(): swallow
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      // Only the still-current generation may clear the in-flight flag / abort
      // handle; a stale completion must not disturb a freshly resumed poll.
      if (gen === this.generation) this.pollInFlight = false;
      if (this.pollAbort === abort) this.pollAbort = null;
    }
  }

  /** Raise fetch priority for the selected/followed tram's geometry. */
  prioritizeTrip(tripId: string | null | undefined): void {
    if (!tripId || shapeCache.has(tripId)) return;
    // First try to promote an already-queued waiter (the common cold-cache
    // case: the citywide poll enqueued this trip at background priority and it
    // is stuck behind the 16-starts/8s queue). If nothing is queued yet, ask
    // the cache to issue it at urgent priority.
    if (!promoteTag(tripId, 0)) shapeCache.requestPrefetch([tripId], 0);
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

/** The app-wide runtime singleton (created lazily). */
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

/** All loaded route geometries (grows as shapes stream in), ~1 Hz. */
export function useLoadedGeometries(): RouteGeometry[] {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  return shapeCache.getAllLoaded();
}
