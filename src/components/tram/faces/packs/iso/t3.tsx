// Tatra T3 — the 1960s classic, in the pack's cute 3/4 iso view.
// Tells: egg-rounded brow and rear, wrap-around curved windscreen that spills
// past the corner onto the side, TWO chrome-ringed round headlights set low in
// the red band, a NARROW route-number box centered above the windscreen (the
// classic-T3 tell), ribbed roof, red scissor pantograph, three folding doors
// on a short single car. Red-and-cream DPP livery.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 34, cy: 78, w: 26, l: 36, h: 28 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SIDE_BODY = `M${s(0, 0.06)} L${s(0.94, 0.06)} Q${s(1.06, 0.5)} ${s(0.92, 1)} L${s(0, 1)} Z`;
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.68)} Q${f(1, 1.05)} ${f(0.7, 1.01)} L${f(0.3, 1.01)} Q${f(0, 1.05)} ${f(0, 0.68)} Z`;
const WINDSCREEN = `M${f(0.08, 0.5)} L${f(0.92, 0.5)} L${f(0.92, 0.76)} Q${f(0.92, 0.9)} ${f(0.75, 0.9)} L${f(0.25, 0.9)} Q${f(0.08, 0.9)} ${f(0.08, 0.76)} Z`;

// Scissor pantograph (roof).
const pb1 = R(b, 0.5, 0.28);
const pb2 = R(b, 0.5, 0.52);
const apex = [(pb1[0] + pb2[0]) / 2, (pb1[1] + pb2[1]) / 2 - 8.5] as const;
const PANTO = `M${P(pb1)} L${apex[0] + 1.8} ${apex[1] - 0.9} M${P(pb2)} L${apex[0] - 1.8} ${apex[1] + 0.9}`;
const PANTO_BAR = `M${apex[0] - 2.9} ${apex[1] + 1.45} L${apex[0] + 2.9} ${apex[1] - 1.45}`;

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe + two visible bogies */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.95, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.12, -0.09, 0.3, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.66, -0.09, 0.84, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* roof (ribbed) */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Line x1={R(b, 0.3, 0.08)[0]} y1={R(b, 0.3, 0.08)[1]} x2={R(b, 0.3, 0.92)[0]} y2={R(b, 0.3, 0.92)[1]} stroke={ISO.creamSide} strokeWidth={0.9} />
      <Line x1={R(b, 0.55, 0.08)[0]} y1={R(b, 0.55, 0.08)[1]} x2={R(b, 0.55, 0.92)[0]} y2={R(b, 0.55, 0.92)[1]} stroke={ISO.creamSide} strokeWidth={0.9} />
      <Line x1={R(b, 0.8, 0.08)[0]} y1={R(b, 0.8, 0.08)[1]} x2={R(b, 0.8, 0.92)[0]} y2={R(b, 0.8, 0.92)[1]} stroke={ISO.creamSide} strokeWidth={0.9} />
      {/* scissor pantograph */}
      <Path d={PANTO} stroke="#A8261F" strokeWidth={1.4} strokeLinecap="round" fill="none" />
      <Path d={PANTO_BAR} stroke="#A8261F" strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side body, rounded rear */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.06, 0.96, 0.44)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.44, 0.96, 0.475)} fill={ISO.maroon} opacity={0.55} />
      {/* side: door – window – window – door – window – door */}
      <Path d={sQuad(b, 0.08, 0.12, 0.2, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.14, 0.13)[0]} y1={S(b, 0.14, 0.13)[1]} x2={S(b, 0.14, 0.83)[0]} y2={S(b, 0.14, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.24, 0.52, 0.34, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.38, 0.52, 0.48, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.52, 0.12, 0.64, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.58, 0.13)[0]} y1={S(b, 0.58, 0.13)[1]} x2={S(b, 0.58, 0.83)[0]} y2={S(b, 0.58, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.68, 0.52, 0.78, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.82, 0.12, 0.93, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      {/* front face — egg brow */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={fQuad(b, 0, 0.06, 1, 0.44)} fill={ISO.red} />
      <Path d={fQuad(b, 0, 0.44, 1, 0.475)} fill={ISO.maroon} opacity={0.55} />
      {/* wrap-around windscreen + corner spill onto the side */}
      <Path d={sQuad(b, 0.015, 0.5, 0.095, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.6} strokeLinejoin="round" />
      <Line x1={F(b, 0.5, 0.51)[0]} y1={F(b, 0.5, 0.51)[1]} x2={F(b, 0.5, 0.89)[0]} y2={F(b, 0.5, 0.89)[1]} stroke={ISO.maroon} strokeWidth={0.7} opacity={0.8} />
      <Path d={poly(F(b, 0.6, 0.5), F(b, 0.74, 0.5), F(b, 0.52, 0.9), F(b, 0.4, 0.9))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={F(b, 0.78, 0.82)[0]} cy={F(b, 0.78, 0.82)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* NARROW route-number box (classic tell) */}
      <Path d={fQuad(b, 0.36, 0.905, 0.64, 0.985)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.43, 0.925, 0.57, 0.962)} fill={ISO.amber} opacity={0.95} />
      {/* twin chrome-ring headlights low in the red */}
      <Circle cx={F(b, 0.24, 0.27)[0]} cy={F(b, 0.24, 0.27)[1]} r={2.7} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.3} />
      <Circle cx={F(b, 0.76, 0.27)[0]} cy={F(b, 0.76, 0.27)[1]} r={2.7} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.3} />
      <Circle cx={F(b, 0.27, 0.31)[0]} cy={F(b, 0.27, 0.31)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.79, 0.31)[0]} cy={F(b, 0.79, 0.31)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      {/* chrome bumper smile */}
      <Path d={`M${f(0.07, 0.11)} Q${f(0.5, 0.02)} ${f(0.93, 0.11)}`} stroke={ISO.chrome} strokeWidth={1.8} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
