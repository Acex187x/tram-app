// Side Profile pack — T3R.P: modernized T3s in their trademark COUPLED PAIR.
// Two identical rounded T3 bodies with a coupling bar between them; each car
// carries the full-width amber LED destination brow (the #1 tell vs classic
// T3) and a modern single-arm pantograph instead of the scissor.
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#232932',
  edge: 'rgba(154,166,183,0.42)',
  rail: '#909CAD',
  wheel: '#3C434F',
  red: '#C8332B',
  cream: '#F2E7CE',
  creamShade: '#DFD0AE',
  glass: '#9AD4EA',
  silver: '#C9CFD8',
  amber: '#FFB03A',
  lens: '#FFD98F',
  dark: '#151A21',
} as const;

const CAR_BODY =
  'M5 28.6 L21 28.6 C24.6 28.6 26 31 26 34 L26 41.2 Q26 43 24 43 L2 43 Q0 43 0 41.2 L0 34 C0 31 1.4 28.6 5 28.6 Z';

function Door({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={30.2} width={2.9} height={11.7} rx={0.5} fill={P.creamShade} />
      <Rect x={x + 0.45} y={30.5} width={2} height={3.8} rx={0.4} fill={P.glass} />
      <Line x1={x + 1.45} y1={30.7} x2={x + 1.45} y2={41.6} stroke={P.dark} strokeWidth={0.45} />
      <Rect x={x} y={42.1} width={2.9} height={0.7} fill={P.dark} opacity={0.5} />
    </>
  );
}

function Car({ x }: { x: number }) {
  return (
    <G x={x}>
      {/* modern single-arm pantograph */}
      <Path
        d="M10.8 28.4 L14.4 25.1 L17.2 25.1"
        stroke={P.rail}
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={14.8} y1={24.7} x2={19.6} y2={24.7} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      <Circle cx={4.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={7.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={18.4} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={21.8} cy={44.6} r={1.6} fill={P.wheel} />
      <Path d={CAR_BODY} fill={P.cream} />
      <Path d="M0 36.6 L26 36.6 L26 41.2 Q26 43 24 43 L2 43 Q0 43 0 41.2 Z" fill={P.red} />
      <Line x1={0.2} y1={36.6} x2={25.8} y2={36.6} stroke={P.silver} strokeWidth={0.5} opacity={0.7} />
      {/* full-width amber LED destination brow — the modernization tell */}
      <Rect x={0.9} y={28.9} width={3.6} height={1.05} rx={0.35} fill={P.amber} />
      {/* wrap-around cab windscreen */}
      <Path d="M0.9 34.9 L0.9 31.9 C0.9 30.3 2 29.6 3.7 29.6 L5.1 29.6 L5.1 34.9 Z" fill={P.glass} />
      <Door x={5.9} />
      <Rect x={9.5} y={30.2} width={3} height={4.1} rx={0.7} fill={P.glass} />
      <Door x={13.2} />
      <Rect x={16.8} y={30.2} width={3} height={4.1} rx={0.7} fill={P.glass} />
      <Door x={20.5} />
      <Rect x={23.9} y={30.2} width={1.5} height={4} rx={0.6} fill={P.glass} />
      {/* headlight + modern rectangular turn signal */}
      <Circle cx={0.9} cy={40} r={1} fill={P.lens} stroke={P.silver} strokeWidth={0.5} />
      <Rect x={0.6} y={37.9} width={1} height={0.7} rx={0.2} fill={P.amber} opacity={0.9} />
      <Path d={CAR_BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </G>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Line x1={4} y1={46.2} x2={60} y2={46.2} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* coupling bar between the two cars */}
      <Line x1={30.2} y1={41.4} x2={33.8} y2={41.4} stroke={P.rail} strokeWidth={1.2} strokeLinecap="round" />
      <Car x={4.5} />
      <Car x={33.5} />
    </Svg>
  );
}
