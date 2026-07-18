// Side Profile pack — Tatra KT8D5: the big BOXY long one. Full-width slab
// body in three angular sections with two dark full-height accordion joints,
// cabs at BOTH ends (raked dark windscreens), grey window band over a bold
// red belt over a white skirt, and TWO yellow diamond pantographs.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  white: '#F4F5F7',
  band: '#6E747E',
  red: '#C8352C',
  glass: '#232B35',
  joint: '#3A3F47',
  jointRib: '#5A616B',
  roof: '#4E545C',
  door: '#565D67',
  panto: '#C89A2E',
  dark: '#23272E',
  lens: '#FFD98F',
} as const;

const BODY =
  'M8 28 L56 28 Q58.5 28 58.5 30.5 L58.5 42.8 Q58.5 44.5 56.8 44.5 L7.2 44.5 Q5.5 44.5 5.5 42.8 L5.5 30.5 Q5.5 28 8 28 Z';

function Panto({ cx }: { cx: number }) {
  return (
    <>
      <Path
        d={`M${cx} 22.4 L${cx + 4.2} 25.2 L${cx} 28 L${cx - 4.2} 25.2 Z`}
        fill="none"
        stroke={P.panto}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <Line x1={cx - 2.1} y1={22} x2={cx + 2.1} y2={22} stroke={P.panto} strokeWidth={1.1} strokeLinecap="round" />
    </>
  );
}

function Joint({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={28.6} width={2.6} height={15.5} fill={P.joint} />
      <Line x1={x + 0.85} y1={29} x2={x + 0.85} y2={43.9} stroke={P.jointRib} strokeWidth={0.5} />
      <Line x1={x + 1.75} y1={29} x2={x + 1.75} y2={43.9} stroke={P.jointRib} strokeWidth={0.5} />
    </>
  );
}

function Door({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={29.8} width={3} height={13.6} fill={P.door} />
      <Rect x={x + 0.5} y={30.3} width={2} height={4.6} rx={0.4} fill={P.glass} />
      <Line x1={x + 1.5} y1={30} x2={x + 1.5} y2={43.2} stroke={P.dark} strokeWidth={0.4} opacity={0.7} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      {/* TWO diamond pantographs — the two-headed giant */}
      <Panto cx={13.5} />
      <Panto cx={50.5} />
      <Line x1={4.5} y1={46.8} x2={59.5} y2={46.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* four bogies */}
      <Circle cx={10} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={13.2} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={26.4} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={29.6} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={34.4} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={37.6} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={50.8} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={54} cy={45} r={1.6} fill={P.wheel} />
      {/* white slab base (skirt shows white) */}
      <Path d={BODY} fill={P.white} />
      {/* grey window band + red belt */}
      <Rect x={5.5} y={29.4} width={53} height={6.3} fill={P.band} />
      <Rect x={5.5} y={35.7} width={53} height={5.6} fill={P.red} />
      {/* dark roof strip */}
      <Rect x={7} y={28} width={50} height={1.4} fill={P.roof} />
      {/* raked windscreens at BOTH ends */}
      <Path d="M6.8 29.8 L10.4 29.8 L10.4 35.3 L6 35.3 Z" fill={P.glass} />
      <Path d="M53.6 29.8 L57.2 29.8 L58 35.3 L53.6 35.3 Z" fill={P.glass} />
      {/* side windows */}
      <Rect x={15.5} y={30} width={4.6} height={5} rx={0.4} fill={P.glass} />
      <Rect x={25.6} y={30} width={4.4} height={5} rx={0.4} fill={P.glass} />
      <Rect x={34} y={30} width={4.4} height={5} rx={0.4} fill={P.glass} />
      <Rect x={43.9} y={30} width={4.6} height={5} rx={0.4} fill={P.glass} />
      {/* doors: one per section */}
      <Door x={11.6} />
      <Door x={30.4} />
      <Door x={49.4} />
      {/* two full-height accordion joints */}
      <Joint x={21.2} />
      <Joint x={40.2} />
      {/* round lamp low in the white front bumper stripe */}
      <Circle cx={6.9} cy={42.9} r={0.9} fill={P.lens} stroke={P.dark} strokeWidth={0.4} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
