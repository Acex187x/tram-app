// Škoda 15T ForCity Alfa — the sloped-face one (ref 9389). THE SHAPE: above a
// short red bumper and the white lamp band the ENTIRE face is one huge glossy
// BLACK windscreen leaning hard backwards (6.5px of rake), and the crown
// ROLLS OVER the top so the glass visibly spills onto the roof — no vertical
// slab anywhere above the beltline. Flank: white with a continuous black
// glazing band, RED full-height doors, red skirt + red roofline stripe.
// Single-arm pantograph over the rear.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { F, fQuad, ISO, isoBox, LONG_W, N3, P, poly, S, singleArm, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const np = (a: number, d: number, z: number) => P(N3(b, a, d, z));

const WHITE_F = '#F2F3F1';
const WHITE_S = '#D2D5D3';
const BLACK_GLAZE = '#1B1E24';

// Nose profile: vertical to z 0.30 (bumper + lamp band), then the big rake to
// 7.5px at z 0.88, rounding over a WIDE crown to the roof edge 11px back.
const noseD = (z: number): number => (z <= 0.3 ? 0 : (7.5 * (z - 0.3)) / 0.58);
const GP = (a: number, z: number) => N3(b, a, noseD(z), z);
const gp = (a: number, z: number) => P(GP(a, z));

const FRONT_BODY = `M${np(0, 0, 0.06)} Q${np(0.5, -1.2, 0.06)} ${np(1, 0, 0.06)} L${np(1, 0, 0.3)} L${np(1, 7.5, 0.88)} Q${np(1, 10.2, 1)} ${np(0.82, 11, 1)} L${np(0.18, 11, 1)} Q${np(0, 10.2, 1)} ${np(0, 7.5, 0.88)} L${np(0, 0, 0.3)} Z`;
const SIDE_BODY = `M${np(0, 0, 0.06)} L${np(0, 37.4, 0.06)} Q${np(0, 39.5, 0.5)} ${np(0, 37.2, 1)} L${np(0, 11, 1)} Q${np(0, 10.2, 1)} ${np(0, 7.5, 0.88)} L${np(0, 0, 0.3)} Z`;
const ROOF = `M${np(0, 10.8, 1)} L${np(1, 10.8, 1)} L${np(1, 37, 1)} L${np(0, 37.2, 1)} Z`;
// The glass DOME: lies on the rake, rolls over the crown with the body,
// bowed lower edge (the windscreen is curved in plan).
const DOME = `M${gp(0.07, 0.37)} Q${np(0.5, noseD(0.37) - 1.1, 0.37)} ${gp(0.93, 0.37)} L${gp(0.93, 0.86)} Q${np(0.93, 10, 0.99)} ${np(0.78, 10.9, 1)} L${np(0.22, 10.9, 1)} Q${np(0.07, 10, 0.99)} ${gp(0.07, 0.86)} Z`;
// ...and spills onto the roof as a black front strip.
const DOME_ROOF = `M${np(0.16, 10.9, 1)} L${np(0.84, 10.9, 1)} L${np(0.86, 14, 1)} L${np(0.14, 14, 1)} Z`;

const panto = singleArm(N3(b, 0.5, 26, 1));

