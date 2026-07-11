// One starred line row: PID badge, live "trams on the move" count, gold star
// to unfavorite, tap navigates to the line sheet.
import * as Haptics from 'expo-haptics';
import { useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { isNightLine, LineBadge } from '@/components/ui/LineBadge';
import { Colors, Tram } from '@/constants/theme';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';

/** Left inset that aligns separators with the row text (padding + leading + gap). */
export const LINE_ROW_SEPARATOR_INSET = 16 + 44 + 12;

export function FavoriteLineRow({
  line,
  activeCount,
}: {
  line: string;
  /** Trams currently in service on this line (computed by the screen). */
  activeCount: number;
}) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const toggleLine = useFavoritesStore((s) => s.toggleLine);
  const setSelectedLineId = useSelectionStore((s) => s.setSelectedLineId);

  const open = (): void => {
    void Haptics.selectionAsync();
    setSelectedLineId(line);
    // Cast: typed-routes d.ts regenerates on the next `expo start`.
    router.push(('/line/' + line) as Href);
  };

  const unstar = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toggleLine(line);
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`Line ${line}, ${
        activeCount > 0 ? `${activeCount} trams in service` : 'no trams right now'
      }`}
      style={({ pressed }) => [
        styles.row,
        pressed && {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
        },
      ]}
    >
      <View style={styles.leading}>
        <LineBadge line={line} size="md" />
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
          {isNightLine(line) ? `Night line ${line}` : `Line ${line}`}
        </Text>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.dot,
              { backgroundColor: activeCount > 0 ? Tram.onTime : palette.textSecondary },
            ]}
          />
          <Text style={[styles.subtitle, { color: palette.textSecondary }]}>
            {activeCount > 0
              ? `${activeCount} tram${activeCount === 1 ? '' : 's'} on the move`
              : 'No trams right now'}
          </Text>
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove line ${line} from favorites`}
        hitSlop={10}
        onPress={unstar}
        style={({ pressed }) => [styles.star, pressed && styles.pressedIcon]}
      >
        <SymbolView name="star.fill" size={20} tintColor={Tram.gold} />
      </Pressable>

      <SymbolView
        name="chevron.right"
        size={13}
        weight="semibold"
        tintColor={palette.textSecondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  leading: {
    alignItems: 'center',
    width: 44,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    borderRadius: 3.5,
    height: 7,
    width: 7,
  },
  subtitle: {
    fontSize: 13,
  },
  star: {
    padding: 2,
  },
  pressedIcon: {
    opacity: 0.5,
  },
});
