// Side Profile pack — Škoda 15T ForCity: the sloped-face workhorse. Long
// four-section body: red cab with a big raked black windscreen and red brow
// flowing over the roof, then a continuous glossy BLACK window band over a
// SILVER mid band over a RED skirt. Three slim joints, single-arm pantograph.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  red: '#C8352C',
  silver: '#C9CED6',
  black: '#1E2126',
  glassDoor: '#3E4650',
  joint: '#737A84',
  jointEdge: '#4E555F',
  roof: '#4E545C',
  panto: '#3A4048',
  dark: '#23272E',
  drl: '#F5F7FA',
} as const;

const BODY = 'M12 28 L55.6 28 L58.5 44.5 L5.5 44.5 Z';

function Joint({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={28.5} width={1.8} height={15.6} fill={P.joint} />
      <Line x1={x} y1={28.7} x2={x} y2={44.1} stroke={P.jointEdge} strokeWidth={0.45} />
      <Line x1={x + 1.8} y1={28.7} x2={x + 1.8} y2={44.1} stroke={P.jointEdge} strokeWidth={0.45} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      {/* single-arm pantograph over the cab */}
      <Path d="M18.5 27.8 L22.5 22.8 L28 21.9" stroke={P.panto} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      <Line x1={26.3} y1={21.5} x2={29.7} y2={21.5} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
      <Line x1={4.5} y1={46.8} x2={59.5} y2={46.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      <Circle cx={9.8} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={13} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={27.6} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={30.8} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={47.4} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={50.6} cy={45} r={1.6} fill={P.wheel} />
      {/* silver base body */}
      <Path d={BODY} fill={P.silver} />
      {/* glossy black window band */}
      <Rect x={17.5} y={29} width={40} height={6.9} fill={P.black} />
      {/* red skirt along the bottom */}
      <Path d="M5.5 41 L57.9 41 L58.5 44.5 L5.5 44.5 Z" fill={P.red} />
      {/* dark roof strip */}
      <Rect x={13} y={28} width={42} height={1.2} fill={P.roof} />
      {/* red cab: brow over the roof + raked nose */}
      <Path d="M12 28 L18.2 28 L18.2 44.5 L5.5 44.5 Z" fill={P.red} />
      {/* big raked black windscreen dominating the sloped face */}
      <Path d="M13 28.9 L17.4 28.9 L17.4 38.8 L8.7 38.8 Z" fill={P.black} />
      {/* white DRL dash low on the nose */}
      <Rect x={7} y={41.6} width={2.2} height={1} rx={0.5} fill={P.drl} />
      {/* glazed doors breaking the black band down through the silver */}
      <Rect x={21.5} y={29.4} width={3} height={13.8} fill={P.glassDoor} />
      <Line x1={23} y1={29.6} x2={23} y2={43} stroke={P.dark} strokeWidth={0.4} opacity={0.8} />
      <Rect x={35} y={29.4} width={3} height={13.8} fill={P.glassDoor} />
      <Line x1={36.5} y1={29.6} x2={36.5} y2={43} stroke={P.dark} strokeWidth={0.4} opacity={0.8} />
      <Rect x={48.5} y={29.4} width={3} height={13.8} fill={P.glassDoor} />
      <Line x1={50} y1={29.6} x2={50} y2={43} stroke={P.dark} strokeWidth={0.4} opacity={0.8} />
      {/* three slim joints = four sections */}
      <Joint x={26} />
      <Joint x={40} />
      <Joint x={53} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
