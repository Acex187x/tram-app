// THE MAP SCREEN — heart of the app. Full-bleed 3D Mapbox Standard map of
// Prague with the live tram fleet, route network, planner overlay and Liquid
// Glass chrome. Sheets (line/favorites/planner/search/settings) float over this
// screen as router formSheets; the map keeps rendering beneath them.
//
// TWO OWNED SHEETS, ONE AT A TIME. The home surface (`MapSheet` + search row)
// and the TRAM CARD (`TramSheet`) are both plain views on this screen, built
// from the same component. Exactly one is on stage: presenting a tram slides the
// home sheet off the bottom (`hidden`, a transform — it is never unmounted, so
// the search row keeps its identity and the return trip is a morph) and mounts
// the tram card in its place. Which tram, if any, is presented is store state
// (`presentedTramKey`), not a route — `/tram/[key]` is now a deep-link shim that
// dismisses back to this screen and writes that field.
//
// The map chrome rides whichever sheet is on stage: the ride is a worklet over a
// SharedValue, and this screen simply hands the chrome the ACTIVE sheet's shared
// value + snap table. That switch happens once per present/close (a React
// commit), never per frame — docs/performance.md invariant #1 is untouched.

import Mapbox, {
  Camera,
  LocationPuck,
  MapView,
  StyleImport,
  type MapState,
} from '@rnmapbox/maps';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings, StyleSheet, useColorScheme, useWindowDimensions, View } from 'react-native';
import {
  runOnJS,
  useAnimatedReaction,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveLightPreset, STANDARD_CONFIG } from '@/components/map/mapStyle';
import {
  COMPASS_RIGHT,
  compassBottom,
  MapChips,
  MapControlStack,
  MapChromeSchemeContext,
  MapStatusTile,
} from '@/components/map/MapChrome';
import { DebugOverlay } from '@/components/debug/DebugOverlay';
import { ConnectionBanner } from '@/components/map/ConnectionBanner';
import { DebugMapTraces } from '@/components/debug/DebugMapTraces';
import { MapSheet } from '@/components/maps-kit/MapSheet';
import {
  CARD_DETENT,
  DOCK_INSET,
  DOCK_WIDTH,
  isDocked,
  peekHeight,
  PEEK_FLOAT,
  snapHeights,
} from '@/components/maps-kit/mapSheetLayout';
import { HomeSearchRow } from '@/components/home/HomeSearchRow';
import { HomeSheetContent } from '@/components/home/HomeSheetContent';
import { TramSheet } from '@/components/tram/TramSheet';
import { PlannerOverlay } from '@/components/map/PlannerOverlay';
import { RideOverlay } from '@/components/map/RideOverlay';
import { SpotterController } from '@/components/map/SpotterController';
import { RouteNetwork, STOP_TOTEM_MODEL_KEY } from '@/components/map/RouteNetwork';
import { TramLayers, type FollowGestureState } from '@/components/map/TramLayers';
import { orientationFromCamera, shouldPauseFollow } from '@/components/map/followCamera';
import { useTramModels } from '@/components/map/useTramModels';
import { getRuntime, useTramRuntime } from '@/hooks/tramData';
import { simulatorPerfScenario } from '@/lib/performance/simulatorScenario';
import type { Viewport } from '@/lib/types';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';
import { Spacing } from '@/constants/theme';

Mapbox.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_KEY ?? null);

const PRAGUE_CENTER: [number, number] = [14.42, 50.082];
const INITIAL_ZOOM = 13.8;
const INITIAL_PITCH = 45;
/**
 * Mapbox otherwise selects an adaptive ceiling up to the device's ProMotion
 * refresh rate. Fleet geometry only changes at <=30 Hz; keeping native map
 * gestures/camera animations at 60 Hz preserves fluid interaction without
 * paying for 120 Metal draws per second on Pro devices.
 */
