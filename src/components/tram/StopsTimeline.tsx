// THE LIVING TIMELINE — the tram card's centerpiece since the pass-B content
// redesign deleted the stats band above it.
//
// It renders the stops AHEAD of the tram (plus the one it just left) as an iOS
// grouped-list timeline: one SOLID rail down the left gutter, a dot per stop,
// delay-adjusted times on the right, and a TRAM GLYPH that rides the rail
// between the two stops the car is currently between. With `collapsible`, long
// trips render only the next 5 stops plus a "Show all N stops" expander — that
// is what keeps the ticking NEXT countdown above the card detent's fold.
//
// ── WHAT MOVES, AND WHERE THE FRAMES COME FROM (perf invariant #1) ───────────
// `simDistM` arrives on the shared ~1 Hz tick (`useTramState` in `TramSheet`),
// so React commits this subtree at most once per second — exactly as it did
// before the glyph existed. The glyph does NOT ride those commits. Each tick
// writes ONE shared value (`progressSV`, in ROW units) and lets Reanimated ease
// it on the UI thread with a 1000 ms LINEAR `withTiming`; two `useAnimatedStyle`
// worklets read it — the glyph's `translateY` and the ahead-rail's `scaleY`.
//
// Linear, and exactly 1000 ms, because the anchor cadence is exactly 1 Hz: the
// ramp finishes as the next anchor lands, so the whole thing reads as ONE
// constant-velocity glide instead of a per-second ease-in/ease-out pulse. A late
// tick just holds the glyph at its last anchor — it never extrapolates and never
// overshoots.
//
// Nothing else in here is animated per frame, and NOTHING re-renders a row: the
// rows are plain `View`s the worklets never touch, and the two `Animated.View`s
// the worklets do touch (glyph, ahead-rail) have no children that depend on
// React state. Rendering the movement as row state would have been the invariant
// #1 violation the docs forbid.
//
// ── WHY EVERY ROW IS EXACTLY `ROW_H` TALL ───────────────────────────────────
// The glyph's position is ARITHMETIC — `progress * ROW_H` — with no `onLayout`
// anywhere. Measuring instead would cost either a React commit per stop passed
// or a race between the measurement and the running animation. So the uniform
// row height is not styling, it is the contract the animation stands on, and
// anything that could grow a row (the old two-line "Terminus" label) had to go
// inline. `ROW_H` scales with Dynamic Type so the rows grow with the text.
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated as RNAnimated,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Colors, TextScale, Tram } from '@/constants/theme';
import { useEtaCountdown } from '@/hooks/uiClock';
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
  /** Collapse long trips to the next 5 stops + a "Show all N stops" expander.
   *  Trips with ≤6 upcoming stops always render in full. */
  collapsible?: boolean;
}

/** Stops shown while collapsed. */
const COLLAPSED_COUNT = 5;
/** At or below this many upcoming stops, collapsing isn't worth an extra tap. */
const COLLAPSE_THRESHOLD = 6;

/** Width of the rail gutter. Widened from 18 so the 22 pt glyph has clear air
 *  either side of it without the stop names shifting under it as it passes. */
const RAIL_LANE = 26;
/** Thickness of the rail bar itself. */
const RAIL_W = 2;
/** Gutter → name column. */
const RAIL_GAP = 10;
/** The moving tram token's diameter (border included). */
const GLYPH = 22;
/** The dwell halo's diameter — one ring of air around the glyph. */
const HALO = 28;
/** Row height at Dynamic Type 1×. EVERY row is exactly this tall (see header). */
const ROW_H_BASE = 46;

/**
 * The rail, in two stacked bars. Both are the existing PID red / livery red at
 * new alphas — no new hue enters the palette — so the rail reads as ONE
 * continuous line that is simply brighter ahead of the tram than behind it.
 */
const RAIL_AHEAD = { dark: 'rgba(176,42,38,0.75)', light: 'rgba(122,6,3,0.45)' } as const;
const RAIL_TRAVELLED = { dark: 'rgba(176,42,38,0.22)', light: 'rgba(122,6,3,0.15)' } as const;
/**
 * The departed stop's hollow ring. Its own alpha rather than the rail's: a 1.5 pt
 * stroke needs more of the colour than a 2 pt bar to read at the same weight, and
 * at the rail's light-mode 0.15 the ring simply vanished on #F2F2F7.
 */
