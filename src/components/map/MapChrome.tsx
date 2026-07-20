// Apple-Maps map chrome floating over the basemap: the weather/AQI-style live
// StatusTile (top-left), the right-edge control column (2D/3D circle + a fused
// layers/locate capsule with a light-preset / route-lines quick menu), and the
// bottom chip cluster (follow / spotter / ride / planner) that RIDES above the
// home sheet — translating with the sheet's heightSV on the UI thread.
//
// APPEARANCE: the chrome floats over the BASEMAP, not over app UI — so its
// light/dark styling follows the map's resolved light preset (day/dawn →
// light glass + dark labels, dusk/night → dark glass + light labels) via
// MapChromeSchemeContext, NOT the system color scheme. A dark-mode phone over
// a daytime map previously rendered white icons on white glass.

import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { createContext, useContext, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PollRing, usePollModel } from '@/components/map/PollIndicator';
import {
  CircleControl,
  ControlCapsule,
  ControlStack as KitControlStack,
  CONTROL_GAP,
  CONTROL_SIZE,
} from '@/components/maps-kit/CircleControl';
import { StatusTile } from '@/components/maps-kit/StatusTile';
import { DelayPill } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Apple, Colors, Fonts, Radii, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useTramState } from '@/hooks/tramData';
import { formatEtaMinutes } from '@/lib/arrivals';
import { usePlannerStore } from '@/stores/planner';
import { useRidePreviewStore } from '@/stores/ridePreview';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore, type LightPreset } from '@/stores/settings';
import { useSpotterStore } from '@/stores/spotter';

// ── Chrome appearance (follows the MAP light preset, not the system scheme) ──

export type ChromeScheme = 'light' | 'dark';

/** Provided by the map screen from the resolved basemap light preset. */
export const MapChromeSchemeContext = createContext<ChromeScheme>('light');

