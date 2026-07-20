// The weather/AQI-style rounded-square glass tile top-left (all screenshots):
// two stacked micro-rows on one small glass square. MapChrome's live-status chip
// is rebuilt on it — tram.fill + count (top) over a LIVE/STALE dot (bottom) —
// and tapping reveals the "updated N s ago" detail. Chrome floats over the
// basemap, so appearance follows the MAP light preset (required, not optional).
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Radii } from '@/constants/theme';

export interface StatusTileProps {
  topRow: ReactNode;
  bottomRow: ReactNode;
  onPress?: () => void;
  /** Revealed under the two rows on tap. */
  expandedDetail?: ReactNode;
  appearance: 'light' | 'dark';
  /** Accessibility label for the whole tile. */
  label: string;
}

export function StatusTile({
  topRow,
  bottomRow,
  onPress,
  expandedDetail,
  appearance,
  label,
}: StatusTileProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <GlassPanel variant="regular" interactive appearance={appearance} style={styles.tile}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={6}
        onPress={() => {
          if (expandedDetail != null) setExpanded((e) => !e);
          onPress?.();
        }}
        style={styles.body}
      >
        <View style={styles.microRow}>{topRow}</View>
        {bottomRow != null && <View style={styles.microRow}>{bottomRow}</View>}
        {expanded && expandedDetail != null && <View style={styles.detail}>{expandedDetail}</View>}
      </Pressable>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: Radii.card, borderCurve: 'continuous' },
  body: { paddingHorizontal: 11, paddingVertical: 9, gap: 3, minWidth: 60 },
  microRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  detail: { marginTop: 3 },
});
