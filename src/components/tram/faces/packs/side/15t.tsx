// Side Profile pack — Škoda 15T ForCity Alfa: the workhorse. Only THREE long
// sections (vs the 14T's five), continuous low window line, angular polygonal
// headlight "cheekbone" on the raked nose, grey skirt, roof AC boxes.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#232932',
  edge: 'rgba(154,166,183,0.42)',
  rail: '#909CAD',
  wheel: '#3C434F',
  red: '#C8332B',
  cream: '#F2E7CE',
  glass: '#9AD4EA',
  glassDeep: '#6FB6D4',
  grey: '#7A828E',
  silver: '#C9CFD8',
  amber: '#FFB03A',
  lens: '#FFD98F',
  dark: '#151A21',
} as const;

const BODY =
  'M8.4 28.7 L58.6 28.7 Q60.7 28.7 60.7 30.7 L60.7 41.2 Q60.7 43 58.7 43 L5.8 43 Q4.2 43 4.3 41.4 L4.7 34 C5 31.4 6.3 29.2 8.4 28.7 Z';

function WideDoor({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={30.1} width={3.6} height={12.9} rx={0.5} fill={P.glassDeep} stroke={P.dark} strokeWidth={0.5} />
      <Line x1={x + 1.8} y1={30.5} x2={x + 1.8} y2={42.6} stroke={P.dark} strokeWidth={0.45} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Line x1={3} y1={46.2} x2={61} y2={46.2} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* single-arm pantograph over the front section */}
      <Path
        d="M12.5 28.5 L16.2 25.1 L19 25.1"
        stroke={P.rail}
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={16.8} y1={24.7} x2={21.2} y2={24.7} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* bogies under each long section */}
      <Circle cx={8.8} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={12.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={26.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={30} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={43.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={47} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={54.8} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={58.2} cy={44.6} r={1.6} fill={P.wheel} />
      {/* red base, rounded-trapezoid raked nose */}
      <Path d={BODY} fill={P.red} />
      {/* cream upper band, straight continuous beltline */}
      <Path
        d="M8.4 28.7 L58.6 28.7 Q60.7 28.7 60.7 30.7 L60.7 36.3 L4.62 36.3 L4.7 34 C5 31.4 6.3 29.2 8.4 28.7 Z"
        fill={P.cream}
      />
      <Line x1={4.8} y1={36.3} x2={60.4} y2={36.3} stroke={P.silver} strokeWidth={0.5} opacity={0.6} />
      {/* grey skirt */}
      <Rect x={5.2} y={41.4} width={55} height={1.6} rx={0.5} fill={P.grey} />
      {/* roof AC boxes */}
      <Rect x={25.5} y={27.6} width={5} height={1.1} rx={0.4} fill={P.grey} />
      <Rect x={45.5} y={27.6} width={5} height={1.1} rx={0.4} fill={P.grey} />
      {/* raked windscreen */}
      <Path d="M5.35 34.9 C5.75 31.9 6.9 30 9 29.6 L10.9 29.6 L10.9 34.9 Z" fill={P.glass} />
      {/* full-width LED destination at the roofline */}
      <Rect x={11.3} y={29.3} width={4.2} height={1.05} rx={0.35} fill={P.amber} />
      {/* angular polygonal headlight cluster — the 15T "cheekbone" */}
      <Path d="M4.75 38.4 L7.3 38 L7.9 39.9 L5 40.4 Z" fill={P.lens} stroke={P.dark} strokeWidth={0.4} />
      {/* two joints = three LONG sections */}
      <Rect x={21} y={28.8} width={1.5} height={14} fill={P.dark} opacity={0.9} />
      <Line x1={21.75} y1={29.3} x2={21.75} y2={42.5} stroke="#4A5260" strokeWidth={0.35} />
      <Rect x={39.4} y={28.8} width={1.5} height={14} fill={P.dark} opacity={0.9} />
      <Line x1={40.15} y1={29.3} x2={40.15} y2={42.5} stroke="#4A5260" strokeWidth={0.35} />
      {/* continuous low window line, section 1 */}
      <Rect x={11.7} y={30.4} width={2.6} height={5} rx={0.6} fill={P.glass} />
      <WideDoor x={14.9} />
      <Rect x={19.1} y={30.4} width={1.5} height={5} rx={0.5} fill={P.glass} />
      {/* section 2 */}
      <Rect x={22.9} y={30.4} width={1.8} height={5} rx={0.5} fill={P.glass} />
      <WideDoor x={25.3} />
      <Rect x={29.5} y={30.4} width={3} height={5} rx={0.6} fill={P.glass} />
      <WideDoor x={33.1} />
      <Rect x={37.3} y={30.4} width={1.7} height={5} rx={0.5} fill={P.glass} />
      {/* section 3 */}
      <Rect x={41.4} y={30.4} width={2.8} height={5} rx={0.6} fill={P.glass} />
      <WideDoor x={44.8} />
      <Rect x={49} y={30.4} width={3.2} height={5} rx={0.6} fill={P.glass} />
      <Rect x={52.8} y={30.4} width={3.2} height={5} rx={0.6} fill={P.glass} />
      <Rect x={56.6} y={30.4} width={3} height={5} rx={0.6} fill={P.glass} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
