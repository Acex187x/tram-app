// Chibi KT8D5.RN2P — the angular gentle giant, and the fleet's only
// two-headed tram. Boxy raked trapezoid head (no curves!), two big SQUARE
// glass eyes split by the center pillar, determined brows, the signature
// WHITE STRIPE sweeping across the red face as a giant swoosh-smile,
// rectangular headlights + round halogen refit lamps, square blush, and
// pantograph "ears" at BOTH top corners (bidirectional tell).
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BODY =
  'M13.5 51 C13.4 53.4 15 54 17 54 L47 54 C49 54 50.6 53.4 50.5 51 L49.5 13.5 C49.4 10.2 48 9.2 45 9.2 L19 9.2 C16 9.2 14.6 10.2 14.5 13.5 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* pantograph EARS at both corners — a cab at each end! */}
      <Path
        d="M17.5 9 L14 5.2 M12.6 4.8 L17 4.8 M46.5 9 L50 5.2 M47 4.8 L51.4 4.8"
        stroke="#4A5566"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* boxy trapezoid body, cream upper */}
      <Path d={BODY} fill={C.cream} />
      {/* red lower face */}
      <Path d="M14.05 32 L49.95 32 L50.5 51 C50.6 53.4 49 54 47 54 L17 54 C15 54 13.4 53.4 13.5 51 Z" fill={C.red} />
      {/* signature white stripe sweeping across the red — doubles as a huge grin */}
      <Path
        d="M13.9 46.5 Q32 36.5 50.1 46.5 L50.2 50.5 Q32 41 13.8 50.5 Z"
        fill={C.white}
        stroke={C.outline}
        strokeWidth={1.1}
      />
      {/* full-width destination display across the flat roofline */}
      <Rect x={17} y={11} width={30} height={5.2} rx={1.6} fill={C.dark} />
      <Circle cx={22} cy={13.6} r={0.8} fill={C.amber} />
      <Circle cx={25.4} cy={13.6} r={0.8} fill={C.amber} />
      <Circle cx={28.8} cy={13.6} r={0.8} fill={C.amber} />
      <Circle cx={34.6} cy={13.6} r={0.8} fill={C.amber} opacity={0.55} />
      <Circle cx={38} cy={13.6} r={0.8} fill={C.amber} />
      <Circle cx={41.4} cy={13.6} r={0.8} fill={C.amber} />
      {/* two big SQUARE eyes with the center-pillar gap between them */}
      <Rect x={17.5} y={19} width={12.6} height={11} rx={2.4} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      <Rect x={33.9} y={19} width={12.6} height={11} rx={2.4} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      {/* square pupils + sparkles */}
      <Rect x={22.4} y={22.4} width={5.4} height={5.6} rx={1.3} fill={C.pupil} />
      <Rect x={36.2} y={22.4} width={5.4} height={5.6} rx={1.3} fill={C.pupil} />
      <Circle cx={23.4} cy={23.6} r={1.3} fill={C.sparkle} />
      <Circle cx={37.2} cy={23.6} r={1.3} fill={C.sparkle} />
      {/* determined-but-kind thick brows */}
      <Path d="M18.5 17 L29 16.2" stroke={C.outline} strokeWidth={2.2} strokeLinecap="round" />
      <Path d="M45.5 17 L35 16.2" stroke={C.outline} strokeWidth={2.2} strokeLinecap="round" />
      {/* SQUARE blush — even the blush is angular */}
      <Rect x={15.3} y={34.2} width={4.6} height={2.8} rx={1} fill={C.blush} opacity={0.85} />
      <Rect x={44.1} y={34.2} width={4.6} height={2.8} rx={1} fill={C.blush} opacity={0.85} />
      {/* rectangular headlights + round halogen lamps from the modernization */}
      <Rect x={17.6} y={49} width={4.6} height={2.8} rx={0.8} fill={C.lens} stroke={C.outline} strokeWidth={0.9} />
      <Rect x={41.8} y={49} width={4.6} height={2.8} rx={0.8} fill={C.lens} stroke={C.outline} strokeWidth={0.9} />
      <Circle cx={26} cy={50.4} r={1.6} fill={C.lens} stroke={C.outline} strokeWidth={0.9} />
      <Circle cx={38} cy={50.4} r={1.6} fill={C.lens} stroke={C.outline} strokeWidth={0.9} />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
