// Tatra T3R.P — the modernized T3 workhorse. Same original egg shell as the
// T3, but the number-one differentiator: a FULL-WIDTH orange dot-matrix LED
// destination band across the roofline replacing the narrow number box.
// Round chrome headlights with small rectangular amber turn signals beside
// them, modern black plastic bumper strip, yellow scissor pantograph.
// Expression: the focused shift-worker — straighter mouth, narrower glints.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const PANTO_YELLOW = '#E3B71F';

const BODY =
  'M12.5 56 L12.5 30 C12.5 15 20 9 32 9 C44 9 51.5 15 51.5 30 L51.5 56 Q51.5 60 47.5 60 L16.5 60 Q12.5 60 12.5 56 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* yellow scissor pantograph */}
      <Path
        d="M25 8.6 L33.5 4.2 M39 8.6 L30.5 4.2 M27.6 3.6 L36.4 3.6"
        stroke={PANTO_YELLOW}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* same original T3 egg shell */}
      <Path d={BODY} fill={P.cream} />
      {/* FULL-WIDTH orange dot-matrix destination band — the modernization tell */}
      <Rect x={16.6} y={11.9} width={30.8} height={4.3} rx={1.4} fill="#101317" />
      <Rect x={19} y={13.3} width={8.2} height={1.4} rx={0.7} fill={P.ledOrange} />
      <Rect x={29.4} y={13.3} width={13.2} height={1.4} rx={0.7} fill={P.ledOrange} opacity={0.72} />
      {/* two-piece wrap-around windscreen with a dark center seam */}
      <Path
        d="M15.6 32.8 L15.6 25 C15.6 19.8 22 17.5 32 17.5 C42 17.5 48.4 19.8 48.4 25 L48.4 32.8 Q48.4 34.8 46.4 34.8 L17.6 34.8 Q15.6 34.8 15.6 32.8 Z"
        fill={P.glass}
      />
      <Line x1={32} y1={17.7} x2={32} y2={34.7} stroke="#11151A" strokeWidth={1.1} />
      {/* narrower business-like glints */}
      <Rect x={20.2} y={20.4} width={4.4} height={9.2} rx={2.2} fill={P.glint} opacity={0.42} />
      <Rect x={39.4} y={20.4} width={4.4} height={9.2} rx={2.2} fill={P.glint} opacity={0.42} />
      <Circle cx={22.4} cy={22.6} r={0.95} fill={P.glint} opacity={0.8} />
      <Circle cx={41.6} cy={22.6} r={0.95} fill={P.glint} opacity={0.8} />
      {/* red band, straight refit top edge (no retro sweep) */}
      <Path
        d="M12.5 38.2 L51.5 38.2 L51.5 56 Q51.5 60 47.5 60 L16.5 60 Q12.5 60 12.5 56 Z"
        fill={P.red}
      />
      {/* round chrome-ring headlights */}
      <Circle cx={22.8} cy={44.6} r={3.2} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.4} />
      <Circle cx={41.2} cy={44.6} r={3.2} fill={P.warmLens} stroke={P.chrome} strokeWidth={1.4} />
      <Circle cx={21.9} cy={43.7} r={0.85} fill={P.glint} opacity={0.9} />
      <Circle cx={40.3} cy={43.7} r={0.85} fill={P.glint} opacity={0.9} />
      {/* small rectangular amber turn signals at the outer corners */}
      <Rect x={15.2} y={43.2} width={3.2} height={2.8} rx={0.7} fill={P.amber} />
      <Rect x={45.6} y={43.2} width={3.2} height={2.8} rx={0.7} fill={P.amber} />
      {/* white number plate under the glass */}
      <Rect x={28.3} y={47} width={7.4} height={2.4} rx={0.7} fill="#F2ECDD" />
      <Rect x={29.6} y={48} width={4.8} height={0.6} rx={0.3} fill={P.redDeep} opacity={0.85} />
      {/* modern black plastic bumper strip — the steady straight mouth */}
      <Rect x={14.2} y={51.8} width={35.6} height={2.7} rx={1.35} fill="#26292E" />
      {/* cream chin below, thin underframe shadow */}
      <Rect x={16.5} y={58.1} width={31} height={1.5} rx={0.75} fill="#4A3F35" />
      {/* crisp silhouette re-stroked over the livery bands */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