function useChromeScheme(): ChromeScheme {
  return useContext(MapChromeSchemeContext);
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
/**
 * Gap between the home sheet's peek top edge and the bottom-right control
 * column. Apple Maps pins its map controls bottom-right, just above the search
 * sheet — closer to the thumb than a top-right stack.
 */
export const CHROME_BOTTOM_GAP = 12;
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
 * it floats just above the bottom-right control column, on the same right axis.
 * The caller adds the peek-sheet height so the whole cluster rides above the
 * sheet.
 */
export function compassBottom(peekPx: number): number {
  return peekPx + CHROME_BOTTOM_GAP + STACK_H + 12;
}

/** Vertical footprint of one stacked bottom chip (chip height + gap). */
const CHIP_STACK_H = CONTROL_SIZE + 10;
/** Most chips that can stack at once: planner + ride + spotter + follow. */
const MAX_STACKED_CHIPS = 4;
/**
 * ONE element height for everything inside a chip row — line badge (md),
 * delay pill (md), follow/resume button, ✕ circle — so the pills read as a
 * single consistent set instead of four differently-sized controls.
 */
const CHIP_ELEMENT_H = 30;

// ── Status tile (top-left): weather/AQI-style live-data glass square ─────────

/**
 * The poll indicator and the status tile are ONE element: the 5-segment ring
 * counts down the 5 s positions poll (fills once per second at the shared
 * 1 Hz UI cadence — no timers or animations of its own, see PollIndicator),
 * recolors on stale/error, and tapping the tile toggles an inline "updated
 * N s ago" / offline detail so the information lives in a single surface.
 * Restyled as Apple Maps' rounded weather tile: 🚊 N over a LIVE ● dot row.
 */
export function MapStatusTile() {
  const insets = useSafeAreaInsets();
  const states = useAllTramStates(); // ~1 Hz
  const { scheme, text, secondary } = useTextColors();
  const poll = usePollModel(); // ~1 Hz, same subscription

  const dimColor = scheme === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)';
  const status = statusLabel(poll.state);

  const topRow = (
    <>
      <PollRing model={poll} color={text} dimColor={dimColor} size={20} />
      <SymbolView
        name="tram.fill"
        size={15}
        tintColor={scheme === 'dark' ? Tram.liveryRed : Tram.pidRed}
      />
      <Text style={[styles.tileCount, { color: text }]} allowFontScaling={false}>
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
      <Text style={[styles.tileStatus, { color: secondary }]} allowFontScaling={false}>
        {status.label}
      </Text>
    </>
  ) : null;

  return (
    <View style={[styles.statusTileWrap, { top: insets.top + Spacing.two }]}>
      <StatusTile
        appearance={scheme}
        label={`Live data: ${states.length} trams, ${poll.detail}`}
        topRow={topRow}
        bottomRow={bottomRow}
        expandedDetail={
          <Text style={[styles.tileDetail, { color: secondary }]} allowFontScaling={false}>
            {poll.detail}
          </Text>
        }
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

export interface ControlStackProps {
  is3D: boolean;
  onTogglePitch: () => void;
  onLocate: () => void;
  /** Peek-sheet height in px — the control column's static base sits just above it. */
  peekPx: number;
  /** Rides the column UP with the sheet (px). Driven per detent on the UI thread. */
  chromeShift: SharedValue<number>;
  /** Fades the column out when the sheet is fully open (large detent). */
  chromeOpacity: SharedValue<number>;
}

export function MapControlStack({
  is3D,
  onTogglePitch,
  onLocate,
  peekPx,
  chromeShift,
  chromeOpacity,
}: ControlStackProps) {
  const { scheme } = useTextColors();
  const [layersOpen, setLayersOpen] = useState(false);
  // The whole cluster rides with the home sheet: translate up per detent, fade
  // out at large. Pure UI-thread animation — no per-frame React.
  const rideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -chromeShift.value }],
    opacity: chromeOpacity.value,
  }));

  return (
    <>
      <KitControlStack bottom={peekPx + CHROME_BOTTOM_GAP} right={CONTROL_RIGHT} animatedStyle={rideStyle}>
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
            active={layersOpen}
            onPress={() => {
              tapLight();
              setLayersOpen((o) => !o);
            }}
          />
          <CircleControl
            symbol="location.fill"
            label="Show my location"
            appearance={scheme}
            onPress={() => {
              tapLight();
              onLocate();
            }}
          />
        </ControlCapsule>
      </KitControlStack>
      {layersOpen && (
        <LayersMenu scheme={scheme} peekPx={peekPx} onClose={() => setLayersOpen(false)} />
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
  peekPx,
  onClose,
}: {
  scheme: ChromeScheme;
  peekPx: number;
  onClose: () => void;
}) {
  const palette = Colors[scheme];
  const preset = useSettingsStore((s) => s.lightPreset);
  const setPreset = useSettingsStore((s) => s.setLightPreset);
  const showLines = useSettingsStore((s) => s.showRouteLines);
  const setShowLines = useSettingsStore((s) => s.setShowRouteLines);
  const sep = Apple.separator[scheme];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close map settings"
        style={StyleSheet.absoluteFill}
        onPress={onClose}
      />
      <View style={[styles.layersAnchor, { bottom: peekPx + CHROME_BOTTOM_GAP + STACK_H + 10 }]}>
        <GlassPanel variant="regular" appearance={scheme} style={styles.layersPanel}>
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
              <Text style={[styles.layersRowText, { color: palette.text }]} allowFontScaling={false}>
                {p.label}
              </Text>
              {preset === p.key && (
                <SymbolView name="checkmark" size={15} weight="semibold" tintColor={Apple.blue} />
              )}
            </Pressable>
          ))}
          <View style={[styles.layersSep, { backgroundColor: sep }]} />
          <View style={styles.layersRow}>
            <SymbolView name="point.topleft.down.to.point.bottomright.curvepath" size={18} tintColor={palette.text} />
            <Text style={[styles.layersRowText, { color: palette.text }]} allowFontScaling={false}>
              Route lines
            </Text>
            <Switch
              value={showLines}
              onValueChange={(v) => {
                tapLight();
                setShowLines(v);
              }}
            />
          </View>
        </GlassPanel>
      </View>
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

