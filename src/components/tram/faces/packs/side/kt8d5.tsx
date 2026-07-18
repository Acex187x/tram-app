// Side Profile pack — Tatra KT8D5: NOSE PORTRAIT in side view. The BOXY one:
// all straight lines — chamfered roof corner, a flat windscreen on a single
// moderate rake, then a near-vertical slab of lower front down to the bumper
// chamfer. Grey window band over the bold red belt with a white skirt,
// rectangular headlamp, orange LED brow. Diamond-pantograph horns. Nose left.
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  body: '#ECEAE3',
  band: '#63676D',
  red: '#C8352C',
  door: '#D7D5CE',
  glass: '#5E7E92',
  roof: '#7A7E84',
  ledOrange: '#FF9D2E',
  panto: '#C89A2E',
  dark: '#23272E',
  lens: '#FFD98F',
} as const;

// Angular KT8D5 prow, all straight segments; body runs off the right edge.
const BODY = 'M63 17.5 L27.5 17.5 L21.8 19.6 L18.6 32.5 L18.3 43.5 L21.4 48.6 L63 48.6 Z';

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <ClipPath id="sideKt8Plate">
          <Rect x={1.5} y={1.5} width={61} height={61} rx={14} />
        </ClipPath>
        <ClipPath id="sideKt8Body">
          <Path d={BODY} />
        </ClipPath>
      </Defs>
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <G clipPath="url(#sideKt8Plate)">
        {/* diamond-pantograph horns */}
        <Path d="M45 8.6 L51 13 L45 17.4 L39 13 Z" fill="none" stroke={P.panto} strokeWidth={1.2} strokeLinejoin="round" />
        <Line x1={41.4} y1={8.1} x2={48.6} y2={8.1} stroke={P.panto} strokeWidth={1.3} strokeLinecap="round" />
        {/* rail + wheels peeking under the skirt */}
        <Line x1={7} y1={53.6} x2={57} y2={53.6} stroke={P.rail} strokeWidth={1.2} strokeLinecap="round" />
        <Circle cx={30} cy={50.1} r={3} fill={P.wheel} />
        <Circle cx={45} cy={50.1} r={3} fill={P.wheel} />
        {/* boxy slab prow */}
        <Path d={BODY} fill={P.body} />
        <G clipPath="url(#sideKt8Body)">
          <Rect x={14} y={17.5} width={50} height={1.9} fill={P.roof} />
          {/* grey window band */}
          <Rect x={14} y={20.8} width={50} height={11.6} fill={P.band} />
          {/* red belt (white skirt stays below) */}
          <Rect x={14} y={33.2} width={50} height={9.6} fill={P.red} />
        </G>
        {/* flat raked windscreen — one straight slope, the boxy tell */}
        <Path d="M23.4 20.8 L20.6 31.6 L29 31.6 L29 20.8 Z" fill={P.glass} />
        {/* cab side window in the band */}
        <Rect x={31.5} y={21.6} width={9} height={9.6} rx={0.6} fill={P.glass} />
        {/* tall double folding door */}
        <Rect x={42.5} y={19.6} width={9.5} height={27.6} fill={P.door} />
        <Rect x={43.6} y={21.6} width={7.3} height={8.6} rx={0.6} fill={P.glass} />
        <Line x1={47.25} y1={20} x2={47.25} y2={46.8} stroke={P.dark} strokeWidth={0.5} opacity={0.65} />
        {/* saloon window behind the door */}
        <Rect x={54} y={21.6} width={8} height={9.6} rx={0.6} fill={P.glass} />
        {/* orange LED destination display on the brow */}
        <Rect x={22.6} y={18.2} width={8.4} height={2.9} rx={0.4} fill={P.dark} />
        <Rect x={23.6} y={19.3} width={3} height={0.9} fill={P.ledOrange} />
        <Rect x={27.4} y={19.3} width={2.4} height={0.9} fill={P.ledOrange} />
        {/* rectangular headlamp on the vertical lower front */}
        <Rect x={19} y={35.4} width={2.9} height={2.2} rx={0.3} fill={P.lens} stroke={P.dark} strokeWidth={0.45} />
        <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={1.1} />
      </G>
    </Svg>
  );
}
