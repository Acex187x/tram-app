// Product map chrome floating over the basemap: the live fleet status tile,
// StatusTile (top-left), the right-edge control column (2D/3D circle + a fused
// layers/locate capsule with a light-preset / route-lines quick menu), and the
// bottom chip cluster (follow / spotter / ride / planner) that RIDES above the
// home sheet — translating with the sheet's heightSV on the UI thread.
//
// APPEARANCE: MapChromeSchemeContext carries the system color scheme, so every
// app surface changes together independently of the basemap's time preset.

import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { createContext, useContext, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  useColorScheme,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  ZoomIn,
  ZoomOut,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePollModel } from '@/components/map/PollIndicator';
import {
  CircleControl,
  ControlCapsule,
  ControlStack as KitControlStack,
  CONTROL_GAP,
  CONTROL_SIZE,
} from '@/components/maps-kit/CircleControl';
import { chromeRideFor } from '@/components/maps-kit/mapSheetLayout';
import { StatusTile } from '@/components/maps-kit/StatusTile';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { appleScheme, Colors, Fonts, Radii, Spacing, TextScale, Tram } from '@/constants/theme';
import { useAllTramStates, useTramState } from '@/hooks/tramData';
import { formatEtaMinutes } from '@/lib/arrivals';
import { usePlannerStore } from '@/stores/planner';
import { useRidePreviewStore } from '@/stores/ridePreview';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore, type LightPreset } from '@/stores/settings';
import { useSpotterStore } from '@/stores/spotter';

// ── Chrome appearance (follows the system scheme) ────────────────────────

export type ChromeScheme = 'light' | 'dark';

/** Provided by the map screen from the current system appearance. */
export const MapChromeSchemeContext = createContext<ChromeScheme | null>(null);

export function useChromeScheme(): ChromeScheme {
  const provided = useContext(MapChromeSchemeContext);
  const system = useColorScheme();
  return provided ?? (system === 'dark' ? 'dark' : 'light');
}

/**
 * Livery red for a glyph drawn on DARK chrome glass. `Tram.liveryRed` (#B02A26)
 * only reaches 2.6:1 on the dark surface, under the 3:1 floor for a glyph that
 * carries meaning (WCAG 1.4.11); this lift clears 6:1 and still reads as PID red.
 */
const LIVERY_RED_ON_DARK = '#FF6B63';

/** Livery tint for a chrome glyph in the current system appearance. */
function liveryTint(scheme: ChromeScheme): string {
  return scheme === 'dark' ? LIVERY_RED_ON_DARK : Tram.pidRed;
}

function useTextColors() {
  const scheme = useChromeScheme();
  const palette = Colors[scheme];
  return { scheme, text: palette.text, secondary: palette.textSecondary };
}

function tapLight() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

// ── Layout constants (shared with the map screen's compass ornament) ─────────

/** Right inset of the control column — one shared vertical axis. */
const CONTROL_RIGHT = Spacing.two + 4;
/**
 * Height of the right control stack: a 2D/3D circle (46) + gap + the fused
 * layers/locate capsule (two 46 buttons ≈ 92).
 */
export const STACK_H = CONTROL_SIZE + CONTROL_GAP + 2 * CONTROL_SIZE;
/** The native compass is ~44 pt wide; +1 centers it on the 46 pt button axis. */
export const COMPASS_RIGHT = CONTROL_RIGHT + 1;
/**
 * Right inset of the contextual chip cluster: it stops one control-gap to the
 * LEFT of the right-edge control column so the full-width follow pill can never
 * sit over the 2D/layers/locate buttons (the reported overlap).
 */
