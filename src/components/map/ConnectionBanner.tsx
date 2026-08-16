// The connection-honesty banner (docs/research/physics-v3-protocol.md
// §"Connection honesty" — the protocol's non-negotiable #4).
//
// Physics v3 moved every prediction to the server, which means the app has
// exactly one failure mode worth being loud about: the data stopped arriving.
// When that happens the trams follow their published curves to the horizon and
// then FREEZE, dimmed (TramLayers' `stale` styling) — and this banner says so
// in words, because a frozen fleet on a live-looking map is a lie.
//
// Three states, driven by BUNDLE AGE rather than fetch outcomes, so a server
// that keeps answering 200 OK with twenty-minute-old data still reads as
// offline:
//   live      nothing rendered — zero cost.
//   degraded  a small amber dot + "данные задерживаются"; trams keep moving
//             along their curves, so this stays deliberately quiet.
//   offline   the explicit banner.
//
// Cadence: one 1 Hz subscription (useConnectionState), no timers of its own,
// and it renders null in the common case — perf invariant #1.

import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Spacing, Tram, Type } from '@/constants/theme';
import { useConnectionState } from '@/hooks/tramData';
import { OFFLINE_BANNER_TEXT } from '@/lib/physics/connection';

/** Copy for the quiet middle state — trams are still following real curves. */
const DEGRADED_TEXT = 'Данные задерживаются';

/**
 * Vertical clearance below the top inset, pt — the banner sits directly under
 * the MapStatusTile (which starts at insets.top + Spacing.two and is ~56 pt
 * tall) and shares its left inset, so the two read as one status column.
 */
const STATUS_TILE_CLEARANCE = 66;

export function ConnectionBanner({ leftInset }: { leftInset: number }) {
  const connection = useConnectionState();
  const insets = useSafeAreaInsets();
  if (connection === 'live') return null;

  const offline = connection === 'offline';
  return (
    <View
      pointerEvents="none"
      style={[
        styles.wrap,
        { top: insets.top + STATUS_TILE_CLEARANCE, left: leftInset, right: Spacing.three },
      ]}
      accessibilityLiveRegion="polite"
    >
      <GlassPanel style={styles.panel} readableOverContent>
        <View style={styles.row}>
          <SymbolView
            name={offline ? 'antenna.radiowaves.left.and.right.slash' : 'clock.badge.exclamationmark'}
            size={14}
            weight="semibold"
            tintColor={offline ? Tram.veryLate : Tram.late}
          />
          <Text
            style={[styles.text, { color: offline ? Tram.veryLate : Tram.late }]}
            numberOfLines={2}
          >
            {offline ? OFFLINE_BANNER_TEXT : DEGRADED_TEXT}
          </Text>
        </View>
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', alignItems: 'flex-start' },
  panel: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderRadius: 999 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  text: { ...Type.footnote, fontWeight: '600', flexShrink: 1 },
});