const DOT_PAST = { dark: 'rgba(176,42,38,0.6)', light: 'rgba(122,6,3,0.5)' } as const;

/**
 * The glyph's punch-out ring: the sheet's FULL-detent surface fill
 * (`SHEET_SOLID_DARK` #1C1C1E / `SHEET_SOLID_LIGHT` #F2F2F7 in `sheetLook.ts`)
 * held at 0.9. Written as rgba rather than imported because the constants are
 * opaque hex and this needs the alpha — it has to sit convincingly on the glass
 * card detent AND on the solid full detent, and 0.9 of the solid fill reads as
 * "cut out of the rail" against both.
 */
const GLYPH_RING = { dark: 'rgba(28,28,30,0.9)', light: 'rgba(242,242,247,0.9)' } as const;

// The timetable clocks are Prague wall-clock instants; format them in
// Europe/Prague regardless of the device timezone (see formatPragueClock).
const fmtClock = formatPragueClock;

function fmtEta(s: number): string {
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Delay tint for the arrival CLOCK text. `Tram.late`/`veryLate` are tuned as
 * fills and map layers; as 15 pt text on the sheet they measure ~3.4:1 (light)
 * / ~3.2:1 (dark), so the timeline uses per-scheme variants that clear 4.5:1.
 */
function delayTextColor(delaySeconds: number, scheme: 'light' | 'dark'): string {
  if (delaySeconds <= 180) return scheme === 'dark' ? '#FF9F0A' : '#9A5A10';
  return scheme === 'dark' ? '#FF6B60' : '#B3261E';
}

function LoadingSkeleton() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  // Legacy RN Animated has no Reduce Motion default (Reanimated's does).
  const reduceMotion = useReducedMotion();
  // Lazy useState, not useRef(new Animated.Value(…)).current: reading `.current`
  // during render is a compiler-visible impurity; the initializer runs once, so
  // the instance is just as stable.
  const [opacity] = useState(() => new RNAnimated.Value(0.3));

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(0.5);
      return;
    }
    const loop = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(opacity, { toValue: 0.75, duration: 650, useNativeDriver: true }),
        RNAnimated.timing(opacity, { toValue: 0.3, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);

  const bone = scheme === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)';
  return (
    <View>
      {[0, 1, 2, 3].map((i) => (
        <RNAnimated.View key={i} style={[styles.row, { height: ROW_H_BASE }, { opacity }]}>
          <View style={styles.rail}>
            <View style={[styles.dot, { backgroundColor: bone }]} />
          </View>
          <View style={[styles.bone, { backgroundColor: bone, width: `${62 - i * 9}%` }]} />
          <View style={[styles.bone, { backgroundColor: bone, width: 42 }]} />
        </RNAnimated.View>
      ))}
      <Text style={[styles.loadingNote, { color: Colors[scheme].textSecondary }]}>
        route loading…
      </Text>
    </View>
  );
}

/**
 * The stop the tram has just LEFT, rendered above the upcoming ones in a muted
 * hollow style.
 *
 * It exists for the animation, not for the timetable: without it the glyph would
 * be pinned to the first dot with no segment of rail to travel, because the first
 * UPCOMING stop is the one the tram is heading TO. One departed row gives the
 * moving token a full segment, and it is a genuinely useful orientation cue
 * ("you just left Anděl") on a card whose whole job is where-is-this-tram.
 *
 * It is not counted by "Show all N stops" and is unaffected by collapsing.
 */
