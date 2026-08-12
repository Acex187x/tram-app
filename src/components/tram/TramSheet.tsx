// THE TRAM CARD — an OWNED sheet on the map screen, built from the same
// `MapSheet` as the home surface.
//
// WHY IT IS NOT A ROUTER formSheet ANY MORE. The card used to be
// `/tram/[key]` presented as a UIKit formSheet, and its "minimized" state was a
// separate component (`FollowMiniCard`) living in the HOME sheet's header slot.
// Swiping the card down therefore DISMISSED one surface and REVEALED another,
// with the identity re-mounting in a different view tree at a different size.
// Every variation of that read as a swap, not a morph — which is exactly what
// the user rejected.
//
// Now there is ONE surface with THREE detents, from one snap table:
//
//   bar    the pinned header ONLY. `MapSheet`'s peek detent is
//          `HEADER_PAD_TOP + measured header + HEADER_PAD_BOTTOM (+ float)`, and
//          the card clips, so nothing can peek out below the row.
//   card   0.42 of the window — the detent the old formSheet declared.
//   full   the same large detent as the home sheet (sheetLook geometry).
//
// Dragging between them changes ONE thing: the card box's height. The header is
// the SAME React element at the same size at every detent — in particular the
// 52 pt portrait NEVER scales, which the user asked for explicitly. (The old
// screen shrank it to 28 on scroll; that collapse is gone, because the header is
// no longer scroll content — it is `MapSheet`'s pinned header, outside the
// ScrollView entirely, so there is nothing for it to collapse against.)
//
// HEADER CHROME is Apple's place-card set, not a native toolbar: the identity
// block and ONE control, the 39 pt ✕ close circle on the trailing edge. (A blue
// `location.fill` "you are following this" glyph used to sit beside it; it is
// gone — the follow STATE is already carried by the follow chip floating above
// the sheet, and a third indicator in the bar was just noise.) The favorite /
// info / photos actions live in the FLOATING ACTION PILL (Apple's own idiom — a
// capsule hanging off the card's bottom edge, over the scrolling content),
// because a native `Stack.Toolbar` needs a native header and this sheet has none.
//
// ── WHAT THE BODY IS, AFTER THE PASS-B CONTENT REDESIGN ─────────────────────
// The card is now THREE things: the pinned identity, the UPCOMING STOPS
// timeline, and About. Everything that used to sit between them is gone:
//
//   • the Following / Line N pill row — following is implicit (the camera is
//     already on the tram, and the follow chip handles resume), and `Line N` is
//     a quieter affordance now: the header's LineBadge is itself the button
//     into `/line/[id]`.
//   • the live stat quad — every tile of it was a duplicate. "Next stop" is the
//     first row of the timeline; "Delay" and "Updated" moved onto the UPCOMING
//     STOPS section heading as a pill + an antenna chip, where they caption the
//     data they qualify instead of floating above it.
//
// That deletes ~110 pt of chrome above the fold, which the timeline takes over:
// at the card detent the user now sees stops, not a dashboard.
//
// PERF: the sheet's drag is `MapSheet`'s worklet over `heightSV`
// (docs/performance.md invariant #1). Nothing here runs per frame — the live
// data is the same ~1 Hz `useTramState` subscription the map already holds.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { MapSheet } from '@/components/maps-kit/MapSheet';
import { CARD_DETENT, lastLegFor } from '@/components/maps-kit/mapSheetLayout';
import { ACTION_PILL, SHEET_H_PAD } from '@/components/maps-kit/sheetLook';
import { AboutTramCard } from '@/components/tram/AboutTramCard';
import { RideRecordSection, RideStatusStrip } from '@/components/tram/RideRecorder';
import { StopsTimeline } from '@/components/tram/StopsTimeline';
import { TramFace } from '@/components/tram/TramFace';
import { AcSnowflake, acTint } from '@/components/tram/TramModelImage';
import { CloseCircle } from '@/components/ui/CloseCircle';
import { DelayPill } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { appleScheme, TabularNums, TextScale } from '@/constants/theme';
import { getRuntime, useLoadedGeometries, useTramState } from '@/hooks/tramData';
import { useNowMs } from '@/hooks/uiClock';
import type { TramPublicState } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

