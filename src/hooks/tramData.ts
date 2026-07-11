// TramRuntime — the single live-data spine of the app.
// Polls Golemio every POLL_MS, feeds TramEngine, drives simulation ticks at
// TICK_MS, prefetches trip geometries, and exposes:
//   • imperative frame access for the map (getRuntime().engine / subscribeFrame)
//   • React hooks (1 Hz) for screens/lists — useAllTramStates, useTramState, …
// The map screen renders frames imperatively via ShapeSource.setNativeProps;
// React re-renders are throttled to UI_NOTIFY_MS to keep the JS thread free.
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getModelSpec, isLikelyCoupledPair, regNumberToModelId } from '@/lib/fleet/registry';
import { TramEngine } from '@/lib/engine/engine';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { fetchTramSnapshots } from '@/lib/golemio/vehicles';
import type { RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';

export const POLL_MS = 5_000;
export const TICK_MS = 66; // ~15 fps simulation
const UI_NOTIFY_MS = 1_000;

export type FrameListener = (nowMs: number) => void;

class TramRuntime {
  readonly engine = new TramEngine({
    resolveModel: (snapshot: TramSnapshot) =>
      getModelSpec(regNumberToModelId(snapshot.registrationNumber)),
  });

  private refCount = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private uiNotifyTimer: ReturnType<typeof setInterval> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private pollInFlight = false;
  private lastSnapshots: TramSnapshot[] = [];

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
    if (this.refCount === 1) this.start();
  }

  release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) this.stop();
  }

  private start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      const now = Date.now();
      this.engine.tick(now);
      this.frameListeners.forEach((l) => l(now));
    }, TICK_MS);
    this.uiNotifyTimer = setInterval(() => this.bumpUi(), UI_NOTIFY_MS);
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
    this.appStateSub = AppState.addEventListener('change', this.onAppState);
  }

  private stop(): void {
    for (const t of [this.pollTimer, this.tickTimer, this.uiNotifyTimer]) {
      if (t) clearInterval(t);
    }
    this.pollTimer = this.tickTimer = this.uiNotifyTimer = null;
    this.appStateSub?.remove();
    this.appStateSub = null;
  }

  private readonly onAppState = (status: AppStateStatus): void => {
    if (status === 'active') {
      if (this.refCount > 0 && !this.tickTimer) this.start();
    } else if (this.tickTimer) {
      this.stop();
    }
  };

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const snapshots = await fetchTramSnapshots();
      this.lastSnapshots = snapshots;
      this.lastPollAtMs = Date.now();
      this.lastError = null;
      const now = Date.now();
      this.engine.ingest(snapshots, (tripId) => shapeCache.getLoaded(tripId), now);
      // Prefetch geometries for trips we don't have yet (background priority).
      const missing = snapshots.filter((s) => !shapeCache.has(s.tripId)).map((s) => s.tripId);
      if (missing.length > 0) {
        shapeCache.requestPrefetch(missing, 2);
        // As geometries arrive, they are adopted on the next ingest; nudge one
        // extra ingest shortly after so early geometries apply without waiting
        // a full poll cycle.
        setTimeout(() => {
          this.engine.ingest(this.lastSnapshots, (tripId) => shapeCache.getLoaded(tripId), Date.now());
          this.bumpUi();
        }, 2_500);
      }
      this.bumpUi();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Raise fetch priority for the selected/followed tram's geometry. */
  prioritizeTrip(tripId: string | null | undefined): void {
    if (tripId && !shapeCache.has(tripId)) shapeCache.requestPrefetch([tripId], 0);
  }

  subscribeFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  // — React (1 Hz) subscriptions —

  private bumpUi(): void {
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
