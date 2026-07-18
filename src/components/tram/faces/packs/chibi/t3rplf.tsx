// Chibi T3R.PLF — the SILVER-bodied T3. Same lovable bun silhouette, but:
// smooth SINGLE curved windscreen (no center pillar), a dark WINE "bib" arc
// under the glass holding the two round headlights, green LED brow, red side
// band slivers wrapping the corners, silver skirt. The graceful one — keeps
// her signature wink.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const SILVER = '#CFD3D8'; // champagne-silver body
const WINE = '#7E2537'; // dark wine bib
const LED = '#9BE23A';
const PANTO = '#D9A62E';

const BODY =
  'M11 50 C11 52.8 13 54 15.5 54 L48.5 54 C51 54 53 52.8 53 50 L53 25 C53 12.5 44 7 32 7 C20 7 11 12.5 11 25 Z';

// wine bib: full-width under the glass, bottom edge a deep rounded arc
const BIB =
  'M13.4 33 L50.6 33 L50.6 37.5 C50.6 44.2 42.5 48.2 32 48.2 C21.5 48.2 13.4 44.2 13.4 37.5 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* yellow diamond pantograph */}
      <Path
        d="M32 1.4 L37.4 4.3 L32 7.2 L26.6 4.3 Z"
        stroke={PANTO}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
      {/* SILVER bun body */}
      <Path d={BODY} fill={SILVER} />
      {/* red side-band slivers wrapping around low on the flanks */}
      <Path d="M11 44 L14.5 44 L14.5 49.5 L11 49.5 Z" fill={C.red} />
      <Path d="M53 44 L49.5 44 L49.5 49.5 L53 49.5 Z" fill={C.red} />
      {/* green LED destination strip in the brow */}
      <Rect x={15} y={9.8} width={34} height={5.4} rx={1.6} fill={C.dark} stroke={C.outline} strokeWidth={0.9} />
      <Rect x={17.4} y={11.5} width={3.2} height={2} rx={0.5} fill={LED} />
      <Rect x={23} y={11.9} width={9} height={1.3} rx={0.65} fill={LED} />
      <Rect x={34.5} y={11.9} width={8} height={1.3} rx={0.65} fill={LED} opacity={0.85} />
      {/* smooth SINGLE curved windscreen — one pane, no pillar */}
      <Path
        d="M15 27.5 L15 23.5 C15 18 22 15.8 32 15.8 C42 15.8 49 18 49 23.5 L49 27.5 Q49 30.4 46 30.4 L18 30.4 Q15 30.4 15 27.5 Z"
        fill={C.glass}
        stroke={C.outline}
        strokeWidth={1.8}
      />
      {/* left eye open, right eye a graceful wink */}
      <Circle cx={24} cy={24} r={3.6} fill={C.pupil} />
      <Circle cx={22.8} cy={22.7} r={1.4} fill={C.sparkle} />
      <Circle cx={25.4} cy={25.7} r={0.7} fill={C.sparkle} opacity={0.85} />
      <Path
        d="M36.5 23.2 Q40.5 26.6 44.5 23.2"
        stroke={C.pupil}
        strokeWidth={2.4}
        strokeLinecap="round"
        fill="none"
      />
      {/* glass reflection streak */}
      <Path d="M18.4 18.6 Q22 17.2 25.6 17.2 L22.6 21.6 Q19.6 21.9 17.6 23.4 Z" fill={C.sparkle} opacity={0.4} />
      {/* blush on the silver cheeks */}
      <Ellipse cx={17.4} cy={32} rx={2.4} ry={1.5} fill={C.blush} opacity={0.85} />
      <Ellipse cx={46.6} cy={32} rx={2.4} ry={1.5} fill={C.blush} opacity={0.85} />
      {/* dark WINE bib arc holding the round headlights */}
      <Path d={BIB} fill={WINE} stroke={C.outline} strokeWidth={1.1} />
      <Circle cx={22} cy={39.5} r={3.2} fill={C.lens} stroke={C.chrome} strokeWidth={1.5} />
      <Circle cx={42} cy={39.5} r={3.2} fill={C.lens} stroke={C.chrome} strokeWidth={1.5} />
      <Circle cx={21} cy={38.5} r={0.9} fill={C.sparkle} opacity={0.95} />
      <Circle cx={41} cy={38.5} r={0.9} fill={C.sparkle} opacity={0.95} />
      {/* gentle smile inside the wine bib */}
      <Path
        d="M28.5 41.5 Q32 44.4 35.5 41.5"
        stroke={SILVER}
        strokeWidth={1.9}
        strokeLinecap="round"
        fill="none"
      />
      {/* skirt seam */}
      <Line x1={12} y1={50} x2={52} y2={50} stroke={C.outline} strokeWidth={0.9} opacity={0.3} />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
