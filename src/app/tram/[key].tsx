// Tram detail sheet — a native iOS place card floating over the live map. The
// route is a transparent formSheet (detents [0.15, 0.42, 0.95], opens on the
// card detent, index 1) whose corners come from the system presentation, not a
// hand-rolled radius. The native stack header carries ONLY the toolbar star/⋯
// (no title): favorite lives as a native header star; secondary actions (model
// info, photos, record ride) live in a native header ⋯ menu — no floating bar,
// no share button.
//
// The identity lives in a CUSTOM COLLAPSING HEADER (CollapsingHeader) that is the
// first row of the scroll body: [face icon][line badge][headsign][on-time badge].
// It is a sticky scroll header (stickyHeaderIndices={[0]}) driven by a Reanimated
// onScroll worklet — the face icon shrinks and the subtitle/badge fade as the
// body scrolls, leaving a compact [small icon · line · headsign] bar. All of it
// runs on the UI thread off one shared `scrollY`; no per-frame React state.
//
// The body ScrollView is a DIRECT child of the screen (NOT wrapped in a
// GlassView) so the native sheet controller can track it: that is what wires
// UISheetPresentationController.prefersScrollingExpandsWhenScrolledToEdge —
// dragging the body up on a half-open detent raises the sheet to the next detent
// before the content scrolls. The collapsing header lives INSIDE that scroll (as
// a sticky child, not a sibling overlay), so it never hides the ScrollView from
// react-native-screens' scroll-finder. The glass sheet background comes from the
// system formSheet (iOS 26) or SheetBackground below, never a container around it.
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
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { AboutTramCard } from '@/components/tram/AboutTramCard';
import { RideStatusStrip, useRideRecorder } from '@/components/tram/RideRecorder';
import { StopsTimeline } from '@/components/tram/StopsTimeline';
import { TramFace } from '@/components/tram/TramFace';
import { AcSnowflake } from '@/components/tram/TramModelImage';
import { ActionPillRow, type PillAction } from '@/components/ui/ActionPillRow';
import { DelayPill } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { StatTile, type Stat } from '@/components/ui/StatRow';
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

// ── collapsing identity header ───────────────────────────────────────────────

// The face icon is rendered once at its EXPANDED size and scaled down with a UI-
// thread transform (SVG size is a React prop, not animatable per frame); the
// icon box width/height animate in lockstep so the line badge + headsign reflow
// toward it. HEADER_* are the header row heights the container morphs between.
const EXPANDED_ICON = 52;
const COLLAPSED_ICON = 28;
const HEADER_EXPANDED = 64;
const HEADER_COLLAPSED = 44;
// Scroll distance (pt) over which the header fully collapses.
const COLLAPSE_DISTANCE = 88;
// Top inset baked into the sticky header so its content always clears the
// transparent native toolbar bar (star/⋯) — in BOTH the expanded and the pinned
// (collapsed) state. We drive top spacing manually here instead of via
// contentInsetAdjustmentBehavior="automatic": an automatic inset only shifts the
// resting content, so a sticky header still pins to the scroll-view frame top and
// slides UNDER the toolbar when scrolled. A constant inset that is part of the
// sticky child keeps the identity row below the toolbar at every scroll position,
// and the fade-in surface masks scrolling content behind the toolbar band.
const HEADER_TOP_INSET = 52;

/** Empty native header title — renders nothing (no text, no quote-glyph fallback
 * that an empty/space string produces). Kept module-level so the option identity
 * is stable across renders. */
const renderEmptyTitle = () => <View />;

/**
 * The place-card identity block, laid out HORIZONTALLY and COLLAPSING on scroll:
 * a tappable model portrait (→ full-screen 3D viewer, the established face→3D
 * entry) beside the line badge, the headsign, and the live on-time/delay badge,
 * with a model · reg subtitle underneath. As `scrollY` grows the face icon
 * shrinks, the subtitle + delay badge fade, and a surface + hairline fade in — so
 * the pinned (sticky) bar reads as a compact [small icon · line · headsign].
 * Everything is driven off the shared `scrollY` on the UI thread; no React state.
 */
