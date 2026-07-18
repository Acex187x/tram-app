// Chibi T3R.PLF — the new-build retro tram that "sags gracefully in the
// middle". Same beloved egg face, but in the signature MAROON-and-SILVER
// livery with silver flashes, a crisp continuous-line LED brow (smooth modern
// molding, not dot matrix), and a cheeky WINK — the graceful one of the T3
// family. Hairline panel gaps hint at the modern plastic mask.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BODY =
  'M11 50 C11 52.8 13 54 15.5 54 L48.5 54 C51 54 53 52.8 53 50 L53 26 C53 13 44 7 32 7 C20 7 11 13 11 26 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* modern boxy pantograph */}
      <Path
        d="M26.5 7.5 L32.5 3.6 M28.4 3.2 L37.6 3.2"
        stroke="#4A5566"
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
      {/* cream egg body — retro T3 silhouette, new-build mask */}
      <Path d={BODY} fill={C.cream} />
      {/* MAROON lower band (signature livery) */}
      <Path
        d="M11 36.5 Q32 40.5 53 36.5 L53 50 C53 52.8 51 54 48.5 54 L15.5 54 C13 54 11 52.8 11 50 Z"
        fill={C.maroon}
      />
      {/* silver flash slashes on the maroon cheeks */}
      <Path d="M13.5 41 L20 39.6 L18.6 43.2 L12.6 44.4 Z" fill={C.silver} opacity={0.95} />
      <Path d="M50.5 41 L44 39.6 L45.4 43.2 L51.4 44.4 Z" fill={C.silver} opacity={0.95} />
      {/* full-width LED brow — crisp continuous amber line (modern molding) */}
      <Rect x={13.5} y={10.6} width={37} height={5.4} rx={2} fill={C.dark} />
      <Rect x={17} y={12.7} width={13} height={1.2} rx={0.6} fill={C.amber} />
      <Rect x={33} y={12.7} width={5} height={1.2} rx={0.6} fill={C.amber} opacity={0.8} />
      <Rect x={41} y={12.7} width={6} height={1.2} rx={0.6} fill={C.amber} />
      {/* left eye: big open glass eye */}
      <Circle cx={22.5} cy={27.5} r={8} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      <Circle cx={23.6} cy={28.2} r={4.2} fill={C.pupil} />
      <Circle cx={22.2} cy={26.5} r={1.7} fill={C.sparkle} />
      <Circle cx={25.1} cy={30.1} r={0.8} fill={C.sparkle} opacity={0.85} />
      {/* right eye: graceful wink (happy closed arc + tiny lash) */}
      <Path
        d="M34.5 27 Q41.5 31.8 48.5 27"
        stroke={C.outline}
        strokeWidth={2.2}
        strokeLinecap="round"
        fill="none"
      />
      <Path d="M47.8 28.6 L49.8 30.2" stroke={C.outline} strokeWidth={1.4} strokeLinecap="round" />
      {/* hairline panel gaps of the new plastic mask */}
      <Line x1={15.2} y1={19} x2={15.2} y2={33} stroke={C.outline} strokeWidth={0.7} opacity={0.25} />
      <Line x1={48.8} y1={19} x2={48.8} y2={33} stroke={C.outline} strokeWidth={0.7} opacity={0.25} />
      {/* blush */}
      <Ellipse cx={15.6} cy={34.4} rx={2.7} ry={1.8} fill={C.blush} opacity={0.85} />
      <Ellipse cx={48.4} cy={34.4} rx={2.7} ry={1.8} fill={C.blush} opacity={0.85} />
      {/* round headlights with integrated slim indicators */}
      <Circle cx={20.5} cy={46.2} r={2.7} fill={C.lens} stroke={C.chrome} strokeWidth={1.2} />
      <Circle cx={43.5} cy={46.2} r={2.7} fill={C.lens} stroke={C.chrome} strokeWidth={1.2} />
      <Rect x={24.4} y={45.5} width={3.4} height={1.4} rx={0.7} fill={C.amber} opacity={0.9} />
      <Rect x={36.2} y={45.5} width={3.4} height={1.4} rx={0.7} fill={C.amber} opacity={0.9} />
      {/* gentle contented smile */}
      <Path d="M28 49.4 Q32 52 36 49.4" stroke={C.silver} strokeWidth={1.9} strokeLinecap="round" fill="none" />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
