// Tatra T3 — THE classic. Cream egg-shaped laminate face, one huge wrap-around
// windshield with a hairline red gasket seam, destination pill in the brow,
// twin chrome-ring round headlights low in the red mask, gold fleet number,
// chrome bumper smile, red scissor pantograph. Retro warmth: soft round
// glints, gently curved bumper = a kind old-timer's smile.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { FACE_COLORS as C, FACE_VIEWBOX, type FaceProps } from './common';

const BODY =
  'M13 56.5 L13 30 C13 15.5 20.5 9.5 32 9.5 C43.5 9.5 51 15.5 51 30 L51 56.5 Q51 60 47.5 60 L16.5 60 Q13 60 13 56.5 Z';

export function FaceT3({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX}>
      {/* red scissor pantograph */}
      <Path
        d="M25 9 L33.5 4.4 M39 9 L30.5 4.4 M27.6 3.8 L36.4 3.8"
        stroke="#A8261F"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* egg body */}
      <Path
        d={BODY}
        fill={C.cream}
      />
      {/* destination pill in the cream brow (gold text) */}
      <Rect x={24.6} y={12.4} width={14.8} height={3.9} rx={1.95} fill="#1B1713" />
      <Rect x={27.4} y={13.8} width={9.2} height={1.15} rx={0.57} fill={C.gold} opacity={0.92} />
      {/* wrap-around windshield */}
      <Path
        d="M16.6 32.6 L16.6 24 C16.6 19.6 22.2 17.6 32 17.6 C41.8 17.6 47.4 19.6 47.4 24 L47.4 32.6 Q47.4 34.5 45.5 34.5 L18.5 34.5 Q16.6 34.5 16.6 32.6 Z"
        fill={C.glass}
      />
      {/* hairline red center gasket */}
      <Line x1={32} y1={17.8} x2={32} y2={34.4} stroke="#8E2A22" strokeWidth={0.7} />
      {/* soft round eye-glints, one per pane */}
      <Rect x={20.6} y={20.4} width={5.4} height={9.6} rx={2.7} fill={C.glint} opacity={0.45} />
      <Rect x={38} y={20.4} width={5.4} height={9.6} rx={2.7} fill={C.glint} opacity={0.45} />
      <Circle cx={23.3} cy={22.8} r={1.1} fill={C.glint} opacity={0.8} />
      <Circle cx={40.7} cy={22.8} r={1.1} fill={C.glint} opacity={0.8} />
      {/* red mask — belt sweeps down at the cab corners, cream widens mid-face */}
      <Path d="M13 39.6 Q32 42.9 51 39.6 L51 52.4 L13 52.4 Z" fill={C.red} />
      {/* twin chrome-ring headlights low in the red mask */}
      <Circle cx={22.8} cy={47.5} r={3.3} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.4} />
      <Circle cx={41.2} cy={47.5} r={3.3} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.4} />
      <Circle cx={21.9} cy={46.5} r={0.9} fill={C.glint} opacity={0.9} />
      <Circle cx={40.3} cy={46.5} r={0.9} fill={C.glint} opacity={0.9} />
      {/* gold fleet number between the lamps */}
      <Rect x={29.4} y={46.6} width={5.2} height={1.8} rx={0.9} fill={C.gold} opacity={0.95} />
      {/* chrome bumper — a gentle smile */}
      <Path
        d="M16 52.8 Q32 55.2 48 52.8"
        stroke={C.chrome}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      {/* maroon lip + underframe shadow on the cream apron */}
      <Rect x={14.6} y={56} width={34.8} height={1.7} fill="#5A0B0F" opacity={0.9} />
      <Rect x={16} y={57.9} width={32} height={1.6} rx={0.8} fill="#4A3F35" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={1.6} />
    </Svg>
  );
}
