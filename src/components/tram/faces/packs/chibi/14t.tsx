// Chibi 14T — the Porsche-designed angular WEDGE. Faceted SILVER cab with
// straight chamfered sides (no bun curves), a tall BLACK windscreen frame
// that WIDENS downward (trapezoid), green LED strip at its top, stacked pairs
// of small round lights in dark recessed niches low on the mask, RED body
// sections peeking behind the silver cab, single-arm pantograph, grey skirt.
// Slightly googly eyes keep its lovable-oddball personality.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const SILVER = '#CBD0D8';
const NICHE = '#3A3F4A';
const GLASSBLACK = '#23252E';
const LED = '#9BE23A';

const BODY =
  'M12.5 50 C12.5 52.8 14.5 54 17 54 L47 54 C49.5 54 51.5 52.8 51.5 50 L50.4 18 L44.6 9.5 L19.4 9.5 L13.6 18 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow */}
      <Ellipse cx={32} cy={59.6} rx={23} ry={2.4} fill={C.shadow} />
      {/* RED body sections peeking behind the silver cab — the red/silver tell */}
      <Path d="M7.5 24 L12 24 L12 51 L9 51 C8 51 7.5 50.4 7.5 49.4 Z" fill={C.red} stroke={C.outline} strokeWidth={1.5} />
      <Path d="M56.5 24 L52 24 L52 51 L55 51 C56 51 56.5 50.4 56.5 49.4 Z" fill={C.red} stroke={C.outline} strokeWidth={1.5} />
      {/* wheel-feet */}
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* single-arm pantograph */}
      <Path
        d="M30 9.5 L36.5 3.8 M33.4 3.2 L39.6 3.2"
        stroke="#4A5566"
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
      {/* faceted SILVER wedge cab */}
      <Path d={BODY} fill={SILVER} />
      {/* facet crease lines down the chamfered corners */}
      <Line x1={19.4} y1={10.5} x2={15} y2={18.5} stroke={C.outline} strokeWidth={0.8} opacity={0.3} />
      <Line x1={44.6} y1={10.5} x2={49} y2={18.5} stroke={C.outline} strokeWidth={0.8} opacity={0.3} />
      {/* BLACK windscreen frame that WIDENS downward */}
      <Path
        d="M24.6 11.5 L39.4 11.5 L45 33.5 Q45.3 36 42.8 36 L21.2 36 Q18.7 36 19 33.5 Z"
        fill={GLASSBLACK}
        stroke={C.outline}
        strokeWidth={1.7}
      />
      {/* green LED destination at the top of the black frame */}
      <Rect x={25.6} y={13.2} width={3} height={1.9} rx={0.45} fill={LED} />
      <Rect x={30.2} y={13.5} width={8.2} height={1.3} rx={0.65} fill={LED} opacity={0.9} />
      {/* glass reflection */}
      <Path d="M24.4 17.4 L28.6 17.4 L24.9 30.6 L22.4 28.4 Z" fill={C.sparkle} opacity={0.22} />
      {/* googly eyes — right one rides a touch higher (the quirky one) */}
      <Circle cx={27} cy={26} r={4.4} fill={C.sparkle} />
      <Circle cx={37.4} cy={24.6} r={4.4} fill={C.sparkle} />
      <Circle cx={28} cy={27} r={2.2} fill={C.pupil} />
      <Circle cx={36.6} cy={25.7} r={2.2} fill={C.pupil} />
      <Circle cx={27.2} cy={26.1} r={0.8} fill={C.sparkle} />
      <Circle cx={35.8} cy={24.8} r={0.8} fill={C.sparkle} />
      {/* blush on the silver under the glass */}
      <Ellipse cx={23.4} cy={39.4} rx={2.4} ry={1.5} fill={C.blush} opacity={0.85} />
      <Ellipse cx={40.6} cy={39.4} rx={2.4} ry={1.5} fill={C.blush} opacity={0.85} />
      {/* dark recessed niches with STACKED pairs of small round lights */}
      <Rect x={14.6} y={39.5} width={5.8} height={9} rx={2} fill={NICHE} stroke={C.outline} strokeWidth={1.1} />
      <Rect x={43.6} y={39.5} width={5.8} height={9} rx={2} fill={NICHE} stroke={C.outline} strokeWidth={1.1} />
      <Circle cx={17.5} cy={42} r={1.6} fill={C.lens} />
      <Circle cx={17.5} cy={45.8} r={1.6} fill={C.amber} />
      <Circle cx={46.5} cy={42} r={1.6} fill={C.lens} />
      <Circle cx={46.5} cy={45.8} r={1.6} fill={C.amber} />
      {/* asymmetric smirk on the silver chin */}
      <Path
        d="M27.5 44 Q32 47.2 37.5 44.6 Q36 45.8 35 46"
        stroke={C.outline}
        strokeWidth={1.8}
        strokeLinecap="round"
        fill="none"
      />
      {/* grey skirt */}
      <Path
        d="M12.55 49 L51.45 49 L51.5 50 C51.5 52.8 49.5 54 47 54 L17 54 C14.5 54 12.5 52.8 12.5 50 Z"
        fill={C.grey}
      />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
