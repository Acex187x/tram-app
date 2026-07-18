// Škoda 15T ForCity Alfa — the current workhorse. Broad rounded-trapezoid
// face; ONE big raked windscreen with a subtle V/peak at the top center;
// distinctive ANGULAR polygonal headlight clusters ('cheekbones') sculpted
// into the mask each side — sharper than the 14T's round pods. Full-width
// LED destination at the roofline, cream upper, red lower, grey skirt.
// Expression: the friendly robot with cheekbones.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const CLUSTER = '#23262B';

const BODY =
  'M11.5 56 L13.2 22.5 C13.8 13.4 19.6 10 32 10 C44.4 10 50.2 13.4 50.8 22.5 L52.5 56 Q52.7 60 49 60 L15 60 Q11.3 60 11.5 56 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* slim single-arm pantograph */}
      <Path
        d="M32 9.6 L24 5 M20.9 4.4 L27.1 4.4"
        stroke="#9DA2A8"
        strokeWidth={1.4}
        strokeLinecap="round"
        fill="none"
      />
      {/* broad rounded-trapezoid body */}
      <Path d={BODY} fill={P.cream} />
      {/* full-width LED destination band at the roofline */}
      <Rect x={16.2} y={11.7} width={31.6} height={3.7} rx={1.3} fill="#101317" />
      <Rect x={18.6} y={12.9} width={7.6} height={1.3} rx={0.65} fill={P.ledOrange} />
      <Rect x={28.2} y={12.9} width={12.4} height={1.3} rx={0.65} fill={P.ledOrange} opacity={0.72} />
      {/* ONE big raked windscreen with a subtle V-peak at the top center */}
      <Path
        d="M16.8 33.4 L16.8 21.6 Q16.8 20 18.3 19.6 L30.4 16.7 Q32 16.3 33.6 16.7 L45.7 19.6 Q47.2 20 47.2 21.6 L47.2 33.4 Q47.2 35.6 45 35.6 L19 35.6 Q16.8 35.6 16.8 33.4 Z"
        fill={P.glass}
      />
      {/* big soft robot-eye glints */}
      <Rect x={20.2} y={21.4} width={6.6} height={10.4} rx={3.3} fill={P.glint} opacity={0.48} />
      <Rect x={37.2} y={21.4} width={6.6} height={10.4} rx={3.3} fill={P.glint} opacity={0.48} />
      <Circle cx={23.4} cy={24} r={1.3} fill={P.glint} opacity={0.9} />
      <Circle cx={40.4} cy={24} r={1.3} fill={P.glint} opacity={0.9} />
      {/* red lower body */}
      <Path
        d="M12.4 38.4 L51.6 38.4 L52.5 56 Q52.7 60 49 60 L15 60 Q11.3 60 11.5 56 L12.4 38.4 Z"
        fill={P.red}
      />
      {/* ANGULAR polygonal headlight clusters — the sculpted cheekbones */}
      <Path d="M13.2 39.8 L23.6 38 L25.2 44 L15.2 46.4 Z" fill={CLUSTER} />
      <Path d="M50.8 39.8 L40.4 38 L38.8 44 L48.8 46.4 Z" fill={CLUSTER} />
      <Path d="M16 41 L21.6 40 L22.6 43.2 L17.4 44.4 Z" fill="#EDF1F5" />
      <Path d="M48 41 L42.4 40 L41.4 43.2 L46.6 44.4 Z" fill="#EDF1F5" />
      <Circle cx={23.6} cy={39.6} r={0.9} fill={P.amber} />
      <Circle cx={40.4} cy={39.6} r={0.9} fill={P.amber} />
      {/* white reg plate centered between the cheekbones */}
      <Rect x={28.5} y={41} width={7} height={2.4} rx={0.8} fill="#FFFFFF" />
      <Rect x={29.7} y={42} width={4.6} height={0.6} rx={0.3} fill={P.redDeep} opacity={0.8} />
      {/* slim white DRL smile-slots low on the red */}
      <Rect x={17.6} y={49.8} width={9.2} height={1.6} rx={0.8} fill="#FFFFFF" opacity={0.92} />
      <Rect x={37.2} y={49.8} width={9.2} height={1.6} rx={0.8} fill="#FFFFFF" opacity={0.92} />
      {/* grey skirt band */}
      <Rect x={13.8} y={54.6} width={36.4} height={3.2} rx={1.4} fill={P.grey} />
      {/* dark under-lip */}
      <Rect x={16} y={58.2} width={32} height={1.5} rx={0.75} fill="#191B1F" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
