// Tram route network drawn from loaded trip geometries: PID-red route lines
// (deduped by shapeId), gold highlight for the selected line, and subtle stop
// dots at zoom ≥14. Rendered in the 'middle' slot so it always sits under the
// tram layers ('top' slot).

import { CircleLayer, LineLayer, ShapeSource } from '@rnmapbox/maps';
import { useMemo } from 'react';

import { Tram } from '@/constants/theme';
import { useLoadedGeometries } from '@/hooks/tramData';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

type RouteFC = GeoJSON.FeatureCollection<GeoJSON.LineString, { shapeId: string; line: string }>;
type StopFC = GeoJSON.FeatureCollection<GeoJSON.Point, { stopId: string; name: string }>;

const STOPS_MIN_ZOOM = 14;

export function RouteNetwork() {
  const geometries = useLoadedGeometries();
  const showRouteLines = useSettingsStore((s) => s.showRouteLines);
  const selectedLineId = useSelectionStore((s) => s.selectedLineId);

  // Geometries stream in over time; the array identity changes on every ~1 Hz
  // notify, so key the FC memo on a cheap shapeId fingerprint instead — the
  // FeatureCollections rebuild only when the loaded shape set actually changes.
  let shapeFingerprint = '';
  for (const g of geometries) shapeFingerprint += g.shapeId + '|';

  const { routesFC, stopsFC } = useMemo((): { routesFC: RouteFC; stopsFC: StopFC } => {
    const routeFeatures: RouteFC['features'] = [];
    const stopFeatures: StopFC['features'] = [];
    const seenShapes = new Set<string>();
    const seenStops = new Set<string>();
    for (const g of geometries) {
      if (!seenShapes.has(g.shapeId) && g.coordinates.length >= 2) {
        seenShapes.add(g.shapeId);
        routeFeatures.push({
          type: 'Feature',
          id: g.shapeId,
          geometry: { type: 'LineString', coordinates: g.coordinates },
          properties: { shapeId: g.shapeId, line: g.line },
        });
      }
      for (const stop of g.stops) {
        if (seenStops.has(stop.stopId)) continue;
        seenStops.add(stop.stopId);
        stopFeatures.push({
          type: 'Feature',
          id: stop.stopId,
          geometry: { type: 'Point', coordinates: stop.coordinates },
          properties: { stopId: stop.stopId, name: stop.name },
        });
      }
    }
    return {
      routesFC: { type: 'FeatureCollection', features: routeFeatures },
      stopsFC: { type: 'FeatureCollection', features: stopFeatures },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeFingerprint]);

  return (
    <>
      <ShapeSource id="route-network" shape={routesFC}>
        <LineLayer
          id="route-lines"
          slot="middle"
          style={{
            lineColor: Tram.pidRed,
            lineOpacity: showRouteLines ? 0.6 : 0,
            lineWidth: 2.5,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
        {/* Always mounted (ShapeSource children must be elements); the filter
            matches nothing while no line is selected. */}
        <LineLayer
          id="route-lines-selected"
          slot="middle"
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

      <ShapeSource id="route-stops" shape={stopsFC}>
        <CircleLayer
          id="route-stop-dots"
          slot="middle"
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
