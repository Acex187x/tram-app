// Škoda 15T ForCity Alfa — the sloped face with the silver light-band.
// Tells: big raked CURVED black windscreen, a red brow/cap over the cab that
// flows down the A-pillars, a SILVER horizontal mid-band with clusters of
// ROUND headlights, a RED lower bumper with white DRL dashes, red+black+silver
// livery (black glazing band over red flank), single-arm pantograph. Long.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 30, cy: 78, w: 25, l: 54, h: 27 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SILVER_F = '#E2E4E7';
const SILVER_S = '#AEB1B6';
const BLACK_GLAZE = '#1B1E24';

// Soft-shouldered slab, roof corners rounded (the face leans back in life;
// here the curved black screen + red brow carry the rake).
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.8)} Q${f(1, 1.03)} ${f(0.74, 1.01)} L${f(0.26, 1.01)} Q${f(0, 1.03)} ${f(0, 0.8)} Z`;
const SIDE_BODY = `M${s(0, 0.06)} L${s(0.99, 0.06)} Q${s(1.03, 0.5)} ${s(0.99, 1)} L${s(0, 1)} Z`;
// The huge curved black windscreen: full-width under the brow, rounded lower
// corners rolling into the silver band.
const SCREEN = `M${f(0.08, 0.84)} L${f(0.92, 0.84)} L${f(0.92, 0.54)} Q${f(0.92, 0.4)} ${f(0.76, 0.4)} L${f(0.24, 0.4)} Q${f(0.08, 0.4)} ${f(0.08, 0.54)} Z`;

// Single-arm pantograph over the rear section.
const p0 = R(b, 0.5, 0.62);
const knee = [p0[0] - 1.2, p0[1] - 5.6] as const;
const head = [knee[0] + 4.4, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

/** Cluster of ROUND headlight lenses set into the silver band. */
function LightCluster({ u }: { u: number }) {
  return (
    <>
      <Circle cx={F(b, u, 0.305)[0]} cy={F(b, u, 0.305)[1]} r={2.3} fill={ISO.warm} stroke="#2A2D33" strokeWidth={1.1} />
      <Circle cx={F(b, u + 0.13, 0.305)[0]} cy={F(b, u + 0.13, 0.305)[1]} r={2.3} fill={ISO.warm} stroke="#2A2D33" strokeWidth={1.1} />
      <Circle cx={F(b, u + 0.02, 0.325)[0]} cy={F(b, u + 0.02, 0.325)[1]} r={0.6} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, u + 0.14, 0.325)[0]} cy={F(b, u + 0.14, 0.325)[1]} r={0.6} fill="#FFFFFF" opacity={0.9} />
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
      {/* roof: red cap over the cab, grey equipment spine behind */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#A6AAB0" stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0, 0, 1, 0.09)} fill={ISO.redRoof} />
      <Path d={rQuad(b, 0.28, 0.2, 0.74, 0.34)} fill={ISO.charcoal} stroke={ISO.under} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.44, 0.74, 0.56)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.72, 0.74, 0.84)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side: red lower body, silver belt strip, continuous BLACK glazing band */}
      <Path d={SIDE_BODY} fill={ISO.redSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.44, 0.99, 0.5)} fill={SILVER_S} />
      <Path d={sQuad(b, 0, 0.5, 0.99, 0.88)} fill={BLACK_GLAZE} />
      {/* doors drop through the black band into the red */}
      <Path d={sQuad(b, 0.1, 0.08, 0.175, 0.86)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.38, 0.08, 0.455, 0.86)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.66, 0.08, 0.735, 0.86)} fill={ISO.glassDoor} />
      {/* faint window separators in the black glazing */}
      <Line x1={S(b, 0.27, 0.53)[0]} y1={S(b, 0.27, 0.53)[1]} x2={S(b, 0.27, 0.85)[0]} y2={S(b, 0.27, 0.85)[1]} stroke="#2E323A" strokeWidth={0.8} />
      <Line x1={S(b, 0.55, 0.53)[0]} y1={S(b, 0.55, 0.53)[1]} x2={S(b, 0.55, 0.85)[0]} y2={S(b, 0.55, 0.85)[1]} stroke="#2E323A" strokeWidth={0.8} />
      <Line x1={S(b, 0.83, 0.53)[0]} y1={S(b, 0.83, 0.53)[1]} x2={S(b, 0.83, 0.85)[0]} y2={S(b, 0.83, 0.85)[1]} stroke="#2E323A" strokeWidth={0.8} />
      {/* two articulation joints (three long sections) */}
      <Path d={sQuad(b, 0.315, 0.07, 0.33, 0.9)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.595, 0.07, 0.61, 0.9)} fill={ISO.under} opacity={0.85} />
      {/* front face */}
      <Path d={FRONT_BODY} fill={SILVER_F} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red brow cap flowing down the A-pillars */}
      <Path d={fQuad(b, 0, 0.84, 1, 1)} fill={ISO.red} />
      <Path d={`M${f(0, 0.84)} L${f(0.09, 0.84)} L${f(0.05, 0.38)} L${f(0, 0.38)} Z`} fill={ISO.red} />
      <Path d={`M${f(1, 0.84)} L${f(0.91, 0.84)} L${f(0.95, 0.38)} L${f(1, 0.38)} Z`} fill={ISO.red} />
      {/* the big raked curved BLACK windscreen */}
      <Path d={SCREEN} fill={BLACK_GLAZE} stroke={BLACK_GLAZE} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={poly(F(b, 0.58, 0.44), F(b, 0.72, 0.44), F(b, 0.48, 0.86), F(b, 0.36, 0.87))} fill={ISO.glint} opacity={0.2} />
      <Circle cx={F(b, 0.8, 0.78)[0]} cy={F(b, 0.8, 0.78)[1]} r={1.1} fill={ISO.glint} opacity={0.7} />
      {/* amber route LED at the top center of the glass */}
      <Path d={fQuad(b, 0.34, 0.78, 0.66, 0.83)} fill={ISO.ledOrange} opacity={0.92} />
      {/* SILVER horizontal mid-band with round headlight clusters */}
      <Path d={fQuad(b, 0, 0.24, 1, 0.38)} fill={SILVER_F} />
      <Path d={fQuad(b, 0, 0.24, 1, 0.265)} fill={SILVER_S} opacity={0.6} />
      <LightCluster u={0.15} />
      <LightCluster u={0.73} />
      {/* RED lower bumper with white DRL dashes */}
      <Path d={fQuad(b, 0, 0.06, 1, 0.24)} fill={ISO.red} />
      <Path d={fQuad(b, 0.1, 0.115, 0.24, 0.155)} fill="#F2F6F9" />
      <Path d={fQuad(b, 0.76, 0.115, 0.9, 0.155)} fill="#F2F6F9" />
    </Svg>
  );
}
