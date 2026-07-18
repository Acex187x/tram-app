// Škoda 14T "Elektra" — the Porsche-designed one. Smooth one-piece rounded
// mask; steeply raked windscreen whose rounded top corners BLEND into the
// roofline; round lamp clusters recessed low into the curved mask; no front
// door. Cream upper, red lower front, grey skirt. Tilted glints keep the
// signature smirk. Yellow single-arm pantograph. Expression: sporty, sleek.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const POD = '#1A1D21';

const BODY =
  'M13.5 56.5 L13.5 30 C13.5 15.4 21 9.8 32 9.8 C43 9.8 50.5 15.4 50.5 30 L50.5 56.5 Q50.5 60 47 60 L17 60 Q13.5 60 13.5 56.5 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* yellow single-arm pantograph */}
      <Path
        d="M31 9.4 L39.5 4.8 M36.4 4.2 L42.6 4.2"
        stroke="#D9A31B"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* black mirror ears at the A-pillars */}
      <Rect x={10.8} y={24.4} width={3.2} height={4.6} rx={1.4} fill="#1B1D20" />
      <Rect x={50} y={24.4} width={3.2} height={4.6} rx={1.4} fill="#1B1D20" />
      {/* smooth one-piece rounded mask */}
      <Path d={BODY} fill={P.cream} />
      {/* steeply raked windscreen, top corners rounding into the roofline */}
      <Path
        d="M17.3 34.2 L17.3 24 C17.3 16.4 23.4 13.2 32 13.2 C40.6 13.2 46.7 16.4 46.7 24 L46.7 34.2 Q46.7 36.4 44.5 36.4 L19.5 36.4 Q17.3 36.4 17.3 34.2 Z"
        fill={P.glass}
      />
      {/* orange LED destination glowing behind the glass top */}
      <Rect x={24.6} y={15.4} width={14.8} height={2.7} rx={1.1} fill="#0C0F12" />
      <Rect x={26.4} y={16.3} width={5.4} height={1.1} rx={0.55} fill={P.ledOrange} />
      <Rect x={33.2} y={16.3} width={4} height={1.1} rx={0.55} fill={P.ledOrange} opacity={0.7} />
      {/* tilted narrow glints — the smirk */}
      <Rect
        x={20.8}
        y={21.6}
        width={4.6}
        height={10.4}
        rx={2.3}
        fill={P.glint}
        opacity={0.44}
        transform="rotate(-15 23.1 26.8)"
      />
      <Rect
        x={38.6}
        y={21.6}
        width={4.6}
        height={10.4}
        rx={2.3}
        fill={P.glint}
        opacity={0.44}
        transform="rotate(-15 40.9 26.8)"
      />
      <Circle cx={24.4} cy={23.6} r={1} fill={P.glint} opacity={0.8} />
      <Circle cx={42.2} cy={23.6} r={1} fill={P.glint} opacity={0.8} />
      {/* parked wiper hanging from the glass top */}
      <Path
        d="M35.6 18.6 L38 25.6"
        stroke="#0F1215"
        strokeWidth={0.9}
        strokeLinecap="round"
        fill="none"
      />
      {/* red lower front with a gentle upswept top edge */}
      <Path
        d="M13.5 40 Q32 38 50.5 40 L50.5 55.2 L13.5 55.2 Z"
        fill={P.red}
      />
      {/* round lamp clusters recessed LOW into the curved mask */}
      <Circle cx={21.8} cy={46.8} r={3.9} fill={POD} />
      <Circle cx={42.2} cy={46.8} r={3.9} fill={POD} />
      <Circle cx={21} cy={45.9} r={1.5} fill="#EDF1F5" />
      <Circle cx={41.4} cy={45.9} r={1.5} fill="#EDF1F5" />
      <Circle cx={23.1} cy={48.3} r={1.1} fill={P.amber} />
      <Circle cx={43.5} cy={48.3} r={1.1} fill={P.amber} />
      {/* Škoda winged-arrow roundel between the pods */}
      <Circle cx={32} cy={46.8} r={1.8} fill="none" stroke="#2E7D4F" strokeWidth={1} />
      {/* cream reg plate under the roundel */}
      <Rect x={28.8} y={50.6} width={6.4} height={2.2} rx={0.7} fill="#F2ECDD" />
      {/* grey skirt — the Elektra's low hem */}
      <Rect x={15} y={55.2} width={34} height={3.2} rx={1.4} fill={P.silverDark} />
      {/* dark under-lip */}
      <Rect x={17} y={58.6} width={30} height={1.4} rx={0.7} fill={P.charcoal} />
      {/* crisp silhouette re-stroked over the livery */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
