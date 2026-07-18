// Tatra T3 — the 1960s icon, traced from the real front: rounded 'bun' nose,
// huge wrap-around two-pane curved windscreen, and the classic tells — a BLUE
// route-number box centered above the glass, two BIG chrome-ringed round
// headlights set low in the RED belt whose apron dips in a shallow V between
// them, cream skirt + silver bumper below, yellow diamond pantograph.
// Expression: the kind old-timer.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const BODY =
  'M12.5 56 L12.5 30 C12.5 15 20 9 32 9 C44 9 51.5 15 51.5 30 L51.5 56 Q51.5 60 47.5 60 L16.5 60 Q12.5 60 12.5 56 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* yellow diamond (rhombus) pantograph */}
      <Path
        d="M26 7 L32 3.4 L38 7 L32 9.4 Z"
        stroke="#C29A25"
        strokeWidth={1.2}
        strokeLinejoin="round"
        fill="none"
      />
      <Line x1={28.6} y1={3.4} x2={35.4} y2={3.4} stroke="#6B6F75" strokeWidth={1.1} strokeLinecap="round" />
      {/* soft convex egg body — cream */}
      <Path d={BODY} fill={P.cream} />
      {/* BLUE route-number box centered on the brow — the classic-T3 tell */}
      <Rect x={26} y={11.2} width={12} height={5.2} rx={1} fill="#2050A8" />
      <Rect x={28.4} y={12.6} width={2.8} height={2.4} rx={0.4} fill="#F5F7FA" />
      <Rect x={32.8} y={12.6} width={2.8} height={2.4} rx={0.4} fill="#F5F7FA" />
      {/* wrap-around curved two-pane windscreen */}
      <Path
        d="M15.6 32.8 L15.6 24.6 C15.6 19.2 22 16.9 32 16.9 C42 16.9 48.4 19.2 48.4 24.6 L48.4 32.8 Q48.4 34.8 46.4 34.8 L17.6 34.8 Q15.6 34.8 15.6 32.8 Z"
        fill={P.glass}
      />
      {/* slim body-colored center pillar between the two panes */}
      <Line x1={32} y1={17} x2={32} y2={34.7} stroke={P.creamShade} strokeWidth={1.2} />
      {/* soft eye-glints, one per pane */}
      <Rect x={19.8} y={19.8} width={5.6} height={9.8} rx={2.8} fill={P.glint} opacity={0.42} />
      <Rect x={38.6} y={19.8} width={5.6} height={9.8} rx={2.8} fill={P.glint} opacity={0.42} />
      <Circle cx={22.6} cy={22.3} r={1.15} fill={P.glint} opacity={0.85} />
      <Circle cx={41.4} cy={22.3} r={1.15} fill={P.glint} opacity={0.85} />
      {/* RED belt — apron dips in a shallow V between the headlights */}
      <Path
        d="M12.5 38.3 H51.5 V49.4 C44 50 36.5 51.6 32 54.9 C27.5 51.6 20 50 12.5 49.4 Z"
        fill={P.red}
      />
      {/* thin cream pinstripe riding the top of the belt */}
      <Line x1={13.2} y1={38.3} x2={50.8} y2={38.3} stroke={P.creamShade} strokeWidth={0.8} opacity={0.9} />
      {/* twin BIG chrome-ringed round headlights, set low in the red */}
      <Circle cx={21.5} cy={46.3} r={3.6} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.6} />
      <Circle cx={42.5} cy={46.3} r={3.6} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.6} />
      <Circle cx={20.5} cy={45.3} r={1} fill={P.glint} opacity={0.9} />
      <Circle cx={41.5} cy={45.3} r={1} fill={P.glint} opacity={0.9} />
      {/* white fleet number between the lamps */}
      <Rect x={29} y={45.4} width={6} height={2} rx={0.6} fill="#F8F3E5" opacity={0.92} />
      {/* cream skirt below the red, then the silver bumper */}
      <Rect x={15.2} y={55.6} width={33.6} height={2.2} rx={1.1} fill={P.silver} />
      {/* dark coupling nub at the rails */}
      <Rect x={29.4} y={57.9} width={5.2} height={1.9} rx={0.7} fill={P.charcoal} />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
