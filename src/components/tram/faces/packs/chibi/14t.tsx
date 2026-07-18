// Chibi 14T — the quirky "Porsche caterpillar". Smooth one-piece dome mask,
// ONE big raked visor windscreen shared by two slightly-mismatched googly
// pupils (its lovable oddball personality), round lamp clusters recessed low
// into the mask as rosy cheeks, grey skirt, asymmetric smirk, and three tiny
// caterpillar segment bumps peeking over the roofline.
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BODY =
  'M10.5 50 C10.5 52.8 12.5 54 15 54 L49 54 C51.5 54 53.5 52.8 53.5 50 L53.5 29 C53.5 14.5 44.5 7.5 32 7.5 C19.5 7.5 10.5 14.5 10.5 29 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20.5} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* three caterpillar segment bumps peeking behind the roof */}
      <Path
        d="M20 8.6 C21 5.9 25 5.9 26 8 C27.5 5.4 31.5 5.4 33 7.6 C34.5 5.2 38.5 5.2 40 7.8"
        stroke={C.outline}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
        opacity={0.85}
      />
      {/* smooth cream dome mask */}
      <Path d={BODY} fill={C.cream} />
      {/* red mid band and grey skirt */}
      <Rect x={10.5} y={39.5} width={43} height={8} fill={C.red} />
      <Path
        d="M10.5 47.5 L53.5 47.5 L53.5 50 C53.5 52.8 51.5 54 49 54 L15 54 C12.5 54 10.5 52.8 10.5 50 Z"
        fill={C.grey}
      />
      {/* ONE big raked visor windscreen with rounded top blending into the roof */}
      <Path
        d="M15 33 L15 22.5 C15 14.8 22 11.2 32 11.2 C42 11.2 49 14.8 49 22.5 L49 33 Q49 35.6 46.4 35.6 L17.6 35.6 Q15 35.6 15 33 Z"
        fill={C.glass}
        stroke={C.outline}
        strokeWidth={1.9}
      />
      {/* glass depth + one long reflection streak */}
      <Path d="M15 30 L49 30 L49 33 Q49 35.6 46.4 35.6 L17.6 35.6 Q15 35.6 15 33 Z" fill={C.glassDeep} opacity={0.55} />
      <Path d="M19.5 15.6 Q24 13.4 28.5 13.6 L24.5 20 Q20.5 20.5 18 22.8 Z" fill={C.sparkle} opacity={0.5} />
      {/* quirky googly pupils — right one rides a touch higher */}
      <Circle cx={25} cy={26.5} r={4.3} fill={C.pupil} />
      <Circle cx={39.5} cy={24.8} r={4.3} fill={C.pupil} />
      <Circle cx={23.6} cy={24.9} r={1.7} fill={C.sparkle} />
      <Circle cx={38.1} cy={23.2} r={1.7} fill={C.sparkle} />
      <Circle cx={26.6} cy={28.3} r={0.8} fill={C.sparkle} opacity={0.85} />
      <Circle cx={41.1} cy={26.6} r={0.8} fill={C.sparkle} opacity={0.85} />
      {/* silver Porsche-design beltline under the visor */}
      <Path d="M12 37.6 L52 37.6" stroke={C.silver} strokeWidth={1.4} strokeLinecap="round" />
      {/* round lamp clusters recessed low into the mask = rosy cheeks */}
      <Circle cx={17.8} cy={43.4} r={3.1} fill="#FFD9A6" stroke={C.outline} strokeWidth={1.4} />
      <Circle cx={46.2} cy={43.4} r={3.1} fill="#FFD9A6" stroke={C.outline} strokeWidth={1.4} />
      <Circle cx={16.9} cy={42.5} r={0.9} fill={C.sparkle} opacity={0.9} />
      <Circle cx={45.3} cy={42.5} r={0.9} fill={C.sparkle} opacity={0.9} />
      {/* asymmetric smirk — the oddball of the fleet */}
      <Path d="M27 43.2 Q31 45.9 36.5 43.6 Q35 44.9 34 45.1" stroke={C.outline} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
