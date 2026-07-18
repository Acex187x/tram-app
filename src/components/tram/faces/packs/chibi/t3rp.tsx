// Chibi T3R.P — the modernized T3: SAME egg silhouette as t3 (correct — the
// body is original), but the narrow number box is replaced by a FULL-WIDTH
// amber dot-matrix brow band (the #1 differentiator), cool half-lidded
// "seen-it-all" eyes, small amber turn signals, a dark plastic bumper strip,
// and a modern boxy pantograph instead of the scissor.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BODY =
  'M11 50 C11 52.8 13 54 15.5 54 L48.5 54 C51 54 53 52.8 53 50 L53 26 C53 13 44 7 32 7 C20 7 11 13 11 26 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* modern boxy pantograph */}
      <Path
        d="M26.5 7.5 L32.5 3.6 M28.4 3.2 L37.6 3.2"
        stroke="#4A5566"
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
      {/* cream egg body — identical T3 silhouette */}
      <Path d={BODY} fill={C.cream} />
      {/* red lower band */}
      <Path
        d="M11 36.5 Q32 40.5 53 36.5 L53 50 C53 52.8 51 54 48.5 54 L15.5 54 C13 54 11 52.8 11 50 Z"
        fill={C.red}
      />
      {/* FULL-WIDTH amber dot-matrix destination brow band */}
      <Rect x={13.5} y={10.6} width={37} height={5.4} rx={2} fill={C.dark} />
      <Circle cx={19} cy={13.3} r={0.8} fill={C.amber} />
      <Circle cx={22.4} cy={13.3} r={0.8} fill={C.amber} />
      <Circle cx={25.8} cy={13.3} r={0.8} fill={C.amber} />
      <Circle cx={31.3} cy={13.3} r={0.8} fill={C.amber} opacity={0.55} />
      <Circle cx={36.8} cy={13.3} r={0.8} fill={C.amber} />
      <Circle cx={40.2} cy={13.3} r={0.8} fill={C.amber} />
      <Circle cx={43.6} cy={13.3} r={0.8} fill={C.amber} />
      {/* big round glass eyes */}
      <Circle cx={22.5} cy={27.5} r={8} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      <Circle cx={41.5} cy={27.5} r={8} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      {/* pupils sit low under the lids — relaxed veteran look */}
      <Circle cx={23.5} cy={29.4} r={3.9} fill={C.pupil} />
      <Circle cx={40.5} cy={29.4} r={3.9} fill={C.pupil} />
      <Circle cx={22.2} cy={27.9} r={1.5} fill={C.sparkle} />
      <Circle cx={39.2} cy={27.9} r={1.5} fill={C.sparkle} />
      {/* cool half-closed eyelids (cream chords over the eye tops) */}
      <Path d="M14.78 25.4 A8 8 0 0 1 30.22 25.4 Z" fill={C.cream} />
      <Path d="M33.78 25.4 A8 8 0 0 1 49.22 25.4 Z" fill={C.cream} />
      <Line x1={15.2} y1={25.4} x2={29.8} y2={25.4} stroke={C.outline} strokeWidth={1.5} strokeLinecap="round" />
      <Line x1={34.2} y1={25.4} x2={48.8} y2={25.4} stroke={C.outline} strokeWidth={1.5} strokeLinecap="round" />
      {/* blush */}
      <Ellipse cx={15.6} cy={34.6} rx={2.7} ry={1.8} fill={C.blush} opacity={0.8} />
      <Ellipse cx={48.4} cy={34.6} rx={2.7} ry={1.8} fill={C.blush} opacity={0.8} />
      {/* round headlights + small rectangular turn signals from the refit */}
      <Circle cx={20.5} cy={45.6} r={2.7} fill={C.lens} stroke={C.chrome} strokeWidth={1.2} />
      <Circle cx={43.5} cy={45.6} r={2.7} fill={C.lens} stroke={C.chrome} strokeWidth={1.2} />
      <Rect x={13.6} y={44.4} width={3.2} height={2.2} rx={0.8} fill={C.amber} stroke={C.outline} strokeWidth={0.8} />
      <Rect x={47.2} y={44.4} width={3.2} height={2.2} rx={0.8} fill={C.amber} stroke={C.outline} strokeWidth={0.8} />
      {/* confident little smile over the dark plastic bumper strip */}
      <Path d="M27.5 44.6 Q32 47.6 36.5 44.6" stroke={C.outline} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      <Rect x={18} y={49.4} width={28} height={3} rx={1.5} fill="#3A3742" />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
