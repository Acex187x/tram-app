// Side Profile pack — Tatra T3R.PLF: the SILVER T3. Same short rounded
// bathtub silhouette, but silver-grey body with a red band at sill level,
// silver chevron "wings" cutting the band toward the rear, dark wine bib
// wedge at the nose holding a round lamp, and a deep glazed CENTER low-floor
// door that drops below the band. Diamond pantograph like all Tatras.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  silver: '#CDD3DA',
  silverHi: '#E2E6EB',
  red: '#C8352C',
  wine: '#5E1F2E',
  glass: '#54788C',
  glassDeep: '#5E8299',
  roof: '#5A6068',
  panto: '#C89A2E',
  dark: '#23272E',
  lens: '#FFE2A6',
} as const;

const BODY =
  'M23.5 28 L40.5 28 C44 28 45.5 30.2 45.5 33.4 L45.5 42.3 Q45.5 44.5 43.3 44.5 L20.7 44.5 Q18.5 44.5 18.5 42.3 L18.5 33.4 C18.5 30.2 20 28 23.5 28 Z';

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      {/* diamond pantograph */}
      <Path d="M32 21.9 L36.6 25 L32 28 L27.4 25 Z" fill="none" stroke={P.panto} strokeWidth={1.1} strokeLinejoin="round" />
      <Line x1={29.6} y1={21.5} x2={34.4} y2={21.5} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
      <Line x1={6} y1={46.8} x2={58} y2={46.8} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      <Circle cx={23} cy={45} r={1.7} fill={P.wheel} />
      <Circle cx={26.4} cy={45} r={1.7} fill={P.wheel} />
      <Circle cx={37.6} cy={45} r={1.7} fill={P.wheel} />
      <Circle cx={41} cy={45} r={1.7} fill={P.wheel} />
      {/* silver bathtub body */}
      <Path d={BODY} fill={P.silver} />
      {/* red band at window-sill level */}
      <Rect x={18.5} y={34.9} width={27} height={3.6} fill={P.red} />
      {/* silver chevron wings slicing the band toward the rear */}
      <Path d="M38.8 34.9 L41.2 34.9 L43.8 38.5 L41.4 38.5 Z" fill="#F2F4F7" />
      <Path d="M42.4 34.9 L44.8 34.9 L45.5 36 L45.5 38.5 L45 38.5 Z" fill="#F2F4F7" />
      {/* grey roof strip */}
      <Path d="M23 28.9 L41 28.9" stroke={P.roof} strokeWidth={1.6} strokeLinecap="round" />
      {/* smooth single curved windscreen */}
      <Path d="M19.3 31.2 C19.3 29.9 20.6 29.4 22 29.4 L24.2 29.4 L24.2 34.6 L19.3 34.6 Z" fill={P.glass} />
      {/* dark wine bib wedge at the nose with round lamp */}
      <Path d="M18.5 35.2 L21.6 35.2 C22.3 38.2 22.4 41.4 22.3 44.5 L20.7 44.5 Q18.5 44.5 18.5 42.3 Z" fill={P.wine} />
      <Circle cx={20.2} cy={38.6} r={1} fill={P.lens} stroke={P.dark} strokeWidth={0.4} />
      {/* front door */}
      <Rect x={24.9} y={29.9} width={2.8} height={13.4} fill={P.silverHi} />
      <Rect x={25.3} y={30.3} width={2} height={3.6} rx={0.4} fill={P.glass} />
      {/* side windows */}
      <Rect x={28.6} y={29.9} width={3} height={4.4} rx={0.5} fill={P.glass} />
      <Rect x={39} y={29.9} width={3} height={4.4} rx={0.5} fill={P.glass} />
      <Rect x={42.8} y={29.9} width={1.9} height={4.4} rx={0.5} fill={P.glass} />
      {/* CENTER low-floor plug door: deep glass, drops through the band */}
      <Rect x={32.8} y={29.9} width={4.8} height={14.2} fill="#4A7086" stroke={P.dark} strokeWidth={0.6} />
      <Line x1={35.2} y1={30.2} x2={35.2} y2={43.8} stroke={P.dark} strokeWidth={0.5} opacity={0.85} />
      {/* dipped floor sill under the center door */}
      <Rect x={32.8} y={43.5} width={4.8} height={1.3} fill={P.dark} opacity={0.8} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
