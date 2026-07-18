// Škoda 14T Elektra — the Porsche-designed WEDGE (ref 9122). THE SHAPE: from
// a short vertical bumper zone the whole face RAKES hard backwards — 7px of
// setback over three quarters of the body height — in one clean Porsche
// slope, with a big dark windscreen lying ON that slope and a gently rounded
// crown. SILVER cab ends on a long RED five-section body, silver roofline
// band + skirt, four articulation joints, single-arm pantograph.
import Svg, { Circle, Path } from 'react-native-svg';

import { F, fQuad, ISO, isoBox, LONG_W, N3, P, poly, singleArm, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const np = (a: number, d: number, z: number) => P(N3(b, a, d, z));

const SILVER_F = '#D7DADF';
const SILVER_S = '#AFB3BA';

// Nose profile: vertical bumper zone to z 0.24, then the WEDGE — a straight
// hard rake to 8px at z 0.97, rolling over a small crown to the roof at 9.5px.
const noseD = (z: number): number => (z <= 0.24 ? 0 : (8 * (z - 0.24)) / 0.73);
const WP = (a: number, z: number) => N3(b, a, noseD(z), z);
const wp = (a: number, z: number) => P(WP(a, z));

const FRONT_BODY = `M${np(0, 0, 0.07)} Q${np(0.5, -1.1, 0.07)} ${np(1, 0, 0.07)} L${np(1, 0, 0.24)} L${np(1, 8, 0.97)} Q${np(1, 9.2, 1)} ${np(0.85, 9.5, 1)} L${np(0.15, 9.5, 1)} Q${np(0, 9.2, 1)} ${np(0, 8, 0.97)} L${np(0, 0, 0.24)} Z`;
const SIDE_BODY = `M${np(0, 0, 0.07)} L${np(0, 37.2, 0.07)} Q${np(0, 39.5, 0.5)} ${np(0, 37.2, 1)} L${np(0, 9.5, 1)} Q${np(0, 9.2, 1)} ${np(0, 8, 0.97)} L${np(0, 0, 0.24)} Z`;
// Silver cab wedge on the flank: full height behind the rake, slanted ahead.
const CAB_SIDE = `M${np(0, 0, 0.07)} L${np(0, 10.5, 0.07)} L${np(0, 10.5, 1)} L${np(0, 9.5, 1)} Q${np(0, 9.2, 1)} ${np(0, 8, 0.97)} L${np(0, 0, 0.24)} Z`;
const ROOF = `M${np(0, 9.3, 1)} L${np(1, 9.3, 1)} L${np(1, 37, 1)} L${np(0, 37.2, 1)} Z`;
// The big screen LYING ON the wedge: tapers toward the bumper, rounded top,
// bowed lower edge (the glass is curved in plan).
const SCREEN = `M${wp(0.14, 0.32)} Q${np(0.5, noseD(0.32) - 1, 0.32)} ${wp(0.86, 0.32)} L${wp(0.94, 0.8)} Q${wp(0.96, 0.945)} ${wp(0.8, 0.945)} L${wp(0.2, 0.945)} Q${wp(0.04, 0.945)} ${wp(0.06, 0.8)} Z`;

const panto = singleArm(N3(b, 0.5, 22, 1));

/** Recessed BLACK lamp pod with paired round lenses — the Porsche squint. */
function LampPod({ u }: { u: number }) {
  return (
    <>
      <Path d={fQuad(b, u, 0.095, u + 0.26, 0.235)} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.4} strokeLinejoin="round" />
      <Circle cx={F(b, u + 0.075, 0.165)[0]} cy={F(b, u + 0.075, 0.165)[1]} r={1.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.8} />
      <Circle cx={F(b, u + 0.185, 0.165)[0]} cy={F(b, u + 0.185, 0.165)[1]} r={1.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.8} />
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
      {/* grey roof with shallow equipment boxes */}
      <Path d={ROOF} fill="#C4C7CB" stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.28, 12, 1), N3(b, 0.74, 12, 1), N3(b, 0.74, 16.5, 1), N3(b, 0.28, 16.5, 1))} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={poly(N3(b, 0.28, 25, 1), N3(b, 0.74, 25, 1), N3(b, 0.74, 29.5, 1), N3(b, 0.28, 29.5, 1))} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={panto.arm} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={panto.bar} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* flank: long RED body behind the silver cab wedge */}
      <Path d={SIDE_BODY} fill={ISO.redSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={CAB_SIDE} fill={SILVER_S} />
      {/* silver roofline band + skirt along the red body */}
      <Path d={sQuad(b, 0.276, 0.9, 0.98, 1)} fill={SILVER_S} />
      <Path d={sQuad(b, 0.276, 0.07, 0.98, 0.14)} fill={SILVER_S} />
      {/* cab side window tucked under the rake (slanted top edge) */}
      <Path d={poly(N3(b, 0, 5.2, 0.5), N3(b, 0, 8.6, 0.5), N3(b, 0, 8.6, 0.86), N3(b, 0, 5.2, 0.66))} fill={ISO.glassSide} />
      {/* doors + windows along the red flank, four articulation joints */}
      <Path d={sQuad(b, 0.29, 0.1, 0.35, 0.84)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.38, 0.5, 0.48, 0.84)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.52, 0.1, 0.58, 0.84)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.6, 0.5, 0.64, 0.84)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.68, 0.5, 0.78, 0.84)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.82, 0.1, 0.88, 0.84)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.91, 0.5, 0.96, 0.84)} fill={ISO.glassSide} />
      {[0.36, 0.5, 0.66, 0.8].map((u) => (
        <Path key={u} d={sQuad(b, u, 0.08, u + 0.013, 0.88)} fill={ISO.under} opacity={0.8} />
      ))}
      {/* front — the SILVER Porsche wedge */}
      <Path d={FRONT_BODY} fill={SILVER_F} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* the big screen on the slope */}
      <Path d={SCREEN} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={poly(WP(0.55, 0.4), WP(0.67, 0.4), WP(0.48, 0.92), WP(0.38, 0.92))} fill={ISO.glint} opacity={0.24} />
      <Circle cx={WP(0.74, 0.85)[0]} cy={WP(0.74, 0.85)[1]} r={1.1} fill={ISO.glint} opacity={0.8} />
      {/* destination LED glowing at the top of the glass */}
      <Path d={poly(WP(0.32, 0.86), WP(0.68, 0.86), WP(0.68, 0.91), WP(0.32, 0.91))} fill={ISO.ledOrange} opacity={0.92} />
      {/* recessed paired lamp pods low in the vertical bumper zone */}
      <LampPod u={0.04} />
      <LampPod u={0.7} />
      {/* grey skirt seam */}
      <Path d={fQuad(b, 0, 0.07, 1, 0.095)} fill={ISO.greySide} />
    </Svg>
  );
}
