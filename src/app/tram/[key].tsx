// Tram detail form sheet — floats over the live map (transparent formSheet,
// detents [0.38, 0.95]). Live data via useTramState(key) at ~1 Hz with a local
// 1 s ticker for the next-stop ETA countdown between runtime updates.
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { AboutTramCard } from '@/components/tram/AboutTramCard';
import { StopsTimeline } from '@/components/tram/StopsTimeline';
import { DelayPill } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Tram } from '@/constants/theme';
import { getRuntime, useLoadedGeometries, useTramState } from '@/hooks/tramData';
import type { TramPublicState } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';

// ── helpers ──────────────────────────────────────────────────────────────────

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

const PHASE_META: Record<TramPublicState['phase'], { label: string; icon: SFSymbol }> = {
  cruise: { label: 'Cruising', icon: 'tram.fill' },
  dwell: { label: 'At stop', icon: 'pause.circle.fill' },
  terminal: { label: 'At terminus', icon: 'flag.checkered' },
  unknown: { label: 'Tracking', icon: 'antenna.radiowaves.left.and.right' },
};

// ── small building blocks ────────────────────────────────────────────────────

interface ActionButtonProps {
  icon: SFSymbol;
  label: string;
  active?: boolean;
  onPress: () => void;
}

function ActionButton({ icon, label, active, onPress }: ActionButtonProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const tint = active ? Tram.gold : c.text;
  return (
    <GlassPanel variant="clear" interactive style={styles.actionGlass}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.actionPress, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <SymbolView name={icon} size={20} tintColor={tint} />
        <Text style={[styles.actionLabel, { color: tint }]} allowFontScaling={false}>
          {label}
        </Text>
      </Pressable>
    </GlassPanel>
  );
}

function SectionHeader({ title }: { title: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <Text style={[styles.sectionHeader, { color: Colors[scheme].textSecondary }]}>
      {title.toUpperCase()}
    </Text>
  );
}

// ── gone / left-service state ────────────────────────────────────────────────

