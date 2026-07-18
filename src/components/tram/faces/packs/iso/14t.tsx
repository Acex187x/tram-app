// Škoda 14T Elektra — the Porsche-designed wedge (ref 9119/9122): SILVER cab
// ends on a long RED five-section body. Tall raked dark windscreen that tapers
// toward the bumper, silver nose with paired small round lamps in dark
// recessed pods low on each side, silver roofline band + silver skirt running
// the whole flank, four articulation joints, single-arm pantograph, grey roof.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { F, fQuad, ISO, isoBox, LONG_W, P, poly, R, rQuad, S, singleArm, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SILVER_F = '#D7DADF';
const SILVER_S = '#AFB3BA';

// Wedge slab: gently rounded crown.
const FRONT_BODY = `M${f(0, 0.07)} L${f(1, 0.07)} L${f(1, 0.84)} Q${f(1, 1.03)} ${f(0.74, 1.01)} L${f(0.26, 1.01)} Q${f(0, 1.03)} ${f(0, 0.84)} Z`;
const SIDE_BODY = `M${s(0, 0.07)} L${s(0.99, 0.07)} Q${s(1.03, 0.52)} ${s(0.99, 1)} L${s(0, 1)} Z`;
// The big raked screen: wide at the crown, tapering toward the bumper.
const SCREEN = `M${f(0.17, 0.34)} L${f(0.83, 0.34)} L${f(0.9, 0.82)} Q${f(0.92, 0.96)} ${f(0.76, 0.96)} L${f(0.24, 0.96)} Q${f(0.08, 0.96)} ${f(0.1, 0.82)} Z`;

const panto = singleArm(R(b, 0.5, 0.55));

/** Recessed BLACK lamp pod with paired round lenses — the Porsche squint. */
function LampPod({ u }: { u: number }) {
  return (
    <>
      <Path d={fQuad(b, u, 0.12, u + 0.26, 0.27)} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.6} strokeLinejoin="round" />
      <Circle cx={F(b, u + 0.075, 0.195)[0]} cy={F(b, u + 0.075, 0.195)[1]} r={1.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.8} />
      <Circle cx={F(b, u + 0.185, 0.195)[0]} cy={F(b, u + 0.185, 0.195)[1]} r={1.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.8} />
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
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#C4C7CB" stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.28, 0.16, 0.74, 0.28)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.42, 0.74, 0.54)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.72, 0.74, 0.84)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={panto.arm} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={panto.bar} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* flank: SILVER cab up front, long RED body, silver roofline + skirt */}
      <Path d={SIDE_BODY} fill={ISO.redSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.07, 0.115, 1)} fill={SILVER_S} />
      <Path d={sQuad(b, 0.115, 0.86, 0.99, 1)} fill={SILVER_S} />
      <Path d={sQuad(b, 0.115, 0.07, 0.99, 0.14)} fill={SILVER_S} />
      {/* cab side window in the silver flank */}
      <Path d={sQuad(b, 0.02, 0.5, 0.1, 0.82)} fill={ISO.glassSide} />
      {/* four articulation joints (five short sections) */}
      {[0.21, 0.405, 0.6, 0.795].map((u) => (
        <Path key={u} d={sQuad(b, u, 0.08, u + 0.013, 0.85)} fill={ISO.under} opacity={0.8} />
      ))}
      {/* doors + windows along the red flank */}
      <Path d={sQuad(b, 0.13, 0.1, 0.2, 0.84)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.24, 0.5, 0.39, 0.84)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.43, 0.1, 0.5, 0.84)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.53, 0.5, 0.59, 0.84)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.63, 0.5, 0.78, 0.84)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.82, 0.1, 0.89, 0.84)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.92, 0.5, 0.975, 0.84)} fill={ISO.glassSide} />
      {/* front — SILVER wedge */}
      <Path d={FRONT_BODY} fill={SILVER_F} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* the tapered raked screen */}
      <Path d={SCREEN} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={poly(F(b, 0.55, 0.4), F(b, 0.67, 0.4), F(b, 0.48, 0.94), F(b, 0.38, 0.94))} fill={ISO.glint} opacity={0.24} />
      <Circle cx={F(b, 0.74, 0.85)[0]} cy={F(b, 0.74, 0.85)[1]} r={1.1} fill={ISO.glint} opacity={0.8} />
      {/* destination LED glowing at the top of the glass */}
      <Path d={fQuad(b, 0.3, 0.87, 0.7, 0.92)} fill={ISO.ledOrange} opacity={0.92} />
      {/* recessed paired lamp pods low on both sides of the wedge */}
      <LampPod u={0.04} />
      <LampPod u={0.7} />
      {/* grey skirt seam */}
      <Path d={fQuad(b, 0, 0.07, 1, 0.1)} fill={ISO.greySide} />
    </Svg>
  );
}