const CHIPS_RIGHT_INSET = CONTROL_RIGHT + CONTROL_SIZE + CONTROL_GAP;
/**
 * Bottom offset (px, from the window bottom) of the Mapbox compass ornament:
 * it floats just above the bottom-right control column, on the same right axis
 * and on the SAME band (CHROME_GAP) the riding chrome uses, so it sits directly
 * on top of the column instead of hovering in dead air.
 *
 * It is the SAME anchor the JS chrome uses, read from the same worklet:
 * `chromeRideFor` parks the column's BOTTOM edge at `sheetTop + CHROME_GAP`
 * (clamped at the medium detent, exactly as the column is), so its top edge is
 * that + STACK_H; +8 is the Apple-like breathing room above it. Sharing
 * `chromeRideFor` rather than re-deriving the band is what keeps the ornament
 * and the buttons from drifting apart when the sheet's header — and therefore
 * its peek height — changes.
 *
 * `safeBottom` is the bottom safe-area inset and MUST be passed: Mapbox iOS
 * lays ornaments out inside the safe area, so a margin of N renders the compass
 * N pt above the HOME INDICATOR, not N pt above the window bottom. Left
 * uncompensated the disc floated a full inset higher than the formula intends
 * (measured on an iPhone 16 Pro: a 43.7 pt gap above the control column instead
 * of 8 — exactly the 34 pt indicator inset). Clamped at 0 so a tall inset can
 * never drive the ornament off the bottom of the safe area.
 *
 * KNOWN, ACCEPTED — and the reason this takes a SETTLED height rather than the
 * live one: the compass is a STATIC native Mapbox ornament, positioned by a
 * React prop rather than by a shared value, so it cannot ride the drag the way
 * the JS chrome does (docs/performance.md invariant #1 forbids feeding it from
 * per-frame state). It therefore RELOCATES per detent instead: the map screen
 * holds the active sheet's resting height in React state, written once per
 * settle, and the ornament jumps to the new band when the sheet lands. Passing
 * 0 (nothing settled yet) is safe — `chromeRideFor` clamps anything below the
 * peek detent up to it. On a docked iPad column the sheet is beside the map, so
 * the ornament rests on the map area's own bottom — the same branch
 * `chromeRideFor` takes, and the same safe-area compensation applies there.
 */
export function compassBottom(
  settledHeightPx: number,
  snaps: number[],
  docked = false,
  safeBottom = 0,
): number {
  const fromWindowBottom = chromeRideFor(settledHeightPx, snaps, docked).offset + STACK_H + 8;
  return Math.max(0, fromWindowBottom - safeBottom);
}

/** Vertical footprint of one stacked bottom chip (chip height + gap). */
const CHIP_STACK_H = CONTROL_SIZE + 10;
/** Most chips that can stack at once in the RIGHT-INSET cluster: planner + ride
 *  + spotter. (The follow button is no longer one of them — it is a small red
 *  capsule on its own screen-centred layer; see `FollowButton`.) */
const MAX_STACKED_CHIPS = 3;
/**
 * ONE element height for everything inside a chip row — line badge (md),
 * delay pill (md), ✕ circle — so the pills read as a single consistent set
 * instead of differently-sized controls.
 */
const CHIP_ELEMENT_H = 30;
/**
 * The resume-follow button's height. Small on purpose: it is a single word
 * floating over the map above the sheet's edge, and at the chip cluster's 46 pt
 * it read as a fourth heavyweight chip rather than a quiet "tap to come back".
 * 32 keeps it inside Apple's compact-control band while `hitSlop` below still
 * gives it a 44 pt+ touch target.
 */
const FOLLOW_H = 32;

// ── Status tile (top-left): weather/AQI-style live-data glass square ─────────

/**
 * Live-status tile: 🚊 N (tram count) with a dot + label row ONLY when the
 * feed is non-nominal (STALE / OFFLINE / PAUSED). The poll-cycle countdown
 * ring and the tap-to-reveal "updated N s ago" disclosure were removed
 * (2026-08-08) — request timing is no longer surfaced anywhere in the UI; the
 * PollRing component survives unused in components/map/PollIndicator.tsx.
 * `usePollModel` still supplies the health classification the warning row
 * needs, at the same shared 1 Hz cadence (no timers, no animation).
 */
