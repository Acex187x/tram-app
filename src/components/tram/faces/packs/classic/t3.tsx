// Tatra T3 — the 1960s icon. One soft convex 'bathtub' egg, huge wrap-around
// curved windscreen, and the classic tell: a small NARROW route-number box
// centered above the glass (NOT full-width — that's the modernized variants).
// Two bulbous chrome-ringed round headlights sit low in the red band; thin
// chrome trim line at the belt, gentle chrome bumper smile. Red scissor
// pantograph. Expression: the kind old-timer.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const BODY =
  'M12.5 56 L12.5 30 C12.5 15 20 9 32 9 C44 9 51.5 15 51.5 30 L51.5 56 Q51.5 60 47.5 60 L16.5 60 Q12.5 60 12.5 56 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* red scissor pantograph */}
      <Path
        d="M25 8.6 L33.5 4.2 M39 8.6 L30.5 4.2 M27.6 3.6 L36.4 3.6"
        stroke="#A8261F"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* soft convex egg body */}
      <Path d={BODY} fill={P.cream} />
      {/* NARROW route-number box centered in the cream brow — the classic-T3 tell */}
      <Rect x={26.8} y={11.7} width={10.4} height={4.2} rx={1.1} fill="#17130F" />
      <Rect x={28.9} y={12.9} width={2.3} height={1.9} rx={0.4} fill="#F8F3E5" />
      <Rect x={32.8} y={12.9} width={2.3} height={1.9} rx={0.4} fill="#F8F3E5" />
      {/* wrap-around curved windscreen — glass follows the egg curve */}
      <Path
        d="M15.6 32.8 L15.6 24.6 C15.6 19.2 22 16.9 32 16.9 C42 16.9 48.4 19.2 48.4 24.6 L48.4 32.8 Q48.4 34.8 46.4 34.8 L17.6 34.8 Q15.6 34.8 15.6 32.8 Z"
        fill={P.glass}
      />
      {/* hairline center gasket seam */}
      <Line x1={32} y1={17.1} x2={32} y2={34.7} stroke="#8E2A22" strokeWidth={0.7} />
      {/* soft round eye-glints, one per pane */}
      <Rect x={19.8} y={19.8} width={5.6} height={9.8} rx={2.8} fill={P.glint} opacity={0.45} />
      <Rect x={38.6} y={19.8} width={5.6} height={9.8} rx={2.8} fill={P.glint} opacity={0.45} />
      <Circle cx={22.6} cy={22.3} r={1.15} fill={P.glint} opacity={0.85} />
      <Circle cx={41.4} cy={22.3} r={1.15} fill={P.glint} opacity={0.85} />
      {/* red band — belt dips at the cab corners, cream widens mid-face */}
      <Path
        d="M12.5 38.6 Q32 41.8 51.5 38.6 L51.5 56 Q51.5 60 47.5 60 L16.5 60 Q12.5 60 12.5 56 Z"
        fill={P.red}
      />
      {/* thin chrome trim line riding the belt curve */}
      <Path
        d="M13.4 38.9 Q32 42 50.6 38.9"
        stroke={P.chrome}
        strokeWidth={0.9}
        strokeLinecap="round"
        fill="none"
        opacity={0.9}
      />
      {/* twin bulbous chrome-ring headlights, set LOW on the curved nose */}
      <Circle cx={22.5} cy={47.6} r={3.4} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.5} />
      <Circle cx={41.5} cy={47.6} r={3.4} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.5} />
      <Circle cx={21.5} cy={46.6} r={0.95} fill={P.glint} opacity={0.9} />
      <Circle cx={40.5} cy={46.6} r={0.95} fill={P.glint} opacity={0.9} />
      {/* gold fleet number between the lamps */}
      <Rect x={29.3} y={46.8} width={5.4} height={1.9} rx={0.9} fill={P.gold} opacity={0.95} />
      {/* chrome bumper — the gentle smile */}
      <Path
        d="M16 53.2 Q32 55.8 48 53.2"
        stroke={P.chrome}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      {/* deep maroon lip + underframe shadow */}
      <Rect x={15} y={56.4} width={34} height={1.5} fill={P.redDeep} opacity={0.9} />
      <Rect x={16.5} y={58.1} width={31} height={1.5} rx={0.75} fill="#4A3F35" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
