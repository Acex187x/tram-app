// Recorded-ride preview overlay: the rider's GPS track (blue) vs the simulated
// tram's track (orange), plus start/finish markers, drawn over the live map.
// Static by design — geometry is pushed ONCE when a preview is set (no frame
// loop, no ticking; perf invariants #2/#6 hold), and the camera fits the
// combined bounds once.
//
// IMPORTANT (verified on-device — see the note atop RouteNetwork.tsx): the
// ShapeSource is mounted ONCE with a stable empty FeatureCollection and
// receives geometry ONLY via setNativeProps. React must never commit a
// changing `shape` prop, or the native source reverts / never applies
// (Fabric + rnmapbox quirk).

import { Camera, CircleLayer, LineLayer, ShapeSource } from '@rnmapbox/maps';
import { useEffect, useRef, type RefObject } from 'react';

import type { LngLat } from '@/lib/geo/polyline';
import { useRidePreviewStore } from '@/stores/ridePreview';

/** GPS = iOS system blue, sim = iOS system orange (distinct in both themes). */
export const RIDE_GPS_COLOR = '#0A84FF';
export const RIDE_SIM_COLOR = '#FF9F0A';

type RideFC = GeoJSON.FeatureCollection<
  GeoJSON.LineString | GeoJSON.Point,
  { track?: 'gps' | 'sim'; marker?: 'start' | 'end' }
>;

const EMPTY_FC: RideFC = { type: 'FeatureCollection', features: [] };

export interface RideOverlayProps {
  cameraRef: RefObject<Camera | null>;
}

export function RideOverlay({ cameraRef }: RideOverlayProps) {
  const preview = useRidePreviewStore((s) => s.preview);
  const sourceRef = useRef<ShapeSource>(null);

  useEffect(() => {
    const features: RideFC['features'] = [];
    const gps: LngLat[] = preview?.ride.gpsTrack ?? [];
    const sim: LngLat[] = preview?.ride.simTrack ?? [];
    if (sim.length >= 2) {
      features.push({
        type: 'Feature',
        id: 'ride-sim',
        geometry: { type: 'LineString', coordinates: sim },
        properties: { track: 'sim' },
      });
    }
    if (gps.length >= 2) {
      features.push({
        type: 'Feature',
        id: 'ride-gps',
        geometry: { type: 'LineString', coordinates: gps },
        properties: { track: 'gps' },
      });
    }
    // Start/finish of the rider's own track (fall back to the sim track for
    // GPS-less files so orphaned/degenerate rides still show something).
    const anchor = gps.length >= 1 ? gps : sim;
    if (anchor.length >= 1) {
      features.push({
        type: 'Feature',
        id: 'ride-start',
        geometry: { type: 'Point', coordinates: anchor[0] },
        properties: { marker: 'start' },
      });
    }
    if (anchor.length >= 2) {
      features.push({
        type: 'Feature',
        id: 'ride-end',
        geometry: { type: 'Point', coordinates: anchor[anchor.length - 1] },
        properties: { marker: 'end' },
      });
    }

    const fc: RideFC = features.length > 0 ? { type: 'FeatureCollection', features } : EMPTY_FC;
    // Push imperatively, exactly once per preview change; clearing the preview
    // pushes the empty collection.
    sourceRef.current?.setNativeProps({ id: 'ride-preview', shape: JSON.stringify(fc) });

    if (features.length === 0) return;

    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const [lng, lat] of [...gps, ...sim]) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    if (!Number.isFinite(minLng)) return;
    cameraRef.current?.fitBounds(
      [maxLng, maxLat],
      [minLng, minLat],
      [120, 60, 120, 60],
      1000,
    );
  }, [preview, cameraRef]);

  return (
    <ShapeSource ref={sourceRef} id="ride-preview" shape={EMPTY_FC}>
      <LineLayer
        id="ride-track-sim"
        slot="top"
        filter={['==', ['get', 'track'], 'sim']}
        style={{
          lineColor: RIDE_SIM_COLOR,
          lineWidth: 4,
          lineOpacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
      <LineLayer
        id="ride-track-gps"
        slot="top"
        filter={['==', ['get', 'track'], 'gps']}
        style={{
          lineColor: RIDE_GPS_COLOR,
          lineWidth: 4,
          lineOpacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
          lineDasharray: [2, 1.2], // GPS dashed so overlapping tracks stay tellable
        }}
      />
      <CircleLayer
        id="ride-track-ends"
        slot="top"
        filter={['has', 'marker']}
        style={{
          circleRadius: 6,
          circleColor: [
            'case',
            ['==', ['get', 'marker'], 'start'],
            '#30D158', // start = green
            '#FF453A', // finish = red
          ],
          circleStrokeColor: '#FFFFFF',
          circleStrokeWidth: 2,
        }}
      />
    </ShapeSource>
  );
}
