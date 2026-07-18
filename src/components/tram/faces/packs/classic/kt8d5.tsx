// Tatra KT8D5.RN2P — the angular two-headed giant. Boxy, slightly raked
// trapezoid front (T6A5/KT4 family): flat windscreen split by a CENTER
// PILLAR, full-width destination display at the top, and the signature
// CURVED WHITE STRIPE sweeping across the red front. Paired RECTANGULAR
// headlights low plus round halogen reflectors from the modernization,
// silver bumper beam, dark plow chin. Expression: broad and dependable.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const KT_WHITE = '#EFEEE9';
const ANTHRACITE = '#22262B';

const BODY =
  'M11.2 55.5 L12.8 13.5 Q13 10.5 16 10.5 L48 10.5 Q51 10.5 51.2 13.5 L52.8 55.5 Q52.9 58.5 50 58.5 L14 58.5 Q11.1 58.5 11.2 55.5 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* semi-pantograph with yellow base */}
      <Path
        d="M35 9.4 L25.5 4.6 M22.6 4 L28.4 4"
        stroke="#9DA2A8"
        strokeWidth={1.4}
        strokeLinecap="round"
        fill="none"
      />
      <Rect x={32.6} y={8.2} width={4.8} height={1.8} rx={0.9} fill="#D9A31B" />
      {/* boxy raked trapezoid body — no curves anywhere */}
      <Path d={BODY} fill={KT_WHITE} />
      {/* full-width destination display across the top */}
      <Rect x={14.4} y={12.2} width={35.2} height={4} rx={1.2} fill="#101317" />
      <Rect x={17} y={13.5} width={8.6} height={1.4} rx={0.7} fill={P.ledOrange} />
      <Rect x={27.8} y={13.5} width={14.6} height={1.4} rx={0.7} fill={P.ledOrange} opacity={0.72} />
      {/* anthracite window mask */}
      <Rect x={13.6} y={17.6} width={36.8} height={16.6} rx={2} fill={ANTHRACITE} />
      {/* FLAT two-pane windscreen split by the center pillar */}
      <Rect x={15.8} y={19.4} width={14.4} height={12.6} rx={1.2} fill={P.glass} />
      <Rect x={33.8} y={19.4} width={14.4} height={12.6} rx={1.2} fill={P.glass} />
      {/* tall steady glints */}
      <Rect x={18.2} y={21.2} width={4.2} height={9} rx={2.1} fill={P.glint} opacity={0.42} />
      <Rect x={36.2} y={21.2} width={4.2} height={9} rx={2.1} fill={P.glint} opacity={0.42} />
      <Circle cx={20.3} cy={23.3} r={0.95} fill={P.glint} opacity={0.8} />
      <Circle cx={38.3} cy={23.3} r={0.95} fill={P.glint} opacity={0.8} />
      {/* cream pinstripe between mask and red front */}
      <Rect x={12} y={34.2} width={40} height={1.4} fill="#F6F4EC" />
      {/* big red front */}
      <Path d="M12 35.6 L52 35.6 L52.8 55.5 Q52.9 58.5 50 58.5 L14 58.5 Q11.1 58.5 11.2 55.5 L12 35.6 Z" fill={P.red} />
      {/* SIGNATURE curved white stripe sweeping across the red end */}
      <Path
        d="M11.7 44.6 Q32 36.9 52.3 44.6 L52.4 47.9 Q32 40.2 11.6 47.9 Z"
        fill="#F6F4EC"
      />
      {/* paired RECTANGULAR headlights set low */}
      <Rect x={16.2} y={49.6} width={7.6} height={3.6} rx={1} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.2} />
      <Rect x={40.2} y={49.6} width={7.6} height={3.6} rx={1} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.2} />
      <Circle cx={18.4} cy={50.8} r={0.7} fill={P.glint} opacity={0.9} />
      <Circle cx={42.4} cy={50.8} r={0.7} fill={P.glint} opacity={0.9} />
      {/* round halogen reflectors added in the modernization, inboard */}
      <Circle cx={27.4} cy={51.4} r={1.9} fill={P.warmLens} stroke={P.chrome} strokeWidth={1} />
      <Circle cx={36.6} cy={51.4} r={1.9} fill={P.warmLens} stroke={P.chrome} strokeWidth={1} />
      {/* amber corner blinkers on the rounding */}
      <Rect x={12.4} y={49.8} width={2.3} height={3.6} rx={1} fill={P.amber} />
      <Rect x={49.3} y={49.8} width={2.3} height={3.6} rx={1} fill={P.amber} />
      {/* fleet number chip on the red, above the stripe */}
      <Rect x={29.2} y={40.2} width={5.6} height={2} rx={0.7} fill="#F7F2E6" opacity={0.95} />
      {/* silver bumper beam — the solid mouth */}
      <Rect x={12.2} y={54.2} width={39.6} height={2.4} rx={1.2} fill={P.silver} />
      {/* dark plow chin */}
      <Path d="M15.8 56.6 L48.2 56.6 L45.4 60.4 L18.6 60.4 Z" fill={P.charcoal} />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
