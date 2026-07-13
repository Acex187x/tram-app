// Tram route network drawn from loaded trip geometries: PID-red route lines
// (deduped by shapeId), gold highlight for the selected line, and clickable
// stop markers (white core + PID-red ring) at zoom ≥14 — OUR stops are the
// source of truth (Mapbox's own transit POIs are hidden via STANDARD_CONFIG).
// Tapping a stop opens /stop/<normalized station name>. At zoom ≥16 a 3D stop
// totem renders per stop when the 'stop-totem' GLB is registered (defensive:
// the layer is skipped if the models agent hasn't shipped the asset).
//
// While a planner itinerary is shown, the whole network (lines + stops) hides
// so ONLY the planned route + its trams remain readable; restored on clear.
//
// IMPORTANT (verified on-device): the sources are mounted ONCE with a stable
// empty FeatureCollection and receive data ONLY via setNativeProps on an
// interval — React must never commit a changing `shape` prop, or the native
// source reverts/never applies (Fabric + rnmapbox quirk). This mirrors how the
// tram layers push per-frame updates. (Layer STYLE props may change freely.)

import { CircleLayer, LineLayer, ModelLayer, ShapeSource, SymbolLayer } from '@rnmapbox/maps';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { Tram } from '@/constants/theme';
import { bearingAt } from '@/lib/geo/polyline';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { normalizeName } from '@/lib/planner/network';
import { usePlannerStore } from '@/stores/planner';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

const STOPS_MIN_ZOOM = 14;
/** Stop NAME labels appear from this zoom (close enough to matter). */
const STOP_LABEL_MIN_ZOOM = 15.8;
/** 3D stop totems appear from this zoom. */
const TOTEM_MIN_ZOOM = 16;
/** GLB registry key for the stop totem (shipped by the models workstream). */
export const STOP_TOTEM_MODEL_KEY = 'stop-totem';
const REFRESH_MS = 2_000;
/**
 * Real označníky stand on the platform, which in Prague is (almost always) to
 * the RIGHT of the track in the direction of travel — the 3D totem is shifted
 * perpendicular-right of the shape bearing by this much. The circle markers
 * stay at the true stop coordinates; only the totem moves.
 */
const TOTEM_RIGHT_OFFSET_M = 2.2;
const DEG2RAD = Math.PI / 180;
/** Meters per degree of latitude (WGS84, good enough at a 2 m scale). */
const M_PER_DEG_LAT = 111_320;

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Cheap growth detector so the expensive feature build + stringify only runs
 * when the loaded-geometry set actually changed (the set only grows).
 */
function networkFingerprint(geometries: ReturnType<typeof shapeCache.getAllLoaded>): string {
  let stops = 0;
  for (const g of geometries) stops += g.stops.length;
  return `${geometries.length}:${stops}`;
}

function buildFCs(geometries: ReturnType<typeof shapeCache.getAllLoaded>): {
  routes: string;
  stops: string;
  totems: string;
} {
  const routeFeatures: GeoJSON.Feature[] = [];
  const stopFeatures: GeoJSON.Feature[] = [];
  const totemFeatures: GeoJSON.Feature[] = [];
  const seenShapes = new Set<string>();
  const seenStops = new Set<string>();
  for (const g of geometries) {
    if (!seenShapes.has(g.shapeId) && g.coordinates.length >= 2) {
      seenShapes.add(g.shapeId);
      routeFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: g.coordinates },
        properties: { shapeId: g.shapeId, line: g.line },
      });
    }
    for (const stop of g.stops) {
      if (seenStops.has(stop.stopId)) continue;
      seenStops.add(stop.stopId);
      stopFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: stop.coordinates },
        properties: {
          stopId: stop.stopId,
          name: stop.name,
          // Station key convention shared with the planner network + the
          // /stop/[key] screen: normalized stop NAME groups platforms.
          stationKey: normalizeName(stop.name),
        },
      });
      // 3D totem twin of the stop. Platform stop ids are direction-specific,
      // so each stop belongs to exactly ONE travel direction — the shape
      // bearing at the stop's dist-along-shape IS its direction of travel.
      // Real označníky face AGAINST travel (info side toward the approaching
      // driver's cab): the model's front is authored toward −Z and the
      // ModelLayer sets modelRotation z = totemBearing (spike convention:
      // z = β makes the −Z front face compass bearing β).
      if (g.coordinates.length >= 2) {
        const bearing = bearingAt(g.coordinates, g.cumDistM, stop.distM);
        const totemBearing = (bearing + 180) % 360;
        // Shift perpendicular-RIGHT of travel onto the platform.
        const rightRad = (bearing + 90) * DEG2RAD;
        const lat = stop.coordinates[1];
        const dLat = (TOTEM_RIGHT_OFFSET_M * Math.cos(rightRad)) / M_PER_DEG_LAT;
        const dLng =
          (TOTEM_RIGHT_OFFSET_M * Math.sin(rightRad)) /
          (M_PER_DEG_LAT * Math.cos(lat * DEG2RAD));
        totemFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [stop.coordinates[0] + dLng, lat + dLat],
          },
          properties: {
            stopId: stop.stopId,
            totemBearing,
            // Data-driven model reference for the totem ModelLayer (the same
            // ['get','modelKey'] pattern the tram ModelLayer uses — verified).
            modelKey: STOP_TOTEM_MODEL_KEY,
          },
        });
      }
    }
  }
  return {
    routes: JSON.stringify({ type: 'FeatureCollection', features: routeFeatures }),
    stops: JSON.stringify({ type: 'FeatureCollection', features: stopFeatures }),
    totems: JSON.stringify({ type: 'FeatureCollection', features: totemFeatures }),
  };
}

