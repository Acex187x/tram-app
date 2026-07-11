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
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveLightPreset, STANDARD_CONFIG } from '@/components/map/mapStyle';
import { BottomDock, ControlStack, FollowBanner, StatusChip } from '@/components/map/MapChrome';
import { PlannerOverlay } from '@/components/map/PlannerOverlay';
import { RouteNetwork, STOP_TOTEM_MODEL_KEY } from '@/components/map/RouteNetwork';
import { TramLayers, type FollowGestureState } from '@/components/map/TramLayers';
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
/** Never leave the user stuck on the splash if the map fails to load. */
const SPLASH_FAILSAFE_MS = 8_000;

export default function MapScreen() {
  useTramRuntime(); // keeps polling + simulation alive while the map lives

  const insets = useSafeAreaInsets();
  const cameraRef = useRef<Camera>(null);
  const viewportRef = useRef<Viewport>({ ...INITIAL_VIEWPORT });
  const splashHiddenRef = useRef(false);
  const [is3D, setIs3D] = useState(true);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const modelUris = useTramModels();

  // ── Light preset: settings override or Prague time-of-day, refreshed 5-min ─
  const lightPresetSetting = useSettingsStore((s) => s.lightPreset);
  const [lightClock, setLightClock] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setLightClock(Date.now()), LIGHT_REFRESH_MS);
    return () => clearInterval(iv);
  }, []);
  const lightPreset = resolveLightPreset(lightPresetSetting, lightClock);

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
  const followGestureRef = useRef<FollowGestureState>({ gestureActive: false, overrides: null });
  /** Latest camera params — seeds follow sessions so engaging changes nothing. */
  const cameraStateRef = useRef({ zoom: INITIAL_ZOOM, pitch: INITIAL_PITCH, heading: 0 });
  const onCameraChanged = useCallback((state: MapState) => {
    // Ref assignments only — no React work per camera event.
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

    // Follow-mode gestures do NOT cancel follow: while the user's fingers are
    // on the map we capture their chosen zoom/pitch/heading-offset (relative
    // to the tram bearing) and keep applying them on subsequent retargets.
    const gesture = followGestureRef.current;
    const isGestureActive = state.gestures.isGestureActive;
    const followKey = useSelectionStore.getState().followTramKey;
    if (followKey && isGestureActive) {
      gesture.gestureActive = true;
      const tram = getRuntime().engine.getState(followKey);
      if (tram) {
        const live = useSettingsStore.getState().positionMode === 'live';
        const bearing = live ? tram.observedBearing : tram.bearing;
        gesture.overrides = {
          zoom,
          pitch: state.properties.pitch,
          // Normalized to (-180, 180] so the shortest-way offset persists.
          headingOffset:
            ((((state.properties.heading - bearing) % 360) + 540) % 360) - 180,
        };
      }
    } else if (!isGestureActive) {
      gesture.gestureActive = false;
    }
  }, []);

  // Belt-and-braces: some gesture-end paths only surface via onMapIdle.
  const onMapIdle = useCallback(() => {
    followGestureRef.current.gestureActive = false;
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

  // Followed tram's geometry loads first (smooth on-shape follow ASAP). A new
  // follow session KEEPS the user's current zoom/pitch/heading — the camera
  // only flies to the tram, nothing else changes (the heading persists as an
  // offset from the tram bearing, so later rotation-with-the-tram feels
  // continuous). Gesture overrides still belong to a single follow session.
  const followTramKey = useSelectionStore((s) => s.followTramKey);
  useEffect(() => {
    if (!followTramKey) {
      followGestureRef.current = { gestureActive: false, overrides: null };
      return;
    }
    const state = getRuntime().engine.getState(followTramKey);
    const cam = cameraStateRef.current;
    const live = useSettingsStore.getState().positionMode === 'live';
    const bearing = state ? (live ? state.observedBearing : state.bearing) : cam.heading;
    followGestureRef.current = {
      gestureActive: false,
      overrides: {
        zoom: cam.zoom,
        pitch: cam.pitch,
        headingOffset: ((((cam.heading - bearing) % 360) + 540) % 360) - 180,
      },
    };
    if (state) getRuntime().prioritizeTrip(state.snapshot.tripId);
  }, [followTramKey]);

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
        compassEnabled
        compassPosition={{ top: insets.top + 178, right: 21 }}
        pitchEnabled
        onDidFinishLoadingMap={hideSplash}
        onDidFinishLoadingStyle={() => setStyleLoaded(true)}
        onCameraChanged={onCameraChanged}
        onMapIdle={onMapIdle}
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
        <TramLayers
          cameraRef={cameraRef}
          viewportRef={viewportRef}
          followGestureRef={followGestureRef}
          modelUris={modelUris}
        />
        {locationGranted && <LocationPuck puckBearingEnabled puckBearing="heading" />}
      </MapView>

      <StatusChip />
      <ControlStack is3D={is3D} onLocate={() => void onLocate()} onTogglePitch={onTogglePitch} />
      <FollowBanner />
      <BottomDock />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
