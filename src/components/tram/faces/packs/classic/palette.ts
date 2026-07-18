// Pack-local palette + shared constants for the "classic" face pack.
// Refined front-view flat vector — Prague cream & red, warm chrome, amber LEDs.
// Pure module (no react-native imports) so sprite bakers can bundle it too.

export interface FaceProps {
  /** Rendered square size in pt. Defaults to 64 (the authored viewBox). */
  size?: number;
}

/** The square viewBox every face in this pack is authored in. */
export const VB = '0 0 64 64';

export const P = {
  /** Prague cream body (T3 family / 14T / 15T upper). */
  cream: '#F3E7CE',
  creamShade: '#E3D1AD',
  /** DPP crimson livery band. */
  red: '#9E1B1E',
  redDeep: '#7C1114',
  /** PID red (modern white-livery accent, 52T). */
  pidRed: '#C41E25',
  /** Windshield glass. */
  glass: '#1E2630',
  glassHi: '#31435A',
  glint: '#FFFFFF',
  /** Chrome / silver trim. */
  chrome: '#DCDFE3',
  silver: '#C3C7CC',
  silverDark: '#8F949B',
  grey: '#9DA2A8',
  charcoal: '#2E3237',
  /** Soft dark silhouette outline (reads on light AND dark). */
  outline: '#28221C',
  amber: '#F5A93B',
  /** Orange dot-matrix / LED destination displays. */
  ledOrange: '#F78A1D',
  gold: '#E0A526',
  warmLens: '#FCEFC5',
  /** DPP blue route-number box (classic T3). */
  blue: '#1D4E9E',
  /** Wine/maroon T3R.PLF bib. */
  wine: '#6E1E29',
  /** Green-yellow LED destination displays (T3R.P / T3R.PLF / 14T). */
  ledGreen: '#A6D82F',
} as const;