/** Oval lamp pod set into the white band. */
function LampPod({ u }: { u: number }) {
  return (
    <>
      <Path d={fQuad(b, u, 0.2, u + 0.2, 0.29)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinejoin="round" />
      <Circle cx={F(b, u + 0.06, 0.245)[0]} cy={F(b, u + 0.06, 0.245)[1]} r={1.5} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.6} />
      <Circle cx={F(b, u + 0.14, 0.245)[0]} cy={F(b, u + 0.14, 0.245)[1]} r={1.5} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.6} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      {/* low underframe */}
      <Path d={fQuad(b, 0.04, -0.02, 0.96, 0.06)} fill={ISO.under} />
      <Path d={sQuad(b, 0.005, -0.02, 0.98, 0.06)} fill={ISO.under} />
      {/* roof: grey equipment spine behind the black dome strip */}
      <Path d={ROOF} fill="#B9BDC2" stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.28, 15, 1), N3(b, 0.74, 15, 1), N3(b, 0.74, 19, 1), N3(b, 0.28, 19, 1))} fill={ISO.charcoal} stroke={ISO.under} strokeWidth={0.8} />
      <Path d={poly(N3(b, 0.28, 21.5, 1), N3(b, 0.74, 21.5, 1), N3(b, 0.74, 25.5, 1), N3(b, 0.28, 25.5, 1))} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={poly(N3(b, 0.28, 30, 1), N3(b, 0.74, 30, 1), N3(b, 0.74, 34, 1), N3(b, 0.28, 34, 1))} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={panto.arm} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={panto.bar} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* flank: white body, BLACK glazing band, RED doors, red skirt + roofline */}
      <Path d={SIDE_BODY} fill={WHITE_S} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.05, 0.06, 0.98, 0.16)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0.28, 0.5, 0.98, 0.86)} fill={BLACK_GLAZE} />
      <Path d={sQuad(b, 0.28, 0.94, 0.98, 1)} fill={ISO.redSide} />
      {/* cab side window tucked under the rake (slanted top edge) */}
      <Path d={poly(N3(b, 0, 4, 0.5), N3(b, 0, 8.5, 0.5), N3(b, 0, 8.5, 0.84), N3(b, 0, 4, 0.59))} fill={ISO.glassSide} />
      {/* RED full-height double doors cutting through the black band */}
      {[0.24, 0.5, 0.76].map((u) => (
        <Path key={u} d={sQuad(b, u, 0.07, u + 0.085, 0.86)} fill={ISO.redSide} />
      ))}
      {[0.24, 0.5, 0.76].map((u) => (
        <Path key={u} d={sQuad(b, u + 0.015, 0.16, u + 0.07, 0.84)} fill={ISO.glassDoor} />
      ))}
      {/* faint window separators in the black glazing */}
      {[0.42, 0.68, 0.92].map((u) => (
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
      <Path d={sQuad(b, 0.365, 0.07, 0.38, 0.92)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.63, 0.07, 0.645, 0.92)} fill={ISO.under} opacity={0.85} />
      {/* front — white shell, all slope above the beltline */}
      <Path d={FRONT_BODY} fill={WHITE_F} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* deep RED bumper with white DRL dashes (bowed with the nose) */}
      <Path d={`M${P(N3(b, 0, 0, 0.05))} Q${P(N3(b, 0.5, -1.2, 0.05))} ${P(N3(b, 1, 0, 0.05))} L${P(N3(b, 1, 0, 0.18))} Q${P(N3(b, 0.5, -1.2, 0.18))} ${P(N3(b, 0, 0, 0.18))} Z`} fill={ISO.red} />
      <Path d={poly(N3(b, 0.07, -0.6, 0.09), N3(b, 0.25, -0.6, 0.09), N3(b, 0.25, -0.6, 0.14), N3(b, 0.07, -0.6, 0.14))} fill="#F2F6F9" />
      <Path d={poly(N3(b, 0.75, -0.6, 0.09), N3(b, 0.93, -0.6, 0.09), N3(b, 0.93, -0.6, 0.14), N3(b, 0.75, -0.6, 0.14))} fill="#F2F6F9" />
      {/* the huge raked BLACK dome rolling over the crown */}
      <Path d={DOME} fill={BLACK_GLAZE} stroke={BLACK_GLAZE} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={DOME_ROOF} fill={BLACK_GLAZE} />
      <Path d={poly(GP(0.56, 0.42), GP(0.7, 0.42), GP(0.46, 0.9), GP(0.34, 0.9))} fill={ISO.glint} opacity={0.2} />
      <Circle cx={GP(0.78, 0.82)[0]} cy={GP(0.78, 0.82)[1]} r={1.1} fill={ISO.glint} opacity={0.7} />
      {/* amber route LED high in the glass */}
      <Path d={poly(GP(0.34, 0.8), GP(0.66, 0.8), GP(0.66, 0.86), GP(0.34, 0.86))} fill={ISO.ledOrange} opacity={0.92} />
      {/* white band under the glass with the lamp pods */}
      <LampPod u={0.1} />
      <LampPod u={0.7} />
    </Svg>
  );
}
