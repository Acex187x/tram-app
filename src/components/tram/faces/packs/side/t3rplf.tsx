// Side Profile pack — T3R.PLF: "a T3 that sags gracefully in the middle".
// Retro rounded T3 body, slightly longer, with a low-floor CENTER: the red
// beltline dips, windows over the middle are deeper, and a wide glazed
// sliding plug door sits flush to the floor with silver flashes beside it.
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
} as const;

const BODY =
  'M23 28.6 L41 28.6 C44.6 28.6 46 31 46 34 L46 41.2 Q46 43 44 43 L20 43 Q18 43 18 41.2 L18 34 C18 31 19.4 28.6 23 28.6 Z';

function EndDoor({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={30.2} width={2.8} height={11.7} rx={0.5} fill={P.creamShade} />
      <Rect x={x + 0.4} y={30.5} width={2} height={3.8} rx={0.4} fill={P.glass} />
      <Line x1={x + 1.4} y1={30.7} x2={x + 1.4} y2={41.6} stroke={P.dark} strokeWidth={0.45} />
      <Rect x={x} y={42.1} width={2.8} height={0.7} fill={P.dark} opacity={0.5} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Line x1={5.5} y1={46.2} x2={58.5} y2={46.2} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* modern single-arm pantograph */}
      <Path
        d="M28.6 28.4 L32.2 25.1 L35 25.1"
        stroke={P.rail}
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={32.8} y1={24.7} x2={37.2} y2={24.7} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      <Circle cx={22.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={25.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={38.4} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={41.8} cy={44.6} r={1.6} fill={P.wheel} />
      {/* retro rounded body, a touch longer than a T3 */}
      <Path d={BODY} fill={P.cream} />
      {/* red band whose top DIPS over the low-floor middle */}
      <Path
        d="M18 36.2 C23 36.2 26 37.9 28.6 37.9 L35.4 37.9 C38 37.9 41 36.2 46 36.2 L46 41.2 Q46 43 44 43 L20 43 Q18 43 18 41.2 Z"
        fill={P.red}
      />
      {/* full-width amber LED destination brow */}
      <Rect x={18.9} y={28.9} width={3.9} height={1.05} rx={0.35} fill={P.amber} />
      {/* wrap-around cab windscreen (front = left) */}
      <Path d="M18.9 34.9 L18.9 31.9 C18.9 30.3 20 29.6 21.7 29.6 L23.1 29.6 L23.1 34.9 Z" fill={P.glass} />
      <EndDoor x={23.6} />
      {/* deeper windows over the low-floor middle */}
      <Rect x={27} y={30.2} width={2.2} height={6.4} rx={0.6} fill={P.glass} />
      {/* wide glazed center plug door, flush to the floor — no steps */}
      <Rect x={29.5} y={30} width={5.2} height={13} rx={0.6} fill={P.glassDeep} stroke={P.dark} strokeWidth={0.5} />
      <Line x1={32.1} y1={30.4} x2={32.1} y2={42.6} stroke={P.dark} strokeWidth={0.45} />
      <Rect x={35.7} y={30.2} width={2.2} height={6.4} rx={0.6} fill={P.glass} />
      <EndDoor x={38.6} />
      <Rect x={42.1} y={30.2} width={1.6} height={4.1} rx={0.6} fill={P.glass} />
      {/* silver flashes beside the center door */}
      <Path d="M28.6 38.5 L29.4 38.5 L28.7 42.5 L27.9 42.5 Z" fill={P.silver} />
      <Path d="M35.4 38.5 L36.2 38.5 L36.9 42.5 L36.1 42.5 Z" fill={P.silver} />
      {/* headlight */}
      <Circle cx={18.9} cy={40} r={1} fill={P.lens} stroke={P.silver} strokeWidth={0.5} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
