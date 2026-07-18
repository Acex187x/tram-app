// Side Profile pack — Tatra T3: the SHORT classic. One ~14 m rounded
// "bathtub" car, cream window band over red body, THREE folding doors with
// step wells, ribbed roof with the narrow route-number box up front, and the
// signature red scissor pantograph. Shortest silhouette in the pack.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

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
  lens: '#FFD98F',
  dark: '#151A21',
} as const;

const BODY =
  'M24 28.6 L40 28.6 C43.6 28.6 45 31 45 34 L45 41.2 Q45 43 43 43 L21 43 Q19 43 19 41.2 L19 34 C19 31 20.4 28.6 24 28.6 Z';

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

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Line x1={5.5} y1={46.2} x2={58.5} y2={46.2} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* red scissor pantograph */}
      <Path
        d="M29 28.2 L35 24.6 M35 28.2 L29 24.6"
        stroke="#B04038"
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={27.8} y1={24.2} x2={36.2} y2={24.2} stroke="#B04038" strokeWidth={1.1} strokeLinecap="round" />
      {/* wheels: two 2-axle bogies */}
      <Circle cx={23.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={26.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={37.4} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={40.8} cy={44.6} r={1.6} fill={P.wheel} />
      {/* cream bathtub body, rounded both ends */}
      <Path d={BODY} fill={P.cream} />
      {/* red lower band */}
      <Path d="M19 36.6 L45 36.6 L45 41.2 Q45 43 43 43 L21 43 Q19 43 19 41.2 Z" fill={P.red} />
      <Line x1={19.2} y1={36.6} x2={44.8} y2={36.6} stroke={P.silver} strokeWidth={0.5} opacity={0.7} />
      {/* narrow route-number box on the roof front — the classic-T3 tell */}
      <Rect x={20.6} y={27.7} width={2.2} height={1} rx={0.3} fill={P.cream} stroke={P.dark} strokeWidth={0.4} />
      {/* roof resistor boxes */}
      <Rect x={27.5} y={27.8} width={2.4} height={0.9} rx={0.45} fill={P.creamShade} />
      <Rect x={34} y={27.8} width={2.4} height={0.9} rx={0.45} fill={P.creamShade} />
      {/* wrap-around cab windscreen (front = left) */}
      <Path d="M19.9 34.9 L19.9 31.9 C19.9 30.3 21 29.6 22.7 29.6 L24.1 29.6 L24.1 34.9 Z" fill={P.glass} />
      {/* three folding doors + side windows */}
      <Door x={24.9} />
      <Rect x={28.5} y={30.2} width={3} height={4.1} rx={0.7} fill={P.glass} />
      <Door x={32.2} />
      <Rect x={35.8} y={30.2} width={3} height={4.1} rx={0.7} fill={P.glass} />
      <Door x={39.5} />
      <Rect x={42.9} y={30.2} width={1.5} height={4} rx={0.6} fill={P.glass} />
      {/* headlight edge */}
      <Circle cx={19.9} cy={40} r={1.05} fill={P.lens} stroke={P.silver} strokeWidth={0.5} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
