// Side Profile pack — Škoda 14T (Porsche design): the RED caterpillar. Long
// angular wedge with silver raked noses at both ends and a continuous silver
// roof band; five red modules separated by four slim grey accordion joints;
// modern single-arm pantograph. Red is the dominant color — unlike anything
// else in the fleet at a glance.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  red: '#C8352C',
  silver: '#C9CED6',
  glass: '#2E3640',
  joint: '#6A717B',
  jointEdge: '#4A515B',
  door: '#39414C',
  panto: '#3A4048',
  dark: '#23272E',
} as const;

const BODY = 'M9.8 28 L54.2 28 L58.5 44.5 L5.5 44.5 Z';

function Joint({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={28.5} width={1.8} height={15.6} fill={P.joint} />
      <Line x1={x} y1={28.7} x2={x} y2={44.1} stroke={P.jointEdge} strokeWidth={0.45} />
      <Line x1={x + 1.8} y1={28.7} x2={x + 1.8} y2={44.1} stroke={P.jointEdge} strokeWidth={0.45} />
    </>
  );
}

function Door({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={30.7} width={2.8} height={13.1} fill={P.door} />
      <Line x1={x + 1.4} y1={30.9} x2={x + 1.4} y2={43.5} stroke="#20262E" strokeWidth={0.45} opacity={0.9} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      {/* single-arm pantograph */}
      <Path d="M21.5 27.8 L25.5 22.8 L31 21.9" stroke={P.panto} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      <Line x1={29.3} y1={21.5} x2={32.7} y2={21.5} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
      <Line x1={4.5} y1={46.8} x2={59.5} y2={46.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      <Circle cx={9.6} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={12.8} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={30.4} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={33.6} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={51.2} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={54.4} cy={45} r={1.6} fill={P.wheel} />
      {/* red wedge body */}
      <Path d={BODY} fill={P.red} />
      {/* continuous silver roof band */}
      <Path d="M9.8 28 L54.2 28 L54.8 30.3 L9.2 30.3 Z" fill={P.silver} />
      {/* silver raked noses at both ends */}
      <Path d="M9.8 28 L15.4 28 L11.2 44.5 L5.5 44.5 Z" fill={P.silver} />
      <Path d="M48.6 28 L54.2 28 L58.5 44.5 L52.8 44.5 Z" fill={P.silver} />
      {/* big raked dark windscreens on the noses */}
      <Path d="M11.2 29.3 L14.4 29.3 L12 38.6 L8.9 38.6 Z" fill={P.glass} />
      <Path d="M49.6 29.3 L52.8 29.3 L55.1 38.6 L52 38.6 Z" fill={P.glass} />
      {/* windows in the red modules */}
      <Rect x={16.2} y={30.9} width={1.6} height={5} rx={0.4} fill={P.glass} />
      <Rect x={24.8} y={30.9} width={4.4} height={5} rx={0.5} fill={P.glass} />
      <Rect x={31.2} y={30.9} width={2.2} height={5} rx={0.4} fill={P.glass} />
      <Rect x={34.6} y={30.9} width={4.4} height={5} rx={0.5} fill={P.glass} />
      <Rect x={43.4} y={30.9} width={0.9} height={5} rx={0.3} fill={P.glass} />
      <Rect x={46.4} y={30.9} width={2.4} height={5} rx={0.5} fill={P.glass} />
      {/* doors */}
      <Door x={20.2} />
      <Door x={40.4} />
      {/* four slim accordion joints = FIVE modules */}
      <Joint x={18} />
      <Joint x={27.4} />
      <Joint x={36.8} />
      <Joint x={44.2} />
      {/* recessed round lamp on the nose */}
      <Circle cx={7.6} cy={41.2} r={0.9} fill="#FFF3D8" stroke={P.dark} strokeWidth={0.4} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
