// One starred tram row. Live status comes from useTramState (~1 Hz): when the
// car is in service we show its line badge, headsign and delay and the row
// navigates to /tram/[key]; otherwise it renders greyed as "Not in service".
// The gold star unfavorites in place — same affordance as FavoriteLineRow, and
// a toggle rather than UITableView's edit-mode minus glyph.
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { AcSnowflake, acTint } from '@/components/tram/TramModelImage';
import { DelayPill } from '@/components/ui/DelayPill';
import { LineBadge } from '@/components/ui/LineBadge';
import { appleScheme, TabularNums, TextScale, Tram } from '@/constants/theme';
import { getRuntime, useTramState } from '@/hooks/tramData';
import { getModelSpec, regNumberToModelId } from '@/lib/fleet/registry';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';

/** Left inset that aligns separators with the row text (padding + leading + gap). */
export const TRAM_ROW_SEPARATOR_INSET = 16 + 44 + 12;

const UNSTAR_ACTIONS = [{ name: 'unstar', label: 'Remove from favorites' }];

export function FavoriteTramRow({ regKey }: { regKey: string }) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = appleScheme(scheme);
  const state = useTramState(regKey);
  const toggleTram = useFavoritesStore((s) => s.toggleTram);
  const openTram = useSelectionStore((s) => s.openTram);

  const spec = getModelSpec(regNumberToModelId(Number(regKey)));
  const inService = state != null;

  // The tram card is an owned sheet on the MAP screen, so opening one from here
  // means: present it, then get out of the way. `dismissAll()` pops this
  // favorites sheet (and anything under it) back to the map in one call. The
  // store write goes FIRST so the card is already mounted as the sheet animates
  // away — the two motions read as a hand-off rather than a blank beat.
  const open = (): void => {
    if (!state) return;
    void Haptics.selectionAsync();
    getRuntime().prioritizeTrip(state.snapshot.tripId);
    openTram(regKey);
    router.dismissAll();
  };

  const remove = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toggleTram(regKey);
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      // NOT `disabled` when out of service: that would also strip the custom
      // action below, and unstarring is then the row's only remaining action.
      // `open` no-ops without a live state.
      accessibilityState={{ disabled: !inService }}
      accessibilityLabel={`Tram ${regKey}, ${spec.name}, ${
        state ? `line ${state.snapshot.line} to ${state.snapshot.headsign}` : 'not in service'
      }, favorited`}
      // VoiceOver never focuses an element nested inside an accessible one, so
      // the inline star is unreachable — unstarring lives on the row instead.
      accessibilityActions={UNSTAR_ACTIONS}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'unstar') remove();
      }}
      style={({ pressed }) => [
        styles.row,
        pressed && inService && { backgroundColor: palette.fillHighlight },
      ]}
    >
      <View style={styles.leading}>
        {state ? (
          <LineBadge line={state.snapshot.line} size="md" />
        ) : (
          <View
            style={[
              styles.idleBadge,
              {
                backgroundColor:
                  scheme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)',
              },
            ]}
          >
            <SymbolView name="tram.fill" size={15} tintColor={palette.secondary} />
          </View>
        )}
      </View>

      <View style={[styles.body, !inService && styles.dimmed]}>
        <View style={styles.titleRow}>
          <Text
            style={[styles.reg, { color: palette.text }]}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {regKey}
          </Text>
          <Text
            style={[styles.model, { color: palette.secondary }]}
            numberOfLines={1}
          >
            {spec.name}
          </Text>
          {state ? (
            <AcSnowflake airConditioned={state.snapshot.airConditioned} size={11} tint={acTint(scheme)} />
          ) : null}
        </View>
        <Text
          style={[styles.subtitle, { color: palette.secondary }]}
          numberOfLines={1}
        >
          {state ? `→ ${state.snapshot.headsign}` : 'Not in service'}
        </Text>
      </View>

      {state ? <DelayPill delaySeconds={state.snapshot.delaySeconds} /> : null}

      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        hitSlop={10}
        onPress={remove}
        style={({ pressed }) => [styles.remove, pressed && styles.pressedIcon]}
      >
        <SymbolView name="star.fill" size={20} tintColor={Tram.gold} />
      </Pressable>

      {inService ? (
        <SymbolView
          name="chevron.right"
          size={13}
          weight="semibold"
          tintColor={palette.secondary}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
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
  idleBadge: {
    alignItems: 'center',
    borderRadius: 8,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  dimmed: {
    opacity: 0.55,
  },
  titleRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 7,
  },
  reg: {
    fontSize: 17,
    ...TabularNums,
    fontWeight: '600',
  },
  model: {
    flexShrink: 1,
    fontSize: 13,
  },
  subtitle: {
    fontSize: 13,
  },
  remove: {
    padding: 2,
  },
  pressedIcon: {
    opacity: 0.5,
  },
});
