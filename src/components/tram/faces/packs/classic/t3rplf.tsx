// Tatra T3R.PLF — new-build retro body with a low-floor middle. Front is
// nearly a T3R.P (rounded nose, two round headlights, full-width orange LED
// sign) but the mask is a smooth MODERN plastic molding: crisper one-piece
// glass with only a hairline seam, headlights in molded silver bezels with
// integrated amber indicator slots, and a big proud grey bumper molding.
// Sits LOW — deeper skirt, body closer to the rails. The softest T3 sister.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const PANTO_YELLOW = '#E3B71F';

const BODY =
  'M12.5 57 L12.5 30.5 C12.5 15.5 20 9.5 32 9.5 C44 9.5 51.5 15.5 51.5 30.5 L51.5 57 Q51.5 60.8 47.5 60.8 L16.5 60.8 Q12.5 60.8 12.5 57 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* yellow scissor pantograph */}
      <Path
        d="M25 9.1 L33.5 4.7 M39 9.1 L30.5 4.7 M27.6 4.1 L36.4 4.1"
        stroke={PANTO_YELLOW}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* retro-styled new-build shell, sitting low */}
      <Path d={BODY} fill={P.cream} />
      {/* full-width orange LED destination band */}
      <Rect x={16.6} y={12.4} width={30.8} height={4.3} rx={1.4} fill="#101317" />
      <Rect x={19} y={13.8} width={9.4} height={1.4} rx={0.7} fill={P.ledOrange} />
      <Rect x={30.6} y={13.8} width={12} height={1.4} rx={0.7} fill={P.ledOrange} opacity={0.72} />
      {/* one-piece molded panorama glass — only a hairline seam */}
      <Path
        d="M15.6 33.4 L15.6 25.5 C15.6 20.3 22 18 32 18 C42 18 48.4 20.3 48.4 25.5 L48.4 33.4 Q48.4 35.3 46.4 35.3 L17.6 35.3 Q15.6 35.3 15.6 33.4 Z"
        fill={P.glass}
      />
      <Line x1={32} y1={18.2} x2={32} y2={35.2} stroke="#11151A" strokeWidth={0.5} opacity={0.7} />
      {/* big soft glints — the sweet look */}
      <Rect x={20} y={21} width={5.6} height={9.6} rx={2.8} fill={P.glint} opacity={0.46} />
      <Rect x={38.4} y={21} width={5.6} height={9.6} rx={2.8} fill={P.glint} opacity={0.46} />
      <Circle cx={22.8} cy={23.4} r={1.1} fill={P.glint} opacity={0.85} />
      <Circle cx={41.2} cy={23.4} r={1.1} fill={P.glint} opacity={0.85} />
      {/* red band with crisp molded panel gap at the top edge */}
      <Path
        d="M12.5 38.8 L51.5 38.8 L51.5 57 Q51.5 60.8 47.5 60.8 L16.5 60.8 Q12.5 60.8 12.5 57 Z"
        fill={P.red}
      />
      <Line x1={13.4} y1={38.8} x2={50.6} y2={38.8} stroke={P.creamShade} strokeWidth={0.6} opacity={0.8} />
      {/* headlights in molded silver bezels — the modern-molding cue */}
      <Rect x={17.6} y={41.6} width={9.6} height={7} rx={2.6} fill={P.silver} />
      <Rect x={36.8} y={41.6} width={9.6} height={7} rx={2.6} fill={P.silver} />
      <Circle cx={22.4} cy={45.1} r={2.5} fill={P.warmLens} stroke={P.silverDark} strokeWidth={1.1} />
      <Circle cx={41.6} cy={45.1} r={2.5} fill={P.warmLens} stroke={P.silverDark} strokeWidth={1.1} />
      <Circle cx={21.7} cy={44.3} r={0.75} fill={P.glint} opacity={0.9} />
      <Circle cx={40.9} cy={44.3} r={0.75} fill={P.glint} opacity={0.9} />
      {/* integrated slim amber indicator slots under each bezel */}
      <Rect x={18.4} y={49.4} width={8} height={1.5} rx={0.75} fill={P.amber} />
      <Rect x={37.6} y={49.4} width={8} height={1.5} rx={0.75} fill={P.amber} />
      {/* white number plate centered */}
      <Rect x={28.3} y={44} width={7.4} height={2.4} rx={0.7} fill="#F6F1E4" />
      {/* big proud grey bumper molding wrapping the nose */}
      <Rect x={13.2} y={52.6} width={37.6} height={3.6} rx={1.8} fill={P.grey} />
      <Line x1={15.4} y1={54.4} x2={48.6} y2={54.4} stroke="#7C8188" strokeWidth={0.7} />
      {/* low-floor stance: thin skirt shadow tight to the ground */}
      <Rect x={16.5} y={59.1} width={31} height={1.3} rx={0.65} fill="#4A3F35" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