export function MapStatusTile({ leftInset }: { leftInset?: number }) {
  const insets = useSafeAreaInsets();
  const states = useAllTramStates(); // ~1 Hz
  const { scheme, text, secondary } = useTextColors();
  const poll = usePollModel(); // ~1 Hz, same subscription

  const status = statusLabel(poll.state);

  const topRow = (
    <>
      <SymbolView name="tram.fill" size={15} tintColor={liveryTint(scheme)} />
      <Text style={[styles.tileCount, { color: text }]} maxFontSizeMultiplier={TextScale.compact}>
        {states.length}
      </Text>
    </>
  );
  // Only non-nominal states get a status row — the healthy "LIVE" label was
  // removed (it read as redundant chrome over the tram count). STALE / OFFLINE /
  // PAUSED still surface as a dot + label so a broken feed is never silent.
  const bottomRow = status ? (
    <>
      <View style={[styles.tileDot, { backgroundColor: status.color }]} />
      <Text style={[styles.tileStatus, { color: secondary }]} maxFontSizeMultiplier={TextScale.chrome}>
        {status.label}
      </Text>
    </>
  ) : null;

  return (
    <View
      style={[
        styles.statusTileWrap,
        { top: insets.top + Spacing.two, left: leftInset ?? Spacing.three },
      ]}
    >
      <StatusTile
        appearance={scheme}
        // The count and any non-nominal status (STALE / OFFLINE / PAUSED) live
        // in the label so a broken feed is announced without any disclosure.
        label={`Live data: ${states.length} trams${status ? `, ${status.label.toLowerCase()}` : ''}`}
        topRow={topRow}
        bottomRow={bottomRow}
      />
    </View>
  );
}

function statusLabel(state: ReturnType<typeof usePollModel>['state']): {
  label: string;
  color: string;
} | null {
  switch (state) {
    case 'error':
      return { label: 'OFFLINE', color: Tram.veryLate };
    case 'stale':
      return { label: 'STALE', color: Tram.late };
    case 'off':
      return { label: 'PAUSED', color: '#8E8E93' };
    default:
      // Nominal live feed: no label (the "LIVE" pill was intentionally removed).
      return null;
  }
}

// ── Right control stack: 2D/3D circle + fused layers/locate capsule ──────────

/**
 * Everything the chrome needs to ride WITH the home sheet. `sheetHeight` is the
 * sheet's live px height, written by its pan worklet every frame — the chrome
 * reads it in a `useAnimatedStyle` so it tracks the drag continuously instead of
 * springing to a new offset after the drag settles (the reported "buttons jump
 * to the sheet once the menu is already open").
 */
export interface ChromeRideProps {
  /** LIVE sheet height (px), updated on the UI thread every frame of the drag. */
  sheetHeight: SharedValue<number>;
  /** The sheet's snap table (px, ascending) — peek / medium / large. */
  sheetSnaps: number[];
  /** True when the sheet is a docked iPad column: the chrome never rides. */
  sheetDocked: boolean;
}

/**
 * Shared UI-thread style for both chrome clusters: sit exactly CHROME_GAP above
 * the sheet's LIVE top edge, and park there once the sheet passes its medium
 * detent — from then on the rising sheet simply covers them (never a fade; the
 * clusters are glass, see below). `chromeRideFor` is the same pure, unit-tested
 * worklet the layout module exports. The offset is absolute (measured from the window bottom) rather than
 * a shift from a resting position, so the chrome cannot drift out of sync when
 * the sheet's header — and therefore its peek height — changes.
 */
type ChromeRideStyle = ReturnType<typeof useAnimatedStyle<ViewStyle>>;

function useChromeRide({
  sheetHeight,
  sheetSnaps,
  sheetDocked,
}: ChromeRideProps): ChromeRideStyle {
  return useAnimatedStyle<ViewStyle>(() => {
    const ride = chromeRideFor(sheetHeight.value, sheetSnaps, sheetDocked);
    return {
      // TRANSLATION ONLY — no `opacity`, ever. Every child of both clusters is a
      // GlassPanel (native UIVisualEffectView / UIGlassEffect), and UIKit leaves
      // the effect undefined at ANY alpha below 1 on the view or an ancestor; an
      // animated round trip through fractional alpha loses the material for
      // good, which is what "the controls came back as flat rectangles after the
      // sheet was opened and closed" is. The previous code floored the fade at
      // 0.01 on the narrower expo-glass-effect wording (only alpha == 0 stops
      // rendering) — but 0.01 is still < 1, so it dodged nothing.
      //
      // Nothing is lost by dropping the fade: past the medium detent the chrome
      // PARKS (see `chromeRideFor`) while the sheet keeps growing straight over
      // it, and the sheet — with its scrim, which covers the chrome too, since
      // both clusters render below the sheet on the map screen — is what makes
      // it disappear. At the large detent it is fully behind an edge-to-edge,
      // opaque card. Occlusion instead of alpha, the same trade `MapSheet` makes
      // for the card itself and for its action pill.
      transform: [{ translateY: -ride.offset }],
    };
    // `sheetHeight` IS a dependency here, unusually for a shared value: the map
    // screen swaps which sheet's shared value it hands us when the tram card is
    // presented or closed. Without it in the list the worklet keeps the shared
    // value it captured on first render and the chrome rides the WRONG (hidden)
    // sheet — parked at the home sheet's peek while the tram card moves.
  }, [sheetHeight, sheetSnaps, sheetDocked]);
}

