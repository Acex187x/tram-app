// TramRuntime — the single live-data spine of the app.
//
// Physics v3 (docs/research/physics-v3-protocol.md) split the old runtime in
// two, and this file now owns only the plumbing between them:
//
//   • the TramFeed (RemoteFeed over the Convex backend) supplies IDENTITY —
//     which trams exist, on which trip, their line/headsign/delay and last raw
//     AVL fix — plus trip-geometry resolution.
//   • the TrajectoryStore supplies MOTION — one bundle of published curves for
//     the whole fleet, every 5 s.
//
// `TramFleet` joins them and evaluates a pure function per tram per push. There
// is no tick loop, no simulation, no clock to reset, and nothing to resync
// after a suspension: a stateless evaluator is simply correct at whatever
// instant you next ask it about (that IS the determinism guarantee).
//
// What remains here: lifecycle (every timer created in resume(), cleared in
// halt(), generation-guarded — perf invariant #3), geometry warm-up priority,
// frame-listener fan-out for the map's imperative pushes, and the 1 Hz React
// hooks for screens/lists (perf invariant #1).
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getModelSpec, isLikelyCoupledPair, regNumberToModelId } from '@/lib/fleet/registry';
import { toCalibrationRecords } from '@/lib/feed/calibration';
import { NullFeed } from '@/lib/feed/nullFeed';
import type { FeedStatus, TramFeed } from '@/lib/feed/types';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore, type TrajectoryHealth } from '@/lib/physics/trajectoryStore';
import type { ConnectionState } from '@/lib/physics/connection';
import type { RenderMode } from '@/lib/physics/render';
import type { RouteGeometry, TramPublicState, TramSnapshot, Viewport } from '@/lib/types';
import { useSettingsStore } from '@/stores/settings';

/**
 * Nominal snapshot-feed cadence, ms. Only a display fallback now (the poll
 * indicator's ring when a feed reports no cadence of its own) — the real
 * cadence comes from `FeedStatus.pollIntervalMs`.
 */
export const POLL_MS = 5_000;
/**
 * Frame-notify cadence while the map is in the glide band. There is no
 * simulation behind it any more: it paces the map's push due-checks, and
 * every push evaluates the curves at the instant it happens.
 */
export const TICK_MS = 33; // ~30 Hz while trams visibly glide (zoom ≥ 14)
/**
 * Idle frame-notify cadence (~10 Hz): at far zooms nothing on screen moves
 * faster than badge/dot updates. The map switches rates via setDetailZoom()
 * from its camera events.
 */
export const TICK_IDLE_MS = 100;
const UI_NOTIFY_MS = 1_000;
/**
 * rideBackground mode (SANCTIONED exception to perf invariant #3 — see
 * docs/performance.md): while a GPS ride recording is active, backgrounding
 * must NOT fully pause the runtime, or every ride point correlates against a
 * frozen fleet. The budget is now strictly smaller than it was under the old
 * engine: the snapshot feed polls at 10 s, trajectories at 10 s, and there is
 * NO tick timer at all (state is evaluated on demand when the ride recorder
 * samples it). Render pushes and UI notifications stay off.
 */
export const RIDE_BG_POLL_MS = 10_000;
/** Re-ingest shortly after a prefetch so early geometries apply without waiting a poll. */
const GEOMETRY_NUDGE_MS = 2_500;
/**
 * Debounce for the geometry-landed re-ingest (feed.subscribeGeometry): the
 * scheduler drains several geometry fetches per rate-limit window, so arrivals
 * come in bursts — one ingest per burst, not one per shape. This is what makes
 * a geometry-less tram "come alive" by itself (no tap, no waiting out the poll):
 * shape lands → ingest ≤ this much later → the dot becomes a tram on its line.
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
 * Points-push gate shared by the map layer's per-frame due-check.
 *
 * Both render modes animate continuously between bundles (they are curves, not
 * step functions), so the old raw-mode dirty-flag special case is gone: a push
 * is due whenever the zoom-banded interval elapsed. `forced` covers the events
 * that must not wait for it — a render-mode switch, or a selection/follow
 * change at the 5 s city-scale cadence.
 */
