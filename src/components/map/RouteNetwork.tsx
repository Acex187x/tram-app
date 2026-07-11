// Tram route network drawn from loaded trip geometries: PID-red route lines
// (deduped by shapeId), gold highlight for the selected line, and subtle stop
// dots at zoom ≥14.
//
// IMPORTANT (verified on-device): the sources are mounted ONCE with a stable
// empty FeatureCollection and receive data ONLY via setNativeProps on an
// interval — React must never commit a changing `shape` prop, or the native
// source reverts/never applies (Fabric + rnmapbox quirk). This mirrors how the
// tram layers push per-frame updates.

import { CircleLayer, LineLayer, ShapeSource } from '@rnmapbox/maps';
import { useEffect, useRef } from 'react';

import { Tram } from '@/constants/theme';
import * as shapeCache from '@/lib/golemio/shapeCache';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

const STOPS_MIN_ZOOM = 14;
const REFRESH_MS = 2_000;

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function buildFCs(): { routes: string; stops: string; fingerprint: string } {
  const geometries = shapeCache.getAllLoaded();
  const routeFeatures: GeoJSON.Feature[] = [];
  const stopFeatures: GeoJSON.Feature[] = [];
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
        properties: { stopId: stop.stopId, name: stop.name },
      });
    }
  }
  return {
    routes: JSON.stringify({ type: 'FeatureCollection', features: routeFeatures }),
    stops: JSON.stringify({ type: 'FeatureCollection', features: stopFeatures }),
    fingerprint: `${seenShapes.size}:${seenStops.size}`,
  };
}

export function RouteNetwork() {
  const showRouteLines = useSettingsStore((s) => s.showRouteLines);
  const selectedLineId = useSelectionStore((s) => s.selectedLineId);

  const routesRef = useRef<ShapeSource>(null);
  const stopsRef = useRef<ShapeSource>(null);
  const fingerprintRef = useRef('');

  useEffect(() => {
    const push = () => {
      const { routes, stops, fingerprint } = buildFCs();
      if (fingerprint === fingerprintRef.current) return;
      fingerprintRef.current = fingerprint;
      routesRef.current?.setNativeProps({ id: 'route-network', shape: routes });
      stopsRef.current?.setNativeProps({ id: 'route-stops', shape: stops });
    };
    // First push soon after mount (cache warm from disk), then poll for growth.
    const first = setTimeout(push, 800);
    const iv = setInterval(push, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, []);

  return (
    <>
      <ShapeSource ref={routesRef} id="route-network" shape={EMPTY_FC}>
        <LineLayer
          id="route-lines"
          slot="top"
          style={{
            lineColor: Tram.pidRed,
            lineOpacity: showRouteLines ? 0.55 : 0,
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
            lineOpacity: 0.95,
            lineWidth: 4,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      </ShapeSource>

      <ShapeSource ref={stopsRef} id="route-stops" shape={EMPTY_FC}>
        <CircleLayer
          id="route-stop-dots"
          slot="top"
          minZoomLevel={STOPS_MIN_ZOOM}
          style={{
            circleRadius: ['interpolate', ['linear'], ['zoom'], 14, 2, 16.5, 4.5],
            circleColor: '#FFFFFF',
            circleStrokeColor: Tram.pidRed,
            circleStrokeWidth: 1.5,
            circleOpacity: [
              'interpolate',
              ['linear'],
              ['zoom'],
              STOPS_MIN_ZOOM,
              0,
              STOPS_MIN_ZOOM + 0.4,
              0.75,
            ],
            circleStrokeOpacity: [
              'interpolate',
              ['linear'],
              ['zoom'],
              STOPS_MIN_ZOOM,
              0,
              STOPS_MIN_ZOOM + 0.4,
              0.8,
            ],
            circlePitchAlignment: 'map',
          }}
        />
      </ShapeSource>
    </>
  );
}
