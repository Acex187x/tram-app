// /rides form sheet — every recorded ride (including interrupted/orphaned ones),
// newest first, re-skinned to Apple Maps' grouped-inset list (IMG_0076): a
// large-title SheetHeader with a circular X, LineBadge-led rows with a
// date/duration subtitle, and a trailing ellipsis that opens the native
// Preview/Export menu. Tapping a row still parses the ride's JSONL and previews
// it on the MAIN map (RideOverlay draws GPS vs sim; the RideChip clears it),
// dismissing the sheets — every data flow is unchanged, this is chrome only.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Fragment, useMemo } from 'react';
import {
  ActionSheetIOS,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { LineBadge } from '@/components/ui/LineBadge';
import { InsetGroup, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { SheetHeader } from '@/components/ui/SheetHeader';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { appleScheme, Tram } from '@/constants/theme';
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
  return (
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  );
}

function fmtDuration(ride: ParsedRide): string {
  if (ride.startedMs == null || ride.endedMs == null) return '—';
  const total = Math.max(0, Math.round((ride.endedMs - ride.startedMs) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min` : `${s} s`;
}

function RideRow({ entry }: { entry: RideEntry }) {
  const c = appleScheme(useColorScheme() === 'dark' ? 'dark' : 'light');
  const { file, ride } = entry;

  const onPreview = () => {
    void Haptics.selectionAsync();
    useRidePreviewStore.getState().setPreview({ relPath: file.relPath, name: file.name, ride });
    // Back to the map — the overlay draws there.
    router.dismissAll();
  };

  const onExport = () => {
    void Haptics.selectionAsync();
    void Share.share({ url: file.uri }).catch(() => {});
  };

  const onMore = () => {
    const options = ['Preview on map', 'Export…', 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: file.name, options, cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) onPreview();
        else if (index === 1) onExport();
      },
    );
  };

  const title =
    [
      ride.line ? `Line ${ride.line}` : null,
      ride.model ? ride.model.toUpperCase() : null,
      ride.tramKey ? `#${ride.tramKey}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || file.name;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Preview ride ${file.name} on the map`}
      onPress={onPreview}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <LineBadge line={ride.line ?? '?'} size="sm" />
      <View style={styles.rowText}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
            {title}
          </Text>
          {ride.orphaned && (
            <View style={styles.orphanBadge}>
              <SymbolView name="exclamationmark.triangle.fill" size={10} tintColor="#FFFFFF" />
              <Text style={styles.orphanLabel}>interrupted</Text>
            </View>
          )}
        </View>
        <Text style={[styles.subtitle, { color: c.secondary }]} numberOfLines={1}>
          {fmtWhen(ride.startedMs)} · {fmtDuration(ride)} · {ride.points} pts · {fmtBytes(file.size)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Ride ${file.name} options`}
        hitSlop={8}
        onPress={onMore}
        style={({ pressed }) => [
          styles.moreBtn,
          { backgroundColor: c.fillSecondary },
          pressed && styles.pressed,
        ]}
      >
        <SymbolView name="ellipsis" size={15} weight="semibold" tintColor={c.secondary} />
      </Pressable>
    </Pressable>
  );
}

export default function RidesScreen() {
  const c = appleScheme(useColorScheme() === 'dark' ? 'dark' : 'light');
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
    <SheetSurface header={<SheetHeader title="Recorded rides" />}>
      {entries.length === 0 ? (
        <View style={styles.empty}>
          <SymbolView name="record.circle" size={46} weight="light" tintColor={Tram.veryLate} />
          <Text style={[styles.emptyTitle, { color: c.text }]}>No rides recorded</Text>
          <Text style={[styles.emptyHint, { color: c.secondary }]}>
            Open a tram you are riding and tap Record ride — the GPS vs. simulation track will be
            stored here, safe across restarts.
          </Text>
        </View>
      ) : (
        <View style={styles.section}>
          <SectionLabel>Tap a ride to preview it on the map</SectionLabel>
          <InsetGroup>
            {entries.map((entry, i) => (
              <Fragment key={entry.file.relPath}>
                {i > 0 && <RowSeparator inset={SEPARATOR_INSET} />}
                <RideRow entry={entry} />
              </Fragment>
            ))}
          </InsetGroup>
        </View>
      )}
    </SheetSurface>
  );
}

const SEPARATOR_INSET = 58;

const styles = StyleSheet.create({
  section: { gap: 8 },
  pressed: { opacity: 0.55 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  rowText: { flex: 1, gap: 2 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { flexShrink: 1, fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 13 },
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
  moreBtn: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  empty: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 32,
    paddingVertical: 56,
  },
  emptyTitle: { fontSize: 22, fontWeight: '700', marginTop: 6 },
  emptyHint: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
