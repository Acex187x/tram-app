// Full step-by-step view of the active guidance session, rendered inside the
// planner sheet. Pure presentation over (session, progress, live states) — the
// actual step advancement runs in GuidanceBanner's driver on the map, so this
// component only derives display state (same pure helpers, same inputs).
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { Fragment, useMemo } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Spacing, Tram } from '@/constants/theme';
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
  const palette = Colors[scheme];
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;
  const separatorColor = scheme === 'dark' ? 'rgba(84,84,88,0.5)' : 'rgba(60,60,67,0.24)';

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
    <View
      style={[
        styles.card,
        { backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.62)' },
      ]}
    >
      <View style={styles.headerRow}>
        <SymbolView name="point.topleft.down.curvedto.point.bottomright.up.fill" size={15} tintColor={accent} />
        <Text style={[styles.headerText, { color: palette.text }]}>Journey guidance</Text>
        <Text style={[styles.headerStep, { color: palette.textSecondary }]} allowFontScaling={false}>
          Step {Math.min(activeIdx + 1, steps.length)} of {steps.length}
        </Text>
      </View>

      {steps.map((step, i) => {
        const status: StepStatus = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'upcoming';
        return (
          <Fragment key={`${step.kind}-${'legIndex' in step ? step.legIndex : 0}-${i}`}>
            {i > 0 && <View style={[styles.separator, { backgroundColor: separatorColor }]} />}
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

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="End journey guidance"
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onEnd();
        }}
        style={({ pressed }) => [styles.endButton, { opacity: pressed ? 0.7 : 1 }]}
      >
        <SymbolView name="xmark" size={12} weight="semibold" tintColor={Tram.cream} />
        <Text style={styles.endButtonText}>End guidance</Text>
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
  const palette = Colors[scheme];
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;
  const dim = status === 'done';
  const textColor = dim ? palette.textSecondary : palette.text;

  // Pinned exit arrival for the leg currently being ridden (frozen at boarding).
  // Non-null only for the ride/arrive step of the active ridden leg; used in
  // place of the nearest-tram timing so the ETA never jumps to the tram behind.
  const pinnedArrivalMs =
    progress.phase === 'ride' && 'legIndex' in step && progress.legIndex === step.legIndex
      ? live.arrivalMs
      : null;

  let symbol: Parameters<typeof SymbolView>[0]['name'];
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
    // While riding THIS leg, arrival is the pinned tram's frozen exit arrival —
    // never the nearest-tram re-search (which would jump to the tram behind).
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
    symbol = 'mappin.circle.fill';
    title = `Arrive at ${step.stopName}`;
    // On the final ride leg the pinned tram's frozen arrival is the destination
    // ETA — stable, not the nearest-tram re-search.
    const arrivalMs = pinnedArrivalMs ?? timing.arrivalMs;
    if (arrivalMs != null) detail = formatPragueClock(arrivalMs);
  }

  return (
    <View style={[styles.row, status === 'active' && styles.rowActive]}>
      <View style={styles.iconCol}>
        {status === 'done' ? (
          <SymbolView name="checkmark.circle.fill" size={18} tintColor={Tram.onTime} />
        ) : (
          <SymbolView
            name={symbol}
            size={18}
            tintColor={status === 'active' ? accent : palette.textSecondary}
          />
        )}
      </View>
      {(step.kind === 'board' || step.kind === 'ride') && (
        <LineBadge line={step.line} size="sm" />
      )}
      <View style={styles.rowText}>
        <Text
          style={[
            styles.rowTitle,
            { color: status === 'active' ? palette.text : textColor },
            status === 'active' && styles.rowTitleActive,
          ]}
        >
          {title}
        </Text>
        {detail != null && (
          <Text style={[styles.rowDetail, { color: palette.textSecondary }]} allowFontScaling={false}>
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
  card: {
    borderCurve: 'continuous',
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 4,
    gap: Spacing.one,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  headerText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
  },
  headerStep: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 26,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 40,
    paddingVertical: Spacing.one,
  },
  rowActive: {},
  iconCol: {
    alignItems: 'center',
    width: 22,
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  rowTitle: {
    fontSize: 14,
  },
  rowTitleActive: {
    fontWeight: '600',
  },
  rowDetail: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  liveNote: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  endButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: Tram.pidRed,
    borderCurve: 'continuous',
    borderRadius: 12,
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'center',
    marginTop: Spacing.two,
    minHeight: 40,
  },
  endButtonText: {
    color: Tram.cream,
    fontSize: 15,
    fontWeight: '600',
  },
});
