// Škoda 52T ForCity Plus — the WHITE tram with the BLACK HELMET VISOR.
// Corrected to the real design: light body, one glossy black wrap-around
// visor that sweeps up over the roof cap and down the A-pillars around a
// large windscreen, amber LED destination band inside its top, slim
// 3-element LED lights tucked low in the black corners, then a clean WHITE
// lower front with only a small RED center panel + tiny red 'pid' chip and a
// LOW body-colored skirt (no bumper mass). Single-arm pantograph.
// Expression: serene, premium, futuristic.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const BODY_WHITE = '#F4F3F0';
const VISOR = '#0E1114';
const GLASS_52 = '#242E39';

const BODY =
  'M14 56.5 L14.6 17 Q14.8 10 22 10 L42 10 Q49.2 10 49.4 17 L50 56.5 Q50 59.5 46.5 59.5 L17.5 59.5 Q14 59.5 14 56.5 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* single-arm pantograph */}
      <Path d="M32 9.6 L40 4.8" stroke="#8A8E94" strokeWidth={1.3} strokeLinecap="round" fill="none" />
      <Line x1={36.8} y1={4} x2={43.2} y2={4} stroke="#6B6F75" strokeWidth={1.1} strokeLinecap="round" />
      {/* clean white body */}
      <Path d={BODY} fill={BODY_WHITE} />
      {/* glossy BLACK helmet visor — over the roof cap, down the A-pillars,
          with a rounded black CHIN bulging down at the center */}
      <Path
        d="M14.65 16.4 Q14.9 10.6 22 10.6 L42 10.6 Q49.1 10.6 49.35 16.4 L49.75 42.6 Q49.75 44.6 47.8 44.9 Q42 45.8 38.5 47.6 Q35.5 49.2 32 49.2 Q28.5 49.2 25.5 47.6 Q22 45.8 16.2 44.9 Q14.25 44.6 14.25 42.6 Z"
        fill={VISOR}
      />
      {/* thin red trim arc riding the chin's lower edge */}
      <Path
        d="M20 45.9 Q26 47.4 29 48.6 Q31 49.4 32 49.4 Q33 49.4 35 48.6 Q38 47.4 44 45.9"
        stroke={P.pidRed}
        strokeWidth={0.9}
        strokeLinecap="round"
        fill="none"
        opacity={0.9}
      />
      {/* black wing mirrors — part of the helmet look */}
      <Rect x={12.2} y={23.5} width={2.2} height={4.4} rx={1.1} fill={P.charcoal} />
      <Rect x={49.6} y={23.5} width={2.2} height={4.4} rx={1.1} fill={P.charcoal} />
      {/* amber LED destination band inside the visor top */}
      <Rect x={22.6} y={13} width={3.4} height={1.8} rx={0.5} fill={P.amber} />
      <Rect x={27.6} y={13.2} width={13.4} height={1.5} rx={0.7} fill={P.amber} opacity={0.75} />
      {/* large windscreen inside the visor, slightly lighter than the black */}
      <Path
        d="M17.8 41.6 L18 19.8 Q18.1 16.8 21.1 16.8 L42.9 16.8 Q45.9 16.8 46 19.8 L46.2 41.6 Q40.5 40 32 40 Q23.5 40 17.8 41.6 Z"
        fill={GLASS_52}
      />
      {/* Škoda roundel centered on the black chin */}
      <Circle cx={32} cy={45.6} r={1.6} fill="none" stroke="#3D8B57" strokeWidth={0.9} />
      {/* tall serene glints */}
      <Rect x={21.6} y={19.6} width={5.4} height={16} rx={2.7} fill={P.glint} opacity={0.34} />
      <Rect x={37} y={19.6} width={4.2} height={16} rx={2.1} fill={P.glint} opacity={0.22} />
      <Circle cx={24.2} cy={22.4} r={1.05} fill={P.glint} opacity={0.8} />
      {/* slim 3-element LED lights low in the black corners */}
      <Rect x={16.9} y={42.5} width={1.7} height={2} rx={0.5} fill="#FFFFFF" />
      <Rect x={19.1} y={42.5} width={1.7} height={2} rx={0.5} fill="#FFFFFF" />
      <Rect x={21.3} y={42.5} width={1.7} height={2} rx={0.5} fill="#FFFFFF" />
      <Rect x={45.4} y={42.5} width={1.7} height={2} rx={0.5} fill="#FFFFFF" />
      <Rect x={43.2} y={42.5} width={1.7} height={2} rx={0.5} fill="#FFFFFF" />
      <Rect x={41} y={42.5} width={1.7} height={2} rx={0.5} fill="#FFFFFF" />
      {/* small RED center panel low on the white front (fleet number on it) */}
      <Rect x={27.6} y={49.8} width={8.8} height={7.6} fill={P.pidRed} />
      <Rect x={29.3} y={52.6} width={5.4} height={1.8} rx={0.5} fill="#FFFFFF" opacity={0.95} />
      {/* tiny red 'pid' chip on the white, left */}
      <Rect x={18.6} y={52.6} width={4.6} height={1.9} rx={0.95} fill={P.pidRed} />
      {/* LOW body-colored skirt — just a thin shadow line at the rails */}
      <Rect x={16.6} y={57.8} width={30.8} height={1.1} rx={0.55} fill="#B9BCC0" />
      {/* crisp silhouette re-stroked */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
