// Side Profile pack — Tatra T3R.P: the classic T3 shape but ALWAYS drawn as
// the coupled two-car set it runs as, each car with the orange LED destination
// strip in the brow (instead of the blue box) and its own yellow diamond
// pantograph. Cream/red T3 livery, cream doors breaking the red belt.
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
  led: '#F59B1A',
  panto: '#C89A2E',
  dark: '#23272E',
} as const;

function carBody(x: number): string {
  return (
    `M${x + 3.6} 28.5 L${x + 19.4} 28.5 C${x + 21.9} 28.5 ${x + 23} 30.3 ${x + 23} 32.8 ` +
    `L${x + 23} 42.7 Q${x + 23} 44.5 ${x + 21.2} 44.5 L${x + 1.8} 44.5 Q${x} 44.5 ${x} 42.7 ` +
    `L${x} 32.8 C${x} 30.3 ${x + 1.1} 28.5 ${x + 3.6} 28.5 Z`
  );
}

function Panto({ cx }: { cx: number }) {
  return (
    <>
      <Path
        d={`M${cx} 23.2 L${cx + 3.8} 25.8 L${cx} 28.4 L${cx - 3.8} 25.8 Z`}
        fill="none"
        stroke={P.panto}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <Line x1={cx - 2} y1={22.8} x2={cx + 2} y2={22.8} stroke={P.panto} strokeWidth={1.1} strokeLinecap="round" />
    </>
  );
}

function Car({ x }: { x: number }) {
  return (
    <>
      <Circle cx={x + 4.5} cy={45} r={1.5} fill={P.wheel} />
      <Circle cx={x + 7.5} cy={45} r={1.5} fill={P.wheel} />
      <Circle cx={x + 15.5} cy={45} r={1.5} fill={P.wheel} />
      <Circle cx={x + 18.5} cy={45} r={1.5} fill={P.wheel} />
      <Path d={carBody(x)} fill={P.cream} />
      <Rect x={x} y={37.2} width={23} height={5.1} fill={P.red} />
      <Path d={`M${x + 3.4} 29.4 L${x + 19.6} 29.4`} stroke={P.roof} strokeWidth={1.5} strokeLinecap="round" />
      {/* windscreen */}
      <Path
        d={`M${x + 0.7} 31.2 C${x + 0.7} 30.2 ${x + 1.7} 29.9 ${x + 2.8} 29.9 L${x + 4.4} 29.9 L${x + 4.4} 35.2 L${x + 0.7} 35.2 Z`}
        fill={P.glass}
      />
      {/* doors + windows */}
      <Rect x={x + 5.4} y={29.9} width={2.6} height={14.1} fill={P.door} />
      <Line x1={x + 6.7} y1={30.1} x2={x + 6.7} y2={43.8} stroke={P.dark} strokeWidth={0.35} opacity={0.7} />
      <Rect x={x + 8.8} y={30.3} width={3.4} height={4.3} rx={0.5} fill={P.glass} />
      <Rect x={x + 13} y={29.9} width={2.6} height={14.1} fill={P.door} />
      <Line x1={x + 14.3} y1={30.1} x2={x + 14.3} y2={43.8} stroke={P.dark} strokeWidth={0.35} opacity={0.7} />
      <Rect x={x + 16.4} y={30.3} width={3.4} height={4.3} rx={0.5} fill={P.glass} />
      {/* orange LED destination strip in the brow — the T3R.P tell */}
      <Rect x={x + 0.9} y={28.6} width={5.2} height={1.3} rx={0.35} fill={P.led} />
      <Path d={carBody(x)} fill="none" stroke={P.dark} strokeWidth={0.85} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Panto cx={18.5} />
      <Panto cx={45.5} />
      <Line x1={5} y1={46.8} x2={59} y2={46.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* coupler bar between the two cars */}
      <Line x1={29.6} y1={41.3} x2={34.4} y2={41.3} stroke={P.dark} strokeWidth={1.2} strokeLinecap="round" />
      <Car x={7} />
      <Car x={34} />
    </Svg>
  );
}
