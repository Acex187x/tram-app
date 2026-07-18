// Side Profile pack — Tatra T3: the SHORT rounded classic. One bathtub car
// with cream window band, bold red belt, narrow cream skirt; three cream
// folding doors interrupting the red band; blue route box on the roof brow
// and the yellow diamond (rhombus) pantograph. Shortest single silhouette.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  red: '#C8352C',
  cream: '#F3E6C8',
  door: '#E6D5AC',
  glass: '#54788C',
  roof: '#5A6068',
  blue: '#2C56A8',
  panto: '#C89A2E',
  dark: '#23272E',
  lens: '#FFD98F',
} as const;

const BODY =
  'M23.5 28 L40.5 28 C44 28 45.5 30.2 45.5 33.4 L45.5 42.3 Q45.5 44.5 43.3 44.5 L20.7 44.5 Q18.5 44.5 18.5 42.3 L18.5 33.4 C18.5 30.2 20 28 23.5 28 Z';

function Door({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={29.4} width={3} height={14.6} fill={P.door} />
      <Rect x={x + 0.4} y={30} width={2.2} height={3.6} rx={0.4} fill={P.glass} />
      <Line x1={x + 1.5} y1={29.6} x2={x + 1.5} y2={43.8} stroke={P.dark} strokeWidth={0.4} opacity={0.7} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      {/* yellow diamond pantograph */}
      <Path d="M32 21.9 L36.6 25 L32 28 L27.4 25 Z" fill="none" stroke={P.panto} strokeWidth={1.1} strokeLinejoin="round" />
      <Line x1={29.6} y1={21.5} x2={34.4} y2={21.5} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
      {/* rails + wheels (two 2-axle bogies) */}
      <Line x1={6} y1={46.8} x2={58} y2={46.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      <Circle cx={23.5} cy={45} r={1.7} fill={P.wheel} />
      <Circle cx={27} cy={45} r={1.7} fill={P.wheel} />
      <Circle cx={37} cy={45} r={1.7} fill={P.wheel} />
      <Circle cx={40.5} cy={45} r={1.7} fill={P.wheel} />
      {/* cream bathtub body */}
      <Path d={BODY} fill={P.cream} />
      {/* red belt (cream skirt stays below) */}
      <Rect x={18.5} y={36.2} width={27} height={6.2} fill={P.red} />
      {/* grey roof strip */}
      <Path d="M23 28.9 L41 28.9" stroke={P.roof} strokeWidth={1.6} strokeLinecap="round" />
      {/* wrap-around windscreen (front = left) */}
      <Path d="M19.3 30.8 C19.3 29.8 20.4 29.4 21.6 29.4 L23.6 29.4 L23.6 35.3 L19.3 35.3 Z" fill={P.glass} />
      {/* doors + windows: door, window, door, window, door, small rear window */}
      <Door x={24.6} />
      <Rect x={28.4} y={29.9} width={2.6} height={4.7} rx={0.5} fill={P.glass} />
      <Door x={31.8} />
      <Rect x={35.6} y={29.9} width={2.6} height={4.7} rx={0.5} fill={P.glass} />
      <Door x={39} />
      <Rect x={42.6} y={29.9} width={2.1} height={4.7} rx={0.5} fill={P.glass} />
      {/* blue route-number box on the roof brow — the classic-T3 tell */}
      <Rect x={20.1} y={26.5} width={3.6} height={2} rx={0.4} fill={P.blue} stroke={P.dark} strokeWidth={0.35} />
      {/* round headlight peeking at the nose */}
      <Circle cx={19.6} cy={40.6} r={1} fill={P.lens} stroke={P.dark} strokeWidth={0.4} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
