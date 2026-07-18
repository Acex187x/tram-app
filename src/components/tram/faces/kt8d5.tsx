// Tatra KT8D5.RN2P — the boxy articulated "старший брат". Wide, square
// white body with the full livery stack on the face: glossy anthracite window
// mask (green LED display at its top), white pinstripe, big red band carrying
// a big + small round lamp per side and amber corner blinker stacks, silver
// bumper beam, dark plow chin. Yellow-based semi-pantograph. Expression:
// broad, sturdy, dependable — wide-set double eyes and a solid straight chin.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { FACE_COLORS as C, FACE_VIEWBOX, type FaceProps } from './common';

const KT_WHITE = '#EDEDEA';
const KT_RED = '#8C1310';
const ANTHRACITE = '#22262B';

const BODY =
  'M10.5 55.5 L10.5 15 Q10.5 10.5 15 10.5 L49 10.5 Q53.5 10.5 53.5 15 L53.5 55.5 Q53.5 58 51 58 L13 58 Q10.5 58 10.5 55.5 Z';

export function FaceKT8D5({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX}>
      {/* semi-pantograph with yellow base */}
      <Path
        d="M35 9.4 L25.5 4.6 M22.6 4 L28.4 4"
        stroke="#9DA2A8"
        strokeWidth={1.4}
        strokeLinecap="round"
        fill="none"
      />
      <Rect x={32.6} y={8} width={4.8} height={1.8} rx={0.9} fill="#D9A31B" />
      {/* wide boxy body */}
      <Path
        d={BODY}
        fill={KT_WHITE}
      />
      {/* glossy anthracite window mask, wrapping the corners */}
      <Rect x={11.8} y={14.6} width={40.4} height={19.4} rx={3} fill={ANTHRACITE} />
      {/* green LED destination embedded at the mask top */}
      <Rect x={21.6} y={16.2} width={20.8} height={2.6} rx={1} fill="#0D1013" />
      <Rect x={23.4} y={17} width={6.4} height={1.1} rx={0.55} fill={C.ledGreen} />
      <Rect x={31.6} y={17} width={8.8} height={1.1} rx={0.55} fill={C.ledGreen} opacity={0.75} />
      {/* two-pane raked windshield inside the mask */}
      <Rect x={14.6} y={20.2} width={16.2} height={11.6} rx={1.6} fill={C.glass} />
      <Rect x={33.2} y={20.2} width={16.2} height={11.6} rx={1.6} fill={C.glass} />
      {/* tall cool glints — the steady gaze */}
      <Rect x={17} y={22} width={4} height={8} rx={2} fill={C.glint} opacity={0.4} />
      <Rect x={35.6} y={22} width={4} height={8} rx={2} fill={C.glint} opacity={0.4} />
      <Circle cx={19} cy={24} r={0.9} fill={C.glint} opacity={0.75} />
      <Circle cx={37.6} cy={24} r={0.9} fill={C.glint} opacity={0.75} />
      {/* white pinstripe between mask and red band */}
      <Rect x={10.5} y={34} width={43} height={1.5} fill="#F7F7F4" />
      {/* big red band */}
      <Rect x={10.5} y={35.5} width={43} height={13.6} fill={KT_RED} />
      {/* per side: big outer + small inner round lamp */}
      <Circle cx={18} cy={42.2} r={3.4} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.4} />
      <Circle cx={46} cy={42.2} r={3.4} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.4} />
      <Circle cx={17} cy={41.2} r={0.9} fill={C.glint} opacity={0.9} />
      <Circle cx={45} cy={41.2} r={0.9} fill={C.glint} opacity={0.9} />
      <Circle cx={25.6} cy={42.2} r={1.9} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.1} />
      <Circle cx={38.4} cy={42.2} r={1.9} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.1} />
      {/* amber/red blinker stacks on the corner rounding */}
      <Rect x={11.4} y={37.6} width={2.2} height={4.4} rx={1} fill={C.amber} />
      <Rect x={11.4} y={42.6} width={2.2} height={4.4} rx={1} fill="#C43C2E" />
      <Rect x={50.4} y={37.6} width={2.2} height={4.4} rx={1} fill={C.amber} />
      <Rect x={50.4} y={42.6} width={2.2} height={4.4} rx={1} fill="#C43C2E" />
      {/* fleet number chip on the red band */}
      <Rect x={29.2} y={45.4} width={5.6} height={1.9} rx={0.7} fill="#F7F2E6" opacity={0.95} />
      {/* silver bumper beam — the solid, dependable mouth */}
      <Rect x={11.6} y={49.4} width={40.8} height={2.9} rx={1.45} fill={C.silver} />
      {/* dark plow chin */}
      <Path d="M15.4 52.6 L48.6 52.6 L45.4 57 L18.6 57 Z" fill={C.charcoal} />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={1.6} />
    </Svg>
  );
}
