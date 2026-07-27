// /rides form sheet — every recorded ride (including interrupted/orphaned ones),
// newest first, re-skinned to Apple Maps' grouped-inset list (IMG_0076): a
// large-title SheetHeader with a circular X, LineBadge-led rows with a
// date/duration subtitle, and a trailing ellipsis that opens the native
// Preview/Export menu. Tapping a row still parses the ride's JSONL and previews
// it on the MAIN map (RideOverlay draws GPS vs sim; the RideChip clears it),
// dismissing the sheets — every data flow is unchanged, this is chrome only.
import { Host } from '@expo/ui';
import { ContentUnavailableView } from '@expo/ui/swift-ui';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
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

/** VoiceOver route to the ellipsis menu — the row itself is one a11y element. */
const ROW_ACTIONS = [{ name: 'more', label: 'Ride options' }];

/**
 * Parsed rides keyed by relPath, stamped with `size:modifiedMs`. Ride files are
 * append-only, so that stamp identifies content exactly: only the file being
 * recorded into is ever re-parsed, instead of the whole directory on every
 * MotionLog version bump (~1 Hz while a ride records).
 */
const parseCache = new Map<string, { stamp: string; ride: ParsedRide }>();

/**
 * `MotionLog.readRideFile` bottoms out in `File.textSync()`, which would block
 * the JS thread while this sheet animates up — read the uri asynchronously.
 */
async function loadRide(file: MotionFileInfo): Promise<ParsedRide> {
  const stamp = `${file.size}:${file.modifiedMs}`;
  const hit = parseCache.get(file.relPath);
  if (hit != null && hit.stamp === stamp) return hit.ride;
  let text = '';
  try {
    const handle = new File(file.uri);
    if (handle.exists) text = await handle.text();
  } catch {
    // unreadable file — the row still renders from its metadata
  }
  const ride = parseRideFile(text);
  parseCache.set(file.relPath, { stamp, ride });
  return ride;
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
      accessibilityActions={ROW_ACTIONS}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === 'more') onMore();
      }}
      onPress={onPreview}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fillHighlight }]}
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
      {/* Reachable in VoiceOver through the row's 'more' action, not directly. */}
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
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

  const files = useMemo<MotionFileInfo[]>(
    () => log.listRideFiles(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, version],
  );
  // null until the first hydration lands — reading + parsing happens off the
  // render pass so the sheet presentation animation is never blocked.
  const [entries, setEntries] = useState<RideEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded: RideEntry[] = [];
      for (const file of files) loaded.push({ file, ride: await loadRide(file) });
      if (cancelled) return;
      for (const relPath of parseCache.keys()) {
        if (!files.some((f) => f.relPath === relPath)) parseCache.delete(relPath);
      }
      setEntries(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  return (
    <SheetSurface header={<SheetHeader title="Recorded rides" />}>
      {entries == null ? (
        <View style={styles.empty}>
          <ActivityIndicator color={Tram.veryLate} />
          <Text style={[styles.emptyHint, { color: c.secondary }]}>Reading recorded rides…</Text>
        </View>
      ) : entries.length === 0 ? (
        // matchContents VERTICAL ONLY — same defect and fix as favorites.tsx: a
        // both-axes matchContents host lays the empty state out offset to the
        // right and it clips at the sheet edge.
        <Host matchContents={{ vertical: true }} style={styles.empty}>
          <ContentUnavailableView
            systemImage="record.circle"
            title="No rides recorded"
            description="Open a tram you are riding and tap Record ride — the GPS vs. simulation track will be stored here, safe across restarts."
          />
        </Host>
      ) : (
        <View style={styles.section}>
          <SectionLabel>Rides</SectionLabel>
          <InsetGroup>
            {entries.map((entry, i) => (
              <Fragment key={entry.file.relPath}>
                {i > 0 && <RowSeparator inset={SEPARATOR_INSET} />}
                <RideRow entry={entry} />
              </Fragment>
            ))}
          </InsetGroup>
          <Text style={[styles.footnote, { color: c.secondary }]}>
            Tap a ride to preview it on the map.
          </Text>
        </View>
      )}
    </SheetSurface>
  );
}

/** Row padding (16) + the sm LineBadge (30) + the row gap (12) — i.e. the
 *  separator starts where the row's TEXT does, as in every iOS list. Tracks the
 *  row's padding: it was 58 while that padding was 14. */
const SEPARATOR_INSET = 58 + 2;

const styles = StyleSheet.create({
  section: { gap: 8 },
  // A group FOOTER: it sits on the same edge as the SectionLabel above the
  // group, which is now the sheet's content edge (see Inset.tsx). The old
  // marginHorizontal 16 indented it past both the label and the card.
  footnote: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  pressed: { opacity: 0.55 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    // 16, not 14: every other row card in the app (InsetRow, FavoriteTramRow,
    // FavoriteLineRow, FleetRow, RecentRoutes) pads 16, so a ride row was the
    // one list whose content sat 2 pt left of the rest.
    paddingHorizontal: 16,
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
  orphanLabel: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
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
  emptyHint: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
