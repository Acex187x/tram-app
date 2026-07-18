// Škoda 14T "Elektra" — the Porsche-designed WEDGE. Faceted angular silhouette
// (straight chamfered corners, no soft rounds), SILVER-dominant cab, tall flat
// raked windscreen in a black frame that WIDENS DOWNWARD (trapezoid), green
// LED route display up in the glass, vertical clusters of small round lens
// lights recessed in dark niches low at each corner (amber below), slim RED
// body flanks peeking past the silver nose at the edges, single-arm
// pantograph. Expression: sharp, faceted, sporty.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const MASK = '#101317';
const NICHE = '#22262B';

// Angular wedge: chamfered roof corners, straight flanks, chamfered base.
const BODY =
  'M13.4 56.9 L15.3 13.8 L17.8 10.1 L46.2 10.1 L48.7 13.8 L50.6 56.9 L48.8 59.6 L15.2 59.6 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* single-arm pantograph */}
      <Path d="M32 9.6 L40 4.8" stroke="#8A8E94" strokeWidth={1.3} strokeLinecap="round" fill="none" />
      <Line x1={36.8} y1={4} x2={43.2} y2={4} stroke="#6B6F75" strokeWidth={1.1} strokeLinecap="round" />
      {/* angular SILVER wedge body */}
      <Path d={BODY} fill="#CDD1D6" />
      {/* soft sheen across the lower silver nose */}
      <Path d="M25.6 47.4 L38.4 47.4 L38.8 56.9 L25.2 56.9 Z" fill="#DDE0E4" opacity={0.55} />
      {/* slim RED body flanks peeking past the silver cab at each edge */}
      <Path d="M14.35 33 L17.6 33.4 L18.3 57 L13.55 57 Z" fill={P.pidRed} />
      <Path d="M49.65 33 L46.4 33.4 L45.7 57 L50.45 57 Z" fill={P.pidRed} />
      {/* black windscreen frame — trapezoid that WIDENS DOWNWARD */}
      <Path d="M24.6 12.4 L39.4 12.4 L45.2 45.6 L18.8 45.6 Z" fill={MASK} />
      {/* raked glass inside the frame */}
      <Path d="M25.8 14.2 L38.2 14.2 L43.2 43.8 L20.8 43.8 Z" fill={P.glass} />
      {/* green LED route display up in the glass */}
      <Rect x={26.4} y={16} width={11.2} height={2.4} rx={0.6} fill="#15130F" />
      <Rect x={27.4} y={16.7} width={2.2} height={1.1} rx={0.3} fill={P.ledGreen} />
      <Rect x={30.4} y={16.7} width={6} height={1.1} rx={0.5} fill={P.ledGreen} opacity={0.8} />
      {/* tilted wedge glints */}
      <Path d="M25.8 21 L29.2 21 L30.9 42.2 L27 42.2 Z" fill={P.glint} opacity={0.34} />
      <Path d="M35.6 21 L38 21 L39.7 42.2 L37 42.2 Z" fill={P.glint} opacity={0.24} />
      <Circle cx={27.6} cy={23.4} r={1} fill={P.glint} opacity={0.85} />
      {/* facet crease lines running from the windscreen corners to the skirt */}
      <Line x1={18.8} y1={45.6} x2={17.7} y2={57} stroke={P.silverDark} strokeWidth={0.8} opacity={0.5} />
      <Line x1={45.2} y1={45.6} x2={46.3} y2={57} stroke={P.silverDark} strokeWidth={0.8} opacity={0.5} />
      {/* roof chamfer creases echoing the faceted cab */}
      <Line x1={24.6} y1={12.4} x2={17.8} y2={10.1} stroke={P.silverDark} strokeWidth={0.7} opacity={0.45} />
      <Line x1={39.4} y1={12.4} x2={46.2} y2={10.1} stroke={P.silverDark} strokeWidth={0.7} opacity={0.45} />
      {/* recessed dark light niches, vertical lens stacks (amber below) */}
      <Rect x={19} y={46.6} width={5.6} height={9.4} rx={1.4} fill={NICHE} />
      <Rect x={39.4} y={46.6} width={5.6} height={9.4} rx={1.4} fill={NICHE} />
      <Circle cx={21.8} cy={48.9} r={1.35} fill={P.warmLens} />
      <Circle cx={21.8} cy={51.9} r={1.35} fill={P.warmLens} />
      <Circle cx={21.8} cy={54.7} r={1.35} fill={P.amber} />
      <Circle cx={42.2} cy={48.9} r={1.35} fill={P.warmLens} />
      <Circle cx={42.2} cy={51.9} r={1.35} fill={P.warmLens} />
      <Circle cx={42.2} cy={54.7} r={1.35} fill={P.amber} />
      {/* Škoda roundel + charcoal fleet plate under the glass */}
      <Circle cx={32} cy={48.4} r={1.5} fill="none" stroke="#3D8B57" strokeWidth={0.9} />
      <Rect x={28.9} y={51.4} width={6.2} height={2} rx={0.5} fill="#4A4F55" />
      {/* grey skirt line at the rails */}
      <Rect x={15.8} y={57.4} width={32.4} height={1.4} rx={0.7} fill={P.silverDark} />
      {/* crisp silhouette re-stroked */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
