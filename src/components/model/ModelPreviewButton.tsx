// Tappable tram-face preview used in the tram sheet header: the model
// illustration (face closeup) with a "View in 3D" caption. Pressing it scales
// down subtly, fires a haptic and opens the full-screen /model/[id] viewer.
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { TramModelImage, tramModelImageSource } from '@/components/tram/TramModelImage';
import { Colors } from '@/constants/theme';
import type { TramModelId } from '@/lib/types';

export interface ModelPreviewButtonProps {
  modelId: TramModelId;
  /** Illustration height (face closeups are ~square). Default 104. */
  height?: number;
  style?: StyleProp<ViewStyle>;
}

export function ModelPreviewButton({ modelId, height = 104, style }: ModelPreviewButtonProps) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const [scale] = useState(() => new Animated.Value(1));

  // No bundled illustration → nothing to preview; keep the header clean.
  if (tramModelImageSource(modelId) == null) return null;

  const animateTo = (v: number) =>
    Animated.spring(scale, {
      toValue: v,
      useNativeDriver: true,
      speed: 30,
      bounciness: 5,
    }).start();

  const onPress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/model/${modelId}`);
  };

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => animateTo(0.93)}
      onPressOut={() => animateTo(1)}
      accessibilityRole="button"
      accessibilityLabel="View tram in 3D"
      hitSlop={6}
      style={[styles.press, style]}
    >
      <Animated.View style={[styles.inner, { transform: [{ scale }] }]}>
        <TramModelImage modelId={modelId} height={height} />
        <Animated.View style={styles.caption}>
          <SymbolView
            name="rotate.3d"
            size={11}
            tintColor={c.textSecondary}
            fallback={
              <SymbolView
                name="arrow.up.left.and.arrow.down.right"
                size={11}
                tintColor={c.textSecondary}
              />
            }
          />
          <Text style={[styles.captionText, { color: c.textSecondary }]} allowFontScaling={false}>
            View in 3D
          </Text>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  caption: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    marginTop: 2,
  },
  captionText: { fontSize: 11, fontWeight: '600' },
  inner: { alignItems: 'center' },
  press: { alignItems: 'center', alignSelf: 'flex-start' },
});
