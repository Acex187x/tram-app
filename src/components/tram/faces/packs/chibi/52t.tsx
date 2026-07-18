// Chibi 52T ForCity Plus — the WHITE tram with the glossy BLACK helmet visor.
// White/light-grey body; a big wrap-around black visor sweeps over the
// rounded roof corners and down the A-pillars, holding the amber LED
// destination band, the tall windscreen, and slim 3-element LED lights in
// its lower corners. Below: clean WHITE face with only small RED accents
// (central red number panel + tiny pid pill) and a LOW body-colored skirt —
// no bumper mass. Single-arm pantograph.
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';

import { C, VIEWBOX, type ChibiFaceProps } from './palette';

const VISOR = '#17161C'; // glossy black helmet
const BODYWHITE = '#F4F5F7';
const AMBER = '#FFA439';

const BODY =
  'M12.5 50.5 C12.5 53.4 14.5 54.5 17 54.5 L47 54.5 C49.5 54.5 51.5 53.4 51.5 50.5 L51.5 16.5 C51.5 10.8 48.3 8 43 8 L21 8 C15.7 8 12.5 10.8 12.5 16.5 Z';

// the black visor: full-width over the roof corners, bottom edge dips at center
const HELMET =
  'M12.5 16.5 C12.5 10.8 15.7 8 21 8 L43 8 C48.3 8 51.5 10.8 51.5 16.5 L51.5 39.2 C45.5 39.2 42 42.4 32 42.4 C22 42.4 18.5 39.2 12.5 39.2 Z';

export function Face({ size = 64 }: ChibiFaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      {/* ground shadow + wheels barely peeking under the low skirt */}
      <Ellipse cx={32} cy={60} rx={19.5} ry={2.2} fill={C.shadow} />
      <Circle cx={21} cy={54.5} r={3.6} fill={C.dark} />
      <Circle cx={43} cy={54.5} r={3.6} fill={C.dark} />
      {/* single-arm pantograph */}
      <Path
        d="M30 8 L36.5 3.8 M33.6 3.2 L39.8 3.2"
        stroke="#4A5566"
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
      {/* clean WHITE body */}
      <Path d={BODY} fill={BODYWHITE} />
      {/* glossy BLACK wrap-around visor helmet */}
      <Path d={HELMET} fill={VISOR} />
      {/* visor gloss streak */}
      <Path d="M16.6 14.6 Q18.4 12 21.4 10.6 L18.8 17.6 Q16.6 19 15.4 20.8 Z" fill={C.sparkle} opacity={0.13} />
      {/* amber LED destination band high in the visor */}
      <Rect x={19.5} y={10.8} width={3} height={2} rx={0.45} fill={AMBER} />
      <Rect x={24.5} y={11.2} width={11} height={1.3} rx={0.65} fill={AMBER} opacity={0.92} />
      <Rect x={37.5} y={11.2} width={6} height={1.3} rx={0.65} fill={AMBER} opacity={0.7} />
      {/* serene eyes inside the visor */}
      <Circle cx={25.5} cy={23.5} r={4.3} fill={C.sparkle} />
      <Circle cx={38.5} cy={23.5} r={4.3} fill={C.sparkle} />
      <Ellipse cx={25.9} cy={24.2} rx={2} ry={2.4} fill={C.pupil} />
      <Ellipse cx={38.1} cy={24.2} rx={2} ry={2.4} fill={C.pupil} />
      <Circle cx={25} cy={23.2} r={0.8} fill={C.sparkle} />
      <Circle cx={37.2} cy={23.2} r={0.8} fill={C.sparkle} />
      {/* soft blush + calm smile, inside the glass */}
      <Ellipse cx={20.8} cy={28.6} rx={2.2} ry={1.4} fill={C.blush} opacity={0.9} />
      <Ellipse cx={43.2} cy={28.6} rx={2.2} ry={1.4} fill={C.blush} opacity={0.9} />
      <Path d="M28.8 29.6 Q32 32.2 35.2 29.6" stroke={C.sparkle} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* slim 3-element LED lights in the visor's lower corners */}
      <Rect x={15.2} y={34.2} width={1.5} height={3.8} rx={0.7} fill={C.iceLed} />
      <Rect x={17.9} y={34.6} width={1.5} height={3.8} rx={0.7} fill={C.iceLed} />
      <Rect x={20.6} y={35} width={1.5} height={3.8} rx={0.7} fill={C.iceLed} />
      <Rect x={47.3} y={34.2} width={1.5} height={3.8} rx={0.7} fill={C.iceLed} />
      <Rect x={44.6} y={34.6} width={1.5} height={3.8} rx={0.7} fill={C.iceLed} />
      <Rect x={41.9} y={35} width={1.5} height={3.8} rx={0.7} fill={C.iceLed} />
      {/* central RED number panel on the white chin (pid livery) */}
      <Rect x={28.9} y={44.6} width={6.2} height={9.9} fill={C.red} />
      <Circle cx={32} cy={48.2} r={1.3} fill={C.sparkle} opacity={0.95} />
      {/* tiny red pid pill at the left */}
      <Rect x={18} y={46.8} width={5} height={2} rx={1} fill={C.red} />
      {/* LOW body-colored skirt: just a seam, no bumper mass */}
      <Line x1={13.5} y1={51.5} x2={28.9} y2={51.5} stroke="#B9BDC4" strokeWidth={1} />
      <Line x1={35.1} y1={51.5} x2={50.5} y2={51.5} stroke="#B9BDC4" strokeWidth={1} />
      {/* thick storybook silhouette */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={2.2} />
    </Svg>
  );
}
