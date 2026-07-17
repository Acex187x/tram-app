// Journey-guidance banner floating over the map. Mounted from PlannerOverlay
// (which lives inside the always-mounted MapView), so it exists whether or not
// the planner sheet is open.
//
// Split in two on purpose:
//  • GuidanceBanner (outer) subscribes ONLY to the planner store and renders
//    nothing without an active session — the map pays no live-states
//    subscription while guidance is idle.
//  • ActiveBanner (inner) is the guidance DRIVER: on each ~1 Hz runtime tick
//    it derives the next step from live tram states (tickGuidance, pure) and
//    commits transitions back to the store (+ haptics on step changes). All
//    React updates stay at ≤ 1 Hz per docs/performance.md invariant #1.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import { formatCountdown, formatEtaMinutes } from '@/lib/arrivals';
import { formatPragueClock } from '@/lib/format/pragueTime';
import {
  activeStepIndex,
  buildSteps,
  tickGuidance,
  type GuidanceProgress,
} from '@/lib/planner/guidance';
import { usePlannerStore, type GuidanceSession } from '@/stores/planner';

export function GuidanceBanner() {
  const session = usePlannerStore((s) => s.guidance);
  const progress = usePlannerStore((s) => s.guidanceProgress);
  if (!session || !progress) return null;
  return <ActiveBanner session={session} progress={progress} />;
}

