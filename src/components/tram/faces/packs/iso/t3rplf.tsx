// T3R.PLF — new-build retro-T3 body with a LOW-FLOOR MIDDLE: "a T3 that sags
// gracefully in the middle". Front is nearly a t3rp (rounded nose, two round
// headlights, full-width LED sign) but a smooth modern plastic molding with a
// crisp panel seam. The side is the tell: ~1 m longer, floor DIPS around a
// wide sliding center plug door, DEEPER windows over the low-floor middle,
// silver flashes beside the center door. Red-and-cream.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 34, cy: 78, w: 26, l: 40, h: 28 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SIDE_BODY = `M${s(0, 0.06)} L${s(0.94, 0.06)} Q${s(1.055, 0.5)} ${s(0.92, 1)} L${s(0, 1)} Z`;
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.68)} Q${f(1, 1.05)} ${f(0.7, 1.01)} L${f(0.3, 1.01)} Q${f(0, 1.05)} ${f(0, 0.68)} Z`;
const WINDSCREEN = `M${f(0.08, 0.5)} L${f(0.92, 0.5)} L${f(0.92, 0.75)} Q${f(0.92, 0.88)} ${f(0.75, 0.88)} L${f(0.25, 0.88)} Q${f(0.08, 0.88)} ${f(0.08, 0.75)} Z`;

// Single-arm pantograph.
const p0 = R(b, 0.5, 0.3);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe — dips deeper under the low-floor middle; bogies at the ends only */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.95, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.44, -0.075, 0.62, 0.05)} fill={ISO.under} />
      <Path d={sQuad(b, 0.1, -0.09, 0.26, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.72, -0.09, 0.88, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* roof */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.28, 0.6, 0.74, 0.82)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side body */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.06, 0.96, 0.44)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.44, 0.96, 0.475)} fill={ISO.maroon} opacity={0.55} />
      {/* front folding door, then the beltline starts to sag */}
      <Path d={sQuad(b, 0.07, 0.12, 0.17, 0.82)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.12, 0.13)[0]} y1={S(b, 0.12, 0.13)[1]} x2={S(b, 0.12, 0.81)[0]} y2={S(b, 0.12, 0.81)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.21, 0.52, 0.31, 0.82)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      {/* DEEPER windows over the low-floor middle */}
      <Path d={sQuad(b, 0.34, 0.46, 0.42, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      {/* silver flash – wide low sliding center door – silver flash */}
      <Path d={sQuad(b, 0.425, 0.06, 0.455, 0.84)} fill={ISO.chrome} />
      <Path d={sQuad(b, 0.46, 0.015, 0.6, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.53, 0.03)[0]} y1={S(b, 0.53, 0.03)[1]} x2={S(b, 0.53, 0.83)[0]} y2={S(b, 0.53, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.605, 0.06, 0.635, 0.84)} fill={ISO.chrome} />
      <Path d={sQuad(b, 0.64, 0.46, 0.72, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.76, 0.52, 0.85, 0.82)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.88, 0.12, 0.955, 0.82)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      {/* front face — modern plastic molding of the T3 nose */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={fQuad(b, 0, 0.06, 1, 0.44)} fill={ISO.red} />
      <Path d={fQuad(b, 0, 0.44, 1, 0.475)} fill={ISO.maroon} opacity={0.55} />
      {/* crisp panel seam of the plastic mask */}
      <Path d={`M${f(0.06, 0.13)} L${f(0.06, 0.42)} M${f(0.94, 0.13)} L${f(0.94, 0.42)}`} stroke={ISO.maroon} strokeWidth={0.6} opacity={0.7} fill="none" />
      {/* windscreen + corner spill */}
      <Path d={sQuad(b, 0.012, 0.5, 0.075, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.6} strokeLinejoin="round" />
      <Path d={poly(F(b, 0.6, 0.5), F(b, 0.74, 0.5), F(b, 0.52, 0.88), F(b, 0.4, 0.88))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={F(b, 0.78, 0.8)[0]} cy={F(b, 0.78, 0.8)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* full-width LED destination sign */}
      <Path d={fQuad(b, 0.07, 0.9, 0.93, 0.985)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.13, 0.922, 0.24, 0.962)} fill={ISO.amber} opacity={0.95} />
      <Path d={fQuad(b, 0.3, 0.922, 0.7, 0.962)} fill={ISO.amber} opacity={0.95} />
      {/* round headlights in slim modern bezels + integrated indicators */}
      <Circle cx={F(b, 0.24, 0.27)[0]} cy={F(b, 0.24, 0.27)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.9} />
      <Circle cx={F(b, 0.76, 0.27)[0]} cy={F(b, 0.76, 0.27)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.9} />
      <Circle cx={F(b, 0.27, 0.31)[0]} cy={F(b, 0.27, 0.31)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.79, 0.31)[0]} cy={F(b, 0.79, 0.31)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Path d={fQuad(b, 0.11, 0.31, 0.17, 0.35)} fill={ISO.amber} />
      <Path d={fQuad(b, 0.83, 0.31, 0.89, 0.35)} fill={ISO.amber} />
      {/* smooth body-color bumper with silver skirt accent */}
      <Path d={fQuad(b, 0.05, 0.075, 0.95, 0.105)} fill={ISO.chrome} opacity={0.9} />
    </Svg>
  );
}
