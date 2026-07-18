// Škoda 52T ForCity Plus Praha — the newest, narrow and serene. Warm-white
// smooth body with one glossy BLACK helmet dome (glass + crown are a single
// black shape), white A-pillar strips flanking the glass, amber display inside
// the black, tri-dot LED clusters in the mask's lower corners, and the
// signature PID-red vertical stripe down the center of the white bumper — a
// neat little necktie. Expression: calm minimal robot, softly smiling LEDs.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { FACE_COLORS as C, FACE_VIEWBOX, type FaceProps } from './common';

const BODY_WHITE = '#EFEDE8';
const PID_RED = '#C41E25';
const HELMET = '#101317';

const BODY =
  'M15 56.5 L15 24 C15 12.5 21 8 32 8 C43 8 49 12.5 49 24 L49 56.5 Q49 60 45.5 60 L18.5 60 Q15 60 15 56.5 Z';

export function Face52T({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX}>
      {/* low-profile single-arm pantograph */}
      <Path
        d="M32 8.6 L39.5 4.6 M36.6 4 L42.4 4"
        stroke="#9DA2A8"
        strokeWidth={1.3}
        strokeLinecap="round"
        fill="none"
      />
      {/* narrow smooth body */}
      <Path
        d={BODY}
        fill={BODY_WHITE}
      />
      {/* black crown — top slice of the dome */}
      <Path
        d="M15.9 20.5 C16.6 12.8 21.8 8.9 32 8.9 C42.2 8.9 47.4 12.8 48.1 20.5 L48.1 21.4 L15.9 21.4 Z"
        fill={HELMET}
      />
      {/* black glass mask, inset so white A-pillar strips flank it */}
      <Rect x={18.6} y={13.6} width={26.8} height={27.6} rx={6} fill={HELMET} />
      {/* amber destination display inside the black */}
      <Rect x={26} y={17.2} width={7.4} height={1.6} rx={0.8} fill={C.amber} />
      <Rect x={35.2} y={17.2} width={2.8} height={1.6} rx={0.8} fill={C.amber} opacity={0.7} />
      {/* windshield sheen panel + tall calm glints */}
      <Rect x={20.8} y={21.6} width={22.4} height={16.4} rx={4.5} fill="#222932" />
      <Rect x={24} y={23.8} width={4.6} height={10.4} rx={2.3} fill={C.glint} opacity={0.4} />
      <Rect x={35.4} y={23.8} width={4.6} height={10.4} rx={2.3} fill={C.glint} opacity={0.4} />
      <Circle cx={26.3} cy={26.2} r={1} fill={C.glint} opacity={0.8} />
      <Circle cx={37.7} cy={26.2} r={1} fill={C.glint} opacity={0.8} />
      {/* Škoda roundel centered on the mask */}
      <Circle cx={32} cy={34.4} r={1.6} fill="none" stroke="#3D8B57" strokeWidth={0.9} />
      {/* tri-dot LED DRLs + round projector in the mask's lower corners */}
      <Circle cx={22.1} cy={36.4} r={1.3} fill="#EDF2F7" />
      <Circle cx={41.9} cy={36.4} r={1.3} fill="#EDF2F7" />
      <Circle cx={20.9} cy={39} r={0.85} fill="#FFFFFF" />
      <Circle cx={23.1} cy={39} r={0.85} fill="#FFFFFF" />
      <Circle cx={25.3} cy={39} r={0.85} fill="#FFFFFF" />
      <Circle cx={38.7} cy={39} r={0.85} fill="#FFFFFF" />
      <Circle cx={40.9} cy={39} r={0.85} fill="#FFFFFF" />
      <Circle cx={43.1} cy={39} r={0.85} fill="#FFFFFF" />
      {/* PID-red vertical center stripe on the white bumper — the necktie */}
      <Rect x={26.2} y={42.6} width={11.6} height={13.2} fill={PID_RED} />
      {/* red pid wordmark chip (left cheek) + grey fleet number (right) */}
      <Rect x={18.2} y={46} width={4.8} height={1.9} rx={0.95} fill={PID_RED} />
      <Rect x={41} y={46} width={4.8} height={1.9} rx={0.95} fill="#B9BDC4" />
      {/* soft smile seam on the necktie */}
      <Path
        d="M28.4 51.4 Q32 52.8 35.6 51.4"
        stroke="#FFFFFF"
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
        opacity={0.85}
      />
      {/* dark under-lip close to the ground */}
      <Rect x={18} y={57.6} width={28} height={1.6} rx={0.8} fill="#3F4247" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={1.6} />
    </Svg>
  );
}