/**
 * The identity portrait's side. Apple's place-card avatar band, and the size the
 * old screen used for its EXPANDED header. It is now the header's tallest child
 * and therefore what sets the bar detent's height — and it is CONSTANT: the
 * whole point of the morph is that this icon does not change size when the sheet
 * is dragged between detents.
 */
const PORTRAIT = 52;
/** Corner radius of the portrait box, concentric with the card's 38 pt corner
 *  minus the ~14 pt content inset (see `sheetLook`'s nesting rule). */
const PORTRAIT_RADIUS = 16;
/** First-frame estimate of the pinned header's height; `MapSheet` then measures
 *  the real row (Dynamic Type grows it) and re-derives the bar detent. */
const HEADER_ESTIMATE = PORTRAIT;

// ── live tickers ─────────────────────────────────────────────────────────────

function fmtAge(ageS: number): string {
  if (ageS < 120) return `${ageS} s`;
  return `${Math.floor(ageS / 60)} m`;
}

// ── pinned identity header (IDENTICAL at every detent) ───────────────────────

/**
 * The place-card identity block: a tappable model portrait (→ the full-screen 3D
 * viewer, the established face→3D entry) beside the line badge, the headsign and
 * a model · reg subtitle, then the ✕ — and NOTHING else. At the bar detent this
 * row IS the whole sheet, so every glyph in it is chrome the user has to look
 * past to read the tram's identity.
 *
 * THE LINE BADGE IS A BUTTON. It replaces the big `Line N` pill that used to sit
 * in the body: the badge already IS the line, so a second element repeating the
 * number was pure duplication. A 9 pt chevron behind it is the whole affordance
 * — enough to read as tappable at a glance, small enough that the bar detent's
 * height (which this row sets) does not move.
 *
 * There is no animation in here at all. That is the feature: this row is what
 * the sheet's bar detent IS, so a scroll- or detent-driven collapse would be the
 * very "the icon changes size while it morphs" defect being fixed.
 */
