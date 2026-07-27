// Recent journey searches as an Apple Maps inset group (IMG_0072/80): rounded
// glass card, each row a clock-circle icon over "from → to", tapping the row
// prefills + plans, a trailing button forgets it. That button is a NEUTRAL
// xmark, not the red minus: on iOS the filled red minus is the list editing-
// mode delete control and never appears at rest.
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { InsetGroup, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { appleScheme } from '@/constants/theme';
import type { RecentRoute } from '@/stores/planner';

export interface RecentRoutesProps {
  recents: RecentRoute[];
  /** Prefill both fields with this pair and plan immediately. */
  onPick: (from: string, to: string) => void;
  /** Forget this pair. */
  onRemove: (from: string, to: string) => void;
}

export function RecentRoutes({ recents, onPick, onRemove }: RecentRoutesProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  if (recents.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <SectionLabel>Recents</SectionLabel>
      <InsetGroup>
        {recents.map((r, i) => (
          <Fragment key={`${r.from} ${r.to}`}>
            {i > 0 && <RowSeparator inset={56} />}
            <View style={styles.row}>
              <Pressable
                onPress={() => onPick(r.from, r.to)}
                accessibilityRole="button"
                accessibilityLabel={`Plan ${r.from} to ${r.to}`}
                style={({ pressed }) => [styles.pickArea, pressed && styles.pressed]}
              >
                <View style={[styles.iconCircle, { backgroundColor: scheme === 'dark' ? '#48484A' : '#8E8E93' }]}>
                  <SymbolView name="clock.arrow.circlepath" size={16} weight="semibold" tintColor="#FFFFFF" />
                </View>
                <View style={styles.textCol}>
                  <Text numberOfLines={1} style={[styles.routeTo, { color: c.text }]}>
                    {r.to}
                  </Text>
                  <Text numberOfLines={1} style={[styles.routeFrom, { color: c.secondary }]}>
                    from {r.from}
                  </Text>
                </View>
              </Pressable>
              <Pressable
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onRemove(r.from, r.to);
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${r.from} to ${r.to} from recents`}
                style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
              >
                <SymbolView name="xmark.circle.fill" size={22} type="hierarchical" tintColor={c.secondary} />
              </Pressable>
            </View>
          </Fragment>
        ))}
      </InsetGroup>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 56,
    paddingRight: 14,
  },
  pickArea: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  iconCircle: {
    alignItems: 'center',
    borderRadius: 14.5,
    height: 29,
    justifyContent: 'center',
    width: 29,
  },
  textCol: {
    flex: 1,
    gap: 1,
  },
  routeTo: {
    fontSize: 17,
    fontWeight: '400',
  },
  routeFrom: {
    fontSize: 13,
  },
  removeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 8,
    paddingVertical: 8,
  },
  pressed: { opacity: 0.55 },
});
