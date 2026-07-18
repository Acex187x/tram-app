// Škoda 52T ForCity Plus Praha — Red Dot 2025, the glassiest face in the
// fleet. CORRECTED proportions: one very TALL upright windscreen dominates
// ~70% of the face — glass starts just above the low skirt and sweeps up
// into the roofline — framed by a thin black mask. Slim horizontal LED
// daytime-running strips flank the LOWER part of the glass. Below: a LOW,
// SMALL body-colored skirt hugging the rails — NO protruding bumper mass.
// White body with PID-red stripe accents, full-width LED destination at top.
// Expression: serene, minimal, premium.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { P, VB, type FaceProps } from './palette';

const BODY_WHITE = '#F4F2EE';
const MASK = '#101317';
const GLASS_52 = '#212B36';

const BODY =
  'M15 56.5 L15 14.5 Q15 10 20 10 L44 10 Q49 10 49 14.5 L49 56.5 Q49 59.5 45.5 59.5 L18.5 59.5 Q15 59.5 15 56.5 Z';

export function Face({ size = 64 }: FaceProps) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* low-profile single-arm pantograph */}
      <Path
        d="M32 9.6 L39.5 5.4 M36.6 4.8 L42.4 4.8"
        stroke="#9DA2A8"
        strokeWidth={1.3}
        strokeLinecap="round"
        fill="none"
      />
      {/* clean upright white body, flat modern roofline */}
      <Path d={BODY} fill={BODY_WHITE} />
      {/* full-width LED destination band at the roofline */}
      <Rect x={16.6} y={11.6} width={30.8} height={3.6} rx={1.2} fill={MASK} />
      <Rect x={19} y={12.8} width={8.4} height={1.3} rx={0.65} fill={P.amber} />
      <Rect x={29.4} y={12.8} width={12.6} height={1.3} rx={0.65} fill={P.amber} opacity={0.72} />
      {/* thin black mask framing the windscreen — sweeps up into the roofline */}
      <Path
        d="M17.2 50.2 L17.2 20 Q17.2 16.4 20.8 16.4 L43.2 16.4 Q46.8 16.4 46.8 20 L46.8 50.2 Z"
        fill={MASK}
      />
      {/* the TALL windscreen — one glass panel, ~70% of the face height */}
      <Path
        d="M19.2 48.4 L19.2 21 Q19.2 18.4 21.8 18.4 L42.2 18.4 Q44.8 18.4 44.8 21 L44.8 48.4 Z"
        fill={GLASS_52}
      />
      {/* tall calm glints running most of the glass height */}
      <Rect x={22.4} y={21.6} width={5} height={16.4} rx={2.5} fill={P.glint} opacity={0.4} />
      <Rect x={36.6} y={21.6} width={5} height={16.4} rx={2.5} fill={P.glint} opacity={0.4} />
      <Circle cx={24.9} cy={24.4} r={1.05} fill={P.glint} opacity={0.85} />
      <Circle cx={39.1} cy={24.4} r={1.05} fill={P.glint} opacity={0.85} />
      {/* slim horizontal LED DRL strips flanking the LOWER windscreen */}
      <Rect x={20.6} y={44.2} width={8.2} height={1.8} rx={0.9} fill="#FFFFFF" />
      <Rect x={35.2} y={44.2} width={8.2} height={1.8} rx={0.9} fill="#FFFFFF" />
      {/* small Škoda roundel between the light strips */}
      <Circle cx={32} cy={45.1} r={1.4} fill="none" stroke="#3D8B57" strokeWidth={0.9} />
      {/* PID-red stripe accent across the white below the glass */}
      <Rect x={15} y={52} width={34} height={1.9} fill={P.pidRed} />
      {/* red pid chip (left) + grey fleet number (right) on the white */}
      <Rect x={17.6} y={55} width={4.8} height={1.8} rx={0.9} fill={P.pidRed} />
      <Rect x={41.6} y={55} width={4.8} height={1.8} rx={0.9} fill="#B9BDC4" />
      {/* LOW, SMALL skirt: body-colored, just a thin shadow line at the rails */}
      <Rect x={17.4} y={57.7} width={29.2} height={1.2} rx={0.6} fill="#3F444A" />
      {/* crisp silhouette re-stroked over the livery */}
      <Path d={BODY} fill="none" stroke={P.outline} strokeWidth={1.6} />
    </Svg>
  );
}