function TramHeader({ state, onClose }: { state: TramPublicState; onClose: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const line = state.snapshot.line;
  const reg = state.snapshot.registrationNumber;
  const subtitle = `${state.model.name}${reg != null ? ` · #${reg}` : ''}`;

  return (
    <View style={styles.header}>
      <Pressable
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.push(`/model/${state.model.id}`);
        }}
        style={({ pressed }) => pressed && styles.portraitPressed}
        accessibilityRole="button"
        accessibilityLabel={`View ${state.model.name} in 3D`}
        hitSlop={4}
      >
        <View style={[styles.portrait, { backgroundColor: c.fillTertiary }]}>
          <TramFace modelId={state.model.id} size={PORTRAIT} />
        </View>
      </Pressable>

      <View style={styles.headerText}>
        <View style={styles.headerTitleRow}>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.push(`/line/${line}`);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Line ${line}, show line details`}
            style={({ pressed }) => [styles.linePress, pressed && { opacity: 0.6 }]}
          >
            <LineBadge line={line} size="md" />
            <SymbolView
              name="chevron.forward"
              size={9}
              weight="semibold"
              tintColor={c.secondary}
            />
          </Pressable>
          <Text
            style={[styles.headsign, { color: c.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {state.snapshot.headsign}
          </Text>
        </View>
        <View style={styles.headerSubRow}>
          <Text
            style={[styles.headerSubtitle, { color: c.secondary }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {subtitle}
          </Text>
          <AcSnowflake
            airConditioned={state.snapshot.airConditioned}
            size={12}
            tint={acTint(scheme)}
          />
        </View>
      </View>

      <CloseCircle label="Close tram details" onPress={onClose} />
    </View>
  );
}

// ── floating action pill (Apple's place-card capsule) ────────────────────────

/**
 * The capsule hanging off the card's bottom edge. It holds the tram's
 * navigations DIRECTLY — favorite · model info · photos — with no ⋯ in front of
 * them. The ⋯ menu it replaces was a hand-rolled popover guarding two pushes and
 * a recording toggle; the pushes are worth a button each, and the recording
 * moved into the card's own (debug-only) content.
 *
 * 3D IS NOT A BUTTON HERE. It has two better entries that both SHOW the thing
 * they open — the header portrait and the About plaque — so a third, glyph-only
 * one in the capsule was the least legible of the three. The capsule is
 * width-hugging, so dropping it just makes the capsule narrower; `ACTION_PILL`
 * geometry is untouched.
 *
 * `MapSheet` owns the anchoring and the detent fade (it is the sheet's `overlay`
 * slot), so this component is just the capsule and its buttons.
 *
 * ── THE BACKGROUND IS TWO STACKED LAYERS, CROSSFADED ────────────────────────
 * Glass at the bottom, a dark GRAY capsule above it, and the gray one's alpha
 * rides `lastLegFor` — the same 0 → 1 ramp the sheet's own glass → solid
 * surface crossfade uses. So the pill is a dark gray while the card sits at its
 * half detent (where it floats over live, scrolling content and has to occlude
 * it) and is Liquid Glass once the card is FULLY open (where the surface behind
 * it has itself gone solid and a glass capsule reads as the floating layer
 * again).
 *
 * The overlay uses an adaptive system gray rather than black. It stays
 * translucent so the timeline remains faintly visible beneath the capsule.
 *
 * The glass NEVER changes alpha — that is the UIVisualEffectView hazard
 * documented in `sheetLook.ts` (a round trip through fractional alpha loses the
 * material for good). Only the opaque sibling above it animates, exactly as
 * `MapSheet` does it for the sheet surface, and the whole thing is one worklet
 * over `heightSV` with zero React per frame (perf invariant #1).
 *
 * Both glass and glyphs follow the system scheme. The animated gray sibling
 * uses the matching light/dark fill, so the crossfade cannot mix appearances.
 */
function ActionPill({
  isFavorite,
  onFavorite,
  onInfo,
  onPhotos,
  heightSV,
  snapsSV,
}: {
  isFavorite: boolean;
  onFavorite: () => void;
  onInfo: () => void;
  /** Null when the tram reports no registration number — no photos to show. */
  onPhotos: (() => void) | null;
  heightSV: SharedValue<number>;
  snapsSV: SharedValue<number[]>;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  // 1 = the gray fill showing (bar / card detents), 0 = pure glass (fully open).
  const grayStyle = useAnimatedStyle(() => ({
    opacity: 1 - lastLegFor(heightSV.value, snapsSV.value),
  }));

  const button = (
    key: string,
    symbol: SFSymbol,
    label: string,
    onPress: () => void,
    state?: { selected?: boolean },
  ) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={state}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.pillButton, { opacity: pressed ? 0.55 : 1 }]}
    >
      <SymbolView name={symbol} size={ACTION_PILL.glyph} weight="medium" tintColor={c.text} />
    </Pressable>
  );

  return (
    <View style={styles.pill}>
      <GlassPanel variant="regular" interactive style={styles.pillFill} />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.pillFill,
          {
            backgroundColor:
              scheme === 'dark' ? 'rgba(44,44,46,0.88)' : 'rgba(242,242,247,0.88)',
          },
          grayStyle,
        ]}
      />
      <View style={styles.pillRow}>
        {button(
          'favorite',
          isFavorite ? 'star.fill' : 'star',
          isFavorite ? 'Remove from favorites' : 'Add to favorites',
          () => {
            void Haptics.selectionAsync();
            onFavorite();
          },
          { selected: isFavorite },
        )}
        {button('info', 'info.circle', 'Model info & history', () => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onInfo();
        })}
        {onPhotos != null &&
          button('photos', 'camera', 'Photos of this car', () => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onPhotos();
          })}
      </View>
    </View>
  );
}

// ── section-header metadata + debug honesty line ─────────────────────────────

/**
 * The trailing slot of the UPCOMING STOPS heading: the trip's delay pill and a
 * position-freshness chip.
 *
 * This is where the old stats quad went. Both values QUALIFY the timeline —
 * "these times are +6 min" and "this position is 4 s old" — so captioning the
 * section they qualify says more in one row than three centred tiles said in
 * two, and it costs the card no vertical space at all.
 *
 * Width budget at 402 pt: label ~118 + 8 + pill ≤78 + 8 + chip ~38 = 250 of the
 * 370 available, ~310 at Dynamic Type 1.35×. Both meta elements are fixed-width
 * data and never shrink; `SectionLabel` truncates its own text instead.
 */
function TimelineMeta({
  delaySeconds,
  observedAtMs,
}: {
  delaySeconds: number;
  observedAtMs: number;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  // The shared 1 Hz UI clock — the same subscription the timeline's countdown
  // already holds, not a second timer (perf invariant #1).
  const nowMs = useNowMs();
  const ageS = Math.max(0, Math.round((nowMs - observedAtMs) / 1000));
  const fresh = ageS <= 15;
  const tint = fresh ? c.green : c.secondary;

  return (
    <View style={styles.metaRow}>
      {/* DelayPill is already its own accessibility element with a spoken
          label ("6 minutes late") — do not wrap it. */}
      <DelayPill delaySeconds={delaySeconds} />
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={`Position updated ${fmtAge(ageS)} ago`}
        style={styles.freshChip}
      >
        <SymbolView
          name="antenna.radiowaves.left.and.right"
          size={11}
          weight="semibold"
          tintColor={tint}
        />
        <Text style={[styles.freshText, { color: tint }]} maxFontSizeMultiplier={TextScale.compact}>
          {fmtAge(ageS)}
        </Text>
      </View>
    </View>
  );
}

/**
 * The position-mode honesty line — DEBUG ONLY as of this pass.
 *
 * ux-screens §8 required the card to declare its own uncertainty, and it still
 * does: this string is unchanged. What changed is who sees it. After the stats
 * band was deleted the card no longer presents ANY synthesized quantity — the
 * only thing left for this line to qualify is the MAP's dot, which is chrome
 * this card does not own, and which the user opted into in Settings. §8's hard
 * rule (never dress a simulated quantity up as a measurement) is untouched:
 * nothing simulated is surfaced here at all any more.
 */
function HonestyLine({
  deviationM,
  positionMode,
}: {
  deviationM: number | null | undefined;
  positionMode: string;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const debugMode = useSettingsStore((s) => s.debugMode);

  // Four-way per engine-v2.md §2.7 (+ the experimental ml mode): raw = the fix
  // itself, live = the engine's estimate of the real tram, ml = the research
  // lab's prediction (labelled as the experiment it is — the deviation number
  // would be measuring the wrong thing there), smooth = the cinematic sim
  // (the only synthesized quantity worth quantifying against the fix).
  const text =
    positionMode === 'raw'
      ? 'Showing raw reported position'
      : positionMode === 'live'
        ? 'Showing estimated real-time position'
        : positionMode === 'ml'
          ? 'ML-прогноз (эксперимент)'
          : deviationM != null
            ? `Sim offset ±${Math.round(deviationM)} m from last fix`
            : null;

  if (!debugMode || text == null) return null;
  return (
    <View style={styles.honestyRow}>
      <SymbolView name="wand.and.rays" size={11} weight="semibold" tintColor={c.secondary} />
      <Text
        style={[styles.honestyText, { color: c.secondary }]}
        maxFontSizeMultiplier={TextScale.content}
      >
        {text}
      </Text>
    </View>
  );
}

// ── gone / left-service state ────────────────────────────────────────────────

/** The bit of a vanished tram the gone screen still needs (line + reg). */
interface LastSeen {
  key: string;
  line: string;
  reg: number | null;
}

function GoneState({ lastSeen, onClose }: { lastSeen: LastSeen | undefined; onClose: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <View style={styles.goneWrap}>
      <SymbolView name="moon.zzz.fill" size={44} tintColor={c.secondary} />
      {lastSeen && <LineBadge line={lastSeen.line} size="lg" />}
      <Text style={[styles.goneTitle, { color: c.text }]}>Left service</Text>
      <Text style={[styles.goneSubtitle, { color: c.secondary }]}>
        {lastSeen
          ? `Tram #${lastSeen.reg ?? lastSeen.key} on line ${lastSeen.line} is no longer being tracked. It has likely reached its depot or ended the trip.`
          : 'This tram is not currently being tracked.'}
      </Text>
      <GlassPanel variant="clear" interactive style={styles.goneButton}>
        {/* Dismissal is a store write now, not `router.back()`: this sheet is not
            a route, so there is nothing on the stack to pop. */}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={6}
          style={({ pressed }) => [styles.goneButtonPress, pressed && { opacity: 0.6 }]}
        >
          <Text style={[styles.goneButtonText, { color: c.text }]}>Close</Text>
        </Pressable>
      </GlassPanel>
    </View>
  );
}

