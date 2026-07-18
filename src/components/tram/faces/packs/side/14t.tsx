// Side Profile pack — Škoda 14T (Porsche design): NOSE PORTRAIT in side view.
// The WEDGE: windscreen on a hard backward rake flowing into a silver nose
// that bulges forward then curls under — a ski-jump profile. Silver front
// module with dark headlight pod, red body taking over behind the cab on a
// slanted module cut, silver skirt. Single-arm pantograph horns. Nose left.
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  silver: '#C9CBCE',
  red: '#CE2B26',
  doorRed: '#B72420',
  glass: '#35444E',
  roof: '#7E8286',
  panto: '#C89A2E',
  dark: '#23272E',
  pod: '#2B333B',
} as const;

// Porsche wedge prow: raked screen, forward-bulging nose, curled underside.
const BODY =
  'M63 15.5 L33.5 15.5 C28.5 16 24.8 19.4 21.9 25.6 C19.4 30.9 17.9 36.5 18.7 41.5 C19.5 45.7 22.6 48.6 27.5 49 L63 49 Z';

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <ClipPath id="side14tPlate">
          <Rect x={1.5} y={1.5} width={61} height={61} rx={14} />
        </ClipPath>
        <ClipPath id="side14tBody">
          <Path d={BODY} />
        </ClipPath>
      </Defs>
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <G clipPath="url(#side14tPlate)">
        {/* single-arm pantograph horns */}
        <Line x1={49} y1={15.2} x2={54} y2={8.6} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
        <Line x1={54} y1={8.6} x2={48.6} y2={6.6} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
        <Line x1={46.2} y1={6.2} x2={51.2} y2={6.2} stroke={P.panto} strokeWidth={1.3} strokeLinecap="round" />
        {/* rail + wheels tucked under the low skirt */}
        <Line x1={7} y1={53.6} x2={57} y2={53.6} stroke={P.rail} strokeWidth={1.2} strokeLinecap="round" />
        <Circle cx={30} cy={50.6} r={2.7} fill={P.wheel} />
        <Circle cx={46} cy={50.6} r={2.7} fill={P.wheel} />
        {/* silver wedge prow */}
        <Path d={BODY} fill={P.silver} />
        <G clipPath="url(#side14tBody)">
          {/* red body takes over on a slanted module cut behind the cab */}
          <Path d="M41.5 14 L37.5 50 L64 50 L64 14 Z" fill={P.red} />
          <Rect x={14} y={15.5} width={50} height={1.8} fill={P.roof} />
          {/* continuous silver skirt under the red modules */}
          <Rect x={14} y={44.8} width={50} height={4.2} fill={P.silver} />
        </G>
        {/* hard-raked windscreen flowing into the nose — the Porsche tell */}
        <Path d="M33.6 17 C30 17.6 26.6 20.9 23.9 26.2 L21.3 32.2 L28.6 32.2 C29.2 27 30.9 21.2 33.6 17 Z" fill={P.glass} />
        {/* cab side window */}
        <Rect x={34.6} y={19} width={5.4} height={10.8} rx={1} fill={P.glass} />
        {/* red section: window, tall glazed door, window */}
        <Rect x={42.2} y={18.2} width={4} height={11} rx={0.8} fill={P.glass} />
        <Rect x={48} y={17.5} width={8} height={27.2} fill={P.doorRed} />
        <Rect x={49.2} y={19} width={5.6} height={13} rx={0.8} fill={P.glass} />
        <Line x1={52} y1={18} x2={52} y2={44.4} stroke={P.dark} strokeWidth={0.5} opacity={0.5} />
        <Rect x={58.2} y={18.2} width={5} height={11} rx={0.8} fill={P.glass} />
        {/* dark headlight pod low on the silver nose */}
        <Rect x={19.2} y={37.4} width={2.9} height={2.1} rx={1} fill={P.pod} />
        <Circle cx={20.4} cy={38.45} r={0.6} fill="#EAF2F8" />
        <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={1.1} />
      </G>
    </Svg>
  );
}
