// Škoda 14T Elektra — the Porsche-designed WEDGE: silver cab ends on a red
// body. Tall flat raked windscreen framed in black that WIDENS DOWNWARD
// (trapezoid), paired small round lens headlights recessed in dark niches low
// on each side + amber signals, silver front/cab flank against the long RED
// side, grey roofline. Single-arm pantograph. Five-section caterpillar.
import Svg, { Circle, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 31, cy: 78, w: 25, l: 50, h: 27 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SILVER_F = '#D2D5DA';
const SILVER_S = '#AFB3BA';

// Wedge slab: gently rounded roof corners.
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.86)} Q${f(1, 1.02)} ${f(0.8, 1.01)} L${f(0.2, 1.01)} Q${f(0, 1.02)} ${f(0, 0.86)} Z`;
const SIDE_BODY = `M${s(0, 0.06)} L${s(0.99, 0.06)} Q${s(1.03, 0.5)} ${s(0.99, 1)} L${s(0, 1)} Z`;
// Black trapezoid frame: narrow at the roofline, widening toward the bumper.
const FRAME = poly(F(b, 0.2, 0.96), F(b, 0.8, 0.96), F(b, 0.95, 0.3), F(b, 0.05, 0.3));
// The glass inside, same taper.
const GLASS = poly(F(b, 0.24, 0.9), F(b, 0.76, 0.9), F(b, 0.88, 0.37), F(b, 0.12, 0.37));

// Single-arm pantograph.
const p0 = R(b, 0.5, 0.34);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

/** Recessed dark lamp niche with paired round lenses + amber signal. */
function LampNiche({ u }: { u: number }) {
  return (
    <>
      <Path d={fQuad(b, u, 0.13, u + 0.17, 0.25)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1.2} strokeLinejoin="round" />
      <Circle cx={F(b, u + 0.05, 0.19)[0]} cy={F(b, u + 0.05, 0.19)[1]} r={1.5} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.7} />
      <Circle cx={F(b, u + 0.12, 0.19)[0]} cy={F(b, u + 0.12, 0.19)[1]} r={1.5} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.7} />
      <Path d={fQuad(b, u + 0.02, 0.075, u + 0.15, 0.105)} fill={ISO.amber} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* low underframe */}
      <Path d={fQuad(b, 0.04, -0.02, 0.96, 0.06)} fill={ISO.under} />
      <Path d={sQuad(b, 0.005, -0.02, 0.98, 0.06)} fill={ISO.under} />
      {/* grey roof with shallow equipment boxes */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#C4C7CB" stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.18, 0.72, 0.3)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.3, 0.5, 0.72, 0.62)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.3, 0.78, 0.72, 0.9)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side: SILVER cab flank up front, long RED body behind, grey roofline */}
      <Path d={SIDE_BODY} fill={ISO.redSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.06, 0.13, 1)} fill={SILVER_S} />
      <Path d={sQuad(b, 0, 0.88, 0.99, 1)} fill={SILVER_S} />
      {/* side cab window in the silver flank */}
      <Path d={sQuad(b, 0.025, 0.52, 0.105, 0.82)} fill={ISO.glassSide} />
      {/* four articulation joints (five short sections) */}
      <Path d={sQuad(b, 0.215, 0.07, 0.228, 0.87)} fill={ISO.under} opacity={0.8} />
      <Path d={sQuad(b, 0.41, 0.07, 0.423, 0.87)} fill={ISO.under} opacity={0.8} />
      <Path d={sQuad(b, 0.605, 0.07, 0.618, 0.87)} fill={ISO.under} opacity={0.8} />
      <Path d={sQuad(b, 0.8, 0.07, 0.813, 0.87)} fill={ISO.under} opacity={0.8} />
      {/* doors + windows along the red flank */}
      <Path d={sQuad(b, 0.14, 0.1, 0.205, 0.82)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.245, 0.5, 0.4, 0.82)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.44, 0.1, 0.51, 0.82)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.535, 0.5, 0.595, 0.82)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.635, 0.5, 0.79, 0.82)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.83, 0.1, 0.9, 0.82)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.925, 0.5, 0.98, 0.82)} fill={ISO.glassSide} />
      {/* front face — SILVER wedge */}
      <Path d={FRONT_BODY} fill={SILVER_F} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* black trapezoid windscreen frame, widening downward */}
      <Path d={FRAME} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={GLASS} fill={ISO.glass} />
      <Path d={poly(F(b, 0.56, 0.38), F(b, 0.68, 0.38), F(b, 0.46, 0.89), F(b, 0.36, 0.89))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.74, 0.8)[0]} cy={F(b, 0.74, 0.8)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* destination LED glowing at the top of the glass */}
      <Path d={fQuad(b, 0.32, 0.82, 0.68, 0.87)} fill={ISO.ledOrange} opacity={0.92} />
      {/* recessed paired lamp niches low on both sides of the wedge */}
      <LampNiche u={0.035} />
      <LampNiche u={0.795} />
      {/* grey skirt */}
      <Path d={fQuad(b, 0, 0.06, 1, 0.09)} fill={ISO.greySide} />
    </Svg>
  );
}
