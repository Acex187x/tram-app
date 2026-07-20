// Ride recording control for the tram detail sheet, re-skinned to Apple Maps.
// The start/stop entry point now lives behind the floating action bar's
// record.circle item (the screen drives it via `useRideRecorder`); this file
// owns the shared recording logic (MotionLog singleton, one-ride-at-a-time
// rule, save confirmation) and the thin active-status strip that appears in the
// card while a ride is running.
//
// The MotionLog data flow is unchanged: recording survives the sheet closing,
// only one ride runs at a time, and the live reliability readout (points on
// disk, seconds since the last fix, background-GPS state, stall warning) is
// preserved — a recording the user cannot verify is a recording they cannot
// trust (two early rides were lost silently).
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { appleScheme, Tram } from '@/constants/theme';
import { useMotionLog } from '@/lib/motionlog';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Pulsing red "recording" dot. */
function RecDot() {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[styles.recDot, { opacity: pulse }]} />;
}

// ── shared ride control ──────────────────────────────────────────────────────

export interface RideControl {
  recordingThis: boolean;
  recordingOther: boolean;
  busy: boolean;
  /** Start (idle) / stop (recording this) / warn (recording another). */
  toggle: () => void;
  /** Stop the current ride, with the "Ride saved" confirmation. */
  stop: () => void;
  /** The tram key of the ride in progress, if any. */
  ridingKey: string | null;
}

/**
 * The tram sheet's ride control. Wraps the MotionLog singleton so both the
 * floating-action-bar record item and the in-card status strip share one code
 * path (start / stop / save-confirm / one-ride rule).
 */
export function useRideRecorder(tramKey: string): RideControl {
  const log = useMotionLog();
  const ride = log.rideInfo();
  const recordingThis = ride?.key === tramKey;
  const recordingOther = ride != null && ride.key !== tramKey;
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    setBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const ok = await log.startRide(tramKey);
      if (!ok) {
        Alert.alert(
          'Cannot start recording',
          'Location permission is needed to record a ride. Enable it in Settings and try again.',
        );
      }
    } finally {
      setBusy(false);
    }
  }, [log, tramKey]);

  const stop = useCallback(async () => {
    setBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
    try {
      const saved = await log.stopRide();
      if (saved) {
        // Explicit save confirmation — the user must be able to verify the
        // recording exists (two early rides vanished silently).
        Alert.alert(
          'Ride saved',
          `${saved.relPath}\n${saved.points} GPS point${saved.points === 1 ? '' : 's'} · ` +
            `${saved.motionSamples} motion sample${saved.motionSamples === 1 ? '' : 's'}` +
            `${saved.gpsRejects > 0 ? ` · ${saved.gpsRejects} outlier${saved.gpsRejects === 1 ? '' : 's'} flagged` : ''}` +
            ` · ${fmtBytes(saved.bytes)}`,
          [
            { text: 'View rides', onPress: () => router.push('/rides' as Href) },
            { text: 'OK', style: 'default' },
          ],
        );
      }
    } finally {
      setBusy(false);
    }
  }, [log]);

  const toggle = useCallback(() => {
    if (busy) return;
    if (recordingThis) {
      void stop();
    } else if (recordingOther) {
      Alert.alert(
        'Recording another tram',
        `A ride on tram #${ride?.key} is in progress. Stop it before starting a new one.`,
      );
    } else {
      void start();
    }
  }, [busy, recordingThis, recordingOther, ride?.key, start, stop]);

  const stopNow = useCallback(() => {
    if (!busy) void stop();
  }, [busy, stop]);

  return {
    recordingThis,
    recordingOther,
    busy,
    toggle,
    stop: stopNow,
    ridingKey: ride?.key ?? null,
  };
}

// ── in-card status strip ─────────────────────────────────────────────────────

/**
 * Thin recording-status strip shown in the tram card while a ride is running.
 * Renders nothing when idle (the record.circle bar item is the start affordance).
 * When a DIFFERENT tram is recording it surfaces a chip pointing at it with a
 * Stop control.
 */
