// Chibi 15T ForCity — the sloped face with the SILVER light-band. Big raked
// CURVED black windscreen framed by a RED brow/cap that flows down the
// A-pillars (the body reads red around the glass), amber LED destination in
// the glass top, a SILVER horizontal mid-band carrying clusters of ROUND
// headlights, RED lower bumper with white DRL dashes, dark skirt, single-arm
// pantograph. The whole cute face lives inside the big black glass.
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const GLASSBLACK = '#1E1F27';
const SILVER = '#D3D7DE';
const DARKSKIRT = '#4A4E58';

const BODY =
  'M11.5 50 C11.5 52.8 13.5 54 16 54 L48 54 C50.5 54 52.5 52.8 52.5 50 L52.5 21.5 C52.5 12 44 7.5 32 7.5 C20 7.5 11.5 12 11.5 21.5 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20.5} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* single-arm pantograph */}
      <Path
        d="M30 7.6 L36.5 3.6 M33.6 3 L39.8 3"
        stroke="#4A5566"
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
      {/* RED body — shows as the brow cap + A-pillars around the glass */}
      <Path d={BODY} fill={C.red} />
      {/* huge raked CURVED black windscreen */}
      <Path
        d="M15 34 L15 22.5 C15 14.6 22 11 32 11 C42 11 49 14.6 49 22.5 L49 34 Q49 36.6 46.4 36.6 L17.6 36.6 Q15 36.6 15 34 Z"
        fill={GLASSBLACK}
        stroke={C.outline}
        strokeWidth={1.7}
      />
      {/* amber LED destination in the glass top */}
      <Rect x={23} y={13.4} width={3} height={2} rx={0.45} fill={C.amber} />
      <Rect x={28} y={13.8} width={9.5} height={1.3} rx={0.65} fill={C.amber} opacity={0.9} />
      {/* glass reflection */}
      <Path d="M19.6 17.6 L24 16.2 L20.8 31 L17.6 28.8 Z" fill={C.sparkle} opacity={0.2} />
      {/* friendly round eyes glowing in the dark glass */}
      <Circle cx={25.5} cy={25} r={4.4} fill={C.sparkle} />
      <Circle cx={38.5} cy={25} r={4.4} fill={C.sparkle} />
      <Circle cx={26.2} cy={26} r={2.2} fill={C.pupil} />
      <Circle cx={37.8} cy={26} r={2.2} fill={C.pupil} />
      <Circle cx={25.4} cy={25.1} r={0.8} fill={C.sparkle} />
      <Circle cx={37} cy={25.1} r={0.8} fill={C.sparkle} />
      {/* blush + smile inside the glass */}
      <Ellipse cx={21.4} cy={30.6} rx={2.3} ry={1.4} fill={C.blush} opacity={0.9} />
      <Ellipse cx={42.6} cy={30.6} rx={2.3} ry={1.4} fill={C.blush} opacity={0.9} />
      <Path d="M28.5 30.6 Q32 33.6 35.5 30.6" stroke={C.sparkle} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      {/* SILVER horizontal mid-band with ROUND headlight clusters */}
      <Path d="M11.5 38.5 L52.5 38.5 L52.5 44.5 L11.5 44.5 Z" fill={SILVER} />
      <Circle cx={17.6} cy={41.5} r={2.2} fill={C.lens} stroke={C.outline} strokeWidth={1} />
      <Circle cx={22.6} cy={41.5} r={1.7} fill={C.sparkle} stroke={C.outline} strokeWidth={0.9} />
      <Circle cx={26.3} cy={41.5} r={1.1} fill={C.amber} />
      <Circle cx={46.4} cy={41.5} r={2.2} fill={C.lens} stroke={C.outline} strokeWidth={1} />
      <Circle cx={41.4} cy={41.5} r={1.7} fill={C.sparkle} stroke={C.outline} strokeWidth={0.9} />
      <Circle cx={37.7} cy={41.5} r={1.1} fill={C.amber} />
      {/* RED lower bumper with white DRL dashes */}
      <Rect x={15.5} y={46.6} width={7} height={1.9} rx={0.95} fill={C.sparkle} stroke={C.outline} strokeWidth={0.8} />
      <Rect x={41.5} y={46.6} width={7} height={1.9} rx={0.95} fill={C.sparkle} stroke={C.outline} strokeWidth={0.8} />
      {/* dark skirt */}
      <Path
        d="M11.55 50.5 L52.45 50.5 C52.2 53 50.3 54 48 54 L16 54 C13.7 54 11.8 53 11.55 50.5 Z"
        fill={DARKSKIRT}
      />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
