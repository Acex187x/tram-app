// Side Profile pack — Tatra T3: NOSE PORTRAIT in side view (front cab only,
// body cropped off the right edge). The classic rounded "bathtub" prow: a
// gently curved, near-vertical wrap-around windscreen, cream body over the
// red belt, round headlight on the nose, the little blue route-number box on
// the roof brow and diamond-pantograph horns above. Nose faces left.
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#EDF0F4',
  edge: 'rgba(90,102,120,0.35)',
  rail: '#A7AEB9',
  wheel: '#333941',
  red: '#C8352C',
  cream: '#F3E6C8',
  door: '#E6D5AC',
  glass: '#54788C',
  roof: '#8A8378',
  blue: '#2C56A8',
  panto: '#C89A2E',
  dark: '#23272E',
  lens: '#FFD98F',
} as const;

// Rounded T3 prow, nose at left; body runs off the right edge (clipped).
const BODY =
  'M63 18.5 L30 18.5 C24 18.8 21.6 21 20.6 24 C19.3 28 18.8 31.8 18.9 35 C19.2 41.8 20.6 46.8 25.2 49 L63 49 Z';

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <ClipPath id="sideT3Plate">
          <Rect x={1.5} y={1.5} width={61} height={61} rx={14} />
        </ClipPath>
        <ClipPath id="sideT3Body">
          <Path d={BODY} />
        </ClipPath>
      </Defs>
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <G clipPath="url(#sideT3Plate)">
        {/* diamond-pantograph horns */}
        <Path d="M45 9.4 L51 13.9 L45 18.4 L39 13.9 Z" fill="none" stroke={P.panto} strokeWidth={1.2} strokeLinejoin="round" />
        <Line x1={41.4} y1={8.9} x2={48.6} y2={8.9} stroke={P.panto} strokeWidth={1.3} strokeLinecap="round" />
        {/* rail + wheels peeking under the skirt */}
        <Line x1={7} y1={53.6} x2={57} y2={53.6} stroke={P.rail} strokeWidth={1.2} strokeLinecap="round" />
        <Circle cx={30} cy={50.3} r={3} fill={P.wheel} />
        <Circle cx={45} cy={50.3} r={3} fill={P.wheel} />
        {/* cream bathtub prow */}
        <Path d={BODY} fill={P.cream} />
        <G clipPath="url(#sideT3Body)">
          <Rect x={14} y={18.5} width={50} height={2.4} fill={P.roof} />
          <Rect x={14} y={36.2} width={50} height={7.4} fill={P.red} />
        </G>
        {/* big near-vertical curved windscreen — the T3 tell */}
        <Path d="M24.2 23 L29.2 23 L29.2 34.2 L21 34.2 C21.2 29.6 22.3 25.6 24.2 23 Z" fill={P.glass} />
        {/* cab side window */}
        <Rect x={31.8} y={23} width={8.6} height={11.2} rx={1} fill={P.glass} />
        {/* front folding door interrupting the belt */}
        <Rect x={43} y={21} width={8} height={27.7} fill={P.door} />
        <Rect x={44} y={23} width={6} height={7.5} rx={0.8} fill={P.glass} />
        <Line x1={47} y1={21.4} x2={47} y2={48.4} stroke={P.dark} strokeWidth={0.5} opacity={0.65} />
        {/* start of the saloon behind the door */}
        <Rect x={53.5} y={23} width={8.5} height={11.2} rx={1} fill={P.glass} />
        {/* blue route-number box on the roof brow — classic-T3 badge */}
        <Rect x={21.8} y={19.3} width={5} height={3.1} rx={0.5} fill={P.blue} stroke={P.dark} strokeWidth={0.35} />
        {/* round headlight on the red belt */}
        <Circle cx={20.7} cy={39.2} r={1.5} fill={P.lens} stroke={P.dark} strokeWidth={0.45} />
        <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={1.1} />
      </G>
    </Svg>
  );
}
