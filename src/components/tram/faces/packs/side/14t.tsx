// Side Profile pack — Škoda 14T: the Porsche "caterpillar". FIVE short
// articulated sections with four dark joints, a soft rounded nose with a
// steeply raked windscreen and recessed round lamp, undulating cream/red
// beltline, grey skirt, no front door (small cab door only), long overhang.
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
  grey: '#7A828E',
  amber: '#FFB03A',
  lens: '#FFD98F',
  dark: '#151A21',
} as const;

const BODY =
  'M10 28.6 L58.7 28.6 Q60.9 28.6 60.9 30.8 L60.9 41 Q60.9 43 58.9 43 L5.6 43 Q4.2 43 4.2 41.4 L4.2 39 C4.2 33.8 6.2 29.9 10 28.6 Z';

function WideDoor({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={30} width={4.6} height={13} rx={0.5} fill={P.glassDeep} stroke={P.dark} strokeWidth={0.5} />
      <Line x1={x + 2.3} y1={30.4} x2={x + 2.3} y2={42.6} stroke={P.dark} strokeWidth={0.45} />
    </>
  );
}

function Joint({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={28.8} width={1.4} height={14} fill={P.dark} opacity={0.9} />
      <Line x1={x + 0.7} y1={29.3} x2={x + 0.7} y2={42.5} stroke="#4A5260" strokeWidth={0.35} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Line x1={3} y1={46.2} x2={61} y2={46.2} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* single-arm pantograph over the middle section */}
      <Path
        d="M30.5 28.4 L34.2 25.1 L37 25.1"
        stroke={P.rail}
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={34.8} y1={24.7} x2={39.2} y2={24.7} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* bogies — long front overhang, first bogie set back */}
      <Circle cx={11.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={14.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={31.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={34.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={51.4} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={54.8} cy={44.6} r={1.6} fill={P.wheel} />
      {/* red base body, soft rounded nose */}
      <Path d={BODY} fill={P.red} />
      {/* cream upper band with UNDULATING beltline across the sections */}
      <Path
        d="M10 28.6 L58.7 28.6 Q60.9 28.6 60.9 30.8 L60.9 36.1 Q54.5 37 47.8 36.2 Q41.2 35.5 34.6 36.3 Q28 37.1 21.4 36.2 Q14.8 35.4 6.4 36.6 C7.1 33 8.2 30 10 28.6 Z"
        fill={P.cream}
      />
      {/* grey skirt */}
      <Rect x={5} y={41.4} width={55.4} height={1.6} rx={0.5} fill={P.grey} />
      {/* steeply raked windscreen blending into the roof */}
      <Path d="M6.6 35.6 C7.3 31.9 8.7 30 11 29.5 L12.7 29.5 L12.7 35.6 Z" fill={P.glass} />
      <Rect x={8.2} y={30.1} width={3.4} height={0.95} rx={0.3} fill={P.amber} />
      {/* small cab side door (no passenger front door) */}
      <Rect x={13.3} y={30} width={1.6} height={12.4} rx={0.3} fill={P.creamShade} stroke={P.dark} strokeWidth={0.4} />
      <Rect x={13.55} y={30.3} width={1.1} height={3.6} rx={0.3} fill={P.glass} />
      {/* four joints = five sections */}
      <Joint x={15.4} />
      <Joint x={26.6} />
      <Joint x={37.8} />
      <Joint x={49} />
      {/* section 2 */}
      <Rect x={17.2} y={30.3} width={2} height={4.6} rx={0.6} fill={P.glass} />
      <WideDoor x={19.8} />
      <Rect x={24.9} y={30.3} width={1.4} height={4.6} rx={0.5} fill={P.glass} />
      {/* section 3 */}
      <Rect x={28.4} y={30.3} width={2} height={4.6} rx={0.6} fill={P.glass} />
      <WideDoor x={31} />
      <Rect x={36.1} y={30.3} width={1.4} height={4.6} rx={0.5} fill={P.glass} />
      {/* section 4 */}
      <Rect x={39.7} y={30.3} width={2} height={4.6} rx={0.6} fill={P.glass} />
      <WideDoor x={42.3} />
      <Rect x={47.4} y={30.3} width={1.4} height={4.6} rx={0.5} fill={P.glass} />
      {/* section 5 — windows only */}
      <Rect x={50.9} y={30.3} width={2.2} height={4.6} rx={0.6} fill={P.glass} />
      <Rect x={53.7} y={30.3} width={2.2} height={4.6} rx={0.6} fill={P.glass} />
      <Rect x={56.5} y={30.3} width={2.2} height={4.6} rx={0.6} fill={P.glass} />
      <Rect x={59.2} y={30.3} width={1.2} height={4.6} rx={0.5} fill={P.glass} />
      {/* round lamp recessed low in the nose */}
      <Circle cx={5.5} cy={39.6} r={1.15} fill={P.lens} />
      <Circle cx={5.2} cy={39.3} r={0.45} fill="#FFFFFF" opacity={0.8} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
