// Chibi 15T — ForCity Alfa, the friendly workhorse ROBOT. Broad
// rounded-trapezoid face, big windscreen with the tell-tale V-peak at the top
// center, glowing round robot eyes, ANGULAR polygonal headlight cheekbones
// (sharper than the 14T's round lamps), full-width roofline LED, big open
// smile, and an antenna bobble. White upper / red lower / grey skirt.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const BODY =
  'M11 50 C11 52.8 13 54 15.5 54 L48.5 54 C51 54 53 52.8 53 50 L52.2 19.5 C51.9 11.5 45 8.5 32 8.5 C19 8.5 12.1 11.5 11.8 19.5 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheel-feet */}
      <Ellipse cx={32} cy={59.6} rx={20} ry={2.4} fill={C.shadow} />
      <Circle cx={21} cy={54} r={4} fill={C.dark} />
      <Circle cx={43} cy={54} r={4} fill={C.dark} />
      <Circle cx={21} cy={55.4} r={1.2} fill={C.chrome} />
      <Circle cx={43} cy={55.4} r={1.2} fill={C.chrome} />
      {/* robot antenna bobble */}
      <Line x1={32} y1={8.5} x2={32} y2={5} stroke={C.outline} strokeWidth={1.6} strokeLinecap="round" />
      <Circle cx={32} cy={3.6} r={1.8} fill={C.red} stroke={C.outline} strokeWidth={1.1} />
      {/* broad rounded-trapezoid body, white upper */}
      <Path d={BODY} fill={C.white} />
      {/* red lower band and grey skirt */}
      <Rect x={11.2} y={38} width={41.6} height={10.5} fill={C.red} />
      <Path
        d="M11 48.5 L53 48.5 L53 50 C53 52.8 51 54 48.5 54 L15.5 54 C13 54 11 52.8 11 50 Z"
        fill={C.grey}
      />
      {/* full-width roofline LED display */}
      <Rect x={15.5} y={10.8} width={33} height={4.6} rx={2} fill={C.dark} />
      <Rect x={19} y={12.6} width={9} height={1.1} rx={0.55} fill={C.amber} />
      <Rect x={31} y={12.6} width={4} height={1.1} rx={0.55} fill={C.amber} opacity={0.7} />
      <Rect x={38} y={12.6} width={7} height={1.1} rx={0.55} fill={C.amber} />
      {/* big windscreen visor with the V-peak at top center */}
      <Path
        d="M16 33.5 L16 23 Q16 20.8 18.5 20 L30.5 16.8 Q32 16.4 33.5 16.8 L45.5 20 Q48 20.8 48 23 L48 33.5 Q48 36 45.5 36 L18.5 36 Q16 36 16 33.5 Z"
        fill={C.glass}
        stroke={C.outline}
        strokeWidth={1.9}
      />
      {/* glass shading + reflection under the peak */}
      <Path d="M16 31 L48 31 L48 33.5 Q48 36 45.5 36 L18.5 36 Q16 36 16 33.5 Z" fill={C.glassDeep} opacity={0.55} />
      <Path d="M28.5 18.2 L33 17 L30 20.6 Z" fill={C.sparkle} opacity={0.55} />
      {/* glowing round robot eyes */}
      <Circle cx={24.5} cy={27.2} r={4.8} fill={C.pupil} />
      <Circle cx={39.5} cy={27.2} r={4.8} fill={C.pupil} />
      <Circle cx={24.5} cy={27.2} r={2.1} fill={C.glow} />
      <Circle cx={39.5} cy={27.2} r={2.1} fill={C.glow} />
      <Circle cx={23} cy={25.4} r={1.3} fill={C.sparkle} />
      <Circle cx={38} cy={25.4} r={1.3} fill={C.sparkle} />
      {/* ANGULAR polygonal headlight cheekbones set into the mask */}
      <Path d="M11.6 39.5 L19.5 38.6 L17.8 43.4 L11.8 43.9 Z" fill={C.lens} stroke={C.outline} strokeWidth={1.2} />
      <Path d="M52.4 39.5 L44.5 38.6 L46.2 43.4 L52.2 43.9 Z" fill={C.lens} stroke={C.outline} strokeWidth={1.2} />
      {/* big friendly open smile */}
      <Path d="M26.5 41.5 Q32 47.8 37.5 41.5 Q32 43.4 26.5 41.5 Z" fill={C.dark} />
      <Path d="M29.5 44.6 Q32 46.2 34.5 44.6 Q32 47 29.5 44.6 Z" fill={C.blush} />
      {/* blush inside the visor — the robot's whole face lives in the glass */}
      <Ellipse cx={20.8} cy={32.8} rx={2.6} ry={1.6} fill={C.blush} opacity={0.85} />
      <Ellipse cx={43.2} cy={32.8} rx={2.6} ry={1.6} fill={C.blush} opacity={0.85} />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
