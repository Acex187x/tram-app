// Tatra T3R.P — the modernized T3 workhorse. Same cream egg shell as the T3
// but: wide black BUSE display band (green LED) above the glass, two-piece
// windshield with a dark seam, round chrome headlights HIGHER in a bigger
// traffic-red mask, amber oval indicators at the outer corners, dark-brown
// bumper rail, YELLOW scissor pantograph. Expression: the focused workhorse —
// straighter mouth, narrower glints.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { FACE_COLORS as C, FACE_VIEWBOX, type FaceProps } from './common';

const TRAFFIC_RED = '#8F1511';
const PANTO_YELLOW = '#E3B71F';

const BODY =
  'M13 56.5 L13 30 C13 15.5 20.5 9.5 32 9.5 C43.5 9.5 51 15.5 51 30 L51 56.5 Q51 60 47.5 60 L16.5 60 Q13 60 13 56.5 Z';

export function FaceT3RP({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX}>
      {/* yellow scissor pantograph */}
      <Path
        d="M25 9 L33.5 4.4 M39 9 L30.5 4.4 M27.6 3.8 L36.4 3.8"
        stroke={PANTO_YELLOW}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* egg body (same T3 shell) */}
      <Path
        d={BODY}
        fill={C.cream}
      />
      {/* wide black BUSE display band, green-lit */}
      <Rect x={18.4} y={12.6} width={27.2} height={4.1} rx={1.6} fill="#101317" />
      <Rect x={20.8} y={14} width={7.6} height={1.3} rx={0.65} fill={C.ledGreen} />
      <Rect x={30.4} y={14} width={12.4} height={1.3} rx={0.65} fill={C.ledGreen} opacity={0.75} />
      {/* two-piece windshield, dark center seam */}
      <Path
        d="M16.6 32.4 L16.6 23.6 C16.6 19.9 22.2 18 32 18 C41.8 18 47.4 19.9 47.4 23.6 L47.4 32.4 Q47.4 34.3 45.5 34.3 L18.5 34.3 Q16.6 34.3 16.6 32.4 Z"
        fill={C.glass}
      />
      <Line x1={32} y1={18.2} x2={32} y2={34.2} stroke="#12161B" strokeWidth={1.1} />
      {/* narrower, business-like glints */}
      <Rect x={20.8} y={20.6} width={4.2} height={9} rx={2.1} fill={C.glint} opacity={0.4} />
      <Rect x={38.6} y={20.6} width={4.2} height={9} rx={2.1} fill={C.glint} opacity={0.4} />
      {/* big traffic-red mask, straight top edge (no retro sweep) */}
      <Rect x={13} y={35.8} width={38} height={14.6} fill={TRAFFIC_RED} />
      {/* round chrome-ring headlights */}
      <Circle cx={23.2} cy={43.4} r={3.1} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.4} />
      <Circle cx={40.8} cy={43.4} r={3.1} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.4} />
      <Circle cx={22.4} cy={42.5} r={0.85} fill={C.glint} opacity={0.9} />
      <Circle cx={40} cy={42.5} r={0.85} fill={C.glint} opacity={0.9} />
      {/* amber vertical oval indicators at the outer corners */}
      <Ellipse cx={16.6} cy={43.4} rx={1.5} ry={2.6} fill={C.amber} />
      <Ellipse cx={47.4} cy={43.4} rx={1.5} ry={2.6} fill={C.amber} />
      {/* white number plate under the glass */}
      <Rect x={28.4} y={45.8} width={7.2} height={2.3} rx={0.7} fill="#EFE9DA" />
      <Rect x={29.6} y={46.7} width={4.8} height={0.6} rx={0.3} fill={TRAFFIC_RED} opacity={0.8} />
      {/* dark-brown bumper rail — the steady straight mouth */}
      <Rect x={14} y={50.4} width={36} height={2.6} rx={1.3} fill="#3E2B22" />
      {/* cream chin below, thin skirt shadow */}
      <Rect x={16} y={57.9} width={32} height={1.6} rx={0.8} fill="#4A3F35" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={1.6} />
    </Svg>
  );
}
