// One planned itinerary as an Apple Maps transit result card (IMG_0080/81): a
// big total-duration headline, a "Tram scheduled in … · ETA" secondary line, a
// mini leg strip (walk ▸ line badge ▸ …), and a green GO button that hands the
// itinerary to the map. A "Details" disclosure expands into the StepList
// (Start / Walk / Board / dotted ride-timeline / Exit / Arrive), and Start
// journey guidance lives at its foot. Data/handoff semantics unchanged: GO and
// the card body both call onPress; onStart starts guidance.
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { GoButton } from '@/components/ui/GoButton';
import { LineBadge, isNightLine } from '@/components/ui/LineBadge';
import { StepList, type Step } from '@/components/ui/StepList';
import { appleScheme, Apple, Radii, Tram } from '@/constants/theme';
import { formatCountdown, type ItineraryTiming } from '@/lib/arrivals';
import { formatPragueClock } from '@/lib/format/pragueTime';
import type { PlannerItinerary } from '@/lib/types';

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
  const c = appleScheme(scheme);
  const { legs, totalStops, transferCount } = itinerary;
  const [expanded, setExpanded] = useState(false);

  const departureMs = timing?.departureMs ?? null;
  const arrivalMs = timing?.arrivalMs ?? null;
  const now = nowMs ?? Date.now();

  // Total-duration headline: live (arrival − departure) when a tram matched,
  // else the summed scheduled leg durations, else the stop count as a fallback.
  const durationLabel = useMemo(() => {
    if (departureMs != null && arrivalMs != null) {
      return fmtDurationMin((arrivalMs - departureMs) / 1000);
    }
    const sched = timing?.legs.reduce((sum, l) => sum + (l.travelS ?? 0), 0) ?? 0;
    if (sched > 0) return fmtDurationMin(sched);
    return `${totalStops} ${totalStops === 1 ? 'stop' : 'stops'}`;
  }, [departureMs, arrivalMs, timing, totalStops]);

  const scheduleLine =
    departureMs != null && arrivalMs != null
      ? `Tram scheduled in ${formatCountdown(departureMs - now)} · ${formatPragueClock(arrivalMs)} ETA`
      : 'Scheduled times — no live tram matched yet';

  // Steps for the expanded "Details" list (IMG_0081).
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [];
    out.push({
      key: 'start',
      icon: { symbol: 'smallcircle.filled.circle', circleTint: Apple.red },
      title: 'Start',
      subtitle: legs[0]?.fromStopName,
    });
    if (walkS != null && walkS > 0 && legs[0]) {
      out.push({
        key: 'walk',
        icon: { symbol: 'figure.walk' },
        title: `Walk to ${legs[0].fromStopName}`,
        subtitle: `About ${Math.max(1, Math.round(walkS / 60))} min`,
      });
    }
    legs.forEach((leg, i) => {
      const lt = timing?.legs[i];
      const tint = isNightLine(leg.line) ? Tram.night : Tram.pidRed;
      const rideMin =
        lt?.travelS != null
          ? fmtDurationMin(lt.travelS)
          : lt?.departureMs != null && lt?.arrivalMs != null
            ? fmtDurationMin((lt.arrivalMs - lt.departureMs) / 1000)
            : null;
      out.push({
        key: `board-${i}`,
        icon: { lineBadge: leg.line },
        title: i > 0 ? `Transfer to the ${leg.line} tram` : `Board the ${leg.line} tram`,
        subtitle: `Toward ${leg.toStopName}`,
        note: lt?.departureMs != null ? `Scheduled in ${formatCountdown(lt.departureMs - now)}` : undefined,
      });
      out.push({
        key: `exit-${i}`,
        icon: { symbol: 'rectangle.portrait.and.arrow.right' },
        title: `Exit tram at ${leg.toStopName}`,
        timeline: {
          fromStop: leg.fromStopName,
          toStop: leg.toStopName,
          detail: `Ride ${leg.stopCount} ${leg.stopCount === 1 ? 'stop' : 'stops'}${
            rideMin != null ? `, ${rideMin}` : ''
          }`,
          tint,
        },
      });
    });
    out.push({
      key: 'arrive',
      icon: { symbol: 'flag.fill', circleTint: Apple.blue },
      title: 'Arrive',
      subtitle: legs[legs.length - 1]?.toStopName,
    });
    return out;
  }, [legs, timing, walkS, now]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Route, ${durationLabel}${
        departureMs != null && arrivalMs != null
          ? `, departing ${formatPragueClock(departureMs)}, arriving ${formatPragueClock(arrivalMs)}`
          : ''
      }. Show on map.`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: c.fillTertiary,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <View style={styles.summaryRow}>
        <View style={styles.summaryText}>
          <Text style={[styles.duration, { color: c.text }]} allowFontScaling={false}>
            {durationLabel}
          </Text>
          <Text style={[styles.schedule, { color: c.secondary }]} numberOfLines={2} allowFontScaling={false}>
            {scheduleLine}
          </Text>

          {/* Mini leg strip: walk ▸ badge ▸ badge … */}
          <View style={styles.legStrip}>
            {walkS != null && walkS > 0 && (
              <>
                <View style={[styles.walkChip, { backgroundColor: c.fillSecondary }]}>
                  <SymbolView name="figure.walk" size={12} tintColor={c.secondary} />
                  <Text style={[styles.walkChipText, { color: c.secondary }]} allowFontScaling={false}>
                    {Math.max(1, Math.round(walkS / 60))} min
                  </Text>
                </View>
                <SymbolView name="chevron.right" size={9} weight="semibold" tintColor={c.secondary} />
              </>
            )}
            {legs.map((leg, i) => (
              <View key={`${i}-${leg.line}-${leg.fromStopId}`} style={styles.stripSeg}>
                {i > 0 && (
                  <SymbolView name="chevron.right" size={9} weight="semibold" tintColor={c.secondary} />
                )}
                <LineBadge line={leg.line} size="sm" />
              </View>
            ))}
          </View>
        </View>

        <GoButton onPress={onPress} size={68} />
      </View>

      {/* Walk-aware leave-by line (existing behavior). */}
      {walkS != null && leaveByMs != null && departureMs != null && (
        <View style={styles.leaveRow}>
          <SymbolView name="figure.walk" size={12} tintColor={Apple.blue} />
          <Text style={[styles.leaveText, { color: c.text }]} allowFontScaling={false}>
            {leaveByMs <= now ? 'Leave now' : `Leave by ${formatPragueClock(leaveByMs)}`}
          </Text>
          <Text style={[styles.leaveWalk, { color: c.secondary }]} allowFontScaling={false}>
            {Math.max(1, Math.round(walkS / 60))} min walk to the stop
          </Text>
        </View>
      )}

      <View style={[styles.divider, { backgroundColor: c.separator }]} />

      <View style={styles.footerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Hide details' : 'Show details'}
          hitSlop={8}
          onPress={() => setExpanded((x) => !x)}
          style={({ pressed }) => [styles.detailsToggle, pressed && styles.pressed]}
        >
          <Text style={[styles.detailsText, { color: Apple.blue }]}>Details</Text>
          <SymbolView
            name={expanded ? 'chevron.up' : 'chevron.down'}
            size={12}
            weight="semibold"
            tintColor={Apple.blue}
          />
        </Pressable>
        <Text style={[styles.totals, { color: c.secondary }]} allowFontScaling={false}>
          {totalStops} {totalStops === 1 ? 'stop' : 'stops'} ·{' '}
          {transferCount === 0
            ? 'Direct'
            : `${transferCount} ${transferCount === 1 ? 'transfer' : 'transfers'}`}
        </Text>
      </View>

      {expanded && (
        <View style={styles.details}>
          <StepList steps={steps} />
          {onStart && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start journey guidance on this route"
              onPress={onStart}
              style={({ pressed }) => [styles.startButton, { opacity: pressed ? 0.8 : 1 }]}
            >
              <SymbolView name="location.north.line.fill" size={15} weight="semibold" tintColor="#FFFFFF" />
              <Text style={styles.startButtonText}>Start Guidance</Text>
            </Pressable>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: Radii.card,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  summaryRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  summaryText: {
    flex: 1,
    gap: 4,
  },
  duration: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  schedule: {
    fontSize: 14,
    lineHeight: 18,
    fontVariant: ['tabular-nums'],
  },
  legStrip: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 4,
  },
  stripSeg: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  walkChip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  walkChipText: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
  },
  leaveRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
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
  divider: {
    height: StyleSheet.hairlineWidth,
    marginTop: 12,
  },
  footerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
  },
  detailsToggle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  detailsText: {
    fontSize: 15,
    fontWeight: '600',
  },
  totals: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  details: {
    marginTop: 4,
    gap: 10,
  },
  startButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: Apple.blue,
    borderCurve: 'continuous',
    borderRadius: Radii.field,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
  },
  startButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: { opacity: 0.55 },
});
