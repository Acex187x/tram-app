// THE MAP SCREEN — heart of the app. Full-bleed 3D Mapbox Standard map of
// Prague with the live tram fleet, route network, planner overlay and Liquid
// Glass chrome. Sheets (tram/line/favorites/planner/search/settings) float
// over this screen as formSheets; the map keeps rendering beneath them.

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
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

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
import { HomeSheetNative } from '@/components/maps-kit/HomeSheetNative';
import {
  chromeLayoutForDetent,
  classifyDetent,
  type NativeDetent,
} from '@/components/maps-kit/sheetDetent';
import { HomeSheetContent, HomeSheetHeader } from '@/components/home/HomeSheetContent';
import { PlannerOverlay } from '@/components/map/PlannerOverlay';
import { RideOverlay } from '@/components/map/RideOverlay';
import { SpotterController } from '@/components/map/SpotterController';
import { RouteNetwork, STOP_TOTEM_MODEL_KEY } from '@/components/map/RouteNetwork';
import { TramLayers, type FollowGestureState } from '@/components/map/TramLayers';
import { orientationFromCamera, shouldPauseFollow } from '@/components/map/followCamera';
import { useTramModels } from '@/components/map/useTramModels';
import { getRuntime, useTramRuntime } from '@/hooks/tramData';
import type { Viewport } from '@/lib/types';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

Mapbox.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_KEY ?? null);

const PRAGUE_CENTER: [number, number] = [14.42, 50.082];
const INITIAL_ZOOM = 13.8;
const INITIAL_PITCH = 45;
const INITIAL_VIEWPORT: Viewport = {
  bbox: [14.32, 50.03, 14.52, 50.14],
  zoom: INITIAL_ZOOM,
};
/** Re-evaluate the 'auto' light preset this often. */
const LIGHT_REFRESH_MS = 5 * 60 * 1000;
/**
 * Peek height (px) of the home sheet — trimmed to reveal ONLY the search bar +
 * grabber (Apple Maps). The header block is grabber/top-pad (10) + row pad (6) +
 * search field (46) + row pad (12) ≈ 74; +12 lets the field clear the home
 * indicator without leaving a tall empty gap of sheet below it (the old
 * window-fraction peek was ~header + full safe-area = too tall, so the grouped
 * body edge peeked under the bar). Medium + large detents are owned natively.
 */
const PEEK_HEIGHT = 86;
/** Never leave the user stuck on the splash if the map fails to load. */
const SPLASH_FAILSAFE_MS = 8_000;