function ActiveBanner({
  session,
  progress,
}: {
  session: GuidanceSession;
  progress: GuidanceProgress;
}) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;

  // Live inputs — ~1 Hz runtime states + a 1 s wall clock for countdowns.
  const states = useAllTramStates();
  const geometries = useLoadedGeometries();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const walkUntilMs = session.startedAtMs + session.accessWalkS * 1_000;
  const tick = useMemo(
    () => tickGuidance(session.itinerary, progress, states, geometries, nowMs, walkUntilMs),
    [session.itinerary, progress, states, geometries, nowMs, walkUntilMs],
  );

  // Commit step transitions in an effect (never during render); tickGuidance
  // returns the same reference when nothing changed, so this is quiet.
  const setGuidanceProgress = usePlannerStore((s) => s.setGuidanceProgress);
  useEffect(() => {
    if (tick.progress !== progress) setGuidanceProgress(tick.progress);
  }, [tick.progress, progress, setGuidanceProgress]);

  // Haptics on transitions: success on a new step, warning when the next stop
  // becomes the exit stop.
  const exitNext = progress.phase === 'ride' && (tick.pos?.nextIsExit ?? false);
  const hapticRef = useRef({ legIndex: progress.legIndex, phase: progress.phase, exitNext });
  useEffect(() => {
    const prev = hapticRef.current;
    if (prev.phase !== progress.phase || prev.legIndex !== progress.legIndex) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (exitNext && !prev.exitNext) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    hapticRef.current = { legIndex: progress.legIndex, phase: progress.phase, exitNext };
  }, [progress, exitNext]);

  const steps = useMemo(
    () => buildSteps(session.itinerary, session.accessWalkS > 0),
    [session],
  );
  const stepIdx = activeStepIndex(steps, progress);

  const legs = session.itinerary.legs;
  const leg = legs[Math.min(progress.legIndex, legs.length - 1)];
  if (!leg) return null;

  let symbol: Parameters<typeof SymbolView>[0]['name'] = 'figure.walk';
  let title = '';
  let subtitle = '';
  let highlight = false;
  const boundState = tick.pos && progress.tramKey ? progress.tramKey : null;

  if (progress.phase === 'walk') {
    symbol = 'figure.walk';
    title = `Walk to ${leg.fromStopName}`;
    subtitle =
      tick.wait?.departureMs != null
        ? `Line ${leg.line} departs ${formatPragueClock(tick.wait.departureMs)} · ${formatCountdown(
            tick.wait.departureMs - nowMs,
          )}`
        : `~${Math.max(1, Math.round(session.accessWalkS / 60))} min walk`;
  } else if (progress.phase === 'wait') {
    symbol = 'clock.fill';
    title =
      progress.legIndex > 0
        ? `Transfer — line ${leg.line} at ${leg.fromStopName}`
        : `Board line ${leg.line} at ${leg.fromStopName}`;
    if (tick.wait?.departureMs != null) {
      const reg = tick.wait.tram?.regNumber;
      subtitle = `${reg != null ? `Tram #${reg} · ` : ''}dep ${formatPragueClock(
        tick.wait.departureMs,
      )} · ${formatCountdown(tick.wait.departureMs - nowMs)}`;
    } else {
      subtitle = 'Waiting for the next live tram…';
    }
  } else if (progress.phase === 'ride') {
    symbol = 'tram.fill';
    // ETA to YOUR exit stop, pinned to the boarded tram (tick.arrivalMs is
    // frozen at boarding) — a stable, decreasing countdown that never jumps to
    // the tram behind.
    const eta =
      tick.arrivalMs != null
        ? `${formatEtaMinutes(Math.max(0, Math.floor((tick.arrivalMs - nowMs) / 1000)))} · arr ${formatPragueClock(
            tick.arrivalMs,
          )}`
        : null;
    if (tick.pos) {
      if (tick.pos.nextIsExit) {
        title = `Get off at ${leg.toStopName}`;
        subtitle = eta ? `Next stop is yours · ${eta}` : 'The next stop is yours';
        highlight = true;
      } else {
        const stops = `${tick.pos.stopsRemaining} ${
          tick.pos.stopsRemaining === 1 ? 'stop' : 'stops'
        } to go`;
        title = `Ride to ${leg.toStopName}`;
        subtitle = eta ? `${stops} · ${eta}` : `${stops}${boundState ? ` · tram #${boundState}` : ''}`;
      }
    } else {
      // Pinned tram left the feed: hold the frozen ETA rather than switch trams.
      title = `Ride to ${leg.toStopName}`;
      subtitle = eta ? `${eta} · signal lost` : 'Tracking lost — watch for your stop';
    }
  } else {
    symbol = 'checkmark.circle.fill';
    title = 'You have arrived';
    subtitle = leg.toStopName;
  }

  return (
    <View
      style={[styles.wrap, { top: insets.top + 54 }]}
      pointerEvents="box-none"
    >
      <GlassPanel variant="regular" interactive style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Journey guidance: ${title}. Open planner.`}
          style={styles.body}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.push('/planner');
          }}
        >
          <SymbolView
            name={symbol}
            size={20}
            tintColor={highlight ? Tram.veryLate : accent}
          />
          <LineBadge line={leg.line} size="sm" />
          <View style={styles.textCol}>
            <Text
              numberOfLines={1}
              style={[styles.title, { color: highlight ? Tram.veryLate : palette.text }]}
              allowFontScaling={false}
            >
              {title}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.subtitle, { color: palette.textSecondary }]}
              allowFontScaling={false}
            >
              {subtitle}
            </Text>
          </View>
          <Text style={[styles.counter, { color: palette.textSecondary }]} allowFontScaling={false}>
            {Math.min(stepIdx + 1, steps.length)}/{steps.length}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End journey guidance"
          hitSlop={10}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            usePlannerStore.getState().stopGuidance();
          }}
        >
          <SymbolView name="xmark.circle.fill" size={20} tintColor={palette.textSecondary} />
        </Pressable>
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  // Left-anchored under the status chip; right margin clears the control stack.
  wrap: {
    position: 'absolute',
    left: Spacing.three,
    right: 76,
    alignItems: 'flex-start',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    maxWidth: 420,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 18,
    borderCurve: 'continuous',
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  textCol: {
    flexShrink: 1,
    gap: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  counter: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginLeft: Spacing.one,
  },
});
