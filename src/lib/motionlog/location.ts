// Real LocationWatcher backed by expo-location. Requests foreground permission,
// then streams BestForNavigation fixes ~1 Hz. `start` rejects if permission is
// denied so the caller can surface it.
import * as Location from 'expo-location';

import type { LocationWatcher } from './core';

export function createExpoLocationWatcher(): LocationWatcher {
  return {
    async start(onSample) {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== Location.PermissionStatus.GRANTED) {
        throw new Error('Location permission denied');
      }
      const sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1_000,
          distanceInterval: 0,
        },
        (loc) => {
          onSample({
            t: loc.timestamp,
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            speed: loc.coords.speed,
            accuracy: loc.coords.accuracy,
          });
        },
      );
      return () => sub.remove();
    },
  };
}
