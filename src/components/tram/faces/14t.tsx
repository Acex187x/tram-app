// Škoda 14T "Elektra" (Porsche Design) — the sporty one. Smooth silver
// helmet framed by bold DPP-red flanks sweeping up the sides, one big raked
// wrap-around visor with tilted narrow glints (the smirk), a parked wiper
// hanging from the glass top, two recessed dark headlight pods each stacking
// three little lamps (amber on top), green LED display, black mirror "ears",
// bright red skirt. Yellow-armed single-arm pantograph. Expression: дерзкая.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { FACE_COLORS as C, FACE_VIEWBOX, type FaceProps } from './common';

const SILVER = '#C7CACF';
const DPP_RED = '#C22420';

const BODY =
  'M14 57 L14 32 C14 16.5 21 10.5 32 10.5 C43 10.5 50 16.5 50 32 L50 57 Q50 60 47 60 L17 60 Q14 60 14 57 Z';

export function Face14T({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX}>
      {/* yellow single-arm pantograph */}
      <Path
        d="M31 10 L39.5 5.2 M36.4 4.6 L42.6 4.6"
        stroke="#D9A31B"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* black mirrors at the A-pillars — little ears */}
      <Rect x={11} y={24.6} width={3.2} height={4.6} rx={1.4} fill="#1B1D20" />
      <Rect x={49.8} y={24.6} width={3.2} height={4.6} rx={1.4} fill="#1B1D20" />
      {/* smooth silver helmet */}
      <Path d={BODY} fill={SILVER} />
      {/* bold red flanks sweeping up the sides — the Elektra energy */}
      <Path d="M14 34 Q17.6 37.5 18.6 44 L18.6 60 L14 60 Z" fill={DPP_RED} />
      <Path d="M50 34 Q46.4 37.5 45.4 44 L45.4 60 L50 60 Z" fill={DPP_RED} />
      {/* one-piece raked wrap-around visor, slightly narrowed at the top */}
      <Path
        d="M18 34.6 L18 24.6 C18 17.2 24 14.4 32 14.4 C40 14.4 46 17.2 46 24.6 L46 34.6 Q46 36.6 44 36.6 L20 36.6 Q18 36.6 18 34.6 Z"
        fill={C.glass}
      />
      {/* green LED destination behind the glass top */}
      <Rect x={25} y={16.4} width={14} height={2.6} rx={1.1} fill="#0C0F12" />
      <Rect x={26.8} y={17.2} width={5.2} height={1.1} rx={0.55} fill={C.ledGreen} />
      <Rect x={33.4} y={17.2} width={3.8} height={1.1} rx={0.55} fill={C.ledGreen} opacity={0.7} />
      {/* tilted narrow glints — the smirk */}
      <Rect
        x={20.9}
        y={22.2}
        width={4.4}
        height={10}
        rx={2.2}
        fill={C.glint}
        opacity={0.42}
        transform="rotate(-16 23.1 27.2)"
      />
      <Rect
        x={38.7}
        y={22.2}
        width={4.4}
        height={10}
        rx={2.2}
        fill={C.glint}
        opacity={0.42}
        transform="rotate(-16 40.9 27.2)"
      />
      {/* wiper parked hanging from the glass top */}
      <Path
        d="M35.4 19.6 L37.8 26.4"
        stroke="#0F1215"
        strokeWidth={0.9}
        strokeLinecap="round"
        fill="none"
      />
      {/* recessed dark headlight pods, three stacked lamps (amber on top) */}
      <Rect x={20.2} y={38.6} width={4.8} height={9.4} rx={2.4} fill="#191C20" />
      <Rect x={39} y={38.6} width={4.8} height={9.4} rx={2.4} fill="#191C20" />
      <Circle cx={22.6} cy={40.9} r={1.15} fill={C.amber} />
      <Circle cx={22.6} cy={43.6} r={1.15} fill="#EDF1F5" />
      <Circle cx={22.6} cy={46.3} r={1.15} fill="#EDF1F5" />
      <Circle cx={41.4} cy={40.9} r={1.15} fill={C.amber} />
      <Circle cx={41.4} cy={43.6} r={1.15} fill="#EDF1F5" />
      <Circle cx={41.4} cy={46.3} r={1.15} fill="#EDF1F5" />
      {/* Škoda winged-arrow roundel between the pods */}
      <Circle cx={32} cy={42.8} r={1.9} fill="none" stroke="#2E7D4F" strokeWidth={1} />
      {/* bumper seam — low confident mouth */}
      <Path
        d="M21 51.6 Q32 53.2 43 51.6"
        stroke="#8F949B"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* bright red skirt band + dark under-lip */}
      <Rect x={18.6} y={55} width={26.8} height={3.1} rx={1.4} fill={DPP_RED} />
      <Rect x={20} y={58.4} width={24} height={1.4} rx={0.7} fill={C.charcoal} />
      {/* crisp silhouette re-stroked over the livery */}
      <Path d={BODY} fill="none" stroke={C.outline} strokeWidth={1.6} />
    </Svg>
  );
}