export interface ControlStackProps extends ChromeRideProps {
  is3D: boolean;
  onTogglePitch: () => void;
  onLocate: () => void;
  /**
   * True while the camera is centred on the user — the locate button's tracking
   * state (Apple Maps' filled-vs-outline location button). Cleared by the map
   * screen inside its existing once-per-gesture camera branch.
   */
  locating?: boolean;
}

export function MapControlStack({
  is3D,
  onTogglePitch,
  onLocate,
  locating,
  ...ride
}: ControlStackProps) {
  const { scheme } = useTextColors();
  const [layersOpen, setLayersOpen] = useState(false);
  const rideStyle = useChromeRide(ride);

  return (
    <>
      <KitControlStack bottom={0} right={CONTROL_RIGHT} animatedStyle={rideStyle}>
        <CircleControl
          symbol={is3D ? 'view.2d' : 'view.3d'}
          label={is3D ? 'Switch to 2D map' : 'Switch to 3D map'}
          appearance={scheme}
          onPress={() => {
            tapLight();
            onTogglePitch();
          }}
        />
        <ControlCapsule appearance={scheme}>
          <CircleControl
            symbol="map.fill"
            label="Map settings"
            appearance={scheme}
            // `expanded`, not `active`: the open menu is anchored to this button
            // so the state is already visible, and `active` (the blue fill) is
            // the locate button's tracking state.
            expanded={layersOpen}
            onPress={() => {
              tapLight();
              setLayersOpen((o) => !o);
            }}
          />
          <CircleControl
            symbol="location.fill"
            label="Show my location"
            appearance={scheme}
            active={locating}
            onPress={() => {
              tapLight();
              onLocate();
            }}
          />
        </ControlCapsule>
      </KitControlStack>
      {layersOpen && (
        <LayersMenu scheme={scheme} rideStyle={rideStyle} onClose={() => setLayersOpen(false)} />
      )}
    </>
  );
}

// ── Layers quick-menu: light preset + route-lines toggle (settings-store) ────

const LIGHT_PRESETS: { key: LightPreset; label: string; symbol: SFSymbol }[] = [
  { key: 'auto', label: 'Automatic', symbol: 'circle.lefthalf.filled' },
  { key: 'day', label: 'Day', symbol: 'sun.max.fill' },
  { key: 'dusk', label: 'Dusk', symbol: 'sunset.fill' },
  { key: 'night', label: 'Night', symbol: 'moon.stars.fill' },
];

