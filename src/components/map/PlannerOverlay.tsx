// Planner itinerary overlay: each leg drawn as a bold gold casing with a
// line-colored inner stroke (PID red / night blue). When an itinerary is set,
// the camera fits its bounds once.

import { Camera, LineLayer, ShapeSource } from '@rnmapbox/maps';
import { useEffect, useMemo, type RefObject } from 'react';

import { Tram } from '@/constants/theme';
import { usePlannerStore } from '@/stores/planner';

type LegFC = GeoJSON.FeatureCollection<GeoJSON.LineString, { line: string; legIndex: number }>;

export interface PlannerOverlayProps {
  cameraRef: RefObject<Camera | null>;
}

export function PlannerOverlay({ cameraRef }: PlannerOverlayProps) {
  const itinerary = usePlannerStore((s) => s.itinerary);

  const legsFC = useMemo((): LegFC | null => {
    if (!itinerary) return null;
    const features: LegFC['features'] = [];
    itinerary.legs.forEach((leg, i) => {
      if (leg.coordinates.length < 2) return; // shape unknown for this leg
      features.push({
        type: 'Feature',
        id: `leg-${i}`,
        geometry: { type: 'LineString', coordinates: leg.coordinates },
        properties: { line: leg.line, legIndex: i },
      });
    });
    return features.length > 0 ? { type: 'FeatureCollection', features } : null;
  }, [itinerary]);

  // Fit the camera to the itinerary bounds when a new plan lands.
  useEffect(() => {
    if (!legsFC) return;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const feature of legsFC.features) {
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
  }, [legsFC, cameraRef]);

  if (!legsFC) return null;

  return (
    <ShapeSource id="planner-legs" shape={legsFC}>
      <LineLayer
        id="planner-leg-casing"
        slot="middle"
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
        slot="middle"
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
