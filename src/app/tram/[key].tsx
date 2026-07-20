// Tram detail sheet — a native iOS place card floating over the live map. The
// route is a transparent formSheet (detents [0.15, 0.42, 0.95], opens on the
// card detent, index 1) whose corners come from the system presentation, not a
// hand-rolled radius. The header is a REAL native stack header
// (react-native-screens): the headsign is the header title, sitting on the same
// row as the toolbar star/⋯ (place-card style) and doubling as the minimized bar
// when the sheet is dragged down to the 0.15 detent. Favorite lives as a native
// header star; secondary actions (model info, photos, record ride) live in a
// native header ⋯ menu — no floating bar, no share button.
//
// The body ScrollView is a DIRECT child of the screen (NOT wrapped in a
// GlassView) so the native sheet controller can track it: that is what wires
// UISheetPresentationController.prefersScrollingExpandsWhenScrolledToEdge —
// dragging the body up on a half-open detent raises the sheet to the next detent
// before the content scrolls. The glass sheet background comes from the system
// formSheet (iOS 26) or SheetBackground below, never a container around the scroll.
//
// Opening this sheet ENGAGES FOLLOW on the tram (and keeps following after
// close). The card's Follow pill toggles it; the map's FollowChip ✕ also ends
// it. Live data via useTramState(key) at ~1 Hz; the 1 s freshness / ETA tickers
// anchor on each runtime value and tick locally so countdowns never freeze.
import { BlurView } from 'expo-blur';
import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { AboutTramCard } from '@/components/tram/AboutTramCard';
import { RideStatusStrip, useRideRecorder } from '@/components/tram/RideRecorder';
import { StopsTimeline } from '@/components/tram/StopsTimeline';
import { TramFace } from '@/components/tram/TramFace';
import { AcSnowflake } from '@/components/tram/TramModelImage';
import { ActionPillRow, type PillAction } from '@/components/ui/ActionPillRow';
import { DelayPill, delayColor, delayLabel } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { StatRow, type Stat } from '@/components/ui/StatRow';
import { Apple, appleScheme, Tram } from '@/constants/theme';
import { getRuntime, useLoadedGeometries, useTramState } from '@/hooks/tramData';
import type { TramPublicState } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

// Whether the system paints Liquid Glass behind a transparent formSheet (iOS 26+).
// When it does, the sheet background is the system's — we must NOT wrap the body
// in our own GlassView, because doing so buries the ScrollView where
// react-native-screens can't find it (it walks the content wrapper's direct /
// first-descendant subviews). That broke the native sheet's
// scroll-expands-to-edge gesture (the ScrollView must be a tracked descendant).
const SYSTEM_SHEET_GLASS = isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

/**
 * Sheet background for the tram card. The ScrollView must be a DIRECT child of
 * the screen (so the native sheet controller can track it for the
 * scroll-expands-to-edge gesture), so the glass can't be a container around it.
 * On iOS 26 the system formSheet
 * already renders Liquid Glass behind our transparent content — we render
 * nothing. On older iOS (or Reduce Transparency) we drop a blur / solid
 * absoluteFill *behind* the scroll — a plain BlurView/View composites correctly
 * as an earlier sibling (only real GlassView has to be a container).
 */
function SheetBackground() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => mounted && setReduceTransparency(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduceTransparency,
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  if (SYSTEM_SHEET_GLASS && !reduceTransparency) return null;
  if (!reduceTransparency) {
    return (
      <BlurView
        intensity={60}
        tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        style={StyleSheet.absoluteFill}
      />
    );
  }
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: scheme === 'dark' ? 'rgba(28,28,30,0.94)' : 'rgba(248,248,250,0.96)' },
      ]}
    />
  );
}

// ── live tickers ─────────────────────────────────────────────────────────────

/** Now-ms ticking every second, for the "updated Ns ago" freshness value. */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Live ETA countdown for the stat quad. Anchors on every fresh runtime value
 * (~1 Hz) and ticks locally each second so it never freezes between polls.
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

