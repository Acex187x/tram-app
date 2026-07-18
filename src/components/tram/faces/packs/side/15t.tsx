// Side Profile pack — Škoda 15T ForCity: NOSE PORTRAIT in side view. The most
// extreme rake in the fleet: one continuous curved sweep of black glass from
// the roofline down to mid-nose, edged by the RED brow cap along its leading
// curve. White muzzle band under the glass, red bumper skirt curling under
// the chin, black window band flowing back. Single-arm horns. Nose left.
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  body: '#F1EFE9',
  red: '#CE2B26',
  glass: '#23292F',
  roof: '#9A9EA2',
  panto: '#C89A2E',
  dark: '#23272E',
} as const;

// ForCity prow: long shallow sweep from roof to a low rounded chin.
const BODY =
  'M63 15 L36 15 C30.5 15.4 26.2 18 22.6 23.4 C19.2 28.7 17.2 33.8 16.8 38.4 C16.5 42.4 18.2 46.4 23.4 48.7 L63 48.7 Z';

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <ClipPath id="side15tPlate">
          <Rect x={1.5} y={1.5} width={61} height={61} rx={14} />
        </ClipPath>
        <ClipPath id="side15tBody">
          <Path d={BODY} />
        </ClipPath>
      </Defs>
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <G clipPath="url(#side15tPlate)">
        {/* single-arm pantograph horns */}
        <Line x1={50} y1={14.8} x2={55} y2={8.2} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
        <Line x1={55} y1={8.2} x2={49.6} y2={6.2} stroke={P.panto} strokeWidth={1.2} strokeLinecap="round" />
        <Line x1={47.2} y1={5.8} x2={52.2} y2={5.8} stroke={P.panto} strokeWidth={1.3} strokeLinecap="round" />
        {/* rail + wheels tucked under the low skirt */}
        <Line x1={7} y1={53.6} x2={57} y2={53.6} stroke={P.rail} strokeWidth={1.2} strokeLinecap="round" />
        <Circle cx={30} cy={50.4} r={2.7} fill={P.wheel} />
        <Circle cx={46} cy={50.4} r={2.7} fill={P.wheel} />
        {/* white body with the long swept prow */}
        <Path d={BODY} fill={P.body} />
        <G clipPath="url(#side15tBody)">
          <Rect x={34} y={15} width={30} height={1.7} fill={P.roof} />
          {/* red bumper skirt curling under the chin */}
          <Path d="M14 38.4 C24 40.2 40 41.8 64 42.3 L64 50 L14 50 Z" fill={P.red} />
          {/* continuous black window band flowing back from the cab */}
          <Rect x={26} y={18.4} width={38} height={14.6} fill={P.glass} />
        </G>
        {/* huge swept windscreen — one curve from roof to mid-nose */}
        <Path d="M37 16.9 C31.6 17.3 27.7 19.9 24.6 24.7 C22 28.7 20.3 32.7 19.7 35.9 L26.9 35.9 C28.2 29.6 30.6 22.7 34.6 17.6 Z" fill={P.glass} />
        {/* RED brow cap along the leading curve — the 15T tell */}
        <Path
          d="M37 15.9 C31 16.3 26.9 18.9 23.6 23.9 C20.8 28.2 18.9 32.9 18.4 36.6"
          fill="none"
          stroke={P.red}
          strokeWidth={1.7}
          strokeLinecap="round"
        />
        {/* door edges crossing the white lower band */}
        <Line x1={42.8} y1={33.2} x2={42.8} y2={41.6} stroke={P.dark} strokeWidth={0.5} opacity={0.5} />
        <Line x1={49.8} y1={33.2} x2={49.8} y2={41.6} stroke={P.dark} strokeWidth={0.5} opacity={0.5} />
        {/* round headlight in the white muzzle band */}
        <Circle cx={19.6} cy={37.3} r={1.1} fill={P.glass} stroke={P.dark} strokeWidth={0.4} />
        <Circle cx={19.9} cy={37} r={0.4} fill="#EAF2F8" />
        <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={1.1} />
      </G>
    </Svg>
  );
}