function LayersMenu({
  scheme,
  rideStyle,
  onClose,
}: {
  scheme: ChromeScheme;
  /** The SAME ride transform as the control column, so the menu stays anchored
   *  to it while the sheet is dragged. */
  rideStyle: ChromeRideStyle;
  onClose: () => void;
}) {
  const palette = Colors[scheme];
  const c = appleScheme(scheme);
  const preset = useSettingsStore((s) => s.lightPreset);
  const setPreset = useSettingsStore((s) => s.setLightPreset);
  const showLines = useSettingsStore((s) => s.showRouteLines);
  const setShowLines = useSettingsStore((s) => s.setShowRouteLines);
  const sep = c.separator;

  return (
    // A popover is modal in its interaction: without this VoiceOver swipes
    // straight past the menu into the status tile, the control column and the
    // chips that are still on screen behind it.
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
    >
      {/* Tap-outside dismissal for sighted users only — as an accessibility
          element it was a screen-sized "Close map settings" button sitting ahead
          of the menu's own rows. VoiceOver dismisses with the escape gesture. */}
      <Pressable
        accessible={false}
        accessibilityElementsHidden
        style={StyleSheet.absoluteFill}
        onPress={onClose}
      />
      <Animated.View style={[styles.layersAnchor, { bottom: STACK_H + 10 }, rideStyle]}>
        {/* Scale out of the button that opened it (a menu is anchored to its
            source, it does not pop in). ZoomIn/ZoomOut animate transform only —
            an opacity fade would kill the panel's glass (expo-glass-effect). */}
        <Animated.View
          style={styles.layersOrigin}
          entering={ZoomIn.duration(180).reduceMotion(ReduceMotion.System)}
          exiting={ZoomOut.duration(140).reduceMotion(ReduceMotion.System)}
        >
          <GlassPanel
            variant="regular"
            readableOverContent
            appearance={scheme}
            style={styles.layersPanel}
          >
            <Text style={[styles.layersLabel, { color: palette.textSecondary }]}>MAP LIGHTING</Text>
            {LIGHT_PRESETS.map((p) => (
              <Pressable
                key={p.key}
                accessibilityRole="button"
                accessibilityLabel={p.label}
                accessibilityState={{ selected: preset === p.key }}
                style={({ pressed }) => [styles.layersRow, pressed && styles.layersRowPressed]}
                onPress={() => {
                  tapLight();
                  setPreset(p.key);
                }}
              >
                <SymbolView name={p.symbol} size={18} tintColor={palette.text} />
                <Text
                  style={[styles.layersRowText, { color: palette.text }]}
                  maxFontSizeMultiplier={TextScale.compact}
                >
                  {p.label}
                </Text>
                {preset === p.key && (
                  <SymbolView name="checkmark" size={15} weight="semibold" tintColor={c.blue} />
                )}
              </Pressable>
            ))}
            <View style={[styles.layersSep, { backgroundColor: sep }]} />
            {/* The whole row toggles, like every iOS settings row — the 51×31
                switch was the only hit target, and unlabeled to VoiceOver. */}
            <Pressable
              accessibilityRole="switch"
              accessibilityLabel="Route lines"
              accessibilityState={{ checked: showLines }}
              style={({ pressed }) => [styles.layersRow, pressed && styles.layersRowPressed]}
              onPress={() => {
                tapLight();
                setShowLines(!showLines);
              }}
            >
              <SymbolView
                name="point.topleft.down.to.point.bottomright.curvepath"
                size={18}
                tintColor={palette.text}
              />
              <Text
                style={[styles.layersRowText, { color: palette.text }]}
                maxFontSizeMultiplier={TextScale.compact}
              >
                Route lines
              </Text>
              <Switch
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                value={showLines}
                onValueChange={(v) => {
                  tapLight();
                  setShowLines(v);
                }}
              />
            </Pressable>
          </GlassPanel>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// ── Bottom chips — follow / spotter / ride / planner riding above the sheet ──
//
// All are glass chips inside one container anchored just above the home sheet's
// peek edge — the SAME low band as the bottom-right control column, inset to its
// left so they never overlap it. The container translates up per detent on the
// UI thread (zero per-frame React — docs/performance.md invariant #1), so the
// chips always sit just above whatever detent the sheet has settled on. Within
// the container the planner chip owns the base row, ride stacks above it,
// spotter above that, and follow floats on top.

export interface MapChipsProps extends ChromeRideProps {
  /** Left edge of the map area — clears the docked sheet column on iPad. */
  leftInset?: number;
}

export function MapChips({ leftInset, ...ride }: MapChipsProps) {
  // Contextual chips (follow / spotter / ride / planner) rest on the SAME low
  // band as the bottom-right control column — just above the peek search bar
  // (Apple Maps) — and ride UP with the home sheet CONTINUOUSLY as it is
  // dragged, fading out as it reaches the large detent. They do NOT stack above
  // the control column: the cluster is horizontally inset from the right edge
  // (CHIPS_RIGHT_INSET reserves the column's width + a gap), so the full-width
  // follow pill sits to the LEFT of the 2D/layers/locate column with no overlap.
  // Anchoring it above the column instead (the old +STACK_H) floated a lone chip
  // at mid-screen while the sheet was at peek — the reported bug.
  const rideStyle = useChromeRide(ride);
  return (
    <>
      {/* The resume-follow button gets a layer of its own, spanning the whole
          map area rather than the cluster's right-inset column, because it is
          CENTRED over the sheet's edge rather than aligned with the chips. Same
          ride transform, so it travels with them frame for frame. */}
      <Animated.View
        pointerEvents="box-none"
        // This layer exists to CENTRE its child, so on a phone it must span the
        // WHOLE window: `leftInset` there is the chips' cosmetic 16 pt gutter,
        // and pairing it with a flush right edge put the button's centre at 209
        // instead of the window's 201 (measured, both). On a DOCKED iPad the same
        // prop is the map area's real left edge, which is exactly what centring
        // over the map wants — hence the split rather than a flat 0.
        style={[
          styles.followWrap,
          { left: ride.sheetDocked ? (leftInset ?? 0) : 0 },
          rideStyle,
        ]}
      >
        <FollowButton />
      </Animated.View>
      <Animated.View
        pointerEvents="box-none"
        style={[styles.chipsWrap, { left: leftInset ?? Spacing.three }, rideStyle]}
      >
        <View pointerEvents="box-none" style={styles.chipsRow}>
          {/* Order matters: the LAST-listed chip owns the base row and the ones
              before it stack upward. */}
          <SpotterChip />
          <RideChip />
          <PlannerChip />
        </View>
      </Animated.View>
    </>
  );
}

/**
 * Shared ✕ for all chips: a 30 pt tinted circle — the SAME element height as
 * the other chip pills (line badge md, delay pill md, follow button) so the
 * row reads as one set — inside a 34 pt touch box (+ hitSlop → ~46 pt target).
 */
function ChipClose({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = useTextColors();
  const bg = colors.scheme === 'dark' ? 'rgba(120,120,128,0.32)' : 'rgba(120,120,128,0.18)';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={styles.chipClose}
      onPress={() => {
        tapLight();
        onPress();
      }}
    >
      {({ pressed }) => (
        <View
          style={[styles.chipCloseCircle, { backgroundColor: bg, opacity: pressed ? 0.65 : 1 }]}
        >
          <SymbolView name="xmark" size={13} weight="semibold" tintColor={colors.secondary} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * RESUME FOLLOW. Shown ONLY when a follow is active AND paused — i.e. the user
 * grabbed the map, so the camera is theirs and the tram has drifted off. Tapping
 * hands the camera back to the follow loop, which eases the tram back to centre
 * under the user's CURRENT zoom/pitch/heading; the button then disappears
 * because the condition that summoned it is gone.
 *
 * It floats over the map rather than living on a sheet on purpose: it rides the
 * ACTIVE sheet's live height on the UI thread, so it sits just above whichever
 * surface is on screen — the tram card at any detent, or the home sheet — and
 * travels with it frame by frame. An earlier pass put the resume control inside
 * the home sheet's header, which meant it only existed while that header was a
 * follow bar; it vanished the moment the tram card was open, which is precisely
 * when a paused follow is most likely.
 *
 * ── WHY IT IS ONE SMALL RED WORD ────────────────────────────────────────────
 * It used to be a full-width glass chip: an icon, "Resume follow", a line·reg
 * detail and a ✕ that ended the follow. That is four controls' worth of surface
 * for one binary act, sitting over the map, and it read as heavier than the
 * sheet it floated above. Now it is a compact accent-red capsule with the single
 * word `Follow` — red because that is the app's livery accent and this is the
 * one map control that is a call to action rather than a state readout, and with
 * NO ✕ because ending the follow is the tram card's Follow toggle's job, not a
 * secondary control on a transient button.
 *
 * The red is the FILL, so it takes `Tram.liveryRed` / `Tram.pidRed` directly
 * rather than `liveryTint`'s lightened glyph red — that lift exists to clear the
 * 3:1 contrast floor for a thin glyph ON dark glass, and would read as pink on a
 * solid button. White on liveryRed is 5.9:1, white on pidRed 11:1.
 */
function FollowButton() {
  const followKey = useSelectionStore((s) => s.followTramKey);
  const paused = useSelectionStore((s) => s.followPaused);
  const state = useTramState(followKey); // ~1 Hz, same subscription as the map
  const spotterActive = useSpotterStore((s) => s.station != null);
  const plannerActive = usePlannerStore((s) => s.itinerary != null);
  const rideActive = useRidePreviewStore((s) => s.preview != null);
  const scheme = useChromeScheme();
  if (!followKey || !paused) return null;

  // The label the BUTTON shows is one word; the label VoiceOver hears still
  // names the tram, which is the only place that identity is now surfaced.
  const reg = state?.snapshot.registrationNumber;
  const spoken = state
    ? `Line ${state.snapshot.line}${reg != null ? ` · #${reg}` : ''}`
    : 'the followed tram';
  // Sits above whatever chips are up, in the same stacking order as before.
  const marginBottom =
    (plannerActive ? CHIP_STACK_H : 0) +
    (rideActive ? CHIP_STACK_H : 0) +
    (spotterActive ? CHIP_STACK_H : 0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Return to following ${spoken}`}
      hitSlop={10}
      onPress={() => {
        tapLight();
        useSelectionStore.getState().setFollowPaused(false);
      }}
      style={({ pressed }) => [
        styles.followButton,
        {
          marginBottom,
          backgroundColor: scheme === 'dark' ? Tram.liveryRed : Tram.pidRed,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text
        style={styles.followLabel}
        numberOfLines={1}
        maxFontSizeMultiplier={TextScale.compact}
      >
        Follow
      </Text>
    </Pressable>
  );
}

/**
 * Shown while stop-spotting is active (SpotterController drives the follow
 * camera through the trams arriving at the spotted stop). Body reopens the
 * stop sheet (planner-chip pattern); the ✕ ends spotting AND the follow it
 * drives. While nobody is inbound the chip stays up with a waiting hint.
 */
function SpotterChip() {
  const station = useSpotterStore((s) => s.station);
  const target = useSpotterStore((s) => s.target); // ~1 Hz while ETA changes
  const plannerActive = usePlannerStore((s) => s.itinerary != null);
  const rideActive = useRidePreviewStore((s) => s.preview != null);
  const colors = useTextColors();
  if (!station) return null;

  const detail = target
    ? `line ${target.line} · ${formatEtaMinutes(target.etaS)}`
    : 'waiting for next tram';
  const bottom = (plannerActive ? CHIP_STACK_H : 0) + (rideActive ? CHIP_STACK_H : 0);
  return (
    <View style={[styles.chipSlot, { bottom }]}>
      <GlassPanel
        variant="regular"
        interactive
        readableOverContent
        appearance={colors.scheme}
        style={styles.chip}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Spotting ${station.name}, ${detail}. Reopen stop details`}
          style={styles.chipBody}
          onPress={() => {
            tapLight();
            router.push(('/stop/' + encodeURIComponent(station.key)) as Href);
          }}
        >
          <SymbolView name="binoculars.fill" size={15} tintColor={liveryTint(colors.scheme)} />
          <Text
            style={[styles.chipLabel, { color: colors.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.compact}
          >
            Spotting {station.name}
          </Text>
          <Text
            style={[styles.spotterDetail, { color: colors.secondary }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.chrome}
          >
            {detail}
          </Text>
          <SymbolView name="chevron.up" size={12} tintColor={colors.secondary} />
        </Pressable>
        <ChipClose
          label="Stop spotting"
          onPress={() => {
            // Order matters: stop() unmounts the controller first, then the
            // follow it was driving is released.
            useSpotterStore.getState().stop();
            useSelectionStore.getState().setFollowTramKey(null);
          }}
        />
      </GlassPanel>
    </View>
  );
}

/**
 * Shown while a recorded ride is previewed on the map (RideOverlay). Tapping
 * the chip body reopens the rides sheet; the ✕ clears the preview. Stacks one
 * slot above the planner chip when both are active.
 */
function RideChip() {
  const preview = useRidePreviewStore((s) => s.preview);
  const plannerActive = usePlannerStore((s) => s.itinerary != null);
  const colors = useTextColors();
  if (!preview) return null;

  const { ride } = preview;
  const label = [
    ride.line ? `Line ${ride.line}` : null,
    ride.tramKey ? `#${ride.tramKey}` : null,
    ride.startedMs != null
      ? new Date(ride.startedMs).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const bottom = plannerActive ? CHIP_STACK_H : 0;
  return (
    <View style={[styles.chipSlot, { bottom }]}>
      <GlassPanel
        variant="regular"
        interactive
        readableOverContent
        appearance={colors.scheme}
        style={styles.chip}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reopen recorded rides"
          style={styles.chipBody}
          onPress={() => {
            tapLight();
            router.push('/rides' as Href);
          }}
        >
          <SymbolView name="record.circle" size={15} tintColor={Tram.veryLate} />
          <Text
            style={[styles.chipLabel, { color: colors.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {label || 'Recorded ride'}
          </Text>
          <SymbolView name="chevron.up" size={12} tintColor={colors.secondary} />
        </Pressable>
        <ChipClose
          label="Hide ride preview"
          onPress={() => useRidePreviewStore.getState().setPreview(null)}
        />
      </GlassPanel>
    </View>
  );
}

/**
 * Shown whenever a planned route is drawn on the map. Tapping the chip body
 * REOPENS the planner sheet (with the active itinerary — users kept losing the
 * sheet with no way back); the ✕ clears the route.
 */
function PlannerChip() {
  const itinerary = usePlannerStore((s) => s.itinerary);
  const colors = useTextColors();
  if (!itinerary) return null;

  const legs = itinerary.legs;
  const from = legs[0]?.fromStopName ?? '';
  const to = legs[legs.length - 1]?.toStopName ?? '';
  const label = from && to ? `${from} → ${to}` : 'Planned route';

  return (
    <View style={[styles.chipSlot, { bottom: 0 }]}>
      <GlassPanel
        variant="regular"
        interactive
        readableOverContent
        appearance={colors.scheme}
        style={styles.chip}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reopen trip planner"
          style={styles.chipBody}
          onPress={() => {
            tapLight();
            router.push('/planner');
          }}
        >
          <SymbolView name="arrow.triangle.swap" size={15} tintColor={Tram.gold} />
          <Text
            style={[styles.chipLabel, { color: colors.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {label}
          </Text>
          <SymbolView name="chevron.up" size={12} tintColor={colors.secondary} />
        </Pressable>
        <ChipClose
          label="Clear planned route"
          onPress={() => usePlannerStore.getState().setItinerary(null)}
        />
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Status tile ──
  statusTileWrap: { position: 'absolute' },
  tileCount: {
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    fontFamily: Fonts?.rounded,
  },
  tileDot: { width: 7, height: 7, borderRadius: 3.5 },
  tileStatus: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  // ── Layers quick-menu ──
  layersAnchor: { position: 'absolute', right: CONTROL_RIGHT },
  /** Scales out of the map button below it, not out of its own centre. */
  layersOrigin: { transformOrigin: 'bottom right' },
  layersPanel: {
    minWidth: 232,
    paddingVertical: 8,
    borderRadius: Radii.group,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  layersLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 6,
  },
  layersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 42,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  layersRowPressed: { opacity: 0.55 },
  layersRowText: { flex: 1, fontSize: 16, fontWeight: '400' },
  layersSep: { height: StyleSheet.hairlineWidth, marginVertical: 4, marginLeft: 16 },

  // ── Bottom chips ──
  // Same horizontal language as the sheet (left/right Spacing.three, 560 pt cap
  // centered on iPad). The row is tall enough to CONTAIN the full upward chip
  // stack — iOS hit-testing is bounds-limited, so chips rendered outside the
  // row would be visible but untappable.
  chipsWrap: {
    position: 'absolute',
    bottom: 0,
    right: CHIPS_RIGHT_INSET,
    alignItems: 'center',
  },
  // The follow button's own layer: the FULL map width (not the cluster's
  // right-inset column) so `alignItems: 'center'` centres it over the sheet
  // rather than over the gap left of the control stack. Bottom-anchored with no
  // height of its own — the button's `marginBottom` is what lifts it clear of
  // any chips that are up. box-none, so only the capsule itself takes touches
  // and the map keeps the rest of the band.
  followWrap: { position: 'absolute', bottom: 0, right: 0, alignItems: 'center' },
  followButton: {
    height: FOLLOW_H,
    // A true capsule: r = h/2, and no `borderCurve` (sheetLook.ts — continuous
    // curvature on a stadium renders a lopsided squircle).
    borderRadius: FOLLOW_H / 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  followLabel: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  chipsRow: {
    width: '100%',
    maxWidth: 560,
    height: CONTROL_SIZE + (MAX_STACKED_CHIPS - 1) * CHIP_STACK_H,
  },
  chipSlot: { position: 'absolute', left: 0, right: 0 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    // minHeight, not height: the labels scale with Dynamic Type (capped) and a
    // fixed box would clip them.
    minHeight: CONTROL_SIZE,
    gap: Spacing.two,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 999,
  },
  chipBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  chipClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  chipCloseCircle: {
    width: CHIP_ELEMENT_H,
    height: CHIP_ELEMENT_H,
    borderRadius: CHIP_ELEMENT_H / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  spotterDetail: { fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'] },
});
