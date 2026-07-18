// Tatra T3R.PLF — the SILVER T3. Same rounded egg, but the body is silver-grey,
// the windscreen is one smooth SINGLE curved pane (no center pillar), and a
// dark WINE gull-wing bib sweeps under the glass, dipping to a point between
// the two round silver-ringed headlights. Green LED destination in the brow,
// diamond pantograph. Expression: the polished heritage rebuild.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const SILVER_BODY = '#D6D9DD';

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
      {/* T3 egg body — SILVER-grey */}
      <Path d={BODY} fill={SILVER_BODY} />
      {/* green LED destination display in the brow */}
      <Rect x={20.5} y={11.6} width={23} height={4.6} rx={1} fill="#15130F" />
      <Rect x={22.4} y={12.9} width={3} height={2} rx={0.4} fill={P.ledGreen} />
      <Rect x={27.2} y={13.1} width={13} height={1.6} rx={0.8} fill={P.ledGreen} opacity={0.8} />
      {/* ONE-PIECE smooth curved windscreen — no center pillar */}
      <Path
        d="M15.6 32.6 L15.6 24.6 C15.6 19.2 22 16.9 32 16.9 C42 16.9 48.4 19.2 48.4 24.6 L48.4 32.6 Q48.4 34.6 46.4 34.6 L17.6 34.6 Q15.6 34.6 15.6 32.6 Z"
        fill={P.glass}
      />
      {/* one wide calm glint across the single pane */}
      <Rect x={20} y={19.6} width={9} height={10} rx={4} fill={P.glint} opacity={0.38} />
      <Rect x={37} y={19.6} width={6.4} height={10} rx={3.2} fill={P.glint} opacity={0.26} />
      <Circle cx={24} cy={22.2} r={1.15} fill={P.glint} opacity={0.85} />
      {/* white fleet-number plate at the LEFT on the silver strip under the glass */}
      <Rect x={16.6} y={35.6} width={8} height={2.8} rx={0.5} fill="#FAFAF8" />
      <Rect x={17.6} y={36.5} width={6} height={1.1} rx={0.3} fill="#2C3036" />
      {/* WINE bib — two arches over the headlights meeting at a center V point */}
      <Path
        d="M13 39 H51 V51.6 Q48 46 41.5 46 Q34.8 46 32 52.8 Q29.2 46 22.5 46 Q16 46 13 51.6 Z"
        fill={P.wine}
      />
      {/* two round chrome-ringed headlights in the silver pockets under the arches */}
      <Circle cx={22.5} cy={48.8} r={3.1} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.5} />
      <Circle cx={41.5} cy={48.8} r={3.1} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.5} />
      <Circle cx={21.7} cy={48} r={0.9} fill={P.glint} opacity={0.9} />
      <Circle cx={40.7} cy={48} r={0.9} fill={P.glint} opacity={0.9} />
      {/* amber indicators tucked at the body edges */}
      <Rect x={13.5} y={46.8} width={2.3} height={3.4} rx={0.6} fill={P.amber} />
      <Rect x={48.2} y={46.8} width={2.3} height={3.4} rx={0.6} fill={P.amber} />
      {/* smooth grey bumper molding + underframe */}
      <Rect x={15} y={55.4} width={34} height={2.4} rx={1.2} fill={P.silverDark} />
      <Rect x={29.4} y={57.9} width={5.2} height={1.9} rx={0.7} fill={P.charcoal} />
      {/* crisp silhouette re-stroked over the livery */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
