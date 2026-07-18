// Tatra T3R.P — the modernized classic: IDENTICAL T3 egg silhouette and
// cream/red livery, but the brow carries a black box with a GREEN-YELLOW LED
// destination display (replacing the blue route box), the round headlights
// get dark modern rims, rectangular AMBER turn signals sit by the body edges,
// and the fleet number is YELLOW on a deeper red belt. Expression: the classic
// with new glasses.
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
      {/* same T3 egg body — cream */}
      <Path d={BODY} fill={P.cream} />
      {/* green LED destination display in the brow — the T3R.P tell */}
      <Rect x={20} y={11.6} width={24} height={4.6} rx={1} fill="#15130F" />
      <Rect x={21.9} y={12.9} width={3} height={2} rx={0.4} fill={P.ledGreen} />
      <Rect x={26.7} y={13.1} width={13.6} height={1.6} rx={0.8} fill={P.ledGreen} opacity={0.8} />
      {/* wrap-around curved two-pane windscreen */}
      <Path
        d="M15.6 32.8 L15.6 24.6 C15.6 19.2 22 16.9 32 16.9 C42 16.9 48.4 19.2 48.4 24.6 L48.4 32.8 Q48.4 34.8 46.4 34.8 L17.6 34.8 Q15.6 34.8 15.6 32.8 Z"
        fill={P.glass}
      />
      <Line x1={32} y1={17} x2={32} y2={34.7} stroke={P.creamShade} strokeWidth={1.2} />
      <Rect x={19.8} y={19.8} width={5.6} height={9.8} rx={2.8} fill={P.glint} opacity={0.42} />
      <Rect x={38.6} y={19.8} width={5.6} height={9.8} rx={2.8} fill={P.glint} opacity={0.42} />
      <Circle cx={22.6} cy={22.3} r={1.15} fill={P.glint} opacity={0.85} />
      <Circle cx={41.4} cy={22.3} r={1.15} fill={P.glint} opacity={0.85} />
      {/* deeper red belt with a nearly straight lower edge */}
      <Path d="M12.5 38.3 H51.5 V52.6 Q42 53.8 32 53.8 Q22 53.8 12.5 52.6 Z" fill={P.red} />
      <Line x1={13.2} y1={38.3} x2={50.8} y2={38.3} stroke={P.creamShade} strokeWidth={0.8} opacity={0.9} />
      {/* round headlights with dark modern rims */}
      <Circle cx={21.5} cy={46.6} r={3.3} fill={P.warmLens} stroke={P.charcoal} strokeWidth={1.6} />
      <Circle cx={42.5} cy={46.6} r={3.3} fill={P.warmLens} stroke={P.charcoal} strokeWidth={1.6} />
      <Circle cx={20.6} cy={45.7} r={0.95} fill={P.glint} opacity={0.9} />
      <Circle cx={41.6} cy={45.7} r={0.95} fill={P.glint} opacity={0.9} />
      {/* rectangular AMBER turn signals out by the body edges */}
      <Rect x={14} y={44.6} width={2.7} height={4} rx={0.7} fill={P.amber} />
      <Rect x={47.3} y={44.6} width={2.7} height={4} rx={0.7} fill={P.amber} />
      {/* YELLOW fleet number on the red between the lamps */}
      <Rect x={28.8} y={45.6} width={6.4} height={2.1} rx={0.6} fill={P.gold} />
      {/* thin cream skirt, then the silver bumper */}
      <Rect x={15.2} y={55.6} width={33.6} height={2.2} rx={1.1} fill={P.silver} />
      <Rect x={29.4} y={57.9} width={5.2} height={1.9} rx={0.7} fill={P.charcoal} />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
