// Upcoming-stops timeline for the tram detail sheet. Renders the stops ahead
// of the tram's simulated position as an iOS grouped-list style timeline with
// a rail of dots, delay-adjusted times, and a terminus flag. The NEXT row
// carries the live ETA countdown (red, ticking each second) with the expected
// wall-clock arrival beneath it. While the trip geometry is still streaming in
// it shows a subtle pulsing skeleton.
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { delayColor } from '@/components/ui/DelayPill';
import { Colors, Tram } from '@/constants/theme';
import { formatPragueClock } from '@/lib/format/pragueTime';
import type { RouteGeometry, RouteStop, TramPublicState } from '@/lib/types';

export interface StopsTimelineProps {
  /** Trip geometry, or undefined while it is still loading. */
  geometry: RouteGeometry | undefined;
  /** Tram's simulated distance along the shape, meters. */
  simDistM: number;
  /** Current reported delay, seconds (shifts scheduled times). */
  delaySeconds: number;
  /** Current sim phase — during 'dwell' the first upcoming stop is the one the
   *  tram is stopped AT, so NEXT shifts to the following stop (matches header). */
  phase?: TramPublicState['phase'];
  /** Engine's ETA to the next stop, seconds — shown as a live countdown on the
   *  NEXT row. Ticks locally each second between runtime updates. */
  nextStopEtaS?: number | null;
}

// The timetable clocks are Prague wall-clock instants; format them in
// Europe/Prague regardless of the device timezone (see formatPragueClock).
const fmtClock = formatPragueClock;

/**
 * Live ETA countdown. Anchors on every fresh value from the runtime (~1 Hz)
 * and ticks locally each second so the countdown never freezes if UI updates
 * stall between polls.
 */
function useEtaCountdown(etaS: number | null): number | null {
  const anchorRef = useRef<{ etaS: number; atMs: number } | null>(null);
  const [, setTick] = useState(0);

  if (etaS == null) {
    anchorRef.current = null;
  } else if (!anchorRef.current || anchorRef.current.etaS !== etaS) {
    anchorRef.current = { etaS, atMs: Date.now() };
  }

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const anchor = anchorRef.current;
  if (!anchor) return null;
  return Math.max(0, Math.round(anchor.etaS - (Date.now() - anchor.atMs) / 1000));
}

function fmtEta(s: number): string {
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function LoadingSkeleton() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.75, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  const bone = scheme === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)';
  return (
    <View>
      {[0, 1, 2, 3].map((i) => (
        <Animated.View key={i} style={[styles.row, { opacity }]}>
          <View style={styles.rail}>
            <View style={[styles.dot, { backgroundColor: bone }]} />
          </View>
          <View style={[styles.bone, { backgroundColor: bone, width: `${62 - i * 9}%` }]} />
          <View style={[styles.bone, { backgroundColor: bone, width: 42 }]} />
        </Animated.View>
      ))}
      <Text style={[styles.loadingNote, { color: Colors[scheme].textSecondary }]}>
        route loading…
      </Text>
    </View>
  );
}

interface StopRowProps {
  stop: RouteStop;
  delaySeconds: number;
  isNext: boolean;
  /** The tram is currently dwelling AT this stop. */
  isAtStop: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** Live countdown seconds — only set on the NEXT row. */
  etaS?: number | null;
}

function StopRow({ stop, delaySeconds, isNext, isAtStop, isFirst, isLast, etaS }: StopRowProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const delayed = delaySeconds > 60;
  // While dwelling, the arrival is already in the past — show the scheduled
  // departure instead so the row reads as "leaving at".
  const baseMs = isAtStop ? stop.departureMs : stop.arrivalMs;
  const expectedMs = baseMs + delaySeconds * 1000;
  const railColor = scheme === 'dark' ? 'rgba(176,42,38,0.55)' : Tram.redSoft;
  const dotColor = scheme === 'dark' ? Tram.liveryRed : Tram.pidRed;
  const emphasized = isNext || isAtStop;

  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <View
          style={[styles.railSegment, styles.railTop, { backgroundColor: railColor, opacity: isFirst ? 0 : 1 }]}
        />
        <View
          style={[styles.railSegment, styles.railBottom, { backgroundColor: railColor, opacity: isLast ? 0 : 1 }]}
        />
        <View
          style={
            isAtStop
              ? [styles.dotAtStop, { backgroundColor: Tram.onTime }]
              : isNext
                ? [styles.dotNext, { backgroundColor: dotColor }]
                : [styles.dot, { backgroundColor: dotColor }]
          }
        />
      </View>
      <View style={styles.nameCol}>
        <View style={styles.nameLine}>
          <Text
            style={[styles.name, { color: c.text }, emphasized && styles.nameNext]}
            numberOfLines={1}
          >
            {stop.name}
          </Text>
          {isAtStop ? (
            <View style={styles.atStopChip}>
              <Text style={styles.atStopChipText} allowFontScaling={false}>
                AT STOP NOW
              </Text>
            </View>
          ) : (
            isNext && (
              <View style={styles.nextChip}>
                <Text style={styles.nextChipText} allowFontScaling={false}>
                  NEXT
                </Text>
              </View>
            )
          )}
        </View>
        {stop.isTerminal && (
          <View style={styles.terminalLine}>
            <SymbolView name="flag.checkered" size={11} tintColor={c.textSecondary} />
            <Text style={[styles.terminalText, { color: c.textSecondary }]}>Terminus</Text>
          </View>
        )}
      </View>
      <View style={styles.timeCol}>
        {isNext && !isAtStop && etaS != null ? (
          // NEXT row: live ticking countdown, expected wall time beneath.
          <>
            <Text style={[styles.etaLive, { color: dotColor }]} allowFontScaling={false}>
              {fmtEta(etaS)}
            </Text>
            <Text style={[styles.timeSmall, { color: c.textSecondary }]} allowFontScaling={false}>
              {fmtClock(expectedMs)}
            </Text>
          </>
        ) : (
          <>
            <Text
              style={[
                styles.time,
                { color: delayed ? delayColor(delaySeconds) : c.text },
                emphasized && styles.timeNext,
              ]}
              allowFontScaling={false}
            >
              {fmtClock(expectedMs)}
            </Text>
            {delayed && (
              <Text style={[styles.timeSched, { color: c.textSecondary }]} allowFontScaling={false}>
                {fmtClock(baseMs)}
              </Text>
            )}
          </>
        )}
      </View>
    </View>
  );
}

