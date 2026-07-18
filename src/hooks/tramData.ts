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
import type { FeedStatus, TramFeed } from '@/lib/feed/types';
import * as shapeCache from '@/lib/golemio/shapeCache';
import type { RouteGeometry, TramPublicState, TramSnapshot, Viewport } from '@/lib/types';
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
/**
 * rideBackground mode (SANCTIONED exception to perf invariant #3 — see
 * docs/performance.md): while a GPS ride recording is active, backgrounding
 * must NOT fully pause the runtime, or every ride point correlates against a
 * frozen simulation. Budget is minimal: feed polls at 10 s, engine ticks at
 * 1 Hz, and ALL render pushes / UI notifications stay off. Gate: only while
 * the injected rideActivity reports an active ride; ride stop → full pause.
 */
export const RIDE_BG_POLL_MS = 10_000;
export const RIDE_BG_TICK_MS = 1_000;
/** Re-ingest shortly after a prefetch so early geometries apply without waiting a poll. */
const GEOMETRY_NUDGE_MS = 2_500;
/**
 * Debounce for the geometry-landed re-ingest (feed.subscribeGeometry): the
 * scheduler drains several geometry fetches per rate-limit window, so arrivals
 * come in bursts — one ingest per burst, not one per shape. This is what makes
 * a geometry-less tram "come alive" by itself (no tap, no waiting out the poll):
 * shape lands → ingest ≤ this much later → sim exists → the dot becomes a tram.
 */
export const GEOMETRY_ADOPT_DEBOUNCE_MS = 300;
/**
 * Margin around the viewport bbox when classifying a missing-geometry tram as
 * ON SCREEN for the warm-up priority split (see onSnapshots), meters. Generous
 * (> featureBuilder's 300 m cull margin) so trams about to scroll in are ready.
 */
const VIEWPORT_GEO_MARGIN_M = 500;

const M_PER_DEG_LAT = 111_320;

/** Expand a [w,s,e,n] bbox by marginM meters (local flat-earth, fine at city scale). */
function expandBbox(
  bbox: [number, number, number, number],
  marginM: number,
): [number, number, number, number] {
  const [w, s, e, n] = bbox;
  const dLat = marginM / M_PER_DEG_LAT;
  const midLat = (s + n) / 2;
  const dLng =
    marginM / (M_PER_DEG_LAT * Math.max(Math.cos(midLat * (Math.PI / 180)), 0.01));
  return [w - dLng, s - dLat, e + dLng, n + dLat];
}