function DepartedRow({
  stop,
  delaySeconds,
  rowH,
}: {
  stop: RouteStop;
  delaySeconds: number;
  rowH: number;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const clock = fmtClock(stop.departureMs + delaySeconds * 1000);

  return (
    <View
      style={[styles.row, { height: rowH }]}
      accessible
      accessibilityLabel={`${stop.name}, departed, ${clock}`}
    >
      <View style={styles.rail}>
        <View style={[styles.dotPast, { borderColor: DOT_PAST[scheme] }]} />
      </View>
      <View style={styles.nameCol}>
        <Text
          style={[styles.namePast, { color: c.textSecondary }]}
          numberOfLines={1}
          maxFontSizeMultiplier={TextScale.compact}
        >
          {stop.name}
        </Text>
      </View>
      <View style={styles.timeCol}>
        <Text
          style={[styles.timeSmall, { color: c.textSecondary }]}
          maxFontSizeMultiplier={TextScale.content}
        >
          {clock}
        </Text>
      </View>
    </View>
  );
}

interface StopRowProps {
  stop: RouteStop;
  delaySeconds: number;
  isNext: boolean;
  /** The tram is currently dwelling AT this stop. */
  isAtStop: boolean;
  /** Live countdown seconds — only set on the NEXT row. */
  etaS?: number | null;
  rowH: number;
}

function StopRow({ stop, delaySeconds, isNext, isAtStop, etaS, rowH }: StopRowProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const delayed = delaySeconds > 60;
  // While dwelling, the arrival is already in the past — show the scheduled
  // departure instead so the row reads as "leaving at".
  const baseMs = isAtStop ? stop.departureMs : stop.arrivalMs;
  const expectedMs = baseMs + delaySeconds * 1000;
  const dotColor = scheme === 'dark' ? Tram.liveryRed : Tram.pidRed;
  const emphasized = isNext || isAtStop;
  const lateMin = Math.round(delaySeconds / 60);
  // Minute-granularity ETA on purpose: the row re-renders every second, and a
  // label that churns at 1 Hz makes VoiceOver re-announce the focused row.
  const a11yLabel = [
    stop.name,
    isAtStop ? 'at stop now' : isNext ? 'next stop' : null,
    stop.isTerminal ? 'terminus' : null,
    fmtClock(expectedMs),
    isNext && !isAtStop && etaS != null
      ? etaS < 60
        ? 'arriving now'
        : `in ${Math.round(etaS / 60)} min`
      : null,
    delayed
      ? `${lateMin} minute${lateMin === 1 ? '' : 's'} late, scheduled ${fmtClock(baseMs)}`
      : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={[styles.row, { height: rowH }]} accessible accessibilityLabel={a11yLabel}>
      <View style={styles.rail}>
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
            maxFontSizeMultiplier={TextScale.compact}
          >
            {stop.name}
          </Text>
          {/* Terminus is an inline glyph, never a second line: a row that can
              grow breaks the uniform ROW_H the glyph's position is derived
              from (see the file header). */}
          {stop.isTerminal && (
            <SymbolView name="flag.checkered" size={11} tintColor={c.textSecondary} />
          )}
          {isAtStop ? (
            <View style={styles.atStopChip}>
              <Text style={styles.atStopChipText} maxFontSizeMultiplier={TextScale.compact}>
                AT STOP NOW
              </Text>
            </View>
          ) : (
            isNext && (
              <View style={styles.nextChip}>
                <Text style={styles.nextChipText} maxFontSizeMultiplier={TextScale.compact}>
                  NEXT
                </Text>
              </View>
            )
          )}
        </View>
      </View>
      <View style={styles.timeCol}>
        {isNext && !isAtStop && etaS != null ? (
          // NEXT row: live ticking countdown, expected wall time beneath.
          <>
            <Text
              style={[styles.etaLive, { color: dotColor }]}
              maxFontSizeMultiplier={TextScale.content}
            >
              {fmtEta(etaS)}
            </Text>
            <Text
              style={[styles.timeSmall, { color: c.textSecondary }]}
              maxFontSizeMultiplier={TextScale.content}
            >
              {fmtClock(expectedMs)}
            </Text>
          </>
        ) : (
          <>
            <Text
              style={[
                styles.time,
                { color: delayed ? delayTextColor(delaySeconds, scheme) : c.text },
                emphasized && styles.timeNext,
              ]}
              maxFontSizeMultiplier={TextScale.content}
            >
              {fmtClock(expectedMs)}
            </Text>
            {delayed && (
              <Text
                style={[styles.timeSched, { color: c.textSecondary }]}
                maxFontSizeMultiplier={TextScale.content}
              >
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
  collapsible,
}: StopsTimelineProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const etaS = useEtaCountdown(nextStopEtaS ?? null);
  const reduceMotion = useReducedMotion();

  // Rows grow with Dynamic Type instead of clipping — and the glyph's arithmetic
  // follows, because everything below is expressed in ROW units × rowH.
  const { fontScale } = useWindowDimensions();
  const rowH = Math.round(ROW_H_BASE * Math.min(fontScale, TextScale.content));

  // Collapse state resets when the trip changes (new geometry = new journey).
  // Adjusted during render off a remembered prop (the documented React pattern,
  // same as useEtaCountdown) rather than in an effect: an effect would commit
  // the expanded list for one frame and then cascade a second render.
  const [expanded, setExpanded] = useState(false);
  const tripId = geometry?.tripId;
  const [prevTripId, setPrevTripId] = useState(tripId);
  if (tripId !== prevTripId) {
    setPrevTripId(tripId);
    setExpanded(false);
  }

  // ONE backwards-compatible slice: the stops at or ahead of the tram (±2 m, so
  // the stop it is dwelling AT stays in the list) plus the single stop behind it.
  const { upcoming, departed } = useMemo(() => {
    if (!geometry) return { upcoming: [] as RouteStop[], departed: undefined };
    const stops = geometry.stops;
    const cut = simDistM - 2;
    let firstAhead = stops.length;
    for (let i = 0; i < stops.length; i += 1) {
      if (stops[i].distM >= cut) {
        firstAhead = i;
        break;
      }
    }
    return {
      upcoming: stops.slice(firstAhead),
      departed: firstAhead > 0 ? stops[firstAhead - 1] : undefined,
    };
  }, [geometry, simDistM]);

  // While dwelling, upcoming[0] is the stop the tram is stopped AT; NEXT is the
  // following stop, matching the engine's next-stop (shown in the sheet header).
  const dwelling = phase === 'dwell' && upcoming.length > 0;
  const nextIndex = dwelling ? 1 : 0;

  const collapsed = collapsible === true && !expanded && upcoming.length > COLLAPSE_THRESHOLD;
  const visible = collapsed ? upcoming.slice(0, COLLAPSED_COUNT) : upcoming;

  // ── the glyph's anchor, recomputed at most once per second ──────────────────
  // `progress` is in ROW units measured from the FIRST rendered dot, so it is
  // always in [0, 1]: row 0 is the departed stop (or the first upcoming one when
  // the tram has not passed a stop yet) and row 1 is the stop it is heading to.
  const head = upcoming[0];
  const segFrom = departed ? departed.distM : (head?.distM ?? 0);
  const segTo = departed ? (head?.distM ?? segFrom) : (upcoming[1]?.distM ?? segFrom);
  // Never 0: a terminal stop (segTo === segFrom) would divide by zero, and the
  // clamp then parks the glyph on the terminus dot, which is the correct render.
  const segSpanM = Math.max(1, segTo - segFrom);
  const progress = head ? clamp01((simDistM - segFrom) / segSpanM) : 0;
  // Identity of the SEGMENT the glyph is on. When it changes, the rows underneath
  // have been re-sliced, so animating would glide the token across a list that
  // already moved — snap instead (see the teleport table in the effect).
  const segKey = `${tripId ?? '-'}|${departed?.stopId ?? 'head'}>${head?.stopId ?? '-'}`;

  const progressSV = useSharedValue(progress);
  const lastSegRef = useRef(segKey);
  useEffect(() => {
    // TELEPORTS — all of these change segKey and therefore SNAP:
    //  • the tram passes a stop. `upcoming` re-slices and `departed` advances in
    //    the SAME commit that produces the new `progress`, so the whole list
    //    shifts up by one row and `progress` restarts near 0. Measured on device:
    //    the glyph's screen position moves by exactly one ROW_H at that instant,
    //    together with every row — i.e. it stays glued to the stop it is at while
    //    the list scrolls under it, which is right. Animating that would drag the
    //    token across rows that have already moved;
    //  • a new trip / geometry swap (tripId changes);
    //  • geometry arriving for the first time.
    // Everything else (expand/collapse, Dynamic Type, a delay change) leaves the
    // segment alone and keeps gliding.
    const teleport = lastSegRef.current !== segKey;
    lastSegRef.current = segKey;
    if (teleport || reduceMotion) {
      progressSV.value = progress;
      return;
    }
    progressSV.value = withTiming(progress, { duration: 1000, easing: Easing.linear });
  }, [progress, segKey, reduceMotion, progressSV]);

  // The dwell ping: a halo expanding out of the glyph while the tram stands at a
  // stop. Started/stopped by ONE effect per phase change; the loop itself never
  // leaves the UI thread.
  const haloSV = useSharedValue(0);
  const dwellPulse = dwelling && !reduceMotion;
  useEffect(() => {
    if (!dwellPulse) {
      cancelAnimation(haloSV);
      haloSV.value = 0;
      return;
    }
    haloSV.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    return () => cancelAnimation(haloSV);
  }, [dwellPulse, haloSV]);

  // Rail geometry, in ROW units. `spanRows` is the distance from the first dot to
  // the last one; while collapsed the rail continues one row further, into the
  // expander, exactly as the per-row segments used to.
  const rowCount = (departed ? 1 : 0) + visible.length;
  const spanRows = Math.max(0, rowCount - 1 + (collapsed ? 1 : 0));
  const railSpan = spanRows * rowH;
  const scaleDiv = Math.max(1, spanRows);

  const glyphStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: progressSV.value * rowH }],
  }));
  // A radar ping, not a breath: `haloSV` runs 0 → 1 and RESTARTS (non-reversing
  // repeat), so the ring expands out of the glyph and fades, over and over. Its
  // resting state (haloSV 0) is a steady ring one point proud of the glyph, which
  // is exactly what a Reduce Motion user should see while the tram stands at a
  // stop — so the same style serves both.
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.35 * (1 - haloSV.value),
    transform: [{ translateY: progressSV.value * rowH }, { scale: 0.8 + haloSV.value * 0.75 }],
  }));
  // The travelled bar is painted full length underneath; this brighter one is
  // anchored at its BOTTOM and shrinks upward to the glyph, so the rail is dim
  // behind the tram and bright ahead of it with only one animated property.
  const aheadStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: Math.max(0, 1 - progressSV.value / scaleDiv) }],
  }));

  // Every hook above this line runs unconditionally (rules of hooks). The effects
  // are harmless no-ops in the states below: `progress` is 0 and neither the rail
  // nor the glyph is mounted.
  if (!geometry) return <LoadingSkeleton />;

  if (upcoming.length === 0) {
    return (
      <Text style={[styles.loadingNote, { color: Colors[scheme].textSecondary }]}>
        No stops remaining on this trip.
      </Text>
    );
  }

  return (
    <View style={styles.wrap}>
      {/* The rail, drawn ONCE by the container behind the rows — the dots paint
          over it because they come later in the tree. It is decorative and
          hidden from VoiceOver; the rows carry every fact it expresses. */}
      {railSpan > 0 && (
        <>
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.railBar,
              { backgroundColor: RAIL_TRAVELLED[scheme], height: railSpan, top: rowH / 2 },
            ]}
          />
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.railBar,
              styles.railAhead,
              { backgroundColor: RAIL_AHEAD[scheme], height: railSpan, top: rowH / 2 },
              aheadStyle,
            ]}
          />
        </>
      )}

      {departed && <DepartedRow stop={departed} delaySeconds={delaySeconds} rowH={rowH} />}

      {visible.map((stop, i) => (
        <StopRow
          key={`${stop.stopId}-${stop.sequence}`}
          stop={stop}
          delaySeconds={delaySeconds}
          isAtStop={dwelling && i === 0}
          isNext={i === nextIndex}
          etaS={i === nextIndex ? etaS : null}
          rowH={rowH}
        />
      ))}

      {collapsed && (
        <Pressable
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [
            styles.expanderRow,
            { height: rowH },
            pressed && styles.expanderPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Show all ${upcoming.length} stops`}
        >
          <View style={styles.rail} />
          <Text style={[styles.expanderText, { color: Colors[scheme].textSecondary }]}>
            Show all {upcoming.length} stops
          </Text>
          <SymbolView name="chevron.down" size={11} tintColor={Colors[scheme].textSecondary} />
        </Pressable>
      )}

      {/* THE TRAM. Above the rail and the dots, hidden from VoiceOver (AT STOP
          NOW / NEXT / the countdown already say everything it shows) and
          non-interactive, so it can never eat a row's tap. */}
      {/* Mounted ONLY while the tram is standing at a stop — at rest the halo is
          a visible ring, so leaving it mounted would put a permanent pink collar
          on a cruising tram. One mount per phase change, never per frame. */}
      {dwelling && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.halo,
            {
              backgroundColor: scheme === 'dark' ? Tram.liveryRed : Tram.pidRed,
              top: rowH / 2 - HALO / 2,
            },
            haloStyle,
          ]}
        />
      )}
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.glyph,
          {
            backgroundColor: scheme === 'dark' ? Tram.liveryRed : Tram.pidRed,
            borderColor: GLYPH_RING[scheme],
            top: rowH / 2 - GLYPH / 2,
          },
          glyphStyle,
        ]}
      >
        <SymbolView name="tram.fill" size={12} weight="semibold" tintColor="#FFFFFF" />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** Positioning context for the rail bars and the moving glyph. */
  wrap: { position: 'relative' },
  // No paddingVertical and no minHeight: the row's height is set inline and is
  // EXACT, because the glyph's offset is `progress * rowH` (see the file header).
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: RAIL_GAP,
  },
  rail: {
    alignItems: 'center',
    alignSelf: 'stretch',
    justifyContent: 'center',
    width: RAIL_LANE,
  },
  /** One continuous bar down the lane's centre. Solid — never dashed. */
  railBar: {
    left: (RAIL_LANE - RAIL_W) / 2,
    position: 'absolute',
    width: RAIL_W,
  },
  railAhead: { transformOrigin: 'bottom' },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  /** The stop just left: a hollow ring, so it reads as spent without a new hue. */
  dotPast: {
    backgroundColor: 'transparent',
    borderRadius: 4,
    borderWidth: 1.5,
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
  /**
   * The moving tram token. NOT a `TramFace`: at 22 pt the authored face
   * illustration is a smudge — the face keeps its 52 pt home in the sheet
   * header, where it reads. The 2 pt ring is the sheet's own surface fill, which
   * punches the token out of the rail and out of any dot it passes.
   *
   * No shadow: a shadow smears during the glide and costs an offscreen pass.
   */
  glyph: {
    alignItems: 'center',
    borderRadius: GLYPH / 2,
    borderWidth: 2,
    height: GLYPH,
    justifyContent: 'center',
    left: (RAIL_LANE - GLYPH) / 2,
    position: 'absolute',
    width: GLYPH,
    zIndex: 2,
  },
  /** Breathes behind the glyph while the tram stands at a stop. */
  halo: {
    borderRadius: HALO / 2,
    height: HALO,
    left: (RAIL_LANE - HALO) / 2,
    position: 'absolute',
    width: HALO,
    zIndex: 1,
  },
  // minWidth 0 defeats the flex item's automatic min-content minimum: without it
  // a long stop name refuses to shrink and pushes the times column past the
  // sheet's edge (clocks clipped to "03:0" at Dynamic Type XXXL).
  nameCol: { flex: 1, minWidth: 0 },
  nameLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  name: { flexShrink: 1, fontSize: 15 },
  nameNext: { fontSize: 16, fontWeight: '600' },
  namePast: { flexShrink: 1, fontSize: 14 },
  nextChip: {
    backgroundColor: Tram.pidRed,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
  },
  nextChipText: {
    // White on both chips (matches LineBadge's white-on-pidRed) so the NEXT and
    // AT-STOP chips that alternate in this slot read as one family.
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  atStopChip: {
    // The shared white-on-green fill token (5.3:1) — same green as DelayPill's
    // on-time state one section above, so the two don't read as different states.
    backgroundColor: Tram.onTimeFill,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
  },
  atStopChipText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  timeCol: { alignItems: 'flex-end', flexShrink: 0 },
  time: { fontSize: 15, fontVariant: ['tabular-nums'] },
  timeNext: { fontWeight: '600' },
  etaLive: { fontSize: 17, fontVariant: ['tabular-nums'], fontWeight: '700' },
  timeSmall: { fontSize: 12, fontVariant: ['tabular-nums'] },
  timeSched: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    textDecorationLine: 'line-through',
  },
  expanderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  expanderPressed: { opacity: 0.55 },
  expanderText: { fontSize: 13, fontWeight: '500' },
  bone: { borderRadius: 5, height: 12 },
  loadingNote: {
    fontSize: 13,
    fontStyle: 'italic',
    paddingVertical: 8,
    textAlign: 'center',
  },
});
