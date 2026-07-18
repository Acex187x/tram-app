// Side Profile pack — KT8D5.RN2P: the angular two-headed giant. Full-width
// three-section slab body with raked trapezoidal cabs at BOTH ends (the only
// bidirectional tram here), two dark accordion joints, a modernized low-floor
// center section, curved white end stripes, one pantograph up + one folded.
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
  glassDeep: '#6FB6D4',
  silver: '#C9CFD8',
  amber: '#FFB03A',
  lens: '#FFD98F',
  dark: '#151A21',
  white: '#F4F5F3',
} as const;

const BODY = 'M6.8 28.8 L57.2 28.8 L60.4 41.8 L60.4 43 L3.6 43 L3.6 41.8 Z';

function StepDoor({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={30.2} width={3} height={11.6} rx={0.4} fill={P.creamShade} />
      <Rect x={x + 0.45} y={30.5} width={2.1} height={3.8} rx={0.4} fill={P.glass} />
      <Line x1={x + 1.5} y1={30.7} x2={x + 1.5} y2={41.5} stroke={P.dark} strokeWidth={0.45} />
      <Rect x={x} y={42} width={3} height={0.7} fill={P.dark} opacity={0.5} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Line x1={3} y1={46.2} x2={61} y2={46.2} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* raised pantograph over the front section */}
      <Path
        d="M11.5 28.6 L15.2 25.2 L18 25.2"
        stroke={P.rail}
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={15.8} y1={24.8} x2={20.2} y2={24.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* folded pantograph over the rear section */}
      <Line x1={44.5} y1={27.8} x2={51.5} y2={27.8} stroke={P.rail} strokeWidth={1} strokeLinecap="round" />
      <Line x1={46.8} y1={27.8} x2={46.8} y2={28.7} stroke={P.rail} strokeWidth={0.8} />
      <Line x1={49.2} y1={27.8} x2={49.2} y2={28.7} stroke={P.rail} strokeWidth={0.8} />
      {/* four bogies */}
      <Circle cx={8.5} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={11.9} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={20.8} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={24.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={39.8} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={43.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={52.1} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={55.5} cy={44.6} r={1.6} fill={P.wheel} />
      {/* angular red slab body, raked cab at BOTH ends */}
      <Path d={BODY} fill={P.red} />
      {/* cream upper band */}
      <Path d="M6.8 28.8 L57.2 28.8 L59 36.2 L5 36.2 Z" fill={P.cream} />
      <Line x1={5} y1={36.2} x2={59} y2={36.2} stroke={P.silver} strokeWidth={0.5} opacity={0.7} />
      {/* signature curved white stripes on both ends */}
      <Path d="M4.1 41.4 C5.8 39.2 6.8 36.6 7.3 33.6" stroke={P.white} strokeWidth={1.5} strokeLinecap="round" fill="none" />
      <Path d="M59.9 41.4 C58.2 39.2 57.2 36.6 56.7 33.6" stroke={P.white} strokeWidth={1.5} strokeLinecap="round" fill="none" />
      {/* destination displays at both ends */}
      <Rect x={7.6} y={29.3} width={3.8} height={1} rx={0.3} fill={P.amber} />
      <Rect x={52.6} y={29.3} width={3.8} height={1} rx={0.3} fill={P.amber} />
      {/* flat split windshields, one cab each end */}
      <Path d="M6.5 30 L9.6 30 L9.6 35.2 L5.22 35.2 Z" fill={P.glass} />
      <Line x1={8.2} y1={30.2} x2={7.5} y2={35} stroke={P.dark} strokeWidth={0.55} />
      <Path d="M57.5 30 L54.4 30 L54.4 35.2 L58.78 35.2 Z" fill={P.glass} />
      <Line x1={55.8} y1={30.2} x2={56.5} y2={35} stroke={P.dark} strokeWidth={0.55} />
      {/* end section A: high-floor door + windows */}
      <StepDoor x={11.2} />
      <Rect x={14.9} y={30.3} width={2.6} height={4} rx={0.6} fill={P.glass} />
      <Rect x={18.1} y={30.3} width={2.7} height={4} rx={0.6} fill={P.glass} />
      {/* accordion joints */}
      <Rect x={21.6} y={28.9} width={1.8} height={14} fill={P.dark} opacity={0.9} />
      <Line x1={22.2} y1={29.4} x2={22.2} y2={42.6} stroke="#4A5260" strokeWidth={0.35} />
      <Line x1={22.9} y1={29.4} x2={22.9} y2={42.6} stroke="#4A5260" strokeWidth={0.35} />
      <Rect x={40.6} y={28.9} width={1.8} height={14} fill={P.dark} opacity={0.9} />
      <Line x1={41.2} y1={29.4} x2={41.2} y2={42.6} stroke="#4A5260" strokeWidth={0.35} />
      <Line x1={41.9} y1={29.4} x2={41.9} y2={42.6} stroke="#4A5260" strokeWidth={0.35} />
      {/* modernized low-floor CENTER: deeper windows, flush glazed doors */}
      <Rect x={24.4} y={30.3} width={2.6} height={5.9} rx={0.6} fill={P.glass} />
      <Rect x={27.8} y={30} width={3.4} height={13} rx={0.5} fill={P.glassDeep} stroke={P.dark} strokeWidth={0.5} />
      <Line x1={29.5} y1={30.4} x2={29.5} y2={42.6} stroke={P.dark} strokeWidth={0.45} />
      <Rect x={32} y={30.3} width={2.6} height={5.9} rx={0.6} fill={P.glass} />
      <Rect x={35.4} y={30} width={3.4} height={13} rx={0.5} fill={P.glassDeep} stroke={P.dark} strokeWidth={0.5} />
      <Line x1={37.1} y1={30.4} x2={37.1} y2={42.6} stroke={P.dark} strokeWidth={0.45} />
      {/* end section C: windows + high-floor door */}
      <Rect x={43.2} y={30.3} width={2.7} height={4} rx={0.6} fill={P.glass} />
      <Rect x={46.6} y={30.3} width={2.6} height={4} rx={0.6} fill={P.glass} />
      <StepDoor x={50} />
      {/* rectangular headlights + round halogens, both ends */}
      <Rect x={3.9} y={39.6} width={1.7} height={1} rx={0.2} fill={P.lens} />
      <Circle cx={6.6} cy={40.1} r={0.75} fill={P.lens} />
      <Rect x={58.4} y={39.6} width={1.7} height={1} rx={0.2} fill={P.lens} />
      <Circle cx={57.4} cy={40.1} r={0.75} fill={P.lens} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
