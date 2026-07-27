// Transparent side-profile illustration of a tram model, plus the shared AC
// snowflake indicator used wherever a specific tram is listed.
//
// MODEL_IMAGES lives in '@/lib/fleet/modelSpecs' (Record<TramModelId, number>
// of require()'d PNGs). It may not exist yet / may miss entries — access it
// defensively via the module namespace and render nothing when absent, so the
// UI never depends on the asset registry being complete.
import { Image, type ImageStyle } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { AppleAccent } from '@/constants/theme';
import * as fleetSpecs from '@/lib/fleet/modelSpecs';
import type { TramModelId } from '@/lib/types';

const MODEL_IMAGES: Partial<Record<TramModelId, number>> =
  (fleetSpecs as { MODEL_IMAGES?: Partial<Record<TramModelId, number>> }).MODEL_IMAGES ?? {};

/** Bundled illustration asset for a model, or null when unavailable. */
export function tramModelImageSource(modelId: TramModelId): number | null {
  const asset = MODEL_IMAGES[modelId];
  return typeof asset === 'number' && asset !== 0 ? asset : null;
}

/**
 * The bundled illustrations are near-square FACE closeups (rendered by
 * scripts/render-model.mjs --face, ~600×600, transparent). Default width
 * follows that aspect; contentFit 'contain' keeps any aspect undistorted.
 */
export const MODEL_IMAGE_ASPECT = 1.1;

export interface TramModelImageProps {
  modelId: TramModelId;
  /** Rendered height; width defaults to the face-closeup aspect. */
  height: number;
  style?: StyleProp<ImageStyle>;
}

/** The tram's illustration (contentFit contain) — or nothing if not bundled. */
export function TramModelImage({ modelId, height, style }: TramModelImageProps) {
  const source = tramModelImageSource(modelId);
  if (source == null) return null;
  return (
    <Image
      source={source}
      contentFit="contain"
      style={[{ height, width: Math.round(height * MODEL_IMAGE_ASPECT) }, style]}
      accessibilityIgnoresInvertColors
      transition={120}
    />
  );
}

/** Snowflake color on the DARK schemes (5.9:1 on the dark sheet fill). */
export const AC_TINT = '#3E9FD8';

/**
 * Snowflake tint per appearance. AC_TINT measures 2.9:1 on the light sheet —
 * under the 3:1 floor for a glyph that carries meaning on its own — so light
 * mode uses systemBlue (4.0:1) instead. Passed in by callers rather than read
 * from a `useColorScheme()` here: this glyph renders inside memoized list rows
 * that re-render ~1 Hz, so it must not add a subscription of its own.
 */
export function acTint(scheme: 'light' | 'dark'): string {
  return scheme === 'dark' ? AC_TINT : AppleAccent.blue.light;
}

/** Small snowflake shown next to a tram wherever it appears, when it has AC. */
export function AcSnowflake({
  airConditioned,
  size = 12,
  tint = AC_TINT,
  decorative = false,
  style,
}: {
  airConditioned: boolean | null | undefined;
  size?: number;
  /** Appearance-aware tint — pass `acTint(scheme)`. */
  tint?: string;
  /** Set when the surrounding row already speaks "air conditioned" in its own
   *  label, so the glyph is not announced twice. */
  decorative?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  if (airConditioned !== true) return null;
  // A bare SymbolView is not an accessibility element until `accessible` is set,
  // so without it the label below is inert and the AC fact is never announced.
  return (
    <SymbolView
      name="snowflake"
      size={size}
      tintColor={tint}
      style={[styles.snowflake, style]}
      accessible={!decorative}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'yes'}
      accessibilityRole="image"
      accessibilityLabel="Air conditioned"
    />
  );
}

const styles = StyleSheet.create({
  snowflake: { flexShrink: 0 },
});