function fmtAge(ageS: number): string {
  if (ageS < 120) return `${ageS} s`;
  return `${Math.floor(ageS / 60)} m`;
}

function fmtEta(s: number): string {
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const PHASE_LABEL: Record<TramPublicState['phase'], string> = {
  cruise: 'Cruising',
  dwell: 'At stop',
  terminal: 'Terminus',
  unknown: 'Tracking',
};

// ── identity hero (horizontal) ───────────────────────────────────────────────

/**
 * The place-card identity block, laid out HORIZONTALLY: a tappable model
 * portrait (→ full-screen 3D viewer, the established face→3D entry) beside the
 * line badge + live delay pill and the model · reg line. The headsign is NOT
 * repeated here — it is the native large title above.
 */
function TramHero({ state }: { state: TramPublicState }) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const line = state.snapshot.line;
  const reg = state.snapshot.registrationNumber;
  const subtitle = `${state.model.name}${reg != null ? ` · #${reg}` : ''}`;

  const onPortrait = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/model/${state.model.id}`);
  };

  return (
    <View style={styles.hero}>
      <Pressable
        onPress={onPortrait}
        style={({ pressed }) => pressed && styles.portraitPressed}
        accessibilityRole="button"
        accessibilityLabel={`View ${state.model.name} in 3D`}
        hitSlop={4}
      >
        <GlassPanel variant="clear" style={styles.portraitGlass}>
          <TramFace modelId={state.model.id} size={56} />
        </GlassPanel>
      </Pressable>

      <View style={styles.heroText}>
        <View style={styles.heroTitleRow}>
          <LineBadge line={line} size="md" />
          <DelayPill delaySeconds={state.snapshot.delaySeconds} />
        </View>
        <View style={styles.heroSubRow}>
          <Text style={[styles.heroSubtitle, { color: c.secondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
          <AcSnowflake airConditioned={state.snapshot.airConditioned} size={12} />
        </View>
      </View>
    </View>
  );
}

// ── live stat quad + honesty line ────────────────────────────────────────────

function LiveStats({ state, positionMode }: { state: TramPublicState; positionMode: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const nowMs = useNowTick();
  const updatedAgoS = Math.max(0, Math.round((nowMs - state.snapshot.observedAtMs) / 1000));
  const fresh = updatedAgoS <= 15;

  const eta = useEtaCountdown(state.nextStopEtaS ?? null);
  const delayS = state.snapshot.delaySeconds;

  const stats: Stat[] = [
    {
      key: 'updated',
      caption: 'Updated',
      value: fmtAge(updatedAgoS),
      symbol: 'antenna.radiowaves.left.and.right',
      valueTint: fresh ? Apple.green : undefined,
    },
    { key: 'status', caption: 'Status', value: PHASE_LABEL[state.phase] },
    {
      key: 'next',
      caption: 'Next stop',
      value: eta != null ? fmtEta(eta) : '—',
      valueTint: eta != null ? Apple.green : undefined,
    },
    {
      key: 'delay',
      caption: 'Delay',
      value: delayLabel(delayS),
      valueTint: delayS > 60 ? delayColor(delayS) : undefined,
    },
  ];

  // Sim honesty — kept verbatim (ux-screens §8): Smooth declares its drift from
  // the last real AVL fix; Live declares it is showing the raw reported position.
  const honesty =
    positionMode === 'live'
      ? 'Showing raw reported position'
      : state.deviationM != null
        ? `Sim offset ±${Math.round(state.deviationM)} m from last fix`
        : null;

  return (
    <View style={styles.statsBlock}>
      <StatRow stats={stats} />
      {honesty != null && (
        <View style={styles.honestyRow}>
          <SymbolView name="wand.and.rays" size={11} weight="semibold" tintColor={c.secondary} />
          <Text style={[styles.honestyText, { color: c.secondary }]} allowFontScaling={false}>
            {honesty}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── gone / left-service state ────────────────────────────────────────────────

function GoneState({ lastState }: { lastState: TramPublicState | undefined }) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  return (
    <View style={styles.goneWrap}>
      <SymbolView name="moon.zzz.fill" size={44} tintColor={c.secondary} />
      {lastState && <LineBadge line={lastState.snapshot.line} size="lg" />}
      <Text style={[styles.goneTitle, { color: c.text }]}>Left service</Text>
      <Text style={[styles.goneSubtitle, { color: c.secondary }]}>
        {lastState
          ? `Tram #${lastState.snapshot.registrationNumber ?? lastState.key} on line ${lastState.snapshot.line} is no longer being tracked. It has likely reached its depot or ended the trip.`
          : 'This tram is not currently being tracked.'}
      </Text>
      <GlassPanel variant="clear" interactive style={styles.goneButton}>
        <Text
          onPress={() => router.back()}
          accessibilityRole="button"
          style={[styles.goneButtonText, { color: c.text }]}
        >
          Close
        </Text>
      </GlassPanel>
    </View>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────

