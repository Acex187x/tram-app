// Chibi T3R.P — the modernized classic: IDENTICAL cream/red T3 bun (correct —
// the body is original), but the blue route box is replaced by a full-width
// GREEN LED destination strip in the brow (the #1 differentiator), plus
// rectangular amber turn signals beside the round headlights. Cool
// half-lidded veteran eyes tell it apart from the wide-eyed t3 at a glance.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const LED = '#9BE23A'; // yellow-green LED destination
const PANTO = '#D9A62E';

const BODY =
  'M11 50 C11 52.8 13 54 15.5 54 L48.5 54 C51 54 53 52.8 53 50 L53 25 C53 12.5 44 7 32 7 C20 7 11 12.5 11 25 Z';

const APRON =
  'M11 33.5 L28.5 33.5 L32 36.6 L35.5 33.5 L53 33.5 L53 48 L11 48 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* yellow diamond pantograph (kept from the original car) */}
      <Path
        d="M32 1.4 L37.4 4.3 L32 7.2 L26.6 4.3 Z"
        stroke={PANTO}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
      {/* cream bun body — identical T3 silhouette */}
      <Path d={BODY} fill={C.cream} />
      {/* full-width GREEN LED destination strip in the brow */}
      <Rect x={15} y={9.8} width={34} height={5.4} rx={1.6} fill={C.dark} stroke={C.outline} strokeWidth={0.9} />
      <Rect x={17.4} y={11.5} width={3.2} height={2} rx={0.5} fill={LED} />
      <Rect x={23} y={11.9} width={10} height={1.3} rx={0.65} fill={LED} />
      <Rect x={35.5} y={11.9} width={7} height={1.3} rx={0.65} fill={LED} opacity={0.85} />
      {/* split windscreen, two panes */}
      <Rect x={14.6} y={17.6} width={16} height={13.2} rx={4.4} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      <Rect x={33.4} y={17.6} width={16} height={13.2} rx={4.4} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      {/* pupils ride low — relaxed veteran look */}
      <Circle cx={23.4} cy={26} r={3.5} fill={C.pupil} />
      <Circle cx={40.6} cy={26} r={3.5} fill={C.pupil} />
      <Circle cx={22.2} cy={24.7} r={1.3} fill={C.sparkle} />
      <Circle cx={39.4} cy={24.7} r={1.3} fill={C.sparkle} />
      {/* cool half-closed eyelids */}
      <Path d="M14.6 22.6 L30.6 22.6 L30.6 19 Q28 17.6 22.6 17.6 Q17.2 17.6 14.6 19 Z" fill={C.cream} />
      <Path d="M33.4 22.6 L49.4 22.6 L49.4 19 Q46.8 17.6 41.4 17.6 Q36 17.6 33.4 19 Z" fill={C.cream} />
      <Line x1={15.4} y1={22.6} x2={29.8} y2={22.6} stroke={C.outline} strokeWidth={1.5} strokeLinecap="round" />
      <Line x1={34.2} y1={22.6} x2={48.6} y2={22.6} stroke={C.outline} strokeWidth={1.5} strokeLinecap="round" />
      {/* blush */}
      <Ellipse cx={17.6} cy={32.2} rx={2.5} ry={1.5} fill={C.blush} opacity={0.8} />
      <Ellipse cx={46.4} cy={32.2} rx={2.5} ry={1.5} fill={C.blush} opacity={0.8} />
      {/* RED apron with the shallow V dip */}
      <Path d={APRON} fill={C.red} />
      <Line x1={11} y1={48} x2={53} y2={48} stroke={C.outline} strokeWidth={0.9} opacity={0.35} />
      {/* round headlights + rectangular AMBER turn signals from the refit */}
      <Circle cx={20.5} cy={42} r={3.3} fill={C.lens} stroke={C.chrome} strokeWidth={1.6} />
      <Circle cx={43.5} cy={42} r={3.3} fill={C.lens} stroke={C.chrome} strokeWidth={1.6} />
      <Circle cx={19.4} cy={40.9} r={0.9} fill={C.sparkle} opacity={0.95} />
      <Circle cx={42.4} cy={40.9} r={0.9} fill={C.sparkle} opacity={0.95} />
      <Rect x={13} y={40.8} width={3.6} height={2.4} rx={0.8} fill={C.amber} stroke={C.outline} strokeWidth={0.8} />
      <Rect x={47.4} y={40.8} width={3.6} height={2.4} rx={0.8} fill={C.amber} stroke={C.outline} strokeWidth={0.8} />
      {/* easy confident smile */}
      <Path
        d="M28 43 Q32 45.8 36 43"
        stroke={C.cream}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
