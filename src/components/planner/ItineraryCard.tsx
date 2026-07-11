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
import type { ItineraryTiming, LegTiming } from '@/lib/arrivals';
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
  onPress: () => void;
}

export function ItineraryCard({ itinerary, timing, onPress }: ItineraryCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const separatorColor = scheme === 'dark' ? 'rgba(84,84,88,0.5)' : 'rgba(60,60,67,0.24)';
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;
  const { legs, totalStops, transferCount } = itinerary;

  const departureMs = timing?.departureMs ?? null;
  const arrivalMs = timing?.arrivalMs ?? null;

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

      {legs.map((leg, i) => {
        const legTiming: LegTiming | undefined = timing?.legs[i];
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
  timeDuration: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    marginLeft: 'auto',
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
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    marginTop: Spacing.two + 2,
    paddingTop: Spacing.two + 2,
  },
  footerTotals: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  footerAction: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3,
    marginLeft: 'auto',
  },
  footerActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
