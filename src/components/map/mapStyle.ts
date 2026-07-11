// Mapbox Standard style plumbing for the map screen.
// SPIKE-VERIFIED: a direct styleURL of 'mapbox://styles/mapbox/standard' has no
// 'basemap' import, so <StyleImport id="basemap"> fails against it. We instead
// feed MapView a tiny style JSON that imports Standard under the id 'basemap' —
// then <StyleImport id="basemap" existing config> works for live re-lighting.

import type { LightPreset } from '@/stores/settings';

/** Standard basemap config shared by the initial style JSON and StyleImport. */
export const STANDARD_CONFIG = {
  theme: 'default',
  show3dObjects: true,
  showPointOfInterestLabels: false,
  // Hide Mapbox's own transit POIs — Golemio stop positions differ, and OUR
  // clickable stop markers are the source of truth.
  showTransitLabels: false,
  showPlaceLabels: true,
  showRoadLabels: true,
} as const;

export type ResolvedLightPreset = 'dawn' | 'day' | 'dusk' | 'night';

let pragueHourFormatter: Intl.DateTimeFormat | null | undefined;

function pragueHour(nowMs: number): number {
  if (pragueHourFormatter === undefined) {
    try {
      pragueHourFormatter = new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hour12: false,
        timeZone: 'Europe/Prague',
      });
    } catch {
      pragueHourFormatter = null;
    }
  }
  if (pragueHourFormatter) {
    const h = parseInt(pragueHourFormatter.format(new Date(nowMs)), 10);
    if (!Number.isNaN(h)) return h % 24;
  }
  // Fallback: CET/CEST approximation.
  return (new Date(nowMs).getUTCHours() + 2) % 24;
}

/** 'auto' → time-of-day in Prague; explicit presets pass through. */
export function resolveLightPreset(preset: LightPreset, nowMs: number): ResolvedLightPreset {
  if (preset !== 'auto') return preset;
  const h = pragueHour(nowMs);
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 18) return 'day';
  if (h >= 18 && h < 21) return 'dusk';
  return 'night';
}

/**
 * Root style JSON: empty custom style importing Mapbox Standard as 'basemap'.
 * Root-level glyphs are required for our own SymbolLayer (line-number badges).
 */
export function buildMapStyleJSON(lightPreset: ResolvedLightPreset): string {
  return JSON.stringify({
    version: 8,
    name: 'Tram Spotter',
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    imports: [
      {
        id: 'basemap',
        url: 'mapbox://styles/mapbox/standard',
        config: { ...STANDARD_CONFIG, lightPreset },
      },
    ],
    sources: {},
    layers: [],
  });
}

// ── Zoom bands (architecture.md table, crossfaded at edges) ──────────────────
/** Dots fully visible below, badges take over above. */
export const BAND_DOTS_TO_BADGES = 13.2;
/** Badges fade out, 3D models fade in (featureBuilder SECTION_MIN_ZOOM). */
export const BAND_BADGES_TO_MODELS = 14.8;
/** Models reach real-world scale 1.0 here. */
export const MODEL_REAL_SCALE_ZOOM = 16.6;
/** Width of the opacity crossfade around each band edge. */
export const BAND_FADE = 0.3;
/** Feed the sections source slightly before the model band to warm it up. */
export const SECTIONS_FEED_MIN_ZOOM = 14.6;