export function RideStatusStrip({ tramKey }: { tramKey: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const log = useMotionLog();
  const { recordingThis, recordingOther, stop } = useRideRecorder(tramKey);

  const ride = log.rideInfo();

  // Local 1 Hz ticker for the elapsed readout (point counts arrive via the
  // log's subscription through useMotionLog()).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ride) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ride]);

  if (recordingOther && ride) {
    return (
      <GlassPanel variant="clear" style={styles.strip}>
        <View style={styles.row}>
          <RecDot />
          <View style={styles.rowText}>
            <Text style={[styles.title, { color: c.text }]}>Recording another tram</Text>
            <Text style={[styles.subtitle, { color: c.secondary }]} numberOfLines={1}>
              Tram #{ride.key} · {ride.points} pts · {fmtElapsed(Date.now() - ride.startedMs)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop recording"
            onPress={stop}
            style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.stopLabel}>Stop</Text>
          </Pressable>
        </View>
      </GlassPanel>
    );
  }

  if (recordingThis && ride) {
    const bytes = log.rideFileBytes();
    const mode = log.rideLocationMode();
    const motionOn = log.rideMotionActive();
    const lastAgoS =
      ride.lastPointMs != null ? Math.max(0, Math.round((Date.now() - ride.lastPointMs) / 1000)) : null;
    const lastLabel =
      lastAgoS == null ? 'no fix yet' : lastAgoS <= 1 ? 'fix just now' : `last fix ${lastAgoS} s ago`;
    // A fix gap > 15 s while recording means GPS delivery has stalled.
    const stalled = lastAgoS != null && lastAgoS > 15;
    return (
      <GlassPanel variant="clear" style={styles.strip}>
        <View style={styles.row}>
          <RecDot />
          <View style={styles.rowText}>
            <Text style={[styles.title, { color: c.text }]} accessibilityLabel="Recording ride">
              Recording · {fmtElapsed(Date.now() - ride.startedMs)}
            </Text>
            <Text style={[styles.subtitle, { color: c.secondary }]}>
              {ride.points} GPS pt{ride.points === 1 ? '' : 's'} · {lastLabel} · {fmtBytes(bytes)} on disk
            </Text>
            <Text style={[styles.subtitle, { color: c.secondary }]}>
              {motionOn
                ? `${ride.motionSamples} motion samples @ 25 Hz`
                : 'Motion sensor off — GPS only'}
              {ride.gpsRejects > 0
                ? ` · ${ride.gpsRejects} outlier${ride.gpsRejects === 1 ? '' : 's'} filtered`
                : ''}
            </Text>
            {mode === 'background' ? (
              <Text style={[styles.statusLine, { color: Tram.onTime }]}>
                Background GPS active — recording continues if you leave the app
              </Text>
            ) : mode === 'foreground' ? (
              <Text style={[styles.statusLine, { color: Tram.late }]}>
                Foreground only — keep the app open or the recording pauses
              </Text>
            ) : (
              <Text style={[styles.statusLine, { color: c.secondary }]}>Starting GPS…</Text>
            )}
            {stalled && (
              <Text style={[styles.statusLine, { color: Tram.veryLate }]}>
                GPS stalled — check the location permission in Settings
              </Text>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop recording"
            onPress={stop}
            style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name="stop.fill" size={13} tintColor="#FFFFFF" />
            <Text style={styles.stopLabel}>Stop</Text>
          </Pressable>
        </View>
      </GlassPanel>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  strip: {
    borderCurve: 'continuous',
    borderRadius: 16,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  rowText: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 12, lineHeight: 16 },
  statusLine: { fontSize: 11, fontWeight: '600', lineHeight: 15 },
  recDot: {
    backgroundColor: Tram.veryLate,
    borderRadius: 7,
    height: 14,
    marginHorizontal: 6,
    width: 14,
  },
  stopBtn: {
    alignItems: 'center',
    backgroundColor: Tram.veryLate,
    borderCurve: 'continuous',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  stopLabel: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
});
