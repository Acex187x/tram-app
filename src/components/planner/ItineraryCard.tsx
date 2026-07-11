// One planned itinerary as a tappable card: legs rendered as
// [LineBadge → towards <stop> · N stops] with transfer dots between legs,
// and a totals footer. Tap = draw on the map.
import { SymbolView } from 'expo-symbols';
import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Spacing, Tram } from '@/constants/theme';
import type { PlannerItinerary } from '@/lib/types';

export interface ItineraryCardProps {
  itinerary: PlannerItinerary;
  onPress: () => void;
}

export function ItineraryCard({ itinerary, onPress }: ItineraryCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const separatorColor = scheme === 'dark' ? 'rgba(84,84,88,0.5)' : 'rgba(60,60,67,0.24)';
  const accent = scheme === 'dark' ? Tram.gold : Tram.pidRed;
  const { legs, totalStops, transferCount } = itinerary;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Route with ${totalStops} stops and ${transferCount} transfers. Show on map.`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.62)',
          opacity: pressed ? 0.65 : 1,
        },
      ]}
    >
      {legs.map((leg, i) => (
        <Fragment key={`${i}-${leg.line}-${leg.fromStopId}`}>
          {i > 0 && (
            <View style={styles.transferRow}>
              <View style={styles.dotsCol}>
                <View style={[styles.dot, { backgroundColor: palette.textSecondary }]} />
                <View style={[styles.dot, { backgroundColor: palette.textSecondary }]} />
              </View>
              <Text numberOfLines={1} style={[styles.transferText, { color: palette.textSecondary }]}>
                Transfer at {leg.fromStopName}
              </Text>
            </View>
          )}
          <View style={styles.legRow}>
            <LineBadge line={leg.line} size="sm" />
            <Text numberOfLines={1} style={[styles.legText, { color: palette.text }]}>
              towards <Text style={styles.legDestination}>{leg.toStopName}</Text>
            </Text>
            <Text style={[styles.legStops, { color: palette.textSecondary }]}>
              {leg.stopCount} {leg.stopCount === 1 ? 'stop' : 'stops'}
            </Text>
          </View>
        </Fragment>
      ))}

      <View style={[styles.footer, { borderTopColor: separatorColor }]}>
        <Text style={[styles.footerTotals, { color: palette.textSecondary }]}>
          {totalStops} {totalStops === 1 ? 'stop' : 'stops'} ·{' '}
          {transferCount === 0 ? 'Direct' : `${transferCount} ${transferCount === 1 ? 'transfer' : 'transfers'}`}
        </Text>
        <View style={styles.footerAction}>
          <Text style={[styles.footerActionText, { color: accent }]}>Show on map</Text>
          <SymbolView name="chevron.right" size={11} weight="semibold" tintColor={accent} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 4,
  },
  legRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two + 2,
    minHeight: 32,
  },
  legText: {
    flex: 1,
    fontSize: 15,
  },
  legDestination: {
    fontWeight: '600',
  },
  legStops: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  transferRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.one,
  },
  dotsCol: {
    alignItems: 'center',
    gap: 3,
    width: 22, // aligns under the sm LineBadge
  },
  dot: {
    borderRadius: 1.5,
    height: 3,
    width: 3,
  },
  transferText: {
    flex: 1,
    fontSize: 12,
  },
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    marginTop: Spacing.two + 2,
    paddingTop: Spacing.two + 2,
  },
  footerTotals: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  footerAction: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3,
    marginLeft: 'auto',
  },
  footerActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
