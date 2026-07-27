// The home sheet's pinned search row — the iOS 26 Apple-Maps peek bar.
//
// Reference (Apple Maps on iOS 26, captured on-simulator): a recessed, capsule
// search FIELD filling the row — leading magnifier, LEFT-ALIGNED placeholder —
// beside a separate circular account/settings button of the exact same height.
// Both sit on the sheet's own glass, inset a little from the card's edges.
//
// Apple's field also carries a trailing voice mic; ours does not, because this
// app has no dictation. A mic glyph that opens the same keyboard the whole field
// opens is a promise the app cannot keep, so it is gone rather than faked.
//
// APPEARANCE: this row follows the SYSTEM color scheme, like everything else on
// the sheet. It used to follow the MAP's light preset (`chromeScheme`) while the
// sheet surface followed the system scheme — so a dark-mode phone over a daytime
// map rendered a BLACK gear on a dark surface (the reported bug). The chrome
// that genuinely floats over the basemap (status tile, control column, chips)
// still follows the map preset; this row is on an app surface, so it does not.
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { SEARCH_H } from '@/components/maps-kit/mapSheetLayout';
import { appleScheme, Radii, TextScale, Type } from '@/constants/theme';
import { SETTINGS_D, SHEET_H_PAD } from '@/components/home/homeMetrics';

export function HomeSearchRow() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  // A RECESSED fill, not another pane of glass: the field sits ON the sheet's
  // glass, and HIG is explicit that stacking Liquid Glass on Liquid Glass muddies
  // the hierarchy. Apple Maps' own field is exactly this — a subtle darker inset
  // inside the glass sheet.
  const fieldBg = scheme === 'dark' ? 'rgba(118,118,128,0.28)' : 'rgba(118,118,128,0.16)';

  return (
    <View style={styles.row}>
      {/* A button, not a field: it accepts no text, it presents /search. Typing
          the search-field trait here tells VoiceOver the opposite. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search lines, trams and stops"
        accessibilityHint="Opens search"
        onPress={() => router.push('/search')}
        style={({ pressed }) => [
          styles.field,
          { backgroundColor: fieldBg, opacity: pressed ? 0.65 : 1 },
        ]}
      >
        {/* 16, down from 17: the field lost 8 pt of height (SEARCH_H 48 → 40),
            and a glyph sized for the taller capsule crowded it. Apple's own
            magnifier measures ~16 across in a 39–42.7 pt field. */}
        <SymbolView name="magnifyingglass" size={16} weight="semibold" tintColor={c.secondary} />
        {/* LEFT-aligned, immediately after the glyph — Apple Maps' placeholder is
            not centered. `flex: 1` lets it own the rest of the capsule. */}
        <Text
          style={[styles.placeholder, { color: c.secondary }]}
          numberOfLines={1}
          maxFontSizeMultiplier={TextScale.compact}
        >
          Search trams & stops
        </Text>
      </Pressable>

      {/* EXACTLY the field's height and therefore a perfect circle beside a
          perfect stadium — one shape family, one baseline, one radius rule.
          There is no longer a slot wrapping a smaller disc: the pressable IS the
          circle, so the visible button and the tap target are the same object.
          See SETTINGS_D for why the earlier smaller-by-ratio disc was wrong. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        style={({ pressed }) => [
          styles.settings,
          { backgroundColor: fieldBg, opacity: pressed ? 0.65 : 1 },
        ]}
      >
        {/* tintColor follows the SYSTEM scheme now — this is the icon that used
            to render black on a dark sheet. 18, down from 20: the disc shrank
            with the field, and 20 left the gear almost touching its edge. */}
        <SymbolView name="gearshape.fill" size={18} tintColor={c.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: SHEET_H_PAD,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    // minHeight, not height: at large Dynamic Type sizes the capsule grows
    // instead of clipping the placeholder. The sheet measures the header, so a
    // taller row simply raises the peek detent. (The settings circle stays a
    // fixed SETTINGS_D — it must remain a CIRCLE, and a growing field is the one
    // case where the two heights legitimately part company.)
    minHeight: SEARCH_H,
    paddingHorizontal: 13,
    // A true stadium at any height (iOS clamps the radius to half the shorter
    // side). `borderCurve: 'continuous'` is deliberately NOT used — it is meant
    // for rounded rectangles, and on a capsule it renders a squircle whose
    // silhouette reads as lopsided next to the perfectly circular settings button.
    borderRadius: Radii.circle,
  },
  placeholder: { flex: 1, ...Type.body },
  // SETTINGS_D === SEARCH_H, so this is a true circle exactly as tall as the
  // field's capsule. Same `borderRadius = h/2` rule, same fill, same baseline.
  settings: {
    width: SETTINGS_D,
    height: SETTINGS_D,
    borderRadius: SETTINGS_D / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
