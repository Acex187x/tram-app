// Liquid Glass chrome floating over the map: status chip (poll ring + live
// count + sync detail), top-right control stack (2D/3D · settings), the bottom
// dock (search + favorites + planner), and the bottom cluster — locate button
// plus the follow/spotter/ride/planner chips sharing one row above the dock.
// All surfaces are GlassPanel over the map.
//
// APPEARANCE: the chrome floats over the BASEMAP, not over app UI — so its
// light/dark styling follows the map's resolved light preset (day/dawn →
// light glass + dark labels, dusk/night → dark glass + light labels) via
// MapChromeSchemeContext, NOT the system color scheme. A dark-mode phone over
// a daytime map previously rendered white icons on white glass.

import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { createContext, useContext, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PollRing, usePollModel } from '@/components/map/PollIndicator';
import { DelayPill } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Fonts, Spacing, Tram } from '@/constants/theme';
import { useAllTramStates, useTramState } from '@/hooks/tramData';
import { formatEtaMinutes } from '@/lib/arrivals';
import { usePlannerStore } from '@/stores/planner';
import { useRidePreviewStore } from '@/stores/ridePreview';
import { useSelectionStore } from '@/stores/selection';
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

const CONTROL_BUTTON_SIZE = 46;
const CONTROL_GAP = Spacing.two + 2;
/** Right inset of the control column — one shared vertical axis for all round buttons. */
const CONTROL_RIGHT = Spacing.two + 4;
const TOP_STACK_BUTTONS = 2; // 2D/3D · settings
/**
 * Mapbox compass ornament slot: directly below the top-right control stack,
 * on the same right axis. NOTE: rnmapbox ornament offsets are already
 * safe-area-relative on iOS — do NOT add insets.top here (adding it double
 * counted the inset and stranded the compass mid-screen).
 */
export const COMPASS_TOP =
  Spacing.two + TOP_STACK_BUTTONS * CONTROL_BUTTON_SIZE + (TOP_STACK_BUTTONS - 1) * CONTROL_GAP + 12;
/** The native compass is ~44 pt wide; +1 centers it on the 46 pt button axis. */
export const COMPASS_RIGHT = CONTROL_RIGHT + 1;

/** Bottom dock footprint (38 pt search field + vertical padding). */
const DOCK_H = 54;
/** Bottom-cluster row slot: floating just above the dock. */
const LOCATE_BOTTOM = Spacing.three + DOCK_H + 12;
/** Vertical footprint of one stacked bottom chip (chip height + gap). */
const CHIP_STACK_H = CONTROL_BUTTON_SIZE + 10;
/** Gap between a chip's right edge and the locate button in the base row. */
const CHIP_ROW_GAP = 10;
/** Most chips that can stack at once: planner + ride + spotter + follow. */
const MAX_STACKED_CHIPS = 4;
/**
 * ONE element height for everything inside a chip row — line badge (md),
 * delay pill (md), follow/resume button, ✕ circle — so the pills read as a
 * single consistent set instead of four differently-sized controls.
 */
const CHIP_ELEMENT_H = 30;

// ── Status chip (top-left): poll ring + live tram count + sync detail ────────

/**
 * The poll indicator and the status chip are ONE element: the 5-segment ring
 * counts down the 5 s positions poll (fills once per second at the shared
 * 1 Hz UI cadence — no timers or animations of its own, see PollIndicator),
 * recolors on stale/error, and tapping the chip toggles an inline "updated
 * N s ago" / offline detail so the information lives in a single surface.
 */