const MAP_MAX_FPS = 60;
const INITIAL_VIEWPORT: Viewport = {
  bbox: [14.32, 50.03, 14.52, 50.14],
  zoom: INITIAL_ZOOM,
};
/** Re-evaluate the 'auto' light preset this often. */
const LIGHT_REFRESH_MS = 5 * 60 * 1000;
/** Never leave the user stuck on the splash if the map fails to load. */
const SPLASH_FAILSAFE_MS = 8_000;
/**
 * Upward travel past the peek detent before the home sheet's body counts as
 * OPEN (see `homeOpen`). Hysteresis, not taste: a bare `> peek` would flap the
 * flag — and mount/unmount the live sections — while a finger rests on the
 * capsule, and 8 pt is still inside the first frames of a real drag.
 */
const LIVE_GATE_SLOP = 8;

export default function MapScreen() {
  useTramRuntime(); // keeps polling + simulation alive while the map lives

  const cameraRef = useRef<Camera>(null);
  const viewportRef = useRef<Viewport>({ ...INITIAL_VIEWPORT });
  const splashHiddenRef = useRef(false);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // ── Sheet geometry ─────────────────────────────────────────────────────────
  // The home sheet's pinned header is ALWAYS the search row now. It used to swap
  // to a follow mini-card while a tram was followed, which is the approach the
  // user rejected: the tram's identity lived in the HOME sheet's header, so
  // "minimizing" the tram card meant dismissing one surface and revealing a
  // different one. The tram card owns its own bar detent instead.
  const followTramKey = useSelectionStore((s) => s.followTramKey);
  /**
   * Which tram (if any) has its OWNED card on stage. One store subscription that
   * fires on present/close only, never per frame. The home sheet is translucent
   * Liquid Glass, so a card over it would show the search row straight through —
   * the home sheet is slid off screen (a transform, not an unmount) instead.
   */
  const presentedTramKey = useSelectionStore((s) => s.presentedTramKey);
  const sheetEnv = useMemo(
    () => ({
      windowWidth,
      windowHeight,
      insetTop: insets.top,
      insetBottom: insets.bottom,
    }),
    [windowWidth, windowHeight, insets.top, insets.bottom],
  );
  const sheetDocked = isDocked(sheetEnv);
  /**
   * Left edge of the usable MAP area. On iPad the sheet is a docked column over
   * the map's left side, so the status tile and the contextual chips have to
   * start to its right — anchored at the default gutter they sat behind it.
   */
  const mapLeftInset = sheetDocked ? DOCK_INSET * 2 + DOCK_WIDTH : Spacing.three;
  // The sheet MEASURES its header and reports the resulting snap table back, so
  // the chrome and the Mapbox compass ornament are anchored to the sheet's real
  // edges rather than to a hand-maintained header-height constant. Seeded with
  // the estimate so the first frame is already correct.
  const [sheetSnaps, setSheetSnaps] = useState<number[]>(() => snapHeights(sheetEnv));
  // The tram card's own snap table, reported up the same way. Seeded with the
  // home sheet's so the chrome never reads an empty table on the frame a card is
  // presented (an empty table parks the chrome at the dock offset — a visible
  // jump to the bottom of the screen).
  const [tramSnaps, setTramSnaps] = useState<number[]>(() =>
    snapHeights(sheetEnv, undefined, CARD_DETENT),
  );
  /**
   * LIVE sheet heights in px, written by each sheet's pan worklet every frame.
   * The chrome (bottom-right control column + contextual chips) reads ONE of
   * them directly, so the whole cluster travels WITH the sheet on stage instead
   * of springing to a new offset only once a detent settles
   * (docs/performance.md invariant #1: the whole path is UI-thread, zero
   * per-frame React). Two shared values rather than one shared between the
   * sheets: the home sheet keeps its own drag position while it is parked off
   * screen, so returning from a tram card is a morph back to where it was.
   */
  const sheetHeight = useSharedValue(0);
  const tramHeight = useSharedValue(0);
  // The chrome follows whatever surface is visible. A React-level switch, once
  // per present/close — the ride itself stays a worklet over whichever shared
  // value it was handed.
  const chromeHeight = presentedTramKey ? tramHeight : sheetHeight;
  const chromeSnaps = presentedTramKey ? tramSnaps : sheetSnaps;
  const peekPx = chromeSnaps[0] ?? peekHeight(sheetEnv);
  /**
   * Bottom offset of the required Mapbox ornaments (logo + attribution) — see
   * logoPosition below.
   *
   * The band is the collapsed bar's own bottom float, mirrored above it: the bar
   * rests PEEK_FLOAT (22) clear of the screen bottom, so the ornaments sit
   * PEEK_FLOAT clear of the bar's TOP edge and the capsule reads as floating in
   * an even margin rather than pinched between the map furniture and the screen.
   * `peekPx` is the peek detent — card height PLUS that float — so the bar's top
   * edge is exactly `peekPx` off the window bottom and the ornaments belong at
   * `peekPx + PEEK_FLOAT`.
   *
   * The safe-area subtraction is the same correction `compassBottom` documents:
   * Mapbox iOS lays its ornaments out inside the safe-area layout guide, so a
   * margin of N puts them N pt above the HOME INDICATOR, not above the window
   * bottom. Uncompensated, the intended 22 pt gap rendered as 22 + 34 = 56 (the
   * "they sit too high" report; the previous +8 rendered as 42). Clamped at 0 so
   * a tall inset can never push them below the safe area.
   */
  const ornamentBottom = sheetDocked
    ? 10
    : Math.max(0, peekPx + PEEK_FLOAT - insets.bottom);
  /**
   * SETTLED height (px) of whichever owned sheet is on stage — the anchor for
   * the Mapbox COMPASS ornament, which is a native ornament positioned by a
   * React prop and therefore cannot ride the drag the way the JS chrome does
   * (docs/performance.md invariant #1). Instead of pinning it to the peek band
   * forever (where it stayed put while a card opened over it), it RELOCATES per
   * detent: this value is written once per settle and the ornament jumps with it.
   *
   * 0 is the "nothing has settled yet" seed — `chromeRideFor` inside
   * `compassBottom` clamps anything below the peek detent up to it.
   */
  const [settledHeight, setSettledHeight] = useState(0);
  /**
   * The settle detector. The prepared value is QUANTIZED — it is a snap height
   * only while the sheet is actually resting on one, and -1 for every frame in
   * between — so the reaction cannot fire per frame no matter how the sheet is
   * dragged. In practice that is one React commit per detent the sheet lands on
   * (plus one for a detent the spring decelerates through), which is the same
   * cadence as the existing `onSnapsChange` / presentation commits.
   *
   * `chromeHeight`/`chromeSnaps` are dependencies for the reason the chrome's own
   * animated style lists them: the map screen SWAPS which sheet's shared value it
   * reads when a tram card is presented or closed, and a worklet that captured
   * the old one would keep watching the hidden sheet.
   *
   * That swap is ALSO the reset. A mapper is registered dirty and Reanimated runs
   * every dirty mapper on the next frame (mappers.ts: `start` sets `dirty`, and on
   * native `scheduledMapperRun` re-arms itself each frame), so re-registering
   * re-reads the newly active sheet straight away — which is what walks the
   * compass back down when a card is closed onto a home sheet resting at peek,
   * and what carries it to whatever detent the home sheet was left on if it was
   * open when the card was raised.
   */
  useAnimatedReaction(
    () => {
      const h = chromeHeight.value;
      for (let i = 0; i < chromeSnaps.length; i++) {
        if (Math.abs(chromeSnaps[i] - h) < 0.5) return chromeSnaps[i];
      }
      return -1;
    },
    (settled, previous) => {
      if (settled < 0 || settled === previous) return;
      runOnJS(setSettledHeight)(settled);
    },
    [chromeHeight, chromeSnaps],
  );
  /**
   * THE HOME SHEET'S LIVE GATE. Its body's top two sections (nearest stop with
   * its arrivals board, favorites with per-tram live status) subscribe to the
   * 1 Hz runtime and run `computeArrivals`, which is O(states × stops). None of
   * that may run while the sheet is parked at peek over a hot basemap, so the
   * sections are MOUNT-gated on this flag — at peek they do not exist and hold
   * no subscriptions at all (verifiable, unlike a conditional inside a hook).
   *
   * Why a threshold reaction rather than `onSettle`: settle fires when a drag
   * ENDS, i.e. while the sheet is still springing open with its body already
   * partly revealed — the live rows would visibly pop in mid-animation. This
   * flips at the FIRST few points of upward travel instead, so the real content
   * is mounted before any of it is legible. It is still one React commit per
   * crossing, never per frame: the worklet emits a BOOLEAN and `runOnJS` runs
   * only when that boolean changes (invariant #1 holds, same discipline as the
   * quantized `settledHeight` reaction above).
   *
   * The `presentedTramKey` term is not optional: `hidden` parks the home sheet
   * off screen WITHOUT a height change, so without it the body would keep
   * polling behind the tram card.
   */
  const [homeOpen, setHomeOpen] = useState(false);
  useAnimatedReaction(
    () => sheetHeight.value > (sheetSnaps[0] ?? 0) + LIVE_GATE_SLOP,
    (open, previous) => {
      if (open === previous) return;
      runOnJS(setHomeOpen)(open);
    },
    [sheetHeight, sheetSnaps],
  );
  const homeLive = homeOpen && presentedTramKey == null;

  const [is3D, setIs3D] = useState(true);
  // Locate button's filled tracking state (Apple Maps idiom). Mirrored in a ref
  // so onCameraChanged can clear it with a single guarded write per gesture,
  // keeping that path ref-only (no React work per camera frame).
  const [locating, setLocating] = useState(false);
  const locatingRef = useRef(false);
  /** Mirror of `is3D` so the pitch animation fires outside the state updater. */
  const is3DRef = useRef(true);
  // Reduce Motion: the one-shot camera flights below are exactly the zoom /
  // z-axis motion the HIG asks us to drop. The follow retarget loop is not
  // touched (it is continuous tracking, not a transition).
  const reduceMotion = useReducedMotion();
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const modelUris = useTramModels();
  const systemScheme = useColorScheme() === 'dark' ? 'dark' : 'light';

  // ── Light preset: settings override or Prague time-of-day, refreshed 5-min ─
  const lightPresetSetting = useSettingsStore((s) => s.lightPreset);
  // Debug overlay: mounted ONLY while debug mode is on (zero cost otherwise).
  const debugMode = useSettingsStore((s) => s.debugMode);
  const [lightClock, setLightClock] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setLightClock(Date.now()), LIGHT_REFRESH_MS);
    return () => clearInterval(iv);
  }, []);
  const lightPreset = resolveLightPreset(lightPresetSetting, lightClock);
  // UI chrome always follows the device appearance. The basemap may keep its
  // independent time-of-day lighting, but it must never silently flip buttons,
  // sheets or status glyphs into another theme.
  const chromeScheme = systemScheme;

  // ── Splash: hide when the base map is in, failsafe either way ──────────────
  const hideSplash = useCallback(() => {
    if (splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    void SplashScreen.hideAsync();
  }, []);
  useEffect(() => {
    const t = setTimeout(hideSplash, SPLASH_FAILSAFE_MS);
    return () => clearTimeout(t);
  }, [hideSplash]);

  // ── Viewport tracking (feeds frame culling + zoom banding via ref) ─────────
  const followGestureRef = useRef<FollowGestureState>({ orientation: null });
  /** Latest camera params — snapshotted as the follow orientation on engage. */
  const cameraStateRef = useRef({ zoom: INITIAL_ZOOM, pitch: INITIAL_PITCH, heading: 0 });
  const onCameraChanged = useCallback((state: MapState) => {
    // Ref assignments + at most one store write per gesture — no React work per
    // camera event.
    const { ne, sw } = state.properties.bounds;
    const zoom = state.properties.zoom;
    viewportRef.current = {
      bbox: [sw[0], sw[1], ne[0], ne[1]],
      zoom,
    };
    cameraStateRef.current = {
      zoom,
      pitch: state.properties.pitch,
      heading: state.properties.heading,
    };
    // Zoom-adaptive simulation rate (thermal): 30 Hz in the glide band
    // (hysteresis inside setDetailZoom), ~10 Hz at far zooms.
    getRuntime().setDetailZoom(zoom);

    // Any map gesture during follow PAUSES it: the camera is handed entirely to
    // the user (no auto-recenter, no heading capture — that was the "map turns
    // on touch" bug). followTramKey is kept; the "Return to follow" chip brings
    // it back. One store write per gesture (guarded by !followPaused).
    const selection = useSelectionStore.getState();
    if (
      shouldPauseFollow({
        followKey: selection.followTramKey,
        followPaused: selection.followPaused,
        isGestureActive: state.gestures.isGestureActive,
      })
    ) {
      selection.setFollowPaused(true);
    }
    // A user gesture ends locate tracking. Guarded by the ref so this stays one
    // React write per gesture, not one per camera frame.
    if (state.gestures.isGestureActive && locatingRef.current) {
      locatingRef.current = false;
      setLocating(false);
    }
  }, []);

  // CLI-only deterministic camera setup. `simctl launch` writes its `-key
  // value` arguments into the process's NSUserDefaults argument domain, which
  // React Native exposes through Settings. This stays fully mouse-free and
  // avoids iOS's custom-URL confirmation alert. Production ignores the hook.
  useEffect(() => {
    // Camera commands sent before the native style is ready are dropped. Do
    // not switch the runtime cadence early either: the measured zoom and the
    // simulated workload must always describe the same scenario.
    if (!__DEV__ || !styleLoaded) return;
    const scenario = simulatorPerfScenario(Settings.get('TramPerfScenario'));
    if (!scenario) return;
    cameraRef.current?.setCamera({
      centerCoordinate: scenario.centerCoordinate,
      zoomLevel: scenario.zoomLevel,
      pitch: scenario.pitch,
      heading: scenario.heading,
      animationMode: 'none',
      animationDuration: 0,
    });
    getRuntime().setDetailZoom(scenario.zoomLevel);
    console.info(
      `[perf-benchmark] scenario=${scenario.id} zoom=${scenario.zoomLevel} pitch=${scenario.pitch}`,
    );
  }, [styleLoaded]);

  // ── One-shot fly-to requests from search/line/favorites sheets ─────────────
  const flyToTarget = useSelectionStore((s) => s.flyToTarget);
  useEffect(() => {
    if (!flyToTarget) return;
    const selection = useSelectionStore.getState();
    if (selection.followTramKey) selection.setFollowTramKey(null);
    cameraRef.current?.setCamera({
      centerCoordinate: flyToTarget.coordinates,
      zoomLevel: flyToTarget.zoom ?? 15.5,
      animationMode: reduceMotion ? 'none' : 'flyTo',
      animationDuration: reduceMotion ? 0 : 1300,
    });
    selection.requestFlyTo(null);
  }, [flyToTarget, reduceMotion]);

  // Engaging follow snapshots the CURRENT camera orientation as the fixed
  // follow angle: the camera keeps the tram centered under exactly this
  // zoom/pitch/heading and never rotates toward the tram's bearing. Nothing
  // about the view changes on engage — only the center starts tracking. The
  // followed tram's geometry is prioritized so on-shape follow is smooth ASAP.
  // (`followTramKey` is read once at the top — it also drives the sheet header.)
  useEffect(() => {
    if (!followTramKey) {
      followGestureRef.current = { orientation: null };
      return;
    }
    followGestureRef.current = { orientation: orientationFromCamera(cameraStateRef.current) };
    const state = getRuntime().fleet.getState(followTramKey);
    if (state) getRuntime().prioritizeTrip(state.snapshot.tripId);
  }, [followTramKey]);

  // "Return to follow": when a paused follow resumes, re-snapshot the user's
  // current camera orientation (they may have zoomed/rotated while paused) so
  // the retarget loop re-centers on the tram under THAT angle/zoom. The loop
  // owns the actual smooth ease back (CAMERA_RETURN_MS) — this only refreshes
  // the fixed orientation before the loop's next frame reads it.
  const followPaused = useSelectionStore((s) => s.followPaused);
  useEffect(() => {
    if (followPaused) return;
    if (!useSelectionStore.getState().followTramKey) return;
    followGestureRef.current = { orientation: orientationFromCamera(cameraStateRef.current) };
  }, [followPaused]);

  // Show the location puck from the start if permission was granted earlier.
  useEffect(() => {
    Location.getForegroundPermissionsAsync()
      .then(({ status }) => {
        if (status === Location.PermissionStatus.GRANTED) setLocationGranted(true);
      })
      .catch(() => {});
  }, []);

  // ── Chrome actions ──────────────────────────────────────────────────────────
  const onLocate = useCallback(async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) return;
      setLocationGranted(true);
      // High (±10 m), not Balanced (±100 m): at zoom 15.5 a hundred metres of
      // error lands the camera visibly off the puck, which keeps tracking at
      // the provider's real accuracy. One-shot fix, so no battery cost.
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      useSelectionStore.getState().setFollowTramKey(null);
      cameraRef.current?.setCamera({
        centerCoordinate: [pos.coords.longitude, pos.coords.latitude],
        zoomLevel: 15.5,
        animationMode: reduceMotion ? 'none' : 'flyTo',
        animationDuration: reduceMotion ? 0 : 1200,
      });
      locatingRef.current = true;
      setLocating(true);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [reduceMotion]);

  // The camera animation is fired from the callback, not from inside the
  // setIs3D updater: React may run an updater more than once per dispatch, and
  // an updater must stay pure.
  const onTogglePitch = useCallback(() => {
    const next = !is3DRef.current;
    is3DRef.current = next;
    cameraRef.current?.setCamera({
      pitch: next ? 55 : 0,
      animationMode: reduceMotion ? 'none' : 'easeTo',
      animationDuration: reduceMotion ? 0 : 550,
    });
    setIs3D(next);
  }, [reduceMotion]);

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        styleURL="mapbox://styles/mapbox/standard"
        preferredFramesPerSecond={MAP_MAX_FPS}
        scaleBarEnabled={false}
        // Keep required Mapbox ornaments clear of the BottomDock (centre) and
        // the bottom cluster (chips + locate): pin both to the bottom-left corner.
        // iOS ornament offsets are already safe-area-relative.
        // Lifted clear of the floating peek capsule: at bottom:10 the required
        // Mapbox ornaments sat UNDER it and showed through the glass as noise.
        // Not when docked — there the sheet is a side column, the map area runs
        // to the bottom, and lifting by the column's height threw them to the top.
        logoPosition={{ bottom: ornamentBottom, left: mapLeftInset - 4 }}
        attributionPosition={{ bottom: ornamentBottom, left: mapLeftInset + 90 }}
        compassEnabled
        // Apple shows the compass only once the map is rotated off north; at
        // north-up it fades away instead of sitting there permanently.
        compassFadeWhenNorth
        // Apple pins the compass bottom-right, floating just above the map
        // control column — so it takes the column's OWN band, straight from the
        // `chromeRideFor` worklet, at whichever detent the active sheet last
        // settled on. It cannot ride the drag frame by frame (a native ornament
        // is positioned by a prop), so it RELOCATES on settle instead: opening
        // the tram card lifts it above the 2D button with the buttons rather
        // than stranding it at the old bar's band. Mapbox lays ornaments out
        // INSIDE the safe area while the JS chrome is placed from the window
        // bottom, so the inset is handed to `compassBottom` to subtract —
        // without it the disc hovered an inset (34 pt) too high.
        compassPosition={{
          bottom: compassBottom(settledHeight, chromeSnaps, sheetDocked, insets.bottom),
          right: COMPASS_RIGHT,
        }}
        pitchEnabled
        onDidFinishLoadingMap={hideSplash}
        onDidFinishLoadingStyle={() => setStyleLoaded(true)}
        onCameraChanged={onCameraChanged}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: PRAGUE_CENTER,
            zoomLevel: INITIAL_ZOOM,
            pitch: INITIAL_PITCH,
          }}
        />
        {/* Live re-lighting of Standard. Mounted only after the style loads —
            applying import config before that logs "Import basemap does not
            exist" and is dropped (verified on-device). */}
        {styleLoaded && (
          <StyleImport
            id="basemap"
            existing
            config={{ ...STANDARD_CONFIG, lightPreset }}
          />
        )}
        <RouteNetwork
          stopTotemReady={modelUris != null && STOP_TOTEM_MODEL_KEY in modelUris}
        />
        <PlannerOverlay cameraRef={cameraRef} />
        <RideOverlay cameraRef={cameraRef} />
        <TramLayers
          cameraRef={cameraRef}
          viewportRef={viewportRef}
          followGestureRef={followGestureRef}
          modelUris={modelUris}
        />
        {/* Game-style in-world diagnostics: raw AVL fix, projected live and
            smooth physics positions with short motion trails. Native source
            updates keep this out of Fabric's frame history. */}
        {debugMode && <DebugMapTraces />}
        {locationGranted && <LocationPuck puckBearingEnabled puckBearing="heading" />}
      </MapView>

      {/* Status and every other UI surface follow the device theme. */}
      <StatusBar style={chromeScheme === 'dark' ? 'light' : 'dark'} animated />

      <MapChromeSchemeContext.Provider value={chromeScheme}>
        <MapStatusTile leftInset={mapLeftInset} />
        {/* Connection honesty (physics-v3-protocol §"Connection honesty"): an
            explicit banner when the trajectory bundle has gone stale, so a
            frozen fleet is never presented as a live one. Renders null — and
            costs nothing — while the connection is live. */}
        <ConnectionBanner leftInset={mapLeftInset} />
        <MapControlStack
          is3D={is3D}
          onTogglePitch={onTogglePitch}
          onLocate={() => void onLocate()}
          locating={locating}
          sheetHeight={chromeHeight}
          sheetSnaps={chromeSnaps}
          sheetDocked={sheetDocked}
        />
        <MapChips
          leftInset={mapLeftInset}
          sheetHeight={chromeHeight}
          sheetSnaps={chromeSnaps}
          sheetDocked={sheetDocked}
        />
      </MapChromeSchemeContext.Provider>

      {/* The persistent home surface. An OWNED Liquid Glass sheet, not a native
          modal one: that is what lets the map read through it, lets the chrome
          ride with the drag frame-by-frame, lets Settings/search present
          instantly over it, and lets it dock as a column on iPad. Its pinned
          header is ALWAYS the compact product/search row. Every UI surface,
          including floating map chrome, follows the SYSTEM scheme. */}
      <MapSheet
        heightSV={sheetHeight}
        onSnapsChange={setSheetSnaps}
        // The regular-width workspace opens tall, but remains a real sheet: the
        // grabber can pull it through medium down to the compact product bar.
        // Phones keep their compact launch state.
        initialSnapIndex={sheetDocked ? 2 : 0}
        // Parked off screen while a tram card is on stage — it is translucent,
        // so leaving it up would show the search row through the card's glass.
        // A transform, not an unmount: the return trip is a morph.
        hidden={presentedTramKey != null}
        header={<HomeSearchRow />}
      >
        <HomeSheetContent live={homeLive} />
      </MapSheet>

      {/* THE TRAM CARD — the same owned sheet, with the tram's identity as its
          pinned header and a 0.42 middle detent. Dragging it down does not
          dismiss it onto some other surface: its smallest detent IS the bar, so
          the header settles in place at the same size. Keyed on the tram so
          switching trams re-seeds the card (live subscriptions, lastSeen and the
          open-at-card-detent spring all belong to one key). */}
      {presentedTramKey != null && (
        <TramSheet
          key={presentedTramKey}
          tramKey={presentedTramKey}
          heightSV={tramHeight}
          onSnapsChange={setTramSnaps}
        />
      )}

      {/* Invisible: while stop-spotting is active, drives the follow camera
          through the trams arriving at the spotted stop (1 Hz; renders null
          and costs nothing when inactive). */}
      <SpotterController />

      {/* Live physics/GPS debug readout for the followed tram (utilitarian).
          Mounted only in debug mode — see Settings ▸ Developer ▸ Debug mode. */}
      {debugMode && <DebugOverlay />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
