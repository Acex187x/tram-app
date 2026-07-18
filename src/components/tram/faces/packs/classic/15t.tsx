// Škoda 15T ForCity Alfa — the strongly RAKED face. The body tapers toward the
// roof (windscreen leans back), one HUGE curved black windscreen bulges out to
// the body edges so the RED reads as a brow/cap over the roof that thins down
// the A-pillars (orange LED route display inside the glass top). Below the
// glass: a SILVER horizontal mid-band carrying clusters of ROUND headlights at
// each side; below that, a RED bumper with white DRL pills. Single-arm
// pantograph. Expression: the modern workhorse, calm and wide-eyed.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const MASK = '#14181D';

// Trapezoid silhouette — narrow rounded roof, wide base = the raked nose.
const BODY =
  'M12.6 56.6 L14.9 15.8 Q15.6 10.2 21.2 10.2 L42.8 10.2 Q48.4 10.2 49.1 15.8 L51.4 56.6 Q51.5 59.6 48.2 59.6 L15.8 59.6 Q12.5 59.6 12.6 56.6 Z';

// Curved windscreen: narrow at the top, sides bow outward, flat sill.
const GLASS =
  'M16.1 42.4 Q15.1 27 17.9 18.2 Q19.2 13.6 24.4 13.6 L39.6 13.6 Q44.8 13.6 46.1 18.2 Q48.9 27 47.9 42.4 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* single-arm pantograph */}
      <Path d="M32 10 L40 5" stroke="#8A8E94" strokeWidth={1.3} strokeLinecap="round" fill="none" />
      <Line x1={36.8} y1={4.2} x2={43.2} y2={4.2} stroke="#6B6F75" strokeWidth={1.1} strokeLinecap="round" />
      {/* body — RED cap/brow base coat (shows as brow + thin pillars + bumper) */}
      <Path d={BODY} fill={P.pidRed} />
      {/* HUGE raked curved black windscreen, bulging to the body edges */}
      <Path d={GLASS} fill={MASK} />
      {/* orange LED route display inside the top of the glass */}
      <Rect x={22.4} y={16.2} width={3.2} height={2.2} rx={0.5} fill={P.ledOrange} />
      <Rect x={27.2} y={16.6} width={13} height={1.6} rx={0.8} fill={P.ledOrange} opacity={0.8} />
      {/* curved glass sheen following the bowed sides */}
      <Path d="M22.4 20.6 Q21 31 22.9 40.6 L26.7 40.6 Q25.1 31 26.5 20.6 Z" fill={P.glint} opacity={0.26} />
      <Path d="M37.7 20.6 Q38.9 30 38.2 40.6 L41.3 40.6 Q42.5 30 40.7 20.6 Z" fill={P.glint} opacity={0.16} />
      <Circle cx={25.2} cy={23} r={1.1} fill={P.glint} opacity={0.8} />
      {/* SILVER horizontal mid-band below the glass — the 15T signature */}
      <Path d="M13.35 43.2 L50.65 43.2 L51 49.8 L13 49.8 Z" fill={P.chrome} />
      {/* round headlight clusters set into the band at each side */}
      <Circle cx={18.4} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={23} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={26.6} cy={46.5} r={1.1} fill={P.amber} />
      <Circle cx={45.6} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={41} cy={46.5} r={1.9} fill={P.warmLens} stroke={P.charcoal} strokeWidth={0.9} />
      <Circle cx={37.4} cy={46.5} r={1.1} fill={P.amber} />
      {/* Škoda roundel centered in the band */}
      <Circle cx={32} cy={46.5} r={1.5} fill="none" stroke="#3D8B57" strokeWidth={0.9} />
      {/* RED bumper below with white DRL pills */}
      <Rect x={16.8} y={52.4} width={7} height={2.2} rx={1.1} fill="#FFFFFF" />
      <Rect x={40.2} y={52.4} width={7} height={2.2} rx={1.1} fill="#FFFFFF" />
      {/* white fleet number chip centered on the red bumper */}
      <Rect x={28.9} y={52.5} width={6.2} height={2} rx={0.5} fill="#FFFFFF" opacity={0.92} />
      {/* dark skirt shadow at the rails */}
      <Rect x={15.5} y={57.4} width={33} height={1.4} rx={0.7} fill={P.charcoal} />
      {/* crisp silhouette re-stroked */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