export function StatusChip() {
  const insets = useSafeAreaInsets();
  const states = useAllTramStates(); // ~1 Hz
  const colors = useTextColors();
  const poll = usePollModel(); // ~1 Hz, same subscription
  const [expanded, setExpanded] = useState(false);

  const trouble = poll.state === 'error' || poll.state === 'stale';
  const dimColor = colors.scheme === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)';

  return (
    <View style={[styles.statusChipWrap, { top: insets.top + Spacing.two }]}>
      <GlassPanel
        variant="regular"
        interactive
        appearance={colors.scheme}
        style={styles.statusChip}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Live data: ${states.length} trams, ${poll.detail}`}
          accessibilityHint="Shows when tram positions were last updated"
          hitSlop={6}
          style={styles.statusBody}
          onPress={() => {
            tapLight();
            setExpanded((e) => !e);
          }}
        >
          <PollRing model={poll} color={colors.text} dimColor={dimColor} />
          <SymbolView
            name="tram.fill"
            size={14}
            tintColor={colors.scheme === 'dark' ? Tram.liveryRed : Tram.pidRed}
          />
          <Text style={[styles.statusText, { color: colors.text }]} allowFontScaling={false}>
            {states.length}
          </Text>
          {trouble && (
            <SymbolView
              name="wifi.exclamationmark"
              size={14}
              tintColor={poll.state === 'error' ? Tram.veryLate : Tram.late}
            />
          )}
          {(expanded || trouble) && (
            <Text
              style={[
                styles.statusDetail,
                {
                  color: trouble
                    ? poll.state === 'error'
                      ? Tram.veryLate
                      : Tram.late
                    : colors.secondary,
                },
              ]}
              allowFontScaling={false}
            >
              {poll.detail}
            </Text>
          )}
        </Pressable>
      </GlassPanel>
    </View>
  );
}

// ── Round glass control button (shared by the stacks + locate) ───────────────

function ControlButton({
  symbol,
  label,
  onPress,
}: {
  symbol: Parameters<typeof SymbolView>[0]['name'];
  label: string;
  onPress: () => void;
}) {
  const colors = useTextColors();
  return (
    <GlassPanel
      variant="regular"
      interactive
      appearance={colors.scheme}
      style={styles.controlButton}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={6}
        style={styles.controlPressable}
        onPress={() => {
          tapLight();
          onPress();
        }}
      >
        <SymbolView name={symbol} size={19} tintColor={colors.text} />
      </Pressable>
    </GlassPanel>
  );
}

// ── Control stack (top-right): 2D/3D · settings ──────────────────────────────

export interface ControlStackProps {
  is3D: boolean;
  onTogglePitch: () => void;
}

export function ControlStack({ is3D, onTogglePitch }: ControlStackProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.controlStack, { top: insets.top + Spacing.two }]}>
      <ControlButton
        symbol={is3D ? 'view.2d' : 'view.3d'}
        label={is3D ? 'Switch to 2D map' : 'Switch to 3D map'}
        onPress={onTogglePitch}
      />
      <ControlButton
        symbol="gearshape.fill"
        label="Settings"
        onPress={() => router.push('/settings' as Href)}
      />
    </View>
  );
}

// ── Bottom cluster: [ chip … ][locate] row + chips stacking upward ───────────
//
// One centered wrap using the SAME horizontal language as the dock below it
// (left/right Spacing.three, width capped at 560 pt on iPad) so the row reads
// as part of the dock family: the locate button is the right end of the row
// (its right edge flush with the dock/search field), and the base chip
// stretches from the dock's left edge all the way to the button. Additional
// chips stack upward at the same full width. `box-none` keeps the transparent
// stacking area gesture-transparent for the map.

export function BottomCluster({ onLocate }: { onLocate: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={[styles.clusterWrap, { bottom: insets.bottom + LOCATE_BOTTOM }]}
    >
      <View pointerEvents="box-none" style={styles.clusterRow}>
        <FollowChip />
        <SpotterChip />
        <RideChip />
        <PlannerChip />
        <View style={styles.locateSlot}>
          <ControlButton symbol="location" label="Show my location" onPress={onLocate} />
        </View>
      </View>
    </View>
  );
}

// ── Bottom dock: search pill + favorites + planner ───────────────────────────

export function BottomDock() {
  const insets = useSafeAreaInsets();
  const colors = useTextColors();
  const fieldBg =
    colors.scheme === 'dark' ? 'rgba(120,120,128,0.22)' : 'rgba(120,120,128,0.16)';

  return (
    <View style={[styles.dockWrap, { bottom: insets.bottom + Spacing.three }]}>
      <GlassPanel variant="regular" appearance={colors.scheme} style={styles.dock}>
        <Pressable
          accessibilityRole="search"
          style={[styles.searchField, { backgroundColor: fieldBg }]}
          onPress={() => {
            tapLight();
            router.push('/search');
          }}
        >
          <SymbolView name="magnifyingglass" size={15} tintColor={colors.secondary} />
          <Text
            style={[styles.searchPlaceholder, { color: colors.secondary }]}
            numberOfLines={1}
            allowFontScaling={false}
          >
            Lines, trams, stops
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Favorites"
          hitSlop={6}
          style={styles.dockButton}
          onPress={() => {
            tapLight();
            router.push('/favorites');
          }}
        >
          <SymbolView name="star.fill" size={19} tintColor={Tram.gold} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Trip planner"
          hitSlop={6}
          style={styles.dockButton}
          onPress={() => {
            tapLight();
            router.push('/planner');
          }}
        >
          <SymbolView name="arrow.triangle.swap" size={19} tintColor={colors.text} />
        </Pressable>
      </GlassPanel>
    </View>
  );
}

// ── Bottom chips: follow + spotter + planner-route clear + ride preview ──────
//
// All are full-width glass chips inside the BottomCluster row (same height as
// the locate button), stretching from the dock's left edge to the locate
// button: `[ chip ……………… ][locate]`. The planner chip owns the base row, the
// ride-preview chip stacks above it, the spotter chip above that, and the
// follow chip floats on top of whichever are visible (each +CHIP_STACK_H,
// relative to the cluster row's bottom).

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
          style={[
            styles.chipCloseCircle,
            { backgroundColor: bg, opacity: pressed ? 0.65 : 1 },
          ]}
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
  const state = useTramState(followKey);
  const plannerActive = usePlannerStore((s) => s.itinerary != null);
  const rideActive = useRidePreviewStore((s) => s.preview != null);
  const spotterActive = useSpotterStore((s) => s.station != null);
  const colors = useTextColors();
  if (!followKey || !state) return null;

  // Float above the planner/ride/spotter chips when they are visible.
  const bottom =
    (plannerActive ? CHIP_STACK_H : 0) +
    (rideActive ? CHIP_STACK_H : 0) +
    (spotterActive ? CHIP_STACK_H : 0);
  const reg = state.snapshot.registrationNumber;
  const accent = colors.scheme === 'dark' ? Tram.liveryRed : Tram.pidRed;
  return (
    <View style={[styles.chipSlot, { bottom }]}>
      <GlassPanel
        variant="regular"
        interactive
        appearance={colors.scheme}
        style={styles.chip}
      >
        {/* The tram identity (line + reg + delay) stays visible in BOTH states;
            tapping it reopens the detail sheet. Only the trailing control
            changes: "Following ⌃" hint while locked, a compact accent "Follow"
            pill to re-center while paused — never a full-width button over the
            info. Every element shares the 30 pt pill height (badge md, delay
            pill md, follow button, ✕ circle) so the row reads as one set. */}
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
              <Text
                style={[styles.followHint, { color: colors.secondary }]}
                allowFontScaling={false}
              >
                Following
              </Text>
              <SymbolView
                name="chevron.up"
                size={12}
                weight="semibold"
                tintColor={colors.secondary}
              />
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
 * Note the follow-banner ✕ also ends spotting — the controller reconciles
 * any follow change it didn't make (no orphaned spotter sessions).
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
            style={[styles.plannerRoute, { color: colors.text }]}
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
 * the chip body reopens the rides sheet (planner-chip pattern); the ✕ clears
 * the preview. Stacks one slot above the planner chip when both are active.
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
      ? new Date(ride.startedMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
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
            style={[styles.plannerRoute, { color: colors.text }]}
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
 * sheet with no way back); the ✕ clears the route. The chevron.up hints that
 * the chip itself is tappable.
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
            style={[styles.plannerRoute, { color: colors.text }]}
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
  statusChipWrap: { position: 'absolute', left: Spacing.three },
  statusChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  statusBody: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    fontFamily: Fonts?.rounded,
  },
  statusDetail: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },

  controlStack: { position: 'absolute', right: CONTROL_RIGHT, gap: CONTROL_GAP },
  controlButton: { borderRadius: CONTROL_BUTTON_SIZE / 2 },
  controlPressable: {
    width: CONTROL_BUTTON_SIZE,
    height: CONTROL_BUTTON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Wide layouts (iPad): the dock caps at 560 pt and centers instead of
  // stretching edge-to-edge; on phones maxWidth never binds.
  dockWrap: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    alignItems: 'center',
  },
  dock: {
    width: '100%',
    maxWidth: 560,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
  },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 38,
  },
  searchPlaceholder: { fontSize: 15, flexShrink: 1 },
  dockButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Bottom cluster: same horizontal language as the dock (left/right
  // Spacing.three, 560 pt cap centered on iPad) so `[ chip … ][locate]` reads
  // as one family with the dock below. The row is tall enough to CONTAIN the
  // full upward chip stack — iOS hit-testing is bounds-limited, so chips
  // rendered outside the row would be visible but untappable.
  clusterWrap: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    alignItems: 'center',
  },
  clusterRow: {
    width: '100%',
    maxWidth: 560,
    height: CONTROL_BUTTON_SIZE + (MAX_STACKED_CHIPS - 1) * CHIP_STACK_H,
  },
  locateSlot: { position: 'absolute', right: 0, bottom: 0 },
  // Chips stretch the full row width, fenced short of the locate button; the
  // stack offset (`bottom`) is set inline per chip.
  chipSlot: {
    position: 'absolute',
    left: 0,
    right: CONTROL_BUTTON_SIZE + CHIP_ROW_GAP,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    // Match the locate button's height (pill row).
    height: CONTROL_BUTTON_SIZE,
    gap: Spacing.two,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 999,
  },
  chipBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  chipSpacer: { flex: 1 },
  // ✕: 34 pt touch box wrapping a 30 pt visible circle (CHIP_ELEMENT_H).
  chipClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  chipCloseCircle: {
    width: CHIP_ELEMENT_H,
    height: CHIP_ELEMENT_H,
    borderRadius: CHIP_ELEMENT_H / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  followReg: {
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    fontFamily: Fonts?.rounded,
  },
  followHint: { fontSize: 14, fontWeight: '500' },
  // Paused follow: a COMPACT accent pill sitting where "Following" was — the
  // tram identity to its left stays visible; never full-width. Same 30 pt
  // element height as everything else in the row.
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
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily: Fonts?.rounded,
  },
  plannerRoute: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  spotterDetail: { fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'] },
});
