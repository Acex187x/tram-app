// Recent planner routes as inset ROWS — each a leading route glyph, "From → To"
// and an ellipsis menu (re-plan / remove). Tapping a row re-opens the planner
// pre-filled with that pair and auto-plans: the same one-shot prefill handoff
// the stop sheet's "Route here" uses, so the data flow is unchanged.
//
// ROWS, NOT A GROUP. This used to own its own `InsetGroup` and its own "RECENT
// ROUTES" section on the home sheet. It no longer does: recents and the trip
// planner are ONE "Trips" section now (the planner is the last row of the same
// card), so the CALLER owns the group and this component contributes rows to it.
// Everything else — the action sheet, its popover anchors, the VoiceOver custom
// actions — is unchanged.
//
// The leading glyph changed with that merge: `arrow.triangle.swap` in blue now
// belongs to the "Plan a trip" row these rows sit above, and four identical blue
// circles in one card carry no information. A history glyph on the neutral grey
// circle says "you did this before" and leaves the blue for the action.
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef } from 'react';
import {
  ActionSheetIOS,
  findNodeHandle,
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
} from 'react-native';

import { InsetRow, RowSeparator } from '@/components/ui/Inset';
import { appleScheme } from '@/constants/theme';
import { usePlannerStore } from '@/stores/planner';

/** Left inset aligning separators with these rows' text (16 + 29 icon + 12 gap
 *  minus the 1 pt the 29 pt circle sits inboard of a 30 pt badge). Measured for
 *  THIS row shape — do not fold it into the arrival rows' 58. */
const RECENT_SEPARATOR_INSET = 56;

export function RecentRouteRows({ limit }: { limit?: number }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const recents = usePlannerStore((s) => s.recents);
  const removeRecent = usePlannerStore((s) => s.removeRecent);
  const requestPrefill = usePlannerStore((s) => s.requestPrefill);
  // Anchors the action sheet's popover to the tapped ellipsis. Without it the
  // popover centres on the whole screen with no arrow — visible on iPad, where
  // the home surface is a narrow docked column.
  const anchors = useRef<Record<string, React.ComponentRef<typeof Pressable> | null>>({});

  if (recents.length === 0) return null;

  const shown = limit == null ? recents : recents.slice(0, limit);

  const ROUTE_ACTIONS = [{ name: 'options', label: 'Route options' }] as const;

  const replan = (from: string, to: string) => {
    requestPrefill(from, to);
    router.push('/planner');
  };

  const openMenu = (from: string, to: string) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: `${from} → ${to}`,
        options: ['Plan Route', 'Remove from Recents', 'Cancel'],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
        anchor: findNodeHandle(anchors.current[`${from}→${to}`]) ?? undefined,
      },
      (i) => {
        if (i === 0) replan(from, to);
        else if (i === 1) removeRecent(from, to);
      },
    );
  };

  return (
    <>
      {shown.map((r, i) => (
        <View key={`${r.from}→${r.to}`}>
          {i > 0 && <RowSeparator inset={RECENT_SEPARATOR_INSET} />}
          <InsetRow
            icon="clock.arrow.circlepath"
            title={r.from}
            // The arrow is what makes the two lines read as a ROUTE rather than
            // as a title with a caption — it used to be carried by the blue
            // swap glyph, which now belongs to the "Plan a trip" row below.
            subtitle={`→ ${r.to}`}
            label={`Route from ${r.from} to ${r.to}`}
            onPress={() => replan(r.from, r.to)}
            accessibilityActions={ROUTE_ACTIONS}
            onAccessibilityAction={({ nativeEvent }) => {
              if (nativeEvent.actionName === 'options') openMenu(r.from, r.to);
            }}
            trailing={
              <Pressable
                ref={(node) => {
                  anchors.current[`${r.from}→${r.to}`] = node;
                }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
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
    </>
  );
}

const styles = StyleSheet.create({
  ellipsis: { paddingHorizontal: 4, paddingVertical: 4 },
});
