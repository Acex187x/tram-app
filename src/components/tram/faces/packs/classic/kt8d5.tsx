// Tatra KT8D5 — the big boxy long one. Angular, flat, slightly-raked WIDE
// front: a dark anthracite mask holds the flat two-pane windscreen (center
// pillar), an ORANGE route box rides the white roof band, and the lower front
// is RED with two round headlights sitting just above a full-width WHITE
// bumper stripe; dark plow chin at the rails. Diamond pantograph.
// Expression: broad and dependable.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const KT_WHITE = '#EFEEE9';
const ANTHRACITE = '#22262B';

const BODY =
  'M11.2 55.5 L12.8 13.5 Q13 10.5 16 10.5 L48 10.5 Q51 10.5 51.2 13.5 L52.8 55.5 Q52.9 58.5 50 58.5 L14 58.5 Q11.1 58.5 11.2 55.5 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* yellow diamond (rhombus) pantograph */}
      <Path
        d="M26 8 L32 4.4 L38 8 L32 10.4 Z"
        stroke="#C29A25"
        strokeWidth={1.2}
        strokeLinejoin="round"
        fill="none"
      />
      <Line x1={28.6} y1={4.4} x2={35.4} y2={4.4} stroke="#6B6F75" strokeWidth={1.1} strokeLinecap="round" />
      {/* boxy raked trapezoid body — white roof band on top */}
      <Path d={BODY} fill={KT_WHITE} />
      {/* ORANGE route-number box centered on the roof band — the KT8 tell */}
      <Rect x={27.9} y={11.4} width={8.2} height={5} rx={0.8} fill="#E8891B" />
      <Rect x={30.4} y={12.8} width={3.2} height={2.3} rx={0.4} fill="#25211B" />
      {/* dark anthracite window mask, full width */}
      <Rect x={13.4} y={17.2} width={37.2} height={17.2} rx={1.8} fill={ANTHRACITE} />
      {/* FLAT two-pane windscreen split by the center pillar */}
      <Rect x={15.6} y={19} width={14.6} height={13.2} rx={1} fill={P.glass} />
      <Rect x={33.8} y={19} width={14.6} height={13.2} rx={1} fill={P.glass} />
      {/* tall steady glints */}
      <Rect x={18} y={20.8} width={4.4} height={9.6} rx={2.2} fill={P.glint} opacity={0.4} />
      <Rect x={36.2} y={20.8} width={4.4} height={9.6} rx={2.2} fill={P.glint} opacity={0.4} />
      <Circle cx={20.2} cy={23} r={0.95} fill={P.glint} opacity={0.8} />
      <Circle cx={38.4} cy={23} r={0.95} fill={P.glint} opacity={0.8} />
      {/* big RED lower front */}
      <Path
        d="M12 34.4 L52 34.4 L52.8 55.5 Q52.9 58.5 50 58.5 L14 58.5 Q11.1 58.5 11.2 55.5 L12 34.4 Z"
        fill={P.red}
      />
      {/* yellow fleet number centered on the red */}
      <Rect x={28.6} y={38.4} width={6.8} height={2.2} rx={0.6} fill={P.gold} />
      {/* two round headlights, one out at each side, low on the red */}
      <Circle cx={18.8} cy={47.8} r={3} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.4} />
      <Circle cx={45.2} cy={47.8} r={3} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.4} />
      <Circle cx={17.9} cy={46.9} r={0.85} fill={P.glint} opacity={0.9} />
      <Circle cx={44.3} cy={46.9} r={0.85} fill={P.glint} opacity={0.9} />
      {/* full-width WHITE bumper stripe under the lights */}
      <Rect x={11.7} y={51.6} width={40.6} height={3.2} fill={KT_WHITE} />
      {/* amber corner blinkers riding the white stripe */}
      <Rect x={13} y={52.1} width={2.6} height={2.2} rx={0.5} fill={P.amber} />
      <Rect x={48.4} y={52.1} width={2.6} height={2.2} rx={0.5} fill={P.amber} />
      {/* dark plow chin at the rails */}
      <Path d="M15 56.2 L49 56.2 L46 60.4 L18 60.4 Z" fill={P.charcoal} />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
