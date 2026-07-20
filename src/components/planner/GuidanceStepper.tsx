// Full step-by-step view of the active guidance session, rendered inside the
// planner sheet, restyled to Apple Maps' itinerary "Details" list (IMG_0081):
// big SF-symbol / line-badge step icons in a gutter, hairline separators, and
// an Apple-red "End guidance" button. Pure presentation over (session,
// progress, live states) — step advancement runs in GuidanceBanner's driver on
// the map, so this only derives display state (same pure helpers, same inputs).
import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Fragment, useMemo } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { LineBadge } from '@/components/ui/LineBadge';
import { RowSeparator } from '@/components/ui/Inset';
import { appleScheme, Apple, Radii, Tram, Type } from '@/constants/theme';
import {
  computeItineraryTiming,
  computeLeaveByMs,
  formatCountdown,
  type ItineraryTiming,
} from '@/lib/arrivals';
import { formatPragueClock } from '@/lib/format/pragueTime';
import {
  activeStepIndex,
  buildSteps,
  tickGuidance,
  type GuidanceProgress,
  type GuidanceStep,
} from '@/lib/planner/guidance';
import type { RouteGeometry, TramPublicState } from '@/lib/types';
import type { GuidanceSession } from '@/stores/planner';

export interface GuidanceStepperProps {
  session: GuidanceSession;
  progress: GuidanceProgress;
  states: TramPublicState[];
  geometries: RouteGeometry[];
  nowMs: number;
  onEnd: () => void;
}

export function GuidanceStepper({
  session,
  progress,
  states,
  geometries,
  nowMs,
  onEnd,
}: GuidanceStepperProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;

  const steps = useMemo(
    () => buildSteps(session.itinerary, session.accessWalkS > 0),
    [session],
  );
  const activeIdx = activeStepIndex(steps, progress);

  // Wall-clock timing for every leg + the live position of the bound tram.
  const timing = useMemo(
    () => computeItineraryTiming(session.itinerary.legs, states, geometries, nowMs),
    [session.itinerary.legs, states, geometries, nowMs],
  );
  const walkUntilMs = session.startedAtMs + session.accessWalkS * 1_000;
  const live = useMemo(
    () => tickGuidance(session.itinerary, progress, states, geometries, nowMs, walkUntilMs),
    [session.itinerary, progress, states, geometries, nowMs, walkUntilMs],
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <SymbolView name="location.north.line.fill" size={17} weight="semibold" tintColor={accent} />
        <Text style={[Type.title3, styles.headerText, { color: c.text }]}>Journey guidance</Text>
        <Text style={[styles.headerStep, { color: c.secondary }]} allowFontScaling={false}>
          Step {Math.min(activeIdx + 1, steps.length)} of {steps.length}
        </Text>
      </View>

      <View>
        {steps.map((step, i) => {
          const status: StepStatus = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'upcoming';
          return (
            <Fragment key={`${step.kind}-${'legIndex' in step ? step.legIndex : 0}-${i}`}>
              {i > 0 && <RowSeparator inset={52} />}
              <StepRow
                step={step}
                status={status}
                timing={timing}
                live={live}
                progress={progress}
                session={session}
                nowMs={nowMs}
                scheme={scheme}
              />
            </Fragment>
          );
        })}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="End journey guidance"
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onEnd();
        }}
        style={({ pressed }) => [styles.endButton, { opacity: pressed ? 0.75 : 1 }]}
      >
        <SymbolView name="xmark" size={13} weight="semibold" tintColor="#FFFFFF" />
        <Text style={styles.endButtonText}>End Guidance</Text>
      </Pressable>
    </View>
  );
}

type StepStatus = 'done' | 'active' | 'upcoming';

