// One route proposal. Its visual hierarchy is deliberately Tram Spotter's own:
// the assigned physical vehicles are the hero, not a generic duration + GO
// clone. Every leg shows the actual model and registration number the user
// should board; schedule-only fallback is explicit when live assignment is not
// yet possible.
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { TramFace } from '@/components/tram/TramFace';
import { LineBadge, isNightLine } from '@/components/ui/LineBadge';
import { StepList, type Step } from '@/components/ui/StepList';
import { appleScheme, Radii, TextScale, Tram } from '@/constants/theme';
import { formatCountdown, type ItineraryTiming, type LegTiming } from '@/lib/arrivals';
import { useNowMs } from '@/hooks/uiClock';
import { formatPragueClock } from '@/lib/format/pragueTime';
import type { PlannerItinerary } from '@/lib/types';

function fmtDurationMin(s: number): string {
  return `${Math.max(1, Math.round(s / 60))} min`;
}

function AssignedVehicle({
  line,
  timing,
  nowMs,
  transfer,
  scheme,
}: {
  line: string;
  timing: LegTiming | undefined;
  nowMs: number;
  transfer: boolean;
  scheme: 'light' | 'dark';
}) {
  const c = appleScheme(scheme);
  const tram = timing?.tram;
  const departure = timing?.departureMs;

  return (
    <View
      style={[styles.vehicle, { backgroundColor: c.fillSecondary }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={
        tram
          ? `${transfer ? 'Transfer to' : 'Board'} line ${line}, ${tram.model.name}, tram ${tram.regNumber ?? tram.key}`
          : `${transfer ? 'Transfer to' : 'Board'} line ${line}; live vehicle not assigned yet`
      }
    >
      <View style={[styles.vehiclePortrait, { backgroundColor: c.fillTertiary }]}>
        {tram ? (
          <TramFace modelId={tram.model.id} size={46} />
        ) : (
          <SymbolView name="tram.fill" size={23} weight="semibold" tintColor={c.secondary} />
        )}
      </View>
      <View style={styles.vehicleBody}>
        <View style={styles.vehicleEyebrowRow}>
          <Text style={[styles.vehicleAction, { color: c.secondary }]}>
            {transfer ? 'TRANSFER' : 'BOARD'}
          </Text>
          <LineBadge line={line} size="sm" />
        </View>
        <Text style={[styles.vehicleTitle, { color: c.text }]} numberOfLines={1}>
          {tram
            ? `${tram.regNumber != null ? `#${tram.regNumber}` : tram.key} · ${tram.model.name}`
            : 'Live vehicle not assigned yet'}
        </Text>
        <Text style={[styles.vehicleModel, { color: c.secondary }]} numberOfLines={1}>
          {tram
            ? `${tram.airConditioned === true ? 'Air-conditioned · ' : ''}live vehicle`
            : 'This option is schedule-only for now'}
        </Text>
      </View>
      <View style={styles.vehicleClock}>
        <Text style={[styles.vehicleTime, { color: c.text }]}>
          {departure != null ? formatPragueClock(departure) : '—'}
        </Text>
        <Text style={[styles.vehicleCountdown, { color: c.secondary }]}>
          {departure != null ? formatCountdown(departure - nowMs) : 'pending'}
        </Text>
      </View>
    </View>
  );
}

export function RouteVehicleRoster({
  itinerary,
  timing,
  nowMs,
}: {
  itinerary: PlannerItinerary;
  timing: ItineraryTiming | null | undefined;
  nowMs: number;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';

  return (
    <View style={styles.vehicleStack}>
      {itinerary.legs.map((leg, i) => (
        <AssignedVehicle
          key={`${i}-${leg.line}-${leg.fromStopId}`}
          line={leg.line}
          timing={timing?.legs[i]}
          nowMs={nowMs}
          transfer={i > 0}
          scheme={scheme}
        />
      ))}
    </View>
  );
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
  // Fallback clock = the shared 1 Hz tick, not Date.now(): reading the wall
  // clock during render makes the card impure under React Compiler.
  const clockNowMs = useNowMs();
  const now = nowMs ?? clockNowMs;

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

  const routeSummary =
    departureMs != null && arrivalMs != null
      ? `${formatCountdown(departureMs - now)} · arrive ${formatPragueClock(arrivalMs)}`
      : 'Waiting for live vehicle assignments';

  // Steps for the expanded journey breakdown.
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [];
    out.push({
      key: 'start',
      icon: { symbol: 'smallcircle.filled.circle', circleTint: c.red },
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
      icon: { symbol: 'flag.fill', circleTint: c.blue },
      title: 'Arrive',
      subtitle: legs[legs.length - 1]?.toStopName,
    });
    return out;
  }, [legs, timing, walkS, now, c.red, c.blue]);

  return (
    // A plain grouping container: `accessible` would merge the map, Details and
    // Start Guidance into one element, leaving them unreachable by VoiceOver.
    // The summary block below carries the card's own tap target and label.
    <View style={[styles.card, { backgroundColor: c.fillTertiary }]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Route, ${durationLabel}${
          departureMs != null && arrivalMs != null
            ? `, departing ${formatPragueClock(departureMs)}, arriving ${formatPragueClock(arrivalMs)}`
            : ''
        }. Show on map.`}
        style={({ pressed }) => [styles.summaryRow, { opacity: pressed ? 0.65 : 1 }]}
      >
        <View style={styles.summaryText}>
          <View style={styles.routeHeadline}>
            <Text
              style={[styles.duration, { color: c.text }]}
              maxFontSizeMultiplier={TextScale.content}
            >
              {durationLabel}
            </Text>
            <Text style={[styles.routeName, { color: c.secondary }]} numberOfLines={1}>
              {legs[0]?.fromStopName} → {legs[legs.length - 1]?.toStopName}
            </Text>
          </View>
          <Text
            style={[styles.schedule, { color: c.secondary }]}
            numberOfLines={2}
            maxFontSizeMultiplier={TextScale.content}
          >
            {routeSummary}
          </Text>
        </View>
        <View style={[styles.routeArrow, { backgroundColor: c.fillSecondary }]}>
          <SymbolView name="map.fill" size={17} weight="semibold" tintColor={c.blue} />
        </View>
      </Pressable>

      <RouteVehicleRoster itinerary={itinerary} timing={timing} nowMs={now} />

      {/* Walk-aware leave-by line (existing behavior). */}
      {walkS != null && leaveByMs != null && departureMs != null && (
        <View style={styles.leaveRow}>
          <SymbolView name="figure.walk" size={12} tintColor={c.blue} />
          <Text
            style={[styles.leaveText, { color: c.text }]}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {leaveByMs <= now ? 'Leave now' : `Leave by ${formatPragueClock(leaveByMs)}`}
          </Text>
          <Text
            style={[styles.leaveWalk, { color: c.secondary }]}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {Math.max(1, Math.round(walkS / 60))} min walk to the stop
          </Text>
        </View>
      )}

      <View style={[styles.divider, { backgroundColor: c.separator }]} />

      <View style={styles.footerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Hide details' : 'Show details'}
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((x) => !x)}
          style={({ pressed }) => [styles.detailsToggle, pressed && styles.pressed]}
        >
          <Text style={[styles.detailsText, { color: c.blue }]}>Details</Text>
          <SymbolView
            name={expanded ? 'chevron.up' : 'chevron.down'}
            size={12}
            weight="semibold"
            tintColor={c.blue}
          />
        </Pressable>
        <Text
          style={[styles.totals, { color: c.secondary }]}
          maxFontSizeMultiplier={TextScale.compact}
        >
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
              style={({ pressed }) => [
                styles.startButton,
                { backgroundColor: c.blue, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <SymbolView name="location.north.line.fill" size={15} weight="semibold" tintColor="#FFFFFF" />
              <Text style={styles.startButtonText}>Start Guidance</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
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
  routeHeadline: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 10,
  },
  duration: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  routeName: {
    flex: 1,
    fontSize: 13,
  },
  schedule: {
    fontSize: 13,
    lineHeight: 18,
    fontVariant: ['tabular-nums'],
  },
  routeArrow: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  vehicleStack: {
    gap: 8,
    marginTop: 12,
  },
  vehicle: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 10,
    minHeight: 62,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  vehiclePortrait: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 12,
    height: 46,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 46,
  },
  vehicleBody: { flex: 1, gap: 2 },
  vehicleEyebrowRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  vehicleAction: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  vehicleTitle: { fontSize: 15, fontWeight: '600' },
  vehicleModel: { fontSize: 11.5 },
  vehicleClock: { alignItems: 'flex-end', gap: 1 },
  vehicleTime: {
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  vehicleCountdown: {
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
    paddingTop: 2,
  },
  // 44 pt minimum target; the shortfall used to come out of footerRow's padding.
  detailsToggle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    minHeight: 44,
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
