// One planned itinerary as a tappable card: a departure → arrival wall-time
// header (Europe/Prague, from live tram data when available), legs rendered as
// [LineBadge → towards <stop> · N stops] with the SPECIFIC next tram (model
// illustration, name, AC snowflake) under each leg, transfer dots between
// legs, and a totals footer. Tap = draw on the map.
import { SymbolView } from 'expo-symbols';
import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { AcSnowflake, TramModelImage } from '@/components/tram/TramModelImage';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Spacing, Tram } from '@/constants/theme';
import { formatCountdown, type ItineraryTiming, type LegTiming } from '@/lib/arrivals';
import { formatPragueClock } from '@/lib/format/pragueTime';
import type { PlannerItinerary } from '@/lib/types';

/** 'Tatra T3R.P' → 'T3R.P', 'Škoda 15T ForCity Alfa' → '15T ForCity Alfa'. */
function shortModelName(name: string): string {
  return name.replace(/^(Tatra|Škoda|ČKD)\s+/u, '');
}

function fmtDurationMin(s: number): string {
  return `${Math.max(1, Math.round(s / 60))} min`;
}

export interface ItineraryCardProps {
  itinerary: PlannerItinerary;
  /** Live wall-clock timing (computeItineraryTiming); optional while loading. */
  timing?: ItineraryTiming;
  /** Current time (ms) for the 'in N min' departure countdown; defaults to now. */
  nowMs?: number;
  /** Walking seconds from the user's location to the boarding stop, when known. */
  walkS?: number | null;
  /** Wall-clock ms to leave by (departure − walk − buffer), when known. */
  leaveByMs?: number | null;
  onPress: () => void;
  /** Start journey guidance on this itinerary (shows a Start button when set). */
  onStart?: () => void;
}

