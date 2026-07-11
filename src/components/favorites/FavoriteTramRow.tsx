// One starred tram row. Live status comes from useTramState (~1 Hz): when the
// car is in service we show its line badge, headsign and delay and the row
// navigates to /tram/[key]; otherwise it renders greyed as "Not in service".
// The minus button unfavorites in place.
import * as Haptics from 'expo-haptics';
import { useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { AcSnowflake } from '@/components/tram/TramModelImage';
import { DelayPill } from '@/components/ui/DelayPill';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Tram } from '@/constants/theme';
import { getRuntime, useTramState } from '@/hooks/tramData';
import { getModelSpec, regNumberToModelId } from '@/lib/fleet/registry';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';

/** Left inset that aligns separators with the row text (padding + leading + gap). */
export const TRAM_ROW_SEPARATOR_INSET = 16 + 44 + 12;

export function FavoriteTramRow({ regKey }: { regKey: string }) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const state = useTramState(regKey);
  const toggleTram = useFavoritesStore((s) => s.toggleTram);
  const setSelectedTramKey = useSelectionStore((s) => s.setSelectedTramKey);

  const spec = getModelSpec(regNumberToModelId(Number(regKey)));
  const inService = state != null;

  const open = (): void => {
    if (!state) return;
    void Haptics.selectionAsync();
    setSelectedTramKey(regKey);
    getRuntime().prioritizeTrip(state.snapshot.tripId);
    // Keys are usually registration numbers but can fall back to trip ids with
    // URL-hostile characters — encode like the map does. Cast: typed-routes
    // d.ts regenerates on the next `expo start`.
    router.push(('/tram/' + encodeURIComponent(regKey)) as Href);
  };

  const remove = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toggleTram(regKey);
  };

  return (
    <Pressable
      onPress={open}
      disabled={!inService}
      accessibilityRole="button"
      accessibilityLabel={`Tram ${regKey}, ${spec.name}, ${
        state ? `line ${state.snapshot.line} to ${state.snapshot.headsign}` : 'not in service'
      }`}
      style={({ pressed }) => [
        styles.row,
        pressed && {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
        },
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
            <SymbolView name="tram.fill" size={15} tintColor={palette.textSecondary} />
          </View>
        )}
      </View>

      <View style={[styles.body, !inService && styles.dimmed]}>
        <View style={styles.titleRow}>
          <Text style={[styles.reg, { color: palette.text }]} allowFontScaling={false}>
            {regKey}
          </Text>
          <Text
            style={[styles.model, { color: palette.textSecondary }]}
            numberOfLines={1}
          >
            {spec.name}
          </Text>
          {state ? <AcSnowflake airConditioned={state.snapshot.airConditioned} size={11} /> : null}
        </View>
        <Text
          style={[styles.subtitle, { color: palette.textSecondary }]}
          numberOfLines={1}
        >
          {state ? `→ ${state.snapshot.headsign}` : 'Not in service'}
        </Text>
      </View>

      {state ? <DelayPill delaySeconds={state.snapshot.delaySeconds} /> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove tram ${regKey} from favorites`}
        hitSlop={10}
        onPress={remove}
        style={({ pressed }) => [styles.remove, pressed && styles.pressedIcon]}
      >
        <SymbolView name="minus.circle.fill" size={22} tintColor={Tram.veryLate} />
      </Pressable>

      {inService ? (
        <SymbolView
          name="chevron.right"
          size={13}
          weight="semibold"
          tintColor={palette.textSecondary}
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
    fontVariant: ['tabular-nums'],
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