export function pointsPushWanted(
  elapsedMs: number,
  zoom: number,
  forced: boolean,
): boolean {
  if (forced) return true;
  return elapsedMs >= pointsPushIntervalMs(zoom);
}

/**
 * Detail-mode (30 Hz frame) zoom band, with hysteresis so hovering at the
 * boundary doesn't thrash the timer. ENTER is aligned with the fast points
 * cadence above (perf invariant #4): everywhere badges are pushed at ~15 Hz the
 * frame loop also runs at 30 Hz — notifying at 10 Hz under 15 Hz pushes aliased
 * badge motion into visible 0-0-jump stutter (the iteration-4 regression).
 */
export const DETAIL_ENTER_ZOOM = 14.0;
export const DETAIL_EXIT_ZOOM = 13.7;

/** Pure hysteresis step: enter 30 Hz at ≥ 14.0, drop to 10 Hz only below 13.7. */
export function detailModeForZoom(zoom: number, current: boolean): boolean {
  if (zoom >= DETAIL_ENTER_ZOOM) return true;
  if (zoom < DETAIL_EXIT_ZOOM) return false;
  return current;
}

export type FrameListener = (nowMs: number) => void;

export class TramRuntime {
  /** MOTION: the server's published curves, refetched every 5 s. */
  readonly trajectories = new TrajectoryStore();

  /** The joined view the whole app renders and reads from. */
  readonly fleet = new TramFleet({
    resolveModel: (snapshot: TramSnapshot) =>
      getModelSpec(regNumberToModelId(snapshot.registrationNumber)),
    trajectories: this.trajectories,
  });

  /** IDENTITY: the data service (RemoteFeed over the Convex backend). */
  private readonly feed: TramFeed;
  private refCount = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private uiNotifyTimer: ReturnType<typeof setInterval> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending debounced geometry-adopt ingest (see onGeometryLoaded). */
  private adoptTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private feedUnsub: (() => void) | null = null;
  /** Unsubscribe from the feed's geometry-landed event (optional capability). */
  private geometryUnsub: (() => void) | null = null;
  /** Unsubscribe from the trajectory store's bundle-decoded event. */
  private trajectoryUnsub: (() => void) | null = null;
  /**
   * Live viewport supplier, registered by the map layer while it is mounted
   * (null otherwise). Read once per poll to split missing-geometry warm-ups
   * into on-screen (raised priority) vs background — never per frame.
   */
  private viewportProvider: (() => Viewport | null) | null = null;
  /**
   * Last non-null viewport ever supplied by a provider. Fallback when the
   * provider is momentarily unregistered (map layer effect re-run/remount) or
   * returns null: the camera rarely leaps across the city between polls, so
   * the previous bbox is a far better prioritization signal than dropping every
   * visible tram's shape to the back of the queue.
   */
  private lastViewport: Viewport | null = null;
  /**
   * Bumped whenever the runtime is paused/torn down. Deferred work (the 2.5 s
   * geometry nudge) captures the generation at schedule time and no-ops if it
   * changed — so stale completions can't mutate the fleet after teardown.
   */
  private generation = 0;
  private lastSnapshots: TramSnapshot[] = [];
  /**
   * key → tripId seen on the previous poll, so a trip change (endpoint turn) is
   * detectable here and its new shape fetched at RAISED priority — the tram is
   * geometry-less (a bare dot) until the shape lands. Pruned to the live fleet
   * each poll so it can't grow unbounded.
   */
  private lastTripByKey = new Map<string, string>();
  /** True while the map is in the glide band (see detailModeForZoom) → 30 Hz. */
  private detailMode = false;
  /**
   * Runtime activity mode: 'active' (foreground, full cadence), 'rideBackground'
   * (backgrounded WITH a live ride recording — minimal keep-alive, no
   * rendering), 'paused' (backgrounded/released — nothing ticks; invariant #3).
   */
  private runMode: 'paused' | 'active' | 'rideBackground' = 'paused';
  /**
   * Injected by src/lib/motionlog (never imported from here — that would be a
   * module cycle): reports whether a GPS ride recording is active.
   */
  private rideActivity: (() => boolean) | null = null;
  /** Unsubscribe from the settings store (render mode mirrors positionMode). */
  private settingsUnsub: (() => void) | null = null;
  /** The cold-start geometry pack is fetched at most once per runtime. */
  private packAttempted = false;

