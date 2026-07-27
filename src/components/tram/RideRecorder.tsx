// Ride recording control for the tram detail sheet, re-skinned to Apple Maps.
//
// WHERE THE ENTRY POINT LIVES, AND WHY IT MOVED. It used to be an item in the
// floating action pill's ⋯ menu, i.e. two taps from every user's tram card.
// Recording a ride is a CALIBRATION tool (it writes a GPS + motion trace for the
// physics loop, see docs/calibration/plan.md) and means nothing to anyone else,
// so the start affordance is now a plain content section — `RideRecordSection`
// — rendered ONLY in debug mode. A recording already in progress is a different
// matter and is never gated: `RideStatusStrip` surfaces it, with its Stop
// control, whatever the debug flag says.
//
// This file owns the shared recording logic (MotionLog singleton,
// one-ride-at-a-time rule, save confirmation), the debug-only start row and the
// active-status strip.
//
// The MotionLog data flow is unchanged: recording survives the sheet closing,
// only one ride runs at a time, and the live reliability readout (points on
// disk, seconds since the last fix, background-GPS state, stall warning) is
// preserved — a recording the user cannot verify is a recording they cannot
// trust (two early rides were lost silently).
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { InsetGroup, InsetRow, SectionLabel } from '@/components/ui/Inset';
import { appleScheme, TabularNums, Tram } from '@/constants/theme';
import { useNowMs } from '@/hooks/uiClock';
import { useMotionLog } from '@/lib/motionlog';
import { useSettingsStore } from '@/stores/settings';

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
  // Lazy useState, not useRef(new Animated.Value(…)).current: reading `.current`
  // during render is a compiler-visible impurity, and the initializer runs once
  // either way (same stable instance for the component's lifetime).
  const [pulse] = useState(() => new Animated.Value(1));
  // Legacy RN Animated has no Reduce Motion default (Reanimated's does), and
  // this loop runs for the whole length of a ride — hold it solid instead.
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);
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

// ── debug-only start affordance ──────────────────────────────────────────────

/**
 * The "Record ride" row in the tram card's content — a grouped-inset section
 * sitting beside the live status strip, exactly where the old full-screen tram
 * detail screen kept it.
 *
 * DEBUG-GATED, and the gate lives here rather than at the call site so it cannot
 * be forgotten by a second caller: without `Settings ▸ Developer ▸ Debug mode`
 * this renders nothing at all and an ordinary user has no way to start a
 * recording. Stopping one is never gated — that is `RideStatusStrip`.
 */
export function RideRecordSection({ tramKey }: { tramKey: string }) {
  const debugMode = useSettingsStore((s) => s.debugMode);
  const { recordingThis, recordingOther, toggle } = useRideRecorder(tramKey);
  if (!debugMode) return null;
  return (
    <View>
      <SectionLabel>Ride recording (debug)</SectionLabel>
      <InsetGroup>
        <InsetRow
          icon={recordingThis ? 'stop.fill' : 'record.circle'}
          iconTint={Tram.veryLate}
          title={recordingThis ? 'Stop ride recording' : 'Record ride'}
          subtitle={
            recordingOther
              ? 'Another tram is being recorded'
              : 'Logs GPS + motion to a file for physics calibration'
          }
          destructive={recordingThis}
          // `toggle` no-ops while a start/stop is in flight, so the row stays a
          // button throughout instead of flickering into a dead View.
          onPress={toggle}
        />
      </InsetGroup>
    </View>
  );
}

// ── in-card status strip ─────────────────────────────────────────────────────

/**
 * Thin recording-status strip shown in the tram card while a ride is running.
 * Renders nothing when idle (`RideRecordSection` is the start affordance).
 * When a DIFFERENT tram is recording it surfaces a chip pointing at it with a
 * Stop control. NOT debug-gated: a running recording must always be visible and
 * stoppable, including on a build where debug mode was switched off mid-ride.
 */
export function RideStatusStrip({ tramKey }: { tramKey: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const log = useMotionLog();
  const { recordingThis, recordingOther, stop } = useRideRecorder(tramKey);

  const ride = log.rideInfo();

  // Elapsed readout rides the shared 1 Hz clock instead of a private interval
  // (one tick for the whole app, and no Date.now() during render — perf
  // invariant #1 / hooks/uiClock). Point counts arrive via the log's
  // subscription through useMotionLog().
  const nowMs = useNowMs();

  if (recordingOther && ride) {
    return (
      <InsetGroup>
        <View style={styles.row}>
          <RecDot />
          <View style={styles.rowText}>
            <Text style={[styles.title, { color: c.text }]}>Recording another tram</Text>
            <Text style={[styles.subtitle, { color: c.secondary }]} numberOfLines={1}>
              Tram #{ride.key} · {ride.points} pts · {fmtElapsed(nowMs - ride.startedMs)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop recording"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={stop}
            style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.stopLabel}>Stop</Text>
          </Pressable>
        </View>
      </InsetGroup>
    );
  }

  if (recordingThis && ride) {
    const bytes = log.rideFileBytes();
    const mode = log.rideLocationMode();
    const motionOn = log.rideMotionActive();
    const lastAgoS =
      ride.lastPointMs != null ? Math.max(0, Math.round((nowMs - ride.lastPointMs) / 1000)) : null;
    const lastLabel =
      lastAgoS == null ? 'no fix yet' : lastAgoS <= 1 ? 'fix just now' : `last fix ${lastAgoS} s ago`;
    // A fix gap > 15 s while recording means GPS delivery has stalled.
    const stalled = lastAgoS != null && lastAgoS > 15;
    return (
      <InsetGroup>
        <View style={styles.row}>
          <RecDot />
          <View style={styles.rowText}>
            <Text style={[styles.title, { color: c.text }]}>
              Recording · {fmtElapsed(nowMs - ride.startedMs)}
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
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={stop}
            style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name="stop.fill" size={13} tintColor="#FFFFFF" />
            <Text style={styles.stopLabel}>Stop</Text>
          </Pressable>
        </View>
      </InsetGroup>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  rowText: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600', ...TabularNums },
  subtitle: { fontSize: 12, lineHeight: 16, ...TabularNums },
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