/** The bar/gone header — the tram left the feed, so there is no live identity to
 *  render, but the pinned slot must never be empty (it would be a blank slab of
 *  glass with no way back). */
function GoneHeader({ lastSeen, onClose }: { lastSeen: LastSeen | undefined; onClose: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <View style={styles.header}>
      <View style={[styles.portrait, styles.portraitEmpty, { backgroundColor: c.fillTertiary }]}>
        <SymbolView name="moon.zzz.fill" size={22} tintColor={c.secondary} />
      </View>
      <View style={styles.headerText}>
        <Text
          style={[styles.headsign, { color: c.text }]}
          numberOfLines={1}
          maxFontSizeMultiplier={TextScale.compact}
        >
          {lastSeen ? `#${lastSeen.reg ?? lastSeen.key}` : 'Tram'}
        </Text>
        <Text
          style={[styles.headerSubtitle, { color: c.secondary }]}
          numberOfLines={1}
          maxFontSizeMultiplier={TextScale.compact}
        >
          {lastSeen ? 'Left service' : 'Locating tram…'}
        </Text>
      </View>
      <CloseCircle label="Close tram details" onPress={onClose} />
    </View>
  );
}

// ── the sheet ────────────────────────────────────────────────────────────────

export interface TramSheetProps {
  /** Entity key of the presented tram (`presentedTramKey`). */
  tramKey: string;
  /** Live sheet height (px), written by the pan worklet every frame. The map
   *  screen hands this to the chrome so the controls ride THIS sheet while it is
   *  the surface on screen. */
  heightSV: SharedValue<number>;
  /** Fires when the snap table changes (header measured, rotation). */
  onSnapsChange?: (snaps: number[]) => void;
}

