// Tram detail form sheet — floats over the live map (transparent formSheet,
// detents [0.38, 0.95]). The "portrait card": TramSheetHeader (line badge +
// headsign, TramFace portrait → 3D viewer, one quiet freshness/delay/honesty
// caption, segmented actions capsule), then the upcoming-stops timeline
// (collapsed to the next 5 so the ticking NEXT countdown sits inside the 0.38
// peek), the RideRecorder, and a compact About row → /model-info/[id].
//
// Opening this sheet ENGAGES FOLLOW on the tram (and keeps following after
// close) — unfollow lives on the map's FollowChip ✕, so there is no in-sheet
// follow button. Live data via useTramState(key) at ~1 Hz; the 1 s freshness
// ticker lives inside TramSheetHeader.
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { AboutTramRow } from '@/components/tram/AboutTramRow';
import { RideRecorder } from '@/components/tram/RideRecorder';
import { StopsTimeline } from '@/components/tram/StopsTimeline';
import { TramSheetHeader } from '@/components/tram/TramSheetHeader';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Tram } from '@/constants/theme';
import { getRuntime, useLoadedGeometries, useTramState } from '@/hooks/tramData';
import type { TramPublicState } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';

function SectionHeader({ title }: { title: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <Text style={[styles.sectionHeader, { color: Colors[scheme].textSecondary }]}>
      {title.toUpperCase()}
    </Text>
  );
}

// ── photos-of-this-car row ───────────────────────────────────────────────────

/**
 * Compact sibling of AboutTramRow: opens /tram-photos/[reg] — community
 * photo history of this PHYSICAL car (TransPhoto) by registration number.
 * Rendered only when the feed exposes a registration number.
 */
function PhotosRow({ reg, onPress }: { reg: number; onPress: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const cardFill = scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.55)';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.photosRow,
        { backgroundColor: cardFill },
        pressed && { opacity: 0.7 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Photos of this car, number ${reg}, from TransPhoto`}
    >
      <View style={styles.photosIcon}>
        <SymbolView name="photo.on.rectangle.angled" size={20} tintColor={Tram.gold} />
      </View>
      <View style={styles.photosTextCol}>
        <Text style={[styles.photosTitle, { color: c.text }]} numberOfLines={1}>
          Photos of this car
        </Text>
        <Text style={[styles.photosSubtitle, { color: c.textSecondary }]} numberOfLines={1}>
          Spotter shots of #{reg} · TransPhoto
        </Text>
      </View>
      <SymbolView name="chevron.right" size={13} tintColor={c.textSecondary} />
    </Pressable>
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

  // Opening the sheet engages follow on this tram — no cleanup: follow persists
  // after close (unfollow is the FollowChip ✕'s job). setFollowTramKey clears
  // followPaused, so this always lands as a live follow.
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

  const onFavorite = () => {
    void Haptics.selectionAsync();
    toggleTram(key);
  };

  const onShowLine = () => {
    if (state) router.push(`/line/${state.snapshot.line}`);
  };

  const onAbout = () => {
    if (state) router.push(`/model-info/${state.model.id}`);
  };

  return (
    <GlassPanel style={styles.root}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <SheetContent style={styles.content}>
        {!state && !gone && (
          <View style={styles.goneWrap}>
            <SymbolView name="antenna.radiowaves.left.and.right" size={36} tintColor={c.textSecondary} />
            <Text style={[styles.goneSubtitle, { color: c.textSecondary }]}>Locating tram…</Text>
          </View>
        )}

        {!state && gone && <GoneState lastState={lastStateRef.current} />}

        {state && (
          <>
            {/* Portrait-card header: badge + headsign + caption line on the
                left, TramFace glass squircle (→ 3D viewer) on the right, then
                the Favorite | Line N | About capsule. */}
            <TramSheetHeader
              state={state}
              isFavorite={isFavorite}
              onFavorite={onFavorite}
              onShowLine={onShowLine}
              onAbout={onAbout}
            />

            {/* Upcoming stops — collapsed to the next 5 so the NEXT row's
                ticking ETA stays inside the 0.38 peek. */}
            <SectionHeader title="Upcoming stops" />
            <StopsTimeline
              geometry={geometry}
              simDistM={state.simDistM}
              delaySeconds={state.snapshot.delaySeconds}
              phase={state.phase}
              nextStopEtaS={state.nextStopEtaS}
              collapsible
            />

            {/* Record ride — real-vs-sim telemetry (survives sheet close) */}
            <RideRecorder tramKey={key} line={state.snapshot.line} />

            {/* Second door to the model reference screen, carrying the
                per-vehicle amenities the per-model screen can't know. */}
            <AboutTramRow model={state.model} snapshot={state.snapshot} onPress={onAbout} />

            {/* Community photo history of this physical car (TransPhoto) —
                only when the feed exposes a registration number. */}
            {state.snapshot.registrationNumber != null && (
              <PhotosRow
                reg={state.snapshot.registrationNumber}
                onPress={() =>
                  router.push(`/tram-photos/${state.snapshot.registrationNumber}`)
                }
              />
            )}
          </>
        )}
        </SheetContent>
      </ScrollView>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    gap: 12,
    paddingBottom: 48,
    paddingHorizontal: 18,
    paddingTop: 14,
  },
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
  photosIcon: { alignItems: 'center', width: 28 },
  photosRow: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  photosSubtitle: { fontSize: 12 },
  photosTextCol: { flex: 1, gap: 1 },
  photosTitle: { fontSize: 15, fontWeight: '600' },
});
