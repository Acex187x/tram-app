// Side Profile pack — Škoda 52T ForCity Plus: the WHITE tram with the BLACK
// helmet visor. Long white/light-grey body, glossy black visor sweeping from
// the rounded raked nose up over the cab roof, amber destination strip in the
// glass, tall dark window band, red only as accents (nose diagonal, door
// panels, roof segments over the joints), low white skirt, single-arm panto.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#E8ECF1',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  white: '#FAFBFC',
  roofGrey: '#D2D7DD',
  visor: '#16181D',
  band: '#252932',
  glassDoor: '#3A414B',
  joint: '#9AA0A8',
  jointEdge: '#6A717B',
  red: '#C8352C',
  amber: '#E8971A',
  panto: '#3A4048',
  dark: '#23272E',
} as const;

const BODY =
  'M13 28 L54.5 28 Q58.5 28 58.5 31.5 L58.5 42.8 Q58.5 44.5 56.8 44.5 L8.2 44.5 Q5.9 44.5 6.3 42 C6.9 36.8 8.7 30.4 13 28 Z';

function Joint({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={28.6} width={1.8} height={15.5} fill={P.joint} />
      <Line x1={x} y1={28.8} x2={x} y2={44} stroke={P.jointEdge} strokeWidth={0.45} />
      <Line x1={x + 1.8} y1={28.8} x2={x + 1.8} y2={44} stroke={P.jointEdge} strokeWidth={0.45} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      {/* single-arm pantograph */}
      <Path d="M33 27.8 L37 22.8 L42.5 21.9" stroke={P.panto} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      <Line x1={40.8} y1={21.5} x2={44.2} y2={21.5} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
      <Line x1={4.5} y1={46.8} x2={59.5} y2={46.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      <Circle cx={10.4} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={13.6} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={31} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={34.2} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={50.4} cy={45} r={1.6} fill={P.wheel} />
      <Circle cx={53.6} cy={45} r={1.6} fill={P.wheel} />
      {/* white body with rounded raked nose */}
      <Path d={BODY} fill={P.white} />
      {/* light grey roof strip */}
      <Rect x={15} y={28} width={40} height={1.1} fill={P.roofGrey} />
      {/* red roof segments over the joints */}
      <Rect x={26.5} y={28} width={6} height={1.1} fill={P.red} />
      <Rect x={41.5} y={28} width={6} height={1.1} fill={P.red} />
      {/* tall dark window band */}
      <Rect x={18.5} y={29.5} width={39} height={6.2} fill={P.band} />
      {/* red accents: nose diagonal + door panels */}
      <Path d="M13.2 36.6 L16.4 36.6 L14 44.5 L10.8 44.5 Z" fill={P.red} />
      <Rect x={32.6} y={36.6} width={5.4} height={7.9} fill={P.red} />
      <Rect x={51} y={36.6} width={4.6} height={7.9} fill={P.red} />
      {/* glossy black helmet visor: windscreen sweeping over the cab roof */}
      <Path
        d="M17.8 27.3 L17.8 36.2 C14.6 36.2 11.4 37.9 9.1 40.9 C7.8 37.4 9.5 30.6 12.6 27.9 Q15.1 27 17.8 27.3 Z"
        fill={P.visor}
      />
      {/* amber destination strip in the visor glass */}
      <Rect x={13.6} y={28.9} width={3.2} height={1} rx={0.3} fill={P.amber} />
      {/* slim LED dash low at the visor tip */}
      <Rect x={7.6} y={41.2} width={2.6} height={0.9} rx={0.45} fill={P.visor} />
      {/* tall glazed doors */}
      <Rect x={21.5} y={29.8} width={3.2} height={13.6} fill={P.glassDoor} />
      <Line x1={23.1} y1={30} x2={23.1} y2={43.2} stroke={P.dark} strokeWidth={0.4} opacity={0.8} />
      <Rect x={33.7} y={29.8} width={3.2} height={13.6} fill={P.glassDoor} />
      <Line x1={35.3} y1={30} x2={35.3} y2={43.2} stroke={P.dark} strokeWidth={0.4} opacity={0.8} />
      <Rect x={46} y={29.8} width={3.2} height={13.6} fill={P.glassDoor} />
      <Line x1={47.6} y1={30} x2={47.6} y2={43.2} stroke={P.dark} strokeWidth={0.4} opacity={0.8} />
      {/* two joints = three sections */}
      <Joint x={28.5} />
      <Joint x={43.5} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
