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

/** Snowflake color — a cool blue that reads on both schemes. */
export const AC_TINT = '#3E9FD8';

/** Small snowflake shown next to a tram wherever it appears, when it has AC. */
export function AcSnowflake({
  airConditioned,
  size = 12,
  style,
}: {
  airConditioned: boolean | null | undefined;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  if (airConditioned !== true) return null;
  return (
    <SymbolView
      name="snowflake"
      size={size}
      tintColor={AC_TINT}
      style={[styles.snowflake, style]}
      accessibilityLabel="Air conditioned"
    />
  );
}

const styles = StyleSheet.create({
  snowflake: { flexShrink: 0 },
});