export function ItineraryCard({
  itinerary,
  timing,
  nowMs,
  walkS,
  leaveByMs,
  onPress,
  onStart,
}: ItineraryCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const separatorColor = scheme === 'dark' ? 'rgba(84,84,88,0.5)' : 'rgba(60,60,67,0.24)';
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;
  const { legs, totalStops, transferCount } = itinerary;

  const departureMs = timing?.departureMs ?? null;
  const arrivalMs = timing?.arrivalMs ?? null;
  const now = nowMs ?? Date.now();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Route with ${totalStops} stops and ${transferCount} transfers${
        departureMs != null && arrivalMs != null
          ? `, departing ${formatPragueClock(departureMs)}, arriving ${formatPragueClock(arrivalMs)}`
          : ''
      }. Show on map.`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.62)',
          opacity: pressed ? 0.65 : 1,
        },
      ]}
    >
      {/* Wall-time header — departure → arrival in Prague time. */}
      {departureMs != null && arrivalMs != null ? (
        <View style={styles.timesRow}>
          <Text style={[styles.timeBig, { color: palette.text }]} allowFontScaling={false}>
            {formatPragueClock(departureMs)}
          </Text>
          <SymbolView name="arrow.right" size={13} weight="semibold" tintColor={palette.textSecondary} />
          <Text style={[styles.timeBig, { color: palette.text }]} allowFontScaling={false}>
            {formatPragueClock(arrivalMs)}
          </Text>
          <Text
            style={[styles.countdown, { color: accent }]}
            allowFontScaling={false}
            numberOfLines={1}
          >
            {formatCountdown(departureMs - now)}
          </Text>
          <Text style={[styles.timeDuration, { color: palette.textSecondary }]} allowFontScaling={false}>
            {fmtDurationMin((arrivalMs - departureMs) / 1000)}
          </Text>
        </View>
      ) : (
        <View style={styles.timesRow}>
          <SymbolView name="clock" size={12} tintColor={palette.textSecondary} />
          <Text style={[styles.timesFallback, { color: palette.textSecondary }]}>
            Scheduled times — no live tram matched yet
          </Text>
        </View>
      )}

      {/* Walk-aware leave-by line: departure − walk − 1 min buffer. */}
      {walkS != null && leaveByMs != null && departureMs != null && (
        <View style={styles.leaveRow}>
          <SymbolView name="figure.walk" size={12} tintColor={accent} />
          <Text style={[styles.leaveText, { color: palette.text }]} allowFontScaling={false}>
            {leaveByMs <= now ? 'Leave now' : `Leave by ${formatPragueClock(leaveByMs)}`}
          </Text>
          <Text style={[styles.leaveWalk, { color: palette.textSecondary }]} allowFontScaling={false}>
            {Math.max(1, Math.round(walkS / 60))} min walk to the stop
          </Text>
        </View>
      )}

      {legs.map((leg, i) => {
        const legTiming: LegTiming | undefined = timing?.legs[i];
        // Transfer wait = this leg's departure − previous leg's arrival, when
        // both wall times are live.
        const prevArrivalMs = timing?.legs[i - 1]?.arrivalMs ?? null;
        const waitMs =
          i > 0 && prevArrivalMs != null && legTiming?.departureMs != null
            ? legTiming.departureMs - prevArrivalMs
            : null;
        return (
          <Fragment key={`${i}-${leg.line}-${leg.fromStopId}`}>
            {i > 0 && (
              <View style={styles.transferRow}>
                <View style={styles.dotsCol}>
                  <View style={[styles.dot, { backgroundColor: palette.textSecondary }]} />
                  <View style={[styles.dot, { backgroundColor: palette.textSecondary }]} />
                </View>
                <Text numberOfLines={1} style={[styles.transferText, { color: palette.textSecondary }]}>
                  Transfer at {leg.fromStopName}
                </Text>
                {waitMs != null && (
                  <Text style={[styles.transferWait, { color: palette.textSecondary }]} allowFontScaling={false}>
                    {waitMs < 60_000 ? '<1 min wait' : `${Math.round(waitMs / 60_000)} min wait`}
                  </Text>
                )}
              </View>
            )}
            <View style={styles.legRow}>
              <LineBadge line={leg.line} size="sm" />
              <Text numberOfLines={1} style={[styles.legText, { color: palette.text }]}>
                towards <Text style={styles.legDestination}>{leg.toStopName}</Text>
              </Text>
              <Text style={[styles.legStops, { color: palette.textSecondary }]}>
                {leg.stopCount} {leg.stopCount === 1 ? 'stop' : 'stops'}
              </Text>
            </View>
            <LegTramLine timing={legTiming} scheme={scheme} />
          </Fragment>
        );
      })}

      <View style={[styles.footer, { borderTopColor: separatorColor }]}>
        <Text style={[styles.footerTotals, { color: palette.textSecondary }]}>
          {totalStops} {totalStops === 1 ? 'stop' : 'stops'} ·{' '}
          {transferCount === 0 ? 'Direct' : `${transferCount} ${transferCount === 1 ? 'transfer' : 'transfers'}`}
        </Text>
        {onStart && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start journey guidance on this route"
            hitSlop={6}
            onPress={onStart}
            style={({ pressed }) => [styles.startButton, { opacity: pressed ? 0.7 : 1 }]}
          >
            <SymbolView name="play.fill" size={10} tintColor={Tram.cream} />
            <Text style={styles.startButtonText} allowFontScaling={false}>
              Start
            </Text>
          </Pressable>
        )}
        <View style={styles.footerAction}>
          <Text style={[styles.footerActionText, { color: accent }]}>Show on map</Text>
          <SymbolView name="chevron.right" size={11} weight="semibold" tintColor={accent} />
        </View>
      </View>
    </Pressable>
  );
}

/** The specific next live tram serving a leg — or the schedule-only fallback. */
function LegTramLine({ timing, scheme }: { timing: LegTiming | undefined; scheme: 'light' | 'dark' }) {
  const palette = Colors[scheme];
  if (!timing) return null;

  if (timing.tram && timing.departureMs != null) {
    const { tram } = timing;
    return (
      <View style={styles.tramLine}>
        <View style={styles.dotsColSpacer} />
        <TramModelImage modelId={tram.model.id} height={22} style={styles.tramImage} />
        <Text numberOfLines={1} style={[styles.tramText, { color: palette.textSecondary }]}>
          {shortModelName(tram.model.name)}
          {tram.regNumber != null && ` #${tram.regNumber}`}
        </Text>
        <AcSnowflake airConditioned={tram.airConditioned} size={11} />
        <Text style={[styles.tramDep, { color: palette.textSecondary }]} allowFontScaling={false}>
          dep {formatPragueClock(timing.departureMs)}
        </Text>
      </View>
    );
  }

  // Schedule-only: no live tram found for this leg (yet).
  return (
    <View style={styles.tramLine}>
      <View style={styles.dotsColSpacer} />
      <SymbolView name="clock" size={11} tintColor={palette.textSecondary} />
      <Text numberOfLines={1} style={[styles.tramText, { color: palette.textSecondary }]}>
        {timing.travelS != null
          ? `Scheduled ride ${fmtDurationMin(timing.travelS)} — no live tram yet`
          : 'No live tram yet'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 4,
  },
  timesRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  timeBig: {
    fontSize: 20,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  countdown: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginLeft: 'auto',
  },
  timeDuration: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  timesFallback: {
    flex: 1,
    fontSize: 12,
  },
  legRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two + 2,
    minHeight: 32,
  },
  legText: {
    flex: 1,
    fontSize: 15,
  },
  legDestination: {
    fontWeight: '600',
  },
  legStops: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  tramLine: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    minHeight: 22,
    paddingBottom: 2,
  },
  dotsColSpacer: { width: 22 }, // aligns under the sm LineBadge
  tramImage: { width: 48 },
  tramText: { flexShrink: 1, fontSize: 12 },
  tramDep: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginLeft: 'auto',
  },
  transferRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.one,
  },
  dotsCol: {
    alignItems: 'center',
    gap: 3,
    width: 22, // aligns under the sm LineBadge
  },
  dot: {
    borderRadius: 1.5,
    height: 3,
    width: 3,
  },
  transferText: {
    flex: 1,
    fontSize: 12,
  },
  transferWait: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    marginTop: Spacing.two + 2,
    paddingTop: Spacing.two + 2,
  },
  footerTotals: {
    flex: 1,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  startButton: {
    alignItems: 'center',
    backgroundColor: Tram.pidRed,
    borderCurve: 'continuous',
    borderRadius: 11,
    flexDirection: 'row',
    gap: 5,
    marginRight: Spacing.three,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 4,
  },
  startButtonText: {
    color: Tram.cream,
    fontSize: 13,
    fontWeight: '600',
  },
  footerAction: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3,
  },
  footerActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  leaveRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginBottom: Spacing.one,
  },
  leaveText: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  leaveWalk: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    marginLeft: 'auto',
  },
});
