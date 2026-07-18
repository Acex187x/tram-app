// Tatra T3R.PLF "vana" — classic T3 face on a low-floor shell. Warm greige
// ivory body sitting LOW (deep skirt), green-yellow LED display band, panorama
// windshield, and the signature wine-red bib: two lobes whose top edge sweeps
// concavely down to a V that touches the big grey bumper — the cream wedge
// between them reads as an open, delighted smile. Round headlights sit inside
// the wine lobes like rosy cheeks. The softest of the T3 family.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { FACE_COLORS as C, FACE_VIEWBOX, type FaceProps } from './common';

const GREIGE = '#EBE1CD';
const WINE = '#6B1524';
const PANTO_YELLOW = '#E3B71F';

const BODY =
  'M13 57.5 L13 30.5 C13 16 20.5 10 32 10 C43.5 10 51 16 51 30.5 L51 57.5 Q51 61 47.5 61 L16.5 61 Q13 61 13 57.5 Z';

export function FaceT3RPLF({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX}>
      {/* yellow scissor pantograph */}
      <Path
        d="M25 9.6 L33.5 5 M39 9.6 L30.5 5 M27.6 4.4 L36.4 4.4"
        stroke={PANTO_YELLOW}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* egg body, sitting low — skirt reaches deeper than its sisters */}
      <Path
        d={BODY}
        fill={GREIGE}
      />
      {/* full-width black band with green-yellow LED destination */}
      <Rect x={17.4} y={13} width={29.2} height={4.1} rx={1.6} fill="#101317" />
      <Rect x={19.8} y={14.4} width={9} height={1.3} rx={0.65} fill="#BCE356" />
      <Rect x={31} y={14.4} width={12.2} height={1.3} rx={0.65} fill="#BCE356" opacity={0.75} />
      {/* two-piece panorama windshield */}
      <Path
        d="M16.6 32.8 L16.6 24 C16.6 20.3 22.2 18.4 32 18.4 C41.8 18.4 47.4 20.3 47.4 24 L47.4 32.8 Q47.4 34.7 45.5 34.7 L18.5 34.7 Q16.6 34.7 16.6 32.8 Z"
        fill={C.glass}
      />
      <Line x1={32} y1={18.6} x2={32} y2={34.6} stroke="#12161B" strokeWidth={0.8} />
      {/* big soft glints — the sweet look */}
      <Rect x={20.4} y={21} width={5.6} height={9.4} rx={2.8} fill={C.glint} opacity={0.45} />
      <Rect x={38} y={21} width={5.6} height={9.4} rx={2.8} fill={C.glint} opacity={0.45} />
      <Circle cx={23.2} cy={23.4} r={1.1} fill={C.glint} opacity={0.8} />
      <Circle cx={40.8} cy={23.4} r={1.1} fill={C.glint} opacity={0.8} />
      {/* white number plate under the glass center */}
      <Rect x={28.2} y={36} width={7.6} height={2.3} rx={0.7} fill="#F6F1E4" />
      {/* wine bib: two lobes, concave top edges meeting in a V at the bumper */}
      <Path
        d="M13 38.6 Q22 40.2 28.6 44.6 Q31.6 46.8 32 51 Q32.4 46.8 35.4 44.6 Q42 40.2 51 38.6 L51 51.8 L13 51.8 Z"
        fill={WINE}
      />
      {/* round headlights inside the wine lobes — rosy cheeks */}
      <Circle cx={20.6} cy={46.4} r={3} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.3} />
      <Circle cx={43.4} cy={46.4} r={3} fill={C.warmLens} stroke={C.chrome} strokeWidth={1.3} />
      <Circle cx={19.8} cy={45.5} r={0.8} fill={C.glint} opacity={0.9} />
      <Circle cx={42.6} cy={45.5} r={0.8} fill={C.glint} opacity={0.9} />
      {/* massive proud grey bumper wrapping the nose */}
      <Rect x={13.4} y={51.8} width={37.2} height={3.4} rx={1.7} fill="#9CA0A6" />
      <Line x1={15.4} y1={53.5} x2={48.6} y2={53.5} stroke="#7C8188" strokeWidth={0.7} />
      {/* low-floor skirt shadow, sitting close to the ground */}
      <Rect x={16} y={58.8} width={32} height={1.5} rx={0.75} fill="#4A3F35" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={1.6} />
    </Svg>
  );
}
