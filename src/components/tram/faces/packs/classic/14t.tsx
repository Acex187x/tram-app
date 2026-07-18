// Škoda 14T "Elektra" — the Porsche-designed WEDGE. Angular SILVER cab, tall
// flat raked windscreen in a black frame that WIDENS DOWNWARD (trapezoid),
// green LED route display up in the glass, vertical clusters of small round
// lens lights recessed in dark niches low at each corner (amber on top), red
// body flanks peeking past the silver nose, single-arm pantograph.
// Expression: sharp, faceted, sporty.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const MASK = '#101317';
const NICHE = '#22262B';

const BODY =
  'M13.2 56.8 L14.9 12.6 Q15 10 17.6 10 L46.4 10 Q49 10 49.1 12.6 L50.8 56.8 Q50.9 59.6 47.9 59.6 L16.1 59.6 Q13.1 59.6 13.2 56.8 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* single-arm pantograph */}
      <Path d="M32 9.6 L40 4.8" stroke="#8A8E94" strokeWidth={1.3} strokeLinecap="round" fill="none" />
      <Line x1={36.8} y1={4} x2={43.2} y2={4} stroke="#6B6F75" strokeWidth={1.1} strokeLinecap="round" />
      {/* angular SILVER wedge body */}
      <Path d={BODY} fill="#CDD1D6" />
      {/* soft sheen across the lower silver nose */}
      <Path d="M25.5 46.8 L38.5 46.8 L38.9 56.8 L25.1 56.8 Z" fill="#DBDEE2" opacity={0.5} />
      {/* RED body flanks peeking past the silver cab at each edge */}
      <Path d="M14.1 30 L18.6 30.6 L19.6 57.2 L13.6 57.2 Z" fill={P.pidRed} />
      <Path d="M49.9 30 L45.4 30.6 L44.4 57.2 L50.4 57.2 Z" fill={P.pidRed} />
      {/* black windscreen frame — trapezoid that WIDENS DOWNWARD */}
      <Path d="M24.2 13 L39.8 13 L44.6 46 L19.4 46 Z" fill={MASK} />
      {/* raked glass inside the frame */}
      <Path d="M25.5 14.8 L38.5 14.8 L42.6 44.2 L21.4 44.2 Z" fill={P.glass} />
      {/* green LED route display up in the glass */}
      <Rect x={26.6} y={16.4} width={10.8} height={2.2} rx={0.6} fill="#15130F" />
      <Rect x={27.6} y={17} width={2.2} height={1.1} rx={0.3} fill={P.ledGreen} />
      <Rect x={30.6} y={17} width={5.8} height={1.1} rx={0.5} fill={P.ledGreen} opacity={0.8} />
      {/* tilted wedge glints */}
      <Path d="M25.4 21 L29 21 L30.6 42.6 L26.6 42.6 Z" fill={P.glint} opacity={0.34} />
      <Path d="M35.6 21 L38 21 L39.6 42.6 L36.9 42.6 Z" fill={P.glint} opacity={0.24} />
      <Circle cx={27.4} cy={23.4} r={1} fill={P.glint} opacity={0.85} />
      {/* recessed dark light niches, vertical 3-lens stacks (amber on top) */}
      <Rect x={17.2} y={47} width={5.6} height={9.2} rx={1.4} fill={NICHE} />
      <Rect x={41.2} y={47} width={5.6} height={9.2} rx={1.4} fill={NICHE} />
      <Circle cx={20} cy={49.3} r={1.35} fill={P.amber} />
      <Circle cx={20} cy={52.2} r={1.35} fill={P.warmLens} />
      <Circle cx={20} cy={55} r={1.35} fill={P.warmLens} />
      <Circle cx={44} cy={49.3} r={1.35} fill={P.amber} />
      <Circle cx={44} cy={52.2} r={1.35} fill={P.warmLens} />
      <Circle cx={44} cy={55} r={1.35} fill={P.warmLens} />
      {/* Škoda roundel + charcoal fleet plate under the glass */}
      <Circle cx={32} cy={48.6} r={1.5} fill="none" stroke="#3D8B57" strokeWidth={0.9} />
      <Rect x={28.9} y={51.6} width={6.2} height={2} rx={0.5} fill="#4A4F55" />
      {/* grey skirt line at the rails */}
      <Rect x={16} y={57.4} width={32} height={1.4} rx={0.7} fill={P.silverDark} />
      {/* crisp silhouette re-stroked */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
