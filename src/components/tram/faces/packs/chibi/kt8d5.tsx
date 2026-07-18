// Chibi KT8D5 — the LONG boxy articulated one. Angular near-rectangular head
// (no bun curves!), dark anthracite windscreen mask holding two square glass
// eyes, red belt with the WHITE bumper stripe carrying two round headlights,
// grey skirt — and two accordion-jointed body sections peeking out on BOTH
// sides so it reads as the three-section giant. Yellow diamond pantograph.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const MASK = '#454C59'; // anthracite window mask
const PANTO = '#D9A62E';

const BODY =
  'M14 51 C14 53.5 15.6 54 17.5 54 L46.5 54 C48.4 54 50 53.5 50 51 L49.4 12.5 C49.35 10 48.2 9 45.7 9 L18.3 9 C15.8 9 14.65 10 14.6 12.5 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow */}
      <Ellipse cx={32} cy={59.6} rx={24} ry={2.4} fill={C.shadow} />
      {/* trailing SECTIONS peeking on both sides — the articulated tell */}
      <Path d="M6.5 20 L12.5 20 L12.5 52 L8 52 C6.9 52 6.5 51.4 6.5 50.4 Z" fill={C.white} stroke={C.outline} strokeWidth={1.6} />
      <Path d="M57.5 20 L51.5 20 L51.5 52 L56 52 C57.1 52 57.5 51.4 57.5 50.4 Z" fill={C.white} stroke={C.outline} strokeWidth={1.6} />
      <Path d="M6.5 33 L12.5 33 L12.5 46 L6.7 46 Z" fill={C.red} />
      <Path d="M57.5 33 L51.5 33 L51.5 46 L57.3 46 Z" fill={C.red} />
      {/* accordion joint pleats */}
      <Line x1={9.6} y1={21.5} x2={9.6} y2={50.5} stroke={C.outline} strokeWidth={1.1} opacity={0.55} />
      <Line x1={54.4} y1={21.5} x2={54.4} y2={50.5} stroke={C.outline} strokeWidth={1.1} opacity={0.55} />
      {/* wheel-feet */}
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* yellow diamond pantograph */}
      <Path
        d="M32 1.6 L37.2 4.6 L32 7.6 L26.8 4.6 Z"
        stroke={PANTO}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
      {/* BOXY near-rectangular head, white upper */}
      <Path d={BODY} fill={C.white} />
      {/* amber destination display in the flat white brow */}
      <Rect x={19.5} y={10.6} width={25} height={4.6} rx={1.2} fill={C.dark} stroke={C.outline} strokeWidth={0.9} />
      <Rect x={21.8} y={12.1} width={2.6} height={1.7} rx={0.4} fill={C.amber} />
      <Rect x={26.6} y={12.4} width={8.5} height={1.2} rx={0.6} fill={C.amber} />
      <Rect x={37} y={12.4} width={5.4} height={1.2} rx={0.6} fill={C.amber} opacity={0.8} />
      {/* dark anthracite windscreen MASK with two square glass eyes */}
      <Rect x={16.6} y={17} width={30.8} height={14.4} rx={1.8} fill={MASK} stroke={C.outline} strokeWidth={1.4} />
      <Rect x={18.6} y={18.8} width={12.2} height={10.8} rx={1.4} fill={C.glass} stroke={C.outline} strokeWidth={1.2} />
      <Rect x={33.2} y={18.8} width={12.2} height={10.8} rx={1.4} fill={C.glass} stroke={C.outline} strokeWidth={1.2} />
      {/* SQUARE pupils — even the eyes are boxy */}
      <Rect x={22.2} y={21.6} width={5} height={5.2} rx={1.1} fill={C.pupil} />
      <Rect x={36.8} y={21.6} width={5} height={5.2} rx={1.1} fill={C.pupil} />
      <Circle cx={23.4} cy={22.9} r={1.2} fill={C.sparkle} />
      <Circle cx={38} cy={22.9} r={1.2} fill={C.sparkle} />
      {/* red belt below the mask — full face width */}
      <Path d="M14.35 33.5 L49.55 33.5 L49.75 45.5 L14.15 45.5 Z" fill={C.red} />
      {/* square blush on the red */}
      <Rect x={18} y={35.6} width={4.4} height={2.6} rx={0.9} fill={C.blush} opacity={0.9} />
      <Rect x={41.6} y={35.6} width={4.4} height={2.6} rx={0.9} fill={C.blush} opacity={0.9} />
      {/* little smile on the red belt */}
      <Path d="M28.5 38.8 Q32 41.6 35.5 38.8" stroke={C.white} strokeWidth={1.9} strokeLinecap="round" fill="none" />
      {/* WHITE bumper stripe with two round headlights set in it */}
      <Path d="M14.15 45.5 L49.75 45.5 L49.85 50.5 L14.05 50.5 Z" fill={C.white} />
      <Circle cx={21.5} cy={48} r={2.5} fill={C.lens} stroke={C.outline} strokeWidth={1.1} />
      <Circle cx={42.5} cy={48} r={2.5} fill={C.lens} stroke={C.outline} strokeWidth={1.1} />
      <Circle cx={20.7} cy={47.2} r={0.7} fill={C.sparkle} opacity={0.95} />
      <Circle cx={41.7} cy={47.2} r={0.7} fill={C.sparkle} opacity={0.95} />
      {/* grey skirt */}
      <Path d="M14.05 50.5 L49.85 50.5 L50 51 C50 53.5 48.4 54 46.5 54 L17.5 54 C15.6 54 14 53.5 14 51 Z" fill={C.grey} />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
