// Liquid Glass chrome floating over the map: status chip (live count + stale
// warning), right-side control stack, bottom dock (search + favorites +
// planner), and the follow banner. All surfaces are GlassPanel over the map.

import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DelayPill } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Fonts, Spacing, Tram } from '@/constants/theme';
import { getRuntime, useAllTramStates, useTramState } from '@/hooks/tramData';
import { usePlannerStore } from '@/stores/planner';
import { useRidePreviewStore } from '@/stores/ridePreview';
import { useSelectionStore } from '@/stores/selection';

const STALE_AFTER_MS = 30_000;

/** Vertical footprint of one stacked bottom chip (banner height + gap). */
const CHIP_STACK_H = 56;
/** Bottom offset of the follow-banner slot, above the dock. */
const BANNER_SLOT = Spacing.three + 68;

function useTextColors() {
  const scheme = useColorScheme();
  const palette = Colors[scheme === 'dark' ? 'dark' : 'light'];
  return { text: palette.text, secondary: palette.textSecondary };
}

function tapLight() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

// ── Status chip (top-left): live tram count + stale-data warning ─────────────

/** Stale when the last poll errored or is older than 30 s (re-checked ~1 Hz). */
function useDataStale(): boolean {
  const rt = getRuntime();
  return useSyncExternalStore(
    rt.subscribeUi,
    () =>
      rt.lastError != null ||
      rt.lastPollAtMs === 0 ||
      Date.now() - rt.lastPollAtMs > STALE_AFTER_MS,
  );
}

export function StatusChip() {
  const insets = useSafeAreaInsets();
  const states = useAllTramStates(); // ~1 Hz
  const colors = useTextColors();
  const stale = useDataStale();

  return (
    <View style={[styles.statusChipWrap, { top: insets.top + Spacing.two }]} pointerEvents="none">
      <GlassPanel variant="regular" style={styles.statusChip}>
        <SymbolView name="tram.fill" size={14} tintColor={Tram.pidRed} />
        <Text
          style={[styles.statusText, { color: colors.text }]}
          allowFontScaling={false}
        >
          {states.length}
        </Text>
        {stale && (
          <>
            <SymbolView name="wifi.exclamationmark" size={14} tintColor={Tram.late} />
            <Text style={[styles.statusStale, { color: Tram.late }]} allowFontScaling={false}>
              stale
            </Text>
          </>
        )}
      </GlassPanel>
    </View>
  );
}

// ── Control stack (top-right): locate · 2D/3D · settings ─────────────────────

export interface ControlStackProps {
  is3D: boolean;
  onLocate: () => void;
  onTogglePitch: () => void;
}

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
    <GlassPanel variant="regular" interactive style={styles.controlButton}>
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

export function ControlStack({ is3D, onLocate, onTogglePitch }: ControlStackProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.controlStack, { top: insets.top + Spacing.two }]}>
      <ControlButton symbol="location" label="Show my location" onPress={onLocate} />
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

// ── Bottom dock: search pill + favorites + planner ───────────────────────────