function GoneState({ lastState }: { lastState: TramPublicState | undefined }) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  return (
    <View style={styles.goneWrap}>
      <SymbolView name="moon.zzz.fill" size={44} tintColor={c.textSecondary} />
      {lastState && <LineBadge line={lastState.snapshot.line} size="lg" />}
      <Text style={[styles.goneTitle, { color: c.text }]}>Left service</Text>
      <Text style={[styles.goneSubtitle, { color: c.textSecondary }]}>
        {lastState
          ? `Tram #${lastState.snapshot.registrationNumber ?? lastState.key} on line ${lastState.snapshot.line} is no longer being tracked. It has likely reached its depot or ended the trip.`
          : 'This tram is not currently being tracked.'}
      </Text>
      <GlassPanel variant="clear" interactive style={styles.goneButton}>
        <Pressable onPress={() => router.back()} style={styles.goneButtonPress}>
          <Text style={[styles.goneButtonText, { color: c.text }]}>Close</Text>
        </Pressable>
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
  const c = Colors[scheme];

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

  const etaS = useEtaCountdown(state?.nextStopEtaS ?? null);

  const onFollow = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (isFollowing) {
      setFollowTramKey(null);
    } else {
      setFollowTramKey(key);
      // Close the sheet so the map (now following) is visible.
      router.back();
    }
  };

  const onFavorite = () => {
    void Haptics.selectionAsync();
    toggleTram(key);
  };

  const onShowLine = () => {
    if (state) router.push(`/line/${state.snapshot.line}`);
  };

  return (
    <GlassPanel style={styles.root}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {!state && !gone && (
          <View style={styles.goneWrap}>
            <SymbolView name="antenna.radiowaves.left.and.right" size={36} tintColor={c.textSecondary} />
            <Text style={[styles.goneSubtitle, { color: c.textSecondary }]}>Locating tram…</Text>
          </View>
        )}

        {!state && gone && <GoneState lastState={lastStateRef.current} />}

        {state && (
          <>
            {/* Header */}
            <View style={styles.header}>
              <LineBadge line={state.snapshot.line} size="lg" />
              <View style={styles.headerText}>
                <Text style={[styles.headsign, { color: c.text }]} numberOfLines={1}>
                  {state.snapshot.headsign}
                </Text>
                <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={1}>
                  {state.model.name}
                  {state.snapshot.registrationNumber != null &&
                    ` · #${state.snapshot.registrationNumber}`}
                </Text>
              </View>
              <DelayPill delaySeconds={state.snapshot.delaySeconds} />
            </View>

            {/* Live row */}
            <View
              style={[
                styles.liveRow,
                { backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.55)' },
              ]}
            >
              <View style={styles.liveCell}>
                <SymbolView name="speedometer" size={15} tintColor={c.textSecondary} />
                <Text style={[styles.liveBig, { color: c.text }]} allowFontScaling={false}>
                  {Math.round(state.simSpeedKmh)}
                </Text>
                <Text style={[styles.liveCaption, { color: c.textSecondary }]}>km/h</Text>
              </View>
              <View
                style={[
                  styles.liveDivider,
                  { backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' },
                ]}
              />
              <View style={styles.liveCell}>
                <SymbolView
                  name={PHASE_META[state.phase].icon}
                  size={15}
                  tintColor={state.phase === 'cruise' ? Tram.onTime : c.textSecondary}
                />
                <Text style={[styles.livePhase, { color: c.text }]} numberOfLines={1}>
                  {PHASE_META[state.phase].label}
                </Text>
                <Text style={[styles.liveCaption, { color: c.textSecondary }]}>now</Text>
              </View>
              <View
                style={[
                  styles.liveDivider,
                  { backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' },
                ]}
              />
              <View style={[styles.liveCell, styles.liveCellWide]}>
                <Text style={[styles.liveCaption, { color: c.textSecondary }]} numberOfLines={1}>
                  Next stop
                </Text>
                <Text style={[styles.liveNextName, { color: c.text }]} numberOfLines={1}>
                  {state.nextStopName ?? '—'}
                </Text>
                <Text
                  style={[styles.liveEta, { color: scheme === 'dark' ? Tram.liveryRed : Tram.pidRed }]}
                  allowFontScaling={false}
                >
                  {etaS != null ? fmtEta(etaS) : '· · ·'}
                </Text>
              </View>
            </View>

            {/* Actions */}
            <View style={styles.actionsRow}>
              <ActionButton
                icon="location.viewfinder"
                label={isFollowing ? 'Unfollow' : 'Follow'}
                active={isFollowing}
                onPress={onFollow}
              />
              <ActionButton
                icon={isFavorite ? 'star.fill' : 'star'}
                label={isFavorite ? 'Favorited' : 'Favorite'}
                active={isFavorite}
                onPress={onFavorite}
              />
              <ActionButton icon="map.fill" label="Show line" onPress={onShowLine} />
            </View>

            {/* Upcoming stops */}
            <SectionHeader title="Upcoming stops" />
            <StopsTimeline
              geometry={geometry}
              simDistM={state.simDistM}
              delaySeconds={state.snapshot.delaySeconds}
              phase={state.phase}
            />

            {/* About */}
            <SectionHeader title="About this tram" />
            <AboutTramCard model={state.model} snapshot={state.snapshot} />
          </>
        )}
      </ScrollView>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    gap: 14,
    paddingBottom: 48,
    paddingHorizontal: 18,
    paddingTop: 26,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  headerText: { flex: 1, gap: 2 },
  headsign: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  subtitle: { fontSize: 13 },
  liveRow: {
    alignItems: 'stretch',
    borderCurve: 'continuous',
    borderRadius: 16,
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  liveCell: {
    alignItems: 'center',
    flex: 1,
    gap: 2,
    justifyContent: 'center',
  },
  liveCellWide: { flex: 1.6 },
  liveDivider: {
    alignSelf: 'stretch',
    marginHorizontal: 8,
    width: StyleSheet.hairlineWidth,
  },
  liveBig: { fontSize: 22, fontVariant: ['tabular-nums'], fontWeight: '700' },
  livePhase: { fontSize: 14, fontWeight: '600' },
  liveCaption: { fontSize: 11 },
  liveNextName: { fontSize: 14, fontWeight: '600', maxWidth: '100%' },
  liveEta: { fontSize: 17, fontVariant: ['tabular-nums'], fontWeight: '700' },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionGlass: { flex: 1 },
  actionPress: {
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  actionLabel: { fontSize: 12, fontWeight: '600' },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.7,
    marginBottom: -6,
    marginTop: 6,
  },
  goneWrap: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  goneTitle: { fontSize: 20, fontWeight: '700' },
  goneSubtitle: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  goneButton: { marginTop: 8 },
  goneButtonPress: { paddingHorizontal: 28, paddingVertical: 10 },
  goneButtonText: { fontSize: 15, fontWeight: '600' },
});
