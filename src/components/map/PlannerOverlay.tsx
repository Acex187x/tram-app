// Planner itinerary overlay: each leg drawn as a bold gold casing with a
// line-colored inner stroke (PID red / night blue). When an itinerary is set,
// the camera fits its bounds once.
//
// IMPORTANT (verified on-device — see the note atop RouteNetwork.tsx): the
// ShapeSource is mounted ONCE with a stable empty FeatureCollection and receives
// geometry ONLY via setNativeProps. React must never commit a changing `shape`
// prop, or the native source reverts / never applies (Fabric + rnmapbox quirk).

import { Camera, LineLayer, ShapeSource } from '@rnmapbox/maps';
import { useEffect, useRef, type RefObject } from 'react';

import { Tram } from '@/constants/theme';
import { usePlannerStore } from '@/stores/planner';

type LegFC = GeoJSON.FeatureCollection<GeoJSON.LineString, { line: string; legIndex: number }>;

const EMPTY_FC: LegFC = { type: 'FeatureCollection', features: [] };

export interface PlannerOverlayProps {
  cameraRef: RefObject<Camera | null>;
}

export function PlannerOverlay({ cameraRef }: PlannerOverlayProps) {
  const itinerary = usePlannerStore((s) => s.itinerary);
  const sourceRef = useRef<ShapeSource>(null);

  useEffect(() => {
    // Build the leg FeatureCollection (skip legs whose shape is unknown).
    const features: LegFC['features'] = [];
    if (itinerary) {
      itinerary.legs.forEach((leg, i) => {
        if (leg.coordinates.length < 2) return;
        features.push({
          type: 'Feature',
          id: `leg-${i}`,
          geometry: { type: 'LineString', coordinates: leg.coordinates },
          properties: { line: leg.line, legIndex: i },
        });
      });
    }

    const fc: LegFC = features.length > 0 ? { type: 'FeatureCollection', features } : EMPTY_FC;
    // Push imperatively; clearing an itinerary pushes the empty collection.
    sourceRef.current?.setNativeProps({ id: 'planner-legs', shape: JSON.stringify(fc) });

    if (features.length === 0) return;

    // Fit the camera to the itinerary bounds when a new plan lands.
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const feature of features) {
      for (const [lng, lat] of feature.geometry.coordinates) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    cameraRef.current?.fitBounds(
      [maxLng, maxLat],
      [minLng, minLat],
      [120, 60, 220, 60], // generous bottom padding: planner sheet floats there
      1000,
    );
  }, [itinerary, cameraRef]);

  return (
    <ShapeSource ref={sourceRef} id="planner-legs" shape={EMPTY_FC}>
      <LineLayer
        id="planner-leg-casing"
        slot="top"
        style={{
          lineColor: Tram.gold,
          lineWidth: 9,
          lineOpacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
      <LineLayer
        id="planner-leg-inner"
        slot="top"
        style={{
          lineColor: [
            'case',
            ['>=', ['to-number', ['get', 'line']], 90],
            Tram.night,
            Tram.pidRed,
          ],
          lineWidth: 4,
          lineOpacity: 1,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
    </ShapeSource>
  );
}
