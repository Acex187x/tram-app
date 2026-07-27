// /favorites form sheet — starred trams (with live in-service status) and
// starred lines (with live active-tram counts), floating over the live map.
// On iPad the content column is capped and the lines become a 2-up grid.
//
// Apple-Maps re-skin: a SheetSurface scaffold with a large-title SheetHeader and
// home-sheet-style grouped inset sections (uppercase section labels + rounded
// inset cards with hairline separators). Live-status data flows are unchanged.
import { Host } from '@expo/ui';
import { ContentUnavailableView } from '@expo/ui/swift-ui';
import { Fragment, useMemo } from 'react';
import { StyleSheet, useColorScheme, useWindowDimensions, View } from 'react-native';

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
} from '@/components/ui/Inset';
import { SheetHeader } from '@/components/ui/SheetHeader';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { SHEET_CONTENT_MAX_WIDTH } from '@/components/ui/SheetContent';
import { appleScheme } from '@/constants/theme';
import { useAllTramStates } from '@/hooks/tramData';
import { useFavoritesStore } from '@/stores/favorites';

export default function FavoritesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
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
  /** First index of the grid's last row — cells at or after it get no hairline. */
  const lastGridRowStart = Math.floor((lines.length - 1) / 2) * 2;

  return (
    <SheetSurface header={<SheetHeader title="Favorites" />}>
      {/* Empty state hosts SwiftUI with matchContents VERTICAL ONLY: with both
          axes the host adopts the view's "natural" width and lays out offset to
          the right, clipping the glyph and copy at the sheet edge (verified in
          dark mode). Width must come from the RN column so it centres. */}
      {nothingStarred ? (
        <Host matchContents={{ vertical: true }} style={styles.empty}>
          <ContentUnavailableView
            systemImage="star"
            title="No favorites yet"
            description="Spot a tram on the map and star it — your trams and lines will keep their place here, live status included."
          />
        </Host>
      ) : (
        <>
          <View style={styles.section}>
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

          <View style={styles.section}>
            <SectionLabel>Lines</SectionLabel>
            <InsetGroup>
              {lines.length === 0 ? (
                <InlineHint
                  icon="star"
                  text="Open a line from any tram and star it to track it here."
                />
              ) : gridLines ? (
                <View style={styles.lineGrid}>
                  {lines.map((line, i) => (
                    <View
                      key={line}
                      style={[
                        styles.lineGridCell,
                        // Grouped-card hairlines: a rule between the columns
                        // (only where there IS a right neighbour) and one under
                        // every row but the last.
                        i % 2 === 0 &&
                          i + 1 < lines.length && {
                          borderRightWidth: StyleSheet.hairlineWidth,
                          borderRightColor: c.separator,
                        },
                        i < lastGridRowStart && {
                          borderBottomWidth: StyleSheet.hairlineWidth,
                          borderBottomColor: c.separator,
                        },
                      ]}
                    >
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
    </SheetSurface>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  lineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  lineGridCell: {
    width: '50%',
  },
  empty: { paddingVertical: 56 },
});
