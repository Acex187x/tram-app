// Ride GPS watcher backed by expo-location BACKGROUND location updates
// (SDK 57: startLocationUpdatesAsync + expo-task-manager), so a ride keeps
// recording while the app is backgrounded — the foreground-only
// watchPositionAsync stream died on suspend, which froze recordings the moment
// the phone locked. iOS: verified against expo-location 57.0.2 native source —
// startLocationUpdatesAsync only requires the FOREGROUND (when-in-use)
// permission ("As a user-initiated foreground service, this does NOT require
// the background location permission", LocationModule.swift) and
// EXLocationTaskConsumer sets allowsBackgroundLocationUpdates = YES; combined
// with UIBackgroundModes ["location"] (app.json) the fixes keep flowing in the
// background with the blue status-bar indicator. No "Always" prompt is needed.
//
// If the background route is unavailable (web, missing background mode,
// Android without the foreground-service manifest entries), start() falls back
// to the historic foreground-only watchPositionAsync and reports
// mode() === 'foreground' so the UI can warn honestly.
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type { LocationSample, LocationWatcher, LocationWatchMode } from './core';

export const RIDE_LOCATION_TASK = 'tramspotter-ride-location';

/** The live ride's sample sink; null when no ride is recording in this JS session. */
let activeHandler: ((s: LocationSample) => void) | null = null;

function toSample(loc: Location.LocationObject): LocationSample {
  return {
    t: loc.timestamp,
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    speed: loc.coords.speed,
    accuracy: loc.coords.accuracy,
  };
}

// Expo v57 TaskManager contract: defineTask MUST run in the global scope of
// the JS bundle (never inside React lifecycles) — when iOS relaunches the app
// in the background to deliver locations, the bundle is evaluated headless and
// this registration is all that exists. This module is imported at startup via
// src/app/_layout.tsx.
TaskManager.defineTask(RIDE_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
  const handler = activeHandler;
  if (!handler) {
    // Relaunched (or reloaded) with no live ride in this JS session: the old
    // ride file is closed by orphan recovery; stop the hardware so the blue
    // indicator doesn't linger forever.
    await Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK).catch(() => {});
    return;
  }
  for (const loc of locations) handler(toSample(loc));
});

export function createExpoLocationWatcher(): LocationWatcher {
  let mode: LocationWatchMode | null = null;
  return {
    mode: () => mode,

    async start(onSample) {
      // When-in-use is enough for the background task route (see header note);
      // it is also all the fallback route needs.
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== Location.PermissionStatus.GRANTED) {
        throw new Error('Location permission denied');
      }
      activeHandler = onSample;
      try {
        // A stale registration from a crashed session would double-deliver.
        if (await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)) {
          await Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK);
        }
        await Location.startLocationUpdatesAsync(RIDE_LOCATION_TASK, {
          accuracy: Location.Accuracy.BestForNavigation,
          activityType: Location.ActivityType.AutomotiveNavigation,
          // The honest "app is using your location" blue pill while backgrounded.
          showsBackgroundLocationIndicator: true,
          timeInterval: 1_000, // Android pacing; iOS ignores it
          distanceInterval: 5, // one fix per ~5 m of movement (~2 Hz on a moving tram)
          // Native default is TRUE (EXLocationTaskConsumer.m) — iOS would
          // silently stop deliveries when it judges the rider stationary
          // (tram dwelling at a stop) and might not resume promptly.
          pausesUpdatesAutomatically: false,
          foregroundService: {
            // Android: a foreground service is what keeps recording alive with
            // the screen off (requires the expo-location plugin's
            // foreground-service option in app.json to take effect).
            notificationTitle: 'Tram Spotter is recording your ride',
            notificationBody: 'Logging GPS vs. simulation telemetry.',
          },
        });
        mode = 'background';
        return () => {
          if (activeHandler === onSample) activeHandler = null;
          mode = null;
          void Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK).catch(() => {});
        };
      } catch {
        // Background route unavailable — record in the foreground only rather
        // than not at all, and let mode() tell the UI the truth.
        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1_000,
            distanceInterval: 0,
          },
          (loc) => onSample(toSample(loc)),
        );
        mode = 'foreground';
        return () => {
          if (activeHandler === onSample) activeHandler = null;
          mode = null;
          sub.remove();
        };
      }
    },
  };
}