export default function MapScreen() {
  useTramRuntime(); // keeps polling + simulation alive while the map lives

  const cameraRef = useRef<Camera>(null);
  const viewportRef = useRef<Viewport>({ ...INITIAL_VIEWPORT });
  const splashHiddenRef = useRef(false);
  // Peek height (px) of the native home sheet. The map chrome (bottom-right
  // control column + contextual chips) is pinned just above this so the whole
  // cluster rides over the sheet's resting edge.
  const peekPx = PEEK_HEIGHT;
  const { height: windowHeight } = useWindowDimensions();
  // Map chrome (control column + contextual chips) rides UP with the home sheet
  // and fades out at the large detent — Apple Maps behaviour. The native sheet
  // exposes only its resting detent (no continuous position), so we spring these
  // two shared values on each discrete detent change: zero per-frame React, all
  // animation on the UI thread (docs/performance.md invariant #1).
  const chromeShift = useSharedValue(0);
  const chromeOpacity = useSharedValue(1);
  const onSheetDetentChange = useCallback(
    (detent: NativeDetent) => {
      const layout = chromeLayoutForDetent(classifyDetent(detent, PEEK_HEIGHT), {
        peekPx: PEEK_HEIGHT,
        windowHeight,
      });
      chromeShift.value = withSpring(layout.shift, { damping: 26, stiffness: 240, mass: 0.9 });
      chromeOpacity.value = withTiming(layout.opacity, { duration: 220 });
    },
    // Shared values are stable refs; only the window height affects the math.
    [windowHeight, chromeShift, chromeOpacity],
  );
  const [is3D, setIs3D] = useState(true);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const modelUris = useTramModels();

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
  // The chrome floats over the BASEMAP, so its light/dark appearance follows
  // the map's light preset — NOT the system scheme (a dark-mode phone over a
  // daytime map used to render white icons on white glass).
  const chromeScheme = lightPreset === 'dusk' || lightPreset === 'night' ? 'dark' : 'light';

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
    // Zoom-adaptive simulation rate (thermal): 60 Hz in the glide band
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
  }, []);

  // ── One-shot fly-to requests from search/line/favorites sheets ─────────────
  const flyToTarget = useSelectionStore((s) => s.flyToTarget);
  useEffect(() => {
    if (!flyToTarget) return;
    const selection = useSelectionStore.getState();
    if (selection.followTramKey) selection.setFollowTramKey(null);
    cameraRef.current?.setCamera({
      centerCoordinate: flyToTarget.coordinates,
      zoomLevel: flyToTarget.zoom ?? 15.5,
      animationMode: 'flyTo',
      animationDuration: 1300,
    });
    selection.requestFlyTo(null);
  }, [flyToTarget]);

  // Engaging follow snapshots the CURRENT camera orientation as the fixed
  // follow angle: the camera keeps the tram centered under exactly this
  // zoom/pitch/heading and never rotates toward the tram's bearing. Nothing
  // about the view changes on engage — only the center starts tracking. The
  // followed tram's geometry is prioritized so on-shape follow is smooth ASAP.
  const followTramKey = useSelectionStore((s) => s.followTramKey);
  useEffect(() => {
    if (!followTramKey) {
      followGestureRef.current = { orientation: null };
      return;
    }
    followGestureRef.current = { orientation: orientationFromCamera(cameraStateRef.current) };
    const state = getRuntime().engine.getState(followTramKey);
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
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      useSelectionStore.getState().setFollowTramKey(null);
      cameraRef.current?.setCamera({
        centerCoordinate: [pos.coords.longitude, pos.coords.latitude],
        zoomLevel: 15.5,
        animationMode: 'flyTo',
        animationDuration: 1200,
      });
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, []);

  const onTogglePitch = useCallback(() => {
    setIs3D((current) => {
      cameraRef.current?.setCamera({
        pitch: current ? 0 : 55,
        animationMode: 'easeTo',
        animationDuration: 550,
      });
      return !current;
    });
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        styleURL="mapbox://styles/mapbox/standard"
        scaleBarEnabled={false}
        // Keep required Mapbox ornaments clear of the BottomDock (centre) and
        // the bottom cluster (chips + locate): pin both to the bottom-left corner.
        // iOS ornament offsets are already safe-area-relative.
        logoPosition={{ bottom: 10, left: 12 }}
        attributionPosition={{ bottom: 10, left: 106 }}
        compassEnabled
        // Apple shows the compass only once the map is rotated off north; at
        // north-up it fades away instead of sitting there permanently.
        compassFadeWhenNorth
        // Apple pins the compass bottom-right, floating just above the map
        // control column (which sits over the home sheet's peek edge). Ornament
        // offsets are safe-area-relative on iOS.
        compassPosition={{ bottom: compassBottom(peekPx), right: COMPASS_RIGHT }}
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
        {locationGranted && <LocationPuck puckBearingEnabled puckBearing="heading" />}
      </MapView>

      <MapChromeSchemeContext.Provider value={chromeScheme}>
        <MapStatusTile />
        <MapControlStack
          is3D={is3D}
          onTogglePitch={onTogglePitch}
          onLocate={() => void onLocate()}
          peekPx={peekPx}
          chromeShift={chromeShift}
          chromeOpacity={chromeOpacity}
        />
        <MapChips peekPx={peekPx} chromeShift={chromeShift} chromeOpacity={chromeOpacity} />
      </MapChromeSchemeContext.Provider>

      {/* The persistent home surface — a REAL native iOS sheet (device-matched
          corners, native grabber/detents, map interactive behind it). Pinned
          search + account header; our own grouped-list body (favorites, planner,
          fleet, rides, recents) revealed on drag. Follows the system scheme;
          the map chrome above follows the map light preset. */}
      <HomeSheetNative
        peekPx={peekPx}
        // The peek search bar floats over the basemap at the sheet's resting
        // edge, on the SAME visual band as the map chrome — so it follows the map
        // light preset (day → light glass, night → dark glass), NOT the system
        // scheme, or it read as a lone dark slab beside the light StatusTile /
        // control column over a daytime map.
        header={<HomeSheetHeader chromeScheme={chromeScheme} />}
        onDetentChange={onSheetDetentChange}
      >
        <HomeSheetContent />
      </HomeSheetNative>

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
