// SPIKE SCREEN — validates the riskiest assumptions before real implementation:
// 1. @rnmapbox/maps builds & renders Standard 3D style on Expo SDK 57
// 2. ModelLayer renders bundled GLBs with data-driven modelRotation ['get','bearing']
// 3. ShapeSource.setNativeProps sustains ~15fps updates
// Will be replaced by the real map screen.
import Mapbox, {
  Camera,
  CircleLayer,
  MapView,
  ModelLayer,
  Models,
  ShapeSource,
} from '@rnmapbox/maps';
import { Asset } from 'expo-asset';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

Mapbox.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_KEY ?? null);

// Národní třída area — tram tracks run roughly east-west here.
const CENTER: [number, number] = [14.4189, 50.0813];

function feature(id: string, lng: number, lat: number, bearing: number) {
  return {
    type: 'Feature' as const,
    id,
    properties: { bearing, modelKey: 'arrow' },
    geometry: { type: 'Point' as const, coordinates: [lng, lat] },
  };
}

// Static calibration row: bearings 0/90/180/270 west-to-east.
const staticFeatures = [
  feature('b0', 14.4165, 50.0813, 0),
  feature('b90', 14.417, 50.0813, 90),
  feature('b180', 14.4175, 50.0813, 180),
  feature('b270', 14.418, 50.0813, 270),
];

export default function SpikeScreen() {
  const movingRef = useRef<ShapeSource>(null);
  const [modelUri, setModelUri] = useState<string | null>(null);

  useEffect(() => {
    Asset.fromModule(require('../../assets/models/spike-arrow.glb'))
      .downloadAsync()
      .then((a) => setModelUri(a.localUri))
      .catch((e) => console.error('model asset load failed', e));
  }, []);

  useEffect(() => {
    let t = 0;
    const iv = setInterval(() => {
      t += 1;
      const lng = 14.4185 + (t % 150) * 0.00002;
      movingRef.current?.setNativeProps({
        // @ts-expect-error shape accepts stringified GeoJSON
        shape: JSON.stringify({
          type: 'FeatureCollection',
          features: [feature('mover', lng, 50.0817, 90)],
        }),
      });
    }, 66);
    return () => clearInterval(iv);
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        styleURL={Mapbox.StyleURL.Standard}
        scaleBarEnabled={false}
      >
        <Camera
          defaultSettings={{ centerCoordinate: [14.4172, 50.0813], zoomLevel: 17.2, pitch: 55, heading: 0 }}
        />
        {modelUri != null && <Models models={{ arrow: modelUri }} />}
        <ShapeSource
          id="calib"
          shape={{ type: 'FeatureCollection', features: staticFeatures }}
        >
          <ModelLayer
            id="calib-models"
            slot="top"
            style={{
              modelId: ['get', 'modelKey'],
              modelRotation: [0, 0, ['get', 'bearing']],
              modelScale: [2, 2, 2],
            }}
          />
          <CircleLayer
            id="calib-dots"
            style={{ circleRadius: 5, circleColor: '#00c8ff', circleOpacity: 0.8 }}
          />
        </ShapeSource>
        <ShapeSource
          id="mover"
          ref={movingRef}
          shape={{ type: 'FeatureCollection', features: [feature('mover', 14.4185, 50.0817, 90)] }}
        >
          <ModelLayer
            id="mover-model"
            style={{
              modelId: 'arrow',
              modelRotation: [0, 0, 90],
              modelScale: [1, 1, 1],
            }}
          />
        </ShapeSource>
      </MapView>
      <View style={styles.badge} pointerEvents="none">
        <Text style={styles.badgeText}>SPIKE: red nose = model front, row bearings 0/90/180/270</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  badge: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  badgeText: { color: 'white', fontSize: 12 },
});
