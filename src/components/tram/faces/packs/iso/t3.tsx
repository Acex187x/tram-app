// Tatra T3 — the 1960s classic, cute 3/4 iso view, grounded in the refs:
// rounded "bun" nose with a two-piece wrap-around windscreen, two BIG round
// chrome-ringed headlights set LOW in the red apron (whose lower edge dips in
// a shallow V toward the coupling), a small BLUE route-number box centered
// above the windscreen, cream window band + bold red belt + cream skirt,
// grey canvas roof with ribs, yellow DIAMOND pantograph. Short single car.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, diamond, diamondBar, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 34, cy: 78, w: 26, l: 36, h: 28 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

// Egg-rounded brow + rounded rear.
const SIDE_BODY = `M${s(0, 0.06)} L${s(0.94, 0.06)} Q${s(1.06, 0.5)} ${s(0.92, 1)} L${s(0, 1)} Z`;
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.68)} Q${f(1, 1.05)} ${f(0.7, 1.01)} L${f(0.3, 1.01)} Q${f(0, 1.05)} ${f(0, 0.68)} Z`;
// Two-piece windscreen, rounded top corners.
const WINDSCREEN = `M${f(0.08, 0.52)} L${f(0.92, 0.52)} L${f(0.92, 0.76)} Q${f(0.92, 0.9)} ${f(0.75, 0.9)} L${f(0.25, 0.9)} Q${f(0.08, 0.9)} ${f(0.08, 0.76)} Z`;
// Red apron: straight top under the glass, lower edge dips in a shallow V.
const APRON = `M${f(0.02, 0.52)} L${f(0.98, 0.52)} L${f(0.98, 0.2)} Q${f(0.5, 0.1)} ${f(0.02, 0.2)} Z`;

const pantoM = R(b, 0.5, 0.45);

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
      {/* grey canvas roof with ribs */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#C8C2B1" stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Line x1={R(b, 0.32, 0.08)[0]} y1={R(b, 0.32, 0.08)[1]} x2={R(b, 0.32, 0.92)[0]} y2={R(b, 0.32, 0.92)[1]} stroke="#B0A995" strokeWidth={0.9} />
      <Line x1={R(b, 0.56, 0.08)[0]} y1={R(b, 0.56, 0.08)[1]} x2={R(b, 0.56, 0.92)[0]} y2={R(b, 0.56, 0.92)[1]} stroke="#B0A995" strokeWidth={0.9} />
      <Line x1={R(b, 0.8, 0.08)[0]} y1={R(b, 0.8, 0.08)[1]} x2={R(b, 0.8, 0.92)[0]} y2={R(b, 0.8, 0.92)[1]} stroke="#B0A995" strokeWidth={0.9} />
      {/* yellow DIAMOND pantograph */}
      <Path d={diamond(pantoM)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(pantoM)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* side: cream body, red belt BELOW the windows, cream skirt */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.18, 0.97, 0.52)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.5, 0.97, 0.53)} fill={ISO.maroon} opacity={0.55} />
      {/* side: door – window – window – door – window – door */}
      <Path d={sQuad(b, 0.08, 0.12, 0.2, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.14, 0.13)[0]} y1={S(b, 0.14, 0.13)[1]} x2={S(b, 0.14, 0.83)[0]} y2={S(b, 0.14, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.24, 0.56, 0.34, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.38, 0.56, 0.48, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.52, 0.12, 0.64, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.58, 0.13)[0]} y1={S(b, 0.58, 0.13)[1]} x2={S(b, 0.58, 0.83)[0]} y2={S(b, 0.58, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.68, 0.56, 0.78, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.82, 0.12, 0.93, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      {/* front face — cream bun */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red apron with shallow-V lower edge */}
      <Path d={APRON} fill={ISO.red} />
      <Path d={`M${f(0.02, 0.2)} Q${f(0.5, 0.1)} ${f(0.98, 0.2)}`} stroke={ISO.maroon} strokeWidth={0.8} fill="none" opacity={0.6} />
      {/* wrap-around windscreen + corner spill onto the side */}
      <Path d={sQuad(b, 0.015, 0.54, 0.09, 0.88)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.6} strokeLinejoin="round" />
      {/* two-piece: center divider */}
      <Line x1={F(b, 0.5, 0.53)[0]} y1={F(b, 0.5, 0.53)[1]} x2={F(b, 0.5, 0.89)[0]} y2={F(b, 0.5, 0.89)[1]} stroke={ISO.cream} strokeWidth={1.1} />
      <Path d={poly(F(b, 0.6, 0.52), F(b, 0.74, 0.52), F(b, 0.52, 0.9), F(b, 0.4, 0.9))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={F(b, 0.8, 0.82)[0]} cy={F(b, 0.8, 0.82)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* BLUE route-number box centered above the windscreen (classic tell) */}
      <Path d={fQuad(b, 0.32, 0.9, 0.68, 1)} fill="#2559B0" stroke="#1A3F84" strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.42, 0.925, 0.49, 0.975)} fill="#FFFFFF" opacity={0.95} />
      <Path d={fQuad(b, 0.53, 0.925, 0.6, 0.975)} fill="#FFFFFF" opacity={0.95} />
      {/* two BIG round chrome-ringed headlights set LOW in the red */}
      <Circle cx={F(b, 0.24, 0.3)[0]} cy={F(b, 0.24, 0.3)[1]} r={3.1} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.76, 0.3)[0]} cy={F(b, 0.76, 0.3)[1]} r={3.1} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.27, 0.34)[0]} cy={F(b, 0.27, 0.34)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.79, 0.34)[0]} cy={F(b, 0.79, 0.34)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      {/* chrome bumper smile on the cream skirt */}
      <Path d={`M${f(0.07, 0.1)} Q${f(0.5, 0.02)} ${f(0.93, 0.1)}`} stroke={ISO.chrome} strokeWidth={1.8} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
