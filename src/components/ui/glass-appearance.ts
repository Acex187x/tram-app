export type GlassAppearance = 'light' | 'dark';

/**
 * Liquid Glass remains content-adaptive even when its color scheme is pinned.
 * These tints keep same-scheme foreground legible over bright or dark map
 * imagery without turning ordinary sheet glass opaque.
 */
export function contentGlassTintFor(scheme: GlassAppearance): string {
  return scheme === 'dark'
    ? 'rgba(18,18,20,0.72)'
    : 'rgba(250,250,252,0.72)';
}

/** Extra veil used only by the BlurView fallback over high-contrast content. */
export function contentBlurOverlayFor(scheme: GlassAppearance): string {
  return scheme === 'dark'
    ? 'rgba(0,0,0,0.28)'
    : 'rgba(255,255,255,0.24)';
}
