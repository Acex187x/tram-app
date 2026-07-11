// /favorites form sheet — starred trams (with live in-service status) and
// starred lines (with live active-tram counts), floating over the live map.
// On iPad the content column is capped and the lines become a 2-up grid.
import { SymbolView } from 'expo-symbols';
import { Fragment, useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  FavoriteLineRow,
  LINE_ROW_SEPARATOR_INSET,
} from '@/components/favorites/FavoriteLineRow';
import {
  FavoriteTramRow,
  TRAM_ROW_SEPARATOR_INSET,
} from '@/components/favorites/FavoriteTramRow';
import {
  InlineHint,
  InsetGroup,
  RowSeparator,
  SectionLabel,
} from '@/components/favorites/InsetGroup';
import { SheetHeader } from '@/components/favorites/SheetHeader';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SheetContent, SHEET_CONTENT_MAX_WIDTH } from '@/components/ui/SheetContent';
import { Colors, Tram } from '@/constants/theme';
import { useAllTramStates } from '@/hooks/tramData';
import { useFavoritesStore } from '@/stores/favorites';

export default function FavoritesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const favoriteTrams = useFavoritesStore((s) => s.favoriteTrams);
  const favoriteLines = useFavoritesStore((s) => s.favoriteLines);
  const states = useAllTramStates();
  // iPad: the sheet glass is full-width; grid-ify the lines section when the
  // (already width-capped) content column is wide enough for two columns.
  const { width } = useWindowDimensions();
  const gridLines = width > SHEET_CONTENT_MAX_WIDTH;

  const trams = useMemo(
    () => [...favoriteTrams].sort((a, b) => Number(a) - Number(b)),
    [favoriteTrams],
  );
  const lines = useMemo(
    () => [...favoriteLines].sort((a, b) => Number(a) - Number(b)),
    [favoriteLines],
  );
  const lineCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of states) {
      counts.set(s.snapshot.line, (counts.get(s.snapshot.line) ?? 0) + 1);
    }
    return counts;
  }, [states]);

  const nothingStarred = trams.length === 0 && lines.length === 0;

  return (
    <GlassPanel style={styles.sheet}>
      <SheetContent>
        <SheetHeader title="Favorites" />
      </SheetContent>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.scrollBottom}
        showsVerticalScrollIndicator={false}
      >
        <SheetContent style={styles.content}>
        {nothingStarred ? (
          <View style={styles.empty}>
            <SymbolView name="star" size={46} weight="light" tintColor={Tram.gold} />
            <Text style={[styles.emptyTitle, { color: palette.text }]}>
              No favorites yet
            </Text>
            <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
              Spot a tram on the map and star it — your trams and lines will keep
              their place here, live status included.
            </Text>
          </View>
        ) : (
          <>
            <View>
              <SectionLabel>Trams</SectionLabel>
              <InsetGroup>
                {trams.length === 0 ? (
                  <InlineHint icon="star" text="Spot a tram on the map and star it." />
                ) : (
                  trams.map((reg, i) => (
                    <Fragment key={reg}>
                      {i > 0 ? <RowSeparator inset={TRAM_ROW_SEPARATOR_INSET} /> : null}
                      <FavoriteTramRow regKey={reg} />
                    </Fragment>
                  ))
                )}
              </InsetGroup>
            </View>

            <View>
              <SectionLabel>Lines</SectionLabel>
              <InsetGroup>
                {lines.length === 0 ? (
                  <InlineHint
                    icon="star"
                    text="Open a line from any tram and star it to track it here."
                  />
                ) : gridLines ? (
                  <View style={styles.lineGrid}>
                    {lines.map((line) => (
                      <View key={line} style={styles.lineGridCell}>
                        <FavoriteLineRow line={line} activeCount={lineCounts.get(line) ?? 0} />
                      </View>
                    ))}
                  </View>
                ) : (
                  lines.map((line, i) => (
                    <Fragment key={line}>
                      {i > 0 ? <RowSeparator inset={LINE_ROW_SEPARATOR_INSET} /> : null}
                      <FavoriteLineRow line={line} activeCount={lineCounts.get(line) ?? 0} />
                    </Fragment>
                  ))
                )}
              </InsetGroup>
            </View>
          </>
        )}
        </SheetContent>
      </ScrollView>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
  },
  scrollBottom: {
    paddingBottom: 48,
  },
  content: {
    gap: 24,
    padding: 16,
  },
  lineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  lineGridCell: {
    width: '50%',
  },
  empty: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 32,
    paddingVertical: 56,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 6,
  },
  emptyHint: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
});
