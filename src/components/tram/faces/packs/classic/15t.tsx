// Škoda 15T ForCity Alfa — the sloped face with the silver light-band. A RED
// brow/cap flows over the roof and down the A-pillars around one HUGE raked
// black curved windscreen (orange LED route display inside its top). Below the
// glass: a SILVER horizontal mid-band carrying clusters of ROUND headlights at
// each side; below that, a RED bumper with white DRL pills. Single-arm
// pantograph. Expression: the modern workhorse, calm and wide-eyed.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const MASK = '#14181D';

const BODY =
  'M12.8 56.5 L13.6 16.5 Q13.8 10.5 19.8 10.5 L44.2 10.5 Q50.2 10.5 50.4 16.5 L51.2 56.5 Q51.3 59.6 48 59.6 L16 59.6 Q12.7 59.6 12.8 56.5 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* single-arm pantograph */}
      <Path d="M32 10 L40 5" stroke="#8A8E94" strokeWidth={1.3} strokeLinecap="round" fill="none" />
      <Line x1={36.8} y1={4.2} x2={43.2} y2={4.2} stroke="#6B6F75" strokeWidth={1.1} strokeLinecap="round" />
      {/* body — RED cap, brow and pillars (base coat) */}
      <Path d={BODY} fill={P.pidRed} />
      {/* HUGE raked curved black windscreen, inset so red frames it */}
      <Path
        d="M17.2 40.6 L17.8 19.4 Q18 14.2 23.2 14.2 L40.8 14.2 Q46 14.2 46.2 19.4 L46.8 40.6 Q46.8 42.2 45.2 42.2 L18.8 42.2 Q17.2 42.2 17.2 40.6 Z"
        fill={MASK}
      />
      {/* orange LED route display inside the top of the glass */}
      <Rect x={21.4} y={16.2} width={3.4} height={2.2} rx={0.5} fill={P.ledOrange} />
      <Rect x={26.4} y={16.5} width={14.2} height={1.7} rx={0.8} fill={P.ledOrange} opacity={0.8} />
      {/* deep curved glass sheen */}
      <Rect x={22} y={20.4} width={6.6} height={19.6} rx={3.3} fill={P.glint} opacity={0.28} />
      <Rect x={37.2} y={20.4} width={4.6} height={19.6} rx={2.3} fill={P.glint} opacity={0.18} />
      <Circle cx={25.4} cy={23.2} r={1.1} fill={P.glint} opacity={0.8} />
      {/* SILVER horizontal mid-band below the glass — the 15T signature */}
      <Rect x={13.1} y={43} width={37.8} height={7} fill={P.chrome} />
      {/* round headlight clusters set into the band at each side */}
      <Circle cx={18.6} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={23.2} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={26.9} cy={46.5} r={1.15} fill={P.amber} />
      <Circle cx={45.4} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={40.8} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={37.1} cy={46.5} r={1.15} fill={P.amber} />
      {/* Škoda roundel centered in the band */}
      <Circle cx={32} cy={46.5} r={1.5} fill="none" stroke="#3D8B57" strokeWidth={0.9} />
      {/* RED bumper below with white DRL pills */}
      <Rect x={16.4} y={52.6} width={7.2} height={2.2} rx={1.1} fill="#FFFFFF" />
      <Rect x={40.4} y={52.6} width={7.2} height={2.2} rx={1.1} fill="#FFFFFF" />
      {/* white fleet number chip centered on the red bumper */}
      <Rect x={28.9} y={52.7} width={6.2} height={2} rx={0.5} fill="#FFFFFF" opacity={0.92} />
      {/* dark skirt shadow at the rails */}
      <Rect x={16} y={57.4} width={32} height={1.4} rx={0.7} fill={P.charcoal} />
      {/* crisp silhouette re-stroked */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