function inBbox(p: [number, number], bbox: [number, number, number, number]): boolean {
  return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
}

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
  /** Pending debounced geometry-adopt ingest (see onGeometryLoaded). */
  private adoptTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private feedUnsub: (() => void) | null = null;
  /** Unsubscribe from the feed's geometry-landed event (optional capability). */
  private geometryUnsub: (() => void) | null = null;
  /**
   * Live viewport supplier, registered by the map layer while it is mounted
   * (null otherwise). Read once per poll to split missing-geometry warm-ups
   * into on-screen (raised priority) vs background — never per frame.
   */
  private viewportProvider: (() => Viewport | null) | null = null;
  /**
   * Bumped whenever the runtime is paused/torn down. Deferred work (the 2.5 s
   * geometry nudge) captures the generation at schedule time and no-ops if it
   * changed — so stale completions can't mutate the engine after teardown.
   * (The feed keeps its own generation guard for in-flight polls.)
   */
  private generation = 0;
  private lastSnapshots: TramSnapshot[] = [];
  /**
   * key → tripId seen on the previous poll, so a trip change (endpoint turn) is
   * detectable here and its new shape fetched at RAISED priority — the tram is
   * geometry-less (rendered as a bare dot) until the shape lands, so shortening
   * that window returns it to the drawn line within 1–2 polls instead of
   * waiting behind the background prefetch queue. Pruned to the live fleet each
   * poll (keys absent from the batch are dropped) so it can't grow unbounded.
   */
  private lastTripByKey = new Map<string, string>();
  /** True while the map is in the glide band (see detailModeForZoom) → 60 Hz tick. */
  private detailMode = false;
  /**
   * Runtime activity mode: 'active' (foreground, full cadence), 'rideBackground'
   * (backgrounded WITH a live ride recording — minimal keep-alive cadence, no
   * rendering), 'paused' (backgrounded/released — nothing ticks; invariant #3).
   */
  private runMode: 'paused' | 'active' | 'rideBackground' = 'paused';
  /**
   * Injected by src/lib/motionlog (never imported from here — that would be a
   * module cycle): reports whether a GPS ride recording is active. null until
   * the motionlog singleton exists, i.e. no ride can be active.
   */
  private rideActivity: (() => boolean) | null = null;
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

  /** Full feed health (poll-cycle indicator) — a fresh view over feed.status(). */
  get feedStatus(): FeedStatus {
    return this.feed.status();
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
      // Optional feed capability: geometry-landed events drive a debounced
      // re-ingest so freshly-shaped trams start simulating without a tap or a
      // poll-cycle wait. A stopped feed aborts its prefetches, so no events
      // arrive while paused (the handler also guards on runMode).
      this.geometryUnsub = this.feed.subscribeGeometry?.(this.onGeometryLoaded) ?? null;
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
      this.geometryUnsub?.();
      this.geometryUnsub = null;
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
    if (this.runMode === 'active') return;
    // Leaving rideBackground: clear its slow timers/feed first. From 'paused'
    // everything is already stopped — halting again would double feed.stop().
    if (this.runMode === 'rideBackground') this.halt();
    this.runMode = 'active';
    this.startTickTimer();
    this.uiNotifyTimer = setInterval(() => this.bumpUi(), UI_NOTIFY_MS);
    this.feed.start();
  }

  /**
   * Backgrounded while a ride is recording: keep the minimum alive for the
   * ride log to stay meaningful (see RIDE_BG_* constants — sanctioned
   * exception to invariant #3, docs/performance.md). The tick loop runs at
   * 1 Hz and NEVER notifies frame listeners; bumpUi() is gated off. Idempotent.
   */
  private enterRideBackground(): void {
    if (this.runMode === 'rideBackground') return;
    // From 'paused' nothing runs — halting again would double feed.stop().
    if (this.runMode === 'active') this.halt();
    this.runMode = 'rideBackground';
    this.startTickTimer();
    this.feed.start(RIDE_BG_POLL_MS);
  }

  private startTickTimer(): void {
    const rideBg = this.runMode === 'rideBackground';
    this.tickTimer = setInterval(
      () => {
        const now = Date.now();
        this.engine.tick(now);
        // No render pushes in rideBackground — the map isn't visible and the
        // whole point of the mode is a minimal keep-alive budget.
        if (!rideBg) this.frameListeners.forEach((l) => l(now));
      },
      rideBg ? RIDE_BG_TICK_MS : this.detailMode ? TICK_MS : TICK_IDLE_MS,
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
    if (this.runMode !== 'active' || !this.tickTimer) return; // resume() picks up the new rate
    clearInterval(this.tickTimer);
    this.startTickTimer();
  }

  /**
   * Full pause: nothing may tick afterwards (perf invariant #3). Halts timers,
   * the feed, and all outstanding async work WITHOUT removing the AppState/feed
   * subscriptions (used on background/release).
   */
  private pause(): void {
    this.halt();
    this.runMode = 'paused';
  }

  /**
   * Shared teardown of the mode-owned machinery: timers, the pending nudge,
   * and the feed. feed.stop() aborts the in-flight poll; the generation bump
   * makes any late completions no-op. Mode transitions call this first.
   */
  private halt(): void {
    this.generation += 1;
    for (const t of [this.tickTimer, this.uiNotifyTimer]) {
      if (t) clearInterval(t);
    }
    this.tickTimer = this.uiNotifyTimer = null;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (this.adoptTimer) {
      clearTimeout(this.adoptTimer);
      this.adoptTimer = null;
    }
    this.feed.stop();
    // Every mode transition is a tick-clock boundary: the first tick of the
    // next mode must anchor, never integrate (or budget-drop) the gap the
    // stopped timers left behind — minutes of suspension are NOT replayed.
    this.engine.resetClock();
  }

  private readonly onAppState = (status: AppStateStatus): void => {
    if (this.refCount === 0) return;
    if (status === 'active') {
      this.resume();
    } else if (this.rideActivity?.() === true) {
      // Backgrounded mid-recording: keep the ride log alive on the minimal
      // budget instead of freezing it (see enterRideBackground). Note this
      // also covers 'inactive' — the location-permission dialog during
      // startRide must not fully pause the runtime under the recording.
      this.enterRideBackground();
    } else if (this.runMode !== 'paused') {
      this.pause();
    }
  };

  /**
   * Wire the ride-recording probe (called by src/lib/motionlog when the
   * singleton is created; direction chosen to avoid a module cycle).
   */
  setRideActivity(isRiding: (() => boolean) | null): void {
    this.rideActivity = isRiding;
  }

  /**
   * Called by motionlog on every ride state change: a ride that stops while
   * we are in rideBackground (user stop via the sheet, or the 90 min
   * auto-stop firing in background) must complete the full pause — the
   * exception to invariant #3 is gated strictly on an ACTIVE recording.
   */
  notifyRideActivity(): void {
    if (this.runMode === 'rideBackground' && this.rideActivity?.() !== true) {
      this.pause();
    }
  }

  /**
   * One fresh snapshot batch from the feed → engine ingest + calibration
   * report + geometry warm-up. This is the push-side replacement for the old
   * inline poll body (the fetch/abort/status plumbing now lives in the feed).
   */
  private readonly onSnapshots = (snapshots: TramSnapshot[], atMs: number): void => {
    const gen = this.generation;
    // Detect trip changes (endpoint turns) BEFORE ingest updates the engine.
    // A tram whose tripId changed needs its NEW shape urgently — until it lands
    // the tram renders geometry-less (a bare dot, off any drawn line). Fetch
    // those at raised priority (1) rather than the background warm (2). Also
    // prune the per-key trip memory to the current fleet.
    const changedTrips: string[] = [];
    const seen = new Set<string>();
    for (const s of snapshots) {
      seen.add(s.key);
      const prevTrip = this.lastTripByKey.get(s.key);
      this.lastTripByKey.set(s.key, s.tripId);
      if (prevTrip !== undefined && prevTrip !== s.tripId && !this.feed.getGeometry(s.tripId)) {
        changedTrips.push(s.tripId);
      }
    }
    for (const key of this.lastTripByKey.keys()) {
      if (!seen.has(key)) this.lastTripByKey.delete(key);
    }
    if (changedTrips.length > 0) this.feed.requestGeometry(changedTrips, 1);

    this.lastSnapshots = snapshots;
    this.engine.ingest(snapshots, (tripId) => this.feed.getGeometry(tripId), atMs);
    this.feed.reportCalibration(toCalibrationRecords(this.engine.getStates(atMs), atMs));
    // Warm geometries for trips we don't have yet, split by visibility: a
    // missing shape whose tram is ON SCREEN (viewport + margin) loads at
    // raised priority (1) — a visible tram stuck as a bare dot is the
    // user-facing failure — while off-screen trams warm at background (2).
    // Both lanes stay behind the tapped-tram urgent lane (0). Re-requesting a
    // still-queued trip at a higher priority PROMOTES its scheduler waiter
    // (shapeCache.requestPrefetch → promoteTag), so a background-warmed tram
    // that scrolls into view jumps the queue on the next poll. Trips already
    // requested at raised priority above (trip changes) are excluded so they
    // aren't re-queued behind the background lane.
    const changedSet = changedTrips.length > 0 ? new Set(changedTrips) : null;
    const viewport = this.viewportProvider?.() ?? null;
    const bbox = viewport ? expandBbox(viewport.bbox, VIEWPORT_GEO_MARGIN_M) : null;
    const missingVisible: string[] = [];
    const missingBackground: string[] = [];
    for (const s of snapshots) {
      if (this.feed.getGeometry(s.tripId) || (changedSet?.has(s.tripId) ?? false)) continue;
      if (bbox && inBbox(s.coordinates, bbox)) missingVisible.push(s.tripId);
      else missingBackground.push(s.tripId);
    }
    if (missingVisible.length > 0) this.feed.requestGeometry(missingVisible, 1);
    if (missingBackground.length > 0) this.feed.requestGeometry(missingBackground, 2);
    // As geometries arrive (whether raised-priority trip changes or background
    // warm), they are adopted on the next ingest; nudge one extra ingest
    // shortly after so early geometries apply without waiting a full poll
    // cycle. Tracked so teardown can cancel it. (The geometry-landed event —
    // onGeometryLoaded — usually beats this; the nudge remains the fallback
    // for feeds without the optional subscribeGeometry capability.)
    if (missingVisible.length > 0 || missingBackground.length > 0 || changedTrips.length > 0) {
      this.nudgeTimer = setTimeout(() => {
        this.nudgeTimer = null;
        if (gen !== this.generation) return;
        this.engine.ingest(this.lastSnapshots, (tripId) => this.feed.getGeometry(tripId), Date.now());
        this.bumpUi();
      }, GEOMETRY_NUDGE_MS);
    }
    this.bumpUi();
  };

  /**
   * A geometry landed in the local cache (feed.subscribeGeometry): schedule ONE
   * debounced re-ingest so the newly-shaped tram gets its sim right away —
   * tapping must never be the only way a dot comes back to life. Arrivals
   * burst (several fetches drain per rate-limit window) and coalesce into a
   * single ingest per debounce interval; the ingest itself is the same work a
   * poll does every 5 s, so this stays far below frame-rate cadences
   * (perf invariant #1/#3 — timer registered with halt(), generation-guarded).
   */
  private readonly onGeometryLoaded = (): void => {
    if (this.runMode === 'paused' || this.adoptTimer || this.lastSnapshots.length === 0) return;
    const gen = this.generation;
    this.adoptTimer = setTimeout(() => {
      this.adoptTimer = null;
      if (gen !== this.generation) return;
      this.engine.ingest(this.lastSnapshots, (tripId) => this.feed.getGeometry(tripId), Date.now());
      this.bumpUi();
    }, GEOMETRY_ADOPT_DEBOUNCE_MS);
  };

  /**
   * Register the live-viewport supplier (map layer mount/unmount). Null while
   * no map is mounted → every missing geometry warms at background priority,
   * exactly the pre-viewport behavior.
   */
  setViewportProvider(provider: (() => Viewport | null) | null): void {
    this.viewportProvider = provider;
  }

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
    // rideBackground: ALL UI notifications are off by contract (the app is
    // backgrounded; subscribers would re-render an invisible tree).
    if (this.runMode === 'rideBackground') return;
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
 * Feed poll-cycle health, refreshed ~1 Hz (fetch indicator + status chip).
 * Rides the existing subscribeUi notification — no extra timers, and the
 * status object is only re-read on the 1 Hz version bump (perf invariant #1).
 */
export function useFeedStatus(): FeedStatus {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  return rt.feedStatus;
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
