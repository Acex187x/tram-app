// Tram sheet header — the Apple Maps place-detail card header (IMG_0077/79).
// Full variant: a controls row (leading share circle · trailing X), a centered
// tappable TramFace portrait (→ full-screen 3D viewer, the established face→3D
// entry, ux-screens §9), then the centered identity block (line badge +
// headsign title, model · reg subtitle with the AC snowflake). Compact variant
// is the one-line minimized place bar shown at the tram sheet's 0.15 detent
// (IMG_0079): [share] · badge + headsign / model · reg · [X].
//
// The card's actions (Follow / Show Line / 3D), live stat quad, honesty line,
// and floating action bar are composed by the screen — this file owns the
// identity header only.
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { TramFace } from '@/components/tram/TramFace';
import { AcSnowflake } from '@/components/tram/TramModelImage';
import { CloseCircle } from '@/components/ui/CloseCircle';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { appleScheme } from '@/constants/theme';
import type { TramPublicState } from '@/lib/types';

export interface TramSheetHeaderProps {
  state: TramPublicState;
  /** Trailing X. Defaults to router.back(). */
  onClose?: () => void;
  /** Leading share circle. */
  onShare?: () => void;
  /** One-line minimized place-bar variant (0.15 detent, IMG_0079). */
  compact?: boolean;
}

export function TramSheetHeader({ state, onClose, onShare, compact }: TramSheetHeaderProps) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const close = onClose ?? (() => router.back());

  const line = state.snapshot.line;
  const headsign = state.snapshot.headsign;
  const reg = state.snapshot.registrationNumber;
  const subtitle = `${state.model.name}${reg != null ? ` · #${reg}` : ''}`;

  const onPortrait = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/model/${state.model.id}`);
  };

  if (compact) {
    return (
      <View style={styles.compactRow}>
        <View style={styles.side}>
          {onShare != null && (
            <CloseCircle symbol="square.and.arrow.up" label="Share" onPress={onShare} size={30} />
          )}
        </View>
        <View style={styles.compactCenter}>
          <View style={styles.compactTitleRow}>
            <LineBadge line={line} size="sm" />
            <Text style={[styles.compactTitle, { color: c.text }]} numberOfLines={1}>
              {headsign}
            </Text>
          </View>
          <Text style={[styles.compactSubtitle, { color: c.secondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <View style={styles.side}>
          <CloseCircle onPress={close} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.header}>
      <View style={styles.controls}>
        {onShare != null ? (
          <CloseCircle symbol="square.and.arrow.up" label="Share" onPress={onShare} />
        ) : (
          <View style={styles.controlSpacer} />
        )}
        <CloseCircle onPress={close} />
      </View>

      <Pressable
        onPress={onPortrait}
        style={({ pressed }) => [styles.portraitPress, pressed && styles.portraitPressed]}
        accessibilityRole="button"
        accessibilityLabel={`View ${state.model.name} in 3D`}
        hitSlop={4}
      >
        <GlassPanel variant="clear" style={styles.portraitGlass}>
          <TramFace modelId={state.model.id} size={64} />
        </GlassPanel>
      </Pressable>

      <View style={styles.identity}>
        <View style={styles.titleRow}>
          <LineBadge line={line} size="md" />
          <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
            {headsign}
          </Text>
        </View>
        <View style={styles.subtitleRow}>
          <Text style={[styles.subtitle, { color: c.secondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
          <AcSnowflake airConditioned={state.snapshot.airConditioned} size={12} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 12, paddingHorizontal: 20, paddingTop: 14 },
  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  controlSpacer: { height: 30, width: 30 },
  portraitPress: { alignSelf: 'center' },
  portraitPressed: { transform: [{ scale: 0.96 }] },
  portraitGlass: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 24,
    height: 84,
    justifyContent: 'center',
    width: 84,
  },
  identity: { alignItems: 'center', gap: 4 },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  title: {
    flexShrink: 1,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  subtitleRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  subtitle: { flexShrink: 1, fontSize: 14 },

  // compact (minimized place bar)
  compactRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  side: { alignItems: 'center', flexDirection: 'row', gap: 8, minWidth: 30 },
  compactCenter: { alignItems: 'center', flex: 1, gap: 1 },
  compactTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  compactTitle: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
  compactSubtitle: { fontSize: 12 },
});
