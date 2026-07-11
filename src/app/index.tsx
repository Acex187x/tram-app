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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  buildMapStyleJSON,
  resolveLightPreset,
  STANDARD_CONFIG,
} from '@/components/map/mapStyle';
import { BottomDock, ControlStack, FollowBanner, StatusChip } from '@/components/map/MapChrome';
import { PlannerOverlay } from '@/components/map/PlannerOverlay';
import { RouteNetwork } from '@/components/map/RouteNetwork';
import { TramLayers } from '@/components/map/TramLayers';
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
  // Style JSON is created once; later preset changes flow through StyleImport
  // so the style never reloads (reload would drop runtime layers/models).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const styleJSON = useMemo(() => buildMapStyleJSON(lightPreset), []);

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
  const onCameraChanged = useCallback((state: MapState) => {
    // Ref assignment only — no React work per camera event.
    const { ne, sw } = state.properties.bounds;
    viewportRef.current = {
      bbox: [sw[0], sw[1], ne[0], ne[1]],
      zoom: state.properties.zoom,
    };
  }, []);

  // Any touch on the map cancels tram-follow.
  const onMapTouchStart = useCallback(() => {
    const selection = useSelectionStore.getState();
    if (selection.followTramKey) selection.setFollowTramKey(null);
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

  // Followed tram's geometry loads first (smooth on-shape follow ASAP).
  const followTramKey = useSelectionStore((s) => s.followTramKey);
  useEffect(() => {
    if (!followTramKey) return;
    const state = getRuntime().engine.getState(followTramKey);
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
        styleJSON={styleJSON}
        scaleBarEnabled={false}
        compassEnabled
        compassPosition={{ top: insets.top + 178, right: 21 }}
        pitchEnabled
        onDidFinishLoadingMap={hideSplash}
        onCameraChanged={onCameraChanged}
        onTouchStart={onMapTouchStart}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: PRAGUE_CENTER,
            zoomLevel: INITIAL_ZOOM,
            pitch: INITIAL_PITCH,
          }}
        />
        {/* Live re-lighting of the Standard basemap (import id defined in styleJSON). */}
        <StyleImport
          id="basemap"
          existing
          config={{ ...STANDARD_CONFIG, lightPreset }}
        />
        <RouteNetwork />
        <PlannerOverlay cameraRef={cameraRef} />
        <TramLayers cameraRef={cameraRef} viewportRef={viewportRef} modelUris={modelUris} />
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