export default function TramDetailSheet() {
  const params = useLocalSearchParams<{ key: string }>();
  const key = typeof params.key === 'string' ? params.key : '';
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const state = useTramState(key);
  const geometries = useLoadedGeometries();

  // Remember the last live state so we can render a friendly "left service"
  // screen (with line + reg) if the tram drops out of the feed while open.
  const lastStateRef = useRef<TramPublicState | undefined>(undefined);
  if (state) lastStateRef.current = state;
  const hasPolled = getRuntime().lastPollAtMs > 0;
  const gone = !state && (lastStateRef.current !== undefined || hasPolled);

  const followTramKey = useSelectionStore((s) => s.followTramKey);
  const setFollowTramKey = useSelectionStore((s) => s.setFollowTramKey);
  const setSelectedTramKey = useSelectionStore((s) => s.setSelectedTramKey);
  const isFollowing = followTramKey === key;

  // This sheet owns `selectedTramKey` (drives the map's gold halo). Set it on
  // mount/key change regardless of how we got here (map tap, search, line
  // screen, favorites) and clear it on dismiss — but only if the store still
  // points at us, so a newer sheet that already claimed selection wins.
  useEffect(() => {
    if (!key) return;
    setSelectedTramKey(key);
    return () => {
      if (useSelectionStore.getState().selectedTramKey === key) {
        setSelectedTramKey(null);
      }
    };
  }, [key, setSelectedTramKey]);

  // Opening the sheet engages follow on this tram — no cleanup: follow persists
  // after close (unfollow is the FollowChip ✕'s / the Follow pill's job).
  useEffect(() => {
    if (key) setFollowTramKey(key);
  }, [key, setFollowTramKey]);

  const isFavorite = useFavoritesStore((s) => s.favoriteTrams.includes(key));
  const toggleTram = useFavoritesStore((s) => s.toggleTram);

  // If the followed tram leaves service, stop following it.
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

  const ride = useRideRecorder(key);
  const positionMode = useSettingsStore((s) => s.positionMode);

  const onFavorite = () => {
    void Haptics.selectionAsync();
    toggleTram(key);
  };

  const onToggleFollow = () => {
    void Haptics.selectionAsync();
    setFollowTramKey(isFollowing ? null : key);
  };

  const onShowLine = () => {
    if (state) router.push(`/line/${state.snapshot.line}`);
  };

  const on3D = () => {
    if (state) router.push(`/model/${state.model.id}`);
  };

  const onModelInfo = () => {
    if (state) router.push(`/model-info/${state.model.id}`);
  };

  // ── loading / gone ──
  if (!state) {
    return (
      // The ScrollView is a DIRECT child of the screen so react-native-screens
      // can track it; the glass background sits behind it (see SheetBackground).
      <>
        <SheetBackground />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.centerContent}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
        >
          {gone ? (
            <GoneState lastState={lastStateRef.current} />
          ) : (
            <View style={styles.goneWrap}>
              <SymbolView
                name="antenna.radiowaves.left.and.right"
                size={36}
                tintColor={c.secondary}
              />
              <Text style={[styles.goneSubtitle, { color: c.secondary }]}>Locating tram…</Text>
            </View>
          )}
        </ScrollView>
        <Stack.Title>{gone ? 'Left service' : 'Locating tram'}</Stack.Title>
      </>
    );
  }

  const line = state.snapshot.line;
  const reg = state.snapshot.registrationNumber;

  const actions: PillAction[] = [
    {
      key: 'follow',
      symbol: isFollowing ? 'location.fill' : 'location',
      label: isFollowing ? 'Following' : 'Follow',
      onPress: onToggleFollow,
      prominent: isFollowing,
    },
    { key: 'line', symbol: 'map', label: `Line ${line}`, onPress: onShowLine },
    { key: '3d', symbol: 'rotate.3d', label: '3D Model', onPress: on3D },
  ];

  return (
    // The ScrollView is a DIRECT child of the screen (not wrapped in a GlassView)
    // so the native sheet controller can track it: this is what wires the
    // scroll-expands-to-edge gesture (drag the body up on a half-open sheet → the
    // sheet rises to the next detent, then the content scrolls). The glass sheet
    // background comes from the system formSheet (iOS 26) or SheetBackground.
    <>
      <SheetBackground />

      {/* Scroll spans the whole sheet; automatic inset accounts for the header. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <SheetContent style={styles.column}>
          <TramHero state={state} />

          <ActionPillRow actions={actions} />

          <LiveStats state={state} positionMode={positionMode} />

          <View>
            <SectionLabel>Upcoming stops</SectionLabel>
            <StopsTimeline
              geometry={geometry}
              simDistM={state.simDistM}
              delaySeconds={state.snapshot.delaySeconds}
              phase={state.phase}
              nextStopEtaS={state.nextStopEtaS}
              collapsible
            />
          </View>

          <RideStatusStrip tramKey={key} />

          <View>
            <SectionLabel>About</SectionLabel>
            <AboutTramCard model={state.model} snapshot={state.snapshot} />
          </View>
        </SheetContent>
      </ScrollView>

      {/* Native header title on the SAME row as the toolbar star/⋯ (place-card
          style); it stays the minimized bar at the 0.15 detent too. Regular (not
          large) is enforced by the route's headerLargeTitleEnabled:false. */}
      <Stack.Title style={{ color: c.text }}>{state.snapshot.headsign}</Stack.Title>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={isFavorite ? 'star.fill' : 'star'}
          tintColor={isFavorite ? Tram.gold : undefined}
          onPress={onFavorite}
          accessibilityLabel={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        />
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="More actions">
          <Stack.Toolbar.MenuAction icon="info.circle" onPress={onModelInfo}>
            Model info & history
          </Stack.Toolbar.MenuAction>
          {reg != null && (
            <Stack.Toolbar.MenuAction
              icon="camera"
              onPress={() => router.push(`/tram-photos/${reg}`)}
            >
              Photos of this car
            </Stack.Toolbar.MenuAction>
          )}
          <Stack.Toolbar.MenuAction
            icon={ride.recordingThis ? 'stop.fill' : 'record.circle'}
            destructive={ride.recordingThis}
            onPress={ride.toggle}
          >
            {ride.recordingThis ? 'Stop ride recording' : 'Record ride'}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  body: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 40 },
  // No flex here — inside a ScrollView's content container a flex:1 child
  // collapses to zero height and the whole card renders blank.
  column: { gap: 18 },
  centerContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20 },

  // identity hero (horizontal)
  hero: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  portraitPressed: { transform: [{ scale: 0.96 }] },
  portraitGlass: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 20,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  heroText: { flex: 1, gap: 6 },
  heroTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  heroSubRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  heroSubtitle: { flexShrink: 1, fontSize: 14 },

  statsBlock: { gap: 8 },
  honestyRow: { alignItems: 'center', flexDirection: 'row', gap: 5, justifyContent: 'center' },
  honestyText: { fontSize: 12 },

  goneWrap: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  goneTitle: { fontSize: 20, fontWeight: '700' },
  goneSubtitle: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  goneButton: { borderRadius: 999, marginTop: 8 },
  goneButtonText: { fontSize: 15, fontWeight: '600', paddingHorizontal: 28, paddingVertical: 10 },
});
