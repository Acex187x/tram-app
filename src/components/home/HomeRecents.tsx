// The "Recents" inset group on the home sheet (IMG_0073): the persisted recent
// planner routes, each an inset row with a leading route glyph, "From → To",
// and an ellipsis menu (re-plan / remove). Tapping a row re-opens the planner
// pre-filled with that pair and auto-plans — the same one-shot prefill handoff
// the stop sheet's "Route here" uses, so the data flow is unchanged.
import { ActionSheetIOS, Platform } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native';

import { InsetGroup, InsetRow, RowSeparator } from '@/components/ui/Inset';
import { appleScheme, Apple } from '@/constants/theme';
import { usePlannerStore } from '@/stores/planner';

export function HomeRecents() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const recents = usePlannerStore((s) => s.recents);
  const removeRecent = usePlannerStore((s) => s.removeRecent);
  const requestPrefill = usePlannerStore((s) => s.requestPrefill);

  if (recents.length === 0) return null;

  const replan = (from: string, to: string) => {
    requestPrefill(from, to);
    router.push('/planner');
  };

  const openMenu = (from: string, to: string) => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: `${from} → ${to}`,
          options: ['Plan Route', 'Remove from Recents', 'Cancel'],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
        },
        (i) => {
          if (i === 0) replan(from, to);
          else if (i === 1) removeRecent(from, to);
        },
      );
    } else {
      removeRecent(from, to);
    }
  };

  return (
    <InsetGroup>
      {recents.map((r, i) => (
        <View key={`${r.from}→${r.to}`}>
          {i > 0 && <RowSeparator inset={56} />}
          <InsetRow
            icon="arrow.triangle.swap"
            iconTint={Apple.blue}
            title={r.from}
            subtitle={r.to}
            onPress={() => replan(r.from, r.to)}
            trailing={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Options for route ${r.from} to ${r.to}`}
                hitSlop={10}
                style={styles.ellipsis}
                onPress={() => openMenu(r.from, r.to)}
              >
                <SymbolView name="ellipsis" size={17} weight="semibold" tintColor={c.secondary} />
              </Pressable>
            }
          />
        </View>
      ))}
    </InsetGroup>
  );
}

const styles = StyleSheet.create({
  ellipsis: { paddingHorizontal: 4, paddingVertical: 4 },
});