export interface RouteNetworkProps {
  /**
   * True once the 'stop-totem' GLB is registered with <Models>. The totem
   * layer mounts one tick later so model registration always precedes the
   * layer (spike rule: models before ModelLayers).
   */
  stopTotemReady?: boolean;
}

export function RouteNetwork({ stopTotemReady = false }: RouteNetworkProps) {
  const scheme = useColorScheme();
  const showRouteLines = useSettingsStore((s) => s.showRouteLines);
  const selectedLineId = useSelectionStore((s) => s.selectedLineId);
  // Planner route-only mode: hide the whole network while an itinerary shows.
  const plannerActive = usePlannerStore((s) => s.itinerary != null);

  const routesRef = useRef<ShapeSource>(null);
  const stopsRef = useRef<ShapeSource>(null);
  const totemsRef = useRef<ShapeSource>(null);
  const fingerprintRef = useRef('');
  // Latest built totems FC, kept so the late-mounting totem source (it waits
  // for the GLB to register) can be seeded without rebuilding everything.
  const lastTotemsRef = useRef<string | null>(null);

  // Defer totem-layer mount until after the commit that registered the model.
  const [totemMounted, setTotemMounted] = useState(false);
  useEffect(() => {
    if (!stopTotemReady) {
      setTotemMounted(false);
      return;
    }
    const t = setTimeout(() => setTotemMounted(true), 150);
    return () => clearTimeout(t);
  }, [stopTotemReady]);

  // The totem source mounts AFTER the first data push (it waits for the GLB
  // registration) — seed it with the latest built FC once it exists.
  useEffect(() => {
    if (!totemMounted) return;
    const t = setTimeout(() => {
      if (lastTotemsRef.current) {
        totemsRef.current?.setNativeProps({
          id: 'route-stop-totems-src',
          shape: lastTotemsRef.current,
        });
      }
    }, 60);
    return () => clearTimeout(t);
  }, [totemMounted]);

  useEffect(() => {
    const push = () => {
      // Thermal: no work while backgrounded, and the expensive feature build
      // + stringify only runs when the loaded-geometry set actually grew.
      if (AppState.currentState !== 'active') return;
      const geometries = shapeCache.getAllLoaded();
      const fingerprint = networkFingerprint(geometries);
      if (fingerprint === fingerprintRef.current) return;
      fingerprintRef.current = fingerprint;
      const { routes, stops, totems } = buildFCs(geometries);
      lastTotemsRef.current = totems;
      routesRef.current?.setNativeProps({ id: 'route-network', shape: routes });
      stopsRef.current?.setNativeProps({ id: 'route-stops', shape: stops });
      totemsRef.current?.setNativeProps({ id: 'route-stop-totems-src', shape: totems });
    };
    // First push soon after mount (cache warm from disk), then poll for growth.
    const first = setTimeout(push, 800);
    const iv = setInterval(push, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, []);

  // Tap a stop → its station sheet (key = normalized stop name).
  const onPressStop = useCallback((event: { features: GeoJSON.Feature[] }) => {
    if (usePlannerStore.getState().itinerary) return; // hidden while planning
    const props = event.features[0]?.properties as
      | { stationKey?: string; name?: string }
      | undefined;
    const key = props?.stationKey ?? (props?.name ? normalizeName(props.name) : undefined);
    if (!key) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Cast: the /stop/[key] screen ships in a parallel workstream; the route
    // is already registered in _layout.tsx.
    router.push(`/stop/${encodeURIComponent(key)}` as Href);
  }, []);

  const linesVisible = showRouteLines && !plannerActive;

  // ShapeSource children must be a plain element array (no false/undefined
  // holes — rnmapbox clones each child to inject sourceID), so the optional
  // totem layer is appended conditionally.
  const stopLayers: ReactElement[] = [
    // Stop marker: white core + PID-red ring, growing with zoom.
    <CircleLayer
      key="route-stop-dots"
      id="route-stop-dots"
      slot="top"
      minZoomLevel={STOPS_MIN_ZOOM}
      style={{
        circleRadius: ['interpolate', ['linear'], ['zoom'], 14, 2.5, 16, 4.5, 18, 7],
        circleColor: '#FFFFFF',
        circleStrokeColor: Tram.pidRed,
        circleStrokeWidth: ['interpolate', ['linear'], ['zoom'], 14, 1.5, 18, 2.5],
        circleOpacity: plannerActive
          ? 0
          : ['interpolate', ['linear'], ['zoom'], STOPS_MIN_ZOOM, 0, STOPS_MIN_ZOOM + 0.4, 0.9],
        circleStrokeOpacity: plannerActive
          ? 0
          : ['interpolate', ['linear'], ['zoom'], STOPS_MIN_ZOOM, 0, STOPS_MIN_ZOOM + 0.4, 0.95],
        circlePitchAlignment: 'map',
      }}
    />,
    // Transparent hit target so stops are comfortably tappable.
    <CircleLayer
      key="route-stop-hit-targets"
      id="route-stop-hit-targets"
      slot="top"
      minZoomLevel={STOPS_MIN_ZOOM}
      style={{
        circleRadius: 20,
        circleColor: '#000000',
        circleOpacity: 0.011,
        circleStrokeWidth: 0,
      }}
    />,
    // Stop NAME labels at close zooms, anchored below the marker so the 3D
    // totem (which rises above it) stays clear. textOptional lets crowded
    // areas drop labels instead of markers; halo keeps them readable over the
    // basemap in both light and dark presets.
    <SymbolLayer
      key="route-stop-labels"
      id="route-stop-labels"
      slot="top"
      minZoomLevel={STOP_LABEL_MIN_ZOOM}
      style={{
        textField: ['get', 'name'],
        textFont: ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        textSize: ['interpolate', ['linear'], ['zoom'], STOP_LABEL_MIN_ZOOM, 11, 18, 13],
        textAnchor: 'top',
        textOffset: [0, 0.9],
        textColor: scheme === 'dark' ? '#F3E9D2' : '#4A2C2A',
        textHaloColor: scheme === 'dark' ? 'rgba(20,16,14,0.9)' : 'rgba(255,255,255,0.9)',
        textHaloWidth: 1.2,
        textOptional: true,
        textOpacity: plannerActive
          ? 0
          : [
              'interpolate',
              ['linear'],
              ['zoom'],
              STOP_LABEL_MIN_ZOOM,
              0,
              STOP_LABEL_MIN_ZOOM + 0.3,
              0.95,
            ],
      }}
    />,
  ];
  return (
    <>
      <ShapeSource ref={routesRef} id="route-network" shape={EMPTY_FC}>
        <LineLayer
          id="route-lines"
          slot="top"
          style={{
            lineColor: Tram.pidRed,
            lineOpacity: linesVisible ? 0.55 : 0,
            lineWidth: ['interpolate', ['linear'], ['zoom'], 11, 1.4, 16, 3.2],
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
        {/* Always mounted (ShapeSource children must be elements); the filter
            matches nothing while no line is selected. */}
        <LineLayer
          id="route-lines-selected"
          slot="top"
          filter={['==', ['get', 'line'], selectedLineId ?? '__none__']}
          style={{
            lineColor: Tram.gold,
            lineOpacity: plannerActive ? 0 : 0.95,
            lineWidth: 4,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      </ShapeSource>

      <ShapeSource ref={stopsRef} id="route-stops" shape={EMPTY_FC} onPress={onPressStop}>
        {stopLayers}
      </ShapeSource>

      {/* 3D stop totems live in their OWN source: positions are shifted ~2.2 m
          perpendicular-right of the track (onto the platform) while the circle
          markers above stay at the true stop coords. Mounted only once the GLB
          is registered — skipped entirely if the asset isn't shipped. */}
      {totemMounted && (
        <ShapeSource ref={totemsRef} id="route-stop-totems-src" shape={EMPTY_FC}>
          {[
            <ModelLayer
              key="route-stop-totems"
              id="route-stop-totems"
              slot="top"
              minZoomLevel={TOTEM_MIN_ZOOM}
              style={{
                modelId: ['get', 'modelKey'],
                // Front (−Z) faces AGAINST the direction of travel — toward
                // the approaching tram — like a real označník.
                modelRotation: [0, 0, ['get', 'totemBearing']] as unknown as number[],
                // Like the trams: oversized on entry, real-world 1.0 when close.
                modelScale: [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  TOTEM_MIN_ZOOM,
                  ['literal', [1.8, 1.8, 1.8]],
                  18,
                  ['literal', [1, 1, 1]],
                ],
                modelOpacity: plannerActive
                  ? 0
                  : [
                      'interpolate',
                      ['linear'],
                      ['zoom'],
                      TOTEM_MIN_ZOOM,
                      0,
                      TOTEM_MIN_ZOOM + 0.3,
                      1,
                    ],
                modelEmissiveStrength: 1,
                modelElevationReference: 'ground',
                modelType: 'common-3d',
                // Style-spec default is true — hundreds of totems would re-enable
                // the shadow passes the tram layers deliberately turned off.
                modelCastShadows: false,
                modelReceiveShadows: false,
              }}
            />,
          ]}
        </ShapeSource>
      )}
    </>
  );
}
