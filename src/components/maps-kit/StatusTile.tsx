// The weather/AQI-style rounded-square glass tile top-left (all screenshots):
// two stacked micro-rows on one small glass square. MapChrome's live-status chip
// is rebuilt on it — tram.fill + count (top) over a LIVE/STALE dot (bottom) —
// and tapping reveals the "updated N s ago" detail. Appearance is supplied by
// the system-themed map chrome context.
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Radii } from '@/constants/theme';

export interface StatusTileProps {
  topRow: ReactNode;
  bottomRow: ReactNode;
  onPress?: () => void;
  /** Revealed under the two rows on tap. */
  expandedDetail?: ReactNode;
  appearance: 'light' | 'dark';
  /**
   * Accessibility label for the whole tile. The `topRow`/`bottomRow` nodes are
   * swallowed (the tile is one a11y element), so `label` must already carry the
   * live status a sighted user reads there (count, stale/offline/paused).
   */
  label: string;
  /**
   * Spoken form of the disclosure's `expandedDetail` (which is otherwise
   * unreachable). Announced in place of the generic hint once expanded, so the
   * control is not a no-op for VoiceOver.
   */
  detailLabel?: string;
}

export function StatusTile({
  topRow,
  bottomRow,
  onPress,
  expandedDetail,
  appearance,
  label,
  detailLabel,
}: StatusTileProps) {
  const [expanded, setExpanded] = useState(false);
  const disclosable = expandedDetail != null;
  return (
    <GlassPanel
      variant="regular"
      interactive
      readableOverContent
      appearance={appearance}
      style={styles.tile}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          disclosable
            ? `${label}, ${
                expanded ? (detailLabel ?? 'showing feed details') : 'double tap for feed details'
              }`
            : label
        }
        accessibilityState={disclosable ? { expanded } : undefined}
        hitSlop={6}
        onPress={() => {
          if (disclosable) setExpanded((e) => !e);
          onPress?.();
        }}
        style={styles.body}
      >
        <View style={styles.microRow}>{topRow}</View>
        {bottomRow != null && <View style={styles.microRow}>{bottomRow}</View>}
        {/* A disclosure, not a jump cut: the tile floats over a moving map, so an
            instant height change reads as a glitch. Reduce Motion is honoured by
            the transition config itself. */}
        {expanded && disclosable && (
          <Animated.View
            style={styles.detail}
            entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
          >
            {expandedDetail}
          </Animated.View>
        )}
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