export function StopsTimeline({
  geometry,
  simDistM,
  delaySeconds,
  phase,
  nextStopEtaS,
}: StopsTimelineProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const etaS = useEtaCountdown(nextStopEtaS ?? null);

  const upcoming = useMemo(() => {
    if (!geometry) return [];
    // Keep the stop the tram is currently dwelling at (±2 m tolerance).
    return geometry.stops.filter((s) => s.distM >= simDistM - 2);
  }, [geometry, simDistM]);

  if (!geometry) return <LoadingSkeleton />;

  if (upcoming.length === 0) {
    return (
      <Text style={[styles.loadingNote, { color: Colors[scheme].textSecondary }]}>
        No stops remaining on this trip.
      </Text>
    );
  }

  // While dwelling, upcoming[0] is the stop the tram is stopped AT; NEXT is the
  // following stop, matching the engine's next-stop (shown in the sheet header).
  const dwelling = phase === 'dwell' && upcoming.length > 0;
  const nextIndex = dwelling ? 1 : 0;

  return (
    <View>
      {upcoming.map((stop, i) => (
        <StopRow
          key={`${stop.stopId}-${stop.sequence}`}
          stop={stop}
          delaySeconds={delaySeconds}
          isAtStop={dwelling && i === 0}
          isNext={i === nextIndex}
          isFirst={i === 0}
          isLast={i === upcoming.length - 1}
          etaS={i === nextIndex ? etaS : null}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 40,
    paddingVertical: 4,
  },
  rail: {
    alignItems: 'center',
    alignSelf: 'stretch',
    justifyContent: 'center',
    width: 18,
  },
  railSegment: {
    left: 8,
    position: 'absolute',
    width: 2,
  },
  railTop: { height: '50%', top: 0 },
  railBottom: { bottom: 0, height: '50%' },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  dotNext: {
    backgroundColor: Tram.pidRed,
    borderColor: Tram.gold,
    borderRadius: 7,
    borderWidth: 2.5,
    height: 14,
    width: 14,
  },
  dotAtStop: {
    backgroundColor: Tram.onTime,
    borderColor: Tram.cream,
    borderRadius: 7,
    borderWidth: 2.5,
    height: 14,
    width: 14,
  },
  nameCol: { flex: 1, gap: 1 },
  nameLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  name: { flexShrink: 1, fontSize: 15 },
  nameNext: { fontSize: 16, fontWeight: '600' },
  nextChip: {
    backgroundColor: Tram.pidRed,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
  },
  nextChipText: {
    color: Tram.cream,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  atStopChip: {
    backgroundColor: Tram.onTime,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
  },
  atStopChipText: {
    color: Tram.cream,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  terminalLine: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  terminalText: { fontSize: 12 },
  timeCol: { alignItems: 'flex-end' },
  time: { fontSize: 15, fontVariant: ['tabular-nums'] },
  timeNext: { fontWeight: '600' },
  etaLive: { fontSize: 17, fontVariant: ['tabular-nums'], fontWeight: '700' },
  timeSmall: { fontSize: 12, fontVariant: ['tabular-nums'] },
  timeSched: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    textDecorationLine: 'line-through',
  },
  bone: { borderRadius: 5, height: 12 },
  loadingNote: {
    fontSize: 13,
    fontStyle: 'italic',
    paddingVertical: 8,
    textAlign: 'center',
  },
});