export function TramSheet({ tramKey, heightSV, onSnapsChange }: TramSheetProps) {
  const state = useTramState(tramKey);
  const geometries = useLoadedGeometries();
  const { fontScale } = useWindowDimensions();

  const followTramKey = useSelectionStore((s) => s.followTramKey);
  const setFollowTramKey = useSelectionStore((s) => s.setFollowTramKey);
  const closeTram = useSelectionStore((s) => s.closeTram);
  // Read, never toggled from here any more: the follow BUTTON is gone (following
  // is implicit on open, and the floating follow chip owns pause/resume/end).
  // The card still needs the flag so a tram that leaves service auto-unfollows.
  const isFollowing = followTramKey === tramKey;

  // Remember the last live identity so a tram that drops out of the feed while
  // the card is open still gets a header and a "left service" body. State
  // adjusted during render (React's derived-state pattern), not a ref: a ref
  // written during render is invisible to the React Compiler and can render a
  // stale gone screen. Only the IDENTITY is remembered, so the extra render
  // fires when line/reg change (≈once), not on every 1 Hz tick.
  const [lastSeen, setLastSeen] = useState<LastSeen | undefined>(undefined);
  if (
    state &&
    (lastSeen === undefined ||
      lastSeen.key !== state.key ||
      lastSeen.line !== state.snapshot.line ||
      lastSeen.reg !== state.snapshot.registrationNumber)
  ) {
    setLastSeen({
      key: state.key,
      line: state.snapshot.line,
      reg: state.snapshot.registrationNumber,
    });
  }
  const hasPolled = getRuntime().lastPollAtMs > 0;
  const gone = !state && (lastSeen !== undefined || hasPolled);

  // If the followed tram leaves service, stop following it. (Presentation is
  // left alone — the user still gets the "left service" card and closes it.)
  useEffect(() => {
    if (gone && isFollowing) setFollowTramKey(null);
  }, [gone, isFollowing, setFollowTramKey]);

  // Bump the geometry fetch priority once per trip while it's missing.
  const prioritizedTripRef = useRef<string | null>(null);
  const tripId = state?.snapshot.tripId;
  const hasGeometry = state?.hasGeometry ?? false;
  useEffect(() => {
    if (tripId && !hasGeometry && prioritizedTripRef.current !== tripId) {
      prioritizedTripRef.current = tripId;
      getRuntime().prioritizeTrip(tripId);
    }
  }, [tripId, hasGeometry]);

  const geometry = useMemo(
    () => (tripId ? geometries.find((g) => g.tripId === tripId) : undefined),
    [geometries, tripId],
  );

  const positionMode = useSettingsStore((s) => s.positionMode);
  const isFavorite = useFavoritesStore((s) => s.favoriteTrams.includes(tramKey));
  const toggleTram = useFavoritesStore((s) => s.toggleTram);

  const onClose = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeTram();
  }, [closeTram]);

  const reg = state?.snapshot.registrationNumber ?? null;

  // The LIVE snap table, mirrored into a shared value so the floating pill's
  // black → glass crossfade can be a pure worklet over `heightSV` (it needs the
  // medium and large detents to know where the last leg starts). One write per
  // LAYOUT — the same cadence `onSnapsChange` already fires at, never per frame,
  // so perf invariant #1 is untouched. Routed through state + an effect (the
  // shape `MapSheet` uses for its own copy) rather than written inside the
  // callback: the React Compiler's immutability rule forbids mutating a value
  // that was passed to a hook from inside another hook's body.
  const [snaps, setSnaps] = useState<number[]>([]);
  const snapsSV = useSharedValue<number[]>([]);
  useEffect(() => {
    snapsSV.value = snaps;
  }, [snaps, snapsSV]);
  const handleSnaps = useCallback(
    (next: number[]) => {
      setSnaps(next);
      onSnapsChange?.(next);
    },
    [onSnapsChange],
  );

  // The header row grows with Dynamic Type (two text lines beside a fixed
  // portrait), so the first-frame estimate is scaled the same way the row is —
  // MapSheet corrects it from the real onLayout a frame later either way.
  const headerHeight = Math.round(HEADER_ESTIMATE * Math.min(fontScale, TextScale.compact));

  return (
    <MapSheet
      label="Tram card"
      heightSV={heightSV}
      headerHeight={headerHeight}
      onSnapsChange={handleSnaps}
      mediumFraction={CARD_DETENT}
      // Opens on the CARD detent and can be dragged down to the bar — the bar is
      // this same sheet, not a hand-off to another surface.
      initialSnapIndex={1}
      overlay={
        state ? (
          <ActionPill
            isFavorite={isFavorite}
            onFavorite={() => toggleTram(tramKey)}
            onInfo={() => router.push(`/model-info/${state.model.id}`)}
            onPhotos={reg != null ? () => router.push(`/tram-photos/${reg}`) : null}
            heightSV={heightSV}
            snapsSV={snapsSV}
          />
        ) : undefined
      }
      header={
        state ? (
          <TramHeader state={state} onClose={onClose} />
        ) : (
          <GoneHeader lastSeen={gone ? lastSeen : undefined} onClose={onClose} />
        )
      }
    >
      {state ? (
        <SheetContent style={styles.column}>
          <View>
            <SectionLabel
              trailing={
                <TimelineMeta
                  delaySeconds={state.snapshot.delaySeconds}
                  observedAtMs={state.snapshot.observedAtMs}
                />
              }
            >
              Upcoming stops
            </SectionLabel>
            <StopsTimeline
              geometry={geometry}
              simDistM={state.simDistM}
              delaySeconds={state.snapshot.delaySeconds}
              phase={state.phase}
              nextStopEtaS={state.nextStopEtaS}
              collapsible
            />
          </View>

          {/* An ACTIVE recording always surfaces, debug mode or not — a running
              ride the user cannot see or stop is the one state that must never
              be hidden. The START affordance below it is the debug-only half. */}
          <RideStatusStrip tramKey={tramKey} />
          <RideRecordSection tramKey={tramKey} />

          <View>
            <SectionLabel>About</SectionLabel>
            <AboutTramCard model={state.model} snapshot={state.snapshot} />
          </View>

          <HonestyLine deviationM={state.deviationM} positionMode={positionMode} />

          {/* Clearance for the floating capsule, which overlays this scroll. */}
          <View style={styles.pillClearance} />
        </SheetContent>
      ) : gone ? (
        <GoneState lastSeen={lastSeen} onClose={onClose} />
      ) : (
        <View style={styles.goneWrap} />
      )}
    </MapSheet>
  );
}

