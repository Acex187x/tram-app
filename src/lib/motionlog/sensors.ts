// High-rate device-motion watcher for ride recordings, backed by expo-sensors
// DeviceMotion (SDK 57). GPS is ~1–2 Hz and noisy; the IMU gives ~25 Hz
// relative-motion truth (user acceleration + rotation rate + attitude) that
// the offline analysis can fuse with the GPS track (dead-reckon between fixes,
// detect stops/starts/braking envelopes precisely).
//
// Honest platform limits (verified against expo-sensors 57.0.2 / CoreMotion):
//   • DeviceMotion delivers via CMMotionManager on the JS thread — it works
//     while the PROCESS is alive. With no background mode of its own, samples
//     STOP when iOS suspends the app. During a ride recording, the active
//     expo-location background session (UIBackgroundModes: location) keeps the
//     process running, so in practice motion often keeps flowing while
//     backgrounded — but this is a side effect, not an API contract. The ride
//     file records whatever arrives; gaps in motion coverage are visible in
//     the data itself (t0/dt), and GPS remains the guaranteed background
//     stream. See docs/decisions/ride-recording.md.
//   • iOS requires NSMotionUsageDescription (expo-sensors config plugin,
//     app.json `motionPermission`) — requestPermissionsAsync() surfaces it.
//   • 25 Hz is the deliberate rate: enough bandwidth for tram dynamics
//     (accel/brake transients are < 2 Hz; track vibration analysis is not a
//     goal), ~1.4 KB/s on disk, negligible battery vs. the GPS already running.
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';

import type { MotionSample, MotionWatcher } from './core';

/** 25 Hz — see the rate rationale above. */
export const MOTION_UPDATE_INTERVAL_MS = 40;

/**
 * Map a DeviceMotionMeasurement to the compact ride MotionSample. `t` is the
 * delivery wall-clock ms (the native per-sensor timestamps are boot-relative
 * seconds and platform-inconsistent; at 25 Hz delivery jitter is ~ms and the
 * batch t0/dt encoding keeps ordering exact).
 */
export function toMotionSample(m: DeviceMotionMeasurement, t: number): MotionSample {
  return {
    t,
    // User acceleration (gravity removed), m/s² — null on devices without a
    // gyroscope (no attitude → no gravity separation).
    ax: m.acceleration?.x ?? null,
    ay: m.acceleration?.y ?? null,
    az: m.acceleration?.z ?? null,
    // Rotation rate, deg/s.
    ra: m.rotationRate?.alpha ?? null,
    rb: m.rotationRate?.beta ?? null,
    rg: m.rotationRate?.gamma ?? null,
    // Attitude (device orientation in space), rad — lets the analysis rotate
    // the user acceleration into the world frame offline.
    oa: m.rotation?.alpha ?? null,
    ob: m.rotation?.beta ?? null,
    og: m.rotation?.gamma ?? null,
  };
}

/**
 * Real MotionWatcher over expo-sensors DeviceMotion. `start` rejects when the
 * sensor is unavailable or the motion permission is denied — the caller
 * (MotionLog.startRide) treats that as "record GPS only", never as a failed
 * ride.
 */
export function createExpoDeviceMotionWatcher(): MotionWatcher {
  return {
    async start(onSample: (s: MotionSample) => void): Promise<() => void> {
      if (!(await DeviceMotion.isAvailableAsync())) {
        throw new Error('DeviceMotion unavailable');
      }
      const perm = await DeviceMotion.requestPermissionsAsync();
      if (!perm.granted) {
        throw new Error('Motion permission denied');
      }
      DeviceMotion.setUpdateInterval(MOTION_UPDATE_INTERVAL_MS);
      const sub = DeviceMotion.addListener((m) => onSample(toMotionSample(m, Date.now())));
      return () => sub.remove();
    },
  };
}