function StepRow({
  step,
  status,
  timing,
  live,
  progress,
  session,
  nowMs,
  scheme,
}: {
  step: GuidanceStep;
  status: StepStatus;
  timing: ItineraryTiming;
  live: ReturnType<typeof tickGuidance>;
  progress: GuidanceProgress;
  session: GuidanceSession;
  nowMs: number;
  scheme: 'light' | 'dark';
}) {
  const c = appleScheme(scheme);
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;
  const dim = status === 'done';
  const textColor = dim ? c.secondary : c.text;

  // Pinned exit arrival for the leg currently being ridden (frozen at boarding).
  const pinnedArrivalMs =
    progress.phase === 'ride' && 'legIndex' in step && progress.legIndex === step.legIndex
      ? live.arrivalMs
      : null;

  let symbol: SFSymbol;
  let title: string;
  let detail: string | null = null;
  let liveNote: string | null = null;

  if (step.kind === 'walk') {
    symbol = 'figure.walk';
    title = `Walk to ${step.stopName}`;
    const walkMin = Math.max(1, Math.round(session.accessWalkS / 60));
    const dep = timing.legs[0]?.departureMs ?? null;
    detail =
      dep != null
        ? `${walkMin} min · leave by ${formatPragueClock(computeLeaveByMs(dep, session.accessWalkS))}`
        : `${walkMin} min`;
  } else if (step.kind === 'board') {
    symbol = 'clock.fill';
    title = step.transfer
      ? `Transfer — wait for line ${step.line} at ${step.stopName}`
      : `Board line ${step.line} at ${step.stopName}`;
    const legTiming = timing.legs[step.legIndex];
    if (legTiming?.departureMs != null) {
      const reg = legTiming.tram?.regNumber;
      detail = `dep ${formatPragueClock(legTiming.departureMs)}${
        reg != null ? ` · tram #${reg}` : ''
      }`;
      if (status === 'active') liveNote = formatCountdown(legTiming.departureMs - nowMs);
    } else {
      detail = 'no live tram matched yet';
    }
  } else if (step.kind === 'ride') {
    symbol = 'tram.fill';
    title = `Ride ${step.stopCount} ${step.stopCount === 1 ? 'stop' : 'stops'} — exit at ${step.exitName}`;
    const legTiming = timing.legs[step.legIndex];
    const arrivalMs = pinnedArrivalMs ?? legTiming?.arrivalMs ?? null;
    if (arrivalMs != null) detail = `arrive ${formatPragueClock(arrivalMs)}`;
    if (status === 'active') {
      liveNote = live.pos
        ? live.pos.nextIsExit
          ? 'Get off at the next stop'
          : `${live.pos.stopsRemaining} ${live.pos.stopsRemaining === 1 ? 'stop' : 'stops'} left`
        : 'tracking…';
    }
  } else {
    symbol = 'flag.fill';
    title = `Arrive at ${step.stopName}`;
    const arrivalMs = pinnedArrivalMs ?? timing.arrivalMs;
    if (arrivalMs != null) detail = formatPragueClock(arrivalMs);
  }

  const iconTint = status === 'active' ? accent : c.secondary;

  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        {status === 'done' ? (
          <SymbolView name="checkmark.circle.fill" size={24} tintColor={Apple.green} />
        ) : step.kind === 'board' || step.kind === 'ride' ? (
          <LineBadge line={step.line} size="md" />
        ) : (
          <SymbolView name={symbol} size={24} weight="regular" tintColor={iconTint} />
        )}
      </View>
      <View style={styles.rowText}>
        <Text
          style={[
            styles.rowTitle,
            { color: status === 'active' ? c.text : textColor, fontWeight: status === 'active' ? '600' : '400' },
          ]}
        >
          {title}
        </Text>
        {detail != null && (
          <Text style={[styles.rowDetail, { color: c.secondary }]} allowFontScaling={false}>
            {detail}
          </Text>
        )}
      </View>
      {liveNote != null && (
        <Text style={[styles.liveNote, { color: accent }]} allowFontScaling={false}>
          {liveNote}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 4,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  headerText: {
    flex: 1,
  },
  headerStep: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    minHeight: 52,
    paddingVertical: 10,
  },
  gutter: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 17,
    lineHeight: 21,
  },
  rowDetail: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  liveNote: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  endButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: Apple.red,
    borderCurve: 'continuous',
    borderRadius: Radii.field,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 50,
  },
  endButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
