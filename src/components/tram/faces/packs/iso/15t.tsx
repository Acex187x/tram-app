// Škoda 15T ForCity Alfa — the sloped-face one (ref 9389/9209): a huge raked
// glossy BLACK windscreen dome wrapping the crown, framed by a RED brow and
// red A-pillar edges, a WHITE band under the glass carrying the lamp pods and
// the badge, and a deep RED bumper with white DRL dashes. The flank is white
// with a continuous BLACK glazing band, RED full-height doors and a RED skirt
// sweep. Single-arm pantograph over the rear.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { F, fQuad, ISO, isoBox, LONG_W, P, poly, R, rQuad, S, singleArm, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const WHITE_F = '#F2F3F1';
const WHITE_S = '#D2D5D3';
const BLACK_GLAZE = '#1B1E24';

// Soft-shouldered slab with a domed crown (the rake lives in the black glass).
const FRONT_BODY = `M${f(0, 0.07)} L${f(1, 0.07)} L${f(1, 0.78)} Q${f(1, 1.04)} ${f(0.7, 1.02)} L${f(0.3, 1.02)} Q${f(0, 1.04)} ${f(0, 0.78)} Z`;
const SIDE_BODY = `M${s(0, 0.07)} L${s(0.99, 0.07)} Q${s(1.03, 0.52)} ${s(0.99, 1)} L${s(0, 1)} Z`;
// The black windscreen dome: rounded shoulders rolling into the crown.
const SCREEN = `M${f(0.07, 0.42)} L${f(0.93, 0.42)} L${f(0.93, 0.72)} Q${f(0.93, 0.98)} ${f(0.68, 0.98)} L${f(0.32, 0.98)} Q${f(0.07, 0.98)} ${f(0.07, 0.72)} Z`;
// Red brow cap over the crown.
const BROW = `M${f(0, 0.93)} L${f(1, 0.93)} Q${f(1, 1.04)} ${f(0.7, 1.02)} L${f(0.3, 1.02)} Q${f(0, 1.04)} ${f(0, 0.93)} Z`;

const panto = singleArm(R(b, 0.5, 0.68));

/** Oval lamp pod set into the white band. */
function LampPod({ u }: { u: number }) {
  return (
    <>
      <Path d={fQuad(b, u, 0.28, u + 0.2, 0.37)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinejoin="round" />
      <Circle cx={F(b, u + 0.06, 0.325)[0]} cy={F(b, u + 0.06, 0.325)[1]} r={1.5} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.6} />
      <Circle cx={F(b, u + 0.14, 0.325)[0]} cy={F(b, u + 0.14, 0.325)[1]} r={1.5} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.6} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      {/* low underframe */}
      <Path d={fQuad(b, 0.04, -0.02, 0.96, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.005, -0.02, 0.98, 0.07)} fill={ISO.under} />
      {/* roof: red cap over the cab, grey equipment spine behind */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#B9BDC2" stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={rQuad(b, 0, 0, 1, 0.09)} fill={ISO.redRoof} />
      <Path d={rQuad(b, 0.28, 0.2, 0.74, 0.32)} fill={ISO.charcoal} stroke={ISO.under} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.44, 0.74, 0.56)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.76, 0.74, 0.88)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={panto.arm} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={panto.bar} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* flank: white body, BLACK glazing band, RED doors, RED skirt sweep */}
      <Path d={SIDE_BODY} fill={WHITE_S} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.07, 0.99, 0.17)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.5, 0.99, 0.86)} fill={BLACK_GLAZE} />
      {/* red roofline stripe */}
      <Path d={sQuad(b, 0, 0.94, 0.99, 1)} fill={ISO.redSide} />
      {/* RED full-height double doors cutting through the black band */}
      {[0.1, 0.38, 0.66].map((u) => (
        <Path key={u} d={sQuad(b, u, 0.08, u + 0.085, 0.86)} fill={ISO.redSide} />
      ))}
      {[0.1, 0.38, 0.66].map((u) => (
        <Path key={u} d={sQuad(b, u + 0.015, 0.16, u + 0.07, 0.84)} fill={ISO.glassDoor} />
      ))}
      {/* faint window separators in the black glazing */}
      {[0.28, 0.56, 0.84].map((u) => (
        <Line
          key={u}
          x1={S(b, u, 0.53)[0]}
          y1={S(b, u, 0.53)[1]}
          x2={S(b, u, 0.84)[0]}
          y2={S(b, u, 0.84)[1]}
          stroke="#2E323A"
          strokeWidth={0.8}
        />
      ))}
      {/* two articulation joints */}
      <Path d={sQuad(b, 0.31, 0.08, 0.325, 0.92)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.59, 0.08, 0.605, 0.92)} fill={ISO.under} opacity={0.85} />
      {/* front */}
      <Path d={FRONT_BODY} fill={WHITE_F} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* deep RED bumper with white DRL dashes */}
      <Path d={fQuad(b, 0, 0.05, 1, 0.26)} fill={ISO.red} />
      <Path d={fQuad(b, 0.07, 0.12, 0.25, 0.18)} fill="#F2F6F9" />
      <Path d={fQuad(b, 0.75, 0.12, 0.93, 0.18)} fill="#F2F6F9" />
      {/* red A-pillar edges framing the black glass */}
      <Path d={fQuad(b, 0, 0.42, 0.08, 0.95)} fill={ISO.red} />
      <Path d={fQuad(b, 0.92, 0.42, 1, 0.95)} fill={ISO.red} />
      {/* the huge raked BLACK windscreen dome + red brow */}
      <Path d={SCREEN} fill={BLACK_GLAZE} stroke={BLACK_GLAZE} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={BROW} fill={ISO.red} />
      <Path d={poly(F(b, 0.56, 0.45), F(b, 0.7, 0.45), F(b, 0.46, 0.95), F(b, 0.34, 0.95))} fill={ISO.glint} opacity={0.2} />
      <Circle cx={F(b, 0.78, 0.85)[0]} cy={F(b, 0.78, 0.85)[1]} r={1.1} fill={ISO.glint} opacity={0.7} />
      {/* amber route LED at the top of the glass */}
      <Path d={fQuad(b, 0.32, 0.83, 0.68, 0.89)} fill={ISO.ledOrange} opacity={0.92} />
      {/* white band under the glass with the lamp pods */}
      <LampPod u={0.1} />
      <LampPod u={0.7} />
    </Svg>
  );
}
