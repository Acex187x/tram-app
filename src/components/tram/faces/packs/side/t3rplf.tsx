// Side Profile pack — Tatra T3R.PLF: NOSE PORTRAIT in side view. The T3
// bathtub prow again, but in the modernised low-floor dress: smooth silver /
// champagne body, a wine-red cheek mask that covers the lower nose and sweeps
// back along the flank, amber LED destination display in the brow, silver
// doors. Diamond-pantograph horns above. Nose faces left.
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  silver: '#D2D0C9',
  door: '#C0BEB6',
  wine: '#9E2233',
  glass: '#4E6B7E',
  roof: '#8A8D91',
  amber: '#FFB03A',
  panto: '#C89A2E',
  dark: '#23272E',
} as const;

// Same rounded T3 prow, nose at left; body runs off the right edge (clipped).
const BODY =
  'M63 18.5 L30 18.5 C24 18.8 21.6 21 20.6 24 C19.3 28 18.8 31.8 18.9 35 C19.2 41.8 20.6 46.8 25.2 49 L63 49 Z';

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <ClipPath id="sideT3plfPlate">
          <Rect x={1.5} y={1.5} width={61} height={61} rx={14} />
        </ClipPath>
        <ClipPath id="sideT3plfBody">
          <Path d={BODY} />
        </ClipPath>
      </Defs>
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <G clipPath="url(#sideT3plfPlate)">
        {/* diamond-pantograph horns */}
        <Path d="M45 9.4 L51 13.9 L45 18.4 L39 13.9 Z" fill="none" stroke={P.panto} strokeWidth={1.2} strokeLinejoin="round" />
        <Line x1={41.4} y1={8.9} x2={48.6} y2={8.9} stroke={P.panto} strokeWidth={1.3} strokeLinecap="round" />
        {/* rail + wheels peeking under the skirt */}
        <Line x1={7} y1={53.6} x2={57} y2={53.6} stroke={P.rail} strokeWidth={1.2} strokeLinecap="round" />
        <Circle cx={30} cy={50.3} r={3} fill={P.wheel} />
        <Circle cx={45} cy={50.3} r={3} fill={P.wheel} />
        {/* silver bathtub prow */}
        <Path d={BODY} fill={P.silver} />
        <G clipPath="url(#sideT3plfBody)">
          <Rect x={14} y={18.5} width={50} height={2.4} fill={P.roof} />
          {/* wine-red cheek mask: high on the nose, sweeping down along the flank */}
          <Path d="M14 33.5 C26 34.3 42 38 64 43.6 L64 50 L14 50 Z" fill={P.wine} />
        </G>
        {/* big near-vertical curved windscreen */}
        <Path d="M24.2 23 L29.2 23 L29.2 34.2 L21 34.2 C21.2 29.6 22.3 25.6 24.2 23 Z" fill={P.glass} />
        {/* cab side window */}
        <Rect x={31.8} y={23} width={8.6} height={11.2} rx={1} fill={P.glass} />
        {/* plug door interrupting the wine mask */}
        <Rect x={43} y={21} width={8} height={27.7} fill={P.door} />
        <Rect x={44} y={23} width={6} height={7.5} rx={0.8} fill={P.glass} />
        <Line x1={47} y1={21.4} x2={47} y2={48.4} stroke={P.dark} strokeWidth={0.5} opacity={0.65} />
        {/* start of the saloon behind the door */}
        <Rect x={53.5} y={23} width={8.5} height={11.2} rx={1} fill={P.glass} />
        {/* amber LED destination display in the brow */}
        <Rect x={21.6} y={19.3} width={9.8} height={3.4} rx={0.6} fill={P.dark} />
        <Rect x={22.7} y={20.6} width={3.6} height={0.9} fill={P.amber} />
        <Rect x={27.2} y={20.6} width={2.6} height={0.9} fill={P.amber} />
        {/* silver-rimmed headlight sitting in the wine mask */}
        <Circle cx={20.8} cy={39.2} r={1.6} fill="#F5F2E8" stroke={P.dark} strokeWidth={0.45} />
        <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={1.1} />
      </G>
    </Svg>
  );
}