export interface MapChipsProps {
  /** Peek-sheet height in px — the chip cluster's static base rests above it. */
  peekPx: number;
  /** Rides the chip cluster UP with the sheet (px). Driven per detent on the UI thread. */
  chromeShift: SharedValue<number>;
  /** Fades the chips out when the sheet is fully open (large detent). */
  chromeOpacity: SharedValue<number>;
}

export function MapChips({ peekPx, chromeShift, chromeOpacity }: MapChipsProps) {
  // Contextual chips (follow / spotter / ride / planner) rest on the SAME low
  // band as the bottom-right control column — just above the peek search bar
  // (Apple Maps) — and ride UP with the home sheet as it opens (translateY per
  // detent), fading out once it reaches the large detent. They do NOT stack
  // above the control column: the cluster is horizontally inset from the right
  // edge (CHIPS_RIGHT_INSET reserves the column's width + a gap), so the
  // full-width follow pill sits to the LEFT of the 2D/layers/locate column with
  // no overlap. Anchoring it above the column instead (the old +STACK_H) floated
  // a lone chip at mid-screen while the sheet was at peek — the reported bug.
  const bottom = peekPx + CHROME_BOTTOM_GAP;
  const rideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -chromeShift.value }],
    opacity: chromeOpacity.value,
  }));
  return (
    <Animated.View pointerEvents="box-none" style={[styles.chipsWrap, { bottom }, rideStyle]}>
      <View pointerEvents="box-none" style={styles.chipsRow}>
        <FollowChip />
        <SpotterChip />
        <RideChip />
        <PlannerChip />
      </View>
    </Animated.View>
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

function FollowChip() {
  const followKey = useSelectionStore((s) => s.followTramKey);
  // Paused = the user grabbed the map; the camera is theirs and the chip body
  // becomes one big accent "Follow" button (re-centers under the user's
  // current zoom/pitch/heading). The ✕ always stops the follow entirely.
  const paused = useSelectionStore((s) => s.followPaused);
  // The tram sheet owns `selectedTramKey` for the whole time it is presented
  // (set on mount, cleared on unmount). When the sheet on screen is THIS tram's,
  // its compact mini-bar already shows the same badge·#reg·delay identity — a
  // FollowChip stacked right above it would duplicate that (and land two ✕'s
  // doing different things). Hide the chip while that tram's sheet is up.
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const state = useTramState(followKey);
  const plannerActive = usePlannerStore((s) => s.itinerary != null);
  const rideActive = useRidePreviewStore((s) => s.preview != null);
  const spotterActive = useSpotterStore((s) => s.station != null);
  const colors = useTextColors();
  if (!followKey || !state) return null;
  if (selectedKey === followKey) return null;

  // Float above the planner/ride/spotter chips when they are visible.
  const bottom =
    (plannerActive ? CHIP_STACK_H : 0) +
    (rideActive ? CHIP_STACK_H : 0) +
    (spotterActive ? CHIP_STACK_H : 0);
  const reg = state.snapshot.registrationNumber;
  const accent = colors.scheme === 'dark' ? Tram.liveryRed : Tram.pidRed;
  return (
    <View style={[styles.chipSlot, { bottom }]}>
      <GlassPanel variant="regular" interactive appearance={colors.scheme} style={styles.chip}>
        {/* The tram identity (line + reg + delay) stays visible in BOTH states;
            tapping it reopens the detail sheet. Only the trailing control
            changes: "Following ⌃" hint while locked, a compact accent "Follow"
            pill to re-center while paused — never a full-width button over the
            info. Every element shares the 30 pt pill height. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open tram ${reg ?? followKey} details`}
          style={styles.chipBody}
          onPress={() => {
            tapLight();
            useSelectionStore.getState().setSelectedTramKey(followKey);
            router.push(`/tram/${encodeURIComponent(followKey)}`);
          }}
        >
          <LineBadge line={state.snapshot.line} size="md" />
          {reg != null && (
            <Text style={[styles.followReg, { color: colors.text }]} allowFontScaling={false}>
              #{reg}
            </Text>
          )}
          <DelayPill delaySeconds={state.snapshot.delaySeconds} size="md" />
          <View style={styles.chipSpacer} />
          {!paused && (
            <>
              <Text style={[styles.followHint, { color: colors.secondary }]} allowFontScaling={false}>
                Following
              </Text>
              <SymbolView name="chevron.up" size={12} weight="semibold" tintColor={colors.secondary} />
            </>
          )}
        </Pressable>
        {paused && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Return to following tram ${reg ?? followKey}`}
            style={({ pressed }) => [
              styles.followResume,
              { backgroundColor: accent, opacity: pressed ? 0.82 : 1 },
            ]}
            onPress={() => {
              tapLight();
              useSelectionStore.getState().setFollowPaused(false);
            }}
          >
            <SymbolView name="location.viewfinder" size={14} tintColor="#FFFFFF" />
            <Text style={styles.followResumeLabel} allowFontScaling={false}>
              Follow
            </Text>
          </Pressable>
        )}
        <ChipClose
          label="Stop following"
          onPress={() => useSelectionStore.getState().setFollowTramKey(null)}
        />
      </GlassPanel>
    </View>
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
      <GlassPanel variant="regular" interactive appearance={colors.scheme} style={styles.chip}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Spotting ${station.name}, ${detail}. Reopen stop details`}
          style={styles.chipBody}
          onPress={() => {
            tapLight();
            router.push(('/stop/' + encodeURIComponent(station.key)) as Href);
          }}
        >
          <SymbolView
            name="binoculars.fill"
            size={15}
            tintColor={colors.scheme === 'dark' ? Tram.liveryRed : Tram.pidRed}
          />
          <Text
            style={[styles.chipLabel, { color: colors.text }]}
            numberOfLines={1}
            allowFontScaling={false}
          >
            Spotting {station.name}
          </Text>
          <Text
            style={[styles.spotterDetail, { color: colors.secondary }]}
            numberOfLines={1}
            allowFontScaling={false}
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
      <GlassPanel variant="regular" interactive appearance={colors.scheme} style={styles.chip}>
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
            allowFontScaling={false}
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
      <GlassPanel variant="regular" interactive appearance={colors.scheme} style={styles.chip}>
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
            allowFontScaling={false}
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
  statusTileWrap: { position: 'absolute', left: Spacing.three },
  tileCount: {
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    fontFamily: Fonts?.rounded,
  },
  tileDot: { width: 7, height: 7, borderRadius: 3.5 },
  tileStatus: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  tileDetail: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },

  // ── Layers quick-menu ──
  layersAnchor: { position: 'absolute', right: CONTROL_RIGHT },
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
    left: Spacing.three,
    right: CHIPS_RIGHT_INSET,
    alignItems: 'center',
  },
  chipsRow: {
    width: '100%',
    maxWidth: 560,
    height: CONTROL_SIZE + (MAX_STACKED_CHIPS - 1) * CHIP_STACK_H,
  },
  chipSlot: { position: 'absolute', left: 0, right: 0 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    height: CONTROL_SIZE,
    gap: Spacing.two,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 999,
  },
  chipBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  chipSpacer: { flex: 1 },
  chipClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  chipCloseCircle: {
    width: CHIP_ELEMENT_H,
    height: CHIP_ELEMENT_H,
    borderRadius: CHIP_ELEMENT_H / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  followReg: {
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    fontFamily: Fonts?.rounded,
  },
  followHint: { fontSize: 15, fontWeight: '600' },
  followResume: {
    height: CHIP_ELEMENT_H,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  followResumeLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily: Fonts?.rounded,
  },
  chipLabel: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  spotterDetail: { fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'] },
});
