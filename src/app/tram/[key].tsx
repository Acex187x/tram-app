// Tram detail sheet — the Apple Maps place-detail card (IMG_0077/78/79). Floats
// over the live map (transparent formSheet, detents [0.15, 0.42, 0.95]). At the
// 0.15 detent it collapses to the minimized place bar (share · title · X); at
// 0.42/0.95 it is the full card: TramSheetHeader identity, an ActionPillRow
// (Follow / Show Line / 3D), a live stat quad (Updated / Status / Next stop /
// Delay), the sim-honesty line, the upcoming-stops timeline, the About spec
// group, and a floating action bar (star / record / photos / more).
//
// Opening this sheet ENGAGES FOLLOW on the tram (and keeps following after
// close). The card's Follow pill toggles it; the map's FollowChip ✕ also ends
// it. Live data via useTramState(key) at ~1 Hz; the 1 s freshness / ETA tickers
// anchor on each runtime value and tick locally so countdowns never freeze.
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Share,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { AboutTramCard } from '@/components/tram/AboutTramCard';
import { RideStatusStrip, useRideRecorder } from '@/components/tram/RideRecorder';
import { StopsTimeline } from '@/components/tram/StopsTimeline';
import { TramSheetHeader } from '@/components/tram/TramSheetHeader';
import { ActionPillRow, type PillAction } from '@/components/ui/ActionPillRow';
import { CloseCircle } from '@/components/ui/CloseCircle';
import { delayColor, delayLabel } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { StatRow, type Stat } from '@/components/ui/StatRow';
import { FloatingActionBar, type BarItem } from '@/components/ui/FloatingActionBar';
import { Apple, appleScheme, Tram } from '@/constants/theme';
import { getRuntime, useLoadedGeometries, useTramState } from '@/hooks/tramData';
import type { TramPublicState } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

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
  const { height: windowH } = useWindowDimensions();

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

  // Detent tracking: the formSheet resizes the content view to the active
  // detent, so onLayout reports its height. We flip to the minimized place bar
  // below ~0.30·windowHeight (between the 0.15 and 0.42 detents). Only a
  // threshold crossing commits — not every drag frame.
  const [minimized, setMinimized] = useState(false);
  const minimizedRef = useRef(false);
  const onRootLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    const next = h > 0 && h < windowH * 0.3;
    if (next !== minimizedRef.current) {
      minimizedRef.current = next;
      setMinimized(next);
    }
  };

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

  const onShare = () => {
    if (!state) return;
    const reg = state.snapshot.registrationNumber;
    void Share.share({
      message: `Tram ${state.snapshot.line} to ${state.snapshot.headsign}${
        reg != null ? ` · #${reg}` : ''
      } — spotted on Tram Spotter`,
    });
  };

  const onMore = () => {
    if (!state) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['Model info & specs', 'View in 3D', 'Share', 'Cancel'],
        cancelButtonIndex: 3,
      },
      (i) => {
        if (i === 0) onModelInfo();
        else if (i === 1) on3D();
        else if (i === 2) onShare();
      },
    );
  };

  // ── minimized place bar (0.15 detent) ──
  if (minimized && state) {
    return (
      <View style={styles.root} onLayout={onRootLayout}>
        <GlassPanel style={styles.glass}>
          <SheetContent>
            <TramSheetHeader state={state} onClose={() => router.back()} onShare={onShare} compact />
          </SheetContent>
        </GlassPanel>
      </View>
    );
  }

  // ── loading / gone ──
  if (!state) {
    return (
      <View style={styles.root} onLayout={onRootLayout}>
        <GlassPanel style={styles.glass}>
          <SheetContent style={styles.centerContent}>
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
          </SheetContent>
        </GlassPanel>
      </View>
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

  const barItems: BarItem[] = [
    {
      key: 'fav',
      symbol: isFavorite ? 'star.fill' : 'star',
      label: isFavorite ? 'Remove favorite' : 'Add favorite',
      onPress: onFavorite,
      active: isFavorite,
      tint: Tram.gold,
    },
    {
      key: 'record',
      symbol: 'record.circle',
      label: ride.recordingThis ? 'Stop recording' : 'Record ride',
      onPress: ride.toggle,
      active: ride.recordingThis,
      tint: Apple.red,
    },
    ...(reg != null
      ? [
          {
            key: 'photos',
            symbol: 'camera' as const,
            label: 'Photos of this car',
            onPress: () => router.push(`/tram-photos/${reg}`),
          },
        ]
      : []),
    { key: 'more', symbol: 'ellipsis', label: 'More', onPress: onMore },
  ];

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      <SheetSurface
        header={
          <TramSheetHeader state={state} onClose={() => router.back()} onShare={onShare} />
        }
        footer={<FloatingActionBar items={barItems} style={styles.bar} />}
        contentContainerStyle={styles.body}
      >
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
      </SheetSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  glass: { flex: 1, borderRadius: 0 },
  centerContent: { flex: 1, justifyContent: 'center' },
  body: { paddingTop: 4, gap: 18 },
  bar: { marginTop: 4, marginBottom: 10 },
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
