// Chibi T3 — the dependable grandpa of the fleet. Cream egg squished into a
// chubby mascot, two HUGE round wrap-around-glass eyes with a hairline red
// gasket seam between them, the classic NARROW route-number box as a tiny cap
// badge (the t3 tell), chrome-ring headlight freckles, warm chrome-bumper
// smile, red scissor-pantograph ahoge, tiny wheels for feet.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BODY =
  'M11 50 C11 52.8 13 54 15.5 54 L48.5 54 C51 54 53 52.8 53 50 L53 26 C53 13 44 7 32 7 C20 7 11 13 11 26 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet (peek below body) */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* red scissor pantograph ahoge */}
      <Path
        d="M24.5 7.5 L33 3.2 M39.5 7.5 L31 3.2 M27.6 2.8 L36.4 2.8"
        stroke={C.redDeep}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* cream egg body */}
      <Path d={BODY} fill={C.cream} />
      {/* red lower band — dips at the corners like the real belt line */}
      <Path
        d="M11 36.5 Q32 40.5 53 36.5 L53 50 C53 52.8 51 54 48.5 54 L15.5 54 C13 54 11 52.8 11 50 Z"
        fill={C.red}
      />
      {/* NARROW number box cap badge (classic-T3 tell — not full width) */}
      <Rect x={26.5} y={10.2} width={11} height={4.6} rx={1.6} fill={C.dark} />
      <Rect x={28.6} y={11.9} width={6.8} height={1.3} rx={0.65} fill={C.amber} opacity={0.95} />
      {/* two HUGE round glass eyes (the wrap-around windscreen) */}
      <Circle cx={22.5} cy={27.5} r={8} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      <Circle cx={41.5} cy={27.5} r={8} fill={C.glass} stroke={C.outline} strokeWidth={1.8} />
      {/* hairline red gasket seam between the panes */}
      <Line x1={32} y1={23.5} x2={32} y2={31.5} stroke="#8E2A22" strokeWidth={0.9} />
      {/* big soft pupils + sparkle highlights */}
      <Circle cx={23.8} cy={28.3} r={4.2} fill={C.pupil} />
      <Circle cx={40.2} cy={28.3} r={4.2} fill={C.pupil} />
      <Circle cx={22.4} cy={26.6} r={1.7} fill={C.sparkle} />
      <Circle cx={38.8} cy={26.6} r={1.7} fill={C.sparkle} />
      <Circle cx={25.3} cy={30.2} r={0.8} fill={C.sparkle} opacity={0.85} />
      <Circle cx={41.7} cy={30.2} r={0.8} fill={C.sparkle} opacity={0.85} />
      {/* rosy blush on the cream cheeks */}
      <Ellipse cx={15.6} cy={34.6} rx={2.7} ry={1.8} fill={C.blush} opacity={0.85} />
      <Ellipse cx={48.4} cy={34.6} rx={2.7} ry={1.8} fill={C.blush} opacity={0.85} />
      {/* chrome-ring round headlight freckles low in the red band */}
      <Circle cx={20} cy={45.8} r={2.7} fill={C.lens} stroke={C.chrome} strokeWidth={1.3} />
      <Circle cx={44} cy={45.8} r={2.7} fill={C.lens} stroke={C.chrome} strokeWidth={1.3} />
      <Circle cx={19.2} cy={45} r={0.8} fill={C.sparkle} opacity={0.9} />
      <Circle cx={43.2} cy={45} r={0.8} fill={C.sparkle} opacity={0.9} />
      {/* warm chrome-bumper smile */}
      <Path
        d="M26 45.6 Q32 50.4 38 45.6"
        stroke={C.chrome}
        strokeWidth={2.2}
        strokeLinecap="round"
        fill="none"
      />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