const styles = StyleSheet.create({
  // ── pinned identity header ──
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    // The pinned identity row and the scrolling body below it share ONE edge.
    // They used to be 14 (CARD_PAD) and 20, so the portrait sat 6 pt outboard
    // of the Follow button directly beneath it — visible at every detent, and
    // most obvious at the bar, where this row IS the whole sheet.
    paddingHorizontal: SHEET_H_PAD,
  },
  portraitPressed: { transform: [{ scale: 0.96 }] },
  // Concentric with the card's 38 pt corner minus the 14 pt content inset —
  // 38 − 14 ≈ 24 would bulge on a 52 pt box, so this keeps the old screen's
  // measured 16 (see the nesting rule in sheetLook.ts).
  portrait: {
    width: PORTRAIT,
    height: PORTRAIT,
    borderRadius: PORTRAIT_RADIUS,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  portraitEmpty: { alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, gap: 3, justifyContent: 'center' },
  headerTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  // The badge + its 9 pt chevron. The chevron eats 3 + 9 of the row's 9 pt gap
  // to the headsign, which is deliberate: the affordance should read as part of
  // the badge, not as a separate glyph floating between two elements.
  linePress: { alignItems: 'center', flexDirection: 'row', gap: 3 },
  headsign: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
  headerSubRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  headerSubtitle: { flexShrink: 1, fontSize: 13 },

  // ── floating action pill ──
  // A true capsule (r = h/2) — never `borderCurve: 'continuous'`, which renders
  // a squircle on a stadium and reads as lopsided (sheetLook.ts). `overflow`
  // clips both background layers to that capsule, so neither can square off a
  // corner during the crossfade.
  pill: {
    height: ACTION_PILL.h,
    borderRadius: ACTION_PILL.h / 2,
    overflow: 'hidden',
  },
  // The two stacked backgrounds: glass first, the opaque black above it. Both
  // carry the capsule radius of their own — the native GlassView paints its own
  // shape, and a square one inside a clipping parent leaves the map showing
  // through the mismatch at the ends (the same defect `MapSheet` fixed).
  pillFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: ACTION_PILL.h / 2,
  },
  /**
   * The non-glass end of the crossfade: Apple's dark GRAY, not black.
   *
   * `#000000` here measured a flat luma 0.00 on device against Apple's own
   * pill at the same detent, which reads 33–42 over live content — a hard black
   * slab where Apple has a translucent gray one. `ACTION_PILL.fill` is the
   * measured replacement; see `sheetLook.ts` for the samples.
   */
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ACTION_PILL.h,
    // endInset is measured to the first icon's CENTRE, so the padding is that
    // minus half a button…
    paddingHorizontal: ACTION_PILL.endInset - ACTION_PILL.h / 2,
    // …and the gap makes up the difference between the buttons' own width and
    // Apple's 54.7 pt centre-to-centre spacing. Without it the buttons abutted
    // and the spacing was the button width (47), not the measured 54.7.
    gap: ACTION_PILL.gap - ACTION_PILL.h,
  },
  pillButton: {
    width: ACTION_PILL.h,
    height: ACTION_PILL.h,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── body ──
  // No flex here — inside a ScrollView's content container a flex:1 child
  // collapses to zero height and the whole card renders blank.
  // SECTION_GAP 22 — the one vertical rhythm both sheets use between top-level
  // sections (was 18 here, 22 on the home sheet).
  column: { gap: 22, paddingHorizontal: SHEET_H_PAD, paddingTop: 14 },
  /** Keeps the last row scrollable clear of the floating capsule. */
  pillClearance: { height: ACTION_PILL.h + ACTION_PILL.fromCardBottom },

  // ── UPCOMING STOPS section-header meta ──
  // flexShrink 0 throughout: the heading truncates, the data never does.
  metaRow: { alignItems: 'center', flexDirection: 'row', flexShrink: 0, gap: 8 },
  freshChip: { alignItems: 'center', flexDirection: 'row', flexShrink: 0, gap: 3 },
  freshText: { fontSize: 12, ...TabularNums },

  // Debug-only honesty line. NOT centred — it sits on the sheet's content edge
  // like every other top-level element (it used to be `justifyContent: center`,
  // aligned with nothing).
  honestyRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  honestyText: { fontSize: 12 },

  // Centred empty-state prose, so it legitimately sits inboard of the content
  // edge rather than on it — but derived from it, not a free 24.
  goneWrap: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: SHEET_H_PAD + 8,
    paddingVertical: 40,
  },
  goneTitle: { fontSize: 20, fontWeight: '700' },
  goneSubtitle: { fontSize: 15, lineHeight: 20, textAlign: 'center' },
  goneButton: { borderRadius: 999, marginTop: 8 },
  // The Pressable, not the label, carries the padding — the whole pill is then
  // the hit target and clears the 44 pt minimum at any text size.
  goneButtonPress: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 28,
  },
  goneButtonText: { fontSize: 15, fontWeight: '600' },
});
