// Side Profile pack — Škoda 52T ForCity Plus: NOSE PORTRAIT in side view.
// The opposite of the 15T: a TALL, almost vertical front with one big rounded
// top corner, wrapped in the glossy BLACK helmet visor (amber destination
// dashes inside), white body with a white rim around the visor, red stripe on
// the leading edge of the nose and a red module behind the white cab.
// Single-arm pantograph horns. Nose faces left.
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  body: '#F2F1ED',
  visor: '#1E2226',
  red: '#D5372E',
  glass: '#2A3138',
  roof: '#8E9296',
  skirt: '#B9BCBF',
  amber: '#FFB03A',
  panto: '#C89A2E',
  dark: '#23272E',
} as const;

// Tall upright prow: big rounded top corner, near-vertical face, flat chin.
const BODY =
  'M63 14.5 L29 14.5 C22.8 14.8 19.2 17.2 17.8 21.6 C16.9 24.8 16.5 30.4 16.5 36 C16.5 42 17.2 46.2 19.8 48.7 L63 48.7 Z';

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <ClipPath id="side52tPlate">
          <Rect x={1.5} y={1.5} width={61} height={61} rx={14} />
        </ClipPath>
        <ClipPath id="side52tBody">
          <Path d={BODY} />
        </ClipPath>
      </Defs>
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <G clipPath="url(#side52tPlate)">
        {/* single-arm pantograph horns */}
        <Line x1={50} y1={14.3} x2={55} y2={7.8} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
        <Line x1={55} y1={7.8} x2={49.6} y2={5.8} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
        <Line x1={47.2} y1={5.4} x2={52.2} y2={5.4} stroke={P.panto} strokeWidth={1.3} strokeLinecap="round" />
        {/* rail + wheels tucked under the low skirt */}
        <Line x1={7} y1={53.6} x2={57} y2={53.6} stroke={P.rail} strokeWidth={1.2} strokeLinecap="round" />
        <Circle cx={30} cy={50.4} r={2.7} fill={P.wheel} />
        <Circle cx={46} cy={50.4} r={2.7} fill={P.wheel} />
        {/* tall white prow */}
        <Path d={BODY} fill={P.body} />
        <G clipPath="url(#side52tBody)">
          {/* red module behind the white cab */}
          <Rect x={50} y={14} width={14} height={35} fill={P.red} />
          <Rect x={36} y={14.5} width={28} height={1.8} fill={P.roof} />
          {/* red stripe on the leading edge of the nose */}
          <Rect x={15.5} y={35.5} width={4.6} height={13.2} fill={P.red} />
          {/* grey skirt line */}
          <Rect x={14} y={47} width={50} height={1.7} fill={P.skirt} />
        </G>
        {/* tall side window band flowing back (crosses the red module) */}
        <Rect x={31.5} y={18.5} width={31} height={17.5} fill={P.glass} />
        <Line x1={39} y1={19.5} x2={39} y2={35} stroke="#8E969E" strokeWidth={0.7} opacity={0.6} />
        <Line x1={50.5} y1={19.5} x2={50.5} y2={35} stroke="#8E969E" strokeWidth={0.7} opacity={0.6} />
        {/* BLACK helmet visor: tall near-vertical glass with the rounded crown */}
        <Path
          d="M34 14.5 L29 14.5 C23.4 14.8 20.1 17.1 18.7 21.8 C17.9 24.6 17.6 29 17.6 33.6 L28.4 33.6 C29 26.4 31.2 18.9 34 14.5 Z"
          fill={P.visor}
        />
        {/* amber destination dashes inside the visor */}
        <Rect x={21.6} y={18.6} width={3.2} height={1} fill={P.amber} />
        <Rect x={25.6} y={18.6} width={2.2} height={1} fill={P.amber} />
        {/* LED headlight slit on the red nose stripe */}
        <Rect x={17.4} y={36.8} width={1.6} height={3} rx={0.8} fill="#F4F7FA" stroke={P.dark} strokeWidth={0.35} />
        {/* dark under-bumper lip at the chin */}
        <Path d="M17.2 44.6 C17.6 46.6 18.6 48 20.2 48.7 L26 48.7 L26 44.6 Z" fill="#33383D" />
        <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={1.1} />
      </G>
    </Svg>
  );
}
