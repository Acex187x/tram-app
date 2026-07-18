// Chibi Mascot pack — shared palette + shared chibi anatomy constants.
// Identity: super-deformed squashed bodies, HUGE glossy windscreen-eyes,
// tiny wheels peeking under the body like feet, thick storybook outline,
// blush marks, one signature accessory per model. Reads on light AND dark
// thanks to the heavy outline + soft ground shadow.

export const C = {
  outline: '#2B2233', // thick storybook stroke, works on both themes
  dark: '#221D2B', // display housings, wheels
  glass: '#C3E9FB', // eye sclera / windscreen glass
  glassDeep: '#8FD2F2', // lower-glass shading
  pupil: '#27364F', // navy pupils
  glow: '#79DBFF', // robot iris glow
  sparkle: '#FFFFFF',
  blush: '#FF9E96',
  red: '#E8433C', // playful DPP red
  redDeep: '#C22F2B',
  maroon: '#8C2F3E', // t3rplf signature livery
  cream: '#FFF4DE',
  white: '#FAFBFF',
  chrome: '#D5DBE4',
  silver: '#C7CDD8',
  grey: '#98A0AE', // skirts
  amber: '#FFB03A', // dot-matrix / halogen warmth
  lens: '#FFE7B3', // warm headlight lens
  iceLed: '#CFE9FF', // 52t white-LED
  shadow: 'rgba(34,29,43,0.30)',
} as const;

export const VIEWBOX = '0 0 64 64';

export type ChibiFaceProps = { size?: number };
