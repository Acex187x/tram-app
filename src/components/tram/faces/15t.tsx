// Škoda 15T ForCity Alfa — the добрый робот. Blunt rounded body wearing its
// livery as horizontal bands: red cap over the dome, silver cant strip, one
// giant gloss-black panoramic visor (with a cute chin-dip and two big soft
// eye-glints), red A-pillar strips, silver band with twin round headlights
// per side, red bumper with white DRL slots. Friendly, glossy, modern.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { FACE_COLORS as C, FACE_VIEWBOX, type FaceProps } from './common';

const FC_RED = '#AD1A1F';
const VISOR = '#15181D';

const BODY =
  'M12 56.5 L12 26 C12 13.5 18.5 9.5 32 9.5 C45.5 9.5 52 13.5 52 26 L52 56.5 Q52 60 48.5 60 L15.5 60 Q12 60 12 56.5 Z';

export function Face15T({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX}>
      {/* slim single-arm pantograph */}
      <Path
        d="M32 9.2 L24 4.8 M20.9 4.2 L27.1 4.2"
        stroke="#9DA2A8"
        strokeWidth={1.4}
        strokeLinecap="round"
        fill="none"
      />
      {/* blunt rounded body — red dome cap base fill */}
      <Path
        d={BODY}
        fill={FC_RED}
      />
      {/* silver cant strip under the red cap */}
      <Path d="M12.6 16.8 L51.4 16.8 L51.4 14.4 C50 12.4 47.5 11.2 44 10.6 L20 10.6 C16.5 11.2 14 12.4 12.6 14.4 Z" fill={C.silver} />
      {/* giant gloss-black visor with a cute chin-dip at the bottom center */}
      <Path
        d="M13.6 20.6 Q13.6 16.8 17.4 16.8 L46.6 16.8 Q50.4 16.8 50.4 20.6 L50.4 32.6 Q50.4 35.4 47.6 35.4 L37.4 35.4 Q33.6 35.4 32 38 Q30.4 35.4 26.6 35.4 L16.4 35.4 Q13.6 35.4 13.6 32.6 Z"
        fill={VISOR}
      />
      {/* red A-pillar strips framing the visor */}
      <Rect x={12.6} y={17.6} width={1.9} height={17} rx={0.95} fill={FC_RED} />
      <Rect x={49.5} y={17.6} width={1.9} height={17} rx={0.95} fill={FC_RED} />
      {/* destination display behind the visor top */}
      <Rect x={25} y={18.4} width={14} height={2.7} rx={1.2} fill="#23272E" />
      <Rect x={26.8} y={19.3} width={6} height={1.1} rx={0.55} fill={C.amber} />
      <Rect x={34.4} y={19.3} width={3.4} height={1.1} rx={0.55} fill={C.amber} opacity={0.7} />
      {/* two BIG soft robot eyes in the visor */}
      <Rect x={19.6} y={23} width={7} height={10} rx={3.5} fill={C.glint} opacity={0.5} />
      <Rect x={37.4} y={23} width={7} height={10} rx={3.5} fill={C.glint} opacity={0.5} />
      <Circle cx={23} cy={25.8} r={1.4} fill={C.glint} opacity={0.9} />
      <Circle cx={40.8} cy={25.8} r={1.4} fill={C.glint} opacity={0.9} />
      {/* silver band with twin round headlights per side */}
      <Rect x={12} y={38.2} width={40} height={7.8} fill={C.silver} />
      <Circle cx={18.6} cy={42.1} r={2.3} fill={C.warmLens} stroke="#8F949B" strokeWidth={1.1} />
      <Circle cx={24.4} cy={42.1} r={2.3} fill={C.warmLens} stroke="#8F949B" strokeWidth={1.1} />
      <Circle cx={39.6} cy={42.1} r={2.3} fill={C.warmLens} stroke="#8F949B" strokeWidth={1.1} />
      <Circle cx={45.4} cy={42.1} r={2.3} fill={C.warmLens} stroke="#8F949B" strokeWidth={1.1} />
      <Circle cx={18} cy={41.4} r={0.7} fill={C.glint} opacity={0.9} />
      <Circle cx={39} cy={41.4} r={0.7} fill={C.glint} opacity={0.9} />
      {/* reg-number chip centered in the silver band */}
      <Rect x={28.6} y={40.9} width={6.8} height={2.4} rx={0.8} fill="#FFFFFF" />
      <Rect x={29.8} y={41.9} width={4.4} height={0.6} rx={0.3} fill={FC_RED} opacity={0.8} />
      {/* red bumper zone with slim white DRL smile-slots */}
      <Rect x={16.8} y={49.6} width={9.6} height={1.7} rx={0.85} fill="#FFFFFF" opacity={0.92} />
      <Rect x={37.6} y={49.6} width={9.6} height={1.7} rx={0.85} fill="#FFFFFF" opacity={0.92} />
      {/* black under-lip */}
      <Rect x={14.8} y={55.6} width={34.4} height={2.2} rx={1.1} fill="#191B1F" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={1.6} />
    </Svg>
  );
}
