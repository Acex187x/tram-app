// Chibi 52T — ForCity Plus Praha, the serene glassy premium one (Red Dot
// 2025). CORRECTED proportions: a very TALL single windscreen dominates
// ~70% of the face, sweeping up into the roofline inside a thin black mask —
// and only a LOW, SMALL skirt at the bottom (no chunky bumper!). The whole
// chibi face lives INSIDE the glass: calm oval eyes, soft blush, tiny smile,
// a premium sparkle. Slim ice-blue LED whisker strips flank the lower glass,
// white body with red PID stripe accents, roof AC module as a little hat.
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BODY =
  'M12 50.5 C12 53.3 14 54.5 16.5 54.5 L47.5 54.5 C50 54.5 52 53.3 52 50.5 L52 15 C52 10.4 49.5 8 45 8 L19 8 C14.5 8 12 10.4 12 15 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet (barely peeking — the skirt sits low) */}
      <Ellipse cx={32} cy={60} rx={19.5} ry={2.2} fill={C.shadow} />
      <Circle cx={21} cy={54.5} r={3.6} fill={C.dark} />
      <Circle cx={43} cy={54.5} r={3.6} fill={C.dark} />
      {/* roof AC module — a tidy little hat */}
      <Rect x={25.5} y={5} width={13} height={3.6} rx={1.6} fill={C.grey} stroke={C.outline} strokeWidth={1.1} />
      {/* sleek white body */}
      <Path d={BODY} fill={C.white} />
      {/* full-width destination band at the roofline — modern white LED */}
      <Rect x={15.5} y={9.6} width={33} height={4} rx={2} fill={C.dark} />
      <Rect x={19} y={11.2} width={10} height={1} rx={0.5} fill={C.iceLed} />
      <Rect x={32} y={11.2} width={4} height={1} rx={0.5} fill={C.iceLed} opacity={0.7} />
      <Rect x={39} y={11.2} width={6} height={1} rx={0.5} fill={C.iceLed} />
      {/* red PID stripe accents flanking the destination band */}
      <Path d="M12.6 10.4 L15 10.4 L15 12.8 L12.4 12.8 Z" fill={C.red} />
      <Path d="M51.4 10.4 L49 10.4 L49 12.8 L51.6 12.8 Z" fill={C.red} />
      {/* the TALL windscreen — glass dominates the face, thin black mask frame */}
      <Path
        d="M16 43.5 L16 19 C16 15.6 18.6 14.4 22 14.4 L42 14.4 C45.4 14.4 48 15.6 48 19 L48 43.5 Q48 45.8 45.6 45.8 L18.4 45.8 Q16 45.8 16 43.5 Z"
        fill={C.glass}
        stroke={C.outline}
        strokeWidth={2.1}
      />
      {/* lower-glass shading + tall premium reflection streak */}
      <Path d="M16 38.5 L48 38.5 L48 43.5 Q48 45.8 45.6 45.8 L18.4 45.8 Q16 45.8 16 43.5 Z" fill={C.glassDeep} opacity={0.5} />
      <Path d="M20 17.6 L24.4 16.4 L20.9 34 L18.3 32.4 Z" fill={C.sparkle} opacity={0.45} />
      {/* serene calm eyes, high in the glass */}
      <Ellipse cx={25.2} cy={25} rx={3.3} ry={4.2} fill={C.pupil} />
      <Ellipse cx={38.8} cy={25} rx={3.3} ry={4.2} fill={C.pupil} />
      <Path d="M21.6 20.9 Q25.2 19.7 28.8 20.9" stroke={C.outline} strokeWidth={1.3} strokeLinecap="round" fill="none" />
      <Path d="M35.2 20.9 Q38.8 19.7 42.4 20.9" stroke={C.outline} strokeWidth={1.3} strokeLinecap="round" fill="none" />
      <Circle cx={24.1} cy={23.2} r={1.4} fill={C.sparkle} />
      <Circle cx={37.7} cy={23.2} r={1.4} fill={C.sparkle} />
      <Circle cx={26.4} cy={27.3} r={0.7} fill={C.sparkle} opacity={0.85} />
      <Circle cx={40} cy={27.3} r={0.7} fill={C.sparkle} opacity={0.85} />
      {/* premium four-point sparkle in the glass */}
      <Path d="M43.6 17.2 L44.5 19.4 L46.7 20.3 L44.5 21.2 L43.6 23.4 L42.7 21.2 L40.5 20.3 L42.7 19.4 Z" fill={C.sparkle} opacity={0.9} />
      {/* soft blush + tiny serene smile, inside the glass */}
      <Ellipse cx={22.2} cy={32.6} rx={2.5} ry={1.6} fill={C.blush} opacity={0.8} />
      <Ellipse cx={41.8} cy={32.6} rx={2.5} ry={1.6} fill={C.blush} opacity={0.8} />
      <Path d="M29.2 34.8 Q32 37 34.8 34.8" stroke={C.pupil} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* slim horizontal LED daytime-running whiskers flanking the lower glass */}
      <Rect x={13.6} y={47.6} width={8.4} height={1.8} rx={0.9} fill={C.iceLed} stroke={C.outline} strokeWidth={0.9} />
      <Rect x={42} y={47.6} width={8.4} height={1.8} rx={0.9} fill={C.iceLed} stroke={C.outline} strokeWidth={0.9} />
      {/* LOW, SMALL skirt: just a red stripe accent hugging the rails — no bumper mass */}
      <Rect x={12.6} y={51} width={38.8} height={1.7} fill={C.red} />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
