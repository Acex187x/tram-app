// Chibi T3 — the round friendly classic. Grounded in the real car: cream bun
// nose with a split two-pane windscreen, the BLUE route-number box above the
// glass (the classic-T3 tell), a bold RED apron whose top edge dips in a
// shallow V, two BIG chrome-ringed round headlights set LOW in the red, a
// cream skirt below, and the yellow DIAMOND pantograph up top.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BLUE = '#2456A4'; // route-number box
const PANTO = '#D9A62E'; // yellow diamond pantograph

const BODY =
  'M11 50 C11 52.8 13 54 15.5 54 L48.5 54 C51 54 53 52.8 53 50 L53 25 C53 12.5 44 7 32 7 C20 7 11 12.5 11 25 Z';

// red apron: top edge dips in a shallow V at center, cream skirt stays below
const APRON =
  'M11 33.5 L28.5 33.5 L32 36.6 L35.5 33.5 L53 33.5 L53 48 L11 48 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* yellow DIAMOND (rhombus) pantograph */}
      <Path
        d="M32 1.4 L37.4 4.3 L32 7.2 L26.6 4.3 Z"
        stroke={PANTO}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
      {/* cream bun body */}
      <Path d={BODY} fill={C.cream} />
      {/* BLUE route-number box above the windscreen — the classic tell */}
      <Rect x={25.2} y={9.4} width={13.6} height={6} rx={1.3} fill={BLUE} stroke={C.outline} strokeWidth={1} />
      <Path d="M28.6 13.2 Q28.6 10.9 30.4 10.9 Q31.8 10.9 31.8 12 L29 13.2 Z" fill={C.sparkle} />
      <Path d="M33.2 10.9 L36.4 10.9 L34.2 13.3" stroke={C.sparkle} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      {/* split windscreen: two rounded panes with a cream center pillar */}
      <Rect x={14.6} y={17.6} width={16} height={13.2} rx={4.4} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      <Rect x={33.4} y={17.6} width={16} height={13.2} rx={4.4} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      {/* big soft eyes in the glass */}
      <Circle cx={23.4} cy={24.6} r={3.8} fill={C.pupil} />
      <Circle cx={40.6} cy={24.6} r={3.8} fill={C.pupil} />
      <Circle cx={22.1} cy={23.1} r={1.5} fill={C.sparkle} />
      <Circle cx={39.3} cy={23.1} r={1.5} fill={C.sparkle} />
      <Circle cx={24.8} cy={26.4} r={0.7} fill={C.sparkle} opacity={0.85} />
      <Circle cx={42} cy={26.4} r={0.7} fill={C.sparkle} opacity={0.85} />
      {/* rosy blush on the cream just under the glass */}
      <Ellipse cx={17.6} cy={32.2} rx={2.5} ry={1.5} fill={C.blush} opacity={0.85} />
      <Ellipse cx={46.4} cy={32.2} rx={2.5} ry={1.5} fill={C.blush} opacity={0.85} />
      {/* RED apron with the shallow center V dip */}
      <Path d={APRON} fill={C.red} />
      <Line x1={11} y1={48} x2={53} y2={48} stroke={C.outline} strokeWidth={0.9} opacity={0.35} />
      {/* two BIG chrome-ringed round headlights, LOW in the red */}
      <Circle cx={20.5} cy={42} r={3.5} fill={C.lens} stroke={C.chrome} strokeWidth={1.7} />
      <Circle cx={43.5} cy={42} r={3.5} fill={C.lens} stroke={C.chrome} strokeWidth={1.7} />
      <Circle cx={19.4} cy={40.9} r={1} fill={C.sparkle} opacity={0.95} />
      <Circle cx={42.4} cy={40.9} r={1} fill={C.sparkle} opacity={0.95} />
      {/* warm cream smile between the lights */}
      <Path
        d="M27.5 42.6 Q32 46.2 36.5 42.6"
        stroke={C.cream}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
