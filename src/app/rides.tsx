// /rides form sheet — every recorded ride (including interrupted/orphaned
// ones), newest first: date, line/model, duration, points, size. Tapping a
// ride parses its JSONL and previews it on the MAIN map (RideOverlay draws the
// GPS vs sim tracks; the RideChip in MapChrome clears it), dismissing the
// sheets so the map is visible. Share per row via the export button.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Fragment, useMemo } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { InsetGroup, RowSeparator, SectionLabel } from '@/components/favorites/InsetGroup';
import { SheetHeader } from '@/components/favorites/SheetHeader';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Tram } from '@/constants/theme';
import { useMotionLog, type MotionFileInfo } from '@/lib/motionlog';
import { parseRideFile, type ParsedRide } from '@/lib/motionlog/rideFile';
import { useRidePreviewStore } from '@/stores/ridePreview';

interface RideEntry {
  file: MotionFileInfo;
  ride: ParsedRide;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(ms: number | null): string {
  if (ms == null) return 'Unknown time';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ride: ParsedRide): string {
  if (ride.startedMs == null || ride.endedMs == null) return '—';
  const total = Math.max(0, Math.round((ride.endedMs - ride.startedMs) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min` : `${s} s`;
}

function RideRow({ entry }: { entry: RideEntry }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const { file, ride } = entry;

  const onPreview = () => {
    void Haptics.selectionAsync();
    useRidePreviewStore.getState().setPreview({ relPath: file.relPath, name: file.name, ride });
    // Back to the map — the overlay draws there.
    router.dismissAll();
  };

  const onShare = () => {
    void Haptics.selectionAsync();
    void Share.share({ url: file.uri }).catch(() => {});
  };

  const title = [
    ride.line ? `Line ${ride.line}` : null,
    ride.model ? ride.model.toUpperCase() : null,
    ride.tramKey ? `#${ride.tramKey}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Preview ride ${file.name} on the map`}
      onPress={onPreview}
      style={({ pressed }) => [
        styles.row,
        pressed && {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
        },
      ]}
    >
      <LineBadge line={ride.line ?? '?'} size="sm" />
      <View style={styles.rowText}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
            {title || file.name}
          </Text>
          {ride.orphaned && (
            <View style={styles.orphanBadge}>
              <SymbolView name="exclamationmark.triangle.fill" size={10} tintColor="#FFFFFF" />
              <Text style={styles.orphanLabel}>interrupted</Text>
            </View>
          )}
        </View>
        <Text style={[styles.subtitle, { color: palette.textSecondary }]} numberOfLines={1}>
          {fmtWhen(ride.startedMs)} · {fmtDuration(ride)} · {ride.points} pts · {fmtBytes(file.size)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Share ride ${file.name}`}
        hitSlop={8}
        onPress={onShare}
        style={styles.shareBtn}
      >
        <SymbolView name="square.and.arrow.up" size={17} tintColor={palette.textSecondary} />
      </Pressable>
    </Pressable>
  );
}

export default function RidesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const log = useMotionLog(); // re-renders on ride/file changes
  const version = log.getVersion(); // cache key: files changed -> reparse

  const entries = useMemo<RideEntry[]>(
    () =>
      log.listRideFiles().map((file) => ({
        file,
        ride: parseRideFile(log.readRideFile(file.relPath)),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, version],
  );

  return (
    <GlassPanel style={styles.sheet}>
      <SheetContent>
        <SheetHeader title="Recorded rides" />
      </SheetContent>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.scrollBottom}
        showsVerticalScrollIndicator={false}
      >
        <SheetContent style={styles.content}>
          {entries.length === 0 ? (
            <View style={styles.empty}>
              <SymbolView name="record.circle" size={46} weight="light" tintColor={Tram.veryLate} />
              <Text style={[styles.emptyTitle, { color: palette.text }]}>No rides recorded</Text>
              <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
                Open a tram you are riding and tap Record ride — the GPS vs. simulation track
                will be stored here, safe across restarts.
              </Text>
            </View>
          ) : (
            <View>
              <SectionLabel>Tap a ride to preview it on the map</SectionLabel>
              <InsetGroup>
                {entries.map((entry, i) => (
                  <Fragment key={entry.file.relPath}>
                    {i > 0 ? <RowSeparator inset={SEPARATOR_INSET} /> : null}
                    <RideRow entry={entry} />
                  </Fragment>
                ))}
              </InsetGroup>
            </View>
          )}
        </SheetContent>
      </ScrollView>
    </GlassPanel>
  );
}

const SEPARATOR_INSET = 58;

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  scrollBottom: { paddingBottom: 48 },
  content: { gap: 24, padding: 16 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  rowText: { flex: 1, gap: 2 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 12 },
  orphanBadge: {
    alignItems: 'center',
    backgroundColor: Tram.late,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  orphanLabel: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  shareBtn: { padding: 4 },
  empty: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 32,
    paddingVertical: 56,
  },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginTop: 6 },
  emptyHint: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
