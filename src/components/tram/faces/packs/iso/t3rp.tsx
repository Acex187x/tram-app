// Tatra T3R.P — modernized T3: identical rounded body to the classic, but the
// number-one differentiator is the FULL-WIDTH orange LED destination band
// across the roofline (replacing the narrow number box). Modern charcoal
// bumper strip, small rectangular turn signals by the round headlights, boxy
// single-arm pantograph, smooth (un-ribbed) refurbished roof. Red-and-cream.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 34, cy: 78, w: 26, l: 36, h: 28 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SIDE_BODY = `M${s(0, 0.06)} L${s(0.94, 0.06)} Q${s(1.06, 0.5)} ${s(0.92, 1)} L${s(0, 1)} Z`;
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.68)} Q${f(1, 1.05)} ${f(0.7, 1.01)} L${f(0.3, 1.01)} Q${f(0, 1.05)} ${f(0, 0.68)} Z`;
const WINDSCREEN = `M${f(0.08, 0.5)} L${f(0.92, 0.5)} L${f(0.92, 0.75)} Q${f(0.92, 0.88)} ${f(0.75, 0.88)} L${f(0.25, 0.88)} Q${f(0.08, 0.88)} ${f(0.08, 0.75)} Z`;

// Boxy single-arm pantograph (roof).
const p0 = R(b, 0.5, 0.32);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe + bogies */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.95, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.12, -0.09, 0.3, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.66, -0.09, 0.84, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* smooth refurbished roof + equipment box */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.62, 0.72, 0.85)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      {/* modern single-arm pantograph */}
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side body, rounded rear */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.06, 0.96, 0.44)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.44, 0.96, 0.475)} fill={ISO.maroon} opacity={0.55} />
      {/* side: door – window – window – door – window – door (same T3 shell) */}
      <Path d={sQuad(b, 0.08, 0.12, 0.2, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.14, 0.13)[0]} y1={S(b, 0.14, 0.13)[1]} x2={S(b, 0.14, 0.83)[0]} y2={S(b, 0.14, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.24, 0.52, 0.34, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.38, 0.52, 0.48, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.52, 0.12, 0.64, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.58, 0.13)[0]} y1={S(b, 0.58, 0.13)[1]} x2={S(b, 0.58, 0.83)[0]} y2={S(b, 0.58, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.68, 0.52, 0.78, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.82, 0.12, 0.93, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      {/* front face — same egg brow as the classic */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={fQuad(b, 0, 0.06, 1, 0.44)} fill={ISO.red} />
      <Path d={fQuad(b, 0, 0.44, 1, 0.475)} fill={ISO.maroon} opacity={0.55} />
      {/* wrap-around windscreen + corner spill */}
      <Path d={sQuad(b, 0.015, 0.5, 0.095, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.6} strokeLinejoin="round" />
      <Line x1={F(b, 0.5, 0.51)[0]} y1={F(b, 0.5, 0.51)[1]} x2={F(b, 0.5, 0.87)[0]} y2={F(b, 0.5, 0.87)[1]} stroke={ISO.maroon} strokeWidth={0.7} opacity={0.8} />
      <Path d={poly(F(b, 0.6, 0.5), F(b, 0.74, 0.5), F(b, 0.52, 0.88), F(b, 0.4, 0.88))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={F(b, 0.78, 0.8)[0]} cy={F(b, 0.78, 0.8)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* FULL-WIDTH orange LED destination band — the t3rp tell */}
      <Path d={fQuad(b, 0.07, 0.9, 0.93, 0.985)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.12, 0.922, 0.2, 0.962)} fill={ISO.amber} opacity={0.95} />
      <Path d={fQuad(b, 0.26, 0.922, 0.62, 0.962)} fill={ISO.amber} opacity={0.95} />
      <Path d={fQuad(b, 0.68, 0.922, 0.88, 0.962)} fill={ISO.amber} opacity={0.7} />
      {/* round headlights + small rectangular turn signals */}
      <Circle cx={F(b, 0.24, 0.27)[0]} cy={F(b, 0.24, 0.27)[1]} r={2.7} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.3} />
      <Circle cx={F(b, 0.76, 0.27)[0]} cy={F(b, 0.76, 0.27)[1]} r={2.7} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.3} />
      <Circle cx={F(b, 0.27, 0.31)[0]} cy={F(b, 0.27, 0.31)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.79, 0.31)[0]} cy={F(b, 0.79, 0.31)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Path d={fQuad(b, 0.06, 0.16, 0.13, 0.21)} fill={ISO.amber} />
      <Path d={fQuad(b, 0.87, 0.16, 0.94, 0.21)} fill={ISO.amber} />
      {/* modern charcoal bumper strip (no chrome smile) */}
      <Path d={fQuad(b, 0.05, 0.075, 0.95, 0.115)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1} strokeLinejoin="round" />
    </Svg>
  );
}
