// Shared bits for the tram "face" icon set — 7 flat-vector front-view
// mordochky, one per Prague tram model. Pure module (no react-native imports)
// so the sprite renderer (scripts/tram-models/render-face-sprites.mjs) can
// bundle the same art for the map PNG sprites.
//
// Design language: 64×64 viewBox, tram drawn front-on as a friendly "face" —
// windshield = eyes (soft white glints), headlights = cheeks, bumper = mouth.
// Every face is self-contained (own body fill + soft dark outline) so it reads
// on light AND dark backgrounds. Colors are photo-sampled per model from the
// round-2 GLB builder references (scripts/tram-models/*.mjs headers).

export interface FaceProps {
  /** Rendered square size in pt. Defaults to 64 (the authored viewBox). */
  size?: number;
}

/** The square viewBox every face is authored in. */
export const FACE_VIEWBOX = '0 0 64 64';

/** Shared photo-sampled palette (per-model accents live in each face file). */
export const FACE_COLORS = {
  /** Prague cream body (T3 family). */
  cream: '#F2E4C9',
  creamShade: '#DEC9A0',
  /** PID crimson (classic livery band). */
  red: '#7A0603',
  /** Windshield glass. */
  glass: '#232C36',
  glassHi: '#3D5064',
  glint: '#FFFFFF',
  /** Chrome / silver trim. */
  chrome: '#D8DBDF',
  silver: '#C4C7CC',
  silverDark: '#8F949B',
  charcoal: '#33363B',
  outline: '#2B241D',
  amber: '#F2A63B',
  gold: '#E0A526',
  ledGreen: '#7CDE6B',
  warmLens: '#FBEFC7',
} as const;