export function BottomDock() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = useTextColors();
  const fieldBg = scheme === 'dark' ? 'rgba(120,120,128,0.22)' : 'rgba(120,120,128,0.16)';

  return (
    <View style={[styles.dockWrap, { bottom: insets.bottom + Spacing.three }]}>
      <GlassPanel variant="regular" style={styles.dock}>
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

// ── Bottom banners: follow + planner-route clear + ride preview ──────────────
//
// All are stacked glass chips above the dock. The planner chip owns the base
// slot, the ride-preview chip stacks above it, and the follow banner floats
// on top of whichever of those are visible. Rendered together from a single
// exported node so `app/index.tsx` keeps its one `<FollowBanner />`.

export function FollowBanner() {
  return (
    <>
      <FollowChip />
      <RideChip />
      <PlannerChip />
    </>
  );
}

function FollowChip() {
  const insets = useSafeAreaInsets();
  const followKey = useSelectionStore((s) => s.followTramKey);
  const state = useTramState(followKey);
  const plannerActive = usePlannerStore((s) => s.itinerary != null);
  const rideActive = useRidePreviewStore((s) => s.preview != null);
  const colors = useTextColors();
  if (!followKey || !state) return null;

  // Float above the planner/ride chips when they are visible.
  const bottom =
    insets.bottom +
    BANNER_SLOT +
    (plannerActive ? CHIP_STACK_H : 0) +
    (rideActive ? CHIP_STACK_H : 0);
  const reg = state.snapshot.registrationNumber;
  // Chip body reopens the tram sheet (same pattern as the planner chip —
  // users kept losing the sheet while following); only the ✕ stops the follow.
  return (
    <View style={[styles.followWrap, { bottom }]}>
      <GlassPanel variant="regular" interactive style={styles.followBanner}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open tram ${reg ?? followKey} details`}
          style={styles.followBody}
          onPress={() => {
            tapLight();
            useSelectionStore.getState().setSelectedTramKey(followKey);
            router.push(`/tram/${encodeURIComponent(followKey)}`);
          }}
        >
          <LineBadge line={state.snapshot.line} size="sm" />
          {reg != null && (
            <Text style={[styles.followReg, { color: colors.text }]} allowFontScaling={false}>
              #{reg}
            </Text>
          )}
          <DelayPill delaySeconds={state.snapshot.delaySeconds} />
          <Text style={[styles.followHint, { color: colors.secondary }]} allowFontScaling={false}>
            Following
          </Text>
          <SymbolView name="chevron.up" size={12} tintColor={colors.secondary} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop following"
          hitSlop={10}
          onPress={() => {
            tapLight();
            useSelectionStore.getState().setFollowTramKey(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColor={colors.secondary} />
        </Pressable>
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
  const insets = useSafeAreaInsets();
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

  const bottom = insets.bottom + BANNER_SLOT + (plannerActive ? CHIP_STACK_H : 0);
  return (
    <View style={[styles.followWrap, { bottom }]}>
      <GlassPanel variant="regular" interactive style={styles.followBanner}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reopen recorded rides"
          style={styles.plannerBody}
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide ride preview"
          hitSlop={8}
          onPress={() => {
            tapLight();
            useRidePreviewStore.getState().setPreview(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={16} tintColor={colors.secondary} />
        </Pressable>
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
  const insets = useSafeAreaInsets();
  const itinerary = usePlannerStore((s) => s.itinerary);
  const colors = useTextColors();
  if (!itinerary) return null;

  const legs = itinerary.legs;
  const from = legs[0]?.fromStopName ?? '';
  const to = legs[legs.length - 1]?.toStopName ?? '';
  const label = from && to ? `${from} → ${to}` : 'Planned route';

  return (
    <View style={[styles.followWrap, { bottom: insets.bottom + BANNER_SLOT }]}>
      <GlassPanel variant="regular" interactive style={styles.followBanner}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reopen trip planner"
          style={styles.plannerBody}
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear planned route"
          hitSlop={8}
          onPress={() => {
            tapLight();
            usePlannerStore.getState().setItinerary(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={16} tintColor={colors.secondary} />
        </Pressable>
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  statusChipWrap: { position: 'absolute', left: Spacing.three },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    fontFamily: Fonts?.rounded,
  },
  statusStale: { fontSize: 12, fontWeight: '600' },

  controlStack: { position: 'absolute', right: Spacing.two + 4, gap: Spacing.two + 2 },
  controlButton: { borderRadius: 23 },
  controlPressable: {
    width: 46,
    height: 46,
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

  followWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  followBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  followBody: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  followReg: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  followHint: { fontSize: 12, fontWeight: '500' },
  plannerRoute: { fontSize: 13, fontWeight: '600', maxWidth: 200, flexShrink: 1 },
  plannerBody: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