  private frameListeners = new Set<FrameListener>();
  private uiListeners = new Set<() => void>();
  private uiVersion = 0;
  private uiStatesCache: { version: number; states: TramPublicState[] } | null = null;

  constructor(feed: TramFeed = new NullFeed()) {
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

  /** Trajectory/clock/connection health — the physics side of the status UI. */
  get physicsHealth(): TrajectoryHealth {
    return this.trajectories.health();
  }

  /** The honest 3-state connection verdict (bundle age + fetch health). */
  get connection(): ConnectionState {
    return this.trajectories.connection();
  }

  /** Coupled-pair predicate for featureBuilder opts. */
  readonly coupledPairFn = (key: string): boolean => {
    const snapshot = this.fleet.getSnapshot(key);
    if (!snapshot) return false;
    return isLikelyCoupledPair(regNumberToModelId(snapshot.registrationNumber), snapshot.line);
  };

  retain(): void {
    this.refCount += 1;
    if (this.refCount === 1) {
      // The AppState subscription lives for the whole retained lifetime, so the
      // later 'active' transition is always observed.
      this.appStateSub = AppState.addEventListener('change', this.onAppState);
      // The feed subscription also spans the retained lifetime; pause/resume
      // only toggles feed.stop()/start() (a stopped feed emits nothing).
      this.feedUnsub = this.feed.subscribeSnapshots(this.onSnapshots);
      // Optional feed capability: geometry-landed events drive a debounced
      // re-ingest so freshly-shaped trams join their line without a tap.
      this.geometryUnsub = this.feed.subscribeGeometry?.(this.onGeometryLoaded) ?? null;
      // A fresh bundle changes every tram's position: refresh the 1 Hz hooks.
      this.trajectoryUnsub = this.trajectories.subscribe(this.onBundle);
      this.applyRenderMode(useSettingsStore.getState().positionMode);
      this.settingsUnsub = useSettingsStore.subscribe((s) =>
        this.applyRenderMode(s.positionMode),
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
      this.trajectoryUnsub?.();
      this.trajectoryUnsub = null;
      this.settingsUnsub?.();
      this.settingsUnsub = null;
    }
  }

  /**
   * Mirror the settings store's render mode onto the fleet. Switching modes is
   * FREE — it changes which curve the next evaluation reads, nothing else.
   * There is no per-mode machinery to spin up or tear down any more.
   */
  private applyRenderMode(mode: RenderMode): void {
    if (this.fleet.renderMode === mode) return;
    this.fleet.setMode(mode);
    this.bumpUi();
  }

  private readonly onBundle = (): void => {
    this.bumpUi();
  };

  /** Start the timer loops + both data sources. Idempotent. */
  private resume(): void {
    if (this.runMode === 'active') return;
    // Leaving rideBackground: clear its slow timers/feed first. From 'paused'
    // everything is already stopped — halting again would double feed.stop().
    if (this.runMode === 'rideBackground') this.halt();
    this.runMode = 'active';
    this.startFrameTimer();
    this.uiNotifyTimer = setInterval(() => this.bumpUi(), UI_NOTIFY_MS);
    this.feed.start();
    this.trajectories.start();
    void this.warmGeometryPack();
  }

  /**
   * ONE-SHOT cold-start geometry pack (lib/golemio/geometryPack): seeds the
   * whole in-service shape set in a single request so visible trams stop being
   * bare dots while ~180 per-trip fetches drain the rate-limit queue.
   *
   * Strictly additive: it runs alongside the per-trip warm-up (never instead of
   * it), every failure — including the 404 the endpoint returns until the
   * predictor service ships it — silently leaves today's behavior untouched,
   * and seeded trips stay PROVISIONAL so the authoritative per-trip geometry
   * still replaces them (see shapeCache.seedProvisional). Attempted once per
   * runtime: a second cold start is a process restart anyway.
   */
  private async warmGeometryPack(): Promise<void> {
    if (this.packAttempted) return;
    this.packAttempted = true;
    const gen = this.generation;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { warmFromGeometryPack } = require('@/lib/golemio/geometryPack') as typeof import('@/lib/golemio/geometryPack');
    const seeded = await warmFromGeometryPack();
    // Teardown while the pack was in flight: the seeds are harmless (they only
    // populate the cache) but the ingest below must not touch a dead runtime.
    if (gen !== this.generation || seeded === 0) return;
    if (__DEV__) console.log(`[tram-runtime] geometry pack seeded ${seeded} trips`);
    // Adopt immediately rather than waiting for the next poll: seeding fires
    // the geometry-landed event too, but this makes the first paint certain.
    if (this.lastSnapshots.length > 0) {
      this.fleet.ingest(this.lastSnapshots, (tripId) => this.feed.getGeometry(tripId));
    }
    this.bumpUi();
  }

  /**
   * Backgrounded while a ride is recording: keep the minimum alive for the
   * ride log to stay meaningful (sanctioned exception to invariant #3). Both
   * data sources poll at 10 s; there is NO frame timer and no UI notification,
   * and tram state is evaluated on demand when the recorder samples it.
   */
  private enterRideBackground(): void {
    if (this.runMode === 'rideBackground') return;
    if (this.runMode === 'active') this.halt();
    this.runMode = 'rideBackground';
    this.feed.start(RIDE_BG_POLL_MS);
    this.trajectories.start(RIDE_BG_POLL_MS);
  }

  private startFrameTimer(): void {
    this.frameTimer = setInterval(
      () => {
        const now = Date.now();
        this.frameListeners.forEach((l) => l(now));
      },
      this.detailMode ? TICK_MS : TICK_IDLE_MS,
    );
  }

  /**
   * Zoom-adaptive frame cadence (thermal): 30 Hz while zoomed into the glide
   * band, ~10 Hz at far zooms — with hysteresis (enter ≥ 14.0, exit < 13.7) so
   * camera drift at the boundary can't thrash the timer. Called by the map
   * screen from camera events; restarts the timer only on an actual mode
   * change and only while running.
   */
  setDetailZoom(zoom: number): void {
    const on = detailModeForZoom(zoom, this.detailMode);
    if (this.detailMode === on) return;
    this.detailMode = on;
    if (__DEV__) console.log(`[tram-runtime] frames → ${on ? '30 Hz (glide band)' : '10 Hz (idle)'}`);
    if (this.runMode !== 'active' || !this.frameTimer) return; // resume() picks up the new rate
    clearInterval(this.frameTimer);
    this.startFrameTimer();
  }

  /**
   * Full pause: nothing may tick afterwards (perf invariant #3). Halts timers,
   * both data sources, and all outstanding async work WITHOUT removing the
   * AppState/feed subscriptions (used on background/release).
   */
  private pause(): void {
    this.halt();
    this.runMode = 'paused';
  }

  /**
   * Shared teardown of the mode-owned machinery: timers, the pending nudge, the
   * feed and the trajectory poller. Both stops abort in-flight work; the
   * generation bump makes late completions no-op. Mode transitions call this
   * first.
   *
   * Note what is NOT here any more: there is no simulation clock to reset. A
   * paused evaluator resumes correct by construction.
   */
  private halt(): void {
    this.generation += 1;
    for (const t of [this.frameTimer, this.uiNotifyTimer]) {
      if (t) clearInterval(t);
    }
    this.frameTimer = this.uiNotifyTimer = null;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (this.adoptTimer) {
      clearTimeout(this.adoptTimer);
      this.adoptTimer = null;
    }
    this.feed.stop();
    this.trajectories.stop();
  }

  private readonly onAppState = (status: AppStateStatus): void => {
    if (this.refCount === 0) return;
    if (status === 'active') {
      this.resume();
    } else if (this.rideActivity?.() === true) {
      // Backgrounded mid-recording: keep the ride log alive on the minimal
      // budget instead of freezing it. Also covers 'inactive' — the
      // location-permission dialog during startRide must not fully pause.
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
   * Called by motionlog on every ride state change: a ride that stops while we
   * are in rideBackground must complete the full pause — the exception to
   * invariant #3 is gated strictly on an ACTIVE recording.
   */
  notifyRideActivity(): void {
    if (this.runMode === 'rideBackground' && this.rideActivity?.() !== true) {
      this.pause();
    }
  }

  /**
   * One fresh snapshot batch from the feed → fleet ingest + calibration report
   * + geometry warm-up. Ingest is pure bookkeeping now (identity, model, the
   * geometry currently resolvable per key) — no physics runs here.
   */
  private readonly onSnapshots = (snapshots: TramSnapshot[], atMs: number): void => {
    const gen = this.generation;
    // Detect trip changes (endpoint turns) BEFORE ingest. A tram whose tripId
    // changed needs its NEW shape urgently — until it lands the tram renders
    // geometry-less, and its published trajectory (computed for the old trip)
    // is correctly ignored. Fetch those at raised priority (1).
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
    this.fleet.ingest(snapshots, (tripId) => this.feed.getGeometry(tripId));
    this.feed.reportCalibration(toCalibrationRecords(this.fleet.getStates(atMs), atMs));
    // Warm geometries for trips we don't have yet, split by visibility: a
    // missing shape whose tram is ON SCREEN (viewport + margin) loads at raised
    // priority (1) — a visible tram stuck as a bare dot is the user-facing
    // failure — while off-screen trams warm at background (2). The split is
    // RE-ASSERTED every poll in both directions, so the queue keeps tracking
    // what is on screen NOW (shapeCache.requestPrefetch → promoteTag/demoteTag).
    const changedSet = changedTrips.length > 0 ? new Set(changedTrips) : null;
    const viewport = this.resolveViewport();
    const bbox = viewport ? expandBbox(viewport.bbox, VIEWPORT_GEO_MARGIN_M) : null;
    const missingVisible: TramSnapshot[] = [];
    const missingBackground: string[] = [];
    for (const s of snapshots) {
      if (this.feed.getGeometry(s.tripId) || (changedSet?.has(s.tripId) ?? false)) continue;
      if (bbox && inBbox(s.coordinates, bbox)) missingVisible.push(s);
      else missingBackground.push(s.tripId);
    }
    const visibleIds = this.orderByViewportProximity(missingVisible, viewport);
    if (visibleIds.length > 0) this.feed.requestGeometry(visibleIds, 1);
    if (missingBackground.length > 0) this.feed.requestGeometry(missingBackground, 2);
    // As geometries arrive they are adopted on the next ingest; nudge one extra
    // ingest shortly after so early geometries apply without waiting a full
    // poll. Tracked so teardown can cancel it. (The geometry-landed event
    // usually beats this; the nudge remains the fallback for feeds without the
    // optional subscribeGeometry capability.)
    if (missingVisible.length > 0 || missingBackground.length > 0 || changedTrips.length > 0) {
      // One pending nudge at a time — a fresh poll supersedes the previous one.
      if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => {
        this.nudgeTimer = null;
        if (gen !== this.generation) return;
        this.fleet.ingest(this.lastSnapshots, (tripId) => this.feed.getGeometry(tripId));
        this.bumpUi();
      }, GEOMETRY_NUDGE_MS);
    }
    this.bumpUi();
  };

  /**
   * A geometry landed in the local cache (feed.subscribeGeometry): schedule ONE
   * debounced re-ingest so the newly-shaped tram is placed on its line right
   * away — tapping must never be the only way a dot comes back to life.
   * Arrivals burst and coalesce into a single ingest per debounce interval
   * (timer registered with halt(), generation-guarded — invariants #1/#3).
   */
  private readonly onGeometryLoaded = (): void => {
    if (this.runMode === 'paused' || this.adoptTimer || this.lastSnapshots.length === 0) return;
    const gen = this.generation;
    this.adoptTimer = setTimeout(() => {
      this.adoptTimer = null;
      if (gen !== this.generation) return;
      this.fleet.ingest(this.lastSnapshots, (tripId) => this.feed.getGeometry(tripId));
      this.bumpUi();
    }, GEOMETRY_ADOPT_DEBOUNCE_MS);
  };

  /**
   * Register the live-viewport supplier (map layer mount/unmount). While no
   * provider has EVER supplied a viewport, every missing geometry warms at
   * background priority; once one has, the last known viewport keeps serving
   * through provider gaps (see lastViewport).
   */
  setViewportProvider(provider: (() => Viewport | null) | null): void {
    this.viewportProvider = provider;
  }

  /** Freshest viewport: the live provider, else the last one it ever gave. */
  private resolveViewport(): Viewport | null {
    const vp = this.viewportProvider?.() ?? null;
    if (vp) this.lastViewport = vp;
    return vp ?? this.lastViewport;
  }

  /**
   * Order missing-geometry trams nearest-to-viewport-center first. Within one
   * scheduler priority the queue drains in insertion order, so on a burst (cold
   * start with an expired disk cache) the trams the user is most likely looking
   * at materialize first. Runs once per poll on at most the fleet size.
   */
  private orderByViewportProximity(
    missing: TramSnapshot[],
    viewport: Viewport | null,
  ): string[] {
    if (missing.length < 2 || !viewport) return missing.map((s) => s.tripId);
    const [w, s, e, n] = viewport.bbox;
    const cLng = (w + e) / 2;
    const cLat = (s + n) / 2;
    const kx = Math.max(Math.cos(cLat * (Math.PI / 180)), 0.01);
    return missing
      .map((snap) => {
        const dx = (snap.coordinates[0] - cLng) * kx;
        const dy = snap.coordinates[1] - cLat;
        return { tripId: snap.tripId, d2: dx * dx + dy * dy };
      })
      .sort((a, b) => a.d2 - b.d2)
      .map((x) => x.tripId);
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
    // invalidate the states cache and force a full getStates() allocation for
    // nobody (1 Hz background churn, thermal).
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
      this.uiStatesCache = { version: this.uiVersion, states: this.fleet.getStates(Date.now()) };
    }
    return this.uiStatesCache.states;
  }
}

let runtime: TramRuntime | null = null;

/** The public backend (self-hosted CONVEX_CLOUD_ORIGIN) — the baked fallback
 * when the build carries no EXPO_PUBLIC_CONVEX_URL. */
const DEFAULT_CONVEX_URL = 'https://tram-api.acex.sh';

/**
 * Feed selection: RemoteFeed over the Convex backend, unconditionally.
 * Direct-from-device Golemio polling is gone (2026-08-08), and with physics v3
 * so is the local-simulation fallback it existed for — see feed/nullFeed.ts.
 * Read once at runtime construction: switching feeds mid-session is a
 * restart-level operation by design.
 */
function constructFeed(): TramFeed {
  try {
    const env = process.env.EXPO_PUBLIC_CONVEX_URL;
    const url = typeof env === 'string' && env.length > 0 ? env : DEFAULT_CONVEX_URL;
    // Lazy require: keeps the convex client stack out of the module graph
    // (and out of bare jest workers) until the runtime actually constructs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RemoteFeed } = require('@/lib/feed/remoteFeed') as typeof import('@/lib/feed/remoteFeed');
    return new RemoteFeed({ url });
  } catch {
    // The convex stack failed to even load (bare test environment). There is
    // no honest offline substitute — an empty feed says so out loud.
    return new NullFeed();
  }
}

/** The app-wide runtime singleton (created lazily; feed per constructFeed()). */
export function getRuntime(): TramRuntime {
  if (!runtime) runtime = new TramRuntime(constructFeed());
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
  // The wall clock IS the datum here — the evaluator answers for "now",
  // sampled once per 1 Hz notification (same sanctioned pattern as
  // usePollModel in components/map/PollIndicator).
  // eslint-disable-next-line react-hooks/purity
  return key ? rt.fleet.getState(key, Date.now()) : undefined;
}

/**
 * Feed poll-cycle health, refreshed ~1 Hz (fetch indicator + status chip).
 * Rides the existing subscribeUi notification — no extra timers.
 */
export function useFeedStatus(): FeedStatus {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  return rt.feedStatus;
}

/**
 * The 3-state connection verdict, refreshed ~1 Hz — the honesty surface. Rides
 * the same 1 Hz notification, so a bundle that quietly stops arriving still
 * ages into `degraded`/`offline` on the clock rather than on a fetch event.
 */
export function useConnectionState(): ConnectionState {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  // eslint-disable-next-line react-hooks/purity
  return rt.trajectories.connection(Date.now());
}

/** Full trajectory/clock health, ~1 Hz (devtools). */
export function usePhysicsHealth(): TrajectoryHealth {
  const rt = getRuntime();
  useSyncExternalStore(rt.subscribeUi, rt.getUiVersion);
  // eslint-disable-next-line react-hooks/purity
  return rt.trajectories.health(Date.now());
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