function CollapsingHeader({
  state,
  scrollY,
}: {
  state: TramPublicState;
  scrollY: SharedValue<number>;
}) {
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

  const containerStyle = useAnimatedStyle(() => ({
    height: interpolate(
      scrollY.value,
      [0, COLLAPSE_DISTANCE],
      [HEADER_EXPANDED, HEADER_COLLAPSED],
      Extrapolation.CLAMP,
    ),
  }));
  const iconBoxStyle = useAnimatedStyle(() => {
    const s = interpolate(
      scrollY.value,
      [0, COLLAPSE_DISTANCE],
      [EXPANDED_ICON, COLLAPSED_ICON],
      Extrapolation.CLAMP,
    );
    return { width: s, height: s };
  });
  const iconScaleStyle = useAnimatedStyle(() => {
    const s = interpolate(
      scrollY.value,
      [0, COLLAPSE_DISTANCE],
      [EXPANDED_ICON, COLLAPSED_ICON],
      Extrapolation.CLAMP,
    );
    return { transform: [{ scale: s / EXPANDED_ICON }] };
  });
  const subtitleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, COLLAPSE_DISTANCE * 0.4], [1, 0], Extrapolation.CLAMP),
  }));
  // Surface + hairline that fade IN as the header pins, masking the scrolling
  // content beneath the sticky bar (the iOS large-title→inline idiom). This is a
  // PLAIN near-opaque View matching the sheet surface — deliberately NOT a
  // BlurView: inside a sticky header the native blur layer composites ON TOP of
  // the row content and washes it out, whereas a plain View honors child z-order
  // and sits cleanly behind the icon / badge / headsign.
  const surface =
    scheme === 'dark' ? 'rgba(28,28,30,0.92)' : 'rgba(248,248,250,0.94)';
  const chromeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [COLLAPSE_DISTANCE * 0.4, COLLAPSE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    // Sticky wrapper carries a constant top inset (HEADER_TOP_INSET) so the
    // identity row always sits below the transparent native toolbar — expanded
    // AND pinned. The fade-in surface fills the WHOLE wrapper (incl. the inset
    // band behind the toolbar), so when pinned it masks the scrolling content the
    // full width, reading as an inline nav bar.
    <View style={styles.headerSticky}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: surface }, chromeStyle]}
      >
        <View style={[styles.headerHairline, { backgroundColor: c.separator }]} />
      </Animated.View>

      <Animated.View style={[styles.header, containerStyle]}>
        <SheetContent style={styles.headerInner}>
          <Pressable
            onPress={onPortrait}
            style={({ pressed }) => pressed && styles.portraitPressed}
            accessibilityRole="button"
            accessibilityLabel={`View ${state.model.name} in 3D`}
            hitSlop={4}
          >
            <Animated.View
              style={[styles.iconBox, { backgroundColor: c.fillTertiary }, iconBoxStyle]}
            >
              <Animated.View style={[styles.iconScale, iconScaleStyle]}>
                <TramFace modelId={state.model.id} size={EXPANDED_ICON} />
              </Animated.View>
            </Animated.View>
          </Pressable>

          <View style={styles.headerText}>
            <View style={styles.headerTitleRow}>
              <LineBadge line={line} size="md" />
              <Text style={[styles.headsign, { color: c.text }]} numberOfLines={1}>
                {state.snapshot.headsign}
              </Text>
            </View>
            <Animated.View style={[styles.headerSubRow, subtitleStyle]}>
              <Text style={[styles.headerSubtitle, { color: c.secondary }]} numberOfLines={1}>
                {subtitle}
              </Text>
              <AcSnowflake airConditioned={state.snapshot.airConditioned} size={12} />
            </Animated.View>
          </View>
        </SheetContent>
      </Animated.View>
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

  // Two text stats (Updated / Next stop) + a Delay tile that renders the same
  // on-time / +N min pill as the header (Status/Cruising dropped — not useful).
  const stats: Stat[] = [
    {
      key: 'updated',
      caption: 'Updated',
      value: fmtAge(updatedAgoS),
      symbol: 'antenna.radiowaves.left.and.right',
      valueTint: fresh ? Apple.green : undefined,
    },
    {
      key: 'next',
      caption: 'Next stop',
      value: eta != null ? fmtEta(eta) : '—',
      valueTint: eta != null ? Apple.green : undefined,
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
      <View style={styles.statRow}>
        {stats.map((s) => (
          <StatTile key={s.key} stat={s} />
        ))}
        {/* Delay cell: just the centered pill (no caption). The pill is pushed to
            the bottom of the stretched row so it sits on the same baseline as the
            Updated / Next stop values. */}
        <View style={styles.delayTile}>
          <DelayPill delaySeconds={delayS} style={styles.delayPill} />
        </View>
      </View>
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

  // Drives the collapsing header entirely on the UI thread — the onScroll worklet
  // writes `scrollY`, CollapsingHeader's useAnimatedStyle hooks read it. No React
  // state per frame (perf invariant §B.1).
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

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
    // The Animated.ScrollView is a DIRECT child of the screen (not wrapped in a
    // GlassView) so the native sheet controller can track it: this is what wires
    // the scroll-expands-to-edge gesture (drag the body up on a half-open sheet →
    // the sheet rises to the next detent, then the content scrolls). The
    // CollapsingHeader is the sticky FIRST child of THIS scroll (index 0), not a
    // sibling overlay — so it never hides the ScrollView from the scroll-finder.
    // The glass sheet background comes from the system formSheet (iOS 26) or
    // SheetBackground.
    <>
      <SheetBackground />

      {/* Scroll spans the whole sheet. Top spacing under the transparent toolbar
          is baked into the sticky header (HEADER_TOP_INSET), NOT an automatic
          content inset — so we use "never": the resting content offset is a clean
          0, which the native sheet controller reads unambiguously for the
          scroll-expands-to-edge gesture, and the sticky header keeps the identity
          row below the toolbar at every scroll position. */}
      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        stickyHeaderIndices={[0]}
      >
        <CollapsingHeader state={state} scrollY={scrollY} />

        <View style={styles.bodyInner}>
          <SheetContent style={styles.column}>
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
        </View>
      </Animated.ScrollView>

      {/* The native header carries ONLY the toolbar star/⋯ now — the headsign
          moved into the CollapsingHeader identity block above. The center title
          is fully suppressed by rendering an EMPTY VIEW as headerTitle: neither an
          empty string (falls back to the "tram/[key]" route name on some entry
          paths) nor a space (renders a stray quote glyph) leaves the center truly
          blank — a custom empty title component does. */}
      <Stack.Screen options={{ headerTitle: renderEmptyTitle }} />
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
  // Full-width container so the sticky header's blur/hairline span edge-to-edge;
  // horizontal padding lives on the header inner + bodyInner instead.
  body: { paddingBottom: 40 },
  bodyInner: { paddingHorizontal: 20, paddingTop: 14 },
  // No flex here — inside a ScrollView's content container a flex:1 child
  // collapses to zero height and the whole card renders blank.
  column: { gap: 18 },
  centerContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20 },

  // collapsing identity header (sticky, morphs on scrollY)
  // Sticky wrapper: constant top inset keeps the identity row clear of the
  // transparent native toolbar in both the expanded and pinned states.
  headerSticky: { paddingTop: HEADER_TOP_INSET },
  header: { justifyContent: 'center', overflow: 'hidden' },
  headerHairline: {
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  headerInner: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: 20 },
  portraitPressed: { transform: [{ scale: 0.96 }] },
  iconBox: {
    borderCurve: 'continuous',
    borderRadius: 13,
    overflow: 'hidden',
  },
  // Rendered at EXPANDED_ICON and scaled from the top-left so it stays pinned in
  // the animating iconBox corner as both shrink in lockstep.
  iconScale: { left: 0, position: 'absolute', top: 0, transformOrigin: 'top left' },
  headerText: { flex: 1, gap: 3, justifyContent: 'center' },
  headerTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  headsign: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
  headerSubRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  headerSubtitle: { flexShrink: 1, fontSize: 13 },

  statsBlock: { gap: 8 },
  // stretch so the delay cell matches the caption+value height of the other
  // tiles; its pill then bottom-aligns to the same baseline as their values.
  statRow: { alignItems: 'stretch', flexDirection: 'row' },
  delayTile: { alignItems: 'center', flex: 1, justifyContent: 'flex-end', paddingHorizontal: 4 },
  delayPill: { alignSelf: 'center' },
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
