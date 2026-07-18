// Record-ride control for the tram detail sheet. Starts/stops a GPS ride
// recording (real-vs-sim telemetry) via the MotionLog singleton, so recording
// survives the sheet closing. While active it shows a live reliability
// readout — points on disk, seconds since the last fix, file size, and whether
// background GPS is active (with an explicit warning when it is not) — because
// a recording the user cannot verify is a recording they cannot trust
// (two early recordings were lost silently). Stopping confirms the saved file
// with its path and size. Only one ride runs at a time; if a different tram is
// recording, this surfaces a chip pointing at it.
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Colors, Tram } from '@/constants/theme';
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

export function RideRecorder({ tramKey, line }: { tramKey: string; line: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const log = useMotionLog();

  const ride = log.rideInfo();
  const recordingThis = ride?.key === tramKey;
  const recordingOther = ride != null && ride.key !== tramKey;

  // Local 1 Hz ticker for the elapsed readout (points come via the log's
  // subscription through useMotionLog()).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ride) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ride]);

  const [busy, setBusy] = useState(false);

  const onStart = async () => {
    if (busy) return;
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
  };

  const onStop = async () => {
    if (busy) return;
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
  };

  // Recording a *different* tram — offer to stop it from here.
  if (recordingOther && ride) {
    return (
      <GlassPanel variant="clear" style={styles.card}>
        <View style={styles.row}>
          <RecDot />
          <View style={styles.rowText}>
            <Text style={[styles.title, { color: c.text }]}>Recording another tram</Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={1}>
              Tram #{ride.key} · {ride.points} pts · {fmtElapsed(Date.now() - ride.startedMs)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={onStop}
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
      <GlassPanel variant="clear" style={styles.card}>
        <View style={styles.row}>
          <RecDot />
          <View style={styles.rowText}>
            <Text style={[styles.title, { color: c.text }]} accessibilityLabel="Recording ride">
              Recording · {fmtElapsed(Date.now() - ride.startedMs)}
            </Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {ride.points} GPS pt{ride.points === 1 ? '' : 's'} · {lastLabel} · {fmtBytes(bytes)} on disk
            </Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
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
              <Text style={[styles.statusLine, { color: c.textSecondary }]}>Starting GPS…</Text>
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
            onPress={onStop}
            style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name="stop.fill" size={13} tintColor="#FFFFFF" />
            <Text style={styles.stopLabel}>Stop</Text>
          </Pressable>
        </View>
      </GlassPanel>
    );
  }

  // Idle — start button.
  return (
    <GlassPanel variant="clear" interactive style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Record ride"
        onPress={onStart}
        disabled={busy}
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
      >
        <SymbolView name="record.circle" size={26} tintColor={Tram.veryLate} />
        <View style={styles.rowText}>
          <Text style={[styles.title, { color: c.text }]}>Record ride</Text>
          <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={2}>
            Log GPS vs. simulated position on line {line} to help recalibrate the physics.
          </Text>
        </View>
      </Pressable>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: 18,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
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
